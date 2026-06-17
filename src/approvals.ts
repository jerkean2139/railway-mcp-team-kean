/**
 * Pending-approval state, backed by Postgres.
 *
 * A gated tool creates an approval row (status=pending), posts a Slack message,
 * then waits by polling for the status to flip. The Slack interaction endpoint
 * is what flips it. (Redis pub/sub would remove the poll; see PHASE_2_NOTES.md.)
 */
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { config } from './config.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timeout';

export interface ApprovalRecord {
  id: string;
  kind: string;
  tool: string | null;
  summary: string;
  projectId: string | null;
  projectName: string | null;
  environment: string | null;
  initiator: string;
  status: ApprovalStatus;
  approver: string | null;
  snapshotId: number | null;
}

export interface CreateApprovalInput {
  kind: 'gated_tool' | 'prod_only_bind';
  tool?: string | null;
  summary: string;
  projectId?: string | null;
  projectName?: string | null;
  environment?: string | null;
  initiator: string;
  snapshotId?: number | null;
}

export async function createApproval(input: CreateApprovalInput): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO approvals (id, kind, tool, summary, project_id, project_name, environment, initiator, status, snapshot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
    [
      id,
      input.kind,
      input.tool ?? null,
      input.summary,
      input.projectId ?? null,
      input.projectName ?? null,
      input.environment ?? null,
      input.initiator,
      input.snapshotId ?? null,
    ],
  );
  return id;
}

export async function recordSlackMessage(id: string, channel: string, ts: string): Promise<void> {
  await pool.query(`UPDATE approvals SET slack_channel = $2, slack_ts = $3 WHERE id = $1`, [id, channel, ts]);
}

export async function getApproval(id: string): Promise<ApprovalRecord | null> {
  const { rows } = await pool.query(
    `SELECT id, kind, tool, summary, project_id, project_name, environment, initiator, status, approver, snapshot_id
       FROM approvals WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    tool: r.tool,
    summary: r.summary,
    projectId: r.project_id,
    projectName: r.project_name,
    environment: r.environment,
    initiator: r.initiator,
    status: r.status,
    approver: r.approver,
    snapshotId: r.snapshot_id === null ? null : Number(r.snapshot_id),
  };
}

/**
 * Record a decision. Only flips a row that is still pending, so a late or
 * duplicate Slack click cannot overturn an existing decision. Returns the
 * resulting status (the existing one if it was already decided).
 */
export async function decideApproval(
  id: string,
  decision: 'approved' | 'denied',
  approver: string,
): Promise<ApprovalStatus | null> {
  const { rows } = await pool.query(
    `UPDATE approvals
        SET status = $2, approver = $3, decided_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING status`,
    [id, decision, approver],
  );
  if (rows[0]) return rows[0].status as ApprovalStatus;
  const existing = await getApproval(id);
  return existing ? existing.status : null;
}

async function markTimeout(id: string): Promise<void> {
  await pool.query(`UPDATE approvals SET status = 'timeout', decided_at = now() WHERE id = $1 AND status = 'pending'`, [
    id,
  ]);
}

/**
 * Block until the approval is decided or the timeout elapses. Polls Postgres.
 * Returns the final record so the caller can read approver + status.
 */
export async function waitForDecision(id: string): Promise<ApprovalRecord> {
  const deadline = Date.now() + config.approvalTimeoutMs;
  const intervalMs = 2000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rec = await getApproval(id);
    if (!rec) throw new Error('Approval record disappeared');
    if (rec.status !== 'pending') return rec;
    if (Date.now() >= deadline) {
      await markTimeout(id);
      const finalRec = await getApproval(id);
      return finalRec ?? rec;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
