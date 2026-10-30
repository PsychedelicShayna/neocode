import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument as RuntimeConnectionCatalogDocument,
  type ConnectionCatalogDocument as RuntimeConnectionCatalogDocumentType,
} from "@t3tools/client-runtime/platform";
import {
  type DesktopConnectionCatalogRead,
  DesktopConnectionCatalogRecovery,
  type PersistedSavedEnvironmentRecord,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const EncryptedConnectionCatalogDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedCatalog: Schema.String,
});
type EncryptedConnectionCatalogDocument = typeof EncryptedConnectionCatalogDocument.Type;

const EncryptedConnectionCatalogDocumentJson = fromLenientJson(EncryptedConnectionCatalogDocument);
const decodeEncryptedConnectionCatalogDocumentJson = Schema.decodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const encodeEncryptedConnectionCatalogDocumentJson = Schema.encodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const RuntimeConnectionCatalogDocumentJson = Schema.fromJsonString(
  RuntimeConnectionCatalogDocument,
);
const encodeRuntimeConnectionCatalogDocumentJson = Schema.encodeEffect(
  RuntimeConnectionCatalogDocumentJson,
);

const RecoveryRecord = Schema.Struct({
  version: Schema.Literal(1),
  reason: DesktopConnectionCatalogRecovery.fields.reason,
  preservedName: Schema.String.check(
    Schema.isPattern(/^connection-catalog\.[a-f0-9]+\.unreadable\.json$/),
  ),
});
const decodeRecoveryRecord = Schema.decodeEffect(Schema.fromJsonString(RecoveryRecord));
const encodeRecoveryRecord = Schema.encodeEffect(Schema.fromJsonString(RecoveryRecord));
const isEpermCause = Schema.is(Schema.Struct({ code: Schema.Literal("EPERM") }));

export class DesktopConnectionCatalogStoreRecoveryError extends Schema.TaggedError<DesktopConnectionCatalogStoreRecoveryError>()(
  "DesktopConnectionCatalogStoreRecoveryError",
  { catalogPath: Schema.String },
) {
  override get message(): string {
    return `Saved connections cannot be changed until the unreadable catalog at ${this.catalogPath} has been preserved. Check directory permissions and restart.`;
  }
}

const DesktopConnectionCatalogStoreWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-catalog-file",
]);

const DesktopConnectionCatalogStoreMigrationOperation = Schema.Literals([
  "read-legacy-registry",
  "read-legacy-secret",
  "encode-catalog",
  "persist-catalog",
]);

const DesktopConnectionCatalogStoreProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "encrypt-catalog",
  "decrypt-catalog",
]);

export class DesktopConnectionCatalogStoreWriteError extends Schema.TaggedError<DesktopConnectionCatalogStoreWriteError>()(
  "DesktopConnectionCatalogStoreWriteError",
  {
    operation: DesktopConnectionCatalogStoreWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopConnectionCatalogStoreDecodeError extends Schema.TaggedError<DesktopConnectionCatalogStoreDecodeError>()(
  "DesktopConnectionCatalogStoreDecodeError",
  {
    resource: Schema.Literal("encryptedCatalog"),
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource} for the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreReadError extends Schema.TaggedError<DesktopConnectionCatalogStoreReadError>()(
  "DesktopConnectionCatalogStoreReadError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreDocumentDecodeError extends Schema.TaggedError<DesktopConnectionCatalogStoreDocumentDecodeError>()(
  "DesktopConnectionCatalogStoreDocumentDecodeError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode the desktop connection catalog document at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreMigrationError extends Schema.TaggedError<DesktopConnectionCatalogStoreMigrationError>()(
  "DesktopConnectionCatalogStoreMigrationError",
  {
    operation: DesktopConnectionCatalogStoreMigrationOperation,
    catalogPath: Schema.String,
    environmentId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const environment =
      this.environmentId === undefined ? "" : ` for environment ${this.environmentId}`;
    return `Legacy desktop saved-environment migration failed during ${this.operation}${environment} into ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreProtectionError extends Schema.TaggedError<DesktopConnectionCatalogStoreProtectionError>()(
  "DesktopConnectionCatalogStoreProtectionError",
  {
    operation: DesktopConnectionCatalogStoreProtectionOperation,
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog protection failed during ${this.operation} at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    readonly get: Effect.Effect<
      DesktopConnectionCatalogRead,
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreMigrationError
      | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly set: (
      catalog: string,
    ) => Effect.Effect<
      boolean,
      | DesktopConnectionCatalogStoreWriteError
      | DesktopConnectionCatalogStoreProtectionError
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreMigrationError
      | DesktopConnectionCatalogStoreRecoveryError
    >;
    readonly clear: Effect.Effect<
      void,
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreMigrationError
      | DesktopConnectionCatalogStoreProtectionError
      | DesktopConnectionCatalogStoreRecoveryError
      | DesktopConnectionCatalogStoreWriteError
    >;
  }
>()("@t3tools/desktop/app/DesktopConnectionCatalogStore") {}

function decodeSecretBytes(
  catalogPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopConnectionCatalogStoreDecodeError> {
  return Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreDecodeError({
          resource: "encryptedCatalog",
          catalogPath,
          cause,
        }),
    ),
  );
}

const readDocument = (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.Effect<
  Option.Option<EncryptedConnectionCatalogDocument>,
  DesktopConnectionCatalogStoreReadError | DesktopConnectionCatalogStoreDocumentDecodeError
> =>
  fileSystem.readFileString(catalogPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(
            new DesktopConnectionCatalogStoreReadError({
              catalogPath,
              cause: error,
            }),
          ),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(Option.none<EncryptedConnectionCatalogDocument>())
        : decodeEncryptedConnectionCatalogDocumentJson(raw).pipe(
            Effect.asSome,
            Effect.mapError(
              (cause) =>
                new DesktopConnectionCatalogStoreDocumentDecodeError({
                  catalogPath,
                  cause,
                }),
            ),
          ),
    ),
  );

const writeDocument = Effect.fn("desktop.connectionCatalogStore.writeDocument")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly catalogPath: string;
  readonly document: EncryptedConnectionCatalogDocument;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopConnectionCatalogStoreWriteError> {
  const directory = input.path.dirname(input.catalogPath);
  const tempPath = `${input.catalogPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeEncryptedConnectionCatalogDocumentJson(input.document).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "encode-document",
          path: input.catalogPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* Effect.gen(function* () {
    yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "write-temporary-file",
            path: tempPath,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.rename(tempPath, input.catalogPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "replace-catalog-file",
            path: input.catalogPath,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.ensuring(
      input.fileSystem.remove(tempPath, { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove a temporary connection catalog file.", {
            tempPath,
            error,
          }),
        ),
      ),
    ),
  );
});

function connectionId(prefix: "bearer" | "ssh", environmentId: string): string {
  return `${prefix}:${environmentId}`;
}

const migrateSavedEnvironmentRecords = Effect.fn(
  "desktop.connectionCatalogStore.migrateSavedEnvironmentRecords",
)(function* (
  records: readonly PersistedSavedEnvironmentRecord[],
  savedEnvironments: DesktopSavedEnvironments.DesktopSavedEnvironments["Service"],
  catalogPath: string,
): Effect.fn.Return<
  RuntimeConnectionCatalogDocumentType,
  DesktopConnectionCatalogStoreMigrationError
> {
  const targets: Array<RuntimeConnectionCatalogDocumentType["targets"][number]> = [];
  const profiles: Array<RuntimeConnectionCatalogDocumentType["profiles"][number]> = [];
  const credentials: Array<RuntimeConnectionCatalogDocumentType["credentials"][number]> = [];

  for (const record of records) {
    if (record.relayManaged !== undefined) {
      targets.push(
        new RelayConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
        }),
      );
      continue;
    }

    if (record.desktopSsh !== undefined) {
      const id = connectionId("ssh", record.environmentId);
      targets.push(
        new SshConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
          connectionId: id,
        }),
      );
      profiles.push(
        new SshConnectionProfile({
          connectionId: id,
          environmentId: record.environmentId,
          label: record.label,
          target: record.desktopSsh,
        }),
      );
      continue;
    }

    const id = connectionId("bearer", record.environmentId);
    targets.push(
      new BearerConnectionTarget({
        environmentId: record.environmentId,
        label: record.label,
        connectionId: id,
      }),
    );
    profiles.push(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
      }),
    );
    const token = yield* savedEnvironments.getSecret(record.environmentId).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-secret",
            catalogPath,
            environmentId: record.environmentId,
            cause,
          }),
      ),
    );
    if (Option.isSome(token)) {
      credentials.push({
        connectionId: id,
        credential: new BearerConnectionCredential({ token: token.value }),
      });
    }
  }

  return {
    schemaVersion: 1,
    targets,
    profiles,
    credentials,
    remoteDpopTokens: [],
    disabledEnvironmentIds: [],
  };
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
  const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
  const recoveryPath = path.join(environment.stateDir, "connection-catalog-recovery.json");
  const lock = yield* Semaphore.make(1);

  const readRecovery = fileSystem.readFileString(recoveryPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    ),
    Effect.flatMap((raw) => (raw === null ? Effect.succeed(null) : decodeRecoveryRecord(raw))),
    Effect.mapError(
      (cause) => new DesktopConnectionCatalogStoreReadError({ catalogPath: recoveryPath, cause }),
    ),
  );

  const preserve = Effect.fn("desktop.connectionCatalogStore.preserve")(function* (
    reason: DesktopConnectionCatalogRecovery["reason"],
    previous: typeof RecoveryRecord.Type | null,
  ): Effect.fn.Return<DesktopConnectionCatalogRecovery> {
    const status = { reason, catalogPath };
    let createdPath: string | null = null;
    let recordCommitted = false;
    return yield* Effect.gen(function* () {
      let preservedPath: string | null = null;
      if (previous !== null) {
        const candidate = path.join(environment.stateDir, previous.preservedName);
        const active = yield* fileSystem.readFile(catalogPath);
        const saved = yield* fileSystem
          .readFile(candidate)
          .pipe(
            Effect.catch((error) =>
              error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
            ),
          );
        if (
          saved !== null &&
          active.length === saved.length &&
          active.every((byte, i) => byte === saved[i])
        ) {
          preservedPath = candidate;
        }
      }
      if (preservedPath === null) {
        // link is exclusive: a collision never overwrites an earlier preserved file.
        // The active catalog is replaced by rename, never edited through this link.
        while (preservedPath === null) {
          const suffix = (yield* crypto.randomUUIDv4).replace(/-/g, "");
          const candidate = path.join(
            environment.stateDir,
            `connection-catalog.${suffix}.unreadable.json`,
          );
          const linked = yield* fileSystem.link(catalogPath, candidate).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
            ),
          );
          if (linked) {
            preservedPath = candidate;
            createdPath = candidate;
          }
        }
      }
      const record = yield* encodeRecoveryRecord({
        version: 1,
        reason,
        preservedName: path.basename(preservedPath),
      });
      const temporaryPath = `${recoveryPath}.${yield* crypto.randomUUIDv4}.tmp`;
      yield* Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(temporaryPath, { flag: "wx", mode: 0o600 });
            yield* file.writeAll(new TextEncoder().encode(`${record}\n`));
            yield* file.sync;
          }),
        );
        yield* fileSystem.rename(temporaryPath, recoveryPath);
        recordCommitted = true;
      }).pipe(
        Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
      );
      // Persist both names before unlinking the original. Windows needs a writable
      // file handle and journals directory entries instead of supporting fsync.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const preserved = yield* fileSystem.open(preservedPath, { flag: "r+" });
          yield* preserved.sync;
          const directory = yield* fileSystem.open(environment.stateDir, { flag: "r" });
          yield* directory.sync.pipe(
            Effect.catch((error) =>
              environment.platform === "win32" && isEpermCause(error.reason.cause)
                ? Effect.void
                : Effect.fail(error),
            ),
          );
        }),
      );
      yield* fileSystem.remove(catalogPath);
      return { ...status, status: "preserved", preservedPath } as const;
    }).pipe(
      Effect.onError(() =>
        createdPath !== null && !recordCommitted
          ? fileSystem.remove(createdPath, { force: true }).pipe(Effect.ignore)
          : Effect.void,
      ),
      Effect.catch(() =>
        Effect.succeed({ ...status, status: "blocked", preservedPath: null } as const),
      ),
      Effect.uninterruptible,
    );
  });
  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreProtectionError({
          operation: "check-encryption-availability",
          catalogPath,
          cause,
        }),
    ),
  );

  const writeCatalog = Effect.fn("desktop.connectionCatalogStore.writeCatalog")(function* (
    catalog: string,
  ) {
    const encryptedCatalog = Encoding.encodeBase64(
      yield* safeStorage.encryptString(catalog).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreProtectionError({
              operation: "encrypt-catalog",
              catalogPath,
              cause,
            }),
        ),
      ),
    );
    const suffix = (yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "create-temporary-file-name",
            path: catalogPath,
            cause,
          }),
      ),
    )).replace(/-/g, "");
    yield* writeDocument({
      fileSystem,
      path,
      catalogPath,
      document: { version: 1, encryptedCatalog },
      suffix,
    });
  });

  const migrateLegacyCatalog = Effect.gen(function* () {
    const records = yield* savedEnvironments.getRegistry.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-registry",
            catalogPath,
            cause,
          }),
      ),
    );
    if (records.length === 0) {
      return Option.none<string>();
    }
    // Checking availability can unlock the keyring; empty profiles have nothing to protect.
    if (!(yield* encryptionAvailable)) {
      return Option.none<string>();
    }
    const catalog = yield* migrateSavedEnvironmentRecords(records, savedEnvironments, catalogPath);
    const encoded = yield* encodeRuntimeConnectionCatalogDocumentJson(catalog).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "encode-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    yield* writeCatalog(encoded).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "persist-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    return Option.some(encoded);
  });

  const get = Effect.gen(function* () {
    const record = yield* readRecovery;
    const recovery: DesktopConnectionCatalogRecovery | null =
      record === null
        ? null
        : {
            reason: record.reason,
            status: "preserved",
            catalogPath,
            preservedPath: path.join(environment.stateDir, record.preservedName),
          };
    const document = yield* readDocument(fileSystem, catalogPath);
    if (Option.isNone(document)) {
      return {
        catalog: record === null ? Option.getOrNull(yield* migrateLegacyCatalog) : null,
        recovery,
      };
    }
    const encrypted = yield* decodeSecretBytes(catalogPath, document.value.encryptedCatalog);
    if (!(yield* encryptionAvailable)) {
      return { catalog: null, recovery: yield* preserve("encryption-unavailable", record) };
    }
    return yield* safeStorage.decryptString(encrypted).pipe(
      Effect.map((catalog): DesktopConnectionCatalogRead => ({ catalog, recovery })),
      Effect.catchTag("ElectronSafeStorageDecryptError", () =>
        preserve("decrypt-failed", record).pipe(
          Effect.map((recovery): DesktopConnectionCatalogRead => ({ catalog: null, recovery })),
        ),
      ),
    );
  });

  const requirePreserved = Effect.gen(function* () {
    const result = yield* get;
    if (result.recovery?.status === "blocked") {
      return yield* new DesktopConnectionCatalogStoreRecoveryError({ catalogPath });
    }
  });

  return DesktopConnectionCatalogStore.of({
    get: lock.withPermits(1)(get).pipe(Effect.withSpan("desktop.connectionCatalogStore.get")),
    set: Effect.fn("desktop.connectionCatalogStore.set")(function* (catalog) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* requirePreserved;
          if (!(yield* encryptionAvailable)) return false;
          yield* writeCatalog(catalog);
          return true;
        }),
      );
    }),
    clear: lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* requirePreserved;
          yield* fileSystem.remove(catalogPath, { force: true }).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopConnectionCatalogStoreWriteError({
                  operation: "replace-catalog-file",
                  path: catalogPath,
                  cause,
                }),
            ),
          );
        }),
      )
      .pipe(Effect.withSpan("desktop.connectionCatalogStore.clear")),
  });
});

export const layer = Layer.effect(DesktopConnectionCatalogStore, make);
