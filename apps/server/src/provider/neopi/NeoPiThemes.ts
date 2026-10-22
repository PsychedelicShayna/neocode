import {
  NeoPiThemesConfiguration,
  NeoPiThemesError,
  type NeoPiModelsTarget,
  type NeoPiThemesInput,
  type NeoPiThemesUpdate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";

const themeError = (cause: unknown) => new NeoPiThemesError({
  message: cause instanceof Error ? cause.message : "Could not read the connected NeoPi themes.",
});
export type NeoPiThemesConnection<E> = (
  target: NeoPiModelsTarget,
) => Effect.Effect<NeoPiModelsConnection, E, Scope.Scope>;

/** Shares the native configuration transport. No GUI inventory or settings files. */
export function makeNeoPiThemes<E>(connection: NeoPiThemesConnection<E>) {
  const requireSupported = Effect.fnUntraced(function* (native: NeoPiModelsConnection) {
    yield* native.validate;
    if (!native.capabilities.has("themes_configuration")) {
      return yield* new NeoPiThemesError({ message: "This NeoPi executable does not support shared themes. Update NeoPi in NeoCore and reconnect." });
    }
  });
  const readConnection = Effect.fnUntraced(function* (native: NeoPiModelsConnection) {
    yield* requireSupported(native);
    const result = yield* native.request({ type: "get_themes_configuration" });
    yield* native.validate;
    return yield* Schema.decodeUnknownEffect(NeoPiThemesConfiguration)(result);
  });
  const read = (input: NeoPiThemesInput) => Effect.scoped(
    Effect.flatMap(connection(input.target), readConnection),
  ).pipe(Effect.mapError(themeError));
  const watch = (input: NeoPiThemesInput) => Stream.unwrap(Effect.gen(function* () {
    const native = yield* connection(input.target);
    const changes = yield* Stream.toPull(native.changes);
    return Stream.fromEffect(readConnection(native)).pipe(Stream.concat(
      Stream.fromPull(Effect.succeed(changes)).pipe(Stream.mapEffect(() => readConnection(native))),
    ));
  })).pipe(Stream.mapError(themeError));
  const update = (input: NeoPiThemesUpdate) => Effect.scoped(Effect.gen(function* () {
    if (input.scope === "project" && !input.target.projectId && !input.target.threadId) {
      return yield* new NeoPiThemesError({ message: "Choose a project before changing a project-scoped native theme." });
    }
    const native = yield* connection(input.target);
    yield* requireSupported(native);
    const result = yield* native.request({
      type: "update_theme", appearance: input.appearance, scope: input.scope,
      name: input.name, expected: input.expected,
    });
    yield* native.validate;
    return yield* Schema.decodeUnknownEffect(NeoPiThemesConfiguration)(result);
  })).pipe(Effect.mapError(themeError));
  return { read, watch, update };
}
