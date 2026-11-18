import { ProviderInstanceId, type NeoPiThreadNativeRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CONTROL_PLANE_OFF_REASON,
  threadNativeConnection,
  type ThreadObservationInput,
} from "./neopiThreadObservation.ts";

const ref = (ownedRuntime: boolean): NeoPiThreadNativeRef => ({
  status: "available",
  ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile: "/s/a.jsonl" },
  sessionId: "s-1",
  ownedRuntime,
});
const session = { sessionId: "s-1", capabilities: ["session_tree_navigation"] };
const at = (
  phase: ThreadObservationInput["phase"],
  extra: Partial<ThreadObservationInput> = {},
): ThreadObservationInput => ({ phase, reason: null, connected: false, session: null, ...extra });

describe("threadNativeConnection", () => {
  it("never shows a runtime NeoCode is running as stopped when no owner can be attached", () => {
    const off = threadNativeConnection(ref(true), at("owner-stopped", { reason: "No owner" }));
    const stopped = threadNativeConnection(ref(false), at("owner-stopped", { reason: "No owner" }));
    expect(off).toEqual({
      status: "unavailable",
      ownership: "gui",
      canNavigate: false,
      reason: CONTROL_PLANE_OFF_REASON,
    });
    expect(stopped).toEqual({
      status: "unavailable",
      ownership: "stopped",
      canNavigate: false,
      reason: "No owner",
    });
    expect(threadNativeConnection(ref(true), at("incompatible"))?.reason).toBe(
      CONTROL_PLANE_OFF_REASON,
    );
  });

  it("allows navigation only while observing a connected owner that supports the tree", () => {
    const observing = threadNativeConnection(
      ref(false),
      at("observing", { connected: true, session }),
    );
    expect(observing).toMatchObject({
      status: "connected",
      ownership: "terminal",
      canNavigate: true,
    });
    expect(
      threadNativeConnection(
        ref(true),
        at("observing", { connected: true, session: { ...session, capabilities: [] } }),
      ),
    ).toMatchObject({ status: "connected", ownership: "gui", canNavigate: false });
    expect(
      threadNativeConnection(ref(false), at("reconnecting", { session, reason: "owner exited" })),
    ).toEqual({
      status: "disconnected",
      ownership: "terminal",
      canNavigate: false,
      reason: "owner exited",
    });
  });

  it("reports a session that is not the thread's binding as an identity change", () => {
    expect(
      threadNativeConnection(
        ref(false),
        at("observing", { connected: true, session: { ...session, sessionId: "other" } }),
      )?.status,
    ).toBe("identity_changed");
  });

  it("stays loading until the ref resolves and the first attachment reports", () => {
    expect(threadNativeConnection(null, at("observing"))).toBeNull();
    expect(threadNativeConnection(ref(false), at("attaching"))).toBeNull();
    expect(
      threadNativeConnection({ status: "unavailable", reason: "no binding" }, null),
    ).toMatchObject({ status: "unavailable", reason: "no binding" });
  });
});
