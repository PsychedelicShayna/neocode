import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// Import is the public boundary here. A regression cannot launch a GUI: the
// disposable Node process forbids launches and state creation before module load.
const importProbe = String.raw`
import * as assert from "node:assert/strict";
import * as module from "node:module";
const require = module.createRequire(import.meta.url);
const fs = require("node:fs");
const childProcess = require("node:child_process");
process.env = { HOME: "/fixture/home", PATH: "/fixture/bin", T3CODE_IMPORT_SENTINEL: "kept" };
const forbidden = (operation) => () => { throw new Error("Import attempted " + operation); };
for (const name of ["mkdtempSync", "mkdirSync", "writeFileSync", "appendFileSync", "rmSync"]) fs[name] = forbidden(name);
const open = fs.openSync;
fs.openSync = (path, flags, ...rest) => {
  // Node's ESM loader must be able to read the module itself.
  if (flags !== "r" && flags !== fs.constants.O_RDONLY) forbidden("writable open")();
  return open(path, flags, ...rest);
};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = forbidden(name);
module.syncBuiltinESMExports();
globalThis.setTimeout = forbidden("timer");
globalThis.setInterval = forbidden("interval");
process.kill = forbidden("signal");
process.exit = forbidden("exit");
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const listener = () => {};
for (const signal of signals) process.on(signal, listener);
const before = signals.map(signal => process.listeners(signal));
const environment = {...process.env};
process.exitCode = 73;
const imported = await import(process.argv[1]);
assert.equal(typeof imported.runIsolatedGuiProcess, "function");
assert.equal(process.exitCode, 73);
assert.ok(Object.keys(process.env).length === Object.keys(environment).length &&
  Object.entries(environment).every(([key, value]) => process.env[key] === value),
  "Import changed the supplied environment");
for (const [index, signal] of signals.entries()) assert.deepEqual(process.listeners(signal), before[index]);
process.exitCode = 0;
console.log("import-isolation-ok");
`;

describe("isolated GUI process module", () => {
  it.effect("imports without launching, creating state or changing process policy", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const output = yield* spawner.string(
        ChildProcess.make(process.execPath, [
          "--input-type=module",
          "-e",
          importProbe,
          new URL("./isolated-gui-process.mjs", import.meta.url).href,
        ]),
        { includeStderr: true },
      );
      assert.equal(output, "import-isolation-ok\n");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
