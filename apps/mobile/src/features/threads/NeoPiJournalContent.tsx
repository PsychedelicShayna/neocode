import type {
  EnvironmentId,
  NeoPiJournalEntry,
  NeoPiNativeSessionRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { journalRecord, nativeJournalImageSource } from "@t3tools/client-runtime/neopi-journal";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import { stripLegacyAttachmentMetadata } from "@t3tools/shared/composerContextLegacy";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Alert, View } from "react-native";
import { Markdown } from "react-native-nitro-markdown";

import { AppText as Text } from "../../components/AppText";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type MarkdownImageRenderer,
} from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import {
  fileRoutePathSegments,
  isAbsolutePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";
import { NativeJson } from "./NativeNeoPiControls";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";

type ContentContext = {
  threadRef?: ScopedThreadRef;
  environmentId?: EnvironmentId;
  nativeRef?: NeoPiNativeSessionRef;
  userContent?: boolean;
  cwd: string | null;
};

function NativeMarkdown({
  text,
  threadRef,
  environmentId: explicitEnvironmentId,
  nativeRef,
  cwd,
  userContent,
}: ContentContext & { text: string }) {
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const [video, setVideo] = useState<VideoPreviewSource | null>(null);
  const environmentId = threadRef?.environmentId ?? explicitEnvironmentId;
  const navigation = useNavigation();
  const openLink = useCallback(
    (href: string) => {
      if (environmentId) {
        const media = resolveMarkdownMediaPreview(href, {
          environmentId,
          ...(threadRef ? { threadId: threadRef.threadId } : {}),
          ...(nativeRef ? { nativeRef } : {}),
          workspaceRoot: cwd,
        });
        if (media?.kind === "image") {
          setPreview(media.source);
          return;
        }
        if (media?.kind === "video") {
          setVideo(media.source);
          return;
        }
      }
      const link = resolveMarkdownLinkPresentation(href);
      if (link.kind === "file") {
        const path =
          resolveWorkspaceRelativeFilePath(cwd, link.path) ??
          (isAbsolutePath(link.path) ? link.path : null);
        if (path && environmentId) {
          navigation.navigate("ThreadFile", {
            environmentId: String(environmentId),
            ...(threadRef ? { threadId: String(threadRef.threadId) } : { cwd: cwd ?? "/" }),
            ...(nativeRef ? { nativeRef } : {}),
            path: fileRoutePathSegments(path),
            ...(link.line ? { line: String(link.line) } : {}),
          });
          return;
        }
        Alert.alert(
          "File link unavailable",
          "The native entry has no usable working directory for this relative file link.",
        );
        return;
      }
      if (link.href)
        void tryOpenExternalUrl(link.href, "markdown-link").then((opened) => {
          if (!opened)
            Alert.alert("Link unavailable", "This device could not open the native entry's link.");
        });
    },
    [cwd, navigation, environmentId, nativeRef, threadRef],
  );
  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const media = resolveMediaSource(image.href, {
        threadId: threadRef?.threadId,
        nativeRef,
        workspaceRoot: cwd,
        imageEmbed: true,
      });
      if (
        !media ||
        media.kind !== "image" ||
        media.access === "unavailable" ||
        (media.access === "environment" && !environmentId)
      )
        return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      return media.access === "direct" ? (
        <ThreadMarkdownImageView
          uri={media.uri}
          sourceKey={media.uri}
          unavailable={false}
          alt={image.alt}
          onPressPreview={setPreview}
        />
      ) : (
        <ThreadMarkdownImage
          environmentId={environmentId!}
          resource={media.resource}
          alt={image.alt}
          srcFragment={media.srcFragment}
          actionsSource={{
            name: media.name,
            mimeType: media.mimeType,
            reference: media.reference,
            environmentId: environmentId!,
            resource: media.resource,
            ...(threadRef ? { threadId: threadRef.threadId } : {}),
          }}
          onPressPreview={setPreview}
        />
      );
    },
    [cwd, environmentId, nativeRef, threadRef],
  );
  const styles = useMarkdownPreviewStyles(renderImage);
  const markdown = userContent ? stripLegacyAttachmentMetadata(text) : text;
  return (
    <View>
      {hasNativeSelectableMarkdownText() ? (
        <SelectableMarkdownText
          markdown={markdown}
          textStyle={styles.nativeTextStyle}
          renderImage={renderImage}
          onLinkPress={openLink}
        />
      ) : (
        <Markdown
          options={{ gfm: true }}
          renderers={{
            ...styles.renderers,
            link: ({ href, children }) => (
              <Text
                className="font-t3-medium"
                style={{ color: styles.theme.colors?.link }}
                onPress={() => {
                  if (href) openLink(href);
                }}
              >
                {children}
              </Text>
            ),
          }}
          styles={styles.styles}
          theme={styles.theme}
        >
          {markdown}
        </Markdown>
      )}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
      <VideoPreviewModal source={video} onRequestClose={() => setVideo(null)} />
    </View>
  );
}

function NativeContent({ content, ...context }: ContentContext & { content: unknown }) {
  const [reasoningOpen, setReasoningOpen] = useState<ReadonlySet<number>>(new Set());
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  if (typeof content === "string") return <NativeMarkdown text={content} {...context} />;
  if (!Array.isArray(content))
    return content === undefined ? null : <NativeJson value={content} label="Native content" />;
  return (
    <View className="gap-3">
      {content.map((value, index) => {
        const block = journalRecord(value);
        if (block.type === "text" && typeof block.text === "string")
          return <NativeMarkdown key={index} text={block.text} {...context} />;
        if (block.type === "thinking" && typeof block.thinking === "string")
          return (
            <View key={index} className="gap-2">
              <Text
                accessibilityRole="button"
                className="text-sm text-foreground-muted"
                onPress={() =>
                  setReasoningOpen((current) => {
                    const next = new Set(current);
                    if (next.has(index)) next.delete(index);
                    else next.add(index);
                    return next;
                  })
                }
              >
                {reasoningOpen.has(index) ? "Hide" : "Show"}{" "}
                {block.summary === true ? "reasoning summary" : "reasoning"}
              </Text>
              {reasoningOpen.has(index) ? (
                <NativeMarkdown text={block.thinking} {...context} />
              ) : null}
            </View>
          );
        if (block.type === "image") {
          const uri = nativeJournalImageSource(block);
          if (uri === null)
            return (
              <View key={index} className="gap-2">
                <ThreadMarkdownImageUnavailable alt="Native journal attachment" />
                <NativeJson value={block} label="Native image record" />
              </View>
            );
          return (
            <ThreadMarkdownImageView
              key={index}
              uri={uri}
              sourceKey={uri}
              unavailable={false}
              alt="Native journal attachment"
              onPressPreview={setPreview}
            />
          );
        }
        if (block.type === "toolCall")
          return (
            <View key={index} className="gap-2 rounded-xl border border-border-subtle p-3">
              <Text className="font-t3-medium text-foreground">
                {String(block.name ?? "Tool call")}
              </Text>
              <Text selectable className="text-xs text-foreground-muted">
                {String(block.id ?? "")}
              </Text>
              <NativeJson value={block.arguments} label="Arguments" />
            </View>
          );
        if (block.type === "anthropicServerTool") {
          const tool = journalRecord(block.block);
          return (
            <View key={index} className="gap-2 rounded-xl border border-border-subtle p-3">
              <Text className="font-t3-medium text-foreground">
                Native server tool · {String(tool.name ?? tool.type ?? "unknown")}
              </Text>
              {tool.input !== undefined ? (
                <NativeJson value={tool.input} label="Arguments" />
              ) : null}
              {tool.content !== undefined ? (
                <NativeContent content={tool.content} {...context} />
              ) : null}
              <NativeJson value={block} label="Provider-native tool record" />
            </View>
          );
        }
        if (block.type === "redactedThinking")
          return (
            <Text key={index} className="text-sm text-foreground-muted">
              Provider-redacted reasoning. Its opaque record remains in canonical JSON.
            </Text>
          );
        if (block.type === "fallback")
          return (
            <Text key={index} className="text-sm text-foreground-muted">
              Model fallback · {String(journalRecord(block.from).model ?? "unknown")} →{" "}
              {String(journalRecord(block.to).model ?? "unknown")}
            </Text>
          );
        return (
          <NativeJson
            key={index}
            value={value}
            label={`${String(block.type ?? "Unknown")} content`}
          />
        );
      })}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
}

export function NeoPiJournalContent({
  entry,
  ...context
}: ContentContext & { entry: NeoPiJournalEntry }) {
  const message = journalRecord(entry.message);
  return (
    <View className="gap-3">
      {entry.type === "message" ? (
        <>
          {message.role === "toolResult" ? (
            <Text
              className={
                message.isError ? "text-sm text-danger-foreground" : "text-sm text-foreground-muted"
              }
            >
              Tool {String(message.toolName ?? "unknown")} · {String(message.toolCallId ?? "")} ·{" "}
              {message.isError ? "error" : "result"}
            </Text>
          ) : null}
          <NativeContent
            content={message.content}
            {...context}
            userContent={message.role === "user"}
          />
          {Array.isArray(message.images) ? (
            <NativeContent content={message.images} {...context} />
          ) : null}
          {Array.isArray(message.files)
            ? message.files.map((value, index) => {
                const file = journalRecord(value);
                return (
                  <View key={index} className="gap-2">
                    <Text selectable className="font-mono text-sm text-foreground">
                      {String(file.path ?? "Native file mention")}
                    </Text>
                    {typeof file.path === "string" ? (
                      <NativeMarkdown
                        text={`[Open file](${encodeURI(file.path).replaceAll("#", "%23").replaceAll("?", "%3F").replaceAll("(", "%28").replaceAll(")", "%29")})`}
                        {...context}
                      />
                    ) : null}
                    {file.image ? <NativeContent content={[file.image]} {...context} /> : null}
                    {typeof file.content === "string" ? (
                      <Text selectable className="font-mono text-xs text-foreground">
                        {file.content}
                      </Text>
                    ) : null}
                    {file.skippedReason ? (
                      <Text className="text-sm text-foreground-muted">
                        Native omission · {String(file.skippedReason)}
                      </Text>
                    ) : null}
                    <NativeJson value={file} label="Native file record" />
                  </View>
                );
              })
            : null}
          {typeof message.command === "string" ? (
            <Text selectable className="font-mono text-sm text-foreground">
              $ {message.command}
            </Text>
          ) : null}
          {typeof message.code === "string" ? (
            <Text selectable className="font-mono text-xs text-foreground">
              {message.code}
            </Text>
          ) : null}
          {typeof message.output === "string" ? (
            <Text selectable className="font-mono text-xs text-foreground">
              {message.output}
            </Text>
          ) : null}
          {message.exitCode !== undefined ? (
            <Text className="text-xs text-foreground-muted">
              Exit code · {String(message.exitCode)}
            </Text>
          ) : null}
          {message.truncated === true ? (
            <Text className="text-xs text-foreground-muted">
              The native record marks this output as truncated.
            </Text>
          ) : null}
          {message.cancelled === true ? (
            <Text className="text-xs text-foreground-muted">Native execution cancelled.</Text>
          ) : null}
          {message.details !== undefined ? (
            <NativeJson value={message.details} label="Native message details" />
          ) : null}
        </>
      ) : entry.type === "custom_message" ? (
        <NativeContent content={entry.content} {...context} />
      ) : null}
      {typeof entry.summary === "string" ? (
        <NativeMarkdown text={entry.summary} {...context} />
      ) : null}
      {entry.type === "compaction" ? (
        <Text className="text-sm text-foreground-muted">
          Compaction · {String(entry.tokensBefore ?? "unknown")} tokens before
          {entry.tokensAfter !== undefined ? ` · ${String(entry.tokensAfter)} after` : ""} · first
          kept entry {String(entry.firstKeptEntryId ?? "unknown")}. Earlier journal entries remain
          available.
        </Text>
      ) : null}
      {entry.type === "reset_boundary" ? (
        <Text className="text-sm text-foreground-muted">
          Native context reset boundary. Earlier entries remain in the journal.
        </Text>
      ) : null}
      {entry.type === "branch_summary" ? (
        <Text className="text-sm text-foreground-muted">
          Branch summary from {String(entry.fromId ?? "unknown")}
        </Text>
      ) : null}
      <NativeJson value={entry} />
    </View>
  );
}
