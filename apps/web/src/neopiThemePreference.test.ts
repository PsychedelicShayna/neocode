import { describe, expect, it } from "vite-plus/test";
import { shouldFollowNativeTheme } from "./neopiThemePreference";

describe("native theme transition", () => {
  it("follows native selections on a client without a named palette", () => {
    expect(shouldFollowNativeTheme(null, null, null)).toBe(true);
    expect(shouldFollowNativeTheme(null, "system", null)).toBe(true);
  });
  it("preserves explicit named and unresolved palettes and raw mixed selections", () => {
    expect(shouldFollowNativeTheme(null, "iris", null)).toBe(false);
    expect(shouldFollowNativeTheme(null, "custom:not-loaded-yet", null)).toBe(false);
    expect(shouldFollowNativeTheme(null, "system", '{"dark":"custom:saved"}')).toBe(false);
  });
  it("lets an explicit follow or restore choice win without rewriting the saved palette", () => {
    expect(shouldFollowNativeTheme("true", "iris", '{"dark":"custom:saved"}')).toBe(true);
    expect(shouldFollowNativeTheme("false", null, null)).toBe(false);
  });
});
