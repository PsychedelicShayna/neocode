import { assert, describe, it } from "@effect/vitest";

import {
  decodeNeoPiControlRegistry,
  neoPiOwnerVersion,
  olderOwnerMessage,
  resolveNativeLive,
} from "./NeoPiNativeLiveness.ts";

const registryJson = (
  rows: ReadonlyArray<{ instanceId: string; snapshot: Record<string, unknown> | null }>,
) =>
  JSON.stringify({
    version: 1,
    sessions: rows.map(({ instanceId, snapshot }) => ({ meta: { instanceId }, snapshot })),
  });

const snapshot = (input: {
  streaming?: boolean;
  compacting?: boolean;
  queued?: number;
  dialogs?: ReadonlyArray<string>;
  version?: string;
}) => ({
  build: { version: input.version ?? "18.14.0" },
  busy: {
    streaming: input.streaming ?? false,
    compacting: input.compacting ?? false,
    pendingSteerAndFollowUp: input.queued ?? 0,
    pendingAsyncWork: false,
    // NeoPi's own "settled" is false for a queued prompt even though nothing streams.
    settled: !(input.streaming || input.compacting || (input.queued ?? 0) > 0),
  },
  dialogs: (input.dialogs ?? []).map((family, index) => ({ dialogId: `d${index}`, family })),
});

const live = (
  snap: Record<string, unknown> | null,
  reported: Parameters<typeof resolveNativeLive>[0]["reported"] = null,
) => {
  const registry = decodeNeoPiControlRegistry(registryJson([{ instanceId: "p1", snapshot: snap }]));
  return resolveNativeLive({ instanceId: "p1", reported, registry });
};

describe("native session liveness from the control registry", () => {
  it("counts only a streaming or compacting process as working", () => {
    assert.deepEqual(live(snapshot({ streaming: true })), {
      state: "busy",
      isStreaming: true,
      pendingDialogs: 0,
      branch: null,
    });
    assert.equal(live(snapshot({ compacting: true }))?.state, "busy");
    assert.equal(live(snapshot({}))?.state, "idle");
  });

  it("does not treat a queued follow-up on an idle process as working", () => {
    // NeoPi 18.10.3 process stuck with one queued prompt: `sessions list --live` says busy.
    assert.deepEqual(live(snapshot({ queued: 1, version: "18.10.3" })), {
      state: "idle",
      isStreaming: false,
      pendingDialogs: 0,
      branch: null,
    });
  });

  it("waits only for dialogs that need an answer, not for open panes", () => {
    for (const family of ["ask", "approval", "plan_review", "extension", "confirm"])
      assert.equal(live(snapshot({ dialogs: [family] }))?.state, "waiting", family);
    for (const family of ["app", "panel", "selector", "custom", "login", "session_in_use", "new"])
      assert.deepEqual(
        live(snapshot({ dialogs: [family] })),
        { state: "idle", isStreaming: false, pendingDialogs: 0, branch: null },
        family,
      );
  });

  it("lets a pending question outrank a turn parked on it", () => {
    assert.deepEqual(live(snapshot({ streaming: true, dialogs: ["ask", "app"] })), {
      state: "waiting",
      isStreaming: true,
      pendingDialogs: 1,
      branch: null,
    });
  });

  it("keeps the branch NeoPi reported for the owner", () => {
    const reported = { state: "busy", isStreaming: false, pendingDialogs: 0, branch: "main" };
    assert.equal(live(snapshot({}), reported)?.branch, "main");
  });

  it("reports nothing for a process that does not answer or left the registry", () => {
    assert.equal(live(null), undefined);
    const registry = decodeNeoPiControlRegistry(registryJson([]));
    assert.equal(
      resolveNativeLive({
        instanceId: "gone",
        reported: { state: "busy", isStreaming: true, pendingDialogs: 0, branch: null },
        registry,
      }),
      undefined,
    );
    assert.equal(resolveNativeLive({ instanceId: null, reported: undefined, registry }), undefined);
  });

  it("never guesses streaming from a snapshot that lacks it", () => {
    assert.equal(live({ dialogs: [{ dialogId: "d1", family: "ask" }] }), undefined);
    assert.equal(live({ session: { isStreaming: true } })?.state, "busy");
  });

  it("believes only the streaming flag when the registry cannot be read", () => {
    const resolve = (state: "busy" | "waiting" | "idle", isStreaming: boolean) =>
      resolveNativeLive({
        instanceId: "p1",
        registry: undefined,
        reported: { state, isStreaming, pendingDialogs: state === "waiting" ? 1 : 0, branch: "b" },
      });
    assert.deepEqual(resolve("busy", false), {
      state: "idle",
      isStreaming: false,
      pendingDialogs: 0,
      branch: "b",
    });
    assert.equal(resolve("waiting", false)?.state, "idle");
    assert.equal(resolve("busy", true)?.state, "busy");
    assert.equal(
      resolveNativeLive({ instanceId: "p1", registry: undefined, reported: null }),
      undefined,
    );
  });

  it("rejects output that is not a registry listing", () => {
    assert.equal(decodeNeoPiControlRegistry("not json"), undefined);
    assert.equal(decodeNeoPiControlRegistry(JSON.stringify({ sessions: "none" })), undefined);
  });

  it("names the owner's release in the older-NeoPi notice", () => {
    const registry = decodeNeoPiControlRegistry(
      registryJson([{ instanceId: "p1", snapshot: snapshot({ version: "18.10.3" }) }]),
    );
    assert.equal(neoPiOwnerVersion(registry, "p1"), "18.10.3");
    assert.equal(neoPiOwnerVersion(registry, "p2"), null);
    assert.equal(
      olderOwnerMessage("18.10.3"),
      "This session runs an older NeoPi (v18.10.3); restart it to use it here.",
    );
    assert.equal(
      olderOwnerMessage(null),
      "This session runs an older NeoPi; restart it to use it here.",
    );
  });
});
