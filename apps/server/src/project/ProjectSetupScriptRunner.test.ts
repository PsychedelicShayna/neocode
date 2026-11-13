import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  TerminalNotRunningError,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { nativeWorkspaceResourceId } from "@t3tools/shared/neopiWorkspace";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";

import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const threadId = "thread-1";
const terminalId = "setup-setup";
const event = { threadId, terminalId, sequence: 1, createdAt: "2026-01-01T00:00:00.000Z" };

const openSnapshot = (history: string): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/repo/.t3/worktrees/feature",
  worktreePath: null,
  status: "running",
  pid: 123,
  history,
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeHarness = Effect.fn(function* (options: {
  readonly history?: string;
  readonly opening?: Deferred.Deferred<void>;
  readonly shell?: string | null;
  readonly beforeWrite?: Effect.Effect<void>;
  readonly native?: boolean;
}) {
  const ref = {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: "/sessions/task.jsonl",
  };
  const resourceId = options.native ? nativeWorkspaceResourceId(ref) : threadId;
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const writes = yield* Queue.unbounded<string>();
  const outputLines = yield* Queue.unbounded<string>();
  const terminals = Layer.mock(TerminalManager.TerminalManager)({
    open: () =>
      (options.opening
        ? Deferred.succeed(options.opening, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.void
      ).pipe(Effect.as(openSnapshot(options.history ?? ""))),
    getShell: () =>
      options.shell === null
        ? Effect.fail(new TerminalNotRunningError({ threadId, terminalId }))
        : Effect.succeed(options.shell ?? "/bin/zsh"),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    write: (input) =>
      (options.beforeWrite ?? Effect.void).pipe(
        Effect.andThen(Queue.offer(writes, input.data)),
        Effect.asVoid,
      ),
    closeIdle: () => Effect.void,
    closeOnSettle: () => Effect.void,
  });
  const runner = yield* ProjectSetupScriptRunner.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        terminals,
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            options.native
              ? Effect.die("Native workspace setup must not query a SQL thread")
              : Effect.succeed(null),
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
  );
  const input = {
    threadId,
    worktreePath: "/repo/.t3/worktrees/feature",
    observeCompletion: { onOutputLine: (line) => Queue.offer(outputLines, line) },
    project: {
      id: ProjectId.make("project-1"),
      workspaceRoot: "/repo",
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "vp i",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    },
  } satisfies ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput;
  const start = options.native
    ? runner.runForWorkspace({
        ref,
        worktreePath: input.worktreePath,
        observeCompletion: input.observeCompletion,
        project: input.project,
      })
    : runner.runForThread(input);
  const emit = (terminalEvent: TerminalEvent) =>
    Effect.forEach(
      [...listeners],
      (listener) => listener({ ...terminalEvent, threadId: resourceId }),
      { discard: true },
    );
  return { start, listeners, writes, outputLines, emit };
});

const setup = Effect.fn(function* (
  options: {
    readonly history?: string;
    readonly shell?: string | null;
    readonly native?: boolean;
  } = {},
) {
  const harness = yield* makeHarness(options);
  const result = yield* harness.start;
  const completion = result.status === "started" ? result.completion : undefined;
  if (!completion) return yield* Effect.die("setup did not start an observed run");
  return { ...harness, result, completion };
});

describe("ProjectSetupScriptRunner", () => {
  it.effect("writes immediately when the spawned fallback is PowerShell", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup({
        shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      });
      expect(yield* Queue.take(writes)).toContain("$global:LASTEXITCODE");
    }),
  );

  it.effect("shows a startup prompt and types only once the line editor starts", () =>
    Effect.gen(function* () {
      const { result, writes, outputLines, emit } = yield* setup();
      expect(result).toMatchObject({ status: "started", terminalId });

      yield* emit({ ...event, type: "output", data: "Missing Node.\r\nInstall it? [y/N]: " });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      expect(yield* Queue.takeAll(outputLines)).toEqual(["Missing Node.", "Install it? [y/N]:"]);

      yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
      yield* emit({ ...event, type: "output", data: "\r\n% \x1b[?2004h" });
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("types into a quiet shell that has no line editor", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup();
      yield* TestClock.adjust("3 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("ignores line editor state restored from an earlier shell", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup({ history: "old run\r\n% \x1b[?2004h" });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
    }),
  );

  it.effect("forgets a busy startup child when the shell restarts", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup();
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      yield* emit({ ...event, type: "restarted", snapshot: openSnapshot("") });
      // The restart lands inside a quiet window, so the next full window decides.
      yield* TestClock.adjust("6 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("drops its terminal listeners when cancelled while the terminal opens", () =>
    Effect.gen(function* () {
      const opening = yield* Deferred.make<void>();
      const { start, listeners } = yield* makeHarness({ opening });
      const fiber = yield* Effect.forkChild(start);
      yield* Deferred.await(opening);
      expect(listeners.size).toBe(2);
      yield* Fiber.interrupt(fiber);
      expect(listeners.size).toBe(0);
    }),
  );

  it.effect.each([false, true])(
    "does not type into a shell that exits during startup (before shell lookup: %s)",
    (beforeShellLookup) =>
      Effect.gen(function* () {
        const { completion, writes, emit, listeners } = yield* setup(
          beforeShellLookup ? { shell: null } : {},
        );
        if (!beforeShellLookup) {
          yield* emit({ ...event, type: "exited", exitCode: 1, exitSignal: null });
        }
        expect(yield* completion).toMatchObject({ exitCode: null });
        yield* TestClock.adjust("1 minute");
        expect(yield* Queue.size(writes)).toBe(0);
        expect(listeners.size).toBe(0);
      }),
  );

  it.effect.each([false, true])(
    "releases a closed terminal's completion observer before completion is awaited (native: %s)",
    (native) =>
      Effect.gen(function* () {
        const { completion, writes, emit, listeners } = yield* setup({
          shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          native,
        });
        yield* Queue.take(writes);
        expect(listeners.size).toBe(1);
        yield* emit({ ...event, type: "closed" });
        expect(listeners.size).toBe(0);
        expect(yield* completion).toMatchObject({ exitCode: null });
      }),
  );

  it.effect(
    "keeps the prompt-redraw receipt without leaking an unconsumed completion observer",
    () =>
      Effect.gen(function* () {
        const { completion, writes, emit, listeners } = yield* setup({
          shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        });
        const command = yield* Queue.take(writes);
        const sentinel = /(__T3_SETUP_DONE___[a-f0-9]{32}:)/.exec(command)?.[1];
        if (!sentinel) return yield* Effect.die("setup command has no completion sentinel");
        yield* emit({ ...event, type: "output", data: `${sentinel}3\r\n` });
        expect(listeners.size).toBe(1);
        yield* emit({ ...event, type: "output", data: "PS> " });
        expect(listeners.size).toBe(0);
        expect(yield* completion).toMatchObject({ exitCode: 3 });
      }),
  );

  it.effect(
    "releases unconsumed completion observation when a background write is interrupted",
    () =>
      Effect.gen(function* () {
        const writing = yield* Deferred.make<void>();
        const listeners = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeHarness({
              shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              beforeWrite: Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
            });
            expect(yield* harness.start).toMatchObject({ status: "started" });
            yield* Deferred.await(writing);
            expect(harness.listeners.size).toBe(1);
            return harness.listeners;
          }),
        );
        expect(listeners.size).toBe(0);
      }),
  );
});
