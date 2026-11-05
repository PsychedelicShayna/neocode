import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ChatAttachmentId, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { workspaceKey } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../composerDraftStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { relocateNativeWorkspace } from "./nativeWorkspaceRelocation";
import {
  readThreadPreviewState,
  rememberPreviewUrl,
  resetPreviewStateForTests,
} from "../previewStateStore";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";

const from = {
  environmentId: EnvironmentId.make("host-a"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: "/sessions/before.jsonl",
  },
};
const to = { ...from, ref: { ...from.ref, sessionFile: "/worktrees/topic/session.jsonl" } };
const other = { ...from, environmentId: EnvironmentId.make("host-b") };

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, backgroundSubmissionThreadKeys: {} });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  resetPreviewStateForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("native workspace relocation", () => {
  it("moves the complete unsent draft and tool-panel choices without affecting another environment", () => {
    useComposerDraftStore.getState().setPrompt(from, "Unsent before /wt");
    useComposerDraftStore.getState().setPrompt(other, "Other host");
    useComposerDraftStore.getState().addImage(from, {
      type: "image",
      id: ChatAttachmentId.make("local-image"),
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 5,
      previewUrl: "blob:retained-image",
      file: new File(["image"], "image.png", { type: "image/png" }),
    });
    useRightPanelStore.getState().openFile(from, "src/example.ts", 17);
    useRightPanelStore.getState().openTerminal(from, "terminal-2");
    useTerminalUiStateStore.getState().setTerminalOpen(from, true);
    useDiffPanelStore.getState().selectBranchBaseRef(from, "main");
    rememberPreviewUrl(from, "http://localhost:3000/before-move");
    usePreviewMiniPlayerStore.getState().open(from, { kind: "browser", tabId: "old-tab" });
    const draft = useComposerDraftStore.getState().getComposerDraft(from);
    const panel = useRightPanelStore.getState().byThreadKey[workspaceKey(from)];
    const terminal =
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[workspaceKey(from)];

    relocateNativeWorkspace(from, to);

    expect(useComposerDraftStore.getState().getComposerDraft(to)).toBe(draft);
    expect(useComposerDraftStore.getState().getComposerDraft(from)).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(other)?.prompt).toBe("Other host");
    expect(useRightPanelStore.getState().byThreadKey[workspaceKey(to)]).toBe(panel);
    expect(useRightPanelStore.getState().byThreadKey[workspaceKey(from)]).toBeUndefined();
    expect(useTerminalUiStateStore.getState().terminalUiStateByThreadKey[workspaceKey(to)]).toBe(
      terminal,
    );
    expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[workspaceKey(to)]).toBe("main");
    expect(readThreadPreviewState(to).recentlySeenUrls).toContain(
      "http://localhost:3000/before-move",
    );
    expect(usePreviewMiniPlayerStore.getState().byThreadKey[workspaceKey(from)]).toBeUndefined();
    relocateNativeWorkspace(from, to);
    expect(useComposerDraftStore.getState().getComposerDraft(to)).toBe(draft);
  });

  it("retains independently edited destination content and panel tabs", () => {
    useComposerDraftStore.getState().setPrompt(from, "Moving draft");
    useComposerDraftStore.getState().setPrompt(to, "Destination draft");
    useRightPanelStore.getState().openFile(from, "source.ts");
    useRightPanelStore.getState().openFile(to, "destination.ts");
    relocateNativeWorkspace(from, to);
    expect(useComposerDraftStore.getState().getComposerDraft(to)?.prompt).toBe(
      "Moving draft\n\nDestination draft",
    );
    expect(useRightPanelStore.getState().byThreadKey[workspaceKey(to)]?.surfaces).toHaveLength(2);
    expect(useComposerDraftStore.getState().getComposerDraft(from)).toBeNull();
  });
});
