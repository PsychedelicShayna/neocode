import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  EnvironmentId,
  NeoPiNativeSessionRef,
  NeoPiNativeSessionsGetDiffPreviewInput,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { useContext, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { getRenderablePatch, resolveFileDiffPath, type RenderablePatch } from "~/lib/diffRendering";
import { reviewEnvironment } from "~/state/review";

const filePathCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const INITIAL_FILE_COUNT = 4;

export function useReviewFilePatches({
  environmentId,
  cwd,
  nativeRef,
  source,
  baseRef,
  ignoreWhitespace,
  theme,
  previewInput,
  preview,
}: {
  environmentId: EnvironmentId | undefined;
  cwd: string | undefined;
  nativeRef?: NeoPiNativeSessionRef;
  source: ReviewDiffPreviewSource | null;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  theme: "light" | "dark";
  /** The preview the file list came from; a newer revision of it refreshes loaded patches. */
  previewInput: ReviewDiffPreviewInput | NeoPiNativeSessionsGetDiffPreviewInput | undefined;
  preview: RenderablePatch | null;
}) {
  const registry = useContext(RegistryContext);
  const scope = JSON.stringify([
    environmentId,
    cwd,
    nativeRef?.providerInstanceId,
    nativeRef?.sessionFile,
    source?.kind,
    source?.baseRef,
    source?.headRef,
    baseRef,
    ignoreWhitespace,
  ]);
  const files = sortedReviewFiles(source);
  const automaticPaths = files.slice(0, INITIAL_FILE_COUNT).map((file) => file.path);
  const [requested, setRequested] = useState(() => ({ scope, paths: automaticPaths }));
  const previousPaths = requested.scope === scope ? requested.paths : [];
  const paths = [...new Set([...previousPaths, ...automaticPaths])];
  if (requested.scope !== scope || paths.length !== previousPaths.length) {
    setRequested({ scope, paths });
  }
  const queries = reviewFileQueries({
    environmentId,
    cwd,
    nativeRef,
    source,
    baseRef,
    ignoreWhitespace,
    previewInput,
    scope,
    requested,
  });
  const queriedPatchesAtom = reviewPatchesAtom(
    JSON.stringify([theme, queries.map(({ index, target }) => [index, target])]),
  );
  const patches = useAtomValue(queriedPatchesAtom);
  const retry = useStableCallback((path: string) => {
    const files = sortedReviewFiles(source);
    const query = queries.find(({ index }) => files[index]?.path === path)?.query;
    if (query) registry.refresh(query);
  });
  const pendingIndex = files.findIndex((_, index) => {
    const patch = patches.get(index);
    return !patch || patch._tag === "Initial";
  });
  const settledFileCount = source
    ? pendingIndex < 0
      ? files.length
      : pendingIndex
    : preview?.kind === "files"
      ? preview.files.length
      : 0;
  const requestFiles = (indices: number[]) =>
    setRequested((current) => {
      const previous = current.scope === scope ? current.paths : [];
      const added = indices.flatMap((index) => {
        const path = files[index]?.path;
        return path !== undefined && !previous.includes(path) ? [path] : [];
      });
      return added.length === 0 ? current : { scope, paths: [...previous, ...added] };
    });
  // The first unsettled file already requested means a batch is in flight; wait for it.
  const loadNextFiles = () => {
    if (queries.some(({ index }) => index === settledFileCount)) return;
    requestFiles(Array.from({ length: 4 }, (_, index) => settledFileCount + index));
  };
  const requestFile = (path: string) =>
    requestFiles([files.findIndex((file) => file.path === path)]);
  const renderableFiles = source
    ? files.flatMap((file, index): FileDiffMetadata[] => {
        const result = patches.get(index);
        const value = result && Option.getOrUndefined(AsyncResult.value(result));
        if (value?.patch?.kind === "files") {
          const loaded = value.patch.files.filter(
            (candidate) => resolveFileDiffPath(candidate) === file.path,
          );
          if (loaded.length > 0) return loaded;
        }
        return [
          {
            name: file.path,
            ...(file.previousPath ? { prevName: file.previousPath } : {}),
            type: file.previousPath ? "rename-changed" : "change",
            hunks: [],
            additionLines: [],
            deletionLines: [],
            additionCharacterCount: 0,
            deletionCharacterCount: 0,
            splitLineCount: 0,
            unifiedLineCount: 0,
            isPartial: true,
            cacheKey: `${scope}:${file.path}:pending`,
          },
        ];
      })
    : (preview?.kind === "files" ? preview.files : []).toSorted((a, b) =>
        filePathCollator.compare(resolveFileDiffPath(a), resolveFileDiffPath(b)),
      );
  const fileStates = new Map(
    files.map((file, index) => {
      const patch = patches.get(index);
      return [
        file.path,
        {
          error:
            patch?._tag === "Failure" ||
            (patch?._tag === "Success" &&
              (patch.value.patch?.kind !== "files" ||
                !patch.value.patch.files.some(
                  (candidate) => resolveFileDiffPath(candidate) === file.path,
                ))),
          truncated: patch?._tag === "Success" && patch.value.source.truncated,
        },
      ] as const;
    }),
  );
  return {
    fileStates,
    isPending: [...patches.values()].some((patch) => patch._tag === "Initial" || patch.waiting),
    retry,
    requestFile,
    renderableFiles,
    remainingFileCount: source ? files.length - settledFileCount : 0,
    loadNextFiles,
  };
}

function reviewFileQueries({
  environmentId,
  cwd,
  nativeRef,
  source,
  baseRef,
  ignoreWhitespace,
  previewInput,
  scope,
  requested,
}: {
  environmentId: EnvironmentId | undefined;
  cwd: string | undefined;
  nativeRef: NeoPiNativeSessionRef | undefined;
  source: ReviewDiffPreviewSource | null;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  previewInput: ReviewDiffPreviewInput | NeoPiNativeSessionsGetDiffPreviewInput | undefined;
  scope: string;
  requested: { scope: string; paths: string[] };
}) {
  const files = sortedReviewFiles(source);
  const paths = new Set([
    ...files.slice(0, INITIAL_FILE_COUNT).map((file) => file.path),
    ...(requested.scope === scope ? requested.paths : []),
  ]);
  if (!environmentId || (!nativeRef && !cwd) || !source) return [];
  const nativePreview = previewInput && "ref" in previewInput ? previewInput : undefined;
  const workspacePreview = previewInput && "cwd" in previewInput ? previewInput : undefined;
  return files
    .flatMap((file, index) => (paths.has(file.path) ? [{ file, index }] : []))
    .map(({ file, index }) => {
      const request = {
        ...(baseRef ? { baseRef } : {}),
        ...(source.kind === "commit" ? { commitSha: source.id } : {}),
        ignoreWhitespace,
        file: {
          path: file.path,
          previousPath: file.previousPath,
          sourceKind: source.kind,
        },
      };
      const target: ReviewPatchTarget = nativeRef
        ? {
            kind: "native",
            args: {
              environmentId,
              input: {
                cacheKey: scope,
                ...(nativePreview ? { preview: nativePreview } : {}),
                request: { ref: nativeRef, ...request },
              },
            },
          }
        : {
            kind: "workspace",
            args: {
              environmentId,
              input: {
                cacheKey: scope,
                ...(workspacePreview ? { preview: workspacePreview } : {}),
                request: { cwd: cwd!, ...request },
              },
            },
          };
      return { index, target, query: reviewPatchQuery(target) };
    });
}

function sortedReviewFiles(source: ReviewDiffPreviewSource | null) {
  return source?.files?.toSorted((a, b) => filePathCollator.compare(a.path, b.path)) ?? [];
}

type ReviewPatchTarget =
  | { kind: "native"; args: Parameters<typeof reviewEnvironment.nativeDiffFilePatch>[0] }
  | { kind: "workspace"; args: Parameters<typeof reviewEnvironment.diffFilePatch>[0] };

function reviewPatchQuery(target: ReviewPatchTarget) {
  return target.kind === "native"
    ? reviewEnvironment.nativeDiffFilePatch(target.args)
    : reviewEnvironment.diffFilePatch(target.args);
}

const parsedPatchAtom = Atom.family((key: string) => {
  const [theme, target] = JSON.parse(key) as ["light" | "dark", ReviewPatchTarget];
  const renderCacheScope =
    target.kind === "native"
      ? `diff-panel:${theme}:${target.args.input.cacheKey}`
      : `diff-panel:${theme}`;
  return Atom.map(reviewPatchQuery(target), (result) =>
    AsyncResult.map(result, (source) => {
      let patch = getRenderablePatch(source.diff, renderCacheScope, {
        compactPartialHunkOffsets: true,
      });
      if (patch?.kind === "files" && patch.files.length === 1 && source.files?.length === 1) {
        const stat = source.files[0]!;
        const file = { ...patch.files[0]!, name: stat.path };
        if (stat.previousPath !== null) file.prevName = stat.previousPath;
        else delete file.prevName;
        patch = { ...patch, files: [file] };
      }
      return { source, patch };
    }),
  );
});

const reviewPatchesAtom = Atom.family((key: string) => {
  const [theme, entries] = JSON.parse(key) as [
    "light" | "dark",
    ReadonlyArray<readonly [number, ReviewPatchTarget]>,
  ];
  const parsed = entries.map(
    ([index, target]) => [index, parsedPatchAtom(JSON.stringify([theme, target]))] as const,
  );
  return Atom.make((get) => new Map(parsed.map(([index, atom]) => [index, get(atom)])));
});
