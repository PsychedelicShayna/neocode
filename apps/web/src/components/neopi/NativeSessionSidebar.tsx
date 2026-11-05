import { useNavigate, useRouter } from "@tanstack/react-router";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { AgentLabel } from "./AgentLabel";
import { agentIdentity, nativeSessionIdentityKey } from "@t3tools/shared/agentNames";
import type { NativeSessionList } from "@t3tools/client-runtime/neopi-native-sessions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LockIcon, PlusIcon } from "lucide-react";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { isElectron } from "../../env";
import { selectOnboardingProvidersByDriver } from "../../onboarding/providerReadiness.logic";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import {
  beginNativeSessionOpen,
  nativeSessionAtoms,
  selectNativeSession,
  useNativeSessionSelection,
} from "../../state/neopiNativeSessions";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarChromeHeader, SidebarChromeFooter } from "../sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { NativeEnvironmentAttentionList } from "./NativeSessionAttentionList";

export function useOpenNativeSession() {
  const open = useAtomCommand(nativeSessionAtoms.open, { reportFailure: false });
  const navigate = useNavigate();
  const router = useRouter();
  return useCallback(
    async (
      environmentId: EnvironmentId,
      input: { providerInstanceId: ProviderInstanceId; sessionFile?: string; cwd?: string },
    ) => {
      const isCurrent = beginNativeSessionOpen();
      const location = router.state.location;
      const response = await open({ environmentId, input });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      const target = { environmentId, ref: response.value.ref };
      if (isCurrent() && router.state.location === location) {
        selectNativeSession(target);
        await navigate({ to: "/" });
      }
      return target;
    },
    [navigate, open, router],
  );
}

export type OpenNativeSession = ReturnType<typeof useOpenNativeSession>;

export function useCreateNativeSession() {
  const configs = useServerConfigs();
  const primary = usePrimaryEnvironmentId();
  const selected = useNativeSessionSelection((state) => state.target);
  const open = useOpenNativeSession();
  const navigate = useNavigate();
  return useCallback(
    async (environmentId = selected?.environmentId ?? primary, cwd?: string) => {
      if (!environmentId) throw new Error("Connect an environment to start a session.");
      const config = configs.get(environmentId);
      if (!config) throw new Error("Connect to this computer before starting a NeoPi session.");
      const providers = config.providers.filter((provider) => provider.driver === "neopi");
      const selectedProvider =
        selected?.environmentId === environmentId
          ? providers.find((candidate) => candidate.instanceId === selected.ref.providerInstanceId)
          : undefined;
      const availableProviders = providers.filter(
        (provider) =>
          provider.enabled && provider.installed && provider.availability !== "unavailable",
      );
      const provider =
        availableProviders.find((candidate) => candidate === selectedProvider) ??
        availableProviders[0];
      if (!provider) {
        const setupProvider =
          selectedProvider ?? selectOnboardingProvidersByDriver(providers).get("neopi");
        await navigate({
          to: "/settings/neocore",
          search: {
            machine: environmentId,
            ...(setupProvider ? { instanceId: setupProvider.instanceId } : {}),
          },
        });
        return;
      }
      return open(environmentId, {
        providerInstanceId: provider.instanceId,
        ...(cwd ? { cwd } : {}),
      });
    },
    [configs, navigate, open, primary, selected],
  );
}

export function NativeSessionSidebar() {
  const { environments } = useEnvironments();
  const create = useCreateNativeSession();
  const open = useOpenNativeSession();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const saved = useThreadShells();
  const navigate = useNavigate();
  const start = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      await create();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        fixedHeader={
          <SidebarGroup>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Search native sessions"
                placeholder="Search sessions"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="New thread"
                disabled={creating}
                onClick={() => void start()}
              >
                <PlusIcon />
              </Button>
            </div>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </SidebarGroup>
        }
      >
        {environments.map((environment) => (
          <NativeEnvironmentAttentionList
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
            query={query}
            open={open}
          />
        ))}
        {saved.length ? (
          <SidebarGroup>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Saved workspaces and legacy history
              </summary>
              <SidebarMenu>
                {saved
                  .filter((thread) => thread.title.toLowerCase().includes(query.toLowerCase()))
                  .map((thread) => (
                    <SidebarMenuItem key={`${thread.environmentId}:${thread.id}`}>
                      <SidebarMenuButton
                        onClick={() =>
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: { environmentId: thread.environmentId, threadId: thread.id },
                          })
                        }
                      >
                        <span className="truncate">{thread.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
              </SidebarMenu>
            </details>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

// Rows mounted at first and added per step as the list scrolls near its end.
// Hundreds of sessions are normal; mounting all of them made sidebar resizing
// lay out every row on each frame.
const SESSION_ROWS_STEP = 60;

type NativeSessionEntry = NativeSessionList["sessions"][number];

const NativeSessionRow = memo(function NativeSessionRow({
  session,
  active,
  disabled,
  onChoose,
}: {
  session: NativeSessionEntry;
  active: boolean;
  disabled: boolean;
  onChoose: (session: NativeSessionEntry) => void;
}) {
  const locked = session.owner.kind === "process" && !session.owner.attachable;
  const identity = agentIdentity(
    nativeSessionIdentityKey({
      sessionId: session.sessionId,
      sessionFile: session.ref.sessionFile,
    }),
  );
  return (
    <SidebarMenuItem className="[contain-intrinsic-size:auto_2rem] [content-visibility:auto]">
      <SidebarMenuButton
        isActive={active}
        disabled={disabled || locked}
        onClick={() => onChoose(session)}
      >
        <span className="min-w-0 flex-1 truncate">
          {session.title ?? (session.firstMessage || "New session")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {locked ? (
            <LockIcon className="size-3 text-icon-muted" aria-label="In use by another process" />
          ) : null}
          <AgentLabel identity={identity} />
          <span className="text-3xs tabular-nums text-secondary-label">
            {formatRelativeTimeLabel(session.modifiedAt)}
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});

export function NativeEnvironmentSessions({
  environmentId,
  label,
  query,
  onSelect,
}: {
  environmentId: EnvironmentId;
  label?: string;
  query: string;
  onSelect?: () => void;
}) {
  const result = useEnvironmentQuery(nativeSessionAtoms.list({ environmentId, input: {} }));
  const refresh = result.refresh;
  useEffect(() => {
    // Native terminal owners can create sessions without a NeoCode mutation.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const open = useOpenNativeSession();
  const selected = useNativeSessionSelection((state) => state.target);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards a second click synchronously; `pending` only drives the disabled rows.
  const pendingRef = useRef(false);
  const chooseSession = useCallback(
    async (session: NativeSessionEntry) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(session.ref.sessionFile);
      setError(null);
      try {
        await open(environmentId, session.ref);
        onSelect?.();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pendingRef.current = false;
        setPending(null);
      }
    },
    [environmentId, onSelect, open],
  );
  const sessions = result.data?.sessions;
  const matching = useMemo(() => {
    const needle = query.toLowerCase();
    if (!sessions || !needle) return sessions ?? [];
    return sessions.filter((session) =>
      `${session.title ?? ""} ${session.firstMessage} ${session.cwd}`
        .toLowerCase()
        .includes(needle),
    );
  }, [sessions, query]);
  // The window belongs to one query; a new search starts from the first step.
  const [shown, setShown] = useState({ query, limit: SESSION_ROWS_STEP });
  const limit = shown.query === query ? shown.limit : SESSION_ROWS_STEP;
  const hasMore = matching.length > limit;
  // Keyed by `limit`, so each step mounts a fresh sentinel and observes it again
  // even when it is still on screen after the rows above it grew.
  const sentinel = useCallback(
    (element: HTMLLIElement | null) => {
      if (!element) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          setShown((current) => ({
            query,
            limit:
              (current.query === query ? current.limit : SESSION_ROWS_STEP) + SESSION_ROWS_STEP,
          }));
        },
        {
          root: element.closest("[data-slot=scroll-area-viewport]"),
          rootMargin: "0px 0px 600px 0px",
        },
      );
      observer.observe(element);
      return () => observer.disconnect();
    },
    [query],
  );
  const choose = useCallback(
    (session: NativeSessionEntry) => void chooseSession(session),
    [chooseSession],
  );
  return (
    <SidebarGroup>
      {label ? (
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{label}</p>
      ) : null}
      {result.error || error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? result.error}
        </p>
      ) : null}
      {result.data?.diagnostics.map((item, index) => (
        <p key={index} className="text-xs text-muted-foreground">
          {item.providerInstanceId}: {item.message}
        </p>
      ))}
      <SidebarMenu>
        {matching.slice(0, limit).map((session) => (
          <NativeSessionRow
            key={`${session.ref.providerInstanceId}:${session.ref.sessionFile}`}
            session={session}
            active={
              selected?.environmentId === environmentId &&
              selected.ref.providerInstanceId === session.ref.providerInstanceId &&
              selected.ref.sessionFile === session.ref.sessionFile
            }
            disabled={pending !== null}
            onChoose={choose}
          />
        ))}
        {hasMore ? <li key={limit} ref={sentinel} aria-hidden className="h-px" /> : null}
      </SidebarMenu>
      {!result.data && result.isPending ? (
        <p className="text-xs text-muted-foreground">Reading sessions…</p>
      ) : null}
    </SidebarGroup>
  );
}
