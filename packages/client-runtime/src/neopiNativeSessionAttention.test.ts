import { ProviderInstanceId, type NeoPiNativeSessionSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nativeSessionProjectLabel,
  partitionNativeSessions,
  resolveNativeSessionStatus,
  type NativeSessionVisitState,
} from "./neopiNativeSessionAttention.ts";

const session = (
  file: string,
  modifiedAt: string,
  extra: Partial<Pick<NeoPiNativeSessionSummary, "live" | "settledAt">> = {},
) => ({
  ref: { providerInstanceId: ProviderInstanceId.make("native"), sessionFile: file },
  modifiedAt,
  ...extra,
});
const live = (state: "busy" | "waiting" | "idle") => ({
  state,
  isStreaming: state === "busy",
  pendingDialogs: state === "waiting" ? 1 : 0,
  branch: null,
});
const visits: NativeSessionVisitState = {
  baseline: "2026-11-01T00:00:00.000Z",
  visited: { "/seen.jsonl": "2026-11-03T00:00:00.000Z" },
};

describe("resolveNativeSessionStatus", () => {
  it("ranks a blocked owner above a working one regardless of visits", () => {
    expect(
      resolveNativeSessionStatus(
        session("/a", "2026-10-01T00:00:00Z", { live: live("waiting") }),
        visits,
        false,
      ),
    ).toBe("waiting");
    expect(
      resolveNativeSessionStatus(
        session("/a", "2026-10-01T00:00:00Z", { live: live("busy") }),
        visits,
        true,
      ),
    ).toBe("working");
  });

  it("calls activity after the last visit done, judged against the baseline when never visited", () => {
    expect(
      resolveNativeSessionStatus(session("/new.jsonl", "2026-11-02T00:00:00Z"), visits, false),
    ).toBe("done");
    expect(
      resolveNativeSessionStatus(session("/old.jsonl", "2026-10-30T00:00:00Z"), visits, false),
    ).toBe("idle");
    expect(
      resolveNativeSessionStatus(session("/seen.jsonl", "2026-11-02T00:00:00Z"), visits, false),
    ).toBe("idle");
    expect(
      resolveNativeSessionStatus(session("/seen.jsonl", "2026-11-04T00:00:00Z"), visits, false),
    ).toBe("done");
  });

  it("never calls the open session done", () => {
    expect(
      resolveNativeSessionStatus(session("/new.jsonl", "2026-11-02T00:00:00Z"), visits, true),
    ).toBe("idle");
  });

  it("treats an unparseable activity time as seen", () => {
    expect(resolveNativeSessionStatus(session("/bad", "not a date"), visits, false)).toBe("idle");
  });
});

describe("partitionNativeSessions", () => {
  // Unopened sessions with activity after the baseline: each one resolves `done`.
  const sections = partitionNativeSessions(
    [
      session("/done-a.jsonl", "2026-11-04T12:00:00Z"),
      session("/done-b.jsonl", "2026-11-04T10:00:00Z"),
      session("/done-c.jsonl", "2026-11-04T07:00:00Z"),
      session("/waiting-a.jsonl", "2026-11-04T06:00:00Z", { live: live("waiting") }),
      session("/waiting-b.jsonl", "2026-11-04T08:00:00Z", { live: live("waiting") }),
      session("/working.jsonl", "2026-11-04T05:00:00Z", { live: live("busy") }),
      session("/open.jsonl", "2026-11-04T09:00:00Z"),
      session("/old.jsonl", "2026-10-31T00:00:00Z"),
      session("/settled-early.jsonl", "2026-10-01T00:00:00Z", {
        settledAt: "2026-10-05T00:00:00Z",
      }),
      session("/settled-late.jsonl", "2026-10-02T00:00:00Z", { settledAt: "2026-10-09T00:00:00Z" }),
    ],
    visits,
    "/open.jsonl",
  );
  const files = (entries: typeof sections.attention) =>
    entries.map((entry) => entry.session.ref.sessionFile);

  it("needs attention holds only sessions waiting on the user, newest first", () => {
    expect(files(sections.attention)).toEqual(["/waiting-b.jsonl", "/waiting-a.jsonl"]);
  });

  it("places a working session above every finished-unseen one", () => {
    expect(files(sections.working)).toEqual(["/working.jsonl"]);
    // Sections render attention, working, recent: done rows must all sit in recent.
    expect([...sections.attention, ...sections.working].map((entry) => entry.status)).not.toContain(
      "done",
    );
    expect(sections.recent.filter((entry) => entry.status === "done")).toHaveLength(3);
  });

  it("orders recent purely by activity, done or not, with the open session in place", () => {
    expect(files(sections.recent)).toEqual([
      "/done-a.jsonl",
      "/done-b.jsonl",
      "/open.jsonl",
      "/done-c.jsonl",
      "/old.jsonl",
    ]);
    expect(sections.recent.map((entry) => entry.status)).toEqual([
      "done",
      "done",
      "idle",
      "done",
      "idle",
    ]);
  });

  it("orders the settled shelf by settle time", () => {
    expect(files(sections.settled)).toEqual(["/settled-late.jsonl", "/settled-early.jsonl"]);
  });
});

describe("nativeSessionProjectLabel", () => {
  it("uses the folder name, tolerating trailing separators and empty paths", () => {
    expect(nativeSessionProjectLabel("/home/me/source/neocode")).toBe("neocode");
    expect(nativeSessionProjectLabel("/home/me/source/neocode/")).toBe("neocode");
    expect(nativeSessionProjectLabel("C:\\work\\repo")).toBe("repo");
    expect(nativeSessionProjectLabel("")).toBe("No project");
    expect(nativeSessionProjectLabel("/")).toBe("No project");
  });
});
