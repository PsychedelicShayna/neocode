import { DEFAULT_SERVER_SETTINGS, ProjectId, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { projectActionsPatch, resolveProjectScripts } from "./projectScripts.ts";
import { resolveProjectSettings } from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const project = { id: ProjectId.make("project"), scripts: [] };
const otherProject = { id: ProjectId.make("other-project"), scripts: [] };
const open: ProjectScript = {
  id: "open-neovide",
  name: "Open in Neovide",
  command: "neovide -- .",
  icon: "play",
  runOnWorktreeCreate: false,
};
const check: ProjectScript = { ...open, id: "check", name: "Check", command: "npm test" };
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsFolded: true,
  actions: { [open.id]: open },
};

function save(
  current: typeof DEFAULT_SERVER_SETTINGS,
  target: typeof project | null,
  scripts: readonly ProjectScript[] | null,
  resetId?: string,
) {
  return applyServerSettingsPatch(current, projectActionsPatch(current, target, scripts, resetId));
}

describe("scoped actions", () => {
  it("stores only project changes and keeps inheriting future environment actions", () => {
    const added = save(settings, project, [open, check]);
    expect(added.projectSettingsOverrides[project.id]?.actions).toEqual({ check });
    expect(added.projectSettingsOverrides[project.id]?.defaultProjectScripts).toBeUndefined();
    const changedOpen = { ...open, command: "neovide --no-fork -- ." };
    const third = { ...check, id: "build", name: "Build", command: "npm run build" };
    const updated = save(added, null, [changedOpen, third]);
    expect(resolveProjectScripts(updated, project)).toEqual([changedOpen, third, check]);
    expect(resolveProjectScripts(updated, otherProject)).toEqual([changedOpen, third]);
  });

  it("overrides and hides individual inherited IDs without affecting another project", () => {
    const overridden = { ...open, command: "neovide --no-fork -- ." };
    const edited = save(settings, project, [overridden, check]);
    expect(resolveProjectScripts(edited, project)).toEqual([overridden, check]);
    expect(resolveProjectScripts(edited, otherProject)).toEqual([open]);
    const hidden = save(edited, project, [check]);
    expect(hidden.projectSettingsOverrides[project.id]?.actions?.[open.id]).toBeNull();
    expect(resolveProjectScripts(hidden, project)).toEqual([check]);
    const restored = save(hidden, project, [check], open.id);
    expect(resolveProjectScripts(restored, project)).toEqual([open, check]);
    expect(restored.projectSettingsOverrides[project.id]?.actions).toEqual({ check });
  });

  it("keeps an explicit project override after the environment action is removed", () => {
    const overridden = { ...open, command: "neovide --no-fork -- ." };
    const edited = save(settings, project, [overridden]);
    const removed = save(edited, null, []);
    expect(resolveProjectScripts(removed, project)).toEqual([overridden]);
    expect(resolveProjectScripts(removed, otherProject)).toEqual([]);
  });

  it("preserves legacy project lists and unrelated overrides through action edits and reset", () => {
    const legacy = applyServerSettingsPatch(settings, {
      projectSettingsOverrides: {
        [project.id]: { set: { defaultProjectScripts: [check], defaultAutoPull: true } },
      },
    });
    expect(resolveProjectScripts(legacy, project)).toEqual([check, open]);
    const extra = { ...check, id: "build", command: "npm run build" };
    const edited = save(legacy, project, [check, open, extra]);
    expect(edited.projectSettingsOverrides[project.id]?.defaultProjectScripts).toEqual([check]);
    const reset = save(edited, project, null);
    expect(reset.projectSettingsOverrides[project.id]).toEqual({ defaultAutoPull: true });
    expect(resolveProjectScripts(reset, project)).toEqual([open]);
    expect(legacy.projectSettingsOverrides[project.id]?.defaultProjectScripts).toEqual([check]);
  });

  it("does not replace unrelated project settings changed after an action edit was planned", () => {
    const actions = projectActionsPatch(settings, project, [open, check]);
    const changed = applyServerSettingsPatch(settings, {
      projectSettingsOverrides: { [project.id]: { set: { defaultAutoPull: true } } },
    });
    const saved = applyServerSettingsPatch(changed, actions);
    expect(saved.projectSettingsOverrides[project.id]?.defaultAutoPull).toBe(true);
    const reset = projectActionsPatch(settings, project, null);
    expect(applyServerSettingsPatch(saved, reset).projectSettingsOverrides[project.id]).toEqual({
      defaultAutoPull: true,
    });
  });

  it("does not resurrect removed environment actions through deep merge", () => {
    const added = save(settings, null, [open, check]);
    const deleted = save(added, null, [check]);
    expect(deleted.actions[open.id]).toBeUndefined();
    expect(resolveProjectScripts(deleted, project)).toEqual([check]);
    const cleared = save(deleted, null, null);
    expect(cleared.actions).toEqual({});
    expect(resolveProjectScripts(cleared, project)).toEqual([]);
  });

  it("merges action IDs in scoped settings without replacing other scope rules", () => {
    const edited = save(settings, project, [open, check]);
    const resolved = resolveProjectSettings(edited, project.id);
    expect(resolved.settings.actions).toEqual({ [open.id]: open, check });
    expect(resolved.sources.actions).toBe("project");
    expect(resolveProjectSettings(edited, otherProject.id).settings.actions).toEqual(
      settings.actions,
    );
  });

  it("keeps environment action definitions isolated", () => {
    const remote = save(DEFAULT_SERVER_SETTINGS, null, [check]);
    expect(resolveProjectScripts(remote, project)).toEqual([check]);
    expect(resolveProjectScripts(settings, project)).toEqual([open]);
  });
});
