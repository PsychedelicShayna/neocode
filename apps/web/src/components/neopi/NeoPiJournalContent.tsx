import type { NeoPiJournalEntry, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import ChatMarkdown from "../ChatMarkdown";
import { cn } from "../../lib/utils";
import { journalRecord } from "./neopiJournal.logic";

export function NativeJson({ value, label = "Canonical JSON" }: {
  value: unknown;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted-foreground">{label}</summary>
      {open ? (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 font-mono text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : null}
    </details>
  );
}

type ContentProps = { threadRef: ScopedThreadRef; cwd: string | undefined };

function NativeContent({ content, ...context }: ContentProps & { content: unknown }) {
  if (typeof content === "string")
    return <ChatMarkdown text={content} {...context} />;
  if (!Array.isArray(content))
    return content === undefined ? null : <NativeJson value={content} label="Native content" />;

  return (
    <div className="space-y-3">
      {content.map((value, index) => {
        const block = journalRecord(value);
        if (block.type === "text" && typeof block.text === "string")
          return <ChatMarkdown key={index} text={block.text} {...context} />;
        if (block.type === "thinking" && typeof block.thinking === "string") {
          return (
            <details key={index}>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {block.summary === true ? "Reasoning summary" : "Reasoning"}
              </summary>
              <ChatMarkdown text={block.thinking} {...context} />
            </details>
          );
        }
        if (block.type === "image" && typeof block.data === "string" &&
          typeof block.mimeType === "string" && /^image\/(png|jpeg|gif|webp|avif)$/.test(block.mimeType)) {
          const src = `data:${block.mimeType};base64,${block.data}`;
          return (
            <a key={index} href={src} target="_blank" rel="noreferrer">
              <img className="max-h-96 max-w-full rounded-md object-contain" src={src}
                alt="Native journal attachment" loading="lazy" />
            </a>
          );
        }
        if (block.type === "toolCall") {
          return (
            <section key={index} className="rounded-md border p-3">
              <h4 className="text-xs font-medium">{String(block.name ?? "Tool call")}</h4>
              <div className="mt-1 font-mono text-xs text-muted-foreground">{String(block.id ?? "")}</div>
              <NativeJson value={block.arguments} label="Arguments" />
            </section>
          );
        }
        if (block.type === "anthropicServerTool") {
          const tool = journalRecord(block.block);
          return (
            <section key={index} className="space-y-2 rounded-md border p-3">
              <h4 className="text-xs font-medium">
                Native server tool · {String(tool.name ?? tool.type ?? "unknown")}
              </h4>
              {tool.input !== undefined ? <NativeJson value={tool.input} label="Arguments" /> : null}
              {tool.content !== undefined ? <NativeContent content={tool.content} {...context} /> : null}
              <NativeJson value={block} label="Provider-native tool record" />
            </section>
          );
        }
        if (block.type === "redactedThinking") {
          return (
            <p key={index} className="text-xs text-muted-foreground">
              Provider-redacted reasoning. The opaque record is available in canonical JSON.
            </p>
          );
        }
        if (block.type === "fallback") {
          return (
            <p key={index} className="text-xs text-muted-foreground">
              Model fallback · {String(journalRecord(block.from).model ?? "unknown")} → {String(journalRecord(block.to).model ?? "unknown")}
            </p>
          );
        }
        return <NativeJson key={index} value={value} label={`${String(block.type ?? "Unknown")} content`} />;
      })}
    </div>
  );
}

function NativeFileMentions({ files, ...context }: ContentProps & { files: unknown[] }) {
  return (
    <div className="space-y-3">
      {files.map((value, index) => {
        const file = journalRecord(value);
        return (
          <details key={index}>
            <summary className="cursor-pointer font-mono text-xs">{String(file.path ?? "Native file mention")}</summary>
            {file.image ? <NativeContent content={[file.image]} {...context} /> : null}
            {typeof file.content === "string" ? (
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs">{file.content}</pre>
            ) : null}
            {file.skippedReason ? <p className="text-xs text-muted-foreground">Native omission · {String(file.skippedReason)}</p> : null}
            <NativeJson value={file} label="Native file record" />
          </details>
        );
      })}
    </div>
  );
}

export function NeoPiJournalContent({ entry, ...context }: ContentProps & { entry: NeoPiJournalEntry }) {
  const message = journalRecord(entry.message);
  return (
    <div className="space-y-4">
      {entry.type === "message" ? (
        <>
          {message.role === "toolResult" ? (
            <p className={cn("text-xs", message.isError ? "text-destructive" : "text-muted-foreground")}>
              Tool {String(message.toolName ?? "unknown")} · {String(message.toolCallId ?? "")} · {message.isError ? "error" : "result"}
            </p>
          ) : null}
          <NativeContent content={message.content} {...context} />
          {Array.isArray(message.images) ? <NativeContent content={message.images} {...context} /> : null}
          {Array.isArray(message.files) ? <NativeFileMentions files={message.files} {...context} /> : null}
          {typeof message.command === "string" ? (
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">$ {message.command}</pre>
          ) : null}
          {typeof message.code === "string" ? (
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">{message.code}</pre>
          ) : null}
          {typeof message.output === "string" ? (
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">{message.output}</pre>
          ) : null}
          {message.exitCode !== undefined ? <p className="text-xs text-muted-foreground">Exit code · {String(message.exitCode)}</p> : null}
          {message.truncated === true ? <p className="text-xs text-muted-foreground">The native record marks this execution output as truncated.</p> : null}
          {message.cancelled === true ? <p className="text-xs text-muted-foreground">Native execution cancelled.</p> : null}
          {message.details !== undefined ? <NativeJson value={message.details} label="Native message details" /> : null}
        </>
      ) : entry.type === "custom_message" ? <NativeContent content={entry.content} {...context} /> : null}
      {typeof entry.summary === "string" ? <ChatMarkdown text={entry.summary} {...context} /> : null}
      {entry.type === "compaction" ? (
        <p className="text-xs text-muted-foreground">
          Compaction · {String(entry.tokensBefore ?? "unknown")} tokens before{entry.tokensAfter !== undefined ? ` · ${String(entry.tokensAfter)} after` : ""} · first kept entry {String(entry.firstKeptEntryId ?? "unknown")}
        </p>
      ) : null}
      {entry.type === "reset_boundary" ? <p className="text-sm">Native context reset boundary. Earlier entries remain in the journal.</p> : null}
      {entry.type === "branch_summary" ? <p className="text-xs text-muted-foreground">Branch summary from {String(entry.fromId ?? "unknown")}</p> : null}
      <NativeJson value={entry} />
    </div>
  );
}
