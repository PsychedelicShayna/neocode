import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  confirmFile: vi.fn(),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("../files/projectFilesQueryState", () => ({ confirmProjectFileQueryData: confirmFile }));

import { useFileSaveCoordinator } from "../files/useFileSaveCoordinator";
import { useNativePendingFiles } from "./useNativePendingFiles";

const environmentId = EnvironmentId.make("native-file-save");
let renderer: ReactTestRenderer | null = null;

function Probe(_props: {
  change: (contents: string) => void;
  onPendingChange: (path: string, pending: boolean) => void;
  pendingFiles: ReadonlySet<string>;
  tick: number;
}) {
  return null;
}

function FilePanel({ path, tick }: { path: string; tick: number }) {
  const { pendingFiles, onPendingChange } = useNativePendingFiles();
  const coordinator = useFileSaveCoordinator({
    environmentId,
    cwd: "/workspace",
    relativePath: path,
    onPendingChange,
  });
  return (
    <Probe
      change={coordinator.change}
      onPendingChange={onPendingChange}
      pendingFiles={pendingFiles}
      tick={tick}
    />
  );
}

function renderPanel(path: string, tick: number) {
  const panel = (
    <StrictMode>
      <FilePanel path={path} tick={tick} />
    </StrictMode>
  );
  if (renderer) renderer.update(panel);
  else renderer = create(panel);
}

function probe() {
  return renderer!.root.findByType(Probe).props as Parameters<typeof Probe>[0];
}

beforeEach(() => {
  renderer = null;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockReset();
  confirmFile.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native file pending state", () => {
  it.each([
    { path: "file.ts", first: "const value = 1;", latest: "const value = 2;" },
    {
      path: "README.md",
      first: "- [x] first\n- [ ] second\n",
      latest: "- [x] first\n- [x] second\n",
    },
  ])(
    "keeps $path saves ordered across pending and streamed rerenders",
    async ({ path, first, latest }) => {
      let releaseFirst!: () => void;
      const firstWrite = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let disk = "";
      writeFile.mockImplementation(({ input }) => {
        if (input.contents === first) {
          return firstWrite.then(() => {
            disk = input.contents;
            return AsyncResult.success(undefined);
          });
        }
        // If a second coordinator writes concurrently, this newer save completes first.
        disk = input.contents;
        return Promise.resolve(AsyncResult.success(undefined));
      });

      act(() => renderPanel(path, 0));
      const handler = probe().onPendingChange;
      act(() => probe().change(first));
      expect(probe().pendingFiles.has(path)).toBe(true);
      expect(probe().onPendingChange).toBe(handler);
      expect(writeFile).not.toHaveBeenCalled();

      const pending = probe().pendingFiles;
      act(() => handler(path, true));
      expect(probe().pendingFiles).toBe(pending);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(writeFile).toHaveBeenCalledTimes(1);

      act(() => {
        probe().change(latest);
        renderPanel(path, 1);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(probe().onPendingChange).toBe(handler);
      expect(probe().pendingFiles.has(path)).toBe(true);
      expect(writeFile).toHaveBeenCalledTimes(1);

      await act(async () => {
        releaseFirst();
        await vi.runAllTimersAsync();
      });
      expect(writeFile).toHaveBeenCalledTimes(2);
      expect(writeFile.mock.calls.map(([request]) => request.input.contents)).toEqual([
        first,
        latest,
      ]);
      expect(disk).toBe(latest);
      expect(confirmFile.mock.calls.map((call) => call[3])).toEqual([first, latest]);
      expect(probe().pendingFiles.has(path)).toBe(false);
    },
  );
});
