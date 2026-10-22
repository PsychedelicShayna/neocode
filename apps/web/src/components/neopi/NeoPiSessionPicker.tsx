import type {
  NeoPiSessionScope,
  NeoPiSessionSummary,
  ProjectId,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import { neopiSessionList, neopiSessionResume } from "../../state/neopiSessions";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import { filterNeoPiSessions, neopiSessionRowState } from "@t3tools/client-runtime/neopi-sessions";

type PendingRestoration = {
  readonly session: NeoPiSessionSummary;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly phase: "loading-project" | "resume" | "resuming" | "loading-thread" | "navigating";
};

export function NeoPiSessionPicker({
  target,
  onClose,
}: {
  target: ScopedProjectRef;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<NeoPiSessionScope>("project");
  const [query, setQuery] = useState("");
  const [restoration, setRestoration] = useState<PendingRestoration | null>(null);
  const activeRestoration = useRef<PendingRestoration | null>(null);
  const pending = restoration !== null;
  const [error, setError] = useState<string | null>(null);
  const result = useEnvironmentQuery(
    neopiSessionList({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, scope },
    }),
  );
  const { refresh } = result;
  // The list is keyed by scope; refresh so reopening never shows a stale owner state.
  useEffect(() => {
    refresh();
  }, [refresh]);
  const resume = useAtomCommand(neopiSessionResume, { reportFailure: false });
  const navigate = useNavigate();
  const threadState = useEnvironmentThread(
    pending ? target.environmentId : null,
    restoration?.threadId ?? null,
  );
  useEffect(
    () => () => {
      activeRestoration.current = null;
    },
    [],
  );

  useEffect(() => {
    if (restoration === null || activeRestoration.current !== restoration) return;

    const replace = (next: PendingRestoration | null) => {
      if (activeRestoration.current !== restoration) return false;
      activeRestoration.current = next;
      setRestoration(next);
      return true;
    };
    const fail = (cause: unknown) => {
      if (replace(null)) {
        setError(cause instanceof Error ? cause.message : "Unable to resume this NeoPi session.");
      }
    };
    if (restoration.phase === "resume" && restoration.projectId !== null) {
      const projectId = restoration.projectId;
      const inFlight: PendingRestoration = { ...restoration, phase: "resuming" };
      if (!replace(inFlight)) return;
      void (async () => {
        try {
          const resumed = await resume({
            environmentId: target.environmentId,
            input: {
              projectId,
              sessionFile: restoration.session.sessionFile,
              providerInstanceId: restoration.session.providerInstanceId,
            },
          });
          if (activeRestoration.current !== inFlight) return;
          if (resumed._tag === "Failure") {
            if (!isAtomCommandInterrupted(resumed)) throw squashAtomCommandFailure(resumed);
            activeRestoration.current = null;
            setRestoration(null);
            return;
          }
          const next: PendingRestoration = {
            ...inFlight,
            phase: "loading-thread",
            threadId: resumed.value.threadId,
          };
          activeRestoration.current = next;
          setRestoration(next);
        } catch (cause) {
          if (activeRestoration.current !== inFlight) return;
          activeRestoration.current = null;
          setRestoration(null);
          setError(cause instanceof Error ? cause.message : "Unable to resume this NeoPi session.");
        }
      })();
      return;
    }
    if (restoration.phase !== "loading-project" && restoration.phase !== "loading-thread") return;
    if (threadState.status === "deleted") {
      fail(new Error("The bound NeoCode thread was deleted."));
      return;
    }
    if (Option.isSome(threadState.error)) {
      fail(new Error(threadState.error.value));
      return;
    }
    if (Option.isNone(threadState.data) || threadState.data.value.id !== restoration.threadId) {
      return;
    }
    const thread = threadState.data.value;
    if (restoration.phase === "loading-project") {
      replace({ ...restoration, projectId: thread.projectId, phase: "resume" });
      return;
    }

    const navigating: PendingRestoration = { ...restoration, phase: "navigating" };
    if (!replace(navigating)) return;
    void (async () => {
      try {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(target.environmentId, thread.id)),
        });
        if (activeRestoration.current !== navigating) return;
        activeRestoration.current = null;
        setRestoration(null);
        onClose();
      } catch (cause) {
        if (activeRestoration.current !== navigating) return;
        activeRestoration.current = null;
        setRestoration(null);
        setError(cause instanceof Error ? cause.message : "Unable to open this NeoCode thread.");
      }
    })();
  }, [restoration, threadState, resume, navigate, target.environmentId, onClose]);
  const sessions =
    result.data?.status === "available" ? filterNeoPiSessions(result.data.sessions, query) : [];

  function select(session: NeoPiSessionSummary) {
    const state = neopiSessionRowState(session);
    if (activeRestoration.current !== null || state.disabledReason) return;
    const next: PendingRestoration = {
      session,
      // Unregistered folders use the selected project only as request context.
      // The server resolves the native cwd before choosing or creating a project.
      projectId: session.projectId ?? (state.threadId === null ? target.projectId : null),
      threadId: state.threadId,
      phase: session.projectId === null && state.threadId !== null ? "loading-project" : "resume",
    };
    activeRestoration.current = next;
    setRestoration(next);
    setError(null);
  }

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          activeRestoration.current = null;
          setRestoration(null);
          onClose();
        }
      }}
    >
      <CommandDialogPopup aria-label="Resume NeoPi session">
        <div className="flex items-center justify-between gap-3 px-4 pt-4">
          <h2 className="font-medium">Resume NeoPi session</h2>
          <Button
            size="xs"
            variant="ghost"
            onClick={refresh}
            disabled={pending || result.isPending}
          >
            Refresh
          </Button>
        </div>
        <div className="flex gap-2 px-4 py-2" role="group" aria-label="Session scope">
          <Button
            size="xs"
            variant={scope === "project" ? "secondary" : "ghost"}
            aria-pressed={scope === "project"}
            disabled={pending}
            onClick={() => setScope("project")}
          >
            This project
          </Button>
          <Button
            size="xs"
            variant={scope === "all" ? "secondary" : "ghost"}
            aria-pressed={scope === "all"}
            disabled={pending}
            onClick={() => setScope("all")}
          >
            All projects
          </Button>
        </div>
        <Command mode="none" value={query} onValueChange={setQuery}>
          <CommandInput
            placeholder="Search titles or first messages…"
            aria-label="Search NeoPi sessions"
          />
          <div className="max-h-72 overflow-y-auto" aria-busy={pending || result.isPending}>
            {error || result.error ? (
              <p role="alert" className="px-4 py-2 text-sm text-destructive">
                {error ?? result.error}
              </p>
            ) : null}
            {pending ? (
              <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
                {restoration.phase === "loading-project"
                  ? "Loading bound NeoCode thread…"
                  : restoration.phase === "loading-thread"
                    ? "Loading restored NeoCode thread…"
                    : restoration.phase === "navigating"
                      ? "Opening NeoCode thread…"
                      : "Restoring NeoPi session…"}
              </p>
            ) : null}
            {result.data?.diagnostics.map((diagnostic) => (
              <p
                key={diagnostic.providerInstanceId}
                role="alert"
                className="px-4 py-2 text-sm text-destructive"
              >
                {diagnostic.providerInstanceId}: {diagnostic.message}
              </p>
            ))}
            {result.data?.status === "unavailable" ? (
              result.data.diagnostics.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">{result.data.reason}</p>
              ) : null
            ) : result.data === null ? (
              <p role="status" className="px-4 py-6 text-sm text-muted-foreground">
                {result.error ? "Could not load sessions. Try Refresh." : "Loading sessions…"}
              </p>
            ) : sessions.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                {query.trim() ? "No matching sessions." : "No NeoPi sessions found."}
              </p>
            ) : (
              <CommandList>
                {sessions.map((session) => {
                  const state = neopiSessionRowState(session);
                  return (
                    <CommandItem
                      key={session.sessionFile}
                      value={session.sessionFile}
                      disabled={pending || state.disabledReason !== null}
                      onClick={() => {
                        void select(session);
                      }}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">{state.title}</span>
                          <Badge variant="outline">{state.ownerLabel}</Badge>
                        </div>
                        <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                          <time dateTime={session.modifiedAt}>
                            {formatRelativeTimeLabel(session.modifiedAt)}
                          </time>
                          <span>
                            {session.messageCount}{" "}
                            {session.messageCount === 1 ? "message" : "messages"}
                          </span>
                        </div>
                        {scope === "all" ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {session.cwd || "Unknown folder"}
                          </span>
                        ) : null}
                        {state.disabledReason ? (
                          <span className="text-xs text-muted-foreground">
                            {state.disabledReason}
                          </span>
                        ) : null}
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandList>
            )}
          </div>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
