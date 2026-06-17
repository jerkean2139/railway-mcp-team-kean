/**
 * Per-user session binding (Containment Wall #1: one project per session).
 *
 * The HTTP server is stateless, so the "session" is the human's current bound
 * project, persisted in Postgres keyed by their identity. No mutating tool runs
 * until a binding exists, and every tool then operates only inside that project.
 */
import { pool } from './db.js';

export interface Binding {
  identity: string;
  projectId: string;
  projectName: string;
  /** The environment the session is pinned to. Always the staging-equivalent. */
  environmentId: string;
  environmentName: string;
}

export async function getBinding(identity: string): Promise<Binding | null> {
  const { rows } = await pool.query(
    `SELECT identity, project_id, project_name, environment_id, environment_name
       FROM sessions WHERE identity = $1`,
    [identity],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    identity: row.identity,
    projectId: row.project_id,
    projectName: row.project_name,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
  };
}

export async function setBinding(b: Binding): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (identity, project_id, project_name, environment_id, environment_name, bound_at)
       VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (identity) DO UPDATE SET
       project_id = EXCLUDED.project_id,
       project_name = EXCLUDED.project_name,
       environment_id = EXCLUDED.environment_id,
       environment_name = EXCLUDED.environment_name,
       bound_at = now()`,
    [b.identity, b.projectId, b.projectName, b.environmentId, b.environmentName],
  );
}

/**
 * Guard used by every mutating tool. Returns the binding or throws a clear,
 * actionable error. Also refuses if a tool call targets a different project than
 * the one bound to the session.
 */
export async function requireBinding(identity: string, targetProjectId?: string): Promise<Binding> {
  const binding = await getBinding(identity);
  if (!binding) {
    throw new Error(
      'No project is bound to this session. Call railway_select_project first; one project per session.',
    );
  }
  if (targetProjectId && targetProjectId !== binding.projectId) {
    throw new Error(
      `This session is bound to project ${binding.projectName} (${binding.projectId}). ` +
        `It cannot operate on a different project (${targetProjectId}). Start a new session to switch projects.`,
    );
  }
  return binding;
}
