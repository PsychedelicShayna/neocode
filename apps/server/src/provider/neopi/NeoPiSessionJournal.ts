// @effect-diagnostics nodeBuiltinImport:off -- native session files are canonical filesystem identities.
import * as NodePath from "node:path";
import { type NeoPiSessionJournalInput, type NeoPiSessionJournalResult } from "@t3tools/contracts";
import { make as makeClient } from "effect-neopi-rpc/client";
import { MAX_RPC_REASSEMBLED_BYTES } from "effect-neopi-rpc/frame";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";
import { makeNeoPiThreadBindingReader } from "./NeoPiThreadBinding.ts";
import {
  decodeNeoPiJournalCli,
  neoPiJournalError,
  readNeoPiJournalPeer,
  type ReadResult,
} from "./NeoPiJournalReader.ts";

const Catalog = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    sessions: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        id: Schema.String,
        inUse: Schema.NullOr(Schema.Struct({ pid: Schema.Number })),
        control: Schema.NullOr(Schema.Struct({ instanceId: Schema.String })),
      }),
    ),
  }),
);
const decodeCatalog = Schema.decodeEffect(Catalog);

class NeoPiJournalReadError extends Schema.TaggedError<NeoPiJournalReadError>()(
  "NeoPiJournalReadError",
  {
    message: Schema.String,
  },
) {}

export const makeNeoPiSessionJournal = Effect.fn("NeoPiSessionJournal.make")(function* () {
  const readBinding = yield* makeNeoPiThreadBindingReader();
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return Effect.fn("NeoPiSessionJournal.read")(
    function* (
      input: NeoPiSessionJournalInput,
    ): Effect.fn.Return<NeoPiSessionJournalResult, unknown, Scope.Scope> {
      const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
      const stale = () => ({
        status: "error" as const,
        code: "stale_cursor",
        message: "The bound native session or owner changed during this read. Restart this view.",
      });
      const binding = yield* readBinding(input.threadId);
      if (!binding) return unavailable("This thread has no bound native NeoPi session.");
      const { instance, source, expected, unchanged, cwd } = binding;
      const { threadId: _, ...paging } = input;
      const connected = source.journal
        ? yield* source.journal(input.threadId, expected, paging)
        : undefined;
      if (connected !== undefined) {
        if (!(yield* unchanged)) return stale();
        return connected.status === "available"
          ? { ...connected, providerInstanceId: instance.instanceId }
          : connected;
      }
      if (
        source.probe.status !== "compatible" ||
        !source.capabilities.has(NEOPI_CAPABILITIES.sessionJournal)
      )
        return unavailable(
          `NeoPi '${source.binary}' has not advertised session_journal in a compatible handshake. Update or refresh this provider before opening native history.`,
        );
      if (!source.capabilities.has(NEOPI_CAPABILITIES.sessionCatalog))
        return unavailable("This NeoPi binary cannot identify the native journal's current owner.");
      const run = Effect.fn("NeoPiSessionJournal.cli")(function* (args: ReadonlyArray<string>) {
        const child = yield* spawner.spawn(
          ChildProcess.make(source.binary, args, { cwd, env: source.env, stdin: "ignore" }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_RPC_REASSEMBLED_BYTES }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 64 * 1024 }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (stdout.truncated || stderr.truncated)
          return yield* new NeoPiJournalReadError({
            message:
              "NeoPi journal output exceeded the transport safety limit. No partial page was returned.",
          });
        return { stdout: stdout.text, code: Number(code) };
      });
      const owner = Effect.gen(function* () {
        const output = yield* run([
          "sessions",
          "list",
          "--json",
          "--session-dir",
          NodePath.dirname(expected.sessionFile),
        ]);
        if (output.code !== 0)
          return yield* new NeoPiJournalReadError({
            message: "NeoPi could not identify the native session owner.",
          });
        const catalog = yield* decodeCatalog(output.stdout);
        for (const row of catalog.sessions) {
          if (row.id !== expected.sessionId) continue;
          const file = yield* fs.realPath(row.path).pipe(Effect.option);
          if (Option.isSome(file) && file.value === expected.sessionFile) return row;
        }
      });
      const before = yield* owner;
      if (!before) return stale();
      let result: ReadResult;
      if (before.control) {
        if (!source.capabilities.has(NEOPI_CAPABILITIES.controlPipe))
          return unavailable("The live native owner has no supported read-only control transport.");
        const peer = yield* makeClient({
          spawn: spawner.spawn,
          command: source.binary,
          args: ["ctl", "pipe", before.control.instanceId, "--label", "neocode-journal"],
          cwd,
          env: source.env,
        });
        if (!peer.capabilities.has(NEOPI_CAPABILITIES.controlAttached))
          return unavailable("NeoPi did not establish a control connection to the existing owner.");
        result = yield* readNeoPiJournalPeer(peer, expected, paging, (file) => fs.realPath(file));
      } else if (before.inUse) {
        return unavailable(
          "The native session is open elsewhere without a readable control socket. No second writer was started.",
        );
      } else {
        const args = ["sessions", "entries", "--json"];
        if (paging.scope) args.push("--scope", paging.scope);
        if (paging.direction) args.push("--direction", paging.direction);
        if (paging.cursor !== undefined) args.push("--cursor", paging.cursor);
        if (paging.limit !== undefined) args.push("--limit", String(paging.limit));
        args.push(expected.sessionFile);
        const output = yield* run(args);
        result = yield* decodeNeoPiJournalCli(output.stdout, output.code, expected);
      }
      const after = yield* owner;
      if (
        !(yield* unchanged) ||
        !after ||
        before.control?.instanceId !== after.control?.instanceId ||
        before.inUse?.pid !== after.inUse?.pid
      )
        return stale();
      return result.status === "available"
        ? { ...result, providerInstanceId: instance.instanceId }
        : result;
    },
    Effect.timeout("45 seconds"),
    Effect.scoped,
    Effect.catch((cause) => Effect.succeed(neoPiJournalError(cause))),
  );
});
