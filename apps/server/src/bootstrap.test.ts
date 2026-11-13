// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { readBootstrapEnvelope, waitForParentInputClose } from "./bootstrap.ts";
import { assertNone, assertSome } from "@effect/vitest/utils";

const openSyncInterceptor = vi.hoisted(() => ({
  failPath: null as string | null,
  errorCode: "ENXIO",
}));
const fstatSyncInterceptor = vi.hoisted(() => ({ failFd: null as number | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const [filePath, flags] = args;
      if (
        typeof filePath === "string" &&
        filePath === openSyncInterceptor.failPath &&
        flags === "r"
      ) {
        const error = new Error(`open failed with ${openSyncInterceptor.errorCode}`);
        Object.assign(error, { code: openSyncInterceptor.errorCode });
        throw error;
      }
      return (actual.openSync as (...a: typeof args) => number)(...args);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      if (args[0] === fstatSyncInterceptor.failFd) {
        const error = new Error("permission denied");
        Object.assign(error, { code: "EACCES" });
        throw error;
      }
      return (actual.fstatSync as (...a: typeof args) => NodeFS.Stats)(...args);
    },
  };
});

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const nullDevice = windowsHost ? "\\\\.\\NUL" : "/dev/null";
const closeIfOpen = (fd: number) => {
  try {
    NodeFS.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
  }
};

// Windows auto-closes the inherited fd; POSIX reopens it, leaving the original for the test to close.
const openBootstrapInputFd = (filePath: string) =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.openSync(filePath, "r")),
    (fd) => (windowsHost ? Effect.void : Effect.sync(() => closeIfOpen(fd))),
  );

const TestEnvelopeSchema = Schema.Struct({ mode: Schema.String });
const encodeTestEnvelopeSchema = Schema.encodeEffect(Schema.fromJsonString(TestEnvelopeSchema));

it.layer(NodeServices.layer)("readBootstrapEnvelope", (it) => {
  it.effect("reads a bootstrap envelope from a provided fd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });

      yield* fs.writeFileString(
        filePath,
        `${yield* encodeTestEnvelopeSchema({ mode: "desktop" })}\n`,
      );

      const fd = yield* openBootstrapInputFd(filePath);

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, { timeoutMs: 100 });
      assertSome(payload, {
        mode: "desktop",
      });
    }),
  );

  it.effect("falls back to reading the inherited fd when path duplication fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });

      yield* fs.writeFileString(
        filePath,
        `${yield* encodeTestEnvelopeSchema({ mode: "desktop" })}\n`,
      );

      // The fallback stream auto-closes asynchronously; a finalizer would race and cause EBADF.
      const fd = NodeFS.openSync(filePath, "r");

      openSyncInterceptor.failPath = `/proc/self/fd/${fd}`;
      try {
        const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
          timeoutMs: 100,
        }).pipe(Effect.provideService(HostProcess.Platform, "linux"));
        assertSome(payload, {
          mode: "desktop",
        });
      } finally {
        openSyncInterceptor.failPath = null;
      }
    }),
  );

  it.effect("returns none when the fd is unavailable", () =>
    Effect.gen(function* () {
      const fd = NodeFS.openSync(nullDevice, "r");
      NodeFS.closeSync(fd);

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, { timeoutMs: 100 });
      assertNone(payload);
    }),
  );
  it.effect("keeps a borrowed bootstrap pipe open until its parent ends it", () =>
    Effect.gen(function* () {
      const input = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeStream.PassThrough()),
        (input) => Effect.sync(() => input.destroy()),
      );
      input.write('{"mode":"desktop"}\n');

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, 0, { input });
      assertSome(payload, { mode: "desktop" });
      assert.equal(input.destroyed, false);

      // Bootstrap may already have resumed the pipe; wait for the lifetime listener installation.
      const listening = new Promise<void>((resolve) => input.once("newListener", () => resolve()));
      const lifetime = yield* waitForParentInputClose(input).pipe(Effect.forkChild);
      yield* Effect.promise(() => listening);
      assert.equal(lifetime.pollUnsafe(), undefined);

      input.end();
      yield* Fiber.join(lifetime);
      assert.equal(input.readableEnded, true);
    }),
  );

  it.effect("observes parent EOF that arrives between bootstrap and the lifetime listener", () =>
    Effect.gen(function* () {
      const input = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeStream.PassThrough()),
        (input) => Effect.sync(() => input.destroy()),
      );
      input.end('{"mode":"desktop"}\n');

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, 0, { input });
      assertSome(payload, { mode: "desktop" });
      yield* waitForParentInputClose(input);
      assert.equal(input.readableEnded, true);
    }),
  );

  it.effect("reports a broken parent pipe instead of leaving the server running", () =>
    Effect.gen(function* () {
      const input = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeStream.PassThrough()),
        (input) => Effect.sync(() => input.destroy()),
      );
      const listening = new Promise<void>((resolve) => input.once("resume", resolve));
      const lifetime = yield* waitForParentInputClose(input).pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => listening);
      const cause = new Error("parent pipe failed");
      input.destroy(cause);

      const error = yield* Fiber.join(lifetime);
      assert.equal(error._tag, "DesktopParentInputError");
      assert.equal(error.cause, cause);
    }),
  );

  it.effect("handles a pipe destroyed with an error before the lifetime listener starts", () =>
    Effect.gen(function* () {
      const input = new NodeStream.PassThrough();
      const cause = new Error("parent pipe failed during bootstrap");
      input.destroy(cause);

      const error = yield* waitForParentInputClose(input).pipe(Effect.flip);
      assert.equal(error._tag, "DesktopParentInputError");
      assert.equal(error.cause, cause);
    }),
  );
});
