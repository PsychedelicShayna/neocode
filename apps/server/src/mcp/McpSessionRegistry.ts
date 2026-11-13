import type { ProviderInstanceId, ThreadId, NeoPiNativeSessionRef } from "@t3tools/contracts";
import { nativeWorkspaceResourceId } from "@t3tools/shared/neopiWorkspace";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** False omits the preview capability wherever the token is honored. Defaults to full access. */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly subagent?: boolean;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly issueNative: (request: {
    readonly sessionRef: NeoPiNativeSessionRef;
    readonly capabilities: ReadonlySet<McpInvocationContext.McpCapability>;
  }) => Effect.Effect<{
    readonly authorizationHeader: string;
    readonly scope: Extract<McpInvocationContext.McpInvocationScope, { readonly kind: "native" }>;
  }>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpWorkspaceInvocationScope | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpWorkspaceInvocationScope;
  readonly lastAliveAt: number;
  readonly revoke: Effect.Effect<void>;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * `/mcp` is outside environment auth, so idle tokens stop authenticating.
 * Keep expired records until explicit revocation: a trusted provider turn can
 * refresh the token its subprocess still holds; MCP requests cannot.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const registryScope = yield* Scope.Scope;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const createRevocation = Effect.fn("McpSessionRegistry.createRevocation")(function* () {
    // Grants outlive the issuing request; revocation closes their registry-owned scope.
    const scope = yield* Scope.fork(registryScope);
    const signal = yield* Effect.abortSignal.pipe(Scope.provide(scope));
    return { signal, revoke: Scope.close(scope, Exit.void) };
  });

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(function* (
    request,
  ) {
    const issuedAt = yield* currentTimeMillis;
    const providerSessionId = yield* random.uuidV4();
    const rawToken = yield* random.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
    const tokenHash = yield* hashToken(rawToken);
    const revocation = yield* createRevocation();
    const browserToolsAvailable = request.browserToolsAvailable ?? true;
    const scope: McpInvocationContext.McpThreadInvocationScope = {
      environmentId,
      requestNamespace: providerSessionId,
      thread: {
        threadId: request.threadId,
        providerSessionId,
        providerInstanceId: request.providerInstanceId,
        subagent: request.subagent === true,
      },
      client: undefined,
      capabilities: new Set<McpInvocationContext.McpCapability>([
        "orchestration",
        "worktree",
        "pull-requests",
        ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
      ]),
      issuedAt,
      revoked: revocation.signal,
    };
    yield* SynchronizedRef.update(state, ({ records }) => {
      const next = new Map(records);
      next.set(tokenHash, { tokenHash, scope, revoke: revocation.revoke, lastAliveAt: issuedAt });
      return { records: next };
    });
    return {
      config: {
        environmentId,
        threadId: scope.thread.threadId,
        providerSessionId,
        providerInstanceId: scope.thread.providerInstanceId,
        endpoint,
        authorizationHeader: `Bearer ${rawToken}`,
        browserToolsAvailable: scope.capabilities.has("preview"),
        capabilities: scope.capabilities,
      },
    };
  }, Effect.uninterruptible);

  const issueNative: McpSessionRegistryShape["issueNative"] = Effect.fn(
    "McpSessionRegistry.issueNative",
  )(function* (request) {
    const issuedAt = yield* currentTimeMillis;
    const providerSessionId = yield* random.uuidV4();
    const rawToken = yield* random.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
    const tokenHash = yield* hashToken(rawToken);
    const revocation = yield* createRevocation();
    const scope: Extract<McpInvocationContext.McpInvocationScope, { readonly kind: "native" }> = {
      environmentId,
      kind: "native",
      requestNamespace: providerSessionId,
      thread: undefined,
      client: undefined,
      threadId: nativeWorkspaceResourceId(request.sessionRef),
      providerSessionId,
      providerInstanceId: request.sessionRef.providerInstanceId,
      sessionRef: { ...request.sessionRef },
      capabilities: new Set(request.capabilities),
      issuedAt,
      revoked: revocation.signal,
    };
    yield* SynchronizedRef.update(state, ({ records }) => {
      const next = new Map(records);
      next.set(tokenHash, { tokenHash, scope, revoke: revocation.revoke, lastAliveAt: issuedAt });
      return { records: next };
    });
    return { authorizationHeader: `Bearer ${rawToken}`, scope };
  }, Effect.uninterruptible);

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      return yield* SynchronizedRef.modify(state, ({ records }) => {
        const record = records.get(tokenHash);
        if (
          !record ||
          (record.scope.kind !== "native" && timestamp - record.lastAliveAt > livenessWindowMs)
        ) {
          return [undefined, { records }] as const;
        }
        const next = new Map(records);
        next.set(tokenHash, { ...record, lastAliveAt: timestamp });
        return [record.scope, { records: next }] as const;
      });
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        for (const [tokenHash, record] of records) {
          if (record.scope.thread?.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { records: next };
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.modify(state, ({ records }) => {
      const next = new Map(records);
      const revoked: CredentialRecord[] = [];
      for (const [key, record] of records) {
        if (predicate(record)) {
          revoked.push(record);
          next.delete(key);
        }
      }
      return [revoked, { records: next }] as const;
    }).pipe(
      Effect.flatMap((revoked) =>
        Effect.forEach(revoked, (record) => record.revoke, {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
      Effect.uninterruptible,
    );

  return McpSessionRegistry.of({
    issue,
    issueNative,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere(
          (record) =>
            (record.scope.kind === "native"
              ? record.scope.providerSessionId
              : record.scope.thread.providerSessionId) === providerSessionId,
        );
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.thread?.threadId === threadId);
    }),
    revokeAll: revokeWhere(() => true),
  });
});

const make = Effect.acquireRelease(makeWithOptions(), (registry) => registry.revokeAll);

export const layer = Layer.effect(McpSessionRegistry, make);

export const __testing = {
  make: makeWithOptions,
};
