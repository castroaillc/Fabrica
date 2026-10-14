// The Postgres JobStore: one row per job in <schema>.jobs, in a schema of the runner's own (never public).
import pg from "pg";
import type { Action, OrchestratorState } from "@fabrica/core";
import type { JobStore, SavedJob } from "./jobStore.js";

export const STORE_SCHEMA = "fabrica_runner";

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

// Schema names are the only values put into SQL text, so they are checked first. Everything else is a parameter.
export function checkSchemaName(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Invalid schema name: ${JSON.stringify(schema)}`);
  return schema;
}

export interface PostgresJobStore extends JobStore {
  close(): Promise<void>;
}

interface Row {
  feature: string;
  state: OrchestratorState;
  in_flight: Action[];
  sessions: Record<string, string>;
}

export async function openJobStore(databaseUrl: string, schema: string = STORE_SCHEMA): Promise<PostgresJobStore> {
  const table = `${checkSchemaName(schema)}.jobs`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // An idle connection dropping must not crash the process; the next query reports it instead.
  pool.on("error", () => undefined);
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
        repo text NOT NULL,
        id text NOT NULL,
        feature text NOT NULL,
        state jsonb NOT NULL,
        in_flight jsonb NOT NULL,
        sessions jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (repo, id)
      )`,
    );
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    async load(repo, id): Promise<SavedJob | null> {
      const { rows } = await pool.query<Row>(
        `SELECT feature, state, in_flight, sessions FROM ${table} WHERE repo = $1 AND id = $2`,
        [repo, id],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return { feature: row.feature, state: row.state, inFlight: row.in_flight, sessions: row.sessions };
    },
    async save(repo, id, saved): Promise<void> {
      await pool.query(
        `INSERT INTO ${table} (repo, id, feature, state, in_flight, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, now())
         ON CONFLICT (repo, id) DO UPDATE
         SET feature = EXCLUDED.feature, state = EXCLUDED.state, in_flight = EXCLUDED.in_flight, updated_at = now()`,
        [repo, id, saved.feature, JSON.stringify(saved.state), JSON.stringify(saved.inFlight)],
      );
    },
    async saveSession(repo, id, name, sessionId): Promise<void> {
      const { rowCount } = await pool.query(
        `UPDATE ${table} SET sessions = sessions || jsonb_build_object($3::text, $4::text), updated_at = now()
         WHERE repo = $1 AND id = $2`,
        [repo, id, name, sessionId],
      );
      if (rowCount === 0) throw new Error(`${id}: no saved job in ${table} for ${repo}`);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
