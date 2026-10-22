import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { describe, it } from "node:test";
import { apkBuildOptions } from "./build-mobile-apk.mjs";

const signing = {
  JAVA_HOME: "/opt/java",
  ANDROID_HOME: "/opt/android",
  NEOCODE_ANDROID_KEYSTORE: "/private/neocode.jks",
  NEOCODE_ANDROID_KEY_ALIAS: "release",
  NEOCODE_ANDROID_STORE_PASSWORD: "test-store-password",
  NEOCODE_ANDROID_KEY_PASSWORD: "test-key-password",
};

describe("local APK build admission", () => {
  it("requires an explicit Android update version rather than silently reusing one", () => {
    for (const value of [undefined, "0", "1.5", "NaN", "-1", "2100000001"]) {
      assert.throws(() => apkBuildOptions(value ? ["--version-code", value] : [], signing), /version-code/);
    }
  });

  it("refuses every missing signing input before starting prebuild", () => {
    for (const key of Object.keys(signing)) {
      assert.throws(() => apkBuildOptions(["--version-code", "42"], { ...signing, [key]: "" }), new RegExp(key));
    }
    assert.throws(() => apkBuildOptions(["--version-code", "42"], { ...signing, NEOCODE_ANDROID_KEYSTORE: "release.jks" }), /absolute path/);
  });

  it("accepts explicit target ABIs and resolves the output without device discovery", () => {
    const options = apkBuildOptions(["--version-code", "42", "--architectures", "arm64-v8a,x86_64", "--output", "artifacts/neocode.apk"], signing);
    assert.equal(options.versionCode, "42");
    assert.equal(options.architectures, "arm64-v8a,x86_64");
    assert.equal(isAbsolute(options.output), true);
    assert.ok(options.output.endsWith("neocode.apk"));
  });

  it("rejects unsupported ABIs and malformed arguments", () => {
    assert.throws(() => apkBuildOptions(["--version-code", "42", "--architectures", "mips"], signing), /architecture/);
    assert.throws(() => apkBuildOptions(["--version-code"], signing), /Missing value/);
    assert.throws(() => apkBuildOptions(["--install", "device"], signing), /Unknown option/);
  });
});
