import { create } from "zustand";

/**
 * Which main-area view a native session shows. The agents right panel and the
 * Agent Hub share one selection, so expanding an agent in either expands it in
 * both. Nothing is selected until the user picks an agent. Not persisted: a
 * reload returns to the session.
 */
export type AgentViewMode = "session" | "hub" | "agent";

export interface AgentViewState {
  readonly mode: AgentViewMode;
  readonly selectedId: string | null;
  /** Where Esc leaves an opened agent to: the hub it was opened from, else the session. */
  readonly returnTo: "session" | "hub";
}

export const SESSION_AGENT_VIEW: AgentViewState = {
  mode: "session",
  selectedId: null,
  returnTo: "session",
};

export type AgentViewAction =
  | { readonly type: "toggleHub" }
  /** Move the selection (keyboard); never clears it. */
  | { readonly type: "select"; readonly id: string }
  /** A click: selects an agent, and collapses it again when it is already selected. */
  | { readonly type: "toggle"; readonly id: string }
  /** Enter the agent's own view. Only ever an explicit action, never a side effect of clicking. */
  | { readonly type: "open"; readonly id: string }
  | { readonly type: "back" };

export function reduceAgentView(state: AgentViewState, action: AgentViewAction): AgentViewState {
  switch (action.type) {
    case "toggleHub":
      return state.mode === "hub"
        ? { ...state, mode: "session", returnTo: "session" }
        : { ...state, mode: "hub", returnTo: "session" };
    case "select":
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
    case "toggle":
      return { ...state, selectedId: state.selectedId === action.id ? null : action.id };
    case "open":
      return {
        mode: "agent",
        selectedId: action.id,
        returnTo: state.mode === "hub" ? "hub" : "session",
      };
    case "back":
      if (state.mode === "agent") return { ...state, mode: state.returnTo, returnTo: "session" };
      if (state.mode === "hub") return { ...state, mode: "session" };
      return state;
  }
}

interface AgentViewStore {
  readonly byKey: Readonly<Record<string, AgentViewState>>;
  dispatch: (key: string, action: AgentViewAction) => void;
}

export const useAgentViewStore = create<AgentViewStore>((set) => ({
  byKey: {},
  dispatch: (key, action) =>
    set((store) => {
      const current = store.byKey[key] ?? SESSION_AGENT_VIEW;
      const next = reduceAgentView(current, action);
      return next === current ? store : { byKey: { ...store.byKey, [key]: next } };
    }),
}));

export const selectAgentView =
  (key: string) =>
  (store: AgentViewStore): AgentViewState =>
    store.byKey[key] ?? SESSION_AGENT_VIEW;
