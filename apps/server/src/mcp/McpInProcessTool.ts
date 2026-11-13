import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { McpSchema, McpServer } from "effect/ai";

import packageJson from "../../package.json" with { type: "json" };
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

export class McpHostTool extends Context.Service<
  McpHostTool,
  {
    readonly capability: McpInvocationContext.McpCapability;
    readonly definition: {
      readonly name: string;
      readonly description: string;
      readonly parameters: Record<string, unknown>;
      readonly loadMode: "discoverable";
    };
  }
>()("t3/mcp/McpInProcessTool/McpHostTool") {}

const hostToolClientInfo = { name: "t3-code", version: packageJson.version };
const hostToolClientCapabilities = {};
const hostToolClient = McpSchema.McpServerClient.of({
  clientId: 0,
  protocolVersion: "2025-06-18",
  clientCapabilities: hostToolClientCapabilities,
  clientInfo: hostToolClientInfo,
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: hostToolClientCapabilities,
    clientInfo: hostToolClientInfo,
  },
  getClient: Effect.die("Host tools do not support MCP reverse requests"),
});
export class McpInProcessToolError extends Schema.TaggedError<McpInProcessToolError>()(
  "McpInProcessToolError",
  { message: Schema.String },
) {}

/** Invoke the registered MCP tool directly, preserving its validation and image handling. */
export const invokeRegisteredMcpTool = Effect.fn("McpHttpServer.invokeRegisteredMcpTool")(
  function* (
    authorizationHeader: string,
    name: string,
    args: Record<string, unknown>,
  ): Effect.fn.Return<
    McpSchema.CallToolResult,
    McpInProcessToolError,
    McpSessionRegistry.McpSessionRegistry | McpServer.McpServer | Scope.Scope
  > {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const server = yield* McpServer.McpServer;
    const registered = server.tools.find((entry) => entry.tool.name === name);
    const capability =
      registered && Context.getOrUndefined(registered.annotations, McpHostTool)?.capability;
    if (!capability)
      return yield* new McpInProcessToolError({ message: `Unsupported host tool: ${name}` });
    const scope = yield* registry.resolve(authorizationHeader.replace(/^Bearer\s+/i, ""));
    if (!scope || !scope.capabilities.has(capability))
      return yield* new McpInProcessToolError({ message: "access revoked" });
    if (scope.revoked?.aborted)
      return yield* new McpInProcessToolError({ message: "access revoked" });
    return yield* server.callTool({ name, arguments: args }).pipe(
      // Only request identity and lifetime may override the owning handler services.
      Effect.updateContext((current: Context.Context<Scope.Scope>) =>
        Context.pick(Scope.Scope)(current).pipe(
          Context.add(McpSchema.McpServerClient, hostToolClient),
          Context.add(McpInvocationContext.McpInvocationContext, scope),
        ),
      ),
      Effect.mapError((error) => new McpInProcessToolError({ message: error.message })),
      Effect.raceFirst(
        Effect.callback<never, McpInProcessToolError>((resume) => {
          const signal = scope.revoked;
          if (!signal) return;
          const cancel = () =>
            resume(Effect.fail(new McpInProcessToolError({ message: "access revoked" })));
          if (signal.aborted) {
            cancel();
            return;
          }
          signal.addEventListener("abort", cancel, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", cancel));
        }),
      ),
    );
  },
);
