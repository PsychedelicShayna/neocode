// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { expect } from "vite-plus/test";

import { makeNeoPiModelsConnection } from "./NeoPiModelsConnection.ts";

const MOCK_PEER_PATH = new URL(
  "../../../../../packages/effect-neopi-rpc/test/fixtures/neopi-mock-peer.ts",
  import.meta.url,
).pathname;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const BURST = 5_000;

const scenario = {
  scenario: [
    {
      emit: [
        {
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1_048_576,
          maxReassembledFrameBytes: 67_108_864,
          capabilities: ["rpc-ui"],
        },
      ],
    },
    {
      on: { type: "negotiate_protocol", protocolVersion: 2 },
      emit: [
        {
          id: "$id",
          type: "response",
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        },
      ],
    },
    {
      on: { type: "get_models_configuration" },
      emit: [
        ...Array.from({ length: BURST }, () => ({ type: "models_configuration_changed" })),
        // An unanswered login prompt, then a burst of UI traffic that is not this flow's.
        {
          type: "extension_ui_request",
          id: "prompt",
          method: "input",
          title: "Code",
          loginId: "flow",
        },
        ...Array.from({ length: BURST }, (_, index) => ({
          type: "extension_ui_request",
          id: `ui-${index}`,
          method: "notify",
          ...(index % 2 === 0 ? { loginId: "other-flow" } : {}),
          message: `m${index}`,
        })),
        {
          type: "extension_ui_request",
          id: "done",
          method: "notify",
          loginId: "flow",
          message: "end",
        },
        {
          id: "$id",
          type: "response",
          command: "get_models_configuration",
          success: true,
          data: {},
        },
      ],
    },
    {
      on: { type: "get_models_configuration" },
      emit: [
        { type: "models_configuration_changed" },
        {
          id: "$id",
          type: "response",
          command: "get_models_configuration",
          success: true,
          data: {},
        },
      ],
    },
  ],
};

const open = Effect.gen(function* () {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-neopi-models-test-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );
  const scenarioPath = NodePath.join(root, "scenario.json");
  NodeFS.writeFileSync(scenarioPath, encodeJson(scenario), "utf8");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeNeoPiModelsConnection({
    spawn: spawner.spawn,
    command: process.execPath,
    args: [MOCK_PEER_PATH, scenarioPath],
    cwd: root,
    env: {},
  });
});

/** Subscribes, then stalls on its first item until released; everything after it queues in the subscription. */
const stalledReader = <A, E>(stream: Stream.Stream<A, E>, gate: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const seen: Array<A> = [];
    const first = yield* Deferred.make<void>();
    yield* stream.pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          seen.push(item);
          if (seen.length === 1) {
            yield* Deferred.succeed(first, undefined);
            yield* Deferred.await(gate);
          }
        }),
      ),
      Effect.forkScoped,
    );
    return { seen, first };
  });

it.live("keeps one change signal for a stalled reader and every prompt of its login flow", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* open;
      const gate = yield* Deferred.make<void>();
      const changes = yield* stalledReader(connection.changes, gate);
      const ui = yield* stalledReader(yield* connection.loginUi("flow"), gate);
      yield* Effect.yieldNow;
      yield* connection.request({ type: "get_models_configuration" });
      yield* Deferred.await(changes.first);
      yield* Deferred.await(ui.first);
      yield* Deferred.succeed(gate, undefined);
      yield* Effect.sleep(200);
      // The first signal was taken before it stalled; the rest collapsed into at most one more.
      expect(changes.seen.length).toBeLessThanOrEqual(2);
      // The unanswered prompt survives the unrelated burst; nothing else was queued for the flow.
      expect(ui.seen.map((frame) => frame.id)).toEqual(["prompt", "done"]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "keeps nothing for an observer that attaches after the burst, then announces the next",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* open;
        yield* connection.request({ type: "get_models_configuration" });
        const changes = yield* Stream.toPull(connection.changes);
        expect((yield* Effect.timeoutOption(changes, 50))._tag).toBe("None");
        yield* connection.request({ type: "get_models_configuration" });
        expect((yield* changes).length).toBe(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
