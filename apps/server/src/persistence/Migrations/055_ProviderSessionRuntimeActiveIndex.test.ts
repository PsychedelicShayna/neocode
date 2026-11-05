import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import migrateActiveIndex from "./055_ProviderSessionRuntimeActiveIndex.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "055_ProviderSessionRuntimeActiveIndex",
  (it) => {
    it.effect("indexes the ordered non-stopped scan without changing its results", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        yield* sql`
          INSERT INTO provider_session_runtime
            (thread_id, provider_name, adapter_key, status, last_seen_at)
          VALUES
            ('historical', 'neopi', 'neopi', 'stopped', '2026-01-01T00:00:00Z'),
            ('later', 'neopi', 'neopi', 'running', '2026-02-01T00:00:00Z'),
            ('tie-b', 'neopi', 'neopi', 'running', '2026-01-02T00:00:00Z'),
            ('tie-a', 'neopi', 'neopi', 'running', '2026-01-02T00:00:00Z')
        `;
        const list = sql<{ readonly thread_id: string; readonly last_seen_at: string }>`
          SELECT * FROM provider_session_runtime
          WHERE status != 'stopped'
          ORDER BY last_seen_at ASC, thread_id ASC
        `;
        const before = yield* list;
        yield* runMigrations({ toMigrationInclusive: 55 });
        // Reapplying is harmless, as for the other additive index migrations.
        yield* migrateActiveIndex;
        assert.deepStrictEqual(yield* list, before);
        assert.deepStrictEqual(
          before.map((row) => row.thread_id),
          ["tie-a", "tie-b", "later"],
        );
        const indexes = yield* sql<{ readonly name: string; readonly partial: number }>`
          PRAGMA index_list(provider_session_runtime)
        `;
        assert.ok(
          indexes.some(
            (index) =>
              index.name === "idx_provider_session_runtime_active_last_seen" && index.partial === 1,
          ),
        );
        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA index_info('idx_provider_session_runtime_active_last_seen')
        `;
        assert.deepStrictEqual(
          columns.map((column) => column.name),
          ["last_seen_at", "thread_id"],
        );
        const plan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT * FROM provider_session_runtime
          WHERE status != 'stopped'
          ORDER BY last_seen_at ASC, thread_id ASC
        `;
        assert.ok(
          plan.some((step) =>
            step.detail.includes("idx_provider_session_runtime_active_last_seen"),
          ),
        );
        assert.ok(plan.every((step) => !step.detail.includes("TEMP B-TREE")));
      }),
    );
  },
);
