import { describe, expect, it } from "vite-plus/test";
import { reduceAgentView, SESSION_AGENT_VIEW } from "./agentViewStore";

describe("agent view transitions", () => {
  it("returns an agent opened from the hub to the hub, then to the session", () => {
    let state = reduceAgentView(SESSION_AGENT_VIEW, { type: "toggleHub" });
    state = reduceAgentView(state, { type: "select", id: "a" });
    state = reduceAgentView(state, { type: "open", id: "a" });
    expect(state).toMatchObject({ mode: "agent", selectedId: "a", returnTo: "hub" });
    state = reduceAgentView(state, { type: "back" });
    expect(state).toMatchObject({ mode: "hub", selectedId: "a" });
    state = reduceAgentView(state, { type: "back" });
    expect(state.mode).toBe("session");
  });

  it("returns an agent opened from the panel straight to the session", () => {
    const opened = reduceAgentView(SESSION_AGENT_VIEW, { type: "open", id: "a" });
    expect(opened.returnTo).toBe("session");
    expect(reduceAgentView(opened, { type: "back" }).mode).toBe("session");
  });

  it("shows the hub from an open agent, and a second toggle closes it", () => {
    const hub = reduceAgentView(SESSION_AGENT_VIEW, { type: "toggleHub" });
    const opened = reduceAgentView(hub, { type: "open", id: "a" });
    const toggled = reduceAgentView(opened, { type: "toggleHub" });
    expect(toggled.mode).toBe("hub");
    expect(reduceAgentView(toggled, { type: "toggleHub" }).mode).toBe("session");
  });

  it("expands nothing by default, and a second click on the expanded agent collapses it", () => {
    expect(SESSION_AGENT_VIEW.selectedId).toBeNull();
    const expanded = reduceAgentView(SESSION_AGENT_VIEW, { type: "toggle", id: "a" });
    expect(expanded).toMatchObject({ mode: "session", selectedId: "a" });
    expect(reduceAgentView(expanded, { type: "toggle", id: "a" }).selectedId).toBeNull();
  });

  it("a click on another agent moves the expansion, and two fast clicks never enter the agent", () => {
    const first = reduceAgentView(SESSION_AGENT_VIEW, { type: "toggle", id: "a" });
    expect(reduceAgentView(first, { type: "toggle", id: "b" }).selectedId).toBe("b");
    const twice = reduceAgentView(first, { type: "toggle", id: "a" });
    expect(twice.mode).toBe("session");
    expect(reduceAgentView(twice, { type: "toggle", id: "a" })).toMatchObject({
      mode: "session",
      selectedId: "a",
    });
  });

  it("keyboard selection never collapses the expanded agent", () => {
    const expanded = reduceAgentView(SESSION_AGENT_VIEW, { type: "toggle", id: "a" });
    expect(reduceAgentView(expanded, { type: "select", id: "a" })).toBe(expanded);
  });
});
