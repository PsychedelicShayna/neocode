import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";

// NeoCode shipped an additive index as 55 before upstream reserved that id for V2.
export const reconcileNeoPiRuntimeIndexMigration = Effect.fn("reconcileNeoPiRuntimeIndexMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return [];
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55
        `;
        if (
          !history.some(
            (row) => row.migration_id === 55 && row.name === "ProviderSessionRuntimeActiveIndex",
          )
        )
          return [];
        if (history.length !== 1)
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message:
              "Cannot upgrade NeoCode's runtime-index migration with unexpected later migrations.",
          });
        yield* OrchestrationV2;
        yield* sql`
          UPDATE effect_sql_migrations SET name = 'OrchestrationV2'
          WHERE migration_id = 55 AND name = 'ProviderSessionRuntimeActiveIndex'
        `;
        return [[55, "OrchestrationV2"] as const];
      }),
    );
  },
);
