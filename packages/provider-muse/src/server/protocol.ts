import * as Schema from "effect/Schema";

/** The latest instant a JavaScript Date holds; formatting a later one throws. */
export const LATEST_DATE_MS = 8.64e15;
const DateMillis = Schema.Finite.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(LATEST_DATE_MS),
);
/** Latest response subscription windows; verbatim Meta percentages may exceed 100. */
export const MuseSubscriptionUsage = Schema.Struct({
  observedAtMs: DateMillis,
  tier: Schema.String,
  window: Schema.Struct({
    usedPercent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    windowDurationMins: Schema.Finite.check(Schema.isGreaterThan(0)),
    resetsAtMs: DateMillis,
  }),
  weekly: Schema.Struct({
    usedPercent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    resetsAtMs: DateMillis,
  }),
});
export type MuseSubscriptionUsage = typeof MuseSubscriptionUsage.Type;
