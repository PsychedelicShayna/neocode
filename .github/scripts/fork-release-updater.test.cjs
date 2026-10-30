const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const workflow = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");
function stepScript(name) {
  const step = workflow.match(
    new RegExp(`- name: ${name}\\n[\\s\\S]*?        run: \\|\\n((?:          .*\\n|\\n)+)`),
  );
  assert.ok(step, `Could not find workflow step ${name}`);
  return step[1].replace(/^          /gm, "");
}
const metadataScript = stepScript("Resolve immutable source and append-only tag");
const manifestScript = stepScript("Prepare fork updater manifests");

function withScratch(run) {
  const root = process.env.TMPDIR || join(homedir(), ".cache/neocode-tests");
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "neocode-fork-feed-test-"));
  try {
    return run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
function runScript(script, cwd, env) {
  const result = spawnSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  assert.ifError(result.error);
  return result;
}

for (const [name, event, ref, dispatch, channel] of [
  ["nightly push", "push", "refs/heads/nightly", "", "nightly"],
  ["stable push", "push", "refs/heads/main", "", "stable"],
  ["scheduled nightly", "schedule", "refs/heads/main", "", "nightly"],
  ["manual nightly", "workflow_dispatch", "refs/heads/main", "nightly", "nightly"],
  ["manual stable", "workflow_dispatch", "refs/heads/main", "stable", "stable"],
  ["manual preview", "workflow_dispatch", "refs/heads/main", "preview", "preview"],
  ["stable tag", "push", "refs/tags/v1.2.3", "", "stable"],
]) {
  test(`exports the actual channel for ${name}`, () =>
    withScratch((cwd) => {
      const outputPath = join(cwd, "outputs");
      const result = runScript(
        'git() { printf "%s\\n" fixture-sha; }\n' +
          'node() { printf "%s\\n" 1.2.3; }\n' +
          metadataScript,
        cwd,
        {
          GITHUB_OUTPUT: outputPath,
          GITHUB_EVENT_NAME: event,
          GITHUB_REF: ref,
          GITHUB_REF_NAME: ref.split("/").at(-1),
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          DISPATCH_CHANNEL: dispatch,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.ok(readFileSync(outputPath, "utf8").split("\n").includes(`channel=${channel}`));
    }));
}

function prepareManifests(channel, files, inspect) {
  return withScratch((cwd) => {
    const assets = join(cwd, "release-assets");
    mkdirSync(assets);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(assets, name), content);
    const result = runScript(manifestScript, cwd, { RELEASE_CHANNEL: channel });
    inspect(result, assets, readdirSync(assets).sort());
  });
}

for (const channel of ["stable", "nightly"]) {
  test(`publishes only the feed paths consumers request for ${channel}`, () => {
    const feed = channel === "nightly" ? "nightly" : "latest";
    prepareManifests(
      channel,
      {
        [`${feed}-linux.yml`]: "linux manifest with installer hashes\n",
        [`${feed}-win-x64.yml`]: "windows manifest with installer hash\n",
        "NeoCode-1.2.3-x64.exe.blockmap": "blockmap bytes",
      },
      (result, _assets, names) => {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(names.includes(`${feed}.yml`), true);
        assert.equal(names.includes(`${feed}-linux.yml`), true);
        assert.equal(
          names.some((name) => name.endsWith("-win-x64.yml")),
          false,
        );
        if (channel === "nightly") {
          assert.equal(names.includes("latest-linux.yml"), true);
          assert.equal(names.includes("latest.yml"), false);
        } else {
          assert.equal(
            names.some((name) => name.startsWith("nightly")),
            false,
          );
        }
      },
    );
  });
}

test("accepts a manual-only preview with no updater metadata", () => {
  prepareManifests("preview", { "NeoCode-preview.AppImage": "installer" }, (result) => {
    assert.equal(result.status, 0, result.stderr);
  });
});
for (const name of ["latest-linux.yml", "nightly-win-x64.yml", "installer.exe.blockmap"]) {
  test(`refuses ${name} on a preview release`, () => {
    prepareManifests("preview", { [name]: "unexpected metadata" }, (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Preview releases must not carry updater metadata/);
    });
  });
}
for (const missing of ["nightly-linux.yml", "nightly-win-x64.yml"]) {
  test(`refuses publication when ${missing} was not collected`, () => {
    const files = { "nightly-linux.yml": "linux", "nightly-win-x64.yml": "windows" };
    delete files[missing];
    prepareManifests("nightly", files, (result) => assert.notEqual(result.status, 0));
  });
}
