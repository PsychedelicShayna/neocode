import { useAtomValue } from "@effect/atom-react";
import type { AgentHubAgent, AgentHubSource } from "@t3tools/client-runtime/neopi-native-agent-hub";
import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import { formatSubagentModelLabel } from "@t3tools/client-runtime/state/subagentRuntime";
import { ArrowLeftIcon, ZapIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  EMPTY_SERVER_PROVIDERS,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "~/state/server";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ComposerSurface } from "../../chat/ComposerSurface";
import { ExpandedImageDialog } from "../../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../../chat/ExpandedImagePreview";
import type { NativeModelChoice } from "../../chat/neopiModelSwitcher";
import { NativeSessionModelPicker } from "../NativeSessionModelPicker";
import { NativeTimelineView, nativeTimelineKey } from "../NativeTimelineView";
import { AgentElapsed, AgentStatusDot, agentStatusLabel } from "./AgentRoster";
import { EFFORT_LEVELS } from "./agentFormat";
import { selectAgentView, useAgentViewStore } from "./agentViewStore";
import { useAgentTranscript } from "./useAgentTranscript";
import { useAgentHubSource } from "./useNativeAgentHubSource";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function AgentControls({
  target,
  agent,
  source,
  onError,
}: {
  target: NativeSessionTarget;
  agent: AgentHubAgent;
  source: AgentHubSource;
  onError: (message: string | null) => void;
}) {
  const settings = useEnvironmentSettings(target.environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const [modelOpen, setModelOpen] = useState(false);
  const run = (action: Promise<void>) => {
    onError(null);
    void action.catch((cause) => onError(message(cause)));
  };
  const efforts =
    agent.effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(agent.effort)
      ? [...EFFORT_LEVELS, agent.effort]
      : EFFORT_LEVELS;
  const controllable = agent.live;
  const selectModel = (choice: NativeModelChoice) => {
    setModelOpen(false);
    run(
      source.setModel(
        agent.id,
        choice.kind === "role"
          ? { kind: "role", role: choice.role }
          : { kind: "model", provider: choice.provider, modelId: choice.modelId },
      ),
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <NativeSessionModelPicker
        target={target}
        providers={serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS}
        settings={settings}
        keybindings={keybindings}
        modelLabel={formatSubagentModelLabel(agent.model, null) ?? "Model"}
        modelSelector={agent.model ?? ""}
        displayState={null}
        open={modelOpen}
        onOpenChange={setModelOpen}
        disabled={!controllable || source.modelControlUnavailable !== null}
        terminalOpen={false}
        onSelect={selectModel}
      />
      {source.modelControlUnavailable !== null ? (
        <span className="text-2xs text-muted-foreground">{source.modelControlUnavailable}</span>
      ) : null}
      <Select
        value={agent.effort ?? ""}
        onValueChange={(value) => {
          if (typeof value === "string" && value) run(source.setEffort(agent.id, value));
        }}
      >
        <SelectTrigger
          size="xs"
          className="w-auto min-w-0"
          aria-label="Effort"
          disabled={!controllable}
        >
          <SelectValue>{agent.effort ? `Effort: ${agent.effort}` : "Effort"}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {efforts.map((level) => (
            <SelectItem hideIndicator key={level} value={level}>
              {level}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {agent.fast !== null ? (
        <Button
          size="xs"
          variant="outline"
          aria-pressed={agent.fast.enabled}
          disabled={!controllable}
          onClick={() => run(source.setFast(agent.id, !agent.fast?.enabled))}
        >
          <ZapIcon aria-hidden className={agent.fast.enabled ? "text-warning" : undefined} />
          Fast {agent.fast.enabled ? "on" : "off"}
        </Button>
      ) : null}
      {agent.live ? (
        <Button size="xs" variant="outline" onClick={() => run(source.cancel(agent.id))}>
          Stop
        </Button>
      ) : null}
    </div>
  );
}

function AgentComposer({
  agent,
  source,
  onSent,
  onEscapeToView,
}: {
  agent: AgentHubAgent;
  source: AgentHubSource;
  onSent: () => void;
  onEscapeToView: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { id, live } = agent;
  useEffect(() => {
    if (live) inputRef.current?.focus({ preventScroll: true });
  }, [live]);
  const send = () => {
    const body = text.trim();
    if (!body || sending || !live) return;
    setSending(true);
    setError(null);
    source
      .steer(id, body)
      .then(() => {
        setText("");
        onSent();
      })
      .catch((cause) => setError(message(cause)))
      .finally(() => setSending(false));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape" && text.length > 0) {
      // A drafted steer survives the first Escape; the next one leaves the agent.
      event.preventDefault();
      event.stopPropagation();
      onEscapeToView();
    }
  };
  return (
    <ComposerSurface.Shell className="shrink-0">
      <ComposerSurface.Host className="flex flex-col gap-1 p-1.5">
        <Textarea
          unstyled
          ref={inputRef}
          className="w-full"
          disabled={!live}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            live
              ? "Steer this agent (Enter to send, Shift+Enter for a new line)"
              : "This agent is not running, so it cannot be steered."
          }
          aria-label="Steer agent"
          data-agent-composer
        />
        <div className="flex items-center justify-between gap-2 px-1.5 pb-0.5">
          <span
            role={error ? "alert" : undefined}
            className="min-w-0 truncate text-2xs text-muted-foreground"
          >
            {error ? (
              <span className="text-destructive-foreground">{error}</span>
            ) : (
              "Steering applies at the agent's next step."
            )}
          </span>
          <Button size="xs" disabled={!live || sending || text.trim().length === 0} onClick={send}>
            Steer
          </Button>
        </div>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}

/**
 * One agent, as the main view: its full transcript on the stock timeline, a composer that
 * steers it, and its model, effort and fast controls. Esc returns.
 */
export function NativeAgentView({
  target,
  viewKey,
  cwd,
  onBack,
}: {
  target: NativeSessionTarget;
  viewKey: string;
  cwd: string | null;
  onBack: () => void;
}) {
  const source = useAgentHubSource();
  const view = useAgentViewStore(selectAgentView(viewKey));
  const agent = source.agents.find((candidate) => candidate.id === view.selectedId) ?? null;
  const { rows, loading, error: readError } = useAgentTranscript(source, agent);
  const [controlError, setControlError] = useState<string | null>(null);
  const [followSignal, setFollowSignal] = useState(0);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const missing = agent === null;
  useEffect(() => {
    // The composer takes focus itself while the agent runs; otherwise the view owns the keyboard.
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  }, [missing]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // Portaled popups bubble through React; only keys typed inside this view count.
    if (!event.currentTarget.contains(event.target as Node)) return;
    // An open popup (the model picker, the effort list) owns its own Escape.
    if (
      document.querySelector(
        '[data-slot="select-popup"],[data-slot="popover-popup"],[data-slot="menu-popup"],[data-slot="dialog-popup"]',
      )
    )
      return;
    event.preventDefault();
    onBack();
  };
  const error = controlError ?? readError;
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="region"
      aria-label="Agent"
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 px-3 py-2">
        <Button size="xs" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon aria-hidden />
          Back
          <Kbd>Esc</Kbd>
        </Button>
        {agent ? (
          <>
            <div className="flex min-w-0 flex-1 basis-48 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <AgentStatusDot status={agent.status} />
                <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
                <span className="shrink-0 text-2xs text-muted-foreground/70">
                  {agent.identity.label} · {agent.identity.pronouns}
                </span>
                {agent.role ? (
                  <span className="shrink-0 rounded-sm border border-border/60 px-1 text-3xs text-muted-foreground">
                    {agent.role}
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                <span>{agentStatusLabel(agent.status)}</span>
                <AgentElapsed agent={agent} />
              </span>
            </div>
            <AgentControls
              target={target}
              agent={agent}
              source={source}
              onError={setControlError}
            />
          </>
        ) : (
          <span className="text-sm text-muted-foreground">This agent is no longer listed.</span>
        )}
      </header>
      {error ? (
        <p role="alert" className="shrink-0 px-4 py-1 text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {agent ? (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col">
            {rows.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground">
                {loading ? "Reading transcript…" : "Nothing in this agent's transcript yet."}
              </p>
            ) : (
              <NativeTimelineView
                rows={rows}
                busy={agent.live}
                assistantName={agent.identity.label}
                environmentId={target.environmentId}
                timelineKey={nativeTimelineKey(
                  target.environmentId,
                  `${target.ref.sessionFile}#agent=${agent.id}`,
                )}
                cwd={cwd ?? undefined}
                loadEarlier={null}
                followSignal={followSignal}
                onImageExpand={setExpandedImage}
              />
            )}
          </div>
          <AgentComposer
            key={agent.id}
            agent={agent}
            source={source}
            onSent={() => setFollowSignal((value) => value + 1)}
            onEscapeToView={() => rootRef.current?.focus()}
          />
        </>
      ) : null}
      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
    </div>
  );
}
