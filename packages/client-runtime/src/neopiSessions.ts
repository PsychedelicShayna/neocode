import type { NeoPiSessionSummary } from "@t3tools/contracts";

export function neopiSessionRowState(session: NeoPiSessionSummary) {
  const ownerLabel =
    session.owner.kind === "neocode"
      ? "Open in NeoCode"
      : session.owner.kind === "process"
        ? "Live in terminal"
        : "Free";
  const threadId =
    session.threadId ?? (session.owner.kind === "neocode" ? session.owner.threadId : null);
  const disabledReason =
    session.owner.kind === "process" && !session.owner.attachable
      ? "This terminal session cannot be attached to. Close it in the terminal first."
      : null;
  return {
    title: session.title?.trim() || session.firstMessage.trim() || "Untitled session",
    ownerLabel,
    threadId,
    disabledReason,
  };
}

export function filterNeoPiSessions(sessions: readonly NeoPiSessionSummary[], query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    const text = `${session.title ?? ""} ${session.firstMessage}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
