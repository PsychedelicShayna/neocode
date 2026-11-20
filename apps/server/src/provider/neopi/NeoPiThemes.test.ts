import { describe, expect, it } from "@effect/vitest";
import { NeoPiModelsError, ProviderInstanceId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";
import { makeNeoPiThemes } from "./NeoPiThemes.ts";

const target = {
  providerInstanceId: ProviderInstanceId.make("native"),
  projectId: ProjectId.make("project"),
};
const snapshot = {
  themes: ["native-dark", "native-light"],
  selection: {
    dark: {
      effective: "native-dark",
      global: "native-light",
      project: "native-dark",
      colors: { pageBg: "#151515", accent: "#9876ff" },
    },
    light: {
      effective: "native-light",
      global: null,
      project: null,
      colors: { pageBg: "#ffffff", accent: "#6543cc" },
    },
  },
};
function native(overrides: Partial<NeoPiModelsConnection> = {}): NeoPiModelsConnection {
  return {
    capabilities: new Set(["themes_configuration"]),
    request: () => Effect.succeed(snapshot),
    respondUi: () => Effect.void,
    loginUi: () => Effect.succeed(Stream.empty),
    changes: Stream.empty,
    validate: Effect.void,
    ...overrides,
  };
}

describe("native theme graphical boundary", () => {
  it.effect(
    "keeps native project precedence and resolved colors without substituting a GUI catalog",
    () =>
      Effect.gen(function* () {
        const service = makeNeoPiThemes(() => Effect.succeed(native()));
        const result = yield* service.read({ target });
        expect(result).toEqual(snapshot);
        expect(result.selection.dark.effective).not.toBe(result.selection.dark.global);
      }),
  );

  it.effect("does not read themes from unsupported native executables", () =>
    Effect.gen(function* () {
      let calls = 0;
      const service = makeNeoPiThemes(() =>
        Effect.succeed(
          native({
            capabilities: new Set(),
            request: () => {
              calls++;
              return Effect.succeed(snapshot);
            },
          }),
        ),
      );
      const result = yield* Effect.result(service.read({ target }));
      expect(result._tag).toBe("Failure");
      expect(calls).toBe(0);
    }),
  );

  it.effect("rejects a snapshot when the connection identity changes during the read", () =>
    Effect.gen(function* () {
      let valid = true;
      const connection = native({
        validate: Effect.suspend(() =>
          valid
            ? Effect.void
            : Effect.fail(new NeoPiModelsError({ message: "Native identity changed" })),
        ),
        request: () =>
          Effect.sync(() => {
            valid = false;
            return snapshot;
          }),
      });
      const service = makeNeoPiThemes(() => Effect.succeed(connection));
      const result = yield* Effect.result(service.read({ target }));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("does not expose malformed colors or selections as a successful snapshot", () =>
    Effect.gen(function* () {
      const service = makeNeoPiThemes(() =>
        Effect.succeed(
          native({
            request: () =>
              Effect.succeed({
                ...snapshot,
                selection: { dark: null, light: snapshot.selection.light },
              }),
          }),
        ),
      );
      const result = yield* Effect.result(service.read({ target }));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("reads a named palette without sending a theme mutation", () =>
    Effect.gen(function* () {
      const palette = { name: "dark-arctic", colors: { pageBg: "#131b25", accent: "#68c8ed" } };
      const requests: unknown[] = [];
      const connection = native({
        capabilities: new Set(["theme_palette"]),
        request: (command) => {
          requests.push(command);
          return Effect.succeed(palette);
        },
      });
      const result = yield* makeNeoPiThemes(() => Effect.succeed(connection)).palette({
        target,
        name: palette.name,
      });
      expect(result).toEqual(palette);
      expect(requests).toEqual([{ type: "get_theme", name: palette.name }]);
    }),
  );

  it.effect("requires read-only palette capability before sending a named read", () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      const connection = native({
        request: (command) => {
          requests.push(command);
          return Effect.succeed(snapshot);
        },
      });
      const result = yield* Effect.result(
        makeNeoPiThemes(() => Effect.succeed(connection)).palette({
          target,
          name: "dark-arctic",
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(requests).toEqual([]);
    }),
  );

  it.effect("rejects a named palette from a connection that changed during its read", () =>
    Effect.gen(function* () {
      let valid = true;
      const connection = native({
        capabilities: new Set(["theme_palette"]),
        validate: Effect.suspend(() =>
          valid
            ? Effect.void
            : Effect.fail(new NeoPiModelsError({ message: "Native identity changed" })),
        ),
        request: () =>
          Effect.sync(() => {
            valid = false;
            return { name: "dark-arctic", colors: { pageBg: "#131b25" } };
          }),
      });
      const result = yield* Effect.result(
        makeNeoPiThemes(() => Effect.succeed(connection)).palette({
          target,
          name: "dark-arctic",
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects malformed named palette data instead of applying another theme", () =>
    Effect.gen(function* () {
      const connection = native({
        capabilities: new Set(["theme_palette"]),
        request: () => Effect.succeed({ name: "dark-arctic", colors: { pageBg: null } }),
      });
      const result = yield* Effect.result(
        makeNeoPiThemes(() => Effect.succeed(connection)).palette({
          target,
          name: "dark-arctic",
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
