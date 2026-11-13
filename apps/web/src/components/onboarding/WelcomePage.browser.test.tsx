import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  linkState: null as unknown,
  linkError: null as string | null,
  refreshLinkState: vi.fn(),
}));

vi.mock(import("../../cloud/publicConfig"), () => ({ hasCloudPublicConfig: () => true }));
vi.mock(import("@clerk/react"), () => {
  const auth: ReturnType<typeof import("@clerk/react").useAuth> = {
    isLoaded: true,
    isSignedIn: true,
    userId: "user_1",
    sessionId: "session_1",
    sessionClaims: {
      __raw: "test-session-token",
      azp: "http://localhost",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
      iss: "https://clerk.test",
      nbf: 1_900_000_000,
      sid: "session_1",
      sub: "user_1",
      v: 2,
      fva: [-1, -1],
    },
    actor: null,
    orgId: null,
    orgRole: null,
    orgSlug: null,
    has: () => true,
    signOut: async () => {},
    getToken: async () => null,
  };
  return { useAuth: () => auth };
});
vi.mock(import("../clerk/useT3ConnectAuthPrompt"), () => ({
  useT3ConnectAuthPrompt: () => ({ openAuthPrompt: () => {} }),
}));
vi.mock(import("../../cloud/cloudLinkState"), async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useCloudLinkState: (environmentId) => ({
      target: environmentId === null ? null : { environmentId },
      data: useAtomValue(state.linkState as Atom.Atom<EnvironmentCloudLinkStateResult | null>),
      error: state.linkError,
      isPending: false,
      refresh: state.refreshLinkState,
    }),
  };
});
vi.mock(import("../../state/environments"), () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
}));
vi.mock(import("../../state/session"), () => ({ useEnvironmentScope: () => true }));
vi.mock(import("../../state/managedPolicy"), () => ({
  useManagedPolicy: () => undefined,
  managedTelemetryOffMessage: () => undefined,
}));
vi.mock(import("../settings/CliCommandSettingsRow"), () => ({
  useDesktopCliCommand: () => ({ state: null, busy: false, run: vi.fn() }),
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { WelcomeExtras } from "./WelcomePage";

it("says the phone is set up only once this computer is shared with the signed-in account", async () => {
  state.linkState = Atom.make<EnvironmentCloudLinkStateResult | null>(null).pipe(Atom.keepAlive);
  state.linkError = "Could not read T3 Connect link state.";
  state.refreshLinkState.mockReset();
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <WelcomeExtras environmentId={EnvironmentId.make("primary")} />
    </RegistryContext.Provider>,
  );
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Set up",
  );
  if (!button) throw new Error("Missing phone setup button");
  await act(async () => button.click());
  const pageText = () => document.body.textContent ?? "";
  await vi.waitFor(() => expect(pageText()).toContain("Could not check T3 Connect."));
  expect(pageText()).not.toContain("Set up T3 Connect");

  state.linkError = null;
  await act(async () =>
    appAtomRegistry.set(state.linkState as Atom.Writable<EnvironmentCloudLinkStateResult | null>, {
      linked: false,
      cloudUserId: null,
      relayUrl: null,
      relayIssuer: null,
      publishAgentActivity: false,
    }),
  );
  await vi.waitFor(() => expect(pageText()).toContain("Set up T3 Connect"));

  const share = (reachability: EnvironmentCloudLinkStateResult["reachability"]) =>
    act(async () =>
      appAtomRegistry.set(
        state.linkState as Atom.Writable<EnvironmentCloudLinkStateResult | null>,
        {
          linked: true,
          cloudUserId: "user_1",
          relayUrl: null,
          relayIssuer: null,
          managedTunnelActive: true,
          publishAgentActivity: true,
          reachability,
        },
      ),
    );
  const checkedAt = "2026-01-01T00:00:00.000Z";
  await share({
    status: "unreachable",
    checkedAt,
    cause: "connector_not_running",
    reason: "The tunnel is not running.",
    hint: null,
    fix: "Turn T3 Connect off and on.",
  });
  await vi.waitFor(() => expect(pageText()).toContain("Check T3 Connect"));
  expect(pageText()).not.toContain("Your phone can reach this computer.");

  await share({ status: "reachable", checkedAt, readyConnections: 4, protocol: "quic" });
  await vi.waitFor(() => expect(pageText()).toContain("Your phone can reach this computer."));
  expect(pageText()).not.toContain("Check T3 Connect");

  await act(async () =>
    appAtomRegistry.set(state.linkState as Atom.Writable<EnvironmentCloudLinkStateResult | null>, {
      linked: true,
      cloudUserId: "another-user",
      relayUrl: null,
      relayIssuer: null,
      managedTunnelActive: true,
      publishAgentActivity: true,
      reachability: { status: "reachable", checkedAt, readyConnections: 4, protocol: "quic" },
    }),
  );
  await vi.waitFor(() => expect(pageText()).toContain("Set up T3 Connect"));
  expect(pageText()).not.toContain("Your phone can reach this computer.");
});
