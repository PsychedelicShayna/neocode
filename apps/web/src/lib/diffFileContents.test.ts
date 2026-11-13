import type { FileDiffMetadata } from "@pierre/diffs";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ReviewDiffFileContentsResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createGitDiffFileContentsLoader,
  createNativeDiffFileContentsLoader,
} from "./diffFileContents";

const SOURCE = {
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/workspace",
  sourceKind: "branch-range" as const,
  baseRef: "main",
  headRef: "feature",
  cacheKey: "comparison-1",
};

function fileDiff(type: FileDiffMetadata["type"] = "rename-changed"): FileDiffMetadata {
  return {
    type,
    prevName: "src/old-name.ts",
    name: "src/new-name.ts",
  } as FileDiffMetadata;
}

describe("createGitDiffFileContentsLoader", () => {
  it("loads a pure rename from its one shared file", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "same\n", newContents: "same\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff("rename-pure"))).resolves.toMatchObject({
      oldFile: null,
      newFile: { name: "src/new-name.ts", contents: "same\n" },
    });
  });

  it("passes command failures through to Pierre's expansion handling", async () => {
    const failure = new Error("revision is not available locally");
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.failure<ReviewDiffFileContentsResult, Error>(Cause.fail(failure)),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).rejects.toBe(failure);
  });
});

describe("createNativeDiffFileContentsLoader", () => {
  const source = {
    environmentId: SOURCE.environmentId,
    ref: {
      providerInstanceId: ProviderInstanceId.make("neopi"),
      sessionFile: "/sessions/first.jsonl",
    },
    sourceKind: SOURCE.sourceKind,
    baseRef: SOURCE.baseRef,
    headRef: SOURCE.headRef,
    cacheKey: SOURCE.cacheKey,
  };

  it("keeps identical patches in different native workspaces out of Pierre's hydrated cache", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const sources = [
      source,
      { ...source, environmentId: EnvironmentId.make("environment-2") },
      {
        ...source,
        ref: { ...source.ref, providerInstanceId: ProviderInstanceId.make("other-neopi") },
      },
      { ...source, ref: { ...source.ref, sessionFile: "/sessions/second.jsonl" } },
      { ...source, baseRef: "release" },
    ];
    const loaded = await Promise.all(
      sources.map((entry) =>
        createNativeDiffFileContentsLoader(getDiffFileContents, entry)(fileDiff()),
      ),
    );
    expect(new Set(loaded.map((files) => files.newFile?.cacheKey)).size).toBe(sources.length);
    expect(new Set(loaded.map((files) => files.oldFile?.cacheKey)).size).toBe(sources.length);
    expect(loaded[0]?.newFile?.contents).toBe("after\n");
    expect(loaded[0]?.oldFile?.contents).toBe("before\n");
  });

  it("preserves native authorization failures during unchanged-context expansion", async () => {
    const failure = new Error("Native session workspace is unavailable.");
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.failure<ReviewDiffFileContentsResult, Error>(Cause.fail(failure)),
    );
    const load = createNativeDiffFileContentsLoader(getDiffFileContents, source);

    await expect(load(fileDiff())).rejects.toBe(failure);
  });
});
