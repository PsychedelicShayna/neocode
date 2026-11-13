import { EnvironmentId, ThreadId, type ThreadJumpKeybindingCommand } from "@t3tools/contracts";
import { useEffect } from "react";
import { NeoPiNativeSessionRef } from "@t3tools/contracts";
import { nativeRecord } from "@t3tools/client-runtime/neopi-native-sessions";
import { parseWorkspaceKey } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";

const nativeRouteTarget = Schema.Struct({
  environmentId: EnvironmentId,
  ref: NeoPiNativeSessionRef,
});
const nativeRouteSuffix: Readonly<Record<string, string>> = {
  NativeSession: "",
  ThreadTerminal: "terminal",
  ThreadDevicePreview: "devices",
  ThreadFiles: "files",
  ThreadFile: "files",
  ThreadReview: "review",
  ThreadReviewComment: "review-comment",
  ThreadAttachment: "attachments",
};

/** Resolve actual native identities carried by existing mobile surface routes. */
export function resolveNativeWorkspaceRoute(route: {
  readonly name: string;
  readonly params?: unknown;
}) {
  if (nativeRouteSuffix[route.name] === undefined) return null;
  const params = nativeRecord(route.params);
  const draftTarget =
    typeof params.draftKey === "string" ? parseWorkspaceKey(params.draftKey) : null;
  const target = nativeRecord(params.target ?? params.workspaceRef ?? draftTarget);
  const candidate = {
    environmentId: target.environmentId ?? params.environmentId,
    ref: target.ref ?? params.nativeRef ?? (route.name === "NativeSession" ? params : null),
  };
  if (!Schema.is(nativeRouteTarget)(candidate)) return null;
  return { target: candidate, ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}) };
}

/** Native route params must not be serialized through the legacy required :threadId path. */
export function nativeWorkspaceRoutePath(route: {
  readonly name: string;
  readonly params?: unknown;
}): string | null {
  const resolved = resolveNativeWorkspaceRoute(route);
  if (!resolved) return null;
  const params = nativeRecord(route.params);
  const suffix = nativeRouteSuffix[route.name];
  const candidate = resolved.target;
  const root = `/sessions/${encodeURIComponent(candidate.environmentId)}/${encodeURIComponent(candidate.ref.providerInstanceId)}/${encodeURIComponent(candidate.ref.sessionFile)}`;
  const path =
    route.name === "ThreadFile" && Array.isArray(params.path)
      ? params.path
          .filter((part): part is string => typeof part === "string")
          .map(encodeURIComponent)
          .join("/")
      : route.name === "ThreadAttachment" && typeof params.attachmentId === "string"
        ? encodeURIComponent(params.attachmentId)
        : "";
  return `${root}${suffix ? `/${suffix}` : ""}${path ? `/${path}` : ""}`;
}

export type HardwareKeyboardCommand =
  | ThreadJumpKeybindingCommand
  | "commandPalette"
  | "paletteNext"
  | "palettePrevious"
  | "paletteDismiss"
  | "newTask"
  | "focusSearch"
  | "back"
  | "files"
  | "terminal"
  | "review"
  | "copyThreadReference"
  | "toggleSidebar"
  | "cycleHost";

type CommandHandler = (command: HardwareKeyboardCommand) => boolean | void;

const handlers = new Map<HardwareKeyboardCommand, Set<CommandHandler>>();
const registrationListeners = new Set<() => void>();
let registrationVersion = 0;

export function useHardwareKeyboardCommand(
  command: HardwareKeyboardCommand | ReadonlyArray<HardwareKeyboardCommand>,
  handler: CommandHandler,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the handler in the module-level hardware keyboard command registry
  useEffect(() => {
    const commands = typeof command === "string" ? [command] : command;
    for (const command of commands) {
      const commandHandlers = handlers.get(command) ?? new Set<CommandHandler>();
      commandHandlers.add(handler);
      handlers.set(command, commandHandlers);
    }
    registrationVersion += 1;
    registrationListeners.forEach((listener) => listener());
    return () => {
      for (const command of commands) {
        const commandHandlers = handlers.get(command);
        commandHandlers?.delete(handler);
        if (commandHandlers?.size === 0) handlers.delete(command);
      }
      registrationVersion += 1;
      registrationListeners.forEach((listener) => listener());
    };
  }, [command, handler]);
}

export function getRegisteredHardwareKeyboardCommands(): ReadonlySet<HardwareKeyboardCommand> {
  return new Set(handlers.keys());
}

export function getHardwareKeyboardCommandRegistrationVersion(): number {
  return registrationVersion;
}

export function subscribeToHardwareKeyboardCommandRegistrations(listener: () => void): () => void {
  registrationListeners.add(listener);
  return () => registrationListeners.delete(listener);
}

export function dispatchHardwareKeyboardCommand(command: HardwareKeyboardCommand): boolean {
  const commandHandlers = handlers.get(command);
  if (!commandHandlers) return false;
  const handlersInRegistrationOrder = Array.from(commandHandlers);
  for (let index = handlersInRegistrationOrder.length - 1; index >= 0; index -= 1) {
    const handler = handlersInRegistrationOrder[index];
    if (!handler) continue;
    if (handler(command) !== false) return true;
  }
  return false;
}

export function parseActiveThreadPath(pathname: string): {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
} | null {
  const match = /^\/threads\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      environmentId: EnvironmentId.make(decodeURIComponent(match[1])),
      threadId: ThreadId.make(decodeURIComponent(match[2])),
    };
  } catch {
    return null;
  }
}

export function nextEnvironmentId<T extends { readonly environmentId: string }>(
  environments: ReadonlyArray<T>,
  currentId: string | null,
): T["environmentId"] | null {
  if (environments.length < 2) return null;
  const index = environments.findIndex((environment) => environment.environmentId === currentId);
  return environments[(index + 1) % environments.length]?.environmentId ?? null;
}
