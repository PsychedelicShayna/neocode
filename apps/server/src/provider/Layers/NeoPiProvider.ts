// @effect-diagnostics nodeBuiltinImport:off -- Provider binary paths are resolved before RPC services start.
import * as NodePath from "node:path";
import * as NodeFS from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { NeoPiSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { NeoPiRpcClient, SpawnFn } from "effect-neopi-rpc/client";
import { make as makeClient } from "effect-neopi-rpc/client";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { providerModelsFromSettings } from "../providerSnapshot.ts";
import type { NeoPiDiscoveryHub } from "../neopi/NeoPiDiscovery.ts";
import type { NeoPiDiscoveryProbe } from "../neopi/NeoPiDiscoveryProbe.ts";
import { NEOPI_CAPABILITIES, neopiCompatibility } from "../neopi/NeoPiCompatibility.ts";
import { neoPiRolesFromRpc, toServerProviderModels } from "../neopi/NeoPiModelCatalog.ts";
import type { NeoPiCapabilityProbe } from "../neopi/NeoPiSessionCatalogSource.ts";

const PRESENTATION = {
  displayName: "NeoPi",
  badgeLabel: "RPC",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  supportsConversationRollback: true,
} as const;
const fallbackModels = (settings: NeoPiSettings) =>
  providerModelsFromSettings(
    [],
    settings.customModels ?? [],
    createModelCapabilities({ optionDescriptors: [] }),
  );

/** Ready plus v2 negotiation, separate from the model catalog fetch. */
const HANDSHAKE_TIMEOUT = "30 seconds";
/** Login, models, state, and roles. Larger than one slow catalog transfer. */
const METADATA_TIMEOUT = "45 seconds";

export interface NeoPiRetainedCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly roles?: unknown;
}

export interface NeoPiProviderProbeOptions {
  readonly resolvedBinary?: string;
  readonly capabilityProbe?: NeoPiCapabilityProbe;
  readonly previous?: NeoPiRetainedCatalog;
  readonly handshakeTimeout?: Duration.Input;
  readonly metadataTimeout?: Duration.Input;
  readonly onSuccessfulCatalog?: (catalog: NeoPiRetainedCatalog) => Effect.Effect<void>;
}

const probeTimeoutMessage = (part: "handshake" | "metadata"): string =>
  part === "handshake"
    ? "NeoPi RPC handshake timed out before ready and protocol v2 negotiation finished."
    : "NeoPi RPC metadata probe timed out before login, models, state, and roles were refreshed.";

const isTimeoutCause = (error: unknown): boolean =>
  error instanceof NeoPiRpcError && error.code === "timeout";

const fromProbe = (
  settings: NeoPiSettings,
  checkedAt: string,
  input: {
    installed: boolean;
    version?: string | null;
    status: "ready" | "warning" | "error";
    auth?: "unknown" | "authenticated";
    message?: string;
    models?: ReadonlyArray<ServerProviderModel>;
    compatibilityAdvisory?: ReturnType<typeof neopiCompatibility>;
    showInteractionModeToggle?: boolean;
  },
): ServerProviderDraft => ({
  ...buildServerProvider({
    presentation: {
      ...PRESENTATION,
      showInteractionModeToggle: input.showInteractionModeToggle === true,
      reportsContextWindow: input.status === "ready",
    },
    enabled: settings.enabled,
    checkedAt,
    models: input.models ?? fallbackModels(settings),
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: input.installed,
      version: input.version ?? null,
      status: input.status,
      auth: { status: input.auth ?? "unknown" },
      ...(input.message ? { message: input.message } : {}),
    },
  }),
  ...(input.compatibilityAdvisory ? { compatibilityAdvisory: input.compatibilityAdvisory } : {}),
});

export const buildInitialNeoPiProviderSnapshot = (settings: NeoPiSettings) =>
  DateTime.now.pipe(
    Effect.map((now) =>
      fromProbe(
        settings,
        DateTime.formatIso(now),
        settings.enabled
          ? {
              installed: true,
              status: "warning",
              message: "Checking NeoPi CLI availability...",
            }
          : {
              installed: false,
              status: "warning",
              message: "NeoPi is disabled in app settings.",
            },
      ),
    ),
  );

export function modelsFromNeoPiRpc(
  data: unknown,
  current?: unknown,
  fastModeEnabled = false,
  roles?: unknown,
): ReadonlyArray<ServerProviderModel> {
  if (
    typeof data !== "object" ||
    data === null ||
    !("models" in data) ||
    !Array.isArray(data.models)
  )
    return [];
  return toServerProviderModels(data.models, current, fastModeEnabled, neoPiRolesFromRpc(roles));
}

export function requestNeoPiProviderMetadata(
  client: Pick<NeoPiRpcClient, "capabilities" | "request">,
) {
  return Effect.all({
    login: client.request({ type: "get_login_providers" }),
    models: client.request({ type: "get_available_models" }),
    state: client.request({ type: "get_state" }),
    roles: client.capabilities.has(NEOPI_CAPABILITIES.getRoles)
      ? client.request({ type: "get_roles" })
      : Effect.succeed(undefined),
  });
}

export const resolveNeoPiBinary = Effect.fn("resolveNeoPiBinary")(function* (
  settings: Pick<NeoPiSettings, "binaryPath">,
  environment: Record<string, string>,
  cwd: string,
  pinnedBinary?: string,
) {
  const useDefaultSearch =
    pinnedBinary === undefined && (!settings.binaryPath || settings.binaryPath === "npi");
  const bundled = environment.T3CODE_DESKTOP_RESOURCES_PATH
    ? NodePath.join(environment.T3CODE_DESKTOP_RESOURCES_PATH, "bin", "npi")
    : undefined;
  const commands = pinnedBinary
    ? [pinnedBinary]
    : useDefaultSearch
      ? ["npi-nightly", "npi", ...(bundled ? [bundled] : []), "omp"]
      : [settings.binaryPath];
  const failures: string[] = [];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  for (const candidate of commands) {
    // Save the executable's path, not a name whose meaning can change after login hydration.
    const binary = useDefaultSearch
      ? yield* Effect.promise(async () => {
          const extensions =
            process.platform === "win32"
              ? ["", ...(environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
              : [""];
          const roots = NodePath.isAbsolute(candidate)
            ? [candidate]
            : (environment.PATH ?? "")
                .split(NodePath.delimiter)
                .map((directory) => NodePath.resolve(cwd, directory, candidate));
          for (const root of roots) {
            for (const extension of extensions) {
              const path = root + extension;
              try {
                await NodeFS.access(path, fsConstants.X_OK);
                return path;
              } catch {
                // Continue searching this command's PATH entries.
              }
            }
          }
          return candidate;
        })
      : candidate;
    const probe = yield* spawnAndCollect(
      binary,
      ChildProcess.make(binary, ["--version"], { cwd, env: environment }),
    ).pipe(Effect.timeoutOption("4 seconds"), Effect.result);
    const version =
      Result.isSuccess(probe) && Option.isSome(probe.success) && probe.success.value.code === 0
        ? parseGenericCliVersion(probe.success.value.stdout + probe.success.value.stderr)
        : null;
    let error = Result.isSuccess(probe)
      ? Option.isNone(probe.success)
        ? "version probe timed out"
        : probe.success.value.code === 0
          ? null
          : `version probe exited ${probe.success.value.code}`
      : String(probe.failure);
    if (!useDefaultSearch) return { binary, version, error, autoSelected: false, bundled: false };
    if (!error) {
      const capability = yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* makeClient({
            spawn: spawner.spawn,
            command: binary,
            args: [
              "--mode",
              "rpc-ui",
              "--cwd",
              cwd,
              "--no-session",
              "--no-tools",
              "--no-extensions",
              "--no-skills",
              "--no-rules",
              "--no-title",
            ],
            cwd,
            env: environment,
            requestTimeoutMs: 30_000,
          });
          return (
            neopiCompatibility(client.ready, client.capabilities.has("v2")).status ===
              "supported" && client.capabilities.has(NEOPI_CAPABILITIES.sessionCatalog)
          );
        }),
      ).pipe(Effect.timeoutOption(HANDSHAKE_TIMEOUT), Effect.result);
      if (
        Result.isSuccess(capability) &&
        Option.isSome(capability.success) &&
        capability.success.value
      )
        return { binary, version, error: null, autoSelected: true, bundled: candidate === bundled };
      error = Result.isFailure(capability)
        ? `session_catalog probe failed: ${String(capability.failure)}`
        : Option.isNone(capability.success)
          ? "session_catalog probe timed out"
          : "missing protocol v2 or session_catalog capability";
    }
    failures.push(`${candidate}: ${error}`);
  }
  return {
    binary: "npi-nightly",
    version: null,
    error: `No compatible NeoPi executable with session_catalog support found. ${failures.join("; ")}. Set Binary path to an explicit installation or update NeoPi`,
    autoSelected: false,
    bundled: false,
  };
});

export function authFromLoginProviders(
  data: unknown,
  activeProvider?: string,
): "authenticated" | "unknown" {
  const providers =
    typeof data === "object" &&
    data !== null &&
    "providers" in data &&
    Array.isArray(data.providers)
      ? data.providers
      : [];
  return providers.some(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "authenticated" in entry &&
      entry.authenticated === true &&
      (activeProvider === undefined || ("id" in entry && entry.id === activeProvider)),
  )
    ? "authenticated"
    : "unknown";
}

/** A configured executable never silently falls back to a different account or installation. */
export const checkNeoPiProviderStatus = Effect.fn("checkNeoPiProviderStatus")(function* (
  settings: NeoPiSettings,
  environment: Record<string, string>,
  cwd: string,
  spawn: SpawnFn,
  hub: NeoPiDiscoveryHub,
  sharedSessionCapabilities?: Set<string>,
  options?: NeoPiProviderProbeOptions,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled)
    return fromProbe(settings, checkedAt, { installed: false, status: "warning" });
  const env = { ...environment, ...(settings.profile ? { OMP_PROFILE: settings.profile } : {}) };
  const resolved = yield* resolveNeoPiBinary(settings, env, cwd, options?.resolvedBinary);
  const capabilityProbe = options?.capabilityProbe;
  if (capabilityProbe) capabilityProbe.version = resolved?.version ?? null;
  const failedProbe = (message: string) => {
    if (capabilityProbe) capabilityProbe.failure = message;
  };
  if (!resolved || resolved.error) {
    failedProbe(resolved?.error ?? "The configured executable could not be resolved.");
    return fromProbe(settings, checkedAt, {
      installed: false,
      status: "error",
      message: resolved?.error
        ? `NeoPi binary '${resolved.binary}' could not be probed: ${resolved.error}.`
        : !settings.binaryPath || settings.binaryPath === "npi"
          ? "NeoPi CLI (`npi` or `omp`) is not installed or not on PATH."
          : `Configured NeoPi binary '${settings.binaryPath}' could not be executed.`,
    });
  }
  const { binary: selected, version } = resolved;
  const handshakeTimeout = options?.handshakeTimeout ?? HANDSHAKE_TIMEOUT;
  const metadataTimeout = options?.metadataTimeout ?? METADATA_TIMEOUT;
  const requestTimeoutMs =
    Math.max(
      Duration.toMillis(Duration.fromInputUnsafe(handshakeTimeout)),
      Duration.toMillis(Duration.fromInputUnsafe(metadataTimeout)),
    ) + 1_000;
  const observed: {
    readyCapabilities: string[];
    compatibility: ReturnType<typeof neopiCompatibility> | null;
  } = { readyCapabilities: [], compatibility: null };
  const retainedModels = (() => {
    const previous = options?.previous;
    if (!previous) return undefined;
    const builtIn =
      previous.models.length > 0
        ? previous.models
        : modelsFromNeoPiRpc({ models: [] }, undefined, false, previous.roles);
    if (builtIn.length === 0) return undefined;
    return providerModelsFromSettings(
      builtIn,
      settings.customModels ?? [],
      createModelCapabilities({ optionDescriptors: [] }),
    );
  })();
  const probed = yield* Effect.scoped(
    Effect.gen(function* () {
      const made = yield* makeClient({
        spawn,
        command: selected,
        args: [
          "--mode",
          "rpc-ui",
          "--cwd",
          cwd,
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--no-title",
        ],
        cwd,
        env,
        requestTimeoutMs,
      }).pipe(Effect.timeoutOption(handshakeTimeout), Effect.result);
      if (Result.isFailure(made)) {
        failedProbe(`RPC handshake failed: ${String(made.failure)}`);
        return { phase: "handshake-failed" as const };
      }
      if (Option.isNone(made.success)) {
        failedProbe(probeTimeoutMessage("handshake"));
        return { phase: "handshake-timeout" as const };
      }
      const client = made.success.value;
      // Capabilities and compatibility are fixed once ready+v2 returns. A later
      // metadata timeout must not discard them.
      observed.readyCapabilities = [...(client.ready.capabilities ?? [])];
      observed.compatibility = neopiCompatibility(client.ready, client.capabilities.has("v2"));
      if (observed.compatibility.status === "unsupported") {
        if (capabilityProbe) {
          capabilityProbe.status = "unsupported";
          delete capabilityProbe.failure;
        }
        return { phase: "unsupported" as const };
      }
      // This synchronous replacement cannot expose an empty set to consumers.
      // Failed refreshes keep the last compatible handshake; successful ones
      // replace it, including capabilities that have been removed.
      sharedSessionCapabilities?.clear();
      for (const capability of observed.readyCapabilities)
        sharedSessionCapabilities?.add(capability);
      if (capabilityProbe) {
        capabilityProbe.status = "compatible";
        delete capabilityProbe.failure;
      }
      const metadata = yield* requestNeoPiProviderMetadata(client).pipe(
        Effect.timeoutOption(metadataTimeout),
        Effect.result,
      );
      if (Result.isFailure(metadata)) {
        return {
          phase: isTimeoutCause(metadata.failure)
            ? ("metadata-timeout" as const)
            : ("metadata-failed" as const),
        };
      }
      if (Option.isNone(metadata.success)) return { phase: "metadata-timeout" as const };
      return { phase: "ok" as const, ...metadata.success.value };
    }),
  ).pipe(Effect.result);
  const withDiscovery = (snapshot: ServerProviderDraft) =>
    hub.latest(cwd).pipe(
      Effect.map((discovery) => ({
        ...snapshot,
        slashCommands: [
          COMPACT_SLASH_COMMAND,
          ...discovery.commands.filter((command) => command.name !== "compact"),
        ],
        skills: [...discovery.skills],
      })),
    );
  const capabilityWarning = (message: string, keepCatalog: boolean) =>
    fromProbe(settings, checkedAt, {
      installed: true,
      version,
      status: "warning",
      message,
      ...(observed.compatibility ? { compatibilityAdvisory: observed.compatibility } : {}),
      showInteractionModeToggle: observed.readyCapabilities.includes(NEOPI_CAPABILITIES.setMode),
      ...(keepCatalog && retainedModels ? { models: retainedModels } : {}),
    });
  if (Result.isFailure(probed)) {
    if (observed.compatibility) {
      return yield* withDiscovery(
        capabilityWarning("NeoPi RPC metadata probe failed; check the CLI and profile.", false),
      );
    }
    failedProbe("RPC handshake failed; check the CLI and profile.");
    return fromProbe(settings, checkedAt, {
      installed: true,
      version,
      status: "warning",
      message: "NeoPi RPC handshake failed; check the CLI and profile.",
    });
  }
  if (probed.success.phase === "handshake-timeout") {
    return fromProbe(settings, checkedAt, {
      installed: true,
      version,
      status: "warning",
      message: probeTimeoutMessage("handshake"),
    });
  }
  if (probed.success.phase === "handshake-failed") {
    return fromProbe(settings, checkedAt, {
      installed: true,
      version,
      status: "warning",
      message: "NeoPi RPC handshake failed; check the CLI and profile.",
    });
  }
  if (probed.success.phase === "unsupported") {
    return fromProbe(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      ...(observed.compatibility?.message ? { message: observed.compatibility.message } : {}),
      ...(observed.compatibility ? { compatibilityAdvisory: observed.compatibility } : {}),
    });
  }
  if (probed.success.phase !== "ok") {
    const warning = capabilityWarning(
      probed.success.phase === "metadata-timeout"
        ? probeTimeoutMessage("metadata")
        : "NeoPi RPC metadata probe failed; check the CLI and profile.",
      probed.success.phase === "metadata-timeout",
    );
    const discovered = yield* withDiscovery(warning);
    return discovered;
  }
  const { login, models, roles, state } = probed.success;
  const readyCapabilities = observed.readyCapabilities;
  const compatibility = observed.compatibility ?? neopiCompatibility(null, false);
  const current =
    typeof state === "object" && state !== null && "model" in state ? state.model : undefined;
  const currentProvider =
    typeof current === "object" &&
    current !== null &&
    "provider" in current &&
    typeof current.provider === "string"
      ? current.provider
      : "";
  const auth = authFromLoginProviders(login, currentProvider);
  const fastModeEnabled =
    typeof state === "object" &&
    state !== null &&
    "fastModeEnabled" in state &&
    state.fastModeEnabled === true;
  const available = modelsFromNeoPiRpc(models, current, fastModeEnabled, roles);
  if (options?.onSuccessfulCatalog)
    yield* options.onSuccessfulCatalog({ models: available, roles });
  const missingCurrent = available.some((model) => model.isCustom);
  const snapshot = fromProbe(settings, checkedAt, {
    installed: true,
    version,
    status: compatibility.status === "unsupported" ? "error" : missingCurrent ? "warning" : "ready",
    ...(compatibility.message || missingCurrent
      ? {
          message:
            compatibility.message ??
            "Current NeoPi model is not in the refreshed catalog; it remains selectable as a custom model.",
        }
      : {}),
    compatibilityAdvisory: compatibility,
    auth,
    showInteractionModeToggle: readyCapabilities.includes(NEOPI_CAPABILITIES.setMode),
    models: providerModelsFromSettings(
      available,
      settings.customModels ?? [],
      createModelCapabilities({ optionDescriptors: [] }),
    ),
  });
  return yield* withDiscovery(snapshot);
});

/** Live session discovery takes precedence over the disposable full-loadout probe. */
export const neoPiSnapshotForCwd = (
  base: ServerProvider,
  cwd: string,
  hub: NeoPiDiscoveryHub,
  probe: NeoPiDiscoveryProbe,
) =>
  Effect.gen(function* () {
    const latest = yield* hub.latest(cwd);
    if (base.enabled && base.installed && base.status !== "error" && latest.source !== "live")
      yield* probe.probe(cwd);
    const found = yield* hub.latest(cwd);
    return {
      ...base,
      ...(found.source === "not-loaded" ? { message: "Commands not loaded yet" } : {}),
      slashCommands: [
        COMPACT_SLASH_COMMAND,
        ...found.commands.filter((command) => command.name !== "compact"),
      ],
      skills: [...found.skills],
    } satisfies ServerProvider;
  });
