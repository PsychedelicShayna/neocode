// @effect-diagnostics nodeBuiltinImport:off -- Fixtures execute only their private fake CLIs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NeoPiSettings,
  NeoPiSessionError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type NeoPiSessionConfigurationResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeTestProviderAdapterHarness } from "../../../integration/TestProviderAdapter.integration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { NeoPiDriver } from "../Drivers/NeoPiDriver.ts";
import {
  buildInitialNeoPiProviderSnapshot,
  checkNeoPiProviderStatus,
} from "../Layers/NeoPiProvider.ts";
import { layerTest as configLayer } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { layerTest as settingsLayer } from "../../serverSettings.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../Services/ProviderSessionDirectory.ts";
import { makeNeoPiSessionCatalog, type NeoPiSessionCommandInput } from "./NeoPiSessionCatalog.ts";
import {
  registerNeoPiSessionCatalogSource,
  neoPiSessionCatalogSource,
  type NeoPiSessionCatalogSource,
} from "./NeoPiSessionCatalogSource.ts";
import { makeNeoPiDiscoveryHub } from "./NeoPiDiscovery.ts";

const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("neopi-personal");
const cwd = process.cwd();
const now = "2026-10-18T12:00:00.000Z";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeProbeCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, type: Schema.String })),
);
const decodeNeoPiSettings = Schema.decodeEffect(NeoPiSettings);
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Project",
  workspaceRoot: cwd,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
};
const session = (id: string, extra: object = {}) => ({
  path: `/tmp/neocode-catalog-sessions/${id}.jsonl`,
  id,
  cwd,
  title: "Imported NeoPi session",
  created: now,
  modified: now,
  messageCount: 2,
  firstMessage: "Fix this",
  inUse: null,
  control: null,
  ...extra,
});
const bound = (
  id: string,
  status: "running" | "stopped" = "stopped",
): ProviderRuntimeBindingWithMetadata => ({
  threadId: ThreadId.make(`bound-${id}`),
  provider: ProviderDriverKind.make("neopi"),
  providerInstanceId: instanceId,
  status,
  lastSeenAt: now,
  resumeCursor: { sessionFile: session(id).path, sessionId: id },
});
const projectedThread = (
  id: ThreadId,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread => ({
  id,
  projectId,
  title: "Imported NeoPi session",
  modelSelection: { instanceId, model: "default-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  ...overrides,
});

const sessionWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const scratch = NodePath.join(NodeOS.homedir(), ".cache/npi-canary");
  yield* fs.makeDirectory(scratch, { recursive: true });
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: scratch,
    prefix: "neocode-session-paths-",
  });
  return yield* fs.realPath(directory);
});

const harness = (options?: {
  instance?: ProviderInstance;
  nativeCommands?: boolean;
  configuration?: NeoPiSessionCatalogSource["configuration"];
  observeConfiguration?: NeoPiSessionCatalogSource["observeConfiguration"];
  domainEvents?: PubSub.PubSub<OrchestrationEvent>;
  workspaceRoot?: string;
  capabilities?: string[];
  projects?: OrchestrationProjectShell[];
  rows?: object[];
  listOutput?: string | NeoPiSessionError;
  bindings?: ProviderRuntimeBindingWithMetadata[];
  threads?: OrchestrationThread[];
  read?: () => Record<string, unknown>;
  defaultInstanceId?: ProviderInstanceId;
  extraInstances?: {
    instanceId: ProviderInstanceId;
    capabilities: string[];
    rows: object[];
    listOutput?: string | NeoPiSessionError;
    enabled?: boolean;
    configuration?: NeoPiSessionCatalogSource["configuration"];
  }[];
}) =>
  Effect.gen(function* () {
    const testProject = { ...project, workspaceRoot: options?.workspaceRoot ?? cwd };
    const projects = [testProject, ...(options?.projects ?? [])];
    const calls: NeoPiSessionCommandInput[] = [];
    const commands: OrchestrationCommand[] = [];
    const bindings = [...(options?.bindings ?? [])];
    const threads = new Map((options?.threads ?? []).map((thread) => [thread.id, thread]));
    const order: string[] = [];
    const registryChanges = yield* PubSub.sliding<void>(1);
    const adapterHarness = yield* makeTestProviderAdapterHarness({
      provider: ProviderDriverKind.make("neopi"),
    });
    const providerSettings = yield* decodeNeoPiSettings({});
    const initial = yield* buildInitialNeoPiProviderSnapshot(providerSettings);
    const snapshot = {
      ...initial,
      instanceId,
      driver: ProviderDriverKind.make("neopi"),
      models: [
        {
          slug: "default-model",
          name: "Default",
          isDefault: true,
          isCustom: false,
          capabilities: null,
        },
      ],
    };
    const capabilities = new Set(
      options?.capabilities ?? ["session_catalog", "session_history_identity", "control_pipe"],
    );
    const source: NeoPiSessionCatalogSource = {
      binary: "/opt/npi",
      env: { OMP_PROFILE: "personal" },
      profile: "personal",
      capabilities,
      probe: { status: "compatible" as const, version: "1.2.3" },
      ...(options?.configuration ? { configuration: options.configuration } : {}),
      ...(options?.observeConfiguration
        ? { observeConfiguration: options.observeConfiguration }
        : {}),
    };
    const instance = registerNeoPiSessionCatalogSource(
      {
        instanceId,
        driverKind: ProviderDriverKind.make("neopi"),
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("neopi"),
          continuationKey: instanceId,
        },
        displayName: undefined,
        adapter: adapterHarness.adapter,
        textGeneration: {
          generateBranchName: () => Effect.die("unused"),
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
        },
        snapshot: {
          getSnapshot: Effect.succeed(snapshot),
          refresh: Effect.succeed(snapshot),
          streamChanges: Stream.empty,
          applyUsageLimits: () => Effect.void,
        },
      } satisfies ProviderInstance,
      source,
    );
    const extraInstances = (options?.extraInstances ?? []).map((entry) =>
      registerNeoPiSessionCatalogSource(
        { ...instance, instanceId: entry.instanceId, enabled: entry.enabled ?? true },
        {
          binary: `/opt/${entry.instanceId}/npi`,
          env: { OMP_PROFILE: entry.instanceId },
          profile: entry.instanceId,
          capabilities: new Set(entry.capabilities),
          probe: { status: "compatible", version: "1.2.3" },
          ...(entry.configuration ? { configuration: entry.configuration } : {}),
        },
      ),
    );
    const allInstances = [options?.instance ?? instance, ...extraInstances];
    const runCommand = (input: NeoPiSessionCommandInput) =>
      Effect.gen(function* () {
        calls.push(input);
        if (input.args[1] === "read") {
          const transcript: Record<string, unknown> = options?.read?.() ?? {
            version: 1,
            session: session("free"),
            truncated: false,
            branchEntryIds: ["user-1", "assistant-1"],
            leafId: "assistant-1",
            messages: [
              { entryId: "user-1", role: "user", text: "Fix this", timestamp: now },
              { entryId: "assistant-1", role: "assistant", text: "Fixed it", timestamp: now },
            ],
          };
          return encodeJson({
            branchMessages: transcript.messages,
            branchMessagesTruncated: false,
            ...transcript,
          });
        }
        const extra = options?.extraInstances?.find(
          (entry) => entry.instanceId === input.source.profile,
        );
        const output = extra?.listOutput ?? options?.listOutput;
        if (typeof output === "string") return output;
        if (output !== undefined) return yield* output;
        return encodeJson({
          version: 1,
          sessions: extra?.rows ?? options?.rows ?? [session("free")],
        });
      });
    const catalog = yield* makeNeoPiSessionCatalog(
      options?.nativeCommands ? undefined : runCommand,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry)({
            listInstances: Effect.succeed(allInstances),
            subscribeChanges: PubSub.subscribe(registryChanges),
            getInstance: (id) =>
              Effect.succeed(allInstances.find((entry) => entry.instanceId === id)),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getProjectShellById: (id) =>
              Effect.sync(() => Option.fromUndefinedOr(projects.find((entry) => entry.id === id))),
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects,
                threads: Array.from(threads.values(), (thread) => ({
                  ...thread,
                  latestUserMessageAt: null,
                  hasPendingApprovals: false,
                  hasPendingUserInput: false,
                  hasActionableProposedPlan: false,
                })),
                updatedAt: now,
              }),
            getThreadDetailById: (id) => Effect.sync(() => Option.fromUndefinedOr(threads.get(id))),
          }),
          Layer.mock(ProviderSessionDirectory)({
            listBindings: () => Effect.sync(() => bindings),
            getBinding: (id) =>
              Effect.sync(() =>
                Option.fromUndefinedOr(bindings.find((binding) => binding.threadId === id)),
              ),
            upsert: (binding, upsertOptions) =>
              Effect.sync(() => {
                const index = bindings.findIndex((entry) => entry.threadId === binding.threadId);
                if (upsertOptions?.onlyUpdateStoppedCursor) {
                  if (index >= 0 && bindings[index]?.status === "stopped")
                    bindings[index] = { ...bindings[index]!, resumeCursor: binding.resumeCursor };
                  return;
                }
                expect(upsertOptions).toEqual({ onConflict: "ignore" });
                order.push("binding");
                if (index < 0) bindings.push({ ...binding, lastSeenAt: now });
              }),
          }),
          Layer.mock(OrchestrationEngineService)({
            subscribeDomainEvents: options?.domainEvents
              ? PubSub.subscribe(options.domainEvents).pipe(
                  Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
                )
              : Effect.succeed(
                  Stream.suspend(() =>
                    Stream.fromIterable(
                      commands
                        .filter((command) => command.type === "thread.session.stop")
                        .map((command): OrchestrationEvent => ({
                          type: "thread.session-set",
                          sequence: 1,
                          eventId: EventId.make("stop-receipt"),
                          aggregateKind: "thread",
                          aggregateId: command.threadId,
                          occurredAt: now,
                          commandId: command.commandId,
                          causationEventId: null,
                          correlationId: null,
                          metadata: {},
                          payload: {
                            threadId: command.threadId,
                            session: {
                              threadId: command.threadId,
                              status: "stopped",
                              providerName: "neopi",
                              runtimeMode: "full-access",
                              activeTurnId: null,
                              lastError: null,
                              updatedAt: now,
                            },
                          },
                        })),
                    ),
                  ),
                ),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                order.push(command.type);
                if (command.type === "project.create")
                  projects.push({
                    ...project,
                    id: command.projectId,
                    title: command.title,
                    workspaceRoot: command.workspaceRoot,
                  });
                if (command.type === "thread.create")
                  threads.set(
                    command.threadId,
                    projectedThread(command.threadId, {
                      projectId: command.projectId,
                      worktreePath: command.worktreePath,
                    }),
                  );
                if (command.type === "thread.session.stop") {
                  const index = bindings.findIndex((entry) => entry.threadId === command.threadId);
                  if (index >= 0) bindings[index] = { ...bindings[index]!, status: "stopped" };
                  const thread = threads.get(command.threadId);
                  if (thread?.session)
                    threads.set(thread.id, {
                      ...thread,
                      session: { ...thread.session, status: "stopped" },
                    });
                }
                return { sequence: commands.length };
              }),
          }),
          settingsLayer(
            options?.defaultInstanceId
              ? {
                  defaultModelSelection: {
                    instanceId: options.defaultInstanceId,
                    model: "default-model",
                  },
                }
              : {},
          ),
          configLayer(testProject.workspaceRoot, { prefix: "neocode-catalog-test-" }),
        ),
      ),
    );
    return {
      catalog,
      calls,
      commands,
      bindings,
      order,
      threads,
      source,
      capabilities,
      providerSettings,
      allInstances,
      notifyRegistry: PubSub.publish(registryChanges, undefined),
    };
  });

/** A real RPC transport whose ready frame is released explicitly by the test. */
const heldProbe = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const started = yield* Deferred.make<void>();
  const exited = yield* Deferred.make<void>();
  const emit = (frame: unknown) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJson(frame)}\n`)).pipe(Effect.asVoid);
  const finish = Deferred.succeed(exited, undefined).pipe(
    Effect.andThen(Queue.end(stdout)),
    Effect.asVoid,
  );
  let pending = "";
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    exitCode: Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
    isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
    kill: () => finish,
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        pending += new TextDecoder().decode(chunk);
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const command = decodeProbeCommand(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          yield* emit({
            type: "response",
            id: command.id,
            command: command.type,
            success: true,
            data: command.type === "negotiate_protocol" ? { protocolVersion: 2 } : {},
          });
        }
      }),
    ),
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
  const version = ChildProcessSpawner.makeHandle({
    ...handle,
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode("npi v1.2.3\n")),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    kill: () => Effect.void,
  });
  const spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"] = (command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Expected standard command");
    return command.args[0] === "--version"
      ? Effect.succeed(version)
      : Deferred.succeed(started, undefined).pipe(Effect.as(handle));
  };
  return {
    spawn,
    started: Deferred.await(started),
    fail: finish,
    ready: (capabilities: string[], compatible = true) =>
      emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: compatible ? [1, 2] : [1],
        capabilities: ["rpc-ui", ...capabilities],
      }),
  };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("NeoPiSessionCatalog probes", (it) => {
  it.effect(
    "uses the configured nightly for real probe, adapter, and catalog processes, not stale PATH npi",
    () =>
      Effect.gen(function* () {
        const scratch = NodePath.join(NodeOS.homedir(), ".cache/npi-canary");
        NodeFS.mkdirSync(scratch, { recursive: true });
        const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "neocode-configured-cli-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
        );
        const log = NodePath.join(dir, "launches.jsonl");
        const peer = NodePath.join(dir, "peer.mjs");
        const binary = NodePath.join(dir, "npi-nightly");
        const stale = NodePath.join(dir, "npi");
        const workspaceRoot = process.cwd();
        const row = session("configured", {
          cwd: workspaceRoot,
          title: "Configured nightly session",
        });
        NodeFS.writeFileSync(
          peer,
          `
        import fs from "node:fs";
        import path from "node:path";
        import readline from "node:readline";
        const args = process.argv.slice(2);
        fs.appendFileSync(${encodeJson(log)}, JSON.stringify({ args, profile: process.env.OMP_PROFILE }) + "\\n");
        if (args[0] === "--version") {
          console.log("npi v9.8.7"); process.exit(0);
        }
        if (args[0] === "sessions") {
          console.log(JSON.stringify({ version: 1, sessions: [${encodeJson(row)}] })); process.exit(0);
        }
        if (args[0] === "usage") {
          console.log(JSON.stringify({ generatedAt: Date.now(), reports: [] })); process.exit(0);
        }
        console.log(JSON.stringify({
          type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2],
          capabilities: ["rpc-ui", "session_catalog"]
        }));
        const sessionDir = args[args.indexOf("--session-dir") + 1];
        readline.createInterface({ input: process.stdin }).on("line", line => {
          const command = JSON.parse(line);
          const data = command.type === "negotiate_protocol" ? { protocolVersion: 2 }
            : command.type === "get_state" ? { sessionId: "configured", sessionFile: path.join(sessionDir || ${encodeJson(dir)}, "configured.jsonl"), messageCount: 0 }
            : command.type === "get_available_models" ? { models: [{ provider: "openai-codex", id: "gpt-6-luna" }] }
            : {};
          console.log(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }));
        }).on("close", () => process.exit(0));
      `,
        );
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        NodeFS.writeFileSync(
          binary,
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(peer)} "$@"\n`,
          { mode: 0o755 },
        );
        NodeFS.writeFileSync(
          stale,
          `#!/bin/sh\necho stale > ${quote(NodePath.join(dir, "stale-launched"))}\necho 'npi v1.0.0'\n`,
          { mode: 0o755 },
        );
        const instance = yield* NeoPiDriver.create({
          instanceId,
          displayName: "Configured nightly",
          enabled: true,
          environment: [{ name: "PATH", value: dir, sensitive: false }],
          config: {
            ...NeoPiDriver.defaultConfig(),
            binaryPath: binary,
            profile: "configured-profile",
          },
        });
        const checked = yield* instance.snapshot.refresh;
        expect(checked.version).toBe("9.8.7");
        expect(checked.status).toBe("ready");
        const source = neoPiSessionCatalogSource(instance)!;
        expect(source.binary).toBe(binary);
        expect(source.probe.status).toBe("compatible");
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pinned = yield* checkNeoPiProviderStatus(
          { ...NeoPiDriver.defaultConfig(), binaryPath: "npi", profile: "configured-profile" },
          source.env,
          workspaceRoot,
          spawner.spawn,
          yield* makeNeoPiDiscoveryHub(),
          new Set(),
          { resolvedBinary: source.binary },
        );
        expect(pinned.version).toBe("9.8.7");
        expect(pinned.status).toBe("ready");
        const threadId = ThreadId.make("configured-adapter");
        yield* instance.adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("neopi"),
          providerInstanceId: instanceId,
          cwd: workspaceRoot,
          runtimeMode: "full-access",
        });
        yield* instance.adapter.stopAll();
        const { catalog } = yield* harness({ instance, nativeCommands: true, workspaceRoot });
        const listed = yield* catalog.list({ projectId, scope: "project" });
        expect(listed.status === "available" && listed.sessions[0]?.title).toBe(
          "Configured nightly session",
        );
        const launches = NodeFS.readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { args: string[]; profile: string });
        expect(launches.some((entry) => entry.args.includes("--no-session"))).toBe(true);
        expect(launches.some((entry) => entry.args.includes("--session-dir"))).toBe(true);
        expect(launches.some((entry) => entry.args[0] === "sessions")).toBe(true);
        expect(launches.every((entry) => entry.profile === "configured-profile")).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(dir, "stale-launched"))).toBe(false);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            configLayer(process.cwd(), { prefix: "neocode-configured-driver-" }),
            settingsLayer(),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunScopeWork: () => Effect.succeed(false),
            }),
          ),
        ),
      ),
  );

  for (const outcome of ["drop", "fail", "unsupported"] as const) {
    it.effect(`keeps catalog and resume usable during refresh, then handles ${outcome}`, () =>
      Effect.gen(function* () {
        const { catalog, source, capabilities, providerSettings, calls } = yield* harness({
          bindings: [bound("free", "running")],
          threads: [projectedThread(ThreadId.make("bound-free"))],
        });
        const peer = yield* heldProbe;
        const discovery = yield* makeNeoPiDiscoveryHub();
        const refresh = yield* checkNeoPiProviderStatus(
          providerSettings,
          source.env,
          cwd,
          peer.spawn,
          discovery,
          capabilities,
          { resolvedBinary: source.binary, capabilityProbe: source.probe },
        ).pipe(
          Effect.provide(
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({ spawn: peer.spawn }),
          ),
          Effect.forkScoped,
        );
        yield* peer.started;
        expect((yield* catalog.list({ projectId, scope: "project" })).status).toBe("available");
        const resumeInput = {
          projectId,
          providerInstanceId: instanceId,
          sessionFile: session("free").path,
        };
        expect(yield* catalog.resume(resumeInput)).toEqual({
          threadId: ThreadId.make("bound-free"),
          created: false,
        });
        expect(calls.length).toBeGreaterThan(0);
        yield* outcome === "fail" ? peer.fail : peer.ready([], outcome !== "unsupported");
        yield* Fiber.join(refresh);
        if (outcome === "fail") {
          expect(capabilities.has("session_catalog")).toBe(true);
          expect(source.probe.failure).toContain("handshake failed");
          expect((yield* catalog.list({ projectId, scope: "project" })).status).toBe("available");
          expect((yield* catalog.resume(resumeInput)).threadId).toBe(ThreadId.make("bound-free"));
        } else {
          expect(capabilities.has("session_catalog")).toBe(outcome === "unsupported");
          const listed = yield* catalog.list({ projectId, scope: "project" });
          expect(listed.status).toBe("unavailable");
          if (listed.status !== "unavailable") return;
          expect(listed.reason).toContain("'/opt/npi' (version 1.2.3)");
          expect(listed.reason).toContain(
            outcome === "drop" ? "did not advertise session_catalog" : "unsupported RPC handshake",
          );
          const error = yield* catalog.resume(resumeInput).pipe(Effect.flip);
          expect(error.message).toBe(listed.reason);
        }
      }),
    );
  }
});

it.layer(NodeServices.layer)("NeoPiSessionCatalog", (it) => {
  it.effect("distinguishes unprobed and failed handshakes from unsupported capabilities", () =>
    Effect.gen(function* () {
      const { catalog, source } = yield* harness({ capabilities: [] });
      source.probe.status = "unprobed";
      source.probe.version = null;
      const initial = yield* catalog.list({ projectId, scope: "project" });
      expect(initial.status === "unavailable" && initial.reason).toContain("version unknown");
      expect(initial.status === "unavailable" && initial.reason).toContain(
        "support is not yet known",
      );
      source.probe.failure = "RPC handshake failed: disconnected";
      const failed = yield* catalog.list({ projectId, scope: "project" });
      expect(failed.status === "unavailable" && failed.reason).toContain(
        "Last probe failed: RPC handshake failed: disconnected",
      );
      expect(failed.status === "unavailable" && failed.reason).not.toContain("did not advertise");
      const error = yield* catalog
        .resume({
          projectId,
          providerInstanceId: instanceId,
          sessionFile: session("free").path,
        })
        .pipe(Effect.flip);
      expect(error.message).toBe(failed.status === "unavailable" && failed.reason);
    }),
  );

  describe("list", () => {
    it.effect("matches workspace symlinks in either direction without registering projects", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* sessionWorkspace;
        const canonical = NodePath.join(root, "canonical");
        const alias = NodePath.join(root, "alias");
        yield* fs.makeDirectory(canonical);
        yield* fs.symlink(canonical, alias);
        for (const [workspaceRoot, nativeCwd] of [
          [alias, canonical],
          [canonical, alias],
        ] as const) {
          const { catalog, commands, bindings } = yield* harness({
            workspaceRoot,
            rows: [session("free", { cwd: nativeCwd })],
          });
          const result = yield* catalog.list({ projectId, scope: "project" });
          expect(
            result.status === "available" && result.sessions.map((row) => row.projectId),
          ).toEqual([projectId]);
          expect(commands).toEqual([]);
          expect(bindings).toEqual([]);
        }
      }),
    );
    it.effect("maps free, terminal-owned and NeoCode-owned sessions and workspace identities", () =>
      Effect.gen(function* () {
        const { catalog, calls } = yield* harness({
          rows: [
            session("free"),
            session("terminal", { inUse: { pid: 123 }, control: { instanceId: "terminal-owner" } }),
            session("live", { inUse: { pid: 456 } }),
            session("foreign", { cwd: "/elsewhere" }),
          ],
          bindings: [bound("free"), bound("live", "running")],
        });
        const result = yield* catalog.list({ projectId, scope: "all" });
        expect(result.status).toBe("available");
        if (result.status !== "available") return;
        expect(
          result.sessions.map((row) => [row.sessionId, row.owner, row.threadId, row.projectId]),
        ).toEqual([
          ["free", { kind: "none" }, ThreadId.make("bound-free"), projectId],
          ["terminal", { kind: "process", pid: 123, attachable: true }, null, projectId],
          [
            "live",
            { kind: "neocode", threadId: ThreadId.make("bound-live") },
            ThreadId.make("bound-live"),
            projectId,
          ],
          ["foreign", { kind: "none" }, null, null],
        ]);
        expect(calls[0]?.args).toEqual(["sessions", "list", "--json", "--all"]);
        expect(calls[0]?.cwd).toBe(cwd);
        expect(calls[0]?.source.env.OMP_PROFILE).toBe("personal");
      }),
    );
    it.effect("never invokes unsupported CLI commands", () =>
      Effect.gen(function* () {
        const { catalog, calls } = yield* harness({ capabilities: [] });
        const result = yield* catalog.list({ projectId, scope: "project" });
        expect(result.status).toBe("unavailable");
        expect(calls).toHaveLength(0);
      }),
    );
    it.effect("filters the project scope and requires control_pipe for attachment", () =>
      Effect.gen(function* () {
        const { catalog, calls } = yield* harness({
          capabilities: ["session_catalog"],
          rows: [
            session("terminal", { inUse: { pid: 1 }, control: { instanceId: "owner" } }),
            session("foreign", { cwd: "/elsewhere" }),
          ],
        });
        const result = yield* catalog.list({ projectId, scope: "project" });
        expect(result.status === "available" && result.sessions.map((row) => row.owner)).toEqual([
          { kind: "process", pid: 1, attachable: false },
        ]);
        expect(calls[0]?.args).toEqual(["sessions", "list", "--json", "--all"]);
      }),
    );
    it.effect("finds a bound worktree by its GUI title and owning project", () =>
      Effect.gen(function* () {
        const worktreePath = `${cwd}-worktree`;
        const binding = bound("gui");
        const title = "Mercury Acceptance Check";
        const { catalog } = yield* harness({
          rows: [
            session("gui", { cwd: worktreePath, title: null, firstMessage: "" }),
            session("foreign", { cwd: "/elsewhere" }),
          ],
          bindings: [binding],
          threads: [projectedThread(binding.threadId, { worktreePath, title })],
        });
        for (const scope of ["project", "all"] as const) {
          const result = yield* catalog.list({ projectId, scope });
          if (result.status !== "available") throw new Error(result.reason);
          expect(result.sessions.find((row) => row.sessionId === "gui")).toMatchObject({
            threadId: binding.threadId,
            projectId,
            title,
            cwd: worktreePath,
          });
          expect(result.sessions.map((row) => row.sessionId).sort()).toEqual(
            scope === "all" ? ["foreign", "gui"] : ["gui"],
          );
        }
      }),
    );
    it.effect("merges capable instances and keeps the default origin for duplicate paths", () =>
      Effect.gen(function* () {
        const otherId = ProviderInstanceId.make("neopi-work");
        const { catalog } = yield* harness({
          rows: [session("personal"), session("shared")],
          defaultInstanceId: otherId,
          extraInstances: [
            {
              instanceId: otherId,
              capabilities: ["session_catalog"],
              rows: [session("work"), session("shared")],
            },
          ],
        });
        const result = yield* catalog.list({ projectId, scope: "all" });
        expect(result.status).toBe("available");
        if (result.status !== "available") return;
        expect(result.sessions.map((row) => [row.sessionId, row.providerInstanceId])).toEqual([
          ["work", otherId],
          ["shared", otherId],
          ["personal", instanceId],
        ]);
      }),
    );
    it.effect("remains available when only a later enabled instance supports catalogs", () =>
      Effect.gen(function* () {
        const capableId = ProviderInstanceId.make("neopi-capable");
        const { catalog, calls } = yield* harness({
          capabilities: [],
          extraInstances: [
            {
              instanceId: capableId,
              capabilities: ["session_catalog"],
              rows: [session("capable")],
            },
            {
              instanceId: ProviderInstanceId.make("neopi-disabled"),
              capabilities: ["session_catalog"],
              rows: [session("disabled")],
              enabled: false,
            },
          ],
        });
        const result = yield* catalog.list({ projectId, scope: "all" });
        expect(
          result.status === "available" && result.sessions.map((row) => row.providerInstanceId),
        ).toEqual([capableId]);
        expect(calls.every((call) => call.source.profile === capableId)).toBe(true);
      }),
    );
    for (const failure of ["timeout", "bad JSON"] as const) {
      for (const failingDefault of [false, true]) {
        it.effect(
          `keeps healthy sessions after ${failure}, failing default ${failingDefault}`,
          () =>
            Effect.gen(function* () {
              const failingId = ProviderInstanceId.make("neopi-broken");
              const { catalog, calls } = yield* harness({
                rows: [session("healthy"), session("shared")],
                defaultInstanceId: failingDefault ? failingId : instanceId,
                extraInstances: [
                  {
                    instanceId: failingId,
                    capabilities: ["session_catalog"],
                    rows: [session("shared")],
                    listOutput:
                      failure === "timeout"
                        ? new NeoPiSessionError({
                            operation: "list",
                            message: "Command timed out.",
                          })
                        : "{invalid json",
                  },
                ],
              });
              const result = yield* catalog.list({ projectId, scope: "all" });
              expect(result.status).toBe("available");
              if (result.status !== "available") return;
              expect(result.sessions.map((row) => [row.sessionId, row.providerInstanceId])).toEqual(
                [
                  ["healthy", instanceId],
                  ["shared", instanceId],
                ],
              );
              expect(result.diagnostics).toEqual([
                { providerInstanceId: failingId, message: expect.any(String) },
              ]);
              expect(calls.map((call) => call.source.binary)).toEqual(
                failingDefault
                  ? ["/opt/neopi-broken/npi", "/opt/npi"]
                  : ["/opt/npi", "/opt/neopi-broken/npi"],
              );
            }),
        );
      }
    }
    it.effect(
      "reports all failed instances as unavailable rather than an empty healthy catalog",
      () =>
        Effect.gen(function* () {
          const failingId = ProviderInstanceId.make("neopi-broken");
          const { catalog } = yield* harness({
            listOutput: new NeoPiSessionError({ operation: "list", message: "Command timed out." }),
            extraInstances: [
              {
                instanceId: failingId,
                capabilities: ["session_catalog"],
                rows: [],
                listOutput: "{invalid json",
              },
            ],
          });
          const result = yield* catalog.list({ projectId, scope: "all" });
          expect(result.status).toBe("unavailable");
          expect(result.diagnostics.map((diagnostic) => diagnostic.providerInstanceId)).toEqual([
            instanceId,
            failingId,
          ]);
        }),
    );
    it.effect("keeps an empty healthy catalog available alongside a failed instance", () =>
      Effect.gen(function* () {
        const { catalog } = yield* harness({
          rows: [],
          extraInstances: [
            {
              instanceId: ProviderInstanceId.make("neopi-broken"),
              capabilities: ["session_catalog"],
              rows: [],
              listOutput: "{invalid json",
            },
          ],
        });
        const result = yield* catalog.list({ projectId, scope: "all" });
        expect(result.status).toBe("available");
        if (result.status !== "available") return;
        expect(result.sessions).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
      }),
    );
  });
  it.effect("resumes canonical and symlink workspaces into the same existing project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sessionWorkspace;
      const canonical = NodePath.join(root, "canonical");
      const alias = NodePath.join(root, "alias");
      yield* fs.makeDirectory(canonical);
      yield* fs.symlink(canonical, alias);
      const row = session("free", { cwd: canonical });
      const { catalog, commands, bindings, calls } = yield* harness({
        workspaceRoot: alias,
        rows: [row],
        read: () => ({
          version: 1,
          session: { ...row, cwd: alias },
          truncated: false,
          branchEntryIds: [],
          leafId: null,
          messages: [],
        }),
      });
      const result = yield* catalog.resume({
        projectId,
        providerInstanceId: instanceId,
        sessionFile: row.path,
      });
      expect(result.created).toBe(true);
      expect(commands).toMatchObject([
        {
          type: "thread.create",
          projectId,
          worktreePath: null,
        },
      ]);
      expect(bindings[0]?.runtimePayload).toMatchObject({ cwd: canonical });
      expect(calls.find((call) => call.args[1] === "read")?.cwd).toBe(canonical);
    }),
  );
  it.effect("preserves the bound live thread and provider across aliased session files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sessionWorkspace;
      const canonical = NodePath.join(root, "canonical");
      const alias = NodePath.join(root, "alias");
      yield* fs.makeDirectory(canonical);
      yield* fs.symlink(canonical, alias);
      const nativeFile = NodePath.join(canonical, "free.jsonl");
      yield* fs.writeFileString(nativeFile, "");
      const binding = {
        ...bound("free", "running"),
        resumeCursor: {
          sessionFile: NodePath.join(alias, "free.jsonl"),
          sessionId: "free",
        },
      };
      const { catalog, commands, bindings, calls } = yield* harness({
        workspaceRoot: canonical,
        rows: [session("free", { path: nativeFile, cwd: alias, inUse: { pid: 123 } })],
        bindings: [binding],
        threads: [projectedThread(binding.threadId)],
      });
      expect(
        yield* catalog.resume({
          projectId,
          providerInstanceId: ProviderInstanceId.make("not-the-bound-provider"),
          sessionFile: nativeFile,
        }),
      ).toEqual({ threadId: binding.threadId, created: false });
      expect(commands).toEqual([]);
      expect(bindings).toEqual([binding]);
      expect(calls.some((call) => call.args[1] === "read")).toBe(false);
    }),
  );
  it.effect(
    "reuses a foreign project and its native cwd without changing the selected project",
    () =>
      Effect.gen(function* () {
        const root = yield* sessionWorkspace;
        const foreignProjectId = ProjectId.make("foreign");
        const row = session("free", { cwd: root });
        const { catalog, commands, bindings } = yield* harness({
          projects: [{ ...project, id: foreignProjectId, workspaceRoot: root }],
          rows: [row],
          read: () => ({
            version: 1,
            session: row,
            truncated: false,
            branchEntryIds: [],
            leafId: null,
            messages: [],
          }),
        });
        yield* catalog.resume({ projectId, providerInstanceId: instanceId, sessionFile: row.path });
        expect(commands).toMatchObject([
          {
            type: "thread.create",
            projectId: foreignProjectId,
            worktreePath: null,
          },
        ]);
        expect(bindings[0]?.runtimePayload).toMatchObject({ cwd: root });
      }),
  );
  it.effect("registers an unrelated nested or prefix-sharing cwd only on explicit resume", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sessionWorkspace;
      const selectedRoot = NodePath.join(root, "project");
      const nested = NodePath.join(selectedRoot, "nested");
      const sibling = `${selectedRoot}-worktree`;
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.makeDirectory(sibling);
      for (const nativeCwd of [nested, sibling]) {
        const row = session("free", { cwd: nativeCwd });
        const { catalog, commands, bindings } = yield* harness({
          workspaceRoot: selectedRoot,
          rows: [row],
          read: () => ({
            version: 1,
            session: row,
            truncated: false,
            branchEntryIds: [],
            leafId: null,
            messages: [],
          }),
        });
        const scoped = yield* catalog.list({ projectId, scope: "project" });
        expect(scoped.status === "available" && scoped.sessions).toEqual([]);
        const all = yield* catalog.list({ projectId, scope: "all" });
        expect(all.status === "available" && all.sessions[0]?.projectId).toBeNull();
        expect(commands).toEqual([]);
        expect(bindings).toEqual([]);
        const resumed = yield* catalog.resume({
          projectId,
          providerInstanceId: instanceId,
          sessionFile: row.path,
        });
        const created = commands.find((command) => command.type === "project.create");
        expect(created?.workspaceRoot).toBe(nativeCwd);
        expect(created?.projectId).not.toBe(projectId);
        expect(commands.find((command) => command.type === "thread.create")).toMatchObject({
          projectId: created?.projectId,
          worktreePath: null,
        });
        expect(
          yield* catalog.resume({
            projectId,
            providerInstanceId: instanceId,
            sessionFile: row.path,
          }),
        ).toEqual({ threadId: resumed.threadId, created: false });
        expect(commands.filter((command) => command.type === "project.create")).toHaveLength(1);
      }
    }),
  );
  it.effect("imports an exact known worktree into its owning project", () =>
    Effect.gen(function* () {
      const worktreePath = yield* sessionWorkspace;
      const row = session("free", { cwd: worktreePath });
      const { catalog, commands, bindings } = yield* harness({
        rows: [row],
        threads: [projectedThread(ThreadId.make("other-native-session"), { worktreePath })],
        read: () => ({
          version: 1,
          session: row,
          truncated: false,
          branchEntryIds: [],
          leafId: null,
          messages: [],
        }),
      });
      const listed = yield* catalog.list({ projectId, scope: "project" });
      expect(listed.status === "available" && listed.sessions[0]?.projectId).toBe(projectId);
      yield* catalog.resume({ projectId, providerInstanceId: instanceId, sessionFile: row.path });
      expect(commands).toMatchObject([{ type: "thread.create", projectId, worktreePath }]);
      expect(bindings[0]?.runtimePayload).toMatchObject({ cwd: worktreePath });
    }),
  );
  it.effect("rejects invalid native working directories before any persistent mutation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sessionWorkspace;
      const file = NodePath.join(root, "not-a-directory");
      yield* fs.writeFileString(file, "");
      for (const [nativeCwd, reason] of [
        ["", "no working directory"],
        ["relative/path", "non-absolute working directory"],
        [NodePath.join(root, "missing"), "Cannot access"],
        [file, "not a directory"],
      ]) {
        const row = session("free", { cwd: nativeCwd });
        const { catalog, commands, bindings, calls } = yield* harness({ rows: [row] });
        const error = yield* catalog
          .resume({
            projectId,
            providerInstanceId: instanceId,
            sessionFile: row.path,
          })
          .pipe(Effect.flip);
        expect(error.message).toContain(reason);
        expect(commands).toEqual([]);
        expect(bindings).toEqual([]);
        expect(calls.some((call) => call.args[1] === "read")).toBe(false);
      }
    }),
  );
  it.effect("does not register a foreign cwd when native history validation fails", () =>
    Effect.gen(function* () {
      const root = yield* sessionWorkspace;
      const row = session("free", { cwd: root });
      const { catalog, commands, bindings } = yield* harness({
        rows: [row],
        read: () => ({
          version: 1,
          session: row,
          truncated: false,
          branchEntryIds: [],
          leafId: "not-in-the-branch",
          messages: [],
        }),
      });
      yield* catalog
        .resume({
          projectId,
          providerInstanceId: instanceId,
          sessionFile: row.path,
        })
        .pipe(Effect.flip);
      expect(commands).toEqual([]);
      expect(bindings).toEqual([]);
    }),
  );
  it.effect(
    "installs the cursor before creating the thread, imports text, and resumes idempotently",
    () =>
      Effect.gen(function* () {
        const { catalog, calls, commands, bindings, order } = yield* harness();
        const first = yield* catalog.resume({
          projectId,
          providerInstanceId: instanceId,
          sessionFile: session("free").path,
        });
        expect(first).toEqual({ threadId: `import:${instanceId}:free`, created: true });
        expect(order).toEqual(["binding", "thread.create", "thread.history.import"]);
        expect(bindings[0]?.resumeCursor).toEqual({
          v: 1,
          sessionFile: session("free").path,
          sessionId: "free",
          sessionDir: "/tmp/neocode-catalog-sessions",
          sharedSession: true,
          turnBoundaries: [],
          historyLeafId: "assistant-1",
        });
        expect(commands[0]).toMatchObject({
          historyImport: true,
          modelSelection: { instanceId, model: "default-model" },
        });
        expect(commands[1]).toMatchObject({
          messages: [
            { messageId: `${first.threadId}:native:user-1`, role: "user", text: "Fix this" },
            {
              messageId: `${first.threadId}:native:assistant-1`,
              role: "assistant",
              text: "Fixed it",
            },
          ],
        });
        expect(calls.find((call) => call.args[1] === "read")?.args).toEqual([
          "sessions",
          "read",
          "--json",
          session("free").path,
          "--max-messages",
          "200",
        ]);
        expect(
          yield* catalog.resume({
            projectId,
            providerInstanceId: instanceId,
            sessionFile: session("free").path,
          }),
        ).toEqual({
          threadId: first.threadId,
          created: false,
        });
        expect(commands).toHaveLength(2);
      }),
  );
  it.effect("routes resume and terminal handoff through the row's originating instance", () =>
    Effect.gen(function* () {
      const otherId = ProviderInstanceId.make("neopi-work");
      const { catalog, calls, bindings, commands } = yield* harness({
        rows: [],
        extraInstances: [
          {
            instanceId: otherId,
            capabilities: ["session_catalog", "session_history_identity"],
            rows: [session("free")],
          },
        ],
      });
      const result = yield* catalog.resume({
        projectId,
        providerInstanceId: otherId,
        sessionFile: session("free").path,
      });
      expect(result.threadId).toBe(`import:${otherId}:free`);
      expect(bindings[0]?.providerInstanceId).toBe(otherId);
      expect(commands[0]).toMatchObject({ modelSelection: { instanceId: otherId } });
      const handoff = yield* catalog.handoff({ threadId: result.threadId });
      expect(handoff.command).toContain(`OMP_PROFILE='${otherId}' '/opt/${otherId}/npi'`);
      expect(calls.every((call) => call.source.profile === otherId)).toBe(true);
    }),
  );
  it.effect("rejects unlisted files and missing workspaces without creating threads", () =>
    Effect.gen(function* () {
      const { catalog, commands } = yield* harness({
        rows: [session("foreign", { cwd: "/elsewhere" })],
      });
      const unlisted = yield* catalog
        .resume({ projectId, providerInstanceId: instanceId, sessionFile: "/etc/passwd" })
        .pipe(Effect.result);
      const mismatch = yield* catalog
        .resume({ projectId, providerInstanceId: instanceId, sessionFile: session("foreign").path })
        .pipe(Effect.result);
      expect(unlisted._tag).toBe("Failure");
      expect(mismatch._tag).toBe("Failure");
      expect(commands).toEqual([]);
    }),
  );
  for (const probeStatus of ["compatible", "unsupported", "unprobed"] as const) {
    it.effect(`refuses non-catalog handoff before stopping with a ${probeStatus} probe`, () =>
      Effect.gen(function* () {
        const binding = bound("free", "running");
        const thread = projectedThread(binding.threadId, {
          session: {
            threadId: binding.threadId,
            status: "running",
            providerName: "neopi",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        });
        const { catalog, source, bindings, threads, commands, calls } = yield* harness({
          capabilities:
            probeStatus === "unsupported"
              ? ["session_catalog", "session_history_identity"]
              : ["session_history_identity"],
          bindings: [binding],
          threads: [thread],
        });
        source.probe.status = probeStatus;
        const error = yield* Effect.flip(catalog.handoff({ threadId: binding.threadId }));
        expect(error.operation).toBe("handoff");
        expect(error.message).toContain("session_catalog");
        expect(error.message).toContain(source.binary);
        expect(commands).toEqual([]);
        expect(calls).toEqual([]);
        expect(bindings[0]).toEqual(binding);
        expect(threads.get(thread.id)).toEqual(thread);
      }),
    );
  }
  it.effect("hands a bound thread back through orchestration and quotes its terminal command", () =>
    Effect.gen(function* () {
      const binding = bound("free", "running");
      const { catalog, commands } = yield* harness({
        bindings: [binding],
        threads: [
          projectedThread(binding.threadId, {
            session: {
              threadId: binding.threadId,
              status: "running",
              providerName: "neopi",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
          }),
        ],
      });
      const result = yield* catalog.handoff({ threadId: binding.threadId });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.session.stop",
        threadId: binding.threadId,
      });
      expect(result).toEqual({
        sessionFile: session("free").path,
        sessionId: "free",
        cwd,
        command: `cd '${cwd}' && OMP_PROFILE='personal' '/opt/npi' --session '${session("free").path}'`,
      });
    }),
  );
  it.effect("refuses a terminal command when stopping only detached from the lease holder", () =>
    Effect.gen(function* () {
      const binding = bound("free", "running");
      const { catalog, commands, calls } = yield* harness({
        bindings: [binding],
        threads: [projectedThread(binding.threadId)],
        rows: [session("free", { inUse: { pid: 123 }, control: { instanceId: "owner" } })],
      });
      const error = yield* Effect.flip(catalog.handoff({ threadId: binding.threadId }));
      expect(error.operation).toBe("handoff");
      expect(error.message).toContain("still open in the terminal process (PID 123)");
      expect(error.message).toContain("NeoCode merely detached");
      expect(commands.map((command) => command.type)).toEqual(["thread.session.stop"]);
      expect(calls.at(-1)?.args).toEqual([
        "sessions",
        "list",
        "--json",
        "--session-dir",
        "/tmp/neocode-catalog-sessions",
      ]);
    }),
  );
  it.effect(
    "restores a GUI-born handoff into the same thread once using native IDs, not repeated text",
    () =>
      Effect.gen(function* () {
        const binding = bound("free", "running");
        const gui = projectedThread(binding.threadId, {
          modelSelection: { instanceId, model: "saved-provider-model" },
          messages: [
            {
              id: MessageId.make("gui-user"),
              role: "user",
              text: "same",
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: MessageId.make("gui-answer"),
              role: "assistant",
              text: "same",
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
        });
        let transcript = {
          version: 1,
          session: session("free"),
          truncated: false,
          branchEntryIds: ["user-1", "assistant-1"],
          leafId: "assistant-1",
          messages: [
            { entryId: "user-1", role: "user", text: "same", timestamp: now },
            { entryId: "assistant-1", role: "assistant", text: "same", timestamp: now },
          ],
        };
        const { catalog, commands, bindings, threads } = yield* harness({
          bindings: [binding],
          threads: [gui],
          read: () => transcript,
        });
        yield* catalog.handoff({ threadId: binding.threadId });
        expect(bindings[0]?.resumeCursor).toMatchObject({ historyLeafId: "assistant-1" });
        transcript = {
          ...transcript,
          branchEntryIds: [
            "user-1",
            "assistant-1",
            "compaction",
            "terminal-user",
            "terminal-assistant",
            "custom-tail",
          ],
          leafId: "custom-tail",
          messages: [
            ...transcript.messages,
            { entryId: "terminal-user", role: "user", text: "same", timestamp: now },
            { entryId: "terminal-assistant", role: "assistant", text: "same", timestamp: now },
          ],
        };
        const input = {
          projectId,
          providerInstanceId: instanceId,
          sessionFile: session("free").path,
        };
        expect(yield* catalog.resume(input)).toEqual({
          threadId: binding.threadId,
          created: false,
        });
        expect(commands.filter((command) => command.type === "thread.history.append")).toEqual([
          {
            type: "thread.history.append",
            commandId: `neopi-restore:${binding.threadId}:custom-tail:terminal-user`,
            threadId: binding.threadId,
            messages: [
              {
                messageId: `${binding.threadId}:native:terminal-user`,
                role: "user",
                text: "same",
                createdAt: now,
              },
              {
                messageId: `${binding.threadId}:native:terminal-assistant`,
                role: "assistant",
                text: "same",
                createdAt: now,
              },
            ],
          },
        ]);
        expect(bindings[0]?.resumeCursor).toMatchObject({ historyLeafId: "custom-tail" });
        expect(yield* catalog.resume(input)).toEqual({
          threadId: binding.threadId,
          created: false,
        });
        expect(commands.filter((command) => command.type === "thread.history.append")).toHaveLength(
          1,
        );
        expect(threads.get(binding.threadId)?.modelSelection).toEqual(gui.modelSelection);
        expect(commands.some((command) => command.type === "thread.turn.start")).toBe(false);
      }),
  );
  it.effect("restores only the bound thread's own worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sessionWorkspace;
      const worktreePath = NodePath.join(root, "worktree");
      const foreignPath = NodePath.join(root, "foreign-worktree");
      yield* fs.makeDirectory(worktreePath);
      yield* fs.makeDirectory(foreignPath);
      for (const nativeCwd of [worktreePath, foreignPath]) {
        const binding = {
          ...bound("free"),
          resumeCursor: {
            sessionFile: session("free").path,
            sessionId: "free",
            historyLeafId: "assistant-1",
          },
        };
        const row = session("free", { cwd: nativeCwd });
        const { catalog, commands, bindings } = yield* harness({
          rows: [row],
          bindings: [binding],
          threads: [projectedThread(binding.threadId, { worktreePath })],
          read: () => ({
            version: 1,
            session: row,
            truncated: false,
            branchEntryIds: ["assistant-1", "terminal-user"],
            leafId: "terminal-user",
            messages: [
              {
                entryId: "terminal-user",
                role: "user",
                text: "Terminal continuation",
                timestamp: now,
              },
            ],
          }),
        });
        const input = {
          projectId,
          providerInstanceId: instanceId,
          sessionFile: row.path,
        };
        if (nativeCwd !== worktreePath) {
          const error = yield* catalog.resume(input).pipe(Effect.flip);
          expect(error.message).toContain("belongs to");
          expect(commands).toEqual([]);
          expect(bindings[0]?.resumeCursor).toMatchObject({ historyLeafId: "assistant-1" });
          continue;
        }
        expect(yield* catalog.resume(input)).toEqual({
          threadId: binding.threadId,
          created: false,
        });
        expect(commands).toMatchObject([
          {
            type: "thread.history.append",
            threadId: binding.threadId,
            messages: [{ role: "user", text: "Terminal continuation" }],
          },
        ]);
        expect(bindings[0]?.resumeCursor).toMatchObject({ historyLeafId: "terminal-user" });
      }
    }),
  );
  it.effect(
    "restores through the bound instance when preferred discovery lacks history identity",
    () =>
      Effect.gen(function* () {
        const boundInstanceId = ProviderInstanceId.make("neopi-work");
        const binding = {
          ...bound("free"),
          providerInstanceId: boundInstanceId,
          resumeCursor: {
            sessionFile: session("free").path,
            sessionId: "free",
            historyLeafId: "gui-leaf",
          },
        };
        const { catalog, commands, bindings } = yield* harness({
          capabilities: ["session_catalog"],
          defaultInstanceId: instanceId,
          bindings: [binding],
          threads: [projectedThread(binding.threadId)],
          extraInstances: [
            {
              instanceId: boundInstanceId,
              capabilities: ["session_catalog", "session_history_identity"],
              rows: [session("free")],
            },
          ],
          read: () => ({
            version: 1,
            session: session("free"),
            truncated: false,
            branchEntryIds: ["gui-leaf", "terminal-user"],
            leafId: "terminal-user",
            messages: [
              {
                entryId: "terminal-user",
                role: "user",
                text: "Bound profile continuation",
                timestamp: now,
              },
            ],
          }),
        });
        const listed = yield* catalog.list({ projectId, scope: "project" });
        if (listed.status !== "available") throw new Error(listed.reason);
        const selected = listed.sessions[0]!;
        expect(
          yield* catalog.resume({
            projectId,
            providerInstanceId: selected.providerInstanceId,
            sessionFile: selected.sessionFile,
          }),
        ).toEqual({ threadId: binding.threadId, created: false });
        expect(commands).toMatchObject([
          {
            type: "thread.history.append",
            threadId: binding.threadId,
            messages: [{ role: "user", text: "Bound profile continuation" }],
          },
        ]);
        expect(bindings[0]?.resumeCursor).toMatchObject({ historyLeafId: "terminal-user" });
      }),
  );
  it.effect("refuses divergent ancestry and legacy cursors without altering their history", () =>
    Effect.gen(function* () {
      for (const historyLeafId of ["abandoned-leaf", undefined]) {
        const binding = {
          ...bound("free"),
          resumeCursor: {
            sessionFile: session("free").path,
            sessionId: "free",
            historyLeafId,
            turnBoundaries: [{ turnId: "gui-turn", userEntryId: "user-1" }],
          },
        };
        const { catalog, commands, bindings } = yield* harness({
          bindings: [binding],
          threads: [projectedThread(binding.threadId)],
        });
        const error = yield* Effect.flip(
          catalog.resume({
            projectId,
            providerInstanceId: instanceId,
            sessionFile: session("free").path,
          }),
        );
        expect(error.message).toContain(
          historyLeafId ? "branch diverged" : "no native history watermark",
        );
        expect(commands).toEqual([]);
        expect(bindings[0]?.resumeCursor).toEqual(binding.resumeCursor);
      }
    }),
  );
  it.effect("selects a running NeoCode binding without reading or replacing native history", () =>
    Effect.gen(function* () {
      const binding = bound("free", "running");
      const { catalog, commands, calls, bindings } = yield* harness({
        bindings: [binding],
        threads: [projectedThread(binding.threadId)],
      });
      expect(
        yield* catalog.resume({
          projectId,
          providerInstanceId: instanceId,
          sessionFile: session("free").path,
        }),
      ).toEqual({ threadId: binding.threadId, created: false });
      expect(commands).toEqual([]);
      expect(calls.every((call) => call.args[1] !== "read")).toBe(true);
      expect(bindings[0]).toEqual(binding);
    }),
  );
  it.effect(
    "restores terminal deltas after a new native import without losing its stable binding",
    () =>
      Effect.gen(function* () {
        let entries = [
          { entryId: "first-user", role: "user", text: "same", timestamp: now },
          { entryId: "first-answer", role: "assistant", text: "same", timestamp: now },
        ];
        const { catalog, commands, bindings } = yield* harness({
          read: () => ({
            version: 1,
            session: session("free"),
            truncated: false,
            branchEntryIds: entries.map((entry) => entry.entryId),
            leafId: entries.at(-1)?.entryId ?? null,
            messages: entries,
          }),
        });
        const input = {
          projectId,
          providerInstanceId: instanceId,
          sessionFile: session("free").path,
        };
        const first = yield* catalog.resume(input);
        expect(bindings[0]?.resumeCursor).toMatchObject({ historyLeafId: "first-answer" });
        entries = [
          ...entries,
          { entryId: "terminal-user", role: "user", text: "same", timestamp: now },
        ];
        expect(yield* catalog.resume(input)).toEqual({ threadId: first.threadId, created: false });
        expect(commands.at(-1)).toMatchObject({
          type: "thread.history.append",
          messages: [{ messageId: `${first.threadId}:native:terminal-user`, text: "same" }],
        });
        expect(bindings).toHaveLength(1);
        expect(bindings[0]?.resumeCursor).toMatchObject({ historyLeafId: "terminal-user" });
      }),
  );
  it.effect(
    "migrates an exact legacy GUI-turn shutdown boundary before appending terminal history",
    () =>
      Effect.gen(function* () {
        const binding = {
          ...bound("free"),
          resumeCursor: {
            sessionFile: session("free").path,
            sessionId: "free",
            turnBoundaries: [{ turnId: "gui-turn", userEntryId: "gui-user" }],
          },
        };
        const { catalog, commands, bindings } = yield* harness({
          bindings: [binding],
          threads: [
            projectedThread(binding.threadId, {
              latestTurn: {
                turnId: TurnId.make("gui-turn"),
                state: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                assistantMessageId: MessageId.make("gui-answer"),
              },
            }),
          ],
          read: () => ({
            version: 1,
            session: session("free"),
            truncated: false,
            branchEntryIds: [
              "gui-user",
              "digest",
              "gui-answer",
              "gui-exit",
              "terminal-user",
              "terminal-answer",
              "terminal-exit",
            ],
            leafId: "terminal-exit",
            userEntryIds: ["gui-user", "terminal-user"],
            sessionExitEntryIds: ["gui-exit", "terminal-exit"],
            sessionExits: [
              {
                entryId: "gui-exit",
                kind: "normal",
                reason: "dispose",
                pendingToolCallCount: 0,
                lastAssistantStopReason: "stop",
              },
              {
                entryId: "terminal-exit",
                kind: "normal",
                reason: "dispose",
                pendingToolCallCount: 0,
                lastAssistantStopReason: "stop",
              },
            ],
            messages: [
              { entryId: "gui-user", role: "user", text: "same", timestamp: now },
              { entryId: "gui-answer", role: "assistant", text: "same", timestamp: now },
              { entryId: "terminal-user", role: "user", text: "same", timestamp: now },
              { entryId: "terminal-answer", role: "assistant", text: "same", timestamp: now },
            ],
          }),
        });
        const input = {
          projectId,
          providerInstanceId: instanceId,
          sessionFile: session("free").path,
        };
        expect(yield* catalog.resume(input)).toEqual({
          threadId: binding.threadId,
          created: false,
        });
        expect(commands).toMatchObject([
          {
            type: "thread.history.append",
            messages: [
              { messageId: `${binding.threadId}:native:terminal-user` },
              { messageId: `${binding.threadId}:native:terminal-answer` },
            ],
          },
        ]);
        expect(bindings[0]?.resumeCursor).toMatchObject({ historyLeafId: "terminal-exit" });
        yield* catalog.resume(input);
        expect(commands).toHaveLength(1);
      }),
  );
  it.effect("never migrates past an unfinished, malformed, or later-lifetime legacy exit", () =>
    Effect.gen(function* () {
      for (const scenario of [
        "pending",
        "aborted",
        "abnormal",
        "malformed-first",
        "empty-user-before-exit",
        "missing-anchor",
      ] as const) {
        const binding = {
          ...bound("free"),
          resumeCursor: {
            sessionFile: session("free").path,
            sessionId: "free",
            turnBoundaries: [
              {
                turnId: "gui-turn",
                userEntryId: scenario === "missing-anchor" ? "missing" : "gui-user",
              },
            ],
          },
        };
        const { catalog, commands } = yield* harness({
          bindings: [binding],
          threads: [
            projectedThread(binding.threadId, {
              latestTurn: {
                turnId: TurnId.make("gui-turn"),
                state: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                assistantMessageId: MessageId.make("gui-answer"),
              },
            }),
          ],
          read: () => ({
            version: 1,
            session: session("free"),
            truncated: false,
            branchEntryIds: [
              "gui-user",
              "gui-answer",
              ...(scenario === "malformed-first" ? ["malformed-exit"] : []),
              ...(scenario === "empty-user-before-exit" ? ["empty-terminal-user"] : []),
              "exit",
              "terminal-user",
            ],
            leafId: "terminal-user",
            userEntryIds: [
              "gui-user",
              "terminal-user",
              ...(scenario === "empty-user-before-exit" ? ["empty-terminal-user"] : []),
            ],
            sessionExitEntryIds: [
              ...(scenario === "malformed-first" ? ["malformed-exit"] : []),
              "exit",
            ],
            sessionExits: [
              {
                entryId: "exit",
                kind: scenario === "abnormal" ? "signal" : "normal",
                reason: "dispose",
                pendingToolCallCount: scenario === "pending" ? 1 : 0,
                lastAssistantStopReason: scenario === "aborted" ? "aborted" : "stop",
              },
            ],
            messages: [],
          }),
        });
        const error = yield* Effect.flip(
          catalog.resume({
            projectId,
            providerInstanceId: instanceId,
            sessionFile: session("free").path,
          }),
        );
        expect(error.message).toContain("No history was changed");
        expect(error.message).toContain("--session");
        expect(commands).toEqual([]);
      }
    }),
  );
  it.effect(
    "reads terminal deltas uncapped across compaction and appends every message in bounded batches",
    () =>
      Effect.gen(function* () {
        const binding = {
          ...bound("free"),
          resumeCursor: {
            sessionFile: session("free").path,
            sessionId: "free",
            historyLeafId: "invisible-watermark",
          },
        };
        const branchMessages = Array.from({ length: 405 }, (_, index) => ({
          entryId: `native-${index}`,
          role: "user",
          text: "identical",
          timestamp: now,
        }));
        const { catalog, commands, calls, bindings } = yield* harness({
          bindings: [binding],
          threads: [projectedThread(binding.threadId)],
          read: () => ({
            version: 1,
            session: session("free"),
            truncated: false,
            branchEntryIds: [
              "invisible-watermark",
              "compaction",
              ...branchMessages.map((message) => message.entryId),
              "custom-tail",
            ],
            leafId: "custom-tail",
            messages: branchMessages.slice(-5),
            branchMessages,
          }),
        });
        yield* catalog.resume({
          projectId,
          providerInstanceId: instanceId,
          sessionFile: session("free").path,
        });
        const appends = commands.filter((command) => command.type === "thread.history.append");
        expect(appends.map((command) => command.messages.length)).toEqual([200, 200, 5]);
        expect(
          appends.flatMap((command) => command.messages.map((message) => message.messageId)),
        ).toEqual(branchMessages.map((message) => `${binding.threadId}:native:${message.entryId}`));
        expect(calls.find((call) => call.args[1] === "read")?.args).toEqual([
          "sessions",
          "read",
          "--json",
          session("free").path,
        ]);
        expect(bindings[0]?.resumeCursor).toMatchObject({ historyLeafId: "custom-tail" });
      }),
  );
  it.effect(
    "keeps discovery available but rejects identity-dependent operations before stopping an older NeoPi",
    () =>
      Effect.gen(function* () {
        const binding = bound("free", "running");
        const { catalog, calls, commands } = yield* harness({
          capabilities: ["session_catalog"],
          bindings: [binding],
          threads: [projectedThread(binding.threadId)],
        });
        expect((yield* catalog.list({ projectId, scope: "project" })).status).toBe("available");
        const handoff = yield* Effect.flip(catalog.handoff({ threadId: binding.threadId }));
        expect(handoff.message).toContain("session_history_identity");
        expect(commands).toEqual([]);
        const fresh = yield* harness({ capabilities: ["session_catalog"] });
        const resume = yield* Effect.flip(
          fresh.catalog.resume({
            projectId,
            providerInstanceId: instanceId,
            sessionFile: session("free").path,
          }),
        );
        expect(resume.message).toContain("Update NeoPi");
        expect(fresh.commands).toEqual([]);
        expect([...calls, ...fresh.calls].every((call) => call.args[1] !== "read")).toBe(true);
      }),
  );
});

const configurationSnapshot = (
  providerInstanceId: ProviderInstanceId,
  sessionId: string,
): NeoPiSessionConfigurationResult => ({
  status: "available",
  providerInstanceId,
  sessionId,
  attachment: "owned",
  model: { provider: "test", id: sessionId, name: null },
  thinkingLevel: null,
  activeRole: null,
  observedAt: now,
  roles: { status: "unsupported", reason: "Not advertised" },
});

describe("bound NeoPi configuration", () => {
  it.live("routes two threads to their recorded instances rather than the enabled default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const otherId = ProviderInstanceId.make("neopi-work");
        const personal = bound("personal", "running");
        const work = { ...bound("work", "running"), providerInstanceId: otherId };
        const inspected: string[] = [];
        const h = yield* harness({
          bindings: [personal, work],
          defaultInstanceId: instanceId,
          configuration: (threadId, expected) =>
            Effect.sync(() => {
              inspected.push(`personal:${threadId}`);
              return configurationSnapshot(instanceId, expected.sessionId);
            }),
          extraInstances: [
            {
              instanceId: otherId,
              capabilities: [],
              rows: [],
              configuration: (threadId, expected) =>
                Effect.sync(() => {
                  inspected.push(`work:${threadId}`);
                  return configurationSnapshot(otherId, expected.sessionId);
                }),
            },
          ],
        });
        const second = yield* h.catalog.configuration({ threadId: work.threadId });
        const first = yield* h.catalog.configuration({ threadId: personal.threadId });
        expect(second).toEqual(configurationSnapshot(otherId, "work"));
        expect(first).toEqual(configurationSnapshot(instanceId, "personal"));
        expect(inspected).toEqual([`work:${work.threadId}`, `personal:${personal.threadId}`]);
        expect(h.calls).toEqual([]);
        expect(h.commands).toEqual([]);
        expect(h.bindings).toEqual([personal, work]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "does not read stopped, other-provider, unknown-instance or missing-runtime sessions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let reads = 0;
          const stopped = bound("stopped");
          const foreign = {
            ...bound("foreign", "running"),
            provider: ProviderDriverKind.make("codex"),
          };
          const absent = {
            ...bound("absent", "running"),
            providerInstanceId: ProviderInstanceId.make("missing-instance"),
          };
          const h = yield* harness({
            bindings: [stopped, foreign, absent],
            configuration: () =>
              Effect.sync(() => {
                reads++;
                return configurationSnapshot(instanceId, "wrong");
              }),
          });
          for (const threadId of [
            stopped.threadId,
            foreign.threadId,
            absent.threadId,
            ThreadId.make("missing"),
          ])
            expect((yield* h.catalog.configuration({ threadId })).status).toBe("unavailable");
          expect(reads).toBe(0);
          const missingRuntime = bound("no-runtime", "running");
          const disconnected = yield* harness({ bindings: [missingRuntime] });
          expect(
            (yield* disconnected.catalog.configuration({ threadId: missingRuntime.threadId }))
              .status,
          ).toBe("unavailable");
          expect(h.calls).toEqual([]);
          expect(h.commands).toEqual([]);
          expect(disconnected.calls).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("discards a snapshot if the bound native identity changes during the read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = bound("original", "running");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const h = yield* harness({
          bindings: [binding],
          configuration: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return configurationSnapshot(instanceId, "original");
            }),
        });
        const read = yield* h.catalog
          .configuration({ threadId: binding.threadId })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        h.bindings[0] = {
          ...binding,
          resumeCursor: { sessionFile: session("replacement").path, sessionId: "replacement" },
        };
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(read)).status).toBe("unavailable");
        expect(h.calls).toEqual([]);
        expect(h.commands).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a reader result from another native session or provider instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = bound("original", "running");
        for (const result of [
          configurationSnapshot(instanceId, "replacement"),
          configurationSnapshot(ProviderInstanceId.make("other"), "original"),
        ]) {
          const h = yield* harness({
            bindings: [binding],
            configuration: () => Effect.succeed(result),
          });
          expect((yield* h.catalog.configuration({ threadId: binding.threadId })).status).toBe(
            "unavailable",
          );
          expect(h.calls).toEqual([]);
          expect(h.commands).toEqual([]);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("observed NeoPi configuration", () => {
  it.live("subscribes before reading and coalesces changes racing the initial snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = bound("observed", "running");
        const changes = yield* PubSub.sliding<void>(1);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let model = "before";
        let reads = 0;
        let observers = 0;
        const h = yield* harness({
          bindings: [binding],
          observeConfiguration: () =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  observers++;
                }),
                () =>
                  Effect.sync(() => {
                    observers--;
                  }),
              );
              const subscription = yield* PubSub.subscribe(changes);
              return {
                changes: Stream.fromEffectRepeat(PubSub.take(subscription)),
                read: Effect.gen(function* () {
                  const id = model;
                  if (++reads === 1) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  return {
                    ...configurationSnapshot(instanceId, "observed"),
                    model: { provider: "test", id, name: null },
                  };
                }),
              };
            }),
        });
        expect(reads).toBe(0);
        const watching = yield* h.catalog
          .watchConfiguration({ threadId: binding.threadId })
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
        yield* Deferred.await(entered);
        model = "after";
        for (let i = 0; i < 100; i++) yield* PubSub.publish(changes, undefined);
        yield* Deferred.succeed(release, undefined);
        const results = yield* Fiber.join(watching);
        expect(results.map((result) => result.status === "available" && result.model?.id)).toEqual([
          "before",
          "after",
        ]);
        expect(reads).toBe(2);
        expect(observers).toBe(0);
        yield* PubSub.publish(changes, undefined);
        expect(reads).toBe(2);
        expect(h.commands).toEqual([]);
        expect(h.calls).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("cancels observation and releases subscriptions without another native read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = bound("observed", "running");
        const changes = yield* PubSub.sliding<void>(1);
        const output = yield* Queue.unbounded<NeoPiSessionConfigurationResult>();
        const closed = yield* Deferred.make<void>();
        let reads = 0;
        const h = yield* harness({
          bindings: [binding],
          observeConfiguration: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
              const subscription = yield* PubSub.subscribe(changes);
              return {
                changes: Stream.fromEffectRepeat(PubSub.take(subscription)),
                read: Effect.sync(() => {
                  reads++;
                  return configurationSnapshot(instanceId, "observed");
                }),
              };
            }),
        });
        const watching = yield* h.catalog.watchConfiguration({ threadId: binding.threadId }).pipe(
          Stream.runForEach((result) => Queue.offer(output, result)),
          Effect.forkScoped,
        );
        expect((yield* Queue.take(output)).status).toBe("available");
        yield* Fiber.interrupt(watching);
        yield* Deferred.await(closed);
        yield* PubSub.publish(changes, undefined);
        expect(reads).toBe(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const replacement of ["binding", "instance"] as const)
    it.live(
      `ends an idle observation on ${replacement} replacement without following its owner`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const binding = bound("observed", "running");
            const output = yield* Queue.unbounded<NeoPiSessionConfigurationResult>();
            let reads = 0;
            const h = yield* harness({
              bindings: [binding],
              observeConfiguration: () =>
                Effect.succeed({
                  changes: Stream.never,
                  read: Effect.sync(() => {
                    reads++;
                    return configurationSnapshot(instanceId, "observed");
                  }),
                }),
            });
            const watching = yield* h.catalog
              .watchConfiguration({ threadId: binding.threadId })
              .pipe(
                Stream.runForEach((result) => Queue.offer(output, result)),
                Effect.forkScoped,
              );
            expect((yield* Queue.take(output)).status).toBe("available");
            if (replacement === "binding")
              h.bindings[0] = { ...binding, adapterKey: "replacement-runtime" };
            else h.allInstances[0] = { ...h.allInstances[0]! };
            yield* h.notifyRegistry;
            expect((yield* Queue.take(output)).status).toBe("unavailable");
            yield* Fiber.join(watching);
            expect(reads).toBe(1);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );

  it.live("rejects a binding change during an in-flight native snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = bound("observed", "running");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const h = yield* harness({
          bindings: [binding],
          observeConfiguration: () =>
            Effect.succeed({
              changes: Stream.never,
              read: Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return configurationSnapshot(instanceId, "observed");
              }),
            }),
        });
        const watching = yield* h.catalog
          .watchConfiguration({ threadId: binding.threadId })
          .pipe(Stream.runCollect, Effect.forkScoped);
        yield* Deferred.await(entered);
        h.bindings[0] = {
          ...binding,
          resumeCursor: { sessionId: "replacement", sessionFile: "/replacement.jsonl" },
        };
        yield* Deferred.succeed(release, undefined);
        const results = yield* Fiber.join(watching);
        expect(results.map((result) => result.status)).toEqual(["unavailable"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.live("invalidates an idle observation when orchestration reports its binding stopped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binding = bound("observed", "running");
      const domainEvents = yield* PubSub.sliding<OrchestrationEvent>(1);
      const output = yield* Queue.unbounded<NeoPiSessionConfigurationResult>();
      let reads = 0;
      const h = yield* harness({
        bindings: [binding],
        domainEvents,
        observeConfiguration: () =>
          Effect.succeed({
            changes: Stream.never,
            read: Effect.sync(() => {
              reads++;
              return configurationSnapshot(instanceId, "observed");
            }),
          }),
      });
      const watching = yield* h.catalog.watchConfiguration({ threadId: binding.threadId }).pipe(
        Stream.runForEach((result) => Queue.offer(output, result)),
        Effect.forkScoped,
      );
      expect((yield* Queue.take(output)).status).toBe("available");
      h.bindings[0] = { ...binding, status: "stopped" };
      yield* PubSub.publish(domainEvents, {
        type: "thread.session-set",
        sequence: 1,
        eventId: EventId.make("observed-stop"),
        aggregateKind: "thread",
        aggregateId: binding.threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: binding.threadId,
          session: {
            threadId: binding.threadId,
            status: "stopped",
            providerName: "neopi",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      });
      expect((yield* Queue.take(output)).status).toBe("unavailable");
      yield* Fiber.join(watching);
      expect(reads).toBe(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports native configuration read failures through the stream error channel", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binding = bound("observed", "running");
      const closed = yield* Deferred.make<void>();
      const h = yield* harness({
        bindings: [binding],
        observeConfiguration: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
            return {
              changes: Stream.never,
              read: Effect.fail(
                new ProviderAdapterRequestError({
                  provider: ProviderDriverKind.make("neopi"),
                  method: "configuration",
                  detail: "NeoPi returned malformed session configuration.",
                }),
              ),
            };
          }),
      });
      const error = yield* h.catalog
        .watchConfiguration({ threadId: binding.threadId })
        .pipe(Stream.runCollect, Effect.flip);
      expect(error.operation).toBe("configuration");
      expect(error.message).toContain("malformed session configuration");
      yield* Deferred.await(closed);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("interrupts a pending native snapshot when its observer disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binding = bound("observed", "running");
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const h = yield* harness({
        bindings: [binding],
        observeConfiguration: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
            return {
              changes: Stream.never,
              read: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(cancelled, undefined)),
              ),
            };
          }),
      });
      const watching = yield* h.catalog
        .watchConfiguration({ threadId: binding.threadId })
        .pipe(Stream.runDrain, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(watching);
      yield* Deferred.await(cancelled);
      yield* Deferred.await(closed);
      expect(h.calls).toEqual([]);
      expect(h.commands).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
