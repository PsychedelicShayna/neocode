import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isOnboardingRelayEnvironment,
  resolveOnboardingNeoProxyTarget,
} from "./targetEnvironment.logic";

describe("resolveOnboardingNeoProxyTarget", () => {
  const first = EnvironmentId.make("first");
  const second = EnvironmentId.make("second");

  it("requires an explicit choice instead of selecting the first computer", () => {
    expect(resolveOnboardingNeoProxyTarget([first, second], null)).toBeNull();
  });

  it("keeps the chosen computer even when it is not first", () => {
    expect(resolveOnboardingNeoProxyTarget([first, second], second)).toBe(second);
  });

  it("does not substitute another computer for an unavailable choice", () => {
    expect(
      resolveOnboardingNeoProxyTarget([first, second], EnvironmentId.make("removed")),
    ).toBeNull();
    expect(resolveOnboardingNeoProxyTarget([], first)).toBeNull();
  });

  it("uses the only selected computer without asking a redundant question", () => {
    expect(resolveOnboardingNeoProxyTarget([second], null)).toBe(second);
  });
});

const olderRelay = {
  environmentId: EnvironmentId.make("older-remote"),
  connection: { phase: "connected" },
  entry: {
    target: new RelayConnectionTarget({
      environmentId: EnvironmentId.make("older-remote"),
      label: "Older computer",
    }),
  },
  label: "Older computer",
} as const;

const pairedRemote = {
  environmentId: EnvironmentId.make("paired-remote"),
  connection: { phase: "connected" },
  entry: {
    target: new BearerConnectionTarget({
      environmentId: EnvironmentId.make("paired-remote"),
      label: "Direct computer",
      connectionId: "paired-remote",
    }),
  },
  label: "Direct computer",
} as const;

const sshEnvironment = {
  environmentId: EnvironmentId.make("ssh-remote"),
  connection: { phase: "connected" },
  entry: {
    target: new SshConnectionTarget({
      environmentId: EnvironmentId.make("ssh-remote"),
      label: "SSH computer",
      connectionId: "ssh-remote",
    }),
  },
  label: "SSH computer",
} as const;

const desktopLocalEnvironment = {
  environmentId: EnvironmentId.make("desktop-local-wsl"),
  connection: { phase: "connected" },
  entry: {
    target: new BearerConnectionTarget({
      environmentId: EnvironmentId.make("desktop-local-wsl"),
      label: "WSL",
      connectionId: "local:wsl:Ubuntu",
    }),
  },
  label: "WSL",
} as const;

describe("isOnboardingRelayEnvironment", () => {
  it("includes only T3 Connect relay targets", () => {
    expect(
      [olderRelay, pairedRemote, sshEnvironment, desktopLocalEnvironment].filter(
        isOnboardingRelayEnvironment,
      ),
    ).toEqual([olderRelay]);
  });
});
