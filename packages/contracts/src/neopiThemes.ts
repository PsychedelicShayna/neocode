import * as Schema from "effect/Schema";
import { NeoPiModelsTarget } from "./neopiModels.ts";

export const NeoPiThemeAppearance = Schema.Literals(["dark", "light"]);
export const NeoPiThemeScope = Schema.Literals(["global", "project"]);
export const NeoPiThemeSelection = Schema.Struct({
  effective: Schema.String,
  global: Schema.NullOr(Schema.String),
  project: Schema.NullOr(Schema.String),
  colors: Schema.Record(Schema.String, Schema.String),
});
export const NeoPiThemesConfiguration = Schema.Struct({
  themes: Schema.Array(Schema.String),
  selection: Schema.Struct({ dark: NeoPiThemeSelection, light: NeoPiThemeSelection }),
});
export type NeoPiThemesConfiguration = typeof NeoPiThemesConfiguration.Type;
export const NeoPiThemesInput = Schema.Struct({ target: NeoPiModelsTarget });
export type NeoPiThemesInput = typeof NeoPiThemesInput.Type;
export const NeoPiThemesUpdate = Schema.Struct({
  target: NeoPiModelsTarget,
  appearance: NeoPiThemeAppearance,
  scope: NeoPiThemeScope,
  name: Schema.NullOr(Schema.String),
  expected: Schema.NullOr(Schema.String),
});
export type NeoPiThemesUpdate = typeof NeoPiThemesUpdate.Type;
export class NeoPiThemesError extends Schema.TaggedError<NeoPiThemesError>()("NeoPiThemesError", {
  message: Schema.String,
}) {}
