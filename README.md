# Railway Guardrail MCP

A team-wide, remote MCP server that lets Claude operate Kean on Biz Railway
projects through natural language, with safety guardrails baked in so an agent
cannot do irreversible damage without a human approving it.

It connects to Railway through a single service token but records which human
initiated and which human approved every action. The design is contained: it
only ever touches one project per session, only ever touches staging, and stops
cold at anything that cannot be undone.

## Safety model

Borrowed from ShipSafe: classify every operation by how dangerous it is up
front, drive the gate behavior off that classification, and never let
confidence substitute for a human decision on irreversible actions.

| Tier | Operations | Behavior |
|---|---|---|
| Read | list, logs, status, view variables (masked) | Auto, logged |
| Reversible | redeploy, set variables, generate domain, create environment | Auto, logged |
| Create | create project, create service | Auto, logged |
| Irreversible | delete service/project/environment, wipe volume, delete variables | Hard gate: Slack approval + config snapshot first |

The gate rule: any tool annotated `destructiveHint: true` is gated. Everything
else runs autonomously.

### Containment walls

1. **One project per session.** No mutating tool runs until `railway_select_project`
   binds a project. Every tool then operates only inside that project. The
   binding is persisted per human identity in Postgres (the HTTP server is
   stateless). `railway_create_project` is the single documented exception, since
   it creates a project rather than touching an existing one.
2. **Staging only.** When a project has both a `staging` and a `production`
   environment, the session binds to staging and production is unreachable. A
   production-only project pauses for an approver to confirm treating production
   as staging for the session.

## Tools (22)

Session: `railway_whoami`, `railway_select_project`, `railway_check_status`.
Read: `railway_list_projects`, `railway_list_services`, `railway_list_environments`,
`railway_get_logs`, `railway_list_variables`.
Reversible/create: `railway_redeploy`, `railway_set_variables`, `railway_generate_domain`,
`railway_create_environment`, `railway_create_project`, `railway_create_service`,
`railway_add_redis`, `railway_edit_redis`, `railway_set_backup_flag`.
Gated: `railway_delete_service`, `railway_delete_project`, `railway_delete_environment`,
`railway_wipe_volume`, `railway_delete_variables`.

`railway_set_backup_flag` (reversible tier) turns the per-project volume backup
flag on or off for the bound project. When on, volume data is backed up before a
gated `railway_wipe_volume`. Default is off (staging data is treated as throwaway).
`railway_check_status` shows the current flag state for the bound project.

`railway_add_redis` (create tier) and `railway_edit_redis` (reversible tier) are an
owner-approved extension on top of the original MVP catalog. They manage the Redis
*service* (provision it from the official redis image with a persistent volume and a
generated password, and edit its instance settings/variables), not Redis data. Adding
Redis uses the documented `serviceCreate` image path rather than the undocumented
`templateDeployV2`, to avoid depending on an unconfirmed schema.

## Architecture

- TypeScript, MCP TypeScript SDK (`@modelcontextprotocol/sdk`).
- Streamable HTTP transport, stateless JSON mode. A fresh server and transport
  are built per request.
- Railway access via the Railway Public GraphQL API, authenticated with one
  Railway Team/Workspace token (`Authorization: Bearer`).
- Gateway auth: per-user bearer token mapped to a human identity, plus a connect
  allowlist.
- Postgres for the append-only audit log, per-user session bindings, per-project
  flags, config snapshots, and pending approvals.
- Approvals via Slack interactive messages (Block Kit, Approve / Deny).

## Endpoints

- `POST /mcp` - the MCP endpoint (requires a bearer token: a static gateway token or an OAuth access token).
- `POST /slack/interactions` - receives Slack button clicks (signature verified).
- `GET /health` - unauthenticated health check.
- OAuth 2.1 + discovery: `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`,
  `/oauth/token`.

## Connecting Claude

Two auth paths, both resolving to the same human-identity allowlist:

- **Claude Code (static bearer):** add the server with your gateway token as a header.
  ```bash
  claude mcp add --transport http railway-guardrail \
    https://YOUR-APP.up.railway.app/mcp \
    --header "Authorization: Bearer YOUR_GATEWAY_TOKEN" -s user
  ```
- **claude.ai chat / Projects / Cowork (OAuth):** their connector UI only accepts
  OAuth, not a static header, so the server runs a small OAuth 2.1 authorization
  server (dynamic client registration + PKCE). Add a custom connector pointing at
  `https://YOUR-APP.up.railway.app/mcp`; Claude runs the OAuth flow and shows a
  sign-in page where you paste your gateway token once. That token is validated
  against the same allowlist, and Claude stores the issued OAuth access token.

Onboarding still mints a gateway token per person (used at the OAuth sign-in).
Removing that step with Slack/Google SSO remains the Phase 2 "per-user OAuth" item.

## Configuration

All operational settings are environment variables, so onboarding a teammate or
adding an approver is a config change and a restart, never a code change. See
`.env.example` for the full list. The approver allowlist is `APPROVERS` (the MVP
ships with just `jeremy`; add Taha later with `APPROVERS=jeremy,taha`).

## Setup and deploy

See **SETUP.md** for plain, step by step instructions (creating the Railway
token, the Slack app, the Postgres database, the gateway tokens, and deploying).

## Local development

```bash
npm install
cp .env.example .env   # then fill in real values
npm run build
npm run start
```

## Tests

```bash
npm test
```

The suite (Node's built-in test runner, via `tsx`) pins the security-critical
logic with no database or network required: secret redaction (no value ever
leaks), the risk-tier mapping (exactly the five irreversible tools are gated),
Slack request-signature verification (forgery and replay are rejected), and the
gateway/approver allowlists.

## What is intentionally not built

The MVP keeps tools as primitives and stops at the containment walls. Deferred
features (per-user OAuth, multi-project sessions, production access, volume
restore, spend caps, composed workflows, an audit dashboard) are recorded in
`PHASE_2_NOTES.md` and must not be added until the MVP is shipped and trusted.
