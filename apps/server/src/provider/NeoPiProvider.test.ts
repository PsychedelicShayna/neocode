// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { NeoPiSettings } from "@t3tools/contracts";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeNeoPiDiscoveryHub } from "./neopi/NeoPiDiscovery.ts";
import { NEOPI_CAPABILITIES } from "./neopi/NeoPiCompatibility.ts";
import { answer, defaultReady, testPeer } from "./neopi/NeoPiTestPeer.ts";
import type { NeoPiCapabilityProbe } from "./neopi/NeoPiSessionCatalogSource.ts";
import {
  authFromLoginProviders,
  buildInitialNeoPiProviderSnapshot,
  checkNeoPiProviderStatus,
  modelsFromNeoPiRpc,
  requestNeoPiProviderMetadata,
  resolveNeoPiBinary,
} from "./NeoPiProvider.ts";

const settings: NeoPiSettings = {
  enabled: true,
  binaryPath: "/no/such/npi-binary",
  profile: "",
  launchArgs: "",
  customModels: [],
};

it.effect(
  "only reports OAuth authentication that RPC explicitly confirms; API keys and local models stay unknown",
  () =>
    Effect.sync(() => {
      assert.equal(
        authFromLoginProviders({ providers: [{ id: "openai", authenticated: false }] }),
        "unknown",
      );
      assert.equal(authFromLoginProviders({ providers: [] }), "unknown");
      assert.equal(
        authFromLoginProviders({ providers: [{ id: "openai", authenticated: true }] }),
        "authenticated",
      );
      assert.equal(
        authFromLoginProviders({ providers: [{ id: "openai", authenticated: true }] }, "local"),
        "unknown",
      );
      assert.equal(
        authFromLoginProviders({ providers: [{ id: "local", available: true }] }),
        "unknown",
      );
    }),
);

it.effect("keeps advertised native roles selectable ahead of provider models", () =>
  Effect.gen(function* () {
    const metadata = yield* requestNeoPiProviderMetadata({
      capabilities: new Set([NEOPI_CAPABILITIES.getRoles]),
      request: <C extends { type: string }>(command: C): Effect.Effect<unknown> => {
        return Effect.succeed(
          command.type === "get_roles"
            ? {
                roles: [
                  {
                    id: "smol",
                    alias: "@smol",
                    name: "Fast",
                    source: "builtin",
                    patterns: ["openai/gpt-5.6-luna:low"],
                    hidden: false,
                  },
                ],
              }
            : {},
        );
      },
    });
    assert.equal(
      modelsFromNeoPiRpc(
        { models: [{ provider: "openai", id: "gpt-5.6-luna" }] },
        undefined,
        false,
        metadata.roles,
      )[0]?.slug,
      "@smol",
    );
  }),
);

it.live(
  "a configured executable that cannot run remains unavailable without falling back to npi",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const discovery = yield* makeNeoPiDiscoveryHub();
        const result = yield* checkNeoPiProviderStatus(
          settings,
          {},
          "/tmp",
          spawner.spawn,
          discovery,
        );
        assert.equal(result.installed, false);
        assert.equal(result.status, "error");
        assert.match(result.message ?? "", /\/no\/such\/npi-binary/);
        const initial = yield* buildInitialNeoPiProviderSnapshot({ ...settings, enabled: false });
        assert.equal(initial.status, "disabled");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.live("prefers capable released npi while preserving fallbacks and explicit selections", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "neopi-selection-"));
    const stableDir = NodePath.join(dir, "stable");
    const nightlyDir = NodePath.join(dir, "nightly");
    NodeFS.mkdirSync(stableDir);
    NodeFS.mkdirSync(nightlyDir);
    const writePeer = (path: string, capable: boolean) =>
      NodeFS.writeFileSync(
        path,
        `#!${process.execPath}
if (process.argv.includes("--version")) { console.log("npi v1.2.3"); process.exit(0); }
const send = (frame) => console.log(JSON.stringify(frame));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  send({ id: request.id, type: "response", command: request.type, success: true,
    data: { protocolVersion: 2 } });
});
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1,2],
  maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864,
  capabilities: ${JSON.stringify(capable ? ["session_catalog"] : [])} });
`,
        { mode: 0o755 },
      );
    try {
      const stable = NodePath.join(stableDir, "npi");
      const nightly = NodePath.join(nightlyDir, "npi-nightly");
      writePeer(stable, false);
      writePeer(nightly, true);
      const env = { PATH: [stableDir, nightlyDir].join(NodePath.delimiter) };
      const selected = yield* resolveNeoPiBinary({ binaryPath: "npi" }, env, dir);
      assert.equal(selected?.binary, nightly);
      assert.equal(selected?.version, "1.2.3");
      assert.equal(selected?.error, null);
      assert.equal(selected?.autoSelected, true);

      writePeer(stable, true);
      assert.equal((yield* resolveNeoPiBinary({ binaryPath: "npi" }, env, dir))?.binary, stable);
      assert.equal(
        (yield* resolveNeoPiBinary({ binaryPath: "npi" }, env, dir, nightly))?.binary,
        nightly,
      );
      writePeer(stable, false);

      // Explicit choices are not capability-filtered or rewritten.
      const explicit = yield* resolveNeoPiBinary({ binaryPath: stable }, env, dir);
      assert.equal(explicit?.binary, stable);
      assert.equal(explicit?.autoSelected, false);
      assert.equal(explicit?.error, null);

      writePeer(stable, true);
      writePeer(nightly, false);
      assert.equal((yield* resolveNeoPiBinary({ binaryPath: "" }, env, dir))?.binary, stable);
      NodeFS.unlinkSync(nightly);
      assert.equal((yield* resolveNeoPiBinary({ binaryPath: "npi" }, env, dir))?.binary, stable);

      writePeer(nightly, true);
      NodeFS.unlinkSync(stable);
      assert.equal((yield* resolveNeoPiBinary({ binaryPath: "npi" }, env, dir))?.binary, nightly);

      // A failing candidate must not hide a later capable executable.
      NodeFS.writeFileSync(stable, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
      assert.equal((yield* resolveNeoPiBinary({ binaryPath: "npi" }, env, dir))?.binary, nightly);
      NodeFS.writeFileSync(stable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, {
        mode: 0o755,
      });
      assert.equal((yield* resolveNeoPiBinary({ binaryPath: "npi" }, env, dir))?.binary, nightly);

      const resources = NodePath.join(dir, "resources");
      const bundled = NodePath.join(resources, "bin", "npi");
      NodeFS.mkdirSync(NodePath.dirname(bundled), { recursive: true });
      writePeer(bundled, true);
      writePeer(stable, false);
      writePeer(nightly, false);
      const packagedEnv = { ...env, T3CODE_DESKTOP_RESOURCES_PATH: resources };
      assert.equal(
        (yield* resolveNeoPiBinary({ binaryPath: "npi" }, packagedEnv, dir))?.binary,
        bundled,
      );
      writePeer(nightly, true);
      assert.equal(
        (yield* resolveNeoPiBinary({ binaryPath: "npi" }, packagedEnv, dir))?.binary,
        nightly,
      );

      NodeFS.unlinkSync(nightly);
      NodeFS.unlinkSync(bundled);
      const absent = yield* resolveNeoPiBinary({ binaryPath: "npi" }, env, dir);
      assert.match(absent?.error ?? "", /No compatible NeoPi executable with session_catalog/);
      const missingOverride = NodePath.join(dir, "absent");
      const failed = yield* resolveNeoPiBinary({ binaryPath: missingOverride }, packagedEnv, dir);
      assert.equal(failed?.binary, missingOverride);
      assert.notEqual(failed?.error, null);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("live commands take precedence over an older full-loadout probe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hub = yield* makeNeoPiDiscoveryHub();
      yield* hub.publish({
        source: "full-probe",
        cwd: "/tmp",
        at: "1",
        commands: [{ name: "compact" }],
        skills: [],
      });
      yield* hub.publish({
        source: "live",
        cwd: "/tmp",
        at: "2",
        commands: [{ name: "compact" }, { name: "review" }],
        skills: [],
      });
      yield* hub.publish({
        source: "full-probe",
        cwd: "/tmp",
        at: "3",
        commands: [{ name: "stale" }],
        skills: [],
      });
      const latest = yield* hub.latest("/tmp");
      assert.deepEqual(
        latest.commands.map((command) => command.name),
        ["compact", "review"],
      );
      assert.equal(latest.source, "live");
    }),
  ),
);

const previousCatalog = {
  models: [
    {
      slug: "openai/gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "@smol",
      name: "Fast",
      isCustom: false,
      capabilities: null,
    },
  ],
  roles: {
    roles: [
      {
        id: "smol",
        alias: "@smol",
        name: "Fast",
        source: "builtin",
        patterns: ["openai/gpt-5.6-luna:low"],
        hidden: false,
      },
    ],
  },
};

const writeSlowPeer = (dir: string): string => {
  const peer = NodePath.join(dir, "peer.mjs");
  const binary = NodePath.join(dir, "npi");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  NodeFS.writeFileSync(
    peer,
    [
      "import readline from 'node:readline';",
      "if (process.env.NEOPI_MOCK_MODE !== 'hang-handshake') {",
      "  process.stdout.write(JSON.stringify({",
      "    type: 'ready',",
      "    protocolVersion: 1,",
      "    supportedProtocolVersions: [1, 2],",
      "    maxFrameBytes: 1048576,",
      "    maxReassembledFrameBytes: 8388608,",
      "    capabilities: ['set_mode', 'get_roles', 'rpc-ui'],",
      "  }) + '\\n');",
      "}",
      "const lines = readline.createInterface({ input: process.stdin });",
      "lines.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  let message;",
      "  try { message = JSON.parse(line); } catch { return; }",
      "  if (!message || message.type !== 'negotiate_protocol') return;",
      "  process.stdout.write(JSON.stringify({",
      "    id: message.id,",
      "    type: 'response',",
      "    command: 'negotiate_protocol',",
      "    success: true,",
      "    data: { protocolVersion: 2 },",
      "  }) + '\\n');",
      "});",
      "lines.on('close', () => process.exit(0));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1 << 30);",
      "",
    ].join("\n"),
  );
  NodeFS.writeFileSync(
    binary,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "npi v9.9.9"; exit 0; fi\nexec ${quote(process.execPath)} ${quote(peer)}\n`,
    { mode: 0o755 },
  );
  return binary;
};

it.live("publishes ready capabilities when metadata times out and keeps the previous catalog", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-neopi-slow-meta-"));
    try {
      const binary = writeSlowPeer(dir);
      const capabilities = new Set<string>();
      const discovery = yield* makeNeoPiDiscoveryHub();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const result = yield* checkNeoPiProviderStatus(
        { ...settings, binaryPath: binary },
        { NEOPI_MOCK_MODE: "hang-metadata" },
        dir,
        spawner.spawn,
        discovery,
        capabilities,
        {
          previous: previousCatalog,
          handshakeTimeout: "5 seconds",
          metadataTimeout: "250 millis",
        },
      );
      assert.equal(result.installed, true);
      assert.equal(result.status, "warning");
      assert.match(result.message ?? "", /metadata probe timed out/);
      assert.equal(/handshake timed out/.test(result.message ?? ""), false);
      assert.equal(result.showInteractionModeToggle, true);
      assert.equal(result.compatibilityAdvisory?.status, "supported");
      assert.deepEqual(
        result.models.map((model) => model.slug),
        ["openai/gpt-5.6-luna", "@smol"],
      );
      assert.equal(capabilities.has(NEOPI_CAPABILITIES.setMode), true);
      assert.equal(capabilities.has(NEOPI_CAPABILITIES.getRoles), true);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "names a handshake timeout and does not publish capabilities from a peer that never readied",
  () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-neopi-slow-handshake-"));
      try {
        const binary = writeSlowPeer(dir);
        const capabilities = new Set<string>();
        const discovery = yield* makeNeoPiDiscoveryHub();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const result = yield* checkNeoPiProviderStatus(
          { ...settings, binaryPath: binary },
          { NEOPI_MOCK_MODE: "hang-handshake" },
          dir,
          spawner.spawn,
          discovery,
          capabilities,
          {
            previous: previousCatalog,
            handshakeTimeout: "200 millis",
            metadataTimeout: "200 millis",
          },
        );
        assert.equal(result.status, "warning");
        assert.match(result.message ?? "", /handshake timed out/);
        assert.equal(/metadata probe timed out/.test(result.message ?? ""), false);
        assert.equal(result.showInteractionModeToggle, false);
        assert.equal(capabilities.size, 0);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "replaces compatible capabilities but retains the last handshake across failed refreshes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let mode: "available" | "removed" | "failed" | "missing" | "unsupported" = "available";
        const fullCapabilities = [
          "rpc-ui",
          "session_catalog",
          "session_history_identity",
          "set_mode",
        ];
        const capabilities = new Set<string>();
        const probe: NeoPiCapabilityProbe = { status: "unprobed", version: null };
        const hub = yield* makeNeoPiDiscoveryHub();
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command))
              throw new Error("Expected a standard command");
            if (command.command !== settings.binaryPath)
              throw new Error("Changed the configured executable");
            if (command.args[0] === "--version") {
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(123),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(mode === "missing" ? 1 : 0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: Stream.make(new TextEncoder().encode("npi v1.2.3\n")),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              });
            }
            if (mode === "failed") {
              return yield* PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "spawn",
                cause: new Error("RPC start failed"),
              });
            }
            const peer = yield* testPeer(
              (request, emit) =>
                answer(
                  request,
                  emit,
                  request.type === "negotiate_protocol" ? { protocolVersion: 2 } : {},
                ),
              {
                ...defaultReady,
                supportedProtocolVersions: mode === "unsupported" ? [1] : [1, 2],
                capabilities: mode === "available" ? fullCapabilities : ["rpc-ui"],
              },
              undefined,
              true,
            );
            return peer.handle;
          }),
        );
        const refresh = () =>
          checkNeoPiProviderStatus(settings, {}, "/workspace", spawner.spawn, hub, capabilities, {
            capabilityProbe: probe,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

        assert.equal((yield* refresh()).status, "ready");
        assert.equal(probe.status, "compatible");
        assert.deepEqual([...capabilities], fullCapabilities);

        mode = "removed";
        assert.equal((yield* refresh()).status, "ready");
        assert.deepEqual([...capabilities], ["rpc-ui"]);

        mode = "failed";
        assert.equal((yield* refresh()).status, "warning");
        assert.equal(probe.status, "compatible");
        assert.include(probe.failure ?? "", "RPC handshake failed");
        assert.deepEqual([...capabilities], ["rpc-ui"]);

        mode = "missing";
        assert.equal((yield* refresh()).status, "error");
        assert.equal(probe.status, "compatible");
        assert.include(probe.failure ?? "", "version probe exited 1");
        assert.deepEqual([...capabilities], ["rpc-ui"]);

        mode = "unsupported";
        assert.equal((yield* refresh()).compatibilityAdvisory?.status, "unsupported");
        assert.equal(probe.status, "unsupported");
        assert.equal(probe.failure, undefined);
        assert.deepEqual([...capabilities], ["rpc-ui"]);

        mode = "available";
        assert.equal((yield* refresh()).status, "ready");
        assert.equal(probe.status, "compatible");
        assert.equal(probe.failure, undefined);
        assert.deepEqual([...capabilities], fullCapabilities);
      }),
    ),
);
