import type {
  NeoPiNativeSessionsGetBranchCommitsInput,
  NeoPiNativeSessionsGetDiffFileContentsInput,
  NeoPiNativeSessionsGetDiffPreviewInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ReviewService } from "../../review/ReviewService.ts";
import { NeoPiNativeSessions } from "./NeoPiNativeSessions.ts";

/** Review authority comes from the configured native session, without opening a process or SQL thread. */
export const makeNeoPiNativeReview = Effect.gen(function* () {
  const sessions = yield* NeoPiNativeSessions;
  const review = yield* ReviewService;

  const getBranchCommits = Effect.fn("NeoPiNativeReview.getBranchCommits")(function* (
    input: NeoPiNativeSessionsGetBranchCommitsInput,
  ) {
    const { ref, ...selectors } = input;
    const workspace = yield* sessions.resolveWorkspace(ref);
    return yield* review.getBranchCommits(
      { ...selectors, cwd: workspace.cwd },
      { workspaceRoot: workspace.cwd },
    );
  });

  const getDiffPreview = Effect.fn("NeoPiNativeReview.getDiffPreview")(function* (
    input: NeoPiNativeSessionsGetDiffPreviewInput,
  ) {
    const { ref, ...selectors } = input;
    const workspace = yield* sessions.resolveWorkspace(ref);
    return yield* review.getDiffPreview(
      { ...selectors, cwd: workspace.cwd },
      { workspaceRoot: workspace.cwd },
    );
  });

  const getDiffFileContents = Effect.fn("NeoPiNativeReview.getDiffFileContents")(function* (
    input: NeoPiNativeSessionsGetDiffFileContentsInput,
  ) {
    const { ref, ...selectors } = input;
    const workspace = yield* sessions.resolveWorkspace(ref);
    return yield* review.getDiffFileContents(
      { ...selectors, cwd: workspace.cwd },
      { workspaceRoot: workspace.cwd },
    );
  });

  return { getBranchCommits, getDiffPreview, getDiffFileContents };
});
