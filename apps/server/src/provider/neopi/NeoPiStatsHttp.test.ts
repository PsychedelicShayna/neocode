import { afterEach, describe, expect, it } from "vite-plus/test";
import { AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthSessionId, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import { NeoPiStatsService } from "./NeoPiStatsService.ts";
import { neoPiStatsHttpRouteLayer } from "./NeoPiStatsHttp.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
const base = "http://environment.test/api/neopi-stats/neopi/12345678-1234-1234-1234-123456789abc";
function fixture(scopes: readonly AuthEnvironmentScope[], options: { denied?: boolean; streaming?: boolean } = {}) {
  const forwarded: Array<{ url: string; headers: Readonly<Record<string, string | undefined>> }> = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const cancelled = Promise.withResolvers<void>();
  let revoked = options.denied ?? false;
  const client = HttpClient.make((request, _url, signal) => Effect.sync(() => {
    forwarded.push({ url: request.url, headers: request.headers });
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    return HttpClientResponse.fromWeb(request, new Response(options.streaming ? new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"indexingHours":2}\n\n')); },
      cancel() { cancelled.resolve(); },
    }) : "native", { headers: { "content-type": options.streaming ? "text/event-stream" : "text/plain" } }));
  }));
  const { handler, dispose } = HttpRouter.toWebHandler(neoPiStatsHttpRouteLayer.pipe(
    Layer.provideMerge(Layer.succeed(EnvironmentAuth, {
      authenticateHttpRequest: () => revoked ? Effect.fail(new ServerAuthMissingCredentialError({})) : Effect.succeed({
        sessionId: AuthSessionId.make("session"), subject: "test", method: "bearer-access-token", scopes,
      }),
    } as unknown as EnvironmentAuth["Service"])),
    Layer.provideMerge(Layer.succeed(NeoPiStatsService, {
      acquire: (instanceId: string, viewId: string, sessionId: string) => Effect.sync(() => {
        acquired.push(`${sessionId}/${instanceId}/${viewId}`);
        return { origin: "http://native.test", token: "private-host-token" };
      }),
      release: (instanceId: string, viewId: string, sessionId: string) => Effect.sync(() => { released.push(`${sessionId}/${instanceId}/${viewId}`); }),
    } as unknown as NeoPiStatsService["Service"])),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
  ), { disableLogger: true });
  disposers.push(dispose);
  return { handler, forwarded, acquired, released, cancelled: cancelled.promise, revoke: () => { revoked = true; } };
}

describe("native stats authenticated proxy", () => {
  it("never forwards arbitrary URLs, unsupported routes or state changes through GET", async () => {
    const test = fixture([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    for (const path of ["/http://elsewhere.test/", "/api/frustration/judge", "/api/unknown", "/api/request/not-a-number", "/api/session/entry/extra"]) {
      expect((await test.handler(new Request(base + path))).status).toBe(404);
    }
    expect(test.forwarded).toEqual([]);
    expect(test.acquired).toEqual([]);
  });
  it("checks authentication on every native request without a URL grant", async () => {
    const test = fixture([AuthOrchestrationReadScope]);
    const first = await test.handler(new Request(`${base}/api/status`));
    expect(await first.text()).toBe("native");
    test.revoke();
    expect((await test.handler(new Request(`${base}/api/status`))).status).toBe(401);
    expect(test.forwarded).toHaveLength(1);
  });
  it("requires operate scope for judgment and preserves the native action check", async () => {
    const reader = fixture([AuthOrchestrationReadScope]);
    expect((await reader.handler(new Request(`${base}/api/frustration/judge`, { method: "POST", headers: { "X-Omp-Stats-Action": "1" } }))).status).toBe(403);
    expect(reader.forwarded).toEqual([]);
    const operator = fixture([AuthOrchestrationOperateScope]);
    const response = await operator.handler(new Request(`${base}/api/frustration/judge?range=7d`, { method: "POST", headers: { authorization: "Bearer environment-only", cookie: "private=cookie", "X-Omp-Stats-Action": "1" } }));
    await response.text();
    expect(operator.forwarded[0]?.url).toBe("http://native.test/api/frustration/judge?range=7d");
    expect(operator.forwarded[0]?.headers.authorization).toBe("Bearer private-host-token");
    expect(operator.forwarded[0]?.headers.cookie).toBeUndefined();
    expect(operator.forwarded[0]?.headers["x-omp-stats-action"]).toBe("1");
    const withoutAction = await operator.handler(new Request(`${base}/api/frustration/judge`, { method: "POST" }));
    await withoutAction.text();
    expect(operator.forwarded[1]?.headers["x-omp-stats-action"]).toBeUndefined();
  });
  it("streams native indexing bytes and cancels upstream when the client closes", async () => {
    const test = fixture([AuthOrchestrationReadScope], { streaming: true });
    const response = await test.handler(new Request(`${base}/api/events`));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"indexingHours":2');
    await reader.cancel();
    await test.cancelled;
  });
  it("releases the exact authenticated view without forwarding a native mutation", async () => {
    const test = fixture([AuthOrchestrationReadScope]);
    expect((await test.handler(new Request(`${base}/`, { method: "DELETE" }))).status).toBe(204);
    expect(test.released).toEqual(["session/neopi/12345678-1234-1234-1234-123456789abc"]);
    expect(test.forwarded).toEqual([]);
  });
});
