import type { KeybindingCommand } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";
import type { TerminalIdentity } from "./lib/terminalFocus";

/**
 * The one table keybindings, the command palette and the Ex line dispatch
 * through. A component that owns a command's behaviour registers its handler
 * while it is mounted; every entry point then reaches that same handler.
 *
 * `workspace` handlers belong to the mounted session or thread view, `app`
 * handlers to the app shell. A keybinding listener dispatches only its own
 * scope, so each command keeps one key route. The palette and the Ex line see
 * both scopes, the workspace first. Within a scope the latest registration wins.
 */
export type CommandScope = "app" | "workspace";

/**
 * How a command was invoked. Keybindings and the palette pass nothing and act
 * where the keyboard is. The Ex line has the keyboard itself, so it names the
 * terminal that had focus last (null when none has); terminal commands then act
 * on that terminal and are unavailable once it is gone.
 */
export interface CommandInvocation {
  readonly terminal: TerminalIdentity | null;
}

export interface CommandHandler {
  readonly label: string;
  /** False when running the command here would do nothing; a key bound to it is then left alone. */
  readonly available: (invocation?: CommandInvocation) => boolean;
  readonly run: (invocation?: CommandInvocation) => void | Promise<void>;
  /** Runs again while its key auto-repeats; otherwise a held key runs it once. */
  readonly repeat?: boolean;
}

interface Registration {
  readonly command: KeybindingCommand;
  readonly scope: CommandScope;
  readonly handler: CommandHandler;
}

export type CommandDispatch =
  | { readonly status: "unknown" }
  | { readonly status: "unavailable"; readonly label: string }
  | { readonly status: "ran"; readonly done: Promise<void> };

const registrations: Registration[] = [];

export function registerCommand(
  command: KeybindingCommand,
  scope: CommandScope,
  handler: CommandHandler,
): () => void {
  const registration = { command, scope, handler };
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index !== -1) registrations.splice(index, 1);
  };
}

function findInScope(command: string, scope: CommandScope): CommandHandler | undefined {
  return registrations.findLast((entry) => entry.command === command && entry.scope === scope)
    ?.handler;
}

/** The handler a palette item or the Ex line reaches for `command`, if any is mounted. */
export function findCommand(command: string): CommandHandler | undefined {
  return findInScope(command, "workspace") ?? findInScope(command, "app");
}

function runHandler(handler: CommandHandler, invocation?: CommandInvocation): Promise<void> {
  try {
    return Promise.resolve(handler.run(invocation));
  } catch (cause) {
    return Promise.reject(cause);
  }
}

export function dispatchCommand(command: string, invocation?: CommandInvocation): CommandDispatch {
  const handler = findCommand(command);
  if (!handler) return { status: "unknown" };
  if (!handler.available(invocation)) return { status: "unavailable", label: handler.label };
  return { status: "ran", done: runHandler(handler, invocation) };
}

interface CommandKeyEvent {
  readonly repeat: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Runs the keybinding's command from `scope` when it is available there and
 * takes the key; otherwise leaves the event alone and returns null.
 */
export function dispatchKeybindingCommand(
  command: KeybindingCommand,
  event: CommandKeyEvent,
  scope: CommandScope,
): Promise<void> | null {
  const handler = findInScope(command, scope);
  if (!handler?.available()) return null;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat && !handler.repeat) return Promise.resolve();
  return runHandler(handler);
}

/** For a palette item: runs `command` and settles when it has, or at once when nothing ran. */
export function runCommand(command: KeybindingCommand): Promise<void> {
  const dispatch = dispatchCommand(command);
  return dispatch.status === "ran" ? dispatch.done : Promise.resolve();
}

/**
 * Registers `handlers` for as long as the calling component is mounted. Each
 * call reads the handler from the latest render, so handlers may close over
 * props and state without re-registering. Registration follows the commit, so
 * an unmounted owner's handlers are gone before any later effect runs.
 */
export function useCommandHandlers(
  scope: CommandScope,
  handlers: Partial<Record<KeybindingCommand, CommandHandler>>,
): void {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  const commands = Object.keys(handlers).join(" ");
  useLayoutEffect(() => {
    const unregister = commands
      .split(" ")
      .filter((command): command is KeybindingCommand => command !== "")
      .map((command) => {
        const read = () => latest.current[command];
        return registerCommand(command, scope, {
          get label() {
            return read()?.label ?? command;
          },
          available: (invocation) => read()?.available(invocation) ?? false,
          run: (invocation) => read()?.run(invocation),
          get repeat() {
            return read()?.repeat === true;
          },
        });
      });
    return () => {
      for (const stop of unregister) stop();
    };
  }, [commands, scope]);
}
