/**
 * Slack approval messaging (Block Kit Approve / Deny).
 *
 * No secret value ever appears in a Slack message. No em dashes in any
 * user-facing text (a hard constraint of this server).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const SLACK_API = 'https://slack.com/api';

interface PostResult {
  channel: string;
  ts: string;
}

/** Post an approval request with Approve / Deny buttons that carry the approval id. */
export async function postApprovalMessage(opts: {
  approvalId: string;
  title: string;
  lines: string[];
}): Promise<PostResult> {
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${opts.title}*` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: opts.lines.map((l) => `> ${l}`).join('\n') },
    },
    {
      type: 'actions',
      block_id: `approval:${opts.approvalId}`,
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          action_id: 'approve',
          value: opts.approvalId,
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Deny' },
          action_id: 'deny',
          value: opts.approvalId,
        },
      ],
    },
  ];

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${config.slack.botToken}`,
    },
    body: JSON.stringify({
      channel: config.slack.approvalChannel,
      text: opts.title, // fallback for notifications
      blocks,
    }),
  });
  let body: { ok?: boolean; channel?: string; ts?: string; error?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error(`Slack chat.postMessage returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!body.ok || !body.ts || !body.channel) {
    throw new Error(`Slack chat.postMessage failed: ${body.error ?? 'unknown error'}`);
  }
  return { channel: body.channel, ts: body.ts };
}

/** Replace an approval message with the recorded decision, removing the buttons. */
export async function updateApprovalMessage(channel: string, ts: string, text: string): Promise<void> {
  await fetch(`${SLACK_API}/chat.update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${config.slack.botToken}`,
    },
    body: JSON.stringify({
      channel,
      ts,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    }),
  });
}

/**
 * Verify an inbound Slack request really came from Slack, per Slack's signing
 * recipe (v0 HMAC over `v0:timestamp:body`). Rejects requests older than 5 min.
 */
export function verifySlackSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false; // stale, possible replay

  const base = `v0:${timestamp}:${rawBody}`;
  const computed = 'v0=' + createHmac('sha256', config.slack.signingSecret).update(base).digest('hex');

  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
