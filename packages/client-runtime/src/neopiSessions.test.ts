import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type NeoPiSessionSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { filterNeoPiSessions, neopiSessionRowState } from "./neopiSessions";

function session(overrides: Partial<NeoPiSessionSummary> = {}): NeoPiSessionSummary {
  return {
    providerInstanceId: ProviderInstanceId.make("neopi-personal"),
    sessionId: "session-1",
    sessionFile: "/sessions/session-1.jsonl",
    cwd: "/workspace/project",
    title: "Fix the parser",
    firstMessage: "Handle escaped Unicode strings",
    createdAt: "2026-10-18T10:00:00.000Z",
    modifiedAt: "2026-10-18T11:00:00.000Z",
    messageCount: 12,
    owner: { kind: "none" },
    threadId: null,
    projectId: ProjectId.make("project-1"),
    ...overrides,
  };
}

describe("NeoPi session selection", () => {
  it("permits free sessions and attachable owners but blocks another writer", () => {
    expect(neopiSessionRowState(session()).disabledReason).toBeNull();
    const attached = neopiSessionRowState(
      session({ owner: { kind: "process", pid: 123, attachable: true } }),
    );
    expect(attached.ownerLabel).toBe("Live in terminal");
    expect(attached.disabledReason).toBeNull();
    expect(
      neopiSessionRowState(session({ owner: { kind: "process", pid: 123, attachable: false } }))
        .disabledReason,
    ).toContain("cannot be attached");
  });

  it("allows explicit resume to resolve a foreign folder without registering it first", () => {
    expect(neopiSessionRowState(session({ projectId: null })).disabledReason).toBeNull();
  });

  it("keeps a bound thread actionable when discovery has no project metadata", () => {
    const threadId = ThreadId.make("existing-thread");
    const state = neopiSessionRowState(
      session({
        projectId: null,
        threadId,
        owner: { kind: "process", pid: 123, attachable: true },
      }),
    );
    expect(state.threadId).toBe(threadId);
    expect(state.disabledReason).toBeNull();
  });

  it("blocks a bound thread when its terminal owner cannot be attached", () => {
    const state = neopiSessionRowState(
      session({
        threadId: ThreadId.make("existing-thread"),
        owner: { kind: "process", pid: 123, attachable: false },
      }),
    );
    expect(state.disabledReason).toBe(
      "This terminal session cannot be attached to. Close it in the terminal first.",
    );
  });

  it("uses the NeoCode owner thread when the summary has no thread id", () => {
    const threadId = ThreadId.make("owned-thread");
    const state = neopiSessionRowState(
      session({ owner: { kind: "neocode", threadId }, projectId: null }),
    );
    expect(state.threadId).toBe(threadId);
    expect(state.ownerLabel).toBe("Open in NeoCode");
    expect(state.disabledReason).toBeNull();
  });

  it("falls back to the first message and then an untitled label", () => {
    expect(neopiSessionRowState(session({ title: "  " })).title).toBe(
      "Handle escaped Unicode strings",
    );
    expect(neopiSessionRowState(session({ title: null, firstMessage: " " })).title).toBe(
      "Untitled session",
    );
  });
});

describe("NeoPi session search", () => {
  it("matches words across titles and first messages without changing recency order", () => {
    const newest = session();
    const older = session({ sessionId: "older", title: "Parser rewrite" });
    const unrelated = session({ title: "Update readme", firstMessage: "Document installation" });
    expect(filterNeoPiSessions([newest, unrelated, older], "  PARSER unicode ")).toEqual([
      newest,
      older,
    ]);
    expect(filterNeoPiSessions([newest, older], "no match")).toEqual([]);
    expect(filterNeoPiSessions([newest, older], "   ")).toEqual([newest, older]);
  });
});
