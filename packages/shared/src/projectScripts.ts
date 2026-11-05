import type {
  ProjectId,
  ProjectScript,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "actions"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

type ScriptProject = { id: ProjectId; scripts: readonly ProjectScript[] };

function legacyProjectScripts(
  settings: ProjectScriptSettings,
  project: ScriptProject,
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

/**
 * Preserve legacy whole-list selection, then overlay reusable environment
 * actions and project deltas by ID. Null hides one ID, never the whole list.
 */
export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: ScriptProject | null,
): readonly ProjectScript[] {
  const baseline = project
    ? legacyProjectScripts(settings, project)
    : settings.defaultProjectScripts;
  const local = project ? settings.projectSettingsOverrides[project.id]?.actions : undefined;
  if (Object.keys(settings.actions).length === 0 && !local) return baseline;
  const scripts = new Map(baseline.map((script) => [script.id, script]));
  for (const layer of [settings.actions, local]) {
    if (!layer) continue;
    for (const [id, script] of Object.entries(layer)) {
      if (script === null) scripts.delete(id);
      else scripts.set(id, script.id === id ? script : { ...script, id });
    }
  }
  return [...scripts.values()];
}

/**
 * Only changed IDs are stored. Unchanged inherited actions keep following
 * future environment edits, even after a project adds its own actions.
 */
export function projectActionsPatch(
  settings: ServerSettings,
  project: ScriptProject | null,
  nextScripts: readonly ProjectScript[] | null,
  resetId?: string,
): ServerSettingsPatch {
  const current = resolveProjectScripts(settings, project);
  const actions = {
    ...(project ? settings.projectSettingsOverrides[project.id]?.actions : settings.actions),
  };
  if (resetId !== undefined) {
    delete actions[resetId];
  } else if (nextScripts !== null) {
    const next = new Map(nextScripts.map((script) => [script.id, script]));
    for (const script of current) {
      const updated = next.get(script.id);
      if (JSON.stringify(updated) !== JSON.stringify(script)) {
        if (updated) actions[script.id] = updated;
        else if (
          project ||
          settings.defaultProjectScripts.some((entry) => entry.id === script.id)
        ) {
          actions[script.id] = null;
        } else {
          delete actions[script.id];
        }
      }
      next.delete(script.id);
    }
    for (const [id, script] of next) actions[id] = script;
  }
  if (!project) return { actions: nextScripts === null ? {} : actions };
  return {
    projectSettingsOverrides: {
      [project.id]:
        nextScripts === null
          ? { clear: ["actions", "defaultProjectScripts"] }
          : { set: { actions } },
    },
  };
}

export function projectScriptsInheritDefaults(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  if (settings.projectSettingsOverrides[project.id]?.defaultProjectScripts !== undefined) {
    return false;
  }
  if (settings.projectSettingsFolded) return true;
  const legacy = settings.projectScriptOverrides[project.id];
  return legacy === null || (legacy === undefined && project.scripts.length === 0);
}

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
