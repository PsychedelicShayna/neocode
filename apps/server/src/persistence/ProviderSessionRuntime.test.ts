import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionRuntime from "./ProviderSessionRuntime.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));

it.layer(layer)("stopped provider runtime cursors", (it) => {
  it.effect("updates only a stopped cursor without inserting or replacing a live writer", () =>
    Effect.gen(function* () {
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const binding = {
        threadId: ThreadId.make("history-cursor-cas"),
        providerName: "neopi",
        providerInstanceId: ProviderInstanceId.make("neopi"),
        adapterKey: "neopi",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-10-19T00:00:00.000Z",
        resumeCursor: { historyLeafId: "old" },
        runtimePayload: { model: "saved-model" },
      } as const satisfies ProviderSessionRuntime.ProviderSessionRuntime;
      yield* runtimes.upsert(binding);
      yield* runtimes.upsert(
        {
          ...binding,
          resumeCursor: { historyLeafId: "restored" },
          runtimePayload: { model: "must-not-replace" },
        },
        { onlyUpdateStoppedCursor: true },
      );
      expect(Option.getOrThrow(yield* runtimes.getByThreadId(binding))).toEqual({
        ...binding,
        resumeCursor: { historyLeafId: "restored" },
      });
      const writer = {
        ...binding,
        status: "running",
        resumeCursor: { historyLeafId: "writer" },
      } as const;
      yield* runtimes.upsert(writer);
      yield* runtimes.upsert(
        { ...binding, resumeCursor: { historyLeafId: "stale-restore" } },
        { onlyUpdateStoppedCursor: true },
      );
      expect(Option.getOrThrow(yield* runtimes.getByThreadId(binding))).toEqual(writer);
      const threadId = ThreadId.make("missing-history-cursor");
      yield* runtimes.upsert({ ...binding, threadId }, { onlyUpdateStoppedCursor: true });
      expect(Option.isNone(yield* runtimes.getByThreadId({ threadId }))).toBe(true);
    }),
  );

  it.effect("admits only the promoted default instance for a null-instance legacy row", () =>
    Effect.gen(function* () {
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const binding = {
        threadId: ThreadId.make("legacy-null-history-cursor"),
        providerName: "neopi",
        providerInstanceId: null,
        adapterKey: "neopi",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-10-19T00:00:00.000Z",
        resumeCursor: { historyLeafId: "old" },
        runtimePayload: { model: "saved-model" },
      } as const satisfies ProviderSessionRuntime.ProviderSessionRuntime;
      yield* runtimes.upsert(binding);
      yield* runtimes.upsert(
        {
          ...binding,
          providerInstanceId: ProviderInstanceId.make("neopi-other"),
          resumeCursor: { historyLeafId: "wrong-instance" },
        },
        { onlyUpdateStoppedCursor: true },
      );
      expect(Option.getOrThrow(yield* runtimes.getByThreadId(binding))).toEqual(binding);
      yield* runtimes.upsert(
        {
          ...binding,
          providerInstanceId: ProviderInstanceId.make("neopi"),
          resumeCursor: { historyLeafId: "restored" },
          runtimePayload: { model: "must-not-replace" },
        },
        { onlyUpdateStoppedCursor: true },
      );
      expect(Option.getOrThrow(yield* runtimes.getByThreadId(binding))).toEqual({
        ...binding,
        resumeCursor: { historyLeafId: "restored" },
      });
    }),
  );
});
