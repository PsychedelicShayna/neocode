import { EnvironmentId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";

export const layer = Layer.mock(McpSessionRegistry.McpSessionRegistry)({
  issue: ({ threadId, providerInstanceId }) =>
    Effect.succeed({
      config: {
        environmentId: EnvironmentId.make("environment:mcp-test"),
        threadId,
        providerSessionId: `mcp-test:${threadId}`,
        providerInstanceId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: `Bearer mcp-test:${threadId}`,
        browserToolsAvailable: true,
      },
    }),
  resolve: () => Effect.undefined,
  touch: () => Effect.void,
  revokeProviderSession: () => Effect.void,
  revokeThread: () => Effect.void,
  revokeAll: Effect.void,
});

export const layerNative = Layer.mergeAll(
  McpProviderSessions.layer,
  McpServer.McpServer.layer,
  McpSessionRegistry.layer.pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("native-adapter-regression")),
        getDescriptor: Effect.die(
          "The native adapter fixture does not read the environment descriptor",
        ),
      }),
    ),
    Layer.provide(
      Layer.succeed(HttpServer.HttpServer, {
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
).pipe(Layer.provideMerge(NodeCrypto.layer));
