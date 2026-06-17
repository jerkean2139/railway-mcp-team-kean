/**
 * Minimal OAuth 2.1 authorization server, just enough for the MCP authorization
 * flow that claude.ai chat / Projects / Cowork use to connect to a remote server:
 *
 *   discovery -> dynamic client registration -> PKCE authorize -> token
 *
 * The login step authenticates the human with their existing gateway token (the
 * same allowlist Claude Code uses), so there is one source of truth for who may
 * connect. The OAuth access token issued here simply carries that identity.
 *
 * Notes:
 *  - Public clients only (PKCE S256 required, no client secret).
 *  - Authorization codes are single use and short lived.
 *  - Codes and issued tokens are stored hashed, never in the clear.
 *  - No em dashes in any user-facing text.
 */
import type { Express, Request, Response } from 'express';
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from './db.js';
import { config, identityForToken } from './config.js';

const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL_SEC = 60; // 1 minute
const SCOPE = 'mcp';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Absolute base URL for this server, used in OAuth metadata (must be absolute). */
function baseUrl(req: Request): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  const proto = ((req.headers['x-forwarded-proto'] as string) || 'https').split(',')[0];
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

/** Resolve a presented bearer token to a human identity, or null. */
export async function resolveIdentity(token: string): Promise<string | null> {
  // Static gateway tokens (Claude Code) take precedence.
  const staticIdentity = identityForToken(token);
  if (staticIdentity) return staticIdentity;

  // Otherwise it may be an OAuth-issued access token.
  const { rows } = await pool.query(
    `SELECT identity FROM oauth_tokens WHERE token_hash = $1 AND kind = 'access' AND expires_at > now()`,
    [sha256(token)],
  );
  return rows[0]?.identity ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Render the login form. All OAuth params are carried as hidden fields. */
function loginPage(params: Record<string, string>, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Railway Guardrail MCP sign in</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { background: #1a1d24; padding: 32px; border-radius: 12px; width: 360px; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { font-size: 13px; color: #9aa0aa; margin: 0 0 20px; }
  label { font-size: 13px; display: block; margin-bottom: 6px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #333; background: #0f1115; color: #fff; }
  button { width: 100%; margin-top: 16px; padding: 10px; border: 0; border-radius: 8px; background: #6c5ce7; color: #fff; font-size: 14px; cursor: pointer; }
  .err { color: #ff6b6b; font-size: 13px; margin-bottom: 12px; }
</style></head>
<body><form class="card" method="post" action="/oauth/authorize">
  <h1>Railway Guardrail MCP</h1>
  <p>Paste your access token to connect Claude to this server.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  <label for="token">Access token</label>
  <input id="token" name="token" type="password" autocomplete="off" autofocus placeholder="gw_live_...">
  ${hidden}
  <button type="submit">Authorize</button>
</form></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Error</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px"><h1>Cannot continue</h1><p>${escapeHtml(message)}</p></body></html>`;
}

/** Register all OAuth and discovery routes on the Express app. */
export function registerOAuth(app: Express): void {
  const bodyParsers = [express.urlencoded({ extended: true }), express.json()];

  // ---- Discovery: Protected Resource Metadata (RFC 9728) ----
  const protectedResource = (req: Request, res: Response): void => {
    const base = baseUrl(req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
    });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  // ---- Discovery: Authorization Server Metadata (RFC 8414) ----
  const asMetadata = (req: Request, res: Response): void => {
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
    });
  };
  app.get('/.well-known/oauth-authorization-server', asMetadata);
  app.get('/.well-known/oauth-authorization-server/mcp', asMetadata);

  // ---- Dynamic Client Registration (RFC 7591) ----
  app.post('/oauth/register', ...bodyParsers, async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const redirectUris: unknown = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === 'string')) {
      res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required.' });
      return;
    }
    const clientId = `client_${randomBytes(16).toString('hex')}`;
    await pool.query(`INSERT INTO oauth_clients (client_id, redirect_uris, client_name) VALUES ($1, $2, $3)`, [
      clientId,
      JSON.stringify(redirectUris),
      typeof body.client_name === 'string' ? body.client_name : null,
    ]);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
    });
  });

  // ---- Authorization endpoint ----
  async function clientRedirectUris(clientId: string): Promise<string[] | null> {
    const { rows } = await pool.query(`SELECT redirect_uris FROM oauth_clients WHERE client_id = $1`, [clientId]);
    if (!rows[0]) return null;
    return rows[0].redirect_uris as string[];
  }

  // The OAuth params we carry through the login form.
  const AUTH_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

  app.get('/oauth/authorize', async (req: Request, res: Response) => {
    const q = req.query as Record<string, string>;
    const uris = q.client_id ? await clientRedirectUris(q.client_id) : null;
    if (!uris) {
      res.status(400).send(errorPage('Unknown client_id. Register the client first.'));
      return;
    }
    if (!q.redirect_uri || !uris.includes(q.redirect_uri)) {
      res.status(400).send(errorPage('redirect_uri does not match a registered URI.'));
      return;
    }
    if (q.response_type !== 'code') {
      res.status(400).send(errorPage('Only response_type=code is supported.'));
      return;
    }
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      res.status(400).send(errorPage('PKCE with code_challenge_method=S256 is required.'));
      return;
    }
    const params: Record<string, string> = {};
    for (const k of AUTH_PARAMS) if (q[k]) params[k] = q[k];
    res.status(200).type('html').send(loginPage(params));
  });

  app.post('/oauth/authorize', express.urlencoded({ extended: true }), async (req: Request, res: Response) => {
    const b = req.body as Record<string, string>;
    const uris = b.client_id ? await clientRedirectUris(b.client_id) : null;
    if (!uris || !b.redirect_uri || !uris.includes(b.redirect_uri)) {
      res.status(400).send(errorPage('Invalid client or redirect_uri.'));
      return;
    }
    if (!b.code_challenge || b.code_challenge_method !== 'S256') {
      res.status(400).send(errorPage('PKCE with code_challenge_method=S256 is required.'));
      return;
    }

    const identity = b.token ? identityForToken(b.token.trim()) : null;
    if (!identity) {
      const params: Record<string, string> = {};
      for (const k of AUTH_PARAMS) if (b[k]) params[k] = b[k];
      res.status(401).type('html').send(loginPage(params, 'That token is not on the allowlist. Check it and try again.'));
      return;
    }

    const code = randomToken();
    const expires = new Date(Date.now() + CODE_TTL_SEC * 1000);
    await pool.query(
      `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, identity, scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sha256(code), b.client_id, b.redirect_uri, b.code_challenge, identity, b.scope || SCOPE, expires],
    );

    const redirect = new URL(b.redirect_uri);
    redirect.searchParams.set('code', code);
    if (b.state) redirect.searchParams.set('state', b.state);
    res.redirect(302, redirect.toString());
  });

  // ---- Token endpoint ----
  async function issueTokens(identity: string, clientId: string | null): Promise<{ access: string; refresh: string }> {
    const access = randomToken();
    const refresh = randomToken();
    const accessExp = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000);
    const refreshExp = new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000);
    await pool.query(
      `INSERT INTO oauth_tokens (token_hash, kind, identity, client_id, expires_at)
         VALUES ($1, 'access', $3, $4, $2)`,
      [sha256(access), accessExp, identity, clientId],
    );
    await pool.query(
      `INSERT INTO oauth_tokens (token_hash, kind, identity, client_id, expires_at)
         VALUES ($1, 'refresh', $3, $4, $2)`,
      [sha256(refresh), refreshExp, identity, clientId],
    );
    return { access, refresh };
  }

  app.post('/oauth/token', ...bodyParsers, async (req: Request, res: Response) => {
    const b = req.body as Record<string, string>;
    const grant = b.grant_type;

    if (grant === 'authorization_code') {
      const { rows } = await pool.query(
        `SELECT client_id, redirect_uri, code_challenge, identity, scope, used, expires_at
           FROM oauth_codes WHERE code_hash = $1`,
        [sha256(b.code ?? '')],
      );
      const row = rows[0];
      if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code is invalid or expired.' });
        return;
      }
      if (row.client_id !== b.client_id || row.redirect_uri !== b.redirect_uri) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'client_id or redirect_uri mismatch.' });
        return;
      }
      // Verify PKCE: base64url(sha256(verifier)) must equal the stored challenge.
      const verifier = b.code_verifier ?? '';
      const computed = createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || computed !== row.code_challenge) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
        return;
      }
      await pool.query(`UPDATE oauth_codes SET used = true WHERE code_hash = $1`, [sha256(b.code ?? '')]);
      const tokens = await issueTokens(row.identity, row.client_id);
      res.json({
        access_token: tokens.access,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: tokens.refresh,
        scope: row.scope || SCOPE,
      });
      return;
    }

    if (grant === 'refresh_token') {
      const { rows } = await pool.query(
        `SELECT identity, client_id FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' AND expires_at > now()`,
        [sha256(b.refresh_token ?? '')],
      );
      const row = rows[0];
      if (!row) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' });
        return;
      }
      const tokens = await issueTokens(row.identity, row.client_id);
      res.json({
        access_token: tokens.access,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: tokens.refresh,
        scope: SCOPE,
      });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });
}
