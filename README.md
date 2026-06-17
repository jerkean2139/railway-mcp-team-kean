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

## Tools (19)

Session: `railway_whoami`, `railway_select_project`, `railway_check_status`.
Read: `railway_list_projects`, `railway_list_services`, `railway_list_environments`,
`railway_get_logs`, `railway_list_variables`.
Reversible/create: `railway_redeploy`, `railway_set_variables`, `railway_generate_domain`,
`railway_create_environment`, `railway_create_project`, `railway_create_service`.
Gated: `railway_delete_service`, `railway_delete_project`, `railway_delete_environment`,
`railway_wipe_volume`, `railway_delete_variables`.

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

- `POST /mcp` - the MCP endpoint (requires `Authorization: Bearer <gateway token>`).
- `POST /slack/interactions` - receives Slack button clicks (signature verified).
- `GET /health` - unauthenticated health check.

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

## What is intentionally not built

The MVP keeps tools as primitives and stops at the containment walls. Deferred
features (per-user OAuth, multi-project sessions, production access, volume
restore, spend caps, composed workflows, an audit dashboard) are recorded in
`PHASE_2_NOTES.md` and must not be added until the MVP is shipped and trusted.
