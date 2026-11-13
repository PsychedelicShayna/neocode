import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type TerminalSummary,
} from "@t3tools/contracts";
import { selectRunningSubprocessTerminalIds } from "@t3tools/client-runtime/state/terminal";
import { workspaceResourceId } from "@t3tools/client-runtime/environment";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

import {
  attachedTerminalSessionAtom,
  knownTerminalSessionsAtom,
  selectKnownTerminalSessions,
} from "./terminalSessions";

const attachCalls = vi.hoisted(() => [] as unknown[]);
const metadataAtom = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return Atom.make<AsyncResult.AsyncResult<ReadonlyArray<TerminalSummary>>>(
    AsyncResult.initial(true),
  );
});
vi.mock("./terminal", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    terminalEnvironment: {
      attach: (request: unknown) => {
        attachCalls.push(request);
        return Atom.make(AsyncResult.initial(true));
      },
      metadata: () => metadataAtom,
    },
  };
});
vi.mock("./session", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const granted = Atom.make(AsyncResult.success({}));
  return {
    environmentSession: { sessionStateAtom: () => granted },
    sessionHasScope: () => true,
    useEnvironmentScope: () => true,
  };
});

const environmentA = EnvironmentId.make("environment-a");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

function summary(
  threadId: string,
  terminalId: string,
  changes: Partial<TerminalSummary> = {},
): TerminalSummary {
  return {
    threadId,
    terminalId,
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 123,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    label: "Terminal",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...changes,
  };
}

describe("selectKnownTerminalSessions", () => {
  it("selects native resource namespaces without conflating provider files or SQL threads", () => {
    const target = {
      environmentId: environmentA,
      ref: {
        providerInstanceId: ProviderInstanceId.make("neopi-a"),
        sessionFile: "/sessions/native.jsonl",
      },
    };
    const nativeId = workspaceResourceId(target);
    const otherId = workspaceResourceId({
      ...target,
      ref: { ...target.ref, providerInstanceId: ProviderInstanceId.make("neopi-b") },
    });
    const metadata = [
      summary(nativeId, "terminal-1", {
        cwd: "/native",
        status: "exited",
        hasRunningSubprocess: false,
      }),
      summary(otherId, "terminal-1", { cwd: "/other-profile" }),
      summary(threadA, "terminal-1", { cwd: "/legacy" }),
    ];
    const selected = selectKnownTerminalSessions(metadata, environmentA, nativeId);
    expect(
      selected.map((session) => ({
        namespace: session.target.threadId,
        cwd: session.state.summary?.cwd,
        status: session.state.status,
      })),
    ).toEqual([{ namespace: nativeId, cwd: "/native", status: "exited" }]);
    expect(selectRunningSubprocessTerminalIds(selected)).toEqual([]);
  });

  it("preserves numeric terminal order and stable picker ties across threads", () => {
    const metadata = [
      summary(threadB, "terminal-2"),
      summary(threadA, "terminal-10"),
      summary(threadB, "terminal-1"),
      summary(threadA, "terminal-1"),
      summary(threadA, "terminal-01"),
    ];
    const all = selectKnownTerminalSessions(metadata, environmentA, null);
    const selected = selectKnownTerminalSessions(metadata, environmentA, threadB);
    expect(all.map((session) => `${session.target.threadId}/${session.target.terminalId}`)).toEqual(
      [
        "thread-b/terminal-1",
        "thread-a/terminal-1",
        "thread-a/terminal-01",
        "thread-b/terminal-2",
        "thread-a/terminal-10",
      ],
    );
    expect(selected.map((session) => session.target.terminalId)).toEqual([
      "terminal-1",
      "terminal-2",
    ]);
    const repeated = [...metadata];
    expect(selectKnownTerminalSessions(repeated, environmentA, null)).toBe(all);
    expect(selectKnownTerminalSessions(repeated, environmentA, threadB)).toBe(selected);

    const reordered = metadata.toReversed();
    expect(selectKnownTerminalSessions(reordered, environmentA, threadB)).toBe(selected);
    expect(
      selectKnownTerminalSessions(reordered, environmentA, null).map(
        (session) => `${session.target.threadId}/${session.target.terminalId}`,
      ),
    ).toEqual([
      "thread-a/terminal-01",
      "thread-a/terminal-1",
      "thread-b/terminal-1",
      "thread-b/terminal-2",
      "thread-a/terminal-10",
    ]);
  });

  it("changes only the affected group and preserves earlier snapshots", () => {
    const first = summary(threadA, "terminal-1");
    const second = summary(threadA, "terminal-2");
    const other = summary(threadB, "terminal-1");
    const metadata = [first, second, other];
    const beforeA = selectKnownTerminalSessions(metadata, environmentA, threadA);
    const beforeB = selectKnownTerminalSessions(metadata, environmentA, threadB);
    Object.freeze(beforeA);
    Object.freeze(beforeB);
    const exited = {
      ...second,
      status: "exited" as const,
      pid: null,
      exitCode: 0,
      hasRunningSubprocess: false,
      label: "Finished",
      updatedAt: "2026-09-04T00:00:01.000Z",
    };
    const next = [first, other, exited];
    const afterA = selectKnownTerminalSessions(next, environmentA, threadA);
    expect(selectKnownTerminalSessions(next, environmentA, threadB)).toBe(beforeB);
    expect(afterA).not.toBe(beforeA);
    expect(afterA[0]).toBe(beforeA[0]);
    expect(afterA[1]?.state).toMatchObject({
      status: "exited",
      hasRunningSubprocess: false,
      summary: { label: "Finished", pid: null, exitCode: 0 },
    });
    expect(selectRunningSubprocessTerminalIds(afterA)).toEqual(["terminal-1"]);
    expect(beforeA[1]?.state).toMatchObject({
      status: "running",
      hasRunningSubprocess: true,
      summary: { label: "Terminal", pid: 123 },
    });
    expect(selectKnownTerminalSessions(metadata, environmentA, threadA)).toBe(beforeA);

    const renamed = [first, exited, { ...other, label: "Renamed" }];
    expect(selectKnownTerminalSessions(renamed, environmentA, threadA)).toBe(afterA);
    expect(
      selectKnownTerminalSessions(renamed, environmentA, threadB)[0]?.state.summary?.label,
    ).toBe("Renamed");
    expect(selectKnownTerminalSessions([other], environmentA, threadA)).toEqual([]);
    expect(selectKnownTerminalSessions([other], environmentA, threadB)).toBe(beforeB);
  });
});

describe("knownTerminalSessionsAtom", () => {
  const metadataResult = (...terminals: ReadonlyArray<TerminalSummary>) =>
    AsyncResult.success<ReadonlyArray<TerminalSummary>>(terminals);

  it("notifies only when the thread's own terminals change", () => {
    const registry = AtomRegistry.make();
    const sessions = knownTerminalSessionsAtom(environmentA, threadA);
    expect(registry.get(sessions)).toBeNull();

    const first = summary(threadA, "terminal-1");
    const other = summary(threadB, "terminal-1");
    registry.set(metadataAtom, metadataResult(first));
    const notified: unknown[] = [];
    const unsubscribe = registry.subscribe(sessions, (value) => notified.push(value));
    const before = registry.get(sessions);

    registry.set(metadataAtom, metadataResult(first, other));
    registry.set(metadataAtom, metadataResult(first, { ...other, label: "Renamed" }));
    expect(notified).toEqual([]);
    expect(registry.get(sessions)).toBe(before);

    registry.set(metadataAtom, metadataResult({ ...first, label: "Renamed" }, other));
    expect(notified).toHaveLength(1);

    const previousSuccess = Option.some(metadataResult(first));
    registry.set(metadataAtom, AsyncResult.failure(Cause.die("unavailable"), { previousSuccess }));
    expect(registry.get(sessions)).toBeNull();
    unsubscribe();
  });
});

describe("attachedTerminalSessionAtom", () => {
  it("attaches with the launch input it was keyed by", () => {
    attachCalls.length = 0;
    const input = {
      threadId: threadA,
      terminalId: "terminal-1",
      cwd: "/repo",
      worktreePath: null,
      env: { T3CODE_PROJECT_ROOT: "/repo" },
    };
    const atom = attachedTerminalSessionAtom(environmentA, input);
    expect(attachedTerminalSessionAtom(environmentA, { ...input })).toBe(atom);

    AtomRegistry.make().get(atom);
    expect(attachCalls).toEqual([{ environmentId: environmentA, input }]);
  });
});
