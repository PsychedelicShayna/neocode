import { describe, expect, it } from "vite-plus/test";
import { androidVersionCode } from "./mobileDistribution";

describe("Android APK update versions", () => {
  it("accepts explicit monotonically chosen build codes without coercing malformed input", () => {
    expect(androidVersionCode("42")).toBe(42);
    expect(androidVersionCode("2100000000")).toBe(2_100_000_000);
    for (const input of ["", "0", "-1", "1.5", "1e3", " 42 ", "Infinity", "2100000001"]) {
      expect(() => androidVersionCode(input)).toThrow("NEOCODE_ANDROID_VERSION_CODE");
    }
  });
});
