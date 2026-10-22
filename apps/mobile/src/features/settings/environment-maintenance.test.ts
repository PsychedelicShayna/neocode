import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canMaintainEnvironment,
  findEnvironmentUpdate,
  supportsEnvironmentUpdate,
} from "./environment-maintenance";


afterEach(() => vi.unstubAllGlobals());

describe("environment maintenance access", () => {
  it("requires a connected authenticated session with operate permission", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: [AuthOrchestrationOperateScope],
    };
    expect(canMaintainEnvironment(session, true)).toBe(true);
    expect(canMaintainEnvironment(session, false)).toBe(false);
    expect(canMaintainEnvironment({ ...session, authenticated: false }, true)).toBe(false);
    expect(canMaintainEnvironment({ ...session, scopes: [] }, true)).toBe(false);
    const { scopes: _, ...legacy } = session;
    expect(canMaintainEnvironment(legacy, true)).toBe(false);
    expect(canMaintainEnvironment(null, true)).toBe(false);
  });

  it("requires remote desktop update support for desktop hosts", () => {
    expect(supportsEnvironmentUpdate({})).toBe(false);
    expect(supportsEnvironmentUpdate({ serverSelfUpdate: "respawn" })).toBe(true);
    expect(supportsEnvironmentUpdate({ serverSelfUpdate: "desktop-managed" })).toBe(false);
    expect(
      supportsEnvironmentUpdate({ serverSelfUpdate: "desktop-managed", desktopAppUpdate: true }),
    ).toBe(true);
  });

});

describe("environment release checks", () => {
  const signal = new AbortController().signal;

  const release = (version: string, draft = false) => ({
    tag_name: `v${version}`,
    draft,
    assets: [{ name: "SHA256SUMS" }, { name: `t3-${version}-linux-x64.tar.gz` }],
  });
  it("keeps stable hosts on stable releases and ignores drafts", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          Response.json([
            release("2.0.0-nightly.20260923.1"),
            release("1.2.0", true),
            release("1.1.0"),
          ]),
        ),
    );
    expect(await findEnvironmentUpdate("1.0.0", signal)).toBe("1.1.0");
    expect(await findEnvironmentUpdate("1.1.0", signal)).toBeNull();
    expect(await findEnvironmentUpdate("1.3.0", signal)).toBeNull();
  });

  it("walks release pages to find the host's channel", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(Array.from({ length: 100 }, () => release("2.0.0"))))
      .mockResolvedValueOnce(Response.json([release("1.0.0-preview.20260923.2")]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await findEnvironmentUpdate("1.0.0-preview.20260923.1", signal)).toBe(
      "1.0.0-preview.20260923.2",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain("page=2");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({ signal });
  });

  it("discovers stable build versions without offering mismatched archives or nightlies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json([
            release("2.0.0-nightly.20261020.39488899088.1+build.2"),
            { ...release("1.2.3+build.39488899089.1"), assets: release("1.2.3").assets },
            release("1.2.3+build.39488899088.2"),
          ]),
        ),
    );
    expect(await findEnvironmentUpdate("1.0.0", signal)).toBe("1.2.3+build.39488899088.2");
  });

  it("offers metadata-bearing updates across patch 9 to 10 without downgrading", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json([release("0.0.10+build.20.1")]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await findEnvironmentUpdate("0.0.9+build.19.1", signal)).toBe("0.0.10+build.20.1");
    expect(await findEnvironmentUpdate("0.0.10+build.21.2", signal)).toBeNull();

    fetchMock.mockImplementation(async () => Response.json([release("0.0.9+build.19.1")]));
    expect(await findEnvironmentUpdate("0.0.10+build.20.1", signal)).toBeNull();
  });

  it("reports failed checks instead of claiming the server is current", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow("403");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow("No stable release");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "invalid" })));
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow();
  });
});
