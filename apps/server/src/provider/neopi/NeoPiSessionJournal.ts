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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";
import { neoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";
import { decodeNeoPiJournalCli, neoPiJournalError, readNeoPiJournalPeer, sameNeoPiJournalIdentity, type ReadResult } from "./NeoPiJournalReader.ts";

const Cursor = Schema.Struct({ sessionId: Schema.String, sessionFile: Schema.String });
const decodeCursor = Schema.decodeUnknownOption(Cursor);
const Catalog = Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(Schema.Struct({
    path: Schema.String,
    id: Schema.String,
    inUse: Schema.NullOr(Schema.Struct({ pid: Schema.Number })),
    control: Schema.NullOr(Schema.Struct({ instanceId: Schema.String })),
  })),
}));

export const makeNeoPiSessionJournal = Effect.fn("NeoPiSessionJournal.make")(function* () {
  const directory = yield* ProviderSessionDirectory;
  const instances = yield* ProviderInstanceRegistry;
  const snapshots = yield* ProjectionSnapshotQuery;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return Effect.fn("NeoPiSessionJournal.read")(
    function* (input: NeoPiSessionJournalInput): Effect.fn.Return<NeoPiSessionJournalResult, unknown, Scope.Scope> {
      const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
      const stale = () => ({ status: "error" as const, code: "stale_cursor", message: "The bound native session or owner changed during this read. Restart this view." });
      const binding = yield* directory.getBinding(input.threadId);
      if (Option.isNone(binding) || binding.value.provider !== "neopi")
        return unavailable("This thread has no bound native NeoPi session.");
      const saved = decodeCursor(binding.value.resumeCursor);
      if (Option.isNone(saved) || !saved.value.sessionId || !NodePath.isAbsolute(saved.value.sessionFile))
        return unavailable("This thread has no durable native NeoPi session identity.");
      const instance = binding.value.providerInstanceId
        ? yield* instances.getInstance(binding.value.providerInstanceId)
        : undefined;
      if (!instance || !instance.enabled || instance.driverKind !== "neopi")
        return unavailable("The bound NeoPi provider instance is unavailable or disabled.");
      const source = neoPiSessionCatalogSource(instance);
      if (!source) return unavailable("The bound provider has no native session reader.");
      const expected = { sessionId: saved.value.sessionId, sessionFile: yield* fs.realPath(saved.value.sessionFile) };
      const { threadId: _, ...paging } = input;
      const unchanged = Effect.gen(function* () {
        const current = yield* directory.getBinding(input.threadId);
        if (Option.isNone(current) || current.value.provider !== "neopi" ||
          current.value.providerInstanceId !== binding.value.providerInstanceId ||
          current.value.adapterKey !== binding.value.adapterKey ||
          current.value.status !== binding.value.status ||
          (yield* instances.getInstance(instance.instanceId)) !== instance) return false;
        const cursor = decodeCursor(current.value.resumeCursor);
        if (Option.isNone(cursor)) return false;
        const file = yield* fs.realPath(cursor.value.sessionFile);
        return sameNeoPiJournalIdentity({ ...cursor.value, sessionFile: file }, expected);
      });
      const connected = source.journal ? yield* source.journal(input.threadId, expected, paging) : undefined;
      if (connected !== undefined) {
        if (!(yield* unchanged)) return stale();
        return connected.status === "available" ? { ...connected, providerInstanceId: instance.instanceId } : connected;
      }
      if (source.probe.status !== "compatible" || !source.capabilities.has(NEOPI_CAPABILITIES.sessionJournal))
        return unavailable(`NeoPi '${source.binary}' has not advertised session_journal in a compatible handshake. Update or refresh this provider before opening native history.`);
      if (!source.capabilities.has(NEOPI_CAPABILITIES.sessionCatalog))
        return unavailable("This NeoPi binary cannot identify the native journal's current owner.");
      const thread = yield* snapshots.getThreadShellById(input.threadId);
      if (Option.isNone(thread)) return unavailable("This thread no longer exists.");
      const project = yield* snapshots.getProjectShellById(thread.value.projectId);
      if (Option.isNone(project)) return unavailable("This thread's project no longer exists.");
      const cwd = thread.value.worktreePath ?? project.value.workspaceRoot;
      const run = Effect.fn("NeoPiSessionJournal.cli")(function* (args: ReadonlyArray<string>) {
        const child = yield* spawner.spawn(ChildProcess.make(source.binary, args, { cwd, env: source.env, stdin: "ignore" }));
        const [stdout, stderr, code] = yield* Effect.all([
          collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_RPC_REASSEMBLED_BYTES }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 64 * 1024 }),
          child.exitCode,
        ], { concurrency: "unbounded" });
        if (stdout.truncated || stderr.truncated)
          return yield* Effect.fail(new Error("NeoPi journal output exceeded the transport safety limit. No partial page was returned."));
        return { stdout: stdout.text, code: Number(code) };
      });
      const owner = Effect.gen(function* () {
        const output = yield* run(["sessions", "list", "--json", "--session-dir", NodePath.dirname(expected.sessionFile)]);
        if (output.code !== 0) return yield* Effect.fail(new Error("NeoPi could not identify the native session owner."));
        const catalog = yield* Schema.decodeUnknownEffect(Catalog)(output.stdout);
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
        return unavailable("The native session is open elsewhere without a readable control socket. No second writer was started.");
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
      if (!(yield* unchanged) || !after ||
        before.control?.instanceId !== after.control?.instanceId || before.inUse?.pid !== after.inUse?.pid)
        return stale();
      return result.status === "available" ? { ...result, providerInstanceId: instance.instanceId } : result;
    },
    Effect.timeout("45 seconds"),
    Effect.scoped,
    Effect.catch((cause) => Effect.succeed(neoPiJournalError(cause))),
  );
});
