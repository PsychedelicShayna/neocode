import { describe, expect, it } from "vite-plus/test";
import { bindManagedTmuxOwner } from "./NeoPiManagedTmux.ts";

const pane = { session: "$2", window: "@3", pane: "%4", pid: 321 };
const sessionFile = "/profile/sessions/session.jsonl";
const publication = {
  instanceId: "0123456789abcdef",
  imageId: "this-image",
  sessionId: "native-session",
  sessionFile,
  profile: "work",
  pid: 321,
  role: "tui",
  tmuxPane: "%4",
};
const status = {
  instanceId: publication.instanceId,
  imageId: publication.imageId,
  session: { sessionId: publication.sessionId, sessionFile },
  ready: true,
  cwd: "/project",
  pid: 321,
  role: "tui",
  tmux: { pane: "%4" },
};
const entry = { meta: publication, snapshot: status };
const requested = { sessionFile, profile: "work" };

describe("managed tmux ownership", () => {
  it("binds the exact pane and ready control image, not a matching file from a different pane owner", () => {
    const other = { ...entry, meta: { ...publication, pid: 999, instanceId: "other" } };
    expect(bindManagedTmuxOwner(requested, pane, [other, entry])).toEqual({
      ...pane,
      instanceId: publication.instanceId,
      imageId: publication.imageId,
      sessionId: publication.sessionId,
    });
  });

  it("refuses a live pane without an attachable endpoint", () => {
    expect(() => bindManagedTmuxOwner(requested, pane, [])).toThrow(
      /control.*disabled or unavailable/i,
    );
    expect(() => bindManagedTmuxOwner(requested, pane, [{ ...entry, snapshot: null }])).toThrow(
      /control.*disabled or unavailable/i,
    );
  });

  it("refuses the pane when its publication is for a different session or profile", () => {
    expect(() =>
      bindManagedTmuxOwner({ ...requested, sessionFile: "/profile/other.jsonl" }, pane, [entry]),
    ).toThrow(/different native session/i);
    expect(() => bindManagedTmuxOwner({ ...requested, profile: "other" }, pane, [entry])).toThrow(
      /different native session/i,
    );
  });

  it("refuses a publication replaced by a different control image", () => {
    expect(() =>
      bindManagedTmuxOwner(requested, pane, [
        { ...entry, snapshot: { ...status, imageId: "new-image" } },
      ]),
    ).toThrow(/changed/i);
  });
});
