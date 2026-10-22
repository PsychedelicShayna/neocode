// @effect-diagnostics nodeBuiltinImport:off -- native session paths are canonical filesystem identities.
import * as NodePath from "node:path";
import {
  NeoPiJournalPage,
  type NeoPiJournalOptions,
  type NeoPiSessionJournalResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";
import type { NeoPiConfigurationIdentity } from "./NeoPiSessionConfiguration.ts";

export type ReadResult =
  | { readonly status: "available"; readonly page: NeoPiJournalPage }
  | Exclude<NeoPiSessionJournalResult, { status: "available" }>;
const State = Schema.Struct({ sessionId: Schema.String, sessionFile: Schema.String });
const NativeFailure = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const decodePage = Schema.decodeUnknownEffect(NeoPiJournalPage);
const decodeState = Schema.decodeUnknownEffect(State);
const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(NativeFailure));

export const sameNeoPiJournalIdentity = (
  left: NeoPiConfigurationIdentity,
  right: NeoPiConfigurationIdentity,
) =>
  left.sessionId !== "" &&
  NodePath.isAbsolute(left.sessionFile) &&
  NodePath.isAbsolute(right.sessionFile) &&
  left.sessionId === right.sessionId &&
  NodePath.resolve(left.sessionFile) === NodePath.resolve(right.sessionFile);

export const neoPiJournalError = (cause: unknown): Extract<ReadResult, { status: "error" }> => ({
  status: "error",
  code:
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "journal_read_failed",
  message: cause instanceof Error ? cause.message : "Could not read the native NeoPi journal.",
});

export const validateNeoPiJournalPage = Effect.fn("NeoPiJournal.validatePage")(function* (
  value: unknown,
  expected: NeoPiConfigurationIdentity,
): Effect.fn.Return<ReadResult> {
  const page = yield* decodePage(value).pipe(Effect.option);
  if (page._tag === "None")
    return {
      status: "error",
      code: "invalid_response",
      message: "NeoPi returned a malformed journal page.",
    };
  if (!sameNeoPiJournalIdentity(page.value, expected))
    return {
      status: "error",
      code: "stale_cursor",
      message: "The native journal identity changed. Restart this view.",
    };
  return { status: "available", page: page.value };
});

/** Decode stdout before considering exit status: native CLI errors deliberately exit nonzero. */
export const decodeNeoPiJournalCli = Effect.fn("NeoPiJournal.decodeCli")(function* (
  stdout: string,
  exitCode: number,
  expected: NeoPiConfigurationIdentity,
): Effect.fn.Return<ReadResult> {
  const failure = decodeFailure(stdout);
  if (failure._tag === "Some") return { status: "error", ...failure.value.error };
  if (exitCode !== 0)
    return {
      status: "error",
      code: "journal_read_failed",
      message: `NeoPi journal reader exited ${exitCode} without a structured error.`,
    };
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    stdout,
  ).pipe(Effect.option);
  if (value._tag === "None")
    return {
      status: "error",
      code: "invalid_response",
      message: "NeoPi journal reader returned invalid JSON.",
    };
  return yield* validateNeoPiJournalPage(value.value, expected);
});

/** This sends read commands only. It never starts a runtime or changes native state. */
export const readNeoPiJournalPeer = Effect.fn("NeoPiJournal.readPeer")(
  function* (
    peer: {
      readonly capabilities: ReadonlySet<string>;
      readonly request: (command: { readonly type: string; readonly [key: string]: unknown }) => Effect.Effect<unknown, unknown>;
    },
    expected: NeoPiConfigurationIdentity,
    options: NeoPiJournalOptions,
    resolveFile: (file: string) => ReturnType<FileSystem.FileSystem["realPath"]>,
  ): Effect.fn.Return<ReadResult, unknown> {
    if (!peer.capabilities.has(NEOPI_CAPABILITIES.sessionJournal))
      return {
        status: "unavailable",
        reason:
          "This connected NeoPi owner does not advertise session_journal. Update NeoPi before opening native history.",
      };
    const before = yield* decodeState(yield* peer.request({ type: "get_state" }));
    if (
      !sameNeoPiJournalIdentity(
        { ...before, sessionFile: yield* resolveFile(before.sessionFile) },
        expected,
      )
    )
      return {
        status: "error",
        code: "stale_cursor",
        message: "The connected native owner changed session. Restart this view.",
      };
    const result = yield* peer.request({ type: "get_entries_page", ...options }).pipe(
      Effect.flatMap((value) => validateNeoPiJournalPage(value, expected)),
      Effect.catch((cause) => Effect.succeed(neoPiJournalError(cause))),
    );
    const after = yield* decodeState(yield* peer.request({ type: "get_state" }));
    if (
      !sameNeoPiJournalIdentity(
        { ...after, sessionFile: yield* resolveFile(after.sessionFile) },
        expected,
      )
    )
      return {
        status: "error",
        code: "stale_cursor",
        message: "The connected native owner changed session during this read. Restart this view.",
      };
    return result;
  },
  Effect.catch((cause) => Effect.succeed(neoPiJournalError(cause))),
);
