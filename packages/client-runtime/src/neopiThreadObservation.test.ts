import {
  ProviderInstanceId,
  type NeoPiJournalEntry,
  type NeoPiJournalPage,
  type NeoPiThreadNativeRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { emptyNativeConversation, reduceNativeConversation } from "./neopiConversation.ts";
import {
  CONTROL_PLANE_OFF_REASON,
  SESSION_CHANGED_REASON,
  findOlderNativePage,
  nativeOlderHistoryAvailable,
  threadNativeConnection,
  type ThreadObservationInput,
} from "./neopiThreadObservation.ts";

const ref = (runtime: "gui" | "terminal" | "none"): NeoPiThreadNativeRef => ({
  status: "available",
  ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile: "/s/a.jsonl" },
  sessionId: "s-1",
  runtime,
});
const session = { sessionId: "s-1", capabilities: ["session_tree_navigation"] };
const at = (
  phase: ThreadObservationInput["phase"],
  extra: Partial<ThreadObservationInput> = {},
): ThreadObservationInput => ({ phase, reason: null, connected: false, session: null, ...extra });

describe("threadNativeConnection", () => {
  it("never shows a session NeoCode owns as stopped, and keeps history readable either way", () => {
    expect(threadNativeConnection(ref("gui"), at("owner-stopped", { reason: "No owner" }))).toEqual(
      {
        status: "unavailable",
        ownership: "gui",
        canNavigate: false,
        history: "read-only",
        reason: CONTROL_PLANE_OFF_REASON,
      },
    );
    for (const runtime of ["none", "terminal"] as const)
      expect(
        threadNativeConnection(ref(runtime), at("owner-stopped", { reason: "No owner" })),
      ).toEqual({
        status: "unavailable",
        ownership: "stopped",
        canNavigate: false,
        history: "read-only",
        reason: "No owner",
      });
  });

  it("reads an owner it cannot follow live as read-only history, saying why", () => {
    const older = threadNativeConnection(
      ref("none"),
      at("incompatible", { reason: "the owner lacks session_journal_events" }),
    );
    expect(older).toMatchObject({
      status: "unavailable",
      history: "read-only",
      ownership: "terminal",
    });
    expect(older?.reason).toContain("Live updates are unavailable");
    expect(threadNativeConnection(ref("gui"), at("incompatible"))?.reason).toBe(
      CONTROL_PLANE_OFF_REASON,
    );
  });

  it("labels the owner by what NeoCode's runtime is, and navigates only when connected", () => {
    expect(
      threadNativeConnection(ref("terminal"), at("observing", { connected: true, session })),
    ).toMatchObject({
      status: "connected",
      ownership: "terminal",
      canNavigate: true,
      history: "live",
    });
    expect(
      threadNativeConnection(
        ref("gui"),
        at("observing", { connected: true, session: { ...session, capabilities: [] } }),
      ),
    ).toMatchObject({ status: "connected", ownership: "gui", canNavigate: false });
    expect(
      threadNativeConnection(ref("none"), at("reconnecting", { session, reason: "owner exited" })),
    ).toEqual({
      status: "disconnected",
      ownership: "terminal",
      canNavigate: false,
      history: "live",
      reason: "owner exited",
    });
  });

  it("shows nothing of a session that is not the thread's binding", () => {
    expect(
      threadNativeConnection(
        ref("none"),
        at("observing", { connected: true, session: { ...session, sessionId: "other" } }),
      ),
    ).toEqual({
      status: "identity_changed",
      ownership: "terminal",
      canNavigate: false,
      history: "none",
      reason: SESSION_CHANGED_REASON,
    });
  });

  it("stays loading until the ref resolves and the first attachment reports", () => {
    expect(threadNativeConnection(null, at("observing"))).toBeNull();
    expect(threadNativeConnection(ref("none"), at("attaching"))).toBeNull();
    expect(
      threadNativeConnection({ status: "unavailable", reason: "no binding" }, null),
    ).toMatchObject({
      status: "unavailable",
      history: "none",
      reason: "no binding",
    });
  });
});

describe("older native history", () => {
  const identity = { sessionId: "s-1", sessionFile: "/s/a.jsonl", leafId: "e9" };
  const entry = (index: number): NeoPiJournalEntry => ({
    id: `e${index}`,
    parentId: index === 0 ? null : `e${index - 1}`,
    type: "message",
    timestamp: "2026-11-18T00:00:00Z",
  });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, offset) => entry(from + offset));
  // Pages of three entries backward from the leaf, as the journal read serves them.
  const journal = (cursor: string | undefined): Promise<NeoPiJournalPage> => {
    const end = cursor === undefined ? 9 : Number(cursor);
    const start = Math.max(0, end - 2);
    return Promise.resolve({
      ...identity,
      entries: range(start, end),
      totalEntries: 10,
      ...(start > 0 ? { nextCursor: String(start - 1) } : {}),
    });
  };

  // The live ring dropped the start of the first page: the reader got the retained tail with
  // no cursor bound to the current leaf.
  const tailWithoutCursor = reduceNativeConversation(emptyNativeConversation(), {
    type: "snapshot",
    page: { ...identity, entries: range(5, 9), totalEntries: 10 },
  });

  it("keeps older history reachable when the first page has no usable cursor", async () => {
    expect(tailWithoutCursor.cursor).toBeUndefined();
    expect(nativeOlderHistoryAvailable(tailWithoutCursor)).toBe(true);
    const page = await findOlderNativePage(tailWithoutCursor, journal);
    expect(page?.entries.map((item) => item.id)).toContain("e4");
    const joined = reduceNativeConversation(
      { ...tailWithoutCursor, cursorLeaf: identity.leafId },
      { type: "older", page: page!, revision: tailWithoutCursor.revision },
    );
    expect(joined.entries[0]?.id).toBe("e4");
    expect(nativeOlderHistoryAvailable(joined)).toBe(true);
  });

  it("stops offering older history at the root", async () => {
    const whole = reduceNativeConversation(emptyNativeConversation(), {
      type: "snapshot",
      page: { ...identity, entries: range(0, 9), totalEntries: 10 },
    });
    expect(nativeOlderHistoryAvailable(whole)).toBe(false);
    expect(await findOlderNativePage(whole, journal)).toBeNull();
  });
});
