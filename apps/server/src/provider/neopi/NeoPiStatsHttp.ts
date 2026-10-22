import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { isNeoPiStatsPathAllowed } from "@t3tools/shared/neopiStats";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal, failEnvironmentScopeRequired } from "../../auth/http.ts";
import { NeoPiStatsService } from "./NeoPiStatsService.ts";

export const NEOPI_STATS_PREFIX = "/api/neopi-stats";

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
  const match = /^\/api\/neopi-stats\/([a-zA-Z][a-zA-Z0-9_-]{0,63})\/([a-f0-9-]{36})(\/.*)$/.exec(url.value.pathname);
  if (!match) return HttpServerResponse.empty({ status: 404 });
  const [, instanceId, viewId, path] = match;
  if (!instanceId || !viewId || !path || !isNeoPiStatsPathAllowed(request.method, path)) return HttpServerResponse.empty({ status: 404 });
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) => failEnvironmentAuthInvalid(
      EnvironmentAuth.serverAuthCredentialReason(error), EnvironmentAuth.serverAuthDpopFailureReason(error))),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) => failEnvironmentInternal("internal_error", error)),
  );
  const required = request.method === "POST" ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope;
  if (!session.scopes.includes(required)) return yield* failEnvironmentScopeRequired(required);
  const stats = yield* NeoPiStatsService;
  if (request.method === "DELETE") {
    yield* stats.release(instanceId, viewId, session.sessionId);
    return HttpServerResponse.empty({ status: 204 });
  }
  return yield* Effect.gen(function* () {
    const dashboard = yield* stats.acquire(instanceId, viewId, session.sessionId, path === "/embed");
    const headers: Record<string, string> = { authorization: `Bearer ${dashboard.token}` };
    // Native action and cache validators retain their meaning. Environment credentials never go upstream.
    for (const name of ["x-omp-stats-action", "if-none-match", "accept"]) {
      const value = request.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const response = yield* client.execute(HttpClientRequest.make(request.method)(`${dashboard.origin}${path}${url.value.search}`).pipe(HttpClientRequest.setHeaders(headers)));
    const resultHeaders: Record<string, string> = { "cache-control": "no-store, no-transform", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
    for (const name of ["content-type", "etag", "content-security-policy"]) {
      const value = response.headers[name];
      if (value !== undefined) resultHeaders[name] = value;
    }
    if (response.status === 304 || response.status === 204 || request.method === "HEAD") return HttpServerResponse.empty({ status: response.status, headers: resultHeaders });
    return HttpServerResponse.stream(response.stream, { status: response.status, headers: resultHeaders,
      ...(resultHeaders["content-type"] ? { contentType: resultHeaders["content-type"] } : {}) });
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.text("Native stats is unavailable. Reopen Stats or update the selected NeoPi runtime.", { status: 503 }))));
});

export const neoPiStatsHttpRouteLayer = HttpRouter.add("*", `${NEOPI_STATS_PREFIX}/*`, handler);
