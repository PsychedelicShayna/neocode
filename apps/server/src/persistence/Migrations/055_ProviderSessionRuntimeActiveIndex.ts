import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Keep inactive runtime history out of the reaper's ordered live-session scan. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_active_last_seen
    ON provider_session_runtime(last_seen_at, thread_id)
    WHERE status != 'stopped'
  `;
});
