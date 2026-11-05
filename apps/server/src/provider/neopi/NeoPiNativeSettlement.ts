import { NeoPiNativeSessionsError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * One settle decision for a native session file. `modifiedAt` is the file's
 * activity time when the decision was made: anything newer is activity the
 * user has not seen, so the decision no longer applies.
 */
const SettledRecord = Schema.Struct({
  state: Schema.Literals(["settled", "unsettled"]),
  settledAt: Schema.String,
  modifiedAt: Schema.String,
});
export type NeoPiNativeSettledRecord = typeof SettledRecord.Type;

const SettledFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    sessions: Schema.Record(Schema.String, SettledRecord),
  }),
);
const encodeSettledFile = Schema.encodeEffect(SettledFile);

export interface NeoPiNativeSettlementInput {
  readonly record: NeoPiNativeSettledRecord | undefined;
  readonly modifiedAt: string;
  readonly live: { readonly state: "busy" | "waiting" | "idle" } | undefined;
  /** `sidebarAutoSettleAfterDays`; null disables automatic settling. */
  readonly autoSettleAfterDays: number | null;
  readonly now: number;
}

/**
 * When a session counts as settled, and whether its stored decision still
 * holds. A manual decision wakes (is dropped) when the owner is working or
 * blocked, or the file saw activity after the decision. Without a decision,
 * a session idle longer than the auto-settle window is settled as of the day
 * that window elapsed; "unsettled" is the manual hold against that rule.
 */
export function resolveNativeSettlement(input: NeoPiNativeSettlementInput): {
  readonly settledAt: string | null;
  readonly retain: boolean;
} {
  const active = input.live?.state === "busy" || input.live?.state === "waiting";
  const modifiedMs = Date.parse(input.modifiedAt);
  const { record } = input;
  if (record) {
    const decidedAt = Date.parse(record.modifiedAt);
    const sawActivity = Number.isFinite(modifiedMs) && modifiedMs > decidedAt;
    if (!active && !sawActivity)
      return { settledAt: record.state === "settled" ? record.settledAt : null, retain: true };
  }
  if (
    input.autoSettleAfterDays !== null &&
    !active &&
    Number.isFinite(modifiedMs) &&
    input.now - modifiedMs >= input.autoSettleAfterDays * DAY_MS
  )
    return {
      settledAt: DateTime.formatIso(
        DateTime.makeUnsafe(modifiedMs + input.autoSettleAfterDays * DAY_MS),
      ),
      retain: false,
    };
  return { settledAt: null, retain: false };
}

export interface NeoPiNativeSettledStore {
  readonly read: Effect.Effect<ReadonlyMap<string, NeoPiNativeSettledRecord>>;
  /** A null record forgets only the exact record returned by a read snapshot. */
  readonly update: (
    changes: ReadonlyArray<
      | readonly [file: string, record: NeoPiNativeSettledRecord]
      | readonly [file: string, record: null, expected: NeoPiNativeSettledRecord]
    >,
  ) => Effect.Effect<void, NeoPiNativeSessionsError>;
}

/**
 * Settle decisions for this environment, keyed by canonical session file and
 * kept in a small JSON file beside the other server userdata. A missing or
 * unreadable file starts empty: the worst case is that sessions resurface.
 */
export const makeNeoPiNativeSettledStore = Effect.fn("NeoPiNativeSettledStore.make")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const initial = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SettledFile)),
    Effect.map((file) => Object.entries(file.sessions)),
    Effect.orElseSucceed(() => []),
  );
  const records = new Map<string, NeoPiNativeSettledRecord>(initial);
  const writes = yield* Semaphore.make(1);
  const store: NeoPiNativeSettledStore = {
    read: Effect.sync(() => new Map(records)),
    update: (changes) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const next = new Map(records);
          for (const [file, record, expected] of changes) {
            if (record === null) {
              if (next.get(file) === expected) next.delete(file);
            } else next.set(file, record);
          }
          const contents = yield* encodeSettledFile({
            version: 1,
            sessions: Object.fromEntries(next),
          });
          yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` }).pipe(
            Effect.provideContext(services),
          );
          records.clear();
          for (const [file, record] of next) records.set(file, record);
        }).pipe(
          Effect.mapError(
            () =>
              new NeoPiNativeSessionsError({
                message: "Could not save the settled sessions.",
                code: "settle_failed",
              }),
          ),
        ),
      ),
  };
  return store;
});
