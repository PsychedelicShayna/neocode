import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { buildExpandedImagePreview, resolveMarkdownMediaPreview } from "./ExpandedImagePreview";

describe("resolveMarkdownMediaPreview", () => {
  it("opens native relative media on its remote environment and preserves the signed query and fragment", async () => {
    const environmentId = EnvironmentId.make("remote");
    const nativeRef = {
      providerInstanceId: ProviderInstanceId.make("profile"),
      sessionFile: "/native/session.jsonl",
    };
    const preview = await resolveMarkdownMediaPreview({
      source: "screens/shot%23one.png?v=2#mark",
      cwd: "/native-cwd",
      environmentId,
      nativeRef,
      httpBaseUrl: "https://remote.example/environment/",
      createAssetUrl: async () =>
        AsyncResult.success({
          relativeUrl: "/api/assets/signed/shot%23one.png?signature=a%2Fb",
          expiresAt: 1234,
        }),
    });
    expect(preview?.images[0]).toMatchObject({
      src: "https://remote.example/api/assets/signed/shot%23one.png?signature=a%2Fb#mark",
      srcFragment: "#mark",
      actionsSource: {
        reference: {
          kind: "file",
          path: "/native-cwd/screens/shot#one.png",
          relativePath: "screens/shot#one.png",
        },
        asset: {
          environmentId,
          resource: { _tag: "native-media-file", ref: nativeRef, path: "screens/shot#one.png" },
        },
      },
    });
    await expect(
      resolveMarkdownMediaPreview({
        source: "shot.png",
        cwd: "/native-cwd",
        nativeRef,
        environmentId,
        createAssetUrl: async () => {
          throw new Error("No connection must not mint.");
        },
      }),
    ).rejects.toThrow("Reconnect");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["t3code:", "https:"],
    ["t3code-dev:", "https:"],
    ["http:", "http:"],
    ["https:", "https:"],
  ])(
    "resolves protocol-relative media on %s without changing its source",
    async (pageProtocol, mediaProtocol) => {
      vi.stubGlobal("window", { location: { protocol: pageProtocol } });
      const source = "//cdn.example.com/recording.mp4?token=a%2FB&v=1#t=2";
      const preview = await resolveMarkdownMediaPreview({
        source,
        createAssetUrl: async () => {
          throw new Error("Remote media must not request a local asset URL.");
        },
      });

      expect(preview?.images[0]).toMatchObject({
        src: `${mediaProtocol}${source}`,
        originalUrl: source,
        actionsSource: {
          src: `${mediaProtocol}${source}`,
          reference: { kind: "url", url: source },
        },
      });
    },
  );
});

describe("buildExpandedImagePreview", () => {
  it("keeps MIME type for stored images without a filename extension", () => {
    const preview = buildExpandedImagePreview(
      [
        {
          type: "image",
          id: "heic-1",
          name: "photo",
          mimeType: "image/heic",
          sizeBytes: 3,
          previewUrl: "blob:heic",
        },
      ],
      "heic-1",
    );
    expect(preview?.images[0]).toMatchObject({
      name: "photo",
      mimeType: "image/heic",
      src: "blob:heic",
    });
  });
});
