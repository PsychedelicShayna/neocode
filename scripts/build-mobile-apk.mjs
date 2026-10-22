import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mobile = join(repo, "apps/mobile");

export function apkBuildOptions(args, env) {
  let versionCode;
  let output;
  let architectures = "arm64-v8a,armeabi-v7a,x86_64";
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--version-code") versionCode = value;
    else if (flag === "--output") output = resolve(value);
    else if (flag === "--architectures") architectures = value;
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (
    !versionCode ||
    !/^\d+$/.test(versionCode) ||
    Number(versionCode) < 1 ||
    Number(versionCode) > 2_100_000_000
  ) {
    throw new Error(
      "Pass --version-code with an integer between 1 and 2100000000. Increase it for each update.",
    );
  }
  const supported = new Set(["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]);
  if (architectures.split(",").some((abi) => !supported.has(abi))) {
    throw new Error("Unsupported Android architecture. Use arm64-v8a, armeabi-v7a, x86 or x86_64.");
  }
  for (const key of [
    "JAVA_HOME",
    "ANDROID_HOME",
    "NEOCODE_ANDROID_KEYSTORE",
    "NEOCODE_ANDROID_KEY_ALIAS",
    "NEOCODE_ANDROID_STORE_PASSWORD",
    "NEOCODE_ANDROID_KEY_PASSWORD",
  ]) {
    if (!env[key]?.trim())
      throw new Error(`Set ${key} before building. No debug signing fallback is allowed.`);
  }
  if (!isAbsolute(env.NEOCODE_ANDROID_KEYSTORE))
    throw new Error("NEOCODE_ANDROID_KEYSTORE must be an absolute path.");
  return {
    versionCode,
    architectures,
    output: output ?? join(homedir(), ".cache/neocode-apk", `neocode-${versionCode}.apk`),
  };
}

export function buildApk(args = process.argv.slice(2), environment = process.env) {
  const options = apkBuildOptions(args, environment);
  const env = {
    ...environment,
    APP_VARIANT: "production",
    NEOCODE_ANDROID_VERSION_CODE: options.versionCode,
    EXPO_NO_GIT_STATUS: "1",
    CI: "1",
  };
  const run = (program, args, cwd = mobile, capture = false) => {
    const result = spawnSync(program, args, {
      cwd,
      env,
      stdio: capture ? "pipe" : "inherit",
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${program} failed with exit code ${result.status}.`);
    return result.stdout?.trim() ?? "";
  };
  if (!existsSync(env.NEOCODE_ANDROID_KEYSTORE))
    throw new Error("The signing keystore does not exist.");
  const apksigner = join(
    env.ANDROID_HOME,
    "build-tools/36.0.0",
    process.platform === "win32" ? "apksigner.bat" : "apksigner",
  );
  if (!existsSync(apksigner))
    throw new Error("Install Android SDK build-tools 36.0.0 before building.");
  if (run("git", ["ls-files", "apps/mobile/android"], repo, true)) {
    throw new Error("Refusing clean prebuild because apps/mobile/android contains tracked files.");
  }
  // Uses the checked-in lockfile and already installed workspace tools. Never installs dependencies or a device app.
  run("vp", ["exec", "expo", "prebuild", "--clean", "--no-install", "--platform", "android"]);
  run(
    process.platform === "win32" ? "gradlew.bat" : "./gradlew",
    [
      "--no-daemon",
      "--max-workers=2",
      "--init-script",
      join(mobile, "scripts/android-sideload-signing.gradle"),
      `-PreactNativeArchitectures=${options.architectures}`,
      ":app:assembleRelease",
    ],
    join(mobile, "android"),
  );
  const apk = join(mobile, "android/app/build/outputs/apk/release/app-release.apk");
  run(apksigner, ["verify", "--verbose", "--print-certs", apk]);
  mkdirSync(dirname(options.output), { recursive: true });
  copyFileSync(apk, options.output);
  const digest = createHash("sha256").update(readFileSync(options.output)).digest("hex");
  writeFileSync(`${options.output}.sha256`, `${digest}  ${options.output.split(/[\\/]/).at(-1)}\n`);
  console.log(
    `Signed APK: ${options.output}\nSHA-256: ${digest}\nNo device was accessed. Install only on an authorized target.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    buildApk();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
