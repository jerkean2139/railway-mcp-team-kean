/**
 * The hard gate for irreversible (destructiveHint:true) tools.
 *
 * Order is fixed and enforced here so no gated tool can skip a step:
 *   1. Write the config snapshot FIRST (and volume backup if the project flag is on).
 *   2. Create a pending approval and post it to Slack with Approve / Deny.
 *   3. Block until a decision or timeout.
 *   4. Return the decision to the caller, which executes only on Approve.
 *
 * No path exists for the agent to destroy anything without an allowlisted
 * human's Slack approval.
 */
import { createApproval, recordSlackMessage, waitForDecision } from './approvals.js';
import type { ApprovalRecord } from './approvals.js';
import { postApprovalMessage, updateApprovalMessage } from './slack.js';
import { writeSnapshot, backupVolumeData, getProjectFlag } from './snapshot.js';
import type { Binding } from './session.js';

export interface GateRequest {
  tool: string;
  initiator: string;
  binding: Binding;
  /** Short human-readable description of the action, no secrets. */
  action: string;
  targetType: 'service' | 'project' | 'environment' | 'volume' | 'variables';
  targetId?: string;
  serviceIdForVars?: string;
  /** Set when the target is a volume and we may need to back its data up. */
  volumeId?: string;
  /** Extra detail lines for the snapshot and Slack message (no secrets). */
  details?: string[];
}

export interface GateOutcome {
  approved: boolean;
  status: ApprovalRecord['status'];
  approver: string | null;
  snapshotId: number;
}

export async function runGate(req: GateRequest): Promise<GateOutcome> {
  // 1. Snapshot first, always.
  const snapshotId = await writeSnapshot({
    projectId: req.binding.projectId,
    environment: req.binding.environmentName,
    environmentId: req.binding.environmentId,
    targetType: req.targetType,
    targetId: req.targetId,
    serviceIdForVars: req.serviceIdForVars,
    extra: { action: req.action },
  });

  // Volume backup only when the project flag is on (default off).
  if (req.volumeId) {
    const { backupVolumeData: flagOn } = await getProjectFlag(req.binding.projectId);
    if (flagOn) {
      await backupVolumeData({
        projectId: req.binding.projectId,
        environment: req.binding.environmentName,
        volumeId: req.volumeId,
      });
    }
  }

  // 2. Create pending approval and post to Slack.
  const approvalId = await createApproval({
    kind: 'gated_tool',
    tool: req.tool,
    summary: req.action,
    projectId: req.binding.projectId,
    projectName: req.binding.projectName,
    environment: req.binding.environmentName,
    initiator: req.initiator,
    snapshotId,
  });

  const lines = [
    `Action: ${req.action}`,
    `Project: ${req.binding.projectName}`,
    `Environment: ${req.binding.environmentName}`,
    `Requested by: ${req.initiator}`,
    `Snapshot: written (id ${snapshotId})`,
    ...(req.details ?? []),
  ];

  const posted = await postApprovalMessage({
    approvalId,
    title: 'Railway Guardrail approval needed',
    lines,
  });
  await recordSlackMessage(approvalId, posted.channel, posted.ts);

  // 3. Block until decided or timed out.
  const decision = await waitForDecision(approvalId);

  // 4. Reflect the outcome back into Slack (buttons removed).
  const verdict =
    decision.status === 'approved'
      ? `Approved by ${decision.approver}.`
      : decision.status === 'denied'
        ? `Denied by ${decision.approver}.`
        : 'Timed out with no decision. Action aborted.';
  await updateApprovalMessage(posted.channel, posted.ts, `Railway Guardrail: ${req.action}\n${verdict}`);

  return {
    approved: decision.status === 'approved',
    status: decision.status,
    approver: decision.approver,
    snapshotId,
  };
}

/**
 * Staging enforcement, production-only path: pause and ask an approver whether a
 * project that has no staging environment may have its production treated as
 * staging for this session. Reuses the same Slack approval mechanism.
 */
export async function requestProdOnlyConfirm(opts: {
  initiator: string;
  projectId: string;
  projectName: string;
  environmentName: string;
}): Promise<{ approved: boolean; approver: string | null; status: ApprovalRecord['status'] }> {
  const approvalId = await createApproval({
    kind: 'prod_only_bind',
    summary: `Treat ${opts.projectName} production as staging for this session`,
    projectId: opts.projectId,
    projectName: opts.projectName,
    environment: opts.environmentName,
    initiator: opts.initiator,
  });

  const posted = await postApprovalMessage({
    approvalId,
    title: 'Railway Guardrail staging confirm',
    lines: [
      `Project ${opts.projectName} has no staging environment.`,
      `Treat its ${opts.environmentName} environment as staging for this session?`,
      `Requested by: ${opts.initiator}`,
    ],
  });
  await recordSlackMessage(approvalId, posted.channel, posted.ts);

  const decision = await waitForDecision(approvalId);
  const verdict =
    decision.status === 'approved'
      ? `Approved by ${decision.approver}. Binding to ${opts.environmentName}.`
      : decision.status === 'denied'
        ? `Denied by ${decision.approver}. Bind refused.`
        : 'Timed out. Bind refused.';
  await updateApprovalMessage(posted.channel, posted.ts, `Railway Guardrail: ${opts.projectName}\n${verdict}`);

  return { approved: decision.status === 'approved', approver: decision.approver, status: decision.status };
}
