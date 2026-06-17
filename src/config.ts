/**
 * Central configuration, read once from the environment at boot.
 *
 * Everything operational is config, not code, so that onboarding a teammate or
 * adding an approver is an env change and a restart, never a code change.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

/**
 * Parse a JSON object env var of the form {"key":"value", ...}.
 * Returns an empty object if unset.
 */
function jsonMap(name: string): Record<string, string> {
  const raw = optional(name);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    throw new Error('not an object');
  } catch (err) {
    throw new Error(`Environment variable ${name} must be a JSON object, e.g. {"token":"jeremy"}`);
  }
}

/**
 * Maps each issued gateway bearer token to the human identity it represents.
 * This is the allowlist: a token not present here cannot connect.
 * Example: GATEWAY_TOKENS = {"gw_live_abc123":"jeremy"}
 */
const gatewayTokens = jsonMap('GATEWAY_TOKENS');

/**
 * Maps a Slack user id to the human identity the team knows them by.
 * Used to confirm a button-clicker is an allowlisted approver.
 * Example: SLACK_APPROVER_IDS = {"U0123ABCD":"jeremy"}
 */
const slackApproverIds = jsonMap('SLACK_APPROVER_IDS');

/**
 * The approver allowlist. MVP ships with just Jeremy. Adding Taha later is a
 * one-line env change (APPROVERS=jeremy,taha), not a code change.
 */
const approvers = optional('APPROVERS', 'jeremy')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const config = {
  port: Number(optional('PORT', '3000')),

  railway: {
    /** Railway Public API GraphQL endpoint. */
    apiUrl: optional('RAILWAY_API_URL', 'https://backboard.railway.com/graphql/v2'),
    /** A single Railway Team (workspace) token used as the server's service identity. */
    token: required('RAILWAY_TOKEN'),
  },

  database: {
    /** Standard Postgres connection string (Railway provides DATABASE_URL). */
    url: required('DATABASE_URL'),
  },

  slack: {
    /** Bot token (xoxb-...) used to post and update approval messages. */
    botToken: required('SLACK_BOT_TOKEN'),
    /** Signing secret used to verify inbound interaction requests are really from Slack. */
    signingSecret: required('SLACK_SIGNING_SECRET'),
    /** Channel where approval requests are posted (channel id, e.g. C0123ABCD). */
    approvalChannel: required('SLACK_APPROVAL_CHANNEL'),
    approverIds: slackApproverIds,
  },

  /** Token -> human identity. */
  gatewayTokens,

  /** Lowercased human identities allowed to approve gated actions. */
  approvers,

  /** How long a gated tool waits for a Slack decision before aborting. */
  approvalTimeoutMs: Number(optional('APPROVAL_TIMEOUT_MS', '300000')), // 5 minutes

  /** Server-to-self base URL, used only for logging/diagnostics. */
  publicUrl: optional('PUBLIC_URL', ''),
} as const;

/** Resolve a gateway bearer token to a human identity, or null if not allowlisted. */
export function identityForToken(token: string): string | null {
  const identity = config.gatewayTokens[token];
  return identity ?? null;
}

/** Resolve a Slack user id to the human identity, or null if unknown. */
export function identityForSlackUser(slackUserId: string): string | null {
  const identity = config.slack.approverIds[slackUserId];
  return identity ?? null;
}

/** Is this human identity allowed to approve gated actions? */
export function isApprover(identity: string | null | undefined): boolean {
  if (!identity) return false;
  return config.approvers.includes(identity.toLowerCase());
}
