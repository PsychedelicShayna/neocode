// @effect-diagnostics nodeBuiltinImport:off -- native identities use canonical filesystem paths.
import * as NodePath from "node:path";
import {
  NeoPiResumeCursor,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as DateTime from "effect/DateTime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../ProviderInstanceRegistry.ts";
import { neoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";

const decodeCursor = Schema.decodeUnknownOption(NeoPiResumeCursor);
const isConnected = (status: string | undefined) =>
  status === "ready" || status === "running" || status === "waiting";

/** Reads an existing V2 binding; it never creates a thread, runtime, or native lease. */
export const makeNeoPiThreadBindingReader = Effect.fn("NeoPiThreadBinding.make")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const fs = yield* FileSystem.FileSystem;
  return Effect.fn("NeoPiThreadBinding.read")(function* (threadId: ThreadId) {
    const shell = yield* projections.getThreadShell(threadId);
    if (!shell?.activeProviderThreadId) return undefined;
    const context = yield* projections.getThreadProviderContext(
      threadId,
      shell.providerInstanceId,
      true,
    );
    const providerThread = context.providerThreads.find(
      (candidate) => candidate.id === context.thread.activeProviderThreadId,
    );
    if (providerThread?.driver !== "neopi") return undefined;
    const cursor = decodeCursor(providerThread.nativeMetadata?.neopiResumeCursor);
    if (
      Option.isNone(cursor) ||
      !NodePath.isAbsolute(cursor.value.sessionFile) ||
      providerThread.nativeThreadRef?.nativeId !== cursor.value.sessionId
    )
      return undefined;
    const instance = yield* instances.getInstance(providerThread.providerInstanceId);
    const source = instance && neoPiSessionCatalogSource(instance);
    if (!instance?.enabled || instance.driverKind !== "neopi" || !source) return undefined;
    const project = yield* projects.get(context.thread.projectId);
    if (Option.isNone(project)) return undefined;
    const expected = {
      sessionId: cursor.value.sessionId,
      sessionFile: yield* fs.realPath(cursor.value.sessionFile),
    };
    const attachedSession = context.providerSessions.find(
      (candidate) => candidate.id === providerThread.providerSessionId,
    );
    const session = attachedSession ?? context.detachedActiveSession;
    const attached = attachedSession !== undefined;
    const connected = attached && isConnected(session?.status);
    const unchanged = Effect.gen(function* () {
      if ((yield* instances.getInstance(instance.instanceId)) !== instance) return false;
      const current = yield* projections.getThreadProviderContext(
        threadId,
        instance.instanceId,
        true,
      );
      if (current.thread.activeProviderThreadId !== providerThread.id) return false;
      const next = current.providerThreads.find((candidate) => candidate.id === providerThread.id);
      if (
        next?.driver !== "neopi" ||
        next.providerInstanceId !== instance.instanceId ||
        next.providerSessionId !== providerThread.providerSessionId ||
        next.nativeThreadRef?.nativeId !== expected.sessionId
      )
        return false;
      const currentAttachedSession = current.providerSessions.find(
        (candidate) => candidate.id === next.providerSessionId,
      );
      const currentAttached = currentAttachedSession !== undefined;
      const currentSession = currentAttachedSession ?? current.detachedActiveSession;
      if (
        currentAttached !== attached ||
        (currentAttached && isConnected(currentSession?.status)) !== connected
      )
        return false;
      const nextCursor = decodeCursor(next.nativeMetadata?.neopiResumeCursor);
      if (Option.isNone(nextCursor) || nextCursor.value.sessionId !== expected.sessionId)
        return false;
      return (yield* fs.realPath(nextCursor.value.sessionFile)) === expected.sessionFile;
    });
    return {
      thread: context.thread,
      providerThread,
      cursor: cursor.value,
      instance,
      source,
      expected,
      session,
      attached,
      connected,
      cwd: context.thread.worktreePath ?? project.value.workspaceRoot,
      unchanged,
    };
  });
});

export const makeNeoPiThreadStateWriter = Effect.fn("NeoPiThreadBinding.makeWriter")(function* () {
  const events = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  return Effect.fn("NeoPiThreadBinding.write")(function* (input: {
    readonly expected: OrchestrationV2ProviderThread;
    readonly expectedSession: OrchestrationV2ProviderSession;
    readonly expectedAttached: boolean;
    readonly next: OrchestrationV2ProviderThread;
  }) {
    const threadId = input.expected.appThreadId;
    if (threadId === null) return false;
    const now = yield* DateTime.now;
    const result = yield* events.writeIfProviderThreadUnchanged({
      expected: input.expected,
      expectedSession: input.expectedSession,
      expectedSessionAttached: input.expectedAttached,
      requireActiveThread: true,
      events: [
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "provider-thread.updated",
          threadId,
          driver: input.expected.driver,
          providerInstanceId: input.expected.providerInstanceId,
          occurredAt: now,
          payload: { ...input.next, updatedAt: now },
        },
      ],
    });
    return result.committed;
  });
});
