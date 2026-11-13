import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { workspaceKey } from "@t3tools/client-runtime/environment";

import { nativeWorkspaceRoutePath, parseActiveThreadPath } from "./hardwareKeyboardCommands";

describe("parseActiveThreadPath", () => {
  it("decodes route components", () => {
    expect(parseActiveThreadPath("/threads/local%20machine/thread%2Fone/review")).toEqual({
      environmentId: "local machine",
      threadId: "thread/one",
    });
  });

  it("ignores malformed encoded route components", () => {
    expect(parseActiveThreadPath("/threads/%E0%A4%A/thread-1")).toBeNull();
  });
});

describe("native workspace route locations", () => {
  const target = {
    environmentId: EnvironmentId.make("remote:server"),
    ref: {
      providerInstanceId: ProviderInstanceId.make("neopi-profile"),
      sessionFile: "/sessions/path with spaces.jsonl",
    },
  };
  const root = "/sessions/remote%3Aserver/neopi-profile/%2Fsessions%2Fpath%20with%20spaces.jsonl";
  it("keeps existing surface routes native instead of emitting a missing SQL identity", () => {
    expect(
      nativeWorkspaceRoutePath({
        name: "NativeSession",
        params: { environmentId: target.environmentId, ...target.ref },
      }),
    ).toBe(root);
    expect(
      nativeWorkspaceRoutePath({ name: "ThreadTerminal", params: { target, cwd: "/workspace" } }),
    ).toBe(`${root}/terminal`);
    expect(
      nativeWorkspaceRoutePath({ name: "ThreadReview", params: { target, cwd: "/workspace" } }),
    ).toBe(`${root}/review`);
    expect(
      nativeWorkspaceRoutePath({
        name: "ThreadFiles",
        params: { environmentId: target.environmentId, nativeRef: target.ref, cwd: "/workspace" },
      }),
    ).toBe(`${root}/files`);
    expect(
      nativeWorkspaceRoutePath({
        name: "ThreadFile",
        params: {
          environmentId: target.environmentId,
          nativeRef: target.ref,
          path: ["src", "a b.ts"],
        },
      }),
    ).toBe(`${root}/files/src/a%20b.ts`);
    expect(nativeWorkspaceRoutePath({ name: "ThreadDevicePreview", params: { target } })).toBe(
      `${root}/devices`,
    );
    expect(
      nativeWorkspaceRoutePath({ name: "ThreadReviewComment", params: { workspaceRef: target } }),
    ).toBe(`${root}/review-comment`);
    expect(
      nativeWorkspaceRoutePath({
        name: "ThreadAttachment",
        params: {
          environmentId: target.environmentId,
          draftKey: workspaceKey(target),
          attachmentId: "photo",
        },
      }),
    ).toBe(`${root}/attachments/photo`);
  });
  it("leaves legacy and malformed routes to the existing linking configuration", () => {
    expect(
      nativeWorkspaceRoutePath({
        name: "ThreadFiles",
        params: { environmentId: "legacy", threadId: "thread" },
      }),
    ).toBeNull();
    expect(
      nativeWorkspaceRoutePath({
        name: "ThreadTerminal",
        params: { target: { ...target, ref: {} } },
      }),
    ).toBeNull();
    expect(nativeWorkspaceRoutePath({ name: "SettingsSheet" })).toBeNull();
  });
});
