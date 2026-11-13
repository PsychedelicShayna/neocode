import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { requestNativeStats, type NativeStatsResponse } from "./neopiStats.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("stats-environment"),
  label: "Stats environment",
  httpBaseUrl: "https://environment.test",
  wsBaseUrl: "wss://environment.test",
});
const INSTANCE = "neopi";
const VIEW = "12345678-1234-1234-1234-123456789abc";
const PREFIX = `/api/neopi-stats/${INSTANCE}/${VIEW}`;
const FILE = "/sessions/project #1/東京?progress=50%.jsonl";
const ENTRY = "entry?branch=a&step=2";
const OVERVIEWS: Readonly<Record<string, { requests: number; totalCost: number }>> = {
  "24h": { requests: 3, totalCost: 0.25 },
  "7d": { requests: 18, totalCost: 1.75 },
};

const fixture = Effect.gen(function* () {
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      `${PREFIX}/api/stats/overview`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const range = new URL(request.url, TARGET.httpBaseUrl).searchParams.get("range");
        const overview = range === null ? undefined : OVERVIEWS[range];
        return overview
          ? HttpServerResponse.jsonUnsafe(overview)
          : HttpServerResponse.empty({ status: 400 });
      }),
    ),
    HttpRouter.add(
      "GET",
      `${PREFIX}/api/session/entry`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const query = new URL(request.url, TARGET.httpBaseUrl).searchParams;
        return query.get("file") === FILE && query.get("id") === ENTRY
          ? HttpServerResponse.jsonUnsafe({
              entry: { type: "message", text: "Saved native entry" },
            })
          : HttpServerResponse.empty({ status: 404 });
      }),
    ),
    HttpRouter.add(
      "GET",
      `${PREFIX}/embed`,
      HttpServerResponse.html("<html><head></head><body>Native stats</body></html>"),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const fetchFn: typeof fetch = (input, init) => handler(new Request(input, init));
  const prepared = yield* SubscriptionRef.make(
    Option.some<PreparedConnection>({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: TARGET.httpBaseUrl,
      socketUrl: "wss://environment.test/ws",
      httpAuthorization: null,
      target: TARGET,
    }),
  );
  const supervisor = { target: TARGET, prepared } as EnvironmentSupervisor["Service"];
  return (path: string, consume: (response: NativeStatsResponse) => Promise<void>) =>
    requestNativeStats({
      instanceId: INSTANCE,
      viewId: VIEW,
      path,
      method: "GET",
      signal: new AbortController().signal,
      consume,
    }).pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
      Effect.provide(layerRemoteHttpClient(fetchFn)),
    );
});

describe("native stats routed HTTP transport", () => {
  it.effect("keeps native range queries separate from the proxy pathname", () =>
    Effect.gen(function* () {
      const request = yield* fixture;
      yield* request("/api/stats/overview?range=24h", async (response) => {
        expect(response.status).toBe(200);
        expect(JSON.parse(await response.text())).toEqual({ requests: 3, totalCost: 0.25 });
      });
      yield* request("/api/stats/overview?range=7d", async (response) => {
        expect(response.status).toBe(200);
        expect(JSON.parse(await response.text())).toEqual({ requests: 18, totalCost: 1.75 });
      });
    }).pipe(Effect.scoped),
  );

  it.effect("preserves encoded native file and entry query values", () =>
    Effect.gen(function* () {
      const request = yield* fixture;
      yield* request(
        `/api/session/entry?file=${encodeURIComponent(FILE)}&id=${encodeURIComponent(ENTRY)}`,
        async (response) => {
          expect(response.status).toBe(200);
          expect(JSON.parse(await response.text())).toEqual({
            entry: { type: "message", text: "Saved native entry" },
          });
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("still opens the native document without a query", () =>
    Effect.gen(function* () {
      const request = yield* fixture;
      yield* request("/embed", async (response) => {
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("<body>Native stats</body>");
      });
    }).pipe(Effect.scoped),
  );
});
