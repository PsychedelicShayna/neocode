import { scopeThreadRef, scopedThreadKey, workspaceKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedTerminalUiStateStoreState,
  selectThreadTerminalUiState,
  useTerminalUiStateStore,
} from "./terminalUiStateStore";
import { DEFAULT_THREAD_TERMINAL_ID } from "./types";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef("environment-a" as never, THREAD_ID);
const OTHER_THREAD_REF = scopeThreadRef("environment-b" as never, THREAD_ID);

describe("terminalUiStateStore actions", () => {
  beforeEach(() => {
    useTerminalUiStateStore.persist.clearStorage();
    useTerminalUiStateStore.setState({
      terminalUiStateByThreadKey: {},
      suppressedTerminalIdsByThreadKey: {},
    });
  });

  it.each(["horizontal", "vertical"] as const)(
    "returns a %s panel split as one drawer group with its active terminal",
    (splitDirection) => {
      const store = useTerminalUiStateStore.getState();
      store.newTerminal(THREAD_REF, "existing");
      store.newTerminal(THREAD_REF, "a");
      store.closeTerminal(THREAD_REF, "b");
      store.closeTerminal(THREAD_REF, "unrelated-closed");
      store.setTerminalHeight(THREAD_REF, 420);
      const group = { id: "returned-panel", terminalIds: ["a", "b"], splitDirection };
      store.returnTerminalGroup(THREAD_REF, group, "b");
      store.returnTerminalGroup(THREAD_REF, group, "b");
      store.reconcileTerminalIds(THREAD_REF, ["existing", "a", "b", "unrelated-closed"]);

      const state = useTerminalUiStateStore.getState();
      const ui = selectThreadTerminalUiState(state.terminalUiStateByThreadKey, THREAD_REF);
      expect(ui).toMatchObject({
        terminalOpen: true,
        terminalHeight: 420,
        terminalIds: ["existing", "a", "b"],
        activeTerminalId: "b",
        activeTerminalGroupId: group.id,
      });
      expect(ui.terminalGroups).toHaveLength(2);
      expect(ui.terminalGroups[0]?.terminalIds).toEqual(["existing"]);
      expect(ui.terminalGroups[1]).toMatchObject({
        id: group.id,
        terminalIds: ["a", "b"],
        ...(splitDirection === "vertical" ? { splitDirection } : {}),
      });
      expect(ui.terminalGroups[1]?.splitDirection ?? "horizontal").toBe(splitDirection);
      expect(state.suppressedTerminalIdsByThreadKey[scopedThreadKey(THREAD_REF)]).toEqual([
        "unrelated-closed",
      ]);
      expect(
        selectThreadTerminalUiState(state.terminalUiStateByThreadKey, OTHER_THREAD_REF).terminalIds,
      ).toEqual([]);
    },
  );

  it("isolates native layouts and close tombstones by environment, provider and canonical file", () => {
    const target = {
      environmentId: EnvironmentId.make("environment-a"),
      ref: {
        providerInstanceId: ProviderInstanceId.make("neopi-a"),
        sessionFile: "/sessions/current.jsonl",
      },
    };
    const otherTargets = [
      { ...target, environmentId: EnvironmentId.make("environment-b") },
      { ...target, ref: { ...target.ref, providerInstanceId: ProviderInstanceId.make("neopi-b") } },
      { ...target, ref: { ...target.ref, sessionFile: "/sessions/other.jsonl" } },
      THREAD_REF,
    ];
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(target, "terminal-1");
    store.splitTerminalVertical(target, "terminal-2");
    store.setTerminalHeight(target, 420);
    for (const other of otherTargets) store.newTerminal(other, "terminal-2");
    store.closeTerminal(target, "terminal-2");
    store.reconcileTerminalIds(target, ["terminal-1", "terminal-2"]);
    for (const other of otherTargets) store.reconcileTerminalIds(other, ["terminal-2"]);

    const states = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
    expect(selectThreadTerminalUiState(states, target)).toMatchObject({
      terminalHeight: 420,
      terminalIds: ["terminal-1"],
      activeTerminalId: "terminal-1",
    });
    for (const other of otherTargets) {
      expect(selectThreadTerminalUiState(states, other).terminalIds).toEqual(["terminal-2"]);
    }
    store.ensureTerminal(target, "terminal-2", { open: true });
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        target,
      ).activeTerminalId,
    ).toBe("terminal-2");
  });

  it("retains native layout across persistence and SQL-only orphan cleanup", () => {
    const target = {
      environmentId: EnvironmentId.make("environment-a"),
      ref: {
        providerInstanceId: ProviderInstanceId.make("neopi-a"),
        sessionFile: "/sessions/current.jsonl",
      },
    };
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(target, "native-shell");
    store.newTerminal(THREAD_REF, "legacy-shell");
    store.removeOrphanedTerminalUiStates(new Set());
    const states = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
    expect(selectThreadTerminalUiState(states, target).terminalIds).toEqual(["native-shell"]);
    expect(selectThreadTerminalUiState(states, THREAD_REF).terminalIds).toEqual([]);
    const migrated = migratePersistedTerminalUiStateStoreState(
      {
        terminalUiStateByThreadKey: states,
      },
      4,
    );
    expect(migrated.terminalUiStateByThreadKey?.[workspaceKey(target)]?.terminalIds).toEqual([
      "native-shell",
    ]);
    store.removeTerminalUiState(target);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        target,
      ).terminalIds,
    ).toEqual([]);
  });

  it("returns an empty default terminal UI state for unknown threads", () => {
    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState).toEqual({
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: [],
      activeTerminalId: "",
      terminalGroups: [],
      activeTerminalGroupId: "",
    });
  });

  it("opens and splits terminals into the active group", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.splitTerminal(THREAD_REF, "terminal-2");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalOpen).toBe(true);
    expect(terminalUiState.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "terminal-2"]);
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "terminal-2"],
      },
    ]);
  });

  it("stacks vertically split terminals in the active group", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.splitTerminalVertical(THREAD_REF, "terminal-2");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "terminal-2"],
        splitDirection: "vertical",
      },
    ]);
  });

  it("materializes the default terminal when opening an empty drawer", () => {
    useTerminalUiStateStore.getState().setTerminalOpen(THREAD_REF, true);

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState).toEqual({
      terminalOpen: true,
      terminalHeight: 280,
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      terminalGroups: [
        {
          id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
          terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
        },
      ],
      activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
    });
  });

  it("caps splits at four terminals per group", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.splitTerminal(THREAD_REF, "terminal-4");
    store.splitTerminal(THREAD_REF, "terminal-5");
    store.splitTerminal(THREAD_REF, "terminal-6");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual([
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
    ]);
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: "group-terminal-2",
        terminalIds: ["terminal-2", "terminal-3", "terminal-4", "terminal-5"],
      },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalUiStateStore.getState().newTerminal(THREAD_REF, "terminal-2");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual(["terminal-2"]);
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("ensures unknown server terminals are registered, opened, and activated", () => {
    const store = useTerminalUiStateStore.getState();
    store.ensureTerminal(THREAD_REF, "setup-setup", { open: true, active: true });

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalOpen).toBe(true);
    expect(terminalUiState.terminalIds).toEqual(["setup-setup"]);
    expect(terminalUiState.activeTerminalId).toBe("setup-setup");
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-setup-setup", terminalIds: ["setup-setup"] },
    ]);
  });

  it("keeps state isolated per environment when raw thread ids collide", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.newTerminal(OTHER_THREAD_REF, "env-b-terminal");

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalOpen,
    ).toBe(true);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        OTHER_THREAD_REF,
      ).terminalIds,
    ).toEqual(["env-b-terminal"]);
  });

  it("drops persisted entries whose thread keys are not valid scoped keys", () => {
    const migrated = migratePersistedTerminalUiStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
          "legacy-thread-id": {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
        },
      },
      2,
    );

    expect(migrated).toEqual({
      terminalUiStateByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: {
          terminalOpen: true,
          terminalHeight: 320,
          terminalIds: ["term-1"],
          activeTerminalId: "term-1",
          terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
          activeTerminalGroupId: "group-term-1",
        },
      },
    });
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-only");
    store.closeTerminal(THREAD_REF, "terminal-only");

    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[scopedThreadKey(THREAD_REF)],
    ).toBeUndefined();
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual([]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.closeTerminal(THREAD_REF, "terminal-3");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.terminalIds).toEqual(["terminal-2"]);
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("reconciles terminal ids from an external ordered list", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.reconcileTerminalIds(THREAD_REF, ["term-a", "term-b"]);

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual(["term-a", "term-b"]);
    expect(terminalUiState.activeTerminalId).toBe("term-a");
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-term-a", terminalIds: ["term-a"] },
      { id: "group-term-b", terminalIds: ["term-b"] },
    ]);
  });

  it("does not import a closed panel terminal from stale metadata", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-2");
    store.closeTerminal(THREAD_REF, "term-1");

    store.reconcileTerminalIds(THREAD_REF, ["term-1", "term-2"]);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2"]);

    store.newTerminal(THREAD_REF, "term-1");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2", "term-1"]);
  });

  it("is a no-op when clearing terminal UI state for a thread with no state", () => {
    const store = useTerminalUiStateStore.getState();
    const before = useTerminalUiStateStore.getState();

    store.clearTerminalUiState(THREAD_REF);

    expect(useTerminalUiStateStore.getState()).toBe(before);
  });
});
