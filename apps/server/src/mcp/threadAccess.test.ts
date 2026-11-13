import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { nativeWorkspaceResourceId } from "@t3tools/shared/neopiWorkspace";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { readThread } from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.effect("rejects a native workspace credential before SQL thread lookup", () =>
  Effect.gen(function* () {
    const sessionRef = {
      providerInstanceId: ProviderInstanceId.make("native"),
      sessionFile: "/native/session.jsonl",
    };
    const error = yield* readThread(bareId).pipe(
      Effect.flip,
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        kind: "native",
        environmentId: client.environmentId,
        requestNamespace: "native-connection",
        thread: undefined,
        client: undefined,
        threadId: nativeWorkspaceResourceId(sessionRef),
        providerInstanceId: sessionRef.providerInstanceId,
        providerSessionId: "native-connection",
        sessionRef,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 1,
      }),
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.die("Native authority reached SQL thread lookup"),
        }),
      ),
    );
    expect(error.code).toBe("capability_denied");
  }),
);
