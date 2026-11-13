import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { MouseEvent } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  useFailedSendDraftStore,
  type SubmittedComposerDraft,
} from "./chat/failedSendDraftRecovery";
import { FailedSendDraftRecovery } from "./FailedSendDraftRecovery";
import type { ToastManagerAddOptions } from "@base-ui/react/toast";
import type { ThreadToastData } from "./ui/toast";

type RecoveryToast = ToastManagerAddOptions<ThreadToastData>;
type SubmissionOutcomes = Parameters<
  ReturnType<typeof useFailedSendDraftStore.getState>["reconcile"]
>[1];
const io = vi.hoisted(() => ({
  outcomes: {} as Record<string, SubmissionOutcomes>,
  statuses: {} as Record<string, string>,
  listeners: new Set<() => void>(),
  add: vi.fn<(options: RecoveryToast) => string>(),
  close: vi.fn(),
  update: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../state/entities", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    io.listeners.add(listener);
    return () => io.listeners.delete(listener);
  };
  return {
    useQuietThreadProjection: (target: ScopedThreadRef | null) => {
      const projection = useSyncExternalStore(subscribe, () =>
        target ? io.outcomes[scopedThreadKey(target)] : undefined,
      );
      return projection ? { projection } : null;
    },
    useThreadStatus: (target: ScopedThreadRef | null) =>
      useSyncExternalStore(subscribe, () =>
        target ? (io.statuses[scopedThreadKey(target)] ?? "live") : "empty",
      ),
  };
});
vi.mock("@tanstack/react-router", async (load) => ({
  ...(await load<typeof import("@tanstack/react-router")>()),
  useNavigate: () => io.navigate,
}));
vi.mock("./ui/toast", async () => ({
  ...(await import("./ui/toastHelpers")),
  toastManager: { add: io.add, close: io.close, update: io.update },
}));

const target = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("original"));
const destination = scopeThreadRef(EnvironmentId.make("remote"), target.threadId);
const key = scopedThreadKey(target);
const submitted: SubmittedComposerDraft = {
  prompt: "Original unsent prompt",
  images: [],
  files: [],
  terminalContexts: [],
  previewAnnotations: [],
  reviewComments: [],
  threadContexts: [],
  environmentContexts: [],
};
const outcome = (inputAccepted = false): SubmissionOutcomes => ({
  runs: [
    {
      id: RunId.make("run-a"),
      userMessageId: MessageId.make("send-a"),
      status: inputAccepted ? "completed" : "failed",
    },
  ],
  attempts: [
    {
      id: RunAttemptId.make("attempt-a"),
      runId: RunId.make("run-a"),
      rootNodeId: NodeId.make("root-a"),
    },
  ],
  providerTurns: [
    {
      runAttemptId: RunAttemptId.make("attempt-a"),
      nodeId: NodeId.make("root-a"),
      ...(inputAccepted ? { inputAccepted: true } : {}),
    },
  ],
});
function Shell({ route }: { route: string | null }) {
  return (
    <>
      <FailedSendDraftRecovery />
      {route ? <output>{route}</output> : null}
    </>
  );
}
function setup() {
  io.outcomes = { [key]: { runs: [], attempts: [], providerTurns: [] } };
  io.statuses = {};
  io.add.mockReset().mockReturnValue("recovery-toast");
  io.close.mockReset();
  io.update.mockReset();
  io.navigate.mockReset();
  useFailedSendDraftStore.setState({ submissionsByThreadKey: {} });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
}

async function publish(update: () => void) {
  await act(() => {
    update();
    for (const listener of io.listeners) listener();
  });
}

describe("root-owned failed-send recovery", () => {
  it.each([null, scopedThreadKey(destination)])(
    "restores only the origin after its composer unmounts for route %s",
    async (route) => {
      setup();
      useComposerDraftStore.getState().setPrompt(destination, "Destination work");
      useFailedSendDraftStore.getState().capture(target, "send-a", submitted);
      await using screen = await render(<Shell route={key} />);
      await screen.rerender(<Shell route={route} />);
      await publish(() => {
        io.outcomes[key] = outcome();
      });
      await screen.rerender(<Shell route={route} />);
      expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
        submitted.prompt,
      );
      expect(useComposerDraftStore.getState().getComposerDraft(destination)?.prompt).toBe(
        "Destination work",
      );
      expect(useFailedSendDraftStore.getState().submissionsByThreadKey).toEqual({});
      expect(io.navigate).not.toHaveBeenCalled();
    },
  );

  it("retains a guarded Restore notice across navigation without overwriting whitespace", async () => {
    setup();
    useComposerDraftStore.getState().setPrompt(target, " \n");
    useComposerDraftStore.getState().setPrompt(destination, "Destination work");
    useFailedSendDraftStore.getState().capture(target, "send-a", submitted);
    await using screen = await render(<Shell route={key} />);
    await publish(() => {
      io.outcomes[key] = outcome();
    });
    await screen.rerender(<Shell route={null} />);
    const notice = io.add.mock.calls[0]![0];
    await act(() => notice.actionProps?.onClick?.({} as MouseEvent<HTMLButtonElement>));
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(" \n");
    expect(io.navigate).not.toHaveBeenCalled();
    await screen.rerender(<Shell route={scopedThreadKey(destination)} />);
    await act(() => useComposerDraftStore.getState().clearComposerContent(target));
    await act(() => notice.actionProps?.onClick?.({} as MouseEvent<HTMLButtonElement>));
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      submitted.prompt,
    );
    expect(useComposerDraftStore.getState().getComposerDraft(destination)?.prompt).toBe(
      "Destination work",
    );
    expect(useFailedSendDraftStore.getState().submissionsByThreadKey).toEqual({});
    expect(io.navigate).toHaveBeenCalledTimes(1);
  });

  it("releases an accepted send without a mounted composer or rescanning stable recovery collections", async () => {
    setup();
    let traversals = 0;
    const pending = outcome();
    const providerTurns = new Proxy(pending.providerTurns, {
      get: (array, property, receiver) => {
        if (property === Symbol.iterator) traversals++;
        return Reflect.get(array, property, receiver);
      },
    });
    io.outcomes[key] = {
      ...pending,
      runs: [{ ...pending.runs[0]!, status: "running" }],
      providerTurns,
    };
    useFailedSendDraftStore.getState().capture(target, "send-a", submitted);
    await using screen = await render(<Shell route={null} />);
    expect(traversals).toBeGreaterThan(0);
    traversals = 0;
    await screen.rerender(<Shell route={null} />);
    await screen.rerender(<Shell route={null} />);
    expect(traversals).toBe(0);
    await publish(() => {
      io.outcomes[key] = outcome(true);
    });
    await screen.rerender(<Shell route={null} />);
    expect(useFailedSendDraftStore.getState().submissionsByThreadKey).toEqual({});
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
    expect(io.add).not.toHaveBeenCalled();
  });

  it.each(["dismiss", "delete"])(
    "disposes retained recovery on explicit %s without changing the newer draft",
    async (action) => {
      setup();
      useComposerDraftStore.getState().setPrompt(target, "Newer draft");
      useFailedSendDraftStore.getState().capture(target, "send-a", submitted);
      io.outcomes[key] = outcome();
      await using screen = await render(<Shell route={null} />);
      if (action === "dismiss") {
        await act(() => io.add.mock.calls[0]![0].onClose?.());
      } else {
        await publish(() => {
          io.statuses[key] = "deleted";
        });
        await screen.rerender(<Shell route={null} />);
      }
      expect(useFailedSendDraftStore.getState().submissionsByThreadKey).toEqual({});
      expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("Newer draft");
      expect(io.close).toHaveBeenCalled();
    },
  );
});
