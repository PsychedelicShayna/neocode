import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

const spawn = vi.fn(() => {
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  return {
    pid: 42,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((callback: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.add(callback);
      return {
        dispose: () => {
          exitListeners.delete(callback);
        },
      };
    }),
    emitExit: () => {
      for (const listener of exitListeners) listener({ exitCode: 0 });
    },
  };
});

const fakeNodePty = { spawn } as unknown as typeof import("node-pty");

const makeTestLayer = (
  platform: NodeJS.Platform = "win32",
  readIdentity: (pid: number, platform: NodeJS.Platform) => string | undefined = () => "owned",
) =>
  NodePtyAdapter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, platform),
        Layer.succeed(HostProcessArchitecture, "x64"),
        Layer.succeed(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.resolve(fakeNodePty)),
        Layer.succeed(NodePtyAdapter.NodePtyProcessIdentityReaderRef, readIdentity),
      ),
    ),
  );

const testLayer = makeTestLayer();

for (const platform of ["win32", "linux", "darwin"] as const) {
  it.effect(`terminates through node-pty using ${platform} semantics`, () =>
    Effect.gen(function* () {
      const adapter = yield* PtyAdapter.PtyAdapter;
      const process = yield* adapter.spawn({
        shell: "test-shell",
        cwd: ".",
        cols: 80,
        rows: 24,
        env: {},
      });
      const nativeProcess = spawn.mock.results.at(-1)!.value;
      nativeProcess.kill.mockImplementation((signal?: string) => {
        if (platform === "win32" && signal) {
          throw new Error("Signals not supported on windows.");
        }
      });

      process.kill("SIGTERM");
      process.kill("SIGKILL");
      process.kill();

      assert.deepEqual(
        nativeProcess.kill.mock.calls,
        platform === "win32"
          ? [[undefined], [undefined], [undefined]]
          : [["SIGTERM"], ["SIGKILL"], [undefined]],
      );
    }).pipe(Effect.provide(makeTestLayer(platform))),
  );
}

for (const platform of ["linux", "darwin"] as const) {
  let currentIdentity: string | undefined = "owned";
  it.effect(`refuses a reused or unidentifiable ${platform} process before escalation`, () =>
    Effect.gen(function* () {
      const adapter = yield* PtyAdapter.PtyAdapter;
      const process = yield* adapter.spawn({
        shell: "test-shell",
        cwd: ".",
        cols: 80,
        rows: 24,
        env: {},
      });
      const nativeProcess = spawn.mock.results.at(-1)!.value;
      process.kill("SIGTERM");
      currentIdentity = "replacement";
      assert.throws(() => process.kill("SIGKILL"), /identity is no longer owned/);
      currentIdentity = undefined;
      assert.throws(() => process.kill("SIGKILL"), /identity is no longer owned/);
      assert.deepEqual(nativeProcess.kill.mock.calls, [["SIGTERM"]]);
    }).pipe(Effect.provide(makeTestLayer(platform, () => currentIdentity))),
  );
}

it.effect("never signals after native exit even if the session exit listener is detached", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "test-shell",
      cwd: ".",
      cols: 80,
      rows: 24,
      env: {},
    });
    const nativeProcess = spawn.mock.results.at(-1)!.value;
    const unsubscribe = process.onExit(() => {});
    unsubscribe();
    nativeProcess.emitExit();
    process.kill("SIGTERM");
    process.kill("SIGKILL");
    assert.deepEqual(nativeProcess.kill.mock.calls, []);
  }).pipe(Effect.provide(makeTestLayer("linux"))),
);

it.effect("refuses to adopt a process identity that was unavailable at spawn", () =>
  Effect.gen(function* () {
    let identity: string | undefined;
    const adapter = yield* NodePtyAdapter.make().pipe(
      Effect.provideService(NodePtyAdapter.NodePtyProcessIdentityReaderRef, () => identity),
    );
    const process = yield* adapter.spawn({
      shell: "test-shell",
      cwd: ".",
      cols: 80,
      rows: 24,
      env: {},
    });
    const nativeProcess = spawn.mock.results.at(-1)!.value;
    identity = "new-process";
    assert.throws(() => process.kill("SIGTERM"), /identity is no longer owned/);
    assert.deepEqual(nativeProcess.kill.mock.calls, []);
  }).pipe(
    Effect.provideService(NodePtyAdapter.NodePtyModuleLoaderRef, () =>
      Promise.resolve(fakeNodePty),
    ),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(HostProcessArchitecture, "x64"),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("spawns through the public adapter with the provided host references", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      ["-NoLogo"],
      {
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: { TERM: "xterm-256color" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves a caller-provided TERM in the spawn env on win32", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-direct" },
    });

    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      [],
      {
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: { TERM: "xterm-direct" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native binding could not be loaded");
    const exit = yield* NodePtyAdapter.make().pipe(
      Effect.provideService(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.reject(cause)),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
      });
      assert.equal(error.message, "Failed to load node-pty for win32-x64.");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(HostProcessArchitecture, "x64"),
      ),
    ),
  ),
);
