# Railway Guardrail MCP — Deferred Features

Everything here was intentionally cut from the MVP. Do not build any of it until the MVP is shipped, deployed, and proven against real staging projects.

## Phase 2 (next, once the MVP is trusted)

- **Add Taha as an approver.** Already designed for: flip the approver config array from `["jeremy"]` to `["jeremy", "taha"]`. Then add routing (either approver can approve, or specific tiers route to specific people).
- **Per-user OAuth** instead of issued bearer tokens, so onboarding a teammate does not require minting a token by hand.
- **Downgrade delete-service to autonomous** if staging service deletes prove cheap and recoverable in practice. Keep delete-project, delete-environment, wipe-volume, and bulk-delete-variables gated.
- **Volume data backup as a smarter default** with an actual restore path, not just a pre-delete copy.

## Phase 3 (later, bigger lifts)

- **Production access** behind a stricter gate (multi-approver, mandatory snapshot, narrower tool set). This is the one that needs the most care; do not rush it.
- **Multi-project sessions** if the one-project-per-session wall ever becomes a real bottleneck. Only after the audit trail and gates are battle-tested.
- **Composed workflow tools** (for example, "spin up a full staging stack" as one tool that orchestrates several primitives). The MVP keeps tools as primitives on purpose.
- **Spend and usage guardrails** (cost caps, alerts before an action that increases billing).
- **Audit log dashboard** so the team can read the trail without querying Postgres directly.
- **Delegated agent operations** (Railway's own `railway-agent` pattern) for multi-step debugging, once the guardrails are mature enough to trust with longer autonomous chains.

---

## Build notes (things deferred during the MVP build, recorded here instead of coded)

- **Redis for pending-approval state.** The MVP polls the Postgres `approvals` table for the pending/approved/denied transition. Redis pub/sub would remove the polling loop; left out to keep the moving parts minimal.
- **MCP session ids.** The server runs stateless (no MCP session id). "One project per session" is enforced by persisting the active binding per human identity in Postgres. If true multi-session-per-user is ever needed, introduce real session ids then.
- **Slack message threading / richer status updates.** The MVP edits the original approval message to show the decision. Threaded follow-ups and richer status were left out.
