import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Atom } from "effect/unstable/reactivity";

export interface NativeStatsResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly text: () => Promise<string>;
}

export interface NativeStatsRequest {
  readonly instanceId: string;
  readonly viewId: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly consume: (response: NativeStatsResponse) => Promise<void>;
}

export const requestNativeStats = (input: NativeStatsRequest) => Effect.scoped(Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) return yield* Effect.fail(new Error("The selected environment is not connected."));
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const path = `/api/neopi-stats/${encodeURIComponent(input.instanceId)}/${encodeURIComponent(input.viewId)}${input.path}`;
    const response = yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: prepared.value, signer, remoteAuthorization,
      // Raw native bytes share the environment auth pipeline with typed metadata requests.
      group: "metadata", method: input.method, timeoutMs: 45_000,
      url: (base) => environmentEndpointUrl(base, path),
      request: ({ headers, url }) => client.execute(HttpClientRequest.make(input.method)(url).pipe(
        HttpClientRequest.setHeaders({ ...input.headers, ...headers }),
      )),
      isUnauthorizedResponse: (result) => result.status === 401,
    });
    const body = response.status === 204 || response.status === 304 ? null : yield* Stream.toReadableStreamEffect(response.stream);
    yield* Effect.tryPromise(() => input.consume({
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: new Headers(Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => entry[1] !== undefined))),
      body,
      text: async () => {
        if (!body) return "";
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return text + decoder.decode();
            text += decoder.decode(chunk.value, { stream: true });
          }
        } finally { reader.releaseLock(); }
      },
    }));
  })).pipe(Effect.raceFirst(Effect.callback<never>((resume) => {
    const abort = () => resume(Effect.interrupt);
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    return Effect.sync(() => input.signal.removeEventListener("abort", abort));
  })));

export const createNativeStatsRequest = <R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, ER>,
) => createEnvironmentCommand(runtime, { label: "Native stats request", execute: requestNativeStats });
