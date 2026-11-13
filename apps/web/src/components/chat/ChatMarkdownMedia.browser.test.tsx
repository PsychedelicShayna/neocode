import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";

// Every evaluation of the URL query is one mint: the first read, then one per refresh.
const assetQuery = vi.hoisted(() => ({ mints: 0 }));
vi.mock(import("~/state/assets"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const createUrl = Atom.family((_key: string) =>
    Atom.make(() => {
      assetQuery.mints += 1;
      return AsyncResult.success({
        relativeUrl: `data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7#mint-${assetQuery.mints}`,
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
    }).pipe(Atom.keepAlive),
  );
  const actual = await original();
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target: { readonly input: unknown }) => createUrl(JSON.stringify(target.input)),
    },
  };
});
vi.mock(import("~/state/session"), async (original) => {
  const { Option } = await import("effect");
  const { PrimaryConnectionTarget } = await import("@t3tools/client-runtime/connection");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Local",
    httpBaseUrl: "http://localhost:1",
    wsBaseUrl: "ws://localhost:1",
  });
  const prepared: PreparedConnection = {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: null,
    target,
  };
  return {
    ...(await original()),
    usePreparedConnection: () => Option.some(prepared),
  };
});
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));

describe("ChatMarkdownAssetImage", () => {
  it("does not re-mint an unchanged workspace image's URL on remount", async () => {
    assetQuery.mints = 0;
    const image = (
      <ChatMarkdownAssetImage
        environmentId={EnvironmentId.make("environment-1")}
        resource={{
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: "docs/diagram.png",
        }}
        alt="diagram"
        workspaceMutationId="mutation-1"
      />
    );

    {
      await using screen = await render(image);
      await expect.element(screen.getByRole("img", { name: "diagram" })).toBeInTheDocument();
    }
    // The first mount at a known revision re-mints the cached URL once.
    expect(assetQuery.mints).toBe(2);

    await using screen = await render(<ChatMarkdownAssetImage {...image.props} />);
    await expect.element(screen.getByRole("img", { name: "diagram" })).toBeInTheDocument();
    expect(assetQuery.mints).toBe(2);
  });

  it("isolates same-path native image URLs by profile and session while retaining their warm cache", async () => {
    assetQuery.mints = 0;
    const environmentId = EnvironmentId.make("environment-1");
    const refs = [
      { providerInstanceId: ProviderInstanceId.make("images-a"), sessionFile: "/sessions/a.jsonl" },
      { providerInstanceId: ProviderInstanceId.make("images-b"), sessionFile: "/sessions/a.jsonl" },
      { providerInstanceId: ProviderInstanceId.make("images-a"), sessionFile: "/sessions/b.jsonl" },
    ];
    const image = (ref: (typeof refs)[number]) => (
      <ChatMarkdownAssetImage
        environmentId={environmentId}
        resource={{ _tag: "native-media-file", ref, path: "docs/shared.png" }}
        alt="native diagram"
        workspaceMutationId="native-mutation"
      />
    );
    await using screen = await render(image(refs[0]!));
    const renderedImage = () => screen.container.querySelector<HTMLImageElement>("img")!;
    await expect.element(screen.getByRole("img", { name: "native diagram" })).toBeInTheDocument();
    const firstSrc = renderedImage().src;
    expect(assetQuery.mints).toBe(2);

    for (const [index, ref] of refs.slice(1).entries()) {
      const previousSrc = renderedImage().src;
      await screen.rerender(image(ref));
      await expect
        .element(screen.getByRole("img", { name: "native diagram" }))
        .not.toHaveAttribute("src", previousSrc);
      expect(assetQuery.mints).toBe((index + 2) * 2);
    }

    await screen.rerender(image(refs[0]!));
    await expect
      .element(screen.getByRole("img", { name: "native diagram" }))
      .toHaveAttribute("src", firstSrc);
    expect(assetQuery.mints).toBe(6);
  });
});
