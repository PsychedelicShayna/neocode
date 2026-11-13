import { EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

const { writeFile, confirmFile } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  confirmFile: vi.fn(),
}));
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: writeFile as never,
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const state = Atom.make(AsyncResult.initial<AuthSessionState>());
  return {
    ...actual,
    environmentSession: { ...actual.environmentSession, sessionStateAtom: () => state },
    readEnvironmentScope: () => true,
  };
});
vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  confirmProjectFileQueryData: confirmFile,
  getUnsavedProjectFileQueryData: () => null,
}));

import { changeFileSaveSession, useFileSaveSession } from "../files/fileSaveSessions";
import { useNativePendingFiles } from "./useNativePendingFiles";

const environmentId = EnvironmentId.make("native-file-save");
function setup() {
  writeFile.mockReset();
  confirmFile.mockReset();
  let current: ReturnType<typeof useNativePendingFiles> | undefined;
  function FilePanel({ path, tick }: { path: string; tick: number }) {
    const pending = useNativePendingFiles();
    useLayoutEffect(() => {
      current = pending;
    }, [pending]);
    useFileSaveSession(
      { environmentId, cwd: "/workspace", relativePath: path },
      pending.onPendingChange,
    );
    return <output>{tick}</output>;
  }
  const panel = (path: string, tick: number) => (
    <StrictMode>
      <FilePanel path={path} tick={tick} />
    </StrictMode>
  );
  return { panel, read: () => current! };
}

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
      const h = setup();
      let releaseFirst!: () => void;
      const firstWrite = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let disk = "";
      const writes: string[] = [];
      writeFile.mockImplementation((_registry, _command, { input }) => {
        writes.push(input.contents);
        if (input.contents === first) {
          return firstWrite.then(() => {
            disk = input.contents;
            return AsyncResult.success(undefined);
          });
        }
        disk = input.contents;
        return Promise.resolve(AsyncResult.success(undefined));
      });
      await using screen = await render(h.panel(path, 0));
      using _timers = fakeTimers();
      const target = { environmentId, cwd: "/workspace", relativePath: path };
      await act(() => changeFileSaveSession(target, first));
      expect(h.read().pendingFiles.has(path)).toBe(true);
      await act(() => vi.advanceTimersByTimeAsync(500));
      await act(() => changeFileSaveSession(target, latest));
      await screen.rerender(h.panel(path, 1));
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(h.read().pendingFiles.has(path)).toBe(true);
      expect(writes).toEqual([first]);
      await act(async () => {
        releaseFirst();
        await vi.runAllTimersAsync();
      });
      expect(writes).toEqual([first, latest]);
      expect(disk).toBe(latest);
      expect(h.read().pendingFiles.has(path)).toBe(false);
    },
  );
});
