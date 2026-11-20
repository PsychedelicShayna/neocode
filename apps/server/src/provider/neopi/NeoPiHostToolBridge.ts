import type { NeoPiNativeSessionRef, NeoPiNativeSessionsError } from "@t3tools/contracts";
import { nativeWorkspaceResourceId } from "@t3tools/shared/neopiWorkspace";
import type {
  AgentToolResultWire,
  HostToolCallFrame,
  HostToolCancelFrame,
  NeoPiRpcTransport,
} from "effect-neopi-rpc/client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";
import { invokeRegisteredMcpTool, McpInProcessToolError } from "../../mcp/McpHttpServer.ts";
import type { McpCapability, McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import {
  issueActiveNativeMcpCredential,
  resolveActiveMcpCredential,
  revokeActiveMcpProviderSession,
} from "../../mcp/McpSessionRegistry.ts";
import { DeviceToolkit } from "../../mcp/toolkits/device/tools.ts";
import { PreviewToolkit } from "../../mcp/toolkits/preview/tools.ts";
import { PullRequestsToolkit } from "../../mcp/toolkits/pullRequests/tools.ts";

export interface NeoPiHostToolBridge {
  readonly definitions: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly loadMode: "discoverable";
  }>;
  readonly handle: (
    call: HostToolCallFrame,
    signal: AbortSignal,
  ) => Effect.Effect<AgentToolResultWire>;
}

const definitionsFor = (tools: Record<string, Tool.Any>) =>
  Object.values(tools).map((tool) => ({
    name: tool.name,
    description: Tool.getDescription(tool) ?? tool.name,
    parameters: Tool.getJsonSchema(tool),
    loadMode: "discoverable" as const,
  }));

const failed = (message: string): AgentToolResultWire => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Uses the existing registered MCP handlers with a revocable SQL or canonical native scope. */
export const makeNeoPiHostToolBridge = Effect.fn("NeoPiHostToolBridge.make")(function* (input: {
  readonly threadId: string;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly credential: string;
  readonly context: McpInvocationScope;
}) {
  const granted = new Set(
    [...input.capabilities].filter((capability) => input.context.capabilities.has(capability)),
  );
  const definitions = [
    ...(granted.has("preview") ? definitionsFor(PreviewToolkit.tools) : []),
    ...(granted.has("device") ? definitionsFor(DeviceToolkit.tools) : []),
    ...(granted.has("pull-requests") ? definitionsFor(PullRequestsToolkit.tools) : []),
  ];
  const names = new Set(definitions.map((definition) => definition.name));
  const handle: NeoPiHostToolBridge["handle"] = (call, signal) => {
    if (signal.aborted) return Effect.succeed(failed("Host tool cancelled"));
    if (!names.has(call.toolName)) {
      return Effect.succeed(failed(`Unsupported host tool: ${call.toolName}`));
    }
    return Effect.gen(function* () {
      const scope = yield* resolveActiveMcpCredential(input.credential);
      if (
        !scope ||
        scope.threadId !== input.threadId ||
        scope.environmentId !== input.context.environmentId ||
        scope.kind !== input.context.kind ||
        scope.providerSessionId !== input.context.providerSessionId ||
        scope.providerInstanceId !== input.context.providerInstanceId ||
        scope.revoked?.aborted ||
        (scope.kind === "native" &&
          (input.context.kind !== "native" ||
            scope.sessionRef.providerInstanceId !== scope.providerInstanceId ||
            scope.sessionRef.providerInstanceId !== input.context.sessionRef.providerInstanceId ||
            scope.sessionRef.sessionFile !== input.context.sessionRef.sessionFile ||
            scope.threadId !== nativeWorkspaceResourceId(scope.sessionRef)))
      ) {
        return failed("access revoked");
      }
      const result = yield* invokeRegisteredMcpTool(
        input.credential,
        call.toolName,
        call.arguments,
      );
      const content: Array<AgentToolResultWire["content"][number]> = [];
      for (const block of result.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          content.push({
            type: "image",
            data: Buffer.from(block.data).toString("base64"),
            mimeType: block.mimeType,
          });
        }
      }
      return {
        content,
        ...(result.structuredContent === undefined ? {} : { details: result.structuredContent }),
        ...(result.isError ? { isError: true } : {}),
      } satisfies AgentToolResultWire;
    }).pipe(
      Effect.raceFirst(
        Effect.callback<never, McpInProcessToolError>((resume) => {
          if (signal.aborted) {
            resume(Effect.fail(new McpInProcessToolError({ message: "Host tool cancelled" })));
            return;
          }
          const cancel = () =>
            resume(Effect.fail(new McpInProcessToolError({ message: "Host tool cancelled" })));
          signal.addEventListener("abort", cancel, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", cancel));
        }),
      ),
      Effect.matchCause({
        onFailure: (cause) => {
          const error = cause.reasons.find(Cause.isFailReason)?.error;
          return failed(error instanceof Error ? error.message : Cause.pretty(cause));
        },
        onSuccess: (result) => result,
      }),
    );
  };
  return { definitions, handle } satisfies NeoPiHostToolBridge;
});

/** Each pump belongs to one transport; terminal registration requires connection_owned_host_tools. */
export const makeNeoPiNativeHostToolPump = Effect.fn("NeoPiHostToolBridge.nativePump")(function* (
  peer: Pick<NeoPiRpcTransport, "hostToolResult"> & {
    readonly hostToolCalls: Stream.Stream<HostToolCallFrame | HostToolCancelFrame>;
  },
  validate: (ref: NeoPiNativeSessionRef) => Effect.Effect<void, NeoPiNativeSessionsError>,
) {
  const lifetime = yield* Effect.scope;
  const workScope = yield* Scope.fork(lifetime);
  const mutation = yield* Semaphore.make(1);
  let closed = false;
  const pending = new Map<string, AbortController>();
  let binding:
    | {
        readonly ref: NeoPiNativeSessionRef;
        readonly bridge: NeoPiHostToolBridge;
        readonly providerSessionId: string;
      }
    | undefined;
  const revoke = Effect.gen(function* () {
    const previous = binding;
    binding = undefined;
    const requests = Array.from(pending);
    pending.clear();
    for (const [, controller] of requests) controller.abort();
    if (previous) yield* revokeActiveMcpProviderSession(previous.providerSessionId);
    for (const [id] of requests)
      yield* peer
        .hostToolResult(id, failed("access revoked"), true)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Native host-tool revocation response failed", { cause }),
          ),
        );
  });
  const bind = Effect.fnUntraced(
    function* (ref: NeoPiNativeSessionRef, capabilities: ReadonlySet<McpCapability>) {
      if (closed)
        return yield* new McpInProcessToolError({
          message: "Native host-tool connection is closed",
        });
      yield* revoke;
      const credential = yield* issueActiveNativeMcpCredential({ sessionRef: ref, capabilities });
      if (!credential)
        return yield* new McpInProcessToolError({
          message: "Native host-tool credential registry is unavailable",
        });
      const bridge = yield* makeNeoPiHostToolBridge({
        threadId: nativeWorkspaceResourceId(ref),
        capabilities,
        credential: credential.authorizationHeader,
        context: credential.scope,
      });
      binding = { ref: { ...ref }, bridge, providerSessionId: credential.scope.providerSessionId };
      return bridge.definitions;
    },
    mutation.withPermit,
    Effect.uninterruptible,
  );
  yield* Stream.runForEach(peer.hostToolCalls, (call) =>
    Effect.gen(function* () {
      if (call.type === "host_tool_cancel") {
        pending.get(call.targetId)?.abort();
        pending.delete(call.targetId);
        return;
      }
      const current = binding;
      const controller = new AbortController();
      // A duplicate native request id must not leave its previous execution running.
      pending.get(call.id)?.abort();
      pending.set(call.id, controller);
      yield* Effect.gen(function* () {
        if (!current) return failed("Native host tools are not bound to a canonical session");
        const valid = yield* validate(current.ref).pipe(Effect.result);
        if (valid._tag === "Failure") {
          yield* revokeActiveMcpProviderSession(current.providerSessionId);
          return failed(
            valid.failure instanceof Error ? valid.failure.message : String(valid.failure),
          );
        }
        if (binding !== current || controller.signal.aborted) return failed("access revoked");
        return yield* current.bridge.handle(call, controller.signal);
      }).pipe(
        Effect.flatMap((result) =>
          pending.get(call.id) === controller && !controller.signal.aborted
            ? peer.hostToolResult(call.id, result, result.isError)
            : Effect.void,
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (pending.get(call.id) === controller) pending.delete(call.id);
          }),
        ),
        Effect.catch((cause) => Effect.logWarning("Native host-tool response failed", { cause })),
        Effect.forkIn(workScope),
      );
    }),
  ).pipe(Effect.forkIn(workScope));
  // Revoke and answer pending calls before the worker scope is interrupted.
  yield* Effect.addFinalizer(() => {
    closed = true;
    return mutation.withPermit(revoke);
  });
  return { bind, revoke: mutation.withPermit(revoke).pipe(Effect.uninterruptible) };
});
