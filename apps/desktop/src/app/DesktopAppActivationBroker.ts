// @effect-diagnostics globalTimers:off -- This protocol broker owns cancellable request deadlines outside the Effect runtime.
import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  type DesktopAppActivationFailure,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";

interface PendingActivation {
  readonly request: DesktopAppActivationRequest;
  readonly resolve: (response: DesktopAppActivationResponse) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  dispatched: boolean;
  rendererId: number | undefined;
}

type RendererSender = (request: DesktopAppActivationRequest) => void;

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    ok: false,
    code,
    message,
  };
}

/** Holds CLI requests until the real desktop renderer is ready to handle them. */
export class DesktopAppActivationBroker {
  readonly #pending = new Map<string, PendingActivation>();
  readonly #requestTimeoutMs: number;
  readonly #activate: () => void;
  readonly #renderers = new Map<number, RendererSender>();
  #rendererId: number | undefined;
  #closed = false;

  constructor(input: { readonly requestTimeoutMs: number; readonly activate: () => void }) {
    this.#requestTimeoutMs = input.requestTimeoutMs;
    this.#activate = input.activate;
  }

  request(request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> {
    if (this.#closed) {
      return Promise.resolve(
        failure(request.requestId, "renderer-unavailable", "The desktop app is shutting down."),
      );
    }
    if (this.#pending.has(request.requestId)) {
      return Promise.resolve(
        failure(request.requestId, "invalid-request", "The request id is already in use."),
      );
    }

    const response = new Promise<DesktopAppActivationResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this.#settle(
          failure(
            request.requestId,
            "request-timeout",
            "The desktop app did not finish opening the project in time.",
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(request.requestId, {
        request,
        resolve,
        timeout,
        dispatched: false,
        rendererId: undefined,
      });
    });

    this.#activate();
    this.#flush();
    return response;
  }

  registerRenderer(send: RendererSender, rendererId = 0): void {
    this.#renderers.set(rendererId, send);
    this.selectRenderer(rendererId);
  }

  selectRenderer(rendererId: number): void {
    if (!this.#renderers.has(rendererId)) return;
    this.#rendererId = rendererId;
    this.#flush();
  }

  clearRenderer(rendererId = 0): void {
    this.#renderers.delete(rendererId);
    if (this.#rendererId === rendererId) {
      this.#rendererId = this.#renderers.keys().next().value;
    }
    for (const pending of this.#pending.values()) {
      if (pending.dispatched && pending.rendererId === rendererId) {
        this.#settle(
          failure(
            pending.request.requestId,
            "renderer-unavailable",
            "The desktop window closed before it opened the project.",
          ),
        );
      }
    }
    this.#flush();
  }

  complete(response: DesktopAppActivationResponse, rendererId = 0): void {
    if (this.#pending.get(response.requestId)?.rendererId !== rendererId) return;
    this.#settle(response);
  }

  cancel(requestId: string): void {
    this.#settle(
      failure(
        requestId,
        "renderer-unavailable",
        "The command closed before the desktop app was ready.",
      ),
    );
  }

  close(): void {
    this.#closed = true;
    this.#renderers.clear();
    this.#rendererId = undefined;
    for (const pending of this.#pending.values()) {
      this.#settle(
        failure(
          pending.request.requestId,
          "renderer-unavailable",
          "The desktop app is shutting down.",
        ),
      );
    }
  }

  #flush(): void {
    const rendererId = this.#rendererId;
    if (rendererId === undefined) return;
    const renderer = this.#renderers.get(rendererId);
    if (renderer === undefined) return;
    if ([...this.#pending.values()].some((pending) => pending.dispatched)) return;

    for (const pending of this.#pending.values()) {
      if (pending.dispatched) continue;
      try {
        pending.dispatched = true;
        pending.rendererId = rendererId;
        renderer(pending.request);
      } catch {
        pending.dispatched = false;
        pending.rendererId = undefined;
        this.clearRenderer(rendererId);
      }
      return;
    }
  }

  #settle(response: DesktopAppActivationResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(response.requestId);
    pending.resolve(response);
    this.#flush();
  }
}
