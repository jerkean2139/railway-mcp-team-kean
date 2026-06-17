/**
 * Postgres access and schema bootstrap.
 *
 * Holds the append-only audit log, per-user session bindings (one project per
 * session, persisted because the HTTP server is stateless), per-project flags,
 * config snapshots, and pending approval state.
 */
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.database.url,
  // Railway-managed Postgres requires TLS; allow self-signed in that managed context.
  ssl: config.database.url.includes('localhost') ? undefined : { rejectUnauthorized: false },
  max: 5,
});

/** Idempotent schema creation. Safe to run on every boot. */
export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id           BIGSERIAL PRIMARY KEY,
      ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
      initiator    TEXT        NOT NULL,
      tool         TEXT        NOT NULL,
      args         JSONB       NOT NULL DEFAULT '{}'::jsonb,
      project_id   TEXT,
      project_name TEXT,
      environment  TEXT,
      tier         TEXT        NOT NULL,
      approval     JSONB,
      outcome      TEXT        NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      identity         TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL,
      project_name     TEXT NOT NULL,
      environment_id   TEXT NOT NULL,
      environment_name TEXT NOT NULL,
      bound_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS project_flags (
      project_id          TEXT PRIMARY KEY,
      backup_volume_data  BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id           BIGSERIAL PRIMARY KEY,
      ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
      project_id   TEXT NOT NULL,
      environment  TEXT,
      target_type  TEXT NOT NULL,
      target_id    TEXT,
      kind         TEXT NOT NULL,
      data         JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      tool          TEXT,
      summary       TEXT NOT NULL,
      project_id    TEXT,
      project_name  TEXT,
      environment   TEXT,
      initiator     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      approver      TEXT,
      decided_at    TIMESTAMPTZ,
      snapshot_id   BIGINT,
      slack_channel TEXT,
      slack_ts      TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/** Append-only: this is the only function that writes the audit trail. */
export interface AuditEntry {
  initiator: string;
  tool: string;
  args: Record<string, unknown>;
  projectId?: string | null;
  projectName?: string | null;
  environment?: string | null;
  tier: string;
  approval?: { approver: string; approvedAt: string } | null;
  outcome: string;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (initiator, tool, args, project_id, project_name, environment, tier, approval, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.initiator,
      entry.tool,
      JSON.stringify(entry.args ?? {}),
      entry.projectId ?? null,
      entry.projectName ?? null,
      entry.environment ?? null,
      entry.tier,
      entry.approval ? JSON.stringify(entry.approval) : null,
      entry.outcome,
    ],
  );
}
