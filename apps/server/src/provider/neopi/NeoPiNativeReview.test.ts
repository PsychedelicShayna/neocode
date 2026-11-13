import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NeoPiNativeSessionsError,
  NeoPiNativeSessionsGetBranchCommitsInput,
  NeoPiNativeSessionsGetDiffFileContentsInput,
  NeoPiNativeSessionsGetDiffPreviewInput,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import * as ReviewService from "../../review/ReviewService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { makeNeoPiNativeReview } from "./NeoPiNativeReview.ts";
import {
  makeNeoPiNativeSessionsWith,
  NeoPiNativeSessions,
  type NeoPiNativeProfile,
} from "./NeoPiNativeSessions.ts";

const decodePreviewInput = Schema.decodeUnknownEffect(NeoPiNativeSessionsGetDiffPreviewInput);
const decodeContentsInput = Schema.decodeUnknownEffect(NeoPiNativeSessionsGetDiffFileContentsInput);
const decodeCommitsInput = Schema.decodeUnknownEffect(NeoPiNativeSessionsGetBranchCommitsInput);

const TestLayer = ReviewService.layer.pipe(
  Layer.provide(
    KnownWorkspaces.layer.pipe(
      Layer.provide(ProjectStore.layer),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSettings.layerTest()),
    ),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-native-review-config-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const contentsSelectors = {
  sourceKind: "working-tree",
  changeType: "change",
  baseRef: "HEAD",
  headRef: null,
  oldPath: "file.txt",
  newPath: "file.txt",
} as const;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-review-" });
  const cwd = path.join(directory, "workspace");
  const cwdAlias = path.join(directory, "workspace-alias");
  const sessionFile = path.join(directory, "session.jsonl");
  const sessionAlias = path.join(directory, "session-alias.jsonl");
  const unavailableFile = path.join(directory, "unavailable.jsonl");
  yield* fs.makeDirectory(cwd);
  yield* fs.writeFileString(sessionFile, "native catalog identity\n");
  yield* fs.writeFileString(unavailableFile, "not in the configured catalog\n");
  yield* fs.symlink(cwd, cwdAlias);
  yield* fs.symlink(sessionFile, sessionAlias);
  const runGit = (args: ReadonlyArray<string>) =>
    git.execute({ operation: "NeoPiNativeReview.test", cwd, args });
  yield* runGit(["init"]);
  yield* runGit(["config", "user.name", "Native Review Test"]);
  yield* runGit(["config", "user.email", "native-review@example.com"]);
  yield* fs.writeFileString(path.join(cwd, "file.txt"), "before\nunchanged context\n");
  yield* fs.writeFileString(path.join(cwd, "other.txt"), "other before\n");
  yield* runGit(["add", "file.txt", "other.txt"]);
  yield* runGit(["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
  yield* fs.writeFileString(path.join(cwd, "file.txt"), "after\nunchanged context\n");
  yield* fs.writeFileString(path.join(cwd, "other.txt"), "other after\n");

  const providerInstanceId = ProviderInstanceId.make("native-review-profile");
  const authority = { profileValid: true, starts: 0 };
  const profile: NeoPiNativeProfile = {
    providerInstanceId,
    source: {
      binary: "/unused/native-review-must-not-start",
      env: {},
      profile: "native-review",
      capabilities: new Set(["session_catalog"]),
      probe: { status: "compatible", version: "fixture" },
    },
    validate: Effect.suspend(() =>
      authority.profileValid
        ? Effect.void
        : Effect.fail(
            new NeoPiNativeSessionsError({ code: "profile_changed", message: "Profile replaced" }),
          ),
    ),
  };
  const sessions = yield* makeNeoPiNativeSessionsWith({
    profileIds: Effect.succeed([providerInstanceId]),
    profile: (id) =>
      id === providerInstanceId
        ? Effect.succeed(profile)
        : Effect.fail(
            new NeoPiNativeSessionsError({
              code: "profile_unavailable",
              message: "Unknown profile",
            }),
          ),
    canonicalize: (value) =>
      fs.realPath(value).pipe(
        Effect.mapError(
          () =>
            new NeoPiNativeSessionsError({
              code: "invalid_path",
              message: "Invalid native path",
            }),
        ),
      ),
    preparePrompt: () => Effect.die("Review must not prepare a native prompt"),
    catalog: () =>
      Effect.succeed([
        {
          path: sessionFile,
          id: "native-review-session",
          cwd: cwdAlias,
          title: null,
          firstMessage: "",
          modified: "2026-10-29T00:00:00Z",
          inUse: null,
          control: null,
        },
      ]),
    connect: () => {
      authority.starts++;
      return Effect.die("Review must not start or attach a native process");
    },
  });
  const review = yield* makeNeoPiNativeReview.pipe(
    Effect.provideService(NeoPiNativeSessions, sessions),
  );
  return {
    review,
    authority,
    cwd: yield* fs.realPath(cwd),
    ref: { providerInstanceId, sessionFile: sessionAlias },
    unavailableFile,
  };
});

describe("NeoPiNativeReview", () => {
  it.effect(
    "reviews a canonical native workspace outside startup roots without opening a session",
    () =>
      Effect.gen(function* () {
        const { review, authority, cwd, ref } = yield* fixture;
        const generic = yield* ReviewService.ReviewService;
        const previewInput = yield* decodePreviewInput({
          ref,
          cwd: process.cwd(),
          workspaceRoot: process.cwd(),
        });
        const preview = yield* review.getDiffPreview(previewInput);
        assert.equal(preview.cwd, cwd);
        const workingTree = preview.sources.find((source) => source.kind === "working-tree");
        assert.isDefined(workingTree);
        assert.match(workingTree!.diff, /\+after/);
        assert.match(workingTree!.diff, /-before/);
        assert.match(workingTree!.diff, /\+other after/);

        const patch = yield* review.getDiffPreview({
          ref,
          file: { path: "file.txt", previousPath: null, sourceKind: "working-tree" },
        });
        const filePatch = patch.sources.find((source) => source.kind === "working-tree")!.diff;
        assert.match(filePatch, /\+after/);
        assert.notMatch(filePatch, /other\.txt|\+other after/);
        const contentsInput = yield* decodeContentsInput({
          ref,
          ...contentsSelectors,
          cwd: process.cwd(),
        });
        assert.deepEqual(yield* review.getDiffFileContents(contentsInput), {
          oldContents: "before\nunchanged context\n",
          newContents: "after\nunchanged context\n",
        });

        // A successful native review does not add its root to generic review authority.
        const genericPreview = yield* generic.getDiffPreview({ cwd }).pipe(Effect.flip);
        const genericContents = yield* generic
          .getDiffFileContents({ cwd, ...contentsSelectors })
          .pipe(Effect.flip);
        assert.equal(genericPreview._tag, "VcsRepositoryDetectionError");
        assert.equal(genericContents._tag, "VcsRepositoryDetectionError");
        const git = yield* GitVcsDriver.GitVcsDriver;
        const base = (yield* git.execute({
          operation: "NeoPiNativeReview.test",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim();
        yield* git.execute({
          operation: "NeoPiNativeReview.test",
          cwd,
          args: ["add", "file.txt", "other.txt"],
        });
        yield* git.execute({
          operation: "NeoPiNativeReview.test",
          cwd,
          args: ["-c", "commit.gpgsign=false", "commit", "-m", "Native review edit"],
        });
        const commits = yield* review.getBranchCommits({ ref, baseRef: base });
        assert.deepEqual(
          commits.commits.map((commit) => commit.subject),
          ["Native review edit"],
        );
        const genericCommits = yield* generic
          .getBranchCommits({ cwd, baseRef: base })
          .pipe(Effect.flip);
        assert.equal(genericCommits._tag, "VcsRepositoryDetectionError");
        assert.equal(authority.starts, 0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "refuses unavailable sessions, invalid paths and other profiles for native review operations",
    () =>
      Effect.gen(function* () {
        const { review, authority, ref, unavailableFile, cwd } = yield* fixture;
        for (const invalidRef of [
          { ...ref, sessionFile: unavailableFile },
          { ...ref, sessionFile: `${unavailableFile}.missing` },
          { ...ref, providerInstanceId: ProviderInstanceId.make("unconfigured") },
        ]) {
          const input = yield* decodePreviewInput({
            ref: invalidRef,
            cwd,
            workspaceRoot: cwd,
          });
          const preview = yield* review.getDiffPreview(input).pipe(Effect.flip);
          const contents = yield* review
            .getDiffFileContents({ ref: invalidRef, ...contentsSelectors })
            .pipe(Effect.flip);
          assert.equal(preview._tag, "NeoPiNativeSessionsError");
          assert.equal(contents._tag, "NeoPiNativeSessionsError");
          const commits = yield* review.getBranchCommits({ ref: invalidRef }).pipe(Effect.flip);
          assert.equal(commits._tag, "NeoPiNativeSessionsError");
        }
        authority.profileValid = false;
        const preview = yield* review.getDiffPreview({ ref }).pipe(Effect.flip);
        const contents = yield* review
          .getDiffFileContents({ ref, ...contentsSelectors })
          .pipe(Effect.flip);
        assert.equal(preview._tag, "NeoPiNativeSessionsError");
        assert.equal(contents._tag, "NeoPiNativeSessionsError");
        const commits = yield* review.getBranchCommits({ ref }).pipe(Effect.flip);
        assert.equal(commits._tag, "NeoPiNativeSessionsError");
        if (preview._tag === "NeoPiNativeSessionsError")
          assert.equal(preview.code, "profile_changed");
        if (contents._tag === "NeoPiNativeSessionsError")
          assert.equal(contents.code, "profile_changed");
        assert.equal(authority.starts, 0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "requires native identity and preserves required file-content selectors on the wire",
    () =>
      Effect.gen(function* () {
        const missingCommitRef = yield* decodeCommitsInput({ cwd: process.cwd() }).pipe(
          Effect.result,
        );
        assert.equal(missingCommitRef._tag, "Failure");
        const missingRef = yield* decodePreviewInput({
          cwd: process.cwd(),
        }).pipe(Effect.result);
        const malformedRef = yield* decodePreviewInput({
          ref: { sessionFile: "/arbitrary/session.jsonl" },
        }).pipe(Effect.result);
        const missingSelectors = yield* decodeContentsInput({
          ref: { providerInstanceId: "native-review-profile", sessionFile: "/session.jsonl" },
        }).pipe(Effect.result);
        assert.equal(missingRef._tag, "Failure");
        assert.equal(malformedRef._tag, "Failure");
        assert.equal(missingSelectors._tag, "Failure");
      }),
  );
});
