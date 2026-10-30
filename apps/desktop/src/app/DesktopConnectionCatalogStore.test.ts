import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);
const encodeLegacySavedEnvironments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(Schema.Unknown) }),
  ),
);
type EncryptionAvailability =
  | boolean
  | ElectronSafeStorage.ElectronSafeStorage["Service"]["isEncryptionAvailable"];

function makeSafeStorageLayer(
  available: EncryptionAvailability,
  failDecrypt: Ref.Ref<boolean> | null = null,
) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: typeof available === "boolean" ? Effect.succeed(available) : available,
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      return Effect.gen(function* () {
        const decoded = textDecoder.decode(value);
        if (
          !decoded.startsWith("encrypted:") ||
          (failDecrypt !== null && (yield* Ref.get(failDecrypt)))
        ) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted catalog"),
          });
        }
        return decoded.slice("encrypted:".length);
      });
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function makeLayer(
  baseDir: string,
  encryptionAvailable: EncryptionAvailability = true,
  failDecrypt: Ref.Ref<boolean> | null = null,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
  platform: NodeJS.Platform = "darwin",
) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform,
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const safeStorageLayer = makeSafeStorageLayer(encryptionAvailable, failDecrypt);
  const dependencies = Layer.mergeAll(
    environmentLayer,
    safeStorageLayer,
    NodeServices.layer,
    fileSystemLayer,
  );
  const savedEnvironmentsLayer = DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(dependencies),
  );

  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(savedEnvironmentsLayer),
    Layer.provideMerge(dependencies),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
  encryptionAvailable: EncryptionAvailability = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-connection-catalog-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore", () => {
  it.effect("persists, reads, and clears an encrypted connection catalog", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalog = '{"schemaVersion":1,"targets":[]}';

        assert.isTrue(yield* store.set(catalog));
        assert.deepStrictEqual(yield* store.get, { catalog, recovery: null });

        yield* store.clear;
        assert.deepStrictEqual(yield* store.get, { catalog: null, recovery: null });
      }),
    ),
  );

  it.effect("does not persist when secure storage is unavailable", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        assert.isFalse(yield* store.set("{}"));
        assert.deepStrictEqual(yield* store.get, { catalog: null, recovery: null });
      }),
      false,
    ),
  );

  it.effect("loads missing and empty registries without accessing secure storage", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        assert.deepStrictEqual(yield* store.get, { catalog: null, recovery: null });

        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({ version: 1, records: [] }),
        );

        assert.deepStrictEqual(yield* store.get, { catalog: null, recovery: null });
        assert.isFalse(
          yield* fileSystem.exists(path.join(environment.stateDir, "connection-catalog.json")),
        );
      }),
      Effect.fail(
        new ElectronSafeStorage.ElectronSafeStorageAvailabilityError({
          cause: new Error("keyring access requires user interaction"),
        }),
      ),
    ),
  );

  it.effect("migrates legacy relay, SSH, bearer profile, and credential data", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const records: readonly PersistedSavedEnvironmentRecord[] = [
          {
            environmentId: EnvironmentId.make("relay-environment"),
            label: "Relay",
            httpBaseUrl: "https://relay.example.com/",
            wsBaseUrl: "wss://relay.example.com/",
            createdAt: "2026-06-01T00:00:00.000Z",
            lastConnectedAt: null,
            relayManaged: { relayUrl: "https://relay-control.example.com/" },
          },
          {
            environmentId: EnvironmentId.make("ssh-environment"),
            label: "SSH",
            httpBaseUrl: "http://127.0.0.1:41773/",
            wsBaseUrl: "ws://127.0.0.1:41773/",
            createdAt: "2026-06-02T00:00:00.000Z",
            lastConnectedAt: null,
            desktopSsh: {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "julius",
              port: 22,
            },
          },
          {
            environmentId: EnvironmentId.make("bearer-environment"),
            label: "Bearer",
            httpBaseUrl: "https://bearer.example.com/",
            wsBaseUrl: "wss://bearer.example.com/",
            createdAt: "2026-06-03T00:00:00.000Z",
            lastConnectedAt: null,
          },
        ];
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({
            version: 1,
            records: records.map((record) =>
              record.environmentId === "bearer-environment"
                ? {
                    ...record,
                    encryptedBearerToken: Encoding.encodeBase64(
                      textEncoder.encode("encrypted:legacy-token"),
                    ),
                  }
                : record,
            ),
          }),
        );

        const migrated = yield* store.get;
        assert.isNotNull(migrated.catalog);
        if (migrated.catalog === null) return;
        const catalog = yield* decodeConnectionCatalog(migrated.catalog);

        assert.deepInclude(catalog.targets[0], {
          _tag: "RelayConnectionTarget",
          environmentId: EnvironmentId.make("relay-environment"),
          label: "Relay",
        });
        assert.deepInclude(catalog.targets[1], {
          _tag: "SshConnectionTarget",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          connectionId: "ssh:ssh-environment",
        });
        assert.deepInclude(catalog.targets[2], {
          _tag: "BearerConnectionTarget",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          connectionId: "bearer:bearer-environment",
        });
        assert.deepInclude(catalog.profiles[0], {
          _tag: "SshConnectionProfile",
          connectionId: "ssh:ssh-environment",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          target: {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 22,
          },
        });
        assert.deepInclude(catalog.profiles[1], {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:bearer-environment",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          httpBaseUrl: "https://bearer.example.com/",
          wsBaseUrl: "wss://bearer.example.com/",
        });
        assert.equal(catalog.credentials.length, 1);
        assert.equal(catalog.credentials[0]?.connectionId, "bearer:bearer-environment");
        assert.equal(catalog.credentials[0]?.credential._tag, "BearerConnectionCredential");
        if (catalog.credentials[0]?.credential._tag === "BearerConnectionCredential") {
          assert.equal(catalog.credentials[0].credential.token, "legacy-token");
        }

        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          '{"version":1,"records":[]}',
        );
        assert.deepEqual(yield* store.get, migrated);
      }),
    ),
  );

  it.effect("surfaces malformed catalog documents without deleting them", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDocumentDecodeError,
        );
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.equal(yield* fileSystem.readFileString(catalogPath), "{not-json");
      }),
    ),
  );

  it.effect("surfaces catalog filesystem failures instead of treating them as missing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseFileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: path.join(baseDir, "userdata", "connection-catalog.json"),
      });
      const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
        ...baseFileSystem,
        readFileString: (file) =>
          file.endsWith("/connection-catalog.json")
            ? Effect.fail(permissionError)
            : baseFileSystem.readFileString(file),
      });
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(makeLayer(baseDir, true, null, fileSystemLayer)),
      );

      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreReadError,
      );
      assert.equal(error.catalogPath, path.join(baseDir, "userdata", "connection-catalog.json"));
      assert.strictEqual(error.cause, permissionError);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports the failed catalog write operation and path", () =>
    Effect.gen(function* () {
      const baseFileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "makeDirectory",
        pathOrDescriptor: path.join(baseDir, "userdata"),
      });
      const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
        ...baseFileSystem,
        makeDirectory: () => Effect.fail(permissionError),
      });
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(makeLayer(baseDir, true, null, fileSystemLayer)),
      );

      const error = yield* store.set("{}").pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreWriteError,
      );
      assert.equal(error.operation, "create-directory");
      assert.equal(error.path, path.join(baseDir, "userdata"));
      assert.strictEqual(error.cause, permissionError);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports the legacy migration stage", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreMigrationError,
        );
        assert.equal(error.operation, "read-legacy-registry");
        assert.equal(error.catalogPath, path.join(environment.stateDir, "connection-catalog.json"));
        assert.instanceOf(
          error.cause,
          DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError,
        );
        const registryError =
          error.cause as DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError;
        assert.exists(registryError.cause);
      }),
    ),
  );

  it.effect("reports invalid encrypted catalog data without exposing it", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, '{"version":1,"encryptedCatalog":"%%%"}\n');

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDecodeError,
        );
        assert.equal(error.resource, "encryptedCatalog");
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.notInclude(error.message, "%%%");
      }),
    ),
  );

  it.effect("preserves wrong-key ciphertext and re-added connections across restart", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const failDecrypt = yield* Ref.make(false);
      const store = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(baseDir, true, failDecrypt)),
      );
      const catalogPath = path.join(baseDir, "userdata", "connection-catalog.json");
      assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
      const original = yield* fileSystem.readFile(catalogPath);
      yield* Ref.set(failDecrypt, true);
      const recovered = yield* store.get;
      assert.isNull(recovered.catalog);
      assert.equal(recovered.recovery?.reason, "decrypt-failed");
      assert.equal(recovered.recovery?.status, "preserved");
      const preservedPath = recovered.recovery?.preservedPath;
      assert.isString(preservedPath);
      if (!preservedPath) return;
      assert.isTrue(Buffer.from(yield* fileSystem.readFile(preservedPath)).equals(original));
      assert.isFalse(yield* fileSystem.exists(catalogPath));
      const restarted = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(baseDir, true, failDecrypt)),
      );
      assert.deepEqual(yield* restarted.get, recovered);
      yield* Ref.set(failDecrypt, false);
      const replacement = '{"schemaVersion":1,"targets":[],"credentials":[{"token":"new-secret"}]}';
      assert.isTrue(yield* restarted.set(replacement));
      const third = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(baseDir)),
      );
      assert.deepEqual(yield* third.get, { catalog: replacement, recovery: recovered.recovery });
      assert.notInclude(yield* fileSystem.readFileString(catalogPath), "new-secret");
      assert.isTrue(Buffer.from(yield* fileSystem.readFile(preservedPath)).equals(original));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("distinguishes existing ciphertext from absence when encryption is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-unavailable-" });
      const initial = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(base)),
      );
      yield* initial.set("{}");
      const original = yield* fs.readFile(`${base}/userdata/connection-catalog.json`);
      const unavailable = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(base, false)),
      );
      const result = yield* unavailable.get;
      assert.isNull(result.catalog);
      assert.equal(result.recovery?.reason, "encryption-unavailable");
      assert.equal(result.recovery?.status, "preserved");
      assert.isTrue(
        Buffer.from(yield* fs.readFile(result.recovery!.preservedPath!)).equals(original),
      );
      assert.isFalse(yield* unavailable.set('{"new":true}'));
      assert.isFalse(yield* fs.exists(`${base}/userdata/connection-catalog.json`));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not overwrite a colliding preserved filename", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-collision-" });
      const initial = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(base)),
      );
      yield* initial.set("{}");
      const original = yield* fs.readFile(`${base}/userdata/connection-catalog.json`);
      let collision: string | undefined;
      const faultFs = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        link: (from, to) =>
          Effect.gen(function* () {
            if (collision === undefined) {
              collision = to;
              yield* fs.writeFileString(to, "existing-preserved-file", { flag: "wx" });
            }
            yield* fs.link(from, to);
          }),
      });
      const fail = yield* Ref.make(true);
      const store = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(base, true, fail, faultFs)),
      );
      const result = yield* store.get;
      assert.equal(result.recovery?.status, "preserved");
      assert.notEqual(result.recovery?.preservedPath, collision);
      assert.equal(yield* fs.readFileString(collision!), "existing-preserved-file");
      assert.isTrue(
        Buffer.from(yield* fs.readFile(result.recovery!.preservedPath!)).equals(original),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "preserves a newly unreadable catalog when the previous recovery file was removed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-missing-recovery-" });
        const fail = yield* Ref.make(false);
        const store = yield* DesktopConnectionCatalogStore.make.pipe(
          Effect.provide(makeLayer(base, true, fail)),
        );
        yield* store.set('{"old":true}');
        yield* Ref.set(fail, true);
        const old = (yield* store.get).recovery!.preservedPath!;
        yield* Ref.set(fail, false);
        yield* store.set('{"replacement":true}');
        const original = yield* fs.readFile(`${base}/userdata/connection-catalog.json`);
        yield* fs.remove(old);
        yield* Ref.set(fail, true);
        const recovered = yield* store.get;
        assert.equal(recovered.recovery?.status, "preserved");
        assert.notEqual(recovered.recovery?.preservedPath, old);
        assert.isTrue(
          Buffer.from(yield* fs.readFile(recovered.recovery!.preservedPath!)).equals(original),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("makes preserved data and its directory durable before removing the active name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-durable-recovery-" });
      const catalogPath = `${base}/userdata/connection-catalog.json`;
      const initial = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(base)),
      );
      yield* initial.set("{}");
      let preservedSynced = false;
      let directorySynced = false;
      const faultFs = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        open: (file, options) =>
          fs.open(file, options).pipe(
            Effect.map((handle) =>
              file.endsWith(".unreadable.json") || file === `${base}/userdata`
                ? {
                    ...handle,
                    sync: handle.sync.pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          if (file.endsWith(".unreadable.json")) preservedSynced = true;
                          if (file === `${base}/userdata`) directorySynced = true;
                        }),
                      ),
                    ),
                  }
                : handle,
            ),
          ),
        remove: (file, options) =>
          Effect.gen(function* () {
            if (file === catalogPath) {
              assert.isTrue(preservedSynced);
              assert.isTrue(directorySynced);
              assert.isTrue(yield* fs.exists(`${base}/userdata/connection-catalog-recovery.json`));
            }
            yield* fs.remove(file, options);
          }),
      });
      const fail = yield* Ref.make(true);
      const store = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(base, true, fail, faultFs)),
      );
      assert.equal((yield* store.get).recovery?.status, "preserved");
      assert.isFalse(yield* fs.exists(catalogPath));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  for (const available of [true, false]) {
    it.effect(
      `allows Windows recovery, re-add and restart when encryption is ${available ? "available" : "unavailable"}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const base = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-windows-sync-" });
          const catalogPath = `${base}/userdata/connection-catalog.json`;
          const initial = yield* DesktopConnectionCatalogStore.make.pipe(
            Effect.provide(makeLayer(base)),
          );
          yield* initial.set('{"old":true}');
          const original = yield* fs.readFile(catalogPath);
          const denied = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "sync",
            cause: Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
          });
          const windowsFs = Layer.succeed(FileSystem.FileSystem, {
            ...fs,
            open: (file, options) =>
              fs
                .open(file, options)
                .pipe(
                  Effect.map((handle) =>
                    file === `${base}/userdata` ||
                    (file.endsWith(".unreadable.json") && options?.flag === "r")
                      ? { ...handle, sync: Effect.fail(denied) }
                      : handle,
                  ),
                ),
          });
          const failDecrypt = yield* Ref.make(true);
          const store = yield* DesktopConnectionCatalogStore.make.pipe(
            Effect.provide(makeLayer(base, available, failDecrypt, windowsFs, "win32")),
          );
          const recovered = yield* store.get;
          assert.equal(recovered.recovery?.status, "preserved");
          const preservedPath = recovered.recovery!.preservedPath!;
          assert.isTrue(Buffer.from(yield* fs.readFile(preservedPath)).equals(original));
          assert.isFalse(yield* fs.exists(catalogPath));
          yield* Ref.set(failDecrypt, false);
          const writable = yield* DesktopConnectionCatalogStore.make.pipe(
            Effect.provide(makeLayer(base, true, failDecrypt, windowsFs, "win32")),
          );
          assert.isTrue(yield* writable.set('{"replacement":true}'));
          const restarted = yield* DesktopConnectionCatalogStore.make.pipe(
            Effect.provide(makeLayer(base, true, failDecrypt, windowsFs, "win32")),
          );
          assert.deepEqual(yield* restarted.get, {
            catalog: '{"replacement":true}',
            recovery: recovered.recovery,
          });
          yield* restarted.clear;
          assert.isNull((yield* restarted.get).catalog);
          assert.isTrue(Buffer.from(yield* fs.readFile(preservedPath)).equals(original));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }

  for (const { platform, code, target } of [
    { platform: "linux", code: "EPERM", target: "directory" },
    { platform: "win32", code: "EACCES", target: "directory" },
    { platform: "win32", code: "EIO", target: "directory" },
    { platform: "win32", code: "EPERM", target: "file" },
  ] as const) {
    it.effect(`retains the active catalog on ${platform} ${target} sync ${code}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-sync-error-" });
        const catalogPath = `${base}/userdata/connection-catalog.json`;
        const initial = yield* DesktopConnectionCatalogStore.make.pipe(
          Effect.provide(makeLayer(base)),
        );
        yield* initial.set('{"old":true}');
        const original = yield* fs.readFile(catalogPath);
        const failure = PlatformError.systemError({
          _tag: code === "EIO" ? "Unknown" : "PermissionDenied",
          module: "FileSystem",
          method: "sync",
          cause: Object.assign(new Error("injected filesystem error"), { code }),
        });
        const faultFs = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          open: (file, options) =>
            fs
              .open(file, options)
              .pipe(
                Effect.map((handle) =>
                  (
                    target === "directory"
                      ? file === `${base}/userdata`
                      : file.endsWith(".unreadable.json")
                  )
                    ? { ...handle, sync: Effect.fail(failure) }
                    : handle,
                ),
              ),
        });
        const failDecrypt = yield* Ref.make(true);
        const store = yield* DesktopConnectionCatalogStore.make.pipe(
          Effect.provide(makeLayer(base, true, failDecrypt, faultFs, platform)),
        );
        assert.equal((yield* store.get).recovery?.status, "blocked");
        assert.instanceOf(
          yield* store.set('{"replacement":true}').pipe(Effect.flip),
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreRecoveryError,
        );
        assert.instanceOf(
          yield* store.clear.pipe(Effect.flip),
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreRecoveryError,
        );
        assert.isTrue(Buffer.from(yield* fs.readFile(catalogPath)).equals(original));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }

  for (const failure of ["preservation", "record", "directory-sync", "remove"] as const) {
    it.effect(`blocks destructive writes when ${failure} fails and resumes safely on restart`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-preservation-failure-" });
        const catalogPath = `${base}/userdata/connection-catalog.json`;
        const initial = yield* DesktopConnectionCatalogStore.make.pipe(
          Effect.provide(makeLayer(base)),
        );
        yield* initial.set("{}");
        const original = yield* fs.readFile(catalogPath);
        const permission = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: failure,
          pathOrDescriptor: catalogPath,
        });
        const faultFs = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          link: failure === "preservation" ? () => Effect.fail(permission) : fs.link,
          rename: (from, to) =>
            failure === "record" && to.endsWith("connection-catalog-recovery.json")
              ? Effect.fail(permission)
              : fs.rename(from, to),
          open: (file, options) =>
            fs
              .open(file, options)
              .pipe(
                Effect.map((handle) =>
                  failure === "directory-sync" && file === `${base}/userdata`
                    ? { ...handle, sync: Effect.fail(permission) }
                    : handle,
                ),
              ),
          remove: (file, options) =>
            failure === "remove" && file === catalogPath
              ? Effect.fail(permission)
              : fs.remove(file, options),
        });
        const failDecrypt = yield* Ref.make(true);
        const store = yield* DesktopConnectionCatalogStore.make.pipe(
          Effect.provide(makeLayer(base, true, failDecrypt, faultFs)),
        );
        const blocked = yield* store.get;
        assert.isNull(blocked.catalog);
        assert.equal(blocked.recovery?.status, "blocked");
        assert.isNull(blocked.recovery?.preservedPath);
        assert.instanceOf(
          yield* store.set('{"replacement":true}').pipe(Effect.flip),
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreRecoveryError,
        );
        assert.instanceOf(
          yield* store.clear.pipe(Effect.flip),
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreRecoveryError,
        );
        assert.isTrue(Buffer.from(yield* fs.readFile(catalogPath)).equals(original));
        const filesBefore = yield* fs.readDirectory(`${base}/userdata`);
        if (failure === "record" || failure === "preservation") {
          assert.deepEqual(
            filesBefore.filter((name) => name.endsWith(".unreadable.json")),
            [],
          );
        }
        const restarted = yield* DesktopConnectionCatalogStore.make.pipe(
          Effect.provide(makeLayer(base, true, failDecrypt)),
        );
        const result = yield* restarted.get;
        assert.equal(result.recovery?.status, "preserved");
        assert.isTrue(
          Buffer.from(yield* fs.readFile(result.recovery!.preservedPath!)).equals(original),
        );
        assert.isFalse(yield* fs.exists(catalogPath));
        if (failure === "remove" || failure === "directory-sync") {
          const filesAfter = yield* fs.readDirectory(`${base}/userdata`);
          assert.deepEqual(
            filesAfter.filter((name) => name.endsWith(".unreadable.json")),
            filesBefore.filter((name) => name.endsWith(".unreadable.json")),
          );
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }

  it.effect("does not reimport legacy credentials after recovery removed the active catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-recovery-legacy-" });
      const initial = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(base)),
      );
      yield* initial.set("{}");
      const fail = yield* Ref.make(true);
      const store = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(base, true, fail)),
      );
      const recovered = yield* store.get;
      const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
        Effect.provide(makeLayer(base)),
      );
      // If recovery accidentally enters migration, this invalid registry fails the read.
      yield* fs.writeFileString(environment.savedEnvironmentRegistryPath, "{not-json");
      const restarted = yield* DesktopConnectionCatalogStore.make.pipe(
        Effect.provide(makeLayer(base)),
      );
      assert.deepEqual(yield* restarted.get, recovered);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
