import { describe, expect, it } from "@effect/vitest";
import { NeoPiModelsError, ProviderInstanceId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";
import { makeNeoPiThemes } from "./NeoPiThemes.ts";

const target = { providerInstanceId: ProviderInstanceId.make("native"), projectId: ProjectId.make("project") };
const snapshot = {
  themes: ["native-dark", "native-light"],
  selection: {
    dark: { effective: "native-dark", global: "native-light", project: "native-dark", colors: { pageBg: "#151515", accent: "#9876ff" } },
    light: { effective: "native-light", global: null, project: null, colors: { pageBg: "#ffffff", accent: "#6543cc" } },
  },
};
function native(overrides: Partial<NeoPiModelsConnection> = {}): NeoPiModelsConnection {
  return {
    capabilities: new Set(["themes_configuration"]),
    request: () => Effect.succeed(snapshot),
    respondUi: () => Effect.void,
    ui: Stream.empty,
    changes: Stream.empty,
    validate: Effect.void,
    ...overrides,
  };
}

describe("native theme graphical boundary", () => {
  it.effect("keeps invalidations that arrive during the initial native snapshot", () => Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<void>();
    let reads = 0;
    const connection = native({
      changes: Stream.fromPubSub(changes),
      request: () => Effect.gen(function* () {
        reads++;
        if (reads === 1) {
          yield* PubSub.publish(changes, undefined);
          return snapshot;
        }
        return { ...snapshot, selection: { ...snapshot.selection, dark: { ...snapshot.selection.dark, effective: "native-light" } } };
      }),
    });
    const values = yield* makeNeoPiThemes(() => Effect.succeed(connection)).watch({ target }).pipe(Stream.take(2), Stream.runCollect);
    expect(Array.from(values).map(value => value.selection.dark.effective)).toEqual(["native-dark", "native-light"]);
    yield* PubSub.shutdown(changes);
  }));
  it.effect("keeps native project precedence and resolved colors without substituting a GUI catalog", () => Effect.gen(function* () {
    const service = makeNeoPiThemes(() => Effect.succeed(native()));
    const result = yield* service.read({ target });
    expect(result).toEqual(snapshot);
    expect(result.selection.dark.effective).not.toBe(result.selection.dark.global);
  }));

  it.effect("does not send a mutation to unsupported native executables", () => Effect.gen(function* () {
    let calls = 0;
    const service = makeNeoPiThemes(() => Effect.succeed(native({ capabilities: new Set(), request: () => { calls++; return Effect.succeed(snapshot); } })));
    const result = yield* Effect.result(service.update({ target, appearance: "dark", scope: "project", name: "native-light", expected: "native-dark" }));
    expect(result._tag).toBe("Failure");
    expect(calls).toBe(0);
  }));

  it.effect("rejects a snapshot when the connection identity changes during the read", () => Effect.gen(function* () {
    let valid = true;
    const connection = native({
      validate: Effect.suspend(() => valid ? Effect.void : Effect.fail(new NeoPiModelsError({ message: "Native identity changed" }))),
      request: () => Effect.sync(() => { valid = false; return snapshot; }),
    });
    const service = makeNeoPiThemes(() => Effect.succeed(connection));
    const result = yield* Effect.result(service.read({ target }));
    expect(result._tag).toBe("Failure");
  }));

  it.effect("does not expose malformed colors or selections as a successful snapshot", () => Effect.gen(function* () {
    const service = makeNeoPiThemes(() => Effect.succeed(native({ request: () => Effect.succeed({ ...snapshot, selection: { dark: null, light: snapshot.selection.light } }) })));
    const result = yield* Effect.result(service.read({ target }));
    expect(result._tag).toBe("Failure");
  }));
});
