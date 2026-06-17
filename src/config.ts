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
 * Parse a credential map env var that maps a credential (a gateway token or a
 * Slack user id) to a human identity. Forgiving on purpose, because JSON in env
 * vars is a common first-timer trap. Accepts either:
 *
 *   1. A simple list (recommended):  token:jeremy,token2:taha
 *      (separator is ":" or "=", entries separated by "," or a newline)
 *   2. A JSON object:                {"token":"jeremy","token2":"taha"}
 *
 * Smart/curly quotes and a single layer of wrapping quotes are tolerated.
 * Returns an empty object if unset.
 */
export function credentialMap(name: string): Record<string, string> {
  let raw = optional(name);
  if (!raw) return {};

  // Normalize curly quotes that sneak in from notes apps.
  raw = raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // Strip one layer of wrapping quotes around a JSON object, e.g. '{"a":"b"}'.
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    const inner = raw.slice(1, -1).trim();
    if (inner.startsWith('{')) raw = inner;
  }
  raw = raw.trim();

  // JSON object form.
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) out[String(k)] = String(v);
        return out;
      }
    } catch {
      throw new Error(
        `Environment variable ${name} looks like JSON but could not be parsed. ` +
          `Easiest fix: use the simple form instead, for example token:jeremy`,
      );
    }
  }

  // Simple list form: pairs of credential:name, separated by commas or newlines.
  const out: Record<string, string> = {};
  for (const entry of raw.split(/[,\n]/)) {
    const pair = entry.trim();
    if (!pair) continue;
    const m = pair.match(/^([^:=]+)[:=](.+)$/);
    if (!m) {
      throw new Error(`Environment variable ${name} entry "${pair}" must look like token:name`);
    }
    out[m[1]!.trim()] = m[2]!.trim();
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`Environment variable ${name} must list at least one token:name pair.`);
  }
  return out;
}

/**
 * Maps each issued gateway bearer token to the human identity it represents.
 * This is the allowlist: a token not present here cannot connect.
 * Simple form: GATEWAY_TOKENS = gw_live_abc123:jeremy
 * JSON form:   GATEWAY_TOKENS = {"gw_live_abc123":"jeremy"}
 */
const gatewayTokens = credentialMap('GATEWAY_TOKENS');

/**
 * Maps a Slack user id to the human identity the team knows them by.
 * Used to confirm a button-clicker is an allowlisted approver.
 * Simple form: SLACK_APPROVER_IDS = U0123ABCD:jeremy
 * JSON form:   SLACK_APPROVER_IDS = {"U0123ABCD":"jeremy"}
 */
const slackApproverIds = credentialMap('SLACK_APPROVER_IDS');

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
