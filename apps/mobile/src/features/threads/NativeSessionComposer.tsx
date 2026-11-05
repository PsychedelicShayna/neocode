import { useNavigation } from "@react-navigation/native";
import {
  nativeCommandNeedsTerminal,
  type NativeCommandCompletion,
  type NativeSessionTarget,
  type NativeSlashCommand,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { useState, type ReactNode } from "react";
import { Keyboard, ScrollView, View } from "react-native";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ComposerEditor } from "../../components/ComposerEditor";
import { ComposerActionButton, ComposerToolbarRow } from "../../components/ComposerToolbar";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { MaterialButton } from "../../components/MaterialButton";
import type { ComposerDocumentAttachment } from "../../lib/composerContext";
import { composerStripAttachments } from "../../lib/composerImages";
import type { useNativeComposerState } from "../../state/use-native-composer-state";
import { fileRoutePathSegments } from "../files/filePath";
import {
  ComposerDictationCancelAction,
  ComposerDictationPrimaryAction,
  ComposerDictationStatus,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import { NativeError } from "./NativeNeoPiControls";
import { useComposerCommandMenu } from "./use-composer-command-menu";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import { ComposerSurface } from "./ThreadComposer";
import { selectNativeSlashSuggestion } from "./nativeSlashSuggestion";

/** Stock mobile editor, context chips, media viewers and dictation without a SQL thread adapter. */
export function NativeSessionComposer({
  target,
  cwd,
  composer,
  busy,
  commands,
  argumentCommand,
  argumentSuggestions,
  attachment,
  workspaceControls,
  onStop,
}: {
  target: NativeSessionTarget;
  cwd: string | null;
  composer: ReturnType<typeof useNativeComposerState>;
  busy: boolean;
  commands: readonly NativeSlashCommand[];
  argumentCommand: string | null;
  argumentSuggestions: readonly NativeCommandCompletion[];
  attachment: "owned" | "terminal" | undefined;
  workspaceControls: ReactNode;
  onStop: () => void;
}) {
  const navigation = useNavigation();
  const menu = useComposerCommandMenu({
    draftMessage: composer.draft.text,
    ownerKey: composer.key,
    environmentId: target.environmentId,
    projectCwd: cwd,
    selectedProviderStatus:
      composer.serverConfig?.providers.find(
        (provider) => provider.instanceId === target.ref.providerInstanceId,
      ) ?? null,
    hasThread: false,
    hasCompactableConversation: false,
    onChangeDraftMessage: composer.setText,
  });
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const voice = useVoiceInputController({
    ownerKey: composer.key,
    draftMessage: composer.draft.text,
    selection: menu.selection,
    onChangeDraftMessage: composer.setText,
    onChangeSelection: menu.onSelectionChange,
  });
  const voicePresentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const showVoice = voicePresentation.statusLabel !== null;
  const send = () => {
    if (!voice.blocksSubmission) void composer.send();
  };
  const openDocument = (attachment: ComposerDocumentAttachment) => {
    Keyboard.dismiss();
    navigation.navigate("ThreadAttachment", {
      environmentId: target.environmentId,
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: String(attachment.sizeBytes),
      draftKey: composer.key,
    });
  };
  const supportsFiles =
    composer.serverConfig?.environment.capabilities.attachmentUploads === true &&
    Boolean(composer.serverConfig.environment.capabilities.fileAttachments);
  return (
    <>
      {!voice.isBusy && commands.length ? (
        <ScrollView horizontal>
          {commands.map((command) => (
            <MaterialButton
              key={command.name}
              label={[
                `/${command.name}`,
                command.input?.hint,
                nativeCommandNeedsTerminal(command, attachment) ? "· terminal only" : undefined,
              ]
                .filter(Boolean)
                .join(" ")}
              tone="text"
              onPress={() =>
                selectNativeSlashSuggestion(voice.getCurrentState, composer, `/${command.name} `)
              }
            />
          ))}
        </ScrollView>
      ) : null}
      {!voice.isBusy && argumentCommand && argumentSuggestions.length ? (
        <ScrollView horizontal>
          {argumentSuggestions.map((item) => (
            <MaterialButton
              key={item.value}
              label={item.label}
              tone="text"
              onPress={() =>
                selectNativeSlashSuggestion(
                  voice.getCurrentState,
                  composer,
                  `/${argumentCommand} ${item.value}`,
                  item.submitsCommand,
                )
              }
            />
          ))}
        </ScrollView>
      ) : null}
      {workspaceControls}
      <NativeError message={composer.error ?? composer.blockReason} />
      {!voice.isBusy &&
      menu.trigger &&
      (menu.trigger.kind === "path" ||
        menu.trigger.kind === "skill" ||
        menu.trigger.kind === "pull-request") &&
      (menu.items.length > 0 || menu.trigger.kind === "pull-request") ? (
        <ComposerCommandPopover
          items={menu.items}
          triggerKind={menu.trigger.kind}
          isLoading={menu.isLoading}
          error={menu.error}
          onSelect={menu.onSelect}
        />
      ) : null}
      <ComposerSurface
        style={{ borderRadius: 26, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}
      >
        {composer.draft.attachments.length ? (
          <ComposerAttachmentStrip
            environmentId={target.environmentId}
            attachments={composerStripAttachments(composer.draft.attachments)}
            onRemove={voice.isBusy ? () => undefined : composer.removeAttachment}
            onPressPreview={voice.isBusy ? undefined : setPreviewFile}
            onPressVideo={
              voice.isBusy
                ? undefined
                : (attachment, sourceIdentifier) =>
                    setPreviewVideo({ type: "local", attachment, sourceIdentifier })
            }
            onPressDocument={
              voice.isBusy
                ? undefined
                : (attachment) =>
                    openDocument({
                      attachmentId: attachment.id,
                      name: attachment.name,
                      mimeType: attachment.mimeType,
                      sizeBytes: attachment.sizeBytes,
                    })
            }
          />
        ) : null}
        <ComposerEditor
          draftKey={composer.key}
          environmentId={target.environmentId}
          value={composer.draft.text}
          multiline
          readOnly={voice.freezesEditor}
          skills={menu.skills}
          selection={menu.selection}
          onSelectionChange={menu.onSelectionChange}
          onChangeText={composer.setText}
          onPasteImages={(uris) => void composer.pasteImages(uris)}
          onPasteText={(paste) => void composer.pasteText(paste)}
          onOpenAttachment={openDocument}
          onOpenMention={
            cwd === null
              ? undefined
              : (path) => {
                  Keyboard.dismiss();
                  navigation.navigate("ThreadFile", {
                    environmentId: target.environmentId,
                    nativeRef: target.ref,
                    cwd,
                    path: fileRoutePathSegments(path),
                  });
                }
          }
          onSubmit={send}
          placeholder="Ask anything, or type / for commands"
          style={{ minHeight: 64, maxHeight: 192 }}
        />
        <ComposerToolbarRow paddingHorizontal={0} paddingTop={0} paddingBottom={0}>
          <ComposerDictationCancelAction presentation={voicePresentation} onCancel={voice.cancel} />
          {showVoice ? (
            <ComposerDictationStatus
              audioLevels={voice.audioLevels}
              elapsedSeconds={voice.elapsedSeconds}
              phase={voice.state.phase}
              presentation={voicePresentation}
              onDismissError={voice.cancel}
            />
          ) : (
            <View className="min-w-0 flex-1">
              <ComposerAttachmentButton
                disabled={voice.isBusy}
                supportsFiles={supportsFiles}
                onPickMedia={composer.pickMedia}
                onPickFiles={composer.pickFiles}
              />
            </View>
          )}
          <ComposerDictationPrimaryAction
            state={voice.state}
            presentation={voicePresentation}
            isAvailable={voice.isAvailable}
            onStart={voice.start}
            onConfirm={voice.stop}
            onCancel={voice.cancel}
          />
          {busy ? (
            <ComposerActionButton
              accessibilityLabel="Stop agent"
              icon="stop.fill"
              variant="danger"
              onPress={onStop}
            />
          ) : null}
          {voicePresentation.showsSend ? (
            <ComposerActionButton
              accessibilityLabel={
                composer.blockReason ??
                (composer.sending ? "Sending…" : busy ? "Queue follow-up" : "Send")
              }
              icon="arrow.up"
              variant="primary"
              disabled={!composer.canSend || voice.blocksSubmission}
              onPress={send}
            />
          ) : null}
        </ComposerToolbarRow>
      </ComposerSurface>
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
      <VideoPreviewModal source={previewVideo} onRequestClose={() => setPreviewVideo(null)} />
    </>
  );
}
