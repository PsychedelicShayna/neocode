import { assert, it } from "@effect/vitest";
import {
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { terminalAttachStream, terminalEventsStream } from "./EventStream.ts";
import type { TerminalManager } from "./Manager.ts";

type Listener<A> = (event: A) => Effect.Effect<void>;
const input = { threadId: "thread-1", terminalId: "terminal-1" };
const initialSnapshot: TerminalSessionSnapshot = {
  ...input,
  cwd: "/workspace",
  worktreePath: null,
  status: "running",
  pid: 42,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "bash",
  updatedAt: "2026-11-04T00:00:00.000Z",
  sequence: 0,
};

function makeManager(history = "") {
  const attachListeners = new Set<Listener<TerminalAttachStreamEvent>>();
  const eventListeners = new Set<Listener<TerminalEvent>>();
  const state = {
    snapshot: { ...initialSnapshot, history } as TerminalSessionSnapshot | null,
    attaches: 0,
    unsubscribes: 0,
    snapshots: 0,
  };
  const manager: Pick<TerminalManager["Service"], "attachStream" | "getSnapshot" | "subscribe"> = {
    attachStream: (_input, listener) =>
      Effect.gen(function* () {
        state.attaches += 1;
        attachListeners.add(listener);
        yield* listener({ type: "snapshot", snapshot: state.snapshot! });
        return () => {
          state.unsubscribes += 1;
          attachListeners.delete(listener);
        };
      }),
    getSnapshot: () =>
      Effect.sync(() => {
        state.snapshots += 1;
        return state.snapshot;
      }),
    subscribe: (listener) =>
      Effect.gen(function* () {
        eventListeners.add(listener);
        yield* listener({ type: "started", ...input, snapshot: state.snapshot! });
        return () => {
          state.unsubscribes += 1;
          eventListeners.delete(listener);
        };
      }),
  };
  const deliver = (data: string, sequence: number, updateHistory = true) =>
    Effect.gen(function* () {
      if (state.snapshot !== null && updateHistory) {
        state.snapshot = { ...state.snapshot, history: state.snapshot.history + data, sequence };
      }
      const event = { type: "output" as const, ...input, data, sequence };
      for (const listener of attachListeners) yield* listener(event);
      for (const listener of eventListeners) yield* listener(event);
    });
  return { manager, state, deliver };
}

it.effect(
  "resnapshots a stalled attach without delaying a healthy subscriber or replaying duplicate bytes",
  () =>
    Effect.gen(function* () {
      const { manager, state, deliver } = makeManager();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const slow = yield* Stream.toPull(terminalAttachStream(manager, input));
          const fast = yield* Stream.toPull(terminalAttachStream(manager, input));
          yield* slow;
          yield* fast;
          for (let index = 1; index <= 600; index += 1) {
            const data = `[${index}]`;
            yield* deliver(data, index);
            assert.deepEqual(yield* fast, [{ type: "output", ...input, data, sequence: index }]);
          }
          // No pull/ACK from slow occurred during the burst. Its bounded backlog is
          // replaced with an authoritative snapshot rather than a partial VT stream.
          assert.equal(state.snapshots, 0);
          assert.deepEqual(yield* slow, [{ type: "resync", ...input, snapshot: state.snapshot }]);
          assert.equal(state.snapshots, 1);
          assert.equal(state.attaches, 2);

          // A manager publish may lag behind history mutation. That old publication
          // must not be appended again after a newer resync snapshot.
          yield* deliver("[600]", 600, false);
          yield* deliver("next", 601);
          assert.deepEqual(yield* slow, [
            { type: "output", ...input, data: "next", sequence: 601 },
          ]);
        }),
      );
      assert.equal(state.unsubscribes, 2);
    }),
);

it.effect("bounds oversized chunks and snapshots without entering a resnapshot loop", () =>
  Effect.gen(function* () {
    const history = "🙂".repeat(200_000);
    const { manager, state, deliver } = makeManager(history);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(terminalAttachStream(manager, input));
        assert.deepEqual(yield* pull, [{ type: "resync", ...input, snapshot: state.snapshot }]);
        assert.equal(state.snapshots, 1);
        yield* deliver(history, 1);
        assert.deepEqual(yield* pull, [{ type: "resync", ...input, snapshot: state.snapshot }]);
        assert.equal(state.snapshots, 2);
        yield* deliver("tail", 2);
        assert.deepEqual(yield* pull, [{ type: "output", ...input, data: "tail", sequence: 2 }]);
        for (let sequence = 3; sequence <= 12; sequence += 1) {
          yield* deliver("x".repeat(32_768), sequence);
        }
        assert.deepEqual(yield* pull, [{ type: "resync", ...input, snapshot: state.snapshot }]);
        assert.equal(state.snapshots, 3);
      }),
    );
    assert.equal(state.unsubscribes, 1);
  }),
);

it.effect("reports a close racing an overflowing subscriber without reopening the terminal", () =>
  Effect.gen(function* () {
    const { manager, state, deliver } = makeManager();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(terminalAttachStream(manager, input));
        yield* pull;
        for (let index = 1; index <= 600; index += 1) yield* deliver("x", index);
        state.snapshot = null;
        assert.deepEqual(yield* pull, [{ type: "resync", ...input, snapshot: null }]);
        assert.equal(state.attaches, 1);
      }),
    );
    assert.equal(state.unsubscribes, 1);
  }),
);

it.effect("gives legacy subscribers an explicit resync boundary before more live output", () =>
  Effect.gen(function* () {
    const { manager, state, deliver } = makeManager();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(terminalEventsStream(manager));
        assert.deepEqual(yield* pull, [{ type: "started", ...input, snapshot: state.snapshot }]);
        for (let index = 1; index <= 600; index += 1) yield* deliver("x", index);
        assert.deepEqual(yield* pull, [{ type: "resync" }]);
        yield* deliver("live", 601);
        assert.deepEqual(yield* pull, [{ type: "output", ...input, data: "live", sequence: 601 }]);
      }),
    );
    assert.equal(state.unsubscribes, 1);
  }),
);
