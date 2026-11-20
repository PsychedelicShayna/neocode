import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  dispatchCommand,
  dispatchKeybindingCommand,
  findCommand,
  registerCommand,
  useCommandHandlers,
  type CommandHandler,
} from "./commandTable";

function keyEvent(repeat = false) {
  return { repeat, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

function handler(overrides: Partial<CommandHandler> = {}) {
  return { label: "Split terminal", available: () => true, run: vi.fn(), ...overrides };
}

const cleanups: Array<() => void> = [];
function register(...args: Parameters<typeof registerCommand>) {
  cleanups.push(registerCommand(...args));
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("command table", () => {
  it("lets the mounted workspace shadow the app shell, latest registration first", () => {
    const app = handler();
    const workspace = handler();
    const newer = handler();
    register("terminal.split", "app", app);
    register("terminal.split", "workspace", workspace);
    register("terminal.split", "workspace", newer);

    expect(dispatchCommand("terminal.split").status).toBe("ran");
    expect(newer.run).toHaveBeenCalledOnce();
    expect(workspace.run).not.toHaveBeenCalled();
    expect(app.run).not.toHaveBeenCalled();
  });

  it("dispatches a key only to its own scope, so each command keeps one key route", () => {
    const app = handler();
    register("chat.new", "app", app);
    const event = keyEvent();

    expect(dispatchKeybindingCommand("chat.new", event, "workspace")).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(app.run).not.toHaveBeenCalled();

    expect(dispatchKeybindingCommand("chat.new", event, "app")).not.toBeNull();
    expect(app.run).toHaveBeenCalledOnce();
  });

  it("does not run an unavailable command and leaves its key alone", () => {
    const close = handler({ label: "Close terminal", available: () => false });
    register("terminal.close", "workspace", close);
    const event = keyEvent();

    expect(dispatchCommand("terminal.close")).toEqual({
      status: "unavailable",
      label: "Close terminal",
    });
    expect(dispatchKeybindingCommand("terminal.close", event, "workspace")).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(close.run).not.toHaveBeenCalled();
    expect(dispatchCommand("terminal.new")).toEqual({ status: "unknown" });
  });

  it("takes a held key but runs the command once unless it repeats", () => {
    const once = handler();
    const repeating = handler({ repeat: true });
    register("terminal.split", "workspace", once);
    register("chat.new", "app", repeating);
    const held = keyEvent(true);

    dispatchKeybindingCommand("terminal.split", held, "workspace");
    dispatchKeybindingCommand("chat.new", held, "app");

    expect(held.preventDefault).toHaveBeenCalledTimes(2);
    expect(once.run).not.toHaveBeenCalled();
    expect(repeating.run).toHaveBeenCalledOnce();
  });

  it("reports a failing command through the returned promise", async () => {
    register(
      "chat.new",
      "app",
      handler({
        run: () => {
          throw new Error("offline");
        },
      }),
    );
    const dispatch = dispatchCommand("chat.new");
    expect(dispatch.status).toBe("ran");
    if (dispatch.status === "ran") await expect(dispatch.done).rejects.toThrow("offline");
  });
});

describe("useCommandHandlers", () => {
  function Owner({ run, available }: { run: () => void; available: boolean }) {
    useCommandHandlers("workspace", {
      "terminal.new": { label: "New terminal", available: () => available, run },
    });
    return null;
  }

  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(() => vi.unstubAllGlobals());

  it("reaches the latest render's handler and unregisters on unmount", () => {
    const first = vi.fn();
    const second = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Owner run={first} available />);
    });
    act(() => renderer.update(<Owner run={second} available={false} />));
    expect(dispatchCommand("terminal.new").status).toBe("unavailable");

    act(() => renderer.update(<Owner run={second} available />));
    dispatchCommand("terminal.new");
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();

    act(() => renderer.unmount());
    expect(findCommand("terminal.new")).toBeUndefined();
  });

  it("is gone before a surviving component's layout effect in the unmounting commit", () => {
    const run = vi.fn();
    const seen: string[] = [];
    function Survivor({ ownerShown }: { ownerShown: boolean }) {
      useLayoutEffect(() => {
        seen.push(`${ownerShown ? "shown" : "removed"}: ${dispatchCommand("terminal.new").status}`);
      }, [ownerShown]);
      return null;
    }
    function Page({ ownerShown }: { ownerShown: boolean }) {
      return (
        <>
          {ownerShown ? <Owner run={run} available /> : null}
          <Survivor ownerShown={ownerShown} />
        </>
      );
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Page ownerShown />);
    });
    act(() => renderer.update(<Page ownerShown={false} />));
    expect(seen).toEqual(["shown: ran", "removed: unknown"]);
    act(() => renderer.unmount());
  });
});
