import {
  nativeSessionKey,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { dispatchCommand, findCommand } from "../../commandTable";
import { getLastTerminalFocusOwner } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { selectNativeSession, useNativeSessionSelection } from "../../state/neopiNativeSessions";
import { toastManager } from "../ui/toast";
import {
  EX_LINE_INITIAL,
  editExLine,
  exLineKey,
  matchExSessions,
  sessionCompletionQuery,
  type ExLineEffect,
  type ExLineKey,
} from "./exLine.logic";
import { useNativeSessionTabPresentation } from "./useNativeSessionTabPresentation";

/** Lines entered since the app started, newest first. Never persisted. */
const history: string[] = [];

interface SessionLabel {
  readonly title: string;
  readonly detail: string;
}

/** Reports what a session tab shows, so `:b` can search it. */
const SessionLabelProbe = memo(function SessionLabelProbe({
  tab,
  onLabel,
}: {
  readonly tab: NativeSessionTarget;
  readonly onLabel: (key: string, label: SessionLabel) => void;
}) {
  const { title, identity } = useNativeSessionTabPresentation(tab, false);
  useEffect(() => {
    onLabel(nativeSessionKey(tab), { title, detail: identity.label });
  }, [onLabel, tab, title, identity.label]);
  return null;
});

function SessionMatchRow({
  label,
  selected,
}: {
  readonly label: SessionLabel;
  readonly selected: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      className={cn(
        "flex items-center gap-2 px-3 py-0.5 sm:px-4",
        selected ? "bg-accent text-accent-foreground" : "text-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label.title}</span>
      <span className="shrink-0 text-muted-foreground">{label.detail}</span>
    </div>
  );
}

function keyOf(event: KeyboardEvent<HTMLInputElement>): ExLineKey | null {
  switch (event.key) {
    case "Enter":
    case "Escape":
    case "ArrowUp":
    case "ArrowDown":
      return event.key;
    case "Tab":
      return event.shiftKey ? "ShiftTab" : "Tab";
    default:
      return null;
  }
}

/**
 * The Vim-style command line, in the status bar's place at the foot of the
 * transcript. It takes the keyboard when it mounts; the owner refocuses it
 * through `inputRef` when asked for again.
 */
export function ExLine({
  inputRef,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  // Read before the input takes focus: where Escape returns to.
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  const [state, setState] = useState(EX_LINE_INITIAL);
  const tabs = useNativeSessionSelection((selection) => selection.tabs);
  const [labels, setLabels] = useState<ReadonlyMap<string, SessionLabel>>(new Map());
  const onLabel = useCallback((key: string, label: SessionLabel) => {
    setLabels((current) => {
      const known = current.get(key);
      if (known?.title === label.title && known.detail === label.detail) return current;
      return new Map(current).set(key, label);
    });
  }, []);
  const query = sessionCompletionQuery(state.text);
  const matches = useMemo(() => {
    if (query === null) return [];
    const options = tabs.map((tab) => {
      const key = nativeSessionKey(tab);
      return { key, tab, ...(labels.get(key) ?? { title: "", detail: "" }) };
    });
    return matchExSessions(options, query);
  }, [labels, query, tabs]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  const close = () => {
    onClose();
    if (returnFocus?.isConnected) returnFocus.focus();
    else inputRef.current?.blur();
  };

  const apply = (effect: ExLineEffect) => {
    if (effect.kind !== "close" && history[0] !== state.text) history.unshift(state.text);
    close();
    if (effect.kind === "switchSession") {
      const match = matches.find((candidate) => candidate.key === effect.key);
      if (match) selectNativeSession(match.tab);
      return;
    }
    if (effect.kind !== "run") return;
    const dispatch = dispatchCommand(effect.command);
    if (dispatch.status !== "ran") return;
    void dispatch.done.catch((cause) =>
      toastManager.add({
        type: "error",
        title: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const key = keyOf(event);
    if (!key) return;
    event.preventDefault();
    const next = exLineKey(state, key, {
      matches,
      history,
      commands: {
        find: findCommand,
        terminalFocusedLast: getLastTerminalFocusOwner() !== null,
      },
    });
    if (next.effect) apply(next.effect);
    else setState(next.state);
  };

  const selected = Math.min(state.selected, matches.length - 1);
  return (
    <div className="relative flex h-6 shrink-0 items-center gap-1 border-t border-border/60 bg-background px-3 font-mono text-xs sm:px-4">
      {query !== null
        ? tabs.map((tab) => (
            <SessionLabelProbe key={nativeSessionKey(tab)} tab={tab} onLabel={onLabel} />
          ))
        : null}
      {matches.length > 0 ? (
        <div
          role="listbox"
          aria-label="Sessions"
          className="absolute inset-x-0 bottom-full max-h-48 overflow-y-auto border-t border-border/60 bg-background py-1"
        >
          {matches.map((match, index) => (
            <SessionMatchRow key={match.key} label={match} selected={index === selected} />
          ))}
        </div>
      ) : null}
      <span aria-hidden="true" className="text-muted-foreground">
        :
      </span>
      <input
        ref={inputRef}
        aria-label="Command"
        value={state.text}
        onChange={(event) => setState(editExLine(event.target.value))}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoComplete="off"
        className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none"
      />
      {state.message ? (
        <span role="alert" className="shrink-0 truncate text-destructive">
          {state.message}
        </span>
      ) : null}
    </div>
  );
}
