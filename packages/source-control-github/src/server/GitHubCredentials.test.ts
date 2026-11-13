import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { DEFAULT_SERVER_SETTINGS, SecretProviderId, SecretProviderKind } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubCredentials from "./GitHubCredentials.ts";

const TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

const hostSettings = (
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }>,
) =>
  Object.fromEntries(
    Object.entries(hosts).map(([host, choice]) => [host, { enabled: true, ...choice }]),
  );

function harness(
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }> = {},
  signedOut: ReadonlyArray<string> = [],
  tokens: Record<string, string> = {},
  processRun?: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
    Effect.sync(() => {
      calls.push(input.args);
      const user = input.args[input.args.indexOf("--user") + 1];
      if (input.args.includes("--user") && user !== undefined && signedOut.includes(user)) {
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: input.args.includes("--user") ? `token-for-${user}\n` : "active-token\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    });
  const layer = GitHubCredentials.layer.pipe(
    Layer.provideMerge(
      TestSourceControlHost.layer({
        settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          sourceControlHosts: { github: { hosts: hostSettings(hosts), tokens } },
        }),
        process: { run: processRun ?? run },
      }),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`Unexpected request to ${request.url}`)),
      ),
    ),
  );
  return { layer, calls };
}

describe("GitHubCredentials", () => {
  beforeEach(() => {
    for (const name of TOKEN_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect("lets an environment token win over a pinned account, as gh does", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("from-env");
      expect(credential.source).toBe("env");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks up a changed account on the next request without a restart", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");

      yield* settings.update({
        sourceControlHosts: {
          github: { hosts: { "github.com": { account: "work", enabled: true } } },
        },
      });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("token-for-work");

      yield* settings.update({
        sourceControlHosts: { github: { hosts: { "github.com": { enabled: false } } } },
      });
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );

      yield* settings.update({ sourceControlHosts: { github: { hosts: {} } } });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("retries a missing credential immediately after an external login", () => {
    let lookups = 0;
    const { layer } = harness({}, [], {}, () =>
      Effect.sync(() => ({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: ++lookups === 1 ? "" : "signed-in",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      })),
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubNotSignedInError",
      );
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("signed-in");
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("signed-in");
      expect(lookups).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("shares a cold credential lookup and refreshes its result after expiry", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let lookups = 0;
      const { layer } = harness({}, [], {}, () =>
        Effect.gen(function* () {
          lookups++;
          if (lookups === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: lookups === 1 ? "initial" : "rotated",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
      );
      yield* Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        const requests = yield* Effect.all(
          Array.from({ length: 24 }, () => credentials.get("github.com")),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(requests)).map(({ token }) => Redacted.value(token))).toEqual(
          Array.from({ length: 24 }, () => "initial"),
        );
        expect(lookups).toBe(1);
        yield* TestClock.adjust("6 minutes");
        expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("rotated");
        expect(lookups).toBe(2);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("falls back to the active login when the pinned one is no longer signed in", () => {
    const { layer, calls } = harness({ "github.com": { account: "gone" } }, ["gone"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "gone"],
        ["auth", "token", "--hostname", "github.com"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses a token saved in Settings before GH_TOKEN and gh", () => {
    vi.stubEnv("GH_TOKEN", "env-token");
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("saved-token");
      expect(credential.source).toBe("settings");

      // A reference left in place by getWithSecrets is one its secret provider could not read.
      yield* settings.update({
        secretProviders: {
          [SecretProviderId.make("vault")]: {
            kind: SecretProviderKind.make("one_password"),
            label: "Work vault",
            config: {},
          },
        },
        sourceControlHosts: {
          github: {
            tokens: {
              "github.com": { provider: SecretProviderId.make("vault"), reference: "gh#token" },
            },
          },
        },
      });
      const error = yield* Effect.flip(credentials.get("github.com"));
      expect(error._tag).toBe("SettingsSecretUnresolvedError");
      expect(error.message).toContain('"Work vault"');
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a host turned off even with a token saved in Settings", () => {
    const { layer } = harness({ "github.com": { enabled: false } }, [], {
      "github.com": "saved-token",
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("never hands a token to a host that is not a plain hostname", () => {
    vi.stubEnv("GH_TOKEN", "env-token");
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      for (const host of ["evil.com#.ghe.com", "evil.com/.ghe.com", "user@x.ghe.com"]) {
        expect(GitHubCredentials.environmentToken(host, { GH_TOKEN: "env-token" })).toBeNull();
        expect((yield* Effect.flip(credentials.get(host)))._tag).toBe("GitHubNotSignedInError");
      }
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
