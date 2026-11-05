// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("reads host files outside the workspace root by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "cleanup-report.md", "# Report\n");
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: absolutePath,
        });

        expect(result).toEqual({
          relativePath: absolutePath,
          contents: "# Report\n",
          byteLength: 9,
          truncated: false,
        });
      }),
    );

    // Needs mkfifo; Windows has no FIFOs to reject.
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "rejects a FIFO without blocking on open",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const fifoPath = path.join(outsideDir, "pipe");
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                NodeChildProcess.execFile("mkfifo", [fifoPath], (error) =>
                  error ? reject(error) : resolve(),
                ),
              ),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: fifoPath })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
          yield* fileSystem.symlink(
            path.join(outsideDir, "secret.txt"),
            path.join(cwd, "linked-secret.txt"),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: "linked-secret.txt" })
            .pipe(Effect.flip);
          const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
          const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(error).toMatchObject({
            workspaceRoot: cwd,
            relativePath: "linked-secret.txt",
            resolvedWorkspaceRoot,
            resolvedPath,
          });
          expect("cause" in error).toBe(false);
        }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("creates a plan without clobbering an existing file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "plans/plan.md", "# Existing work\n");

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "plans/plan.md",
            contents: "# New plan\n",
            mode: "create",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileAlreadyExistsError);
        expect(yield* fileSystem.readFileString(path.join(cwd, "plans/plan.md"))).toBe(
          "# Existing work\n",
        );
        expect(yield* fileSystem.readDirectory(path.join(cwd, "plans"))).toEqual(["plan.md"]);
      }),
    );

    it.effect("publishes a complete new plan and creates its parent directories", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const contents = "# Plan\n" + "Complete plan contents\n".repeat(4_096);

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/new/plan.md",
          contents,
          mode: "create",
        });

        expect(result).toEqual({ relativePath: "plans/new/plan.md" });
        expect(yield* fileSystem.readFileString(path.join(cwd, result.relativePath))).toBe(
          contents,
        );
        expect(yield* fileSystem.readDirectory(path.join(cwd, "plans/new"))).toEqual(["plan.md"]);
      }),
    );

    it.effect("allows only one concurrent creator of the same plan filename", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const plans = ["# First plan\n".repeat(4_096), "# Second plan\n".repeat(4_096)];

        const results = yield* Effect.all(
          plans.map((contents) =>
            workspaceFileSystem
              .writeFile({
                cwd,
                relativePath: "plans/plan.md",
                contents,
                mode: "create",
              })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );

        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        const failures = results.filter((result) => result._tag === "Failure");
        expect(failures).toHaveLength(1);
        expect(failures[0]?.failure).toBeInstanceOf(
          WorkspaceFileSystem.WorkspaceFileAlreadyExistsError,
        );
        const winnerIndex = results.findIndex((result) => result._tag === "Success");
        expect(yield* fileSystem.readFileString(path.join(cwd, "plans/plan.md"))).toBe(
          plans[winnerIndex],
        );
        expect(yield* fileSystem.readDirectory(path.join(cwd, "plans"))).toEqual(["plan.md"]);
      }),
    );

    it.effect("atomically replaces a plan only when replacement is explicitly requested", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "plan.md", "# Existing\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plan.md",
          contents: "# Replacement\n",
          mode: "replace",
        });

        expect(yield* fileSystem.readFileString(path.join(cwd, "plan.md"))).toBe("# Replacement\n");
        expect(yield* fileSystem.readDirectory(cwd)).toEqual(["plan.md"]);
      }),
    );

    it.effect("preserves the editor's intentional in-place overwrite behavior", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "# Existing\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "notes.md",
          contents: "# Edited\n",
        });

        expect(yield* fileSystem.readFileString(path.join(cwd, "notes.md"))).toBe("# Edited\n");
      }),
    );

    it.effect.skipIf(!symlinksSupported)("does not follow an existing plan symlink on create", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "original.md", "# Original\n");
        yield* fileSystem.symlink(path.join(cwd, "original.md"), path.join(cwd, "plan.md"));

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "plan.md",
            contents: "# New plan\n",
            mode: "create",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileAlreadyExistsError);
        expect(yield* fileSystem.readFileString(path.join(cwd, "original.md"))).toBe(
          "# Original\n",
        );
        expect(yield* fileSystem.realPath(path.join(cwd, "plan.md"))).toBe(
          yield* fileSystem.realPath(path.join(cwd, "original.md")),
        );
      }),
    );

    it.effect("rejects writes by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: absolutePath, contents: "# Edited\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );
  });
});
