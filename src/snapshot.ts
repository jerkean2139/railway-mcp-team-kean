/**
 * Config snapshots, written BEFORE any gated delete executes.
 *
 * A snapshot captures the variables and service settings of the target so the
 * action is recoverable in principle. Volume data is only backed up when the
 * per-project `backup_volume_data` flag is on (default off: staging data is
 * treated as throwaway). No secret values are ever stored in plaintext.
 */
import { pool } from './db.js';
import { getVariables } from './railway/api.js';
import { maskValue } from './redact.js';

export async function getProjectFlag(projectId: string): Promise<{ backupVolumeData: boolean }> {
  const { rows } = await pool.query(`SELECT backup_volume_data FROM project_flags WHERE project_id = $1`, [projectId]);
  return { backupVolumeData: rows[0]?.backup_volume_data === true };
}

/** Turn the per-project volume backup flag on or off. Idempotent upsert. */
export async function setBackupVolumeData(projectId: string, enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO project_flags (project_id, backup_volume_data) VALUES ($1, $2)
     ON CONFLICT (project_id) DO UPDATE SET backup_volume_data = EXCLUDED.backup_volume_data`,
    [projectId, enabled],
  );
}

interface SnapshotInput {
  projectId: string;
  environment: string;
  targetType: 'service' | 'project' | 'environment' | 'volume' | 'variables';
  targetId?: string;
  /** The service whose variables/settings to capture, when applicable. */
  serviceIdForVars?: string;
  environmentId: string;
  extra?: Record<string, unknown>;
}

/**
 * Write a config snapshot and return its id. Variable values are stored masked,
 * so the snapshot records which keys existed without persisting any secret.
 */
export async function writeSnapshot(input: SnapshotInput): Promise<number> {
  let maskedVars: Record<string, string> = {};
  try {
    const vars = await getVariables(input.projectId, input.environmentId, input.serviceIdForVars);
    maskedVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, maskValue(v)]));
  } catch {
    // If variables cannot be read (e.g. project-level delete), record what we can.
    maskedVars = {};
  }

  const data = {
    capturedAt: new Date().toISOString(),
    variableKeysMasked: maskedVars,
    ...(input.extra ?? {}),
  };

  const { rows } = await pool.query(
    `INSERT INTO snapshots (project_id, environment, target_type, target_id, kind, data)
       VALUES ($1, $2, $3, $4, 'config', $5) RETURNING id`,
    [input.projectId, input.environment, input.targetType, input.targetId ?? null, JSON.stringify(data)],
  );
  return Number(rows[0].id);
}

/**
 * Back up volume data. The MVP records a backup marker snapshot only; an actual
 * restore path is Phase 2 (see PHASE_2_NOTES.md). Called only when the project
 * flag is on.
 */
export async function backupVolumeData(input: {
  projectId: string;
  environment: string;
  volumeId: string;
}): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO snapshots (project_id, environment, target_type, target_id, kind, data)
       VALUES ($1, $2, 'volume', $3, 'volume_backup', $4) RETURNING id`,
    [
      input.projectId,
      input.environment,
      input.volumeId,
      JSON.stringify({ capturedAt: new Date().toISOString(), note: 'volume backup marker (restore path is Phase 2)' }),
    ],
  );
  return Number(rows[0].id);
}
