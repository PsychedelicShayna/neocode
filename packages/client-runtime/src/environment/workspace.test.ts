import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import { parseWorkspaceKey, workspaceKey, workspaceResourceId } from "./workspace.ts";
import { scopedThreadKey } from "./scoped.ts";

const native = {
  environmentId: EnvironmentId.make("host-a"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: `/sessions/${"long-directory-".repeat(20)}/conversation.jsonl`,
  },
};

describe("workspace identity", () => {
  it("round-trips native metadata while keeping terminal filename namespaces bounded", () => {
    const restored = parseWorkspaceKey(workspaceKey(native));
    expect(restored).toEqual(native);
    expect(restored && "threadId" in restored).toBe(false);
    expect(restored && workspaceResourceId(restored)).toBe(workspaceResourceId(native));
    // Terminal history base64-encodes this namespace in one filesystem component.
    expect(Base64Url.encode(workspaceResourceId(native)).length).toBeLessThan(80);
    expect(workspaceResourceId(native)).not.toContain("conversation.jsonl");
  });

  it("separates native profiles and files while environments scope UI metadata", () => {
    const otherProfile = {
      ...native,
      ref: { ...native.ref, providerInstanceId: ProviderInstanceId.make("second") },
    };
    const otherFile = {
      ...native,
      ref: { ...native.ref, sessionFile: native.ref.sessionFile + ".other" },
    };
    const otherHost = { ...native, environmentId: EnvironmentId.make("host-b") };
    expect(workspaceResourceId(otherProfile)).not.toBe(workspaceResourceId(native));
    expect(workspaceResourceId(otherFile)).not.toBe(workspaceResourceId(native));
    expect(workspaceKey(otherHost)).not.toBe(workspaceKey(native));
    expect(parseWorkspaceKey(workspaceKey(otherProfile))).toEqual(otherProfile);
    expect(parseWorkspaceKey(workspaceKey(otherFile))).toEqual(otherFile);
    expect(parseWorkspaceKey(workspaceKey(otherHost))).toEqual(otherHost);
  });

  it.each(["remote:server", "a:vcs-status:b"])(
    "preserves the complete native environment identity %s",
    (environmentId) => {
      const target = { ...native, environmentId: EnvironmentId.make(environmentId) };
      expect(parseWorkspaceKey(workspaceKey(target))).toEqual(target);
      expect(parseWorkspaceKey(`${environmentId}:native:{broken`)).toBeNull();
    },
  );

  it("preserves saved legacy keys without treating malformed native keys as SQL threads", () => {
    const legacy = {
      environmentId: native.environmentId,
      threadId: ThreadId.make("import:neopi:saved"),
    };
    expect(workspaceKey(legacy)).toBe(scopedThreadKey(legacy));
    expect(workspaceResourceId(legacy)).toBe(legacy.threadId);
    expect(parseWorkspaceKey(workspaceKey(legacy))).toEqual(legacy);
    expect(parseWorkspaceKey("host-a:native:{broken")).toBeNull();
    expect(parseWorkspaceKey('host-a:native:{"providerInstanceId":"neopi"}')).toBeNull();
  });
});
