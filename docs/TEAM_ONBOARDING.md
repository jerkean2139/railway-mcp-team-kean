# Connecting to the Railway Guardrail MCP

This is the team's safe way to operate our Railway projects through Claude. It
talks to Railway for you, but with guardrails: it only touches one project per
session, only touches **staging**, and any destructive action (delete, wipe)
needs a human to approve it in Slack.

Server address: `https://railway-mcp-team-kean-production.up.railway.app`

---

## Part A: For the admin (Jeremy) — add a teammate first

Each developer needs their own token. Do this once per person.

1. Make a unique token for them:
   ```
   node -e "console.log('gw_live_'+require('crypto').randomBytes(24).toString('hex'))"
   ```
2. In Railway, open the app service, go to **Variables**, and edit
   **`GATEWAY_TOKENS`**. Add their token and name, comma separated. Example:
   ```
   gw_live_jeremytoken:jeremy,gw_live_newdevtoken:alex
   ```
3. (Optional) If they should be allowed to **approve** deletes, also:
   - Add their name to `APPROVERS`, e.g. `APPROVERS=jeremy,alex`
   - Add their Slack id to `SLACK_APPROVER_IDS`, e.g.
     `U0JEREMY:jeremy,U0ALEX:alex`
4. Save (Railway redeploys automatically).
5. Send the developer, privately (not in a shared channel):
   - the server address above
   - their personal token
   - this page

Tokens are personal. Do not share one token between people. To remove someone,
delete their entry from `GATEWAY_TOKENS` and redeploy.

---

## Part B: For each developer — connect Claude

You only need to do this once. Pick the way you use Claude.

### If you use Claude Code (terminal)

Run this, replacing `YOUR_TOKEN` with the token Jeremy gave you:

```
claude mcp add --transport http railway-guardrail https://railway-mcp-team-kean-production.up.railway.app/mcp --header "Authorization: Bearer YOUR_TOKEN" -s user
```

- `-s user` makes it available in all your projects. (Use `-s project` from
  inside a repo folder if you want it tied to just that project.)

Check it: run `claude`, then type `/mcp`. You should see **railway-guardrail**
with 22 tools.

### If you use Claude on the web or desktop app (chat / Projects)

1. In Claude, go to **Settings** -> **Connectors**.
2. Click **Add custom connector**.
3. URL: `https://railway-mcp-team-kean-production.up.railway.app/mcp`
4. Click connect. A sign-in page appears.
5. Paste your token (the part Jeremy gave you) and click **Authorize**.

It now works in your chats and inside Projects (turn the connector on for a
Project to use it there).

---

## How to use it

1. Start a chat or session and pick one project (required before anything else):
   > Select the my-project-name project.

   It binds to that project's **staging** environment. Production is off limits
   for the whole session. To switch projects, start a new session.

2. Then ask for what you need. Examples:
   - "List the services in this project."
   - "Show me the logs for the api service."
   - "List the variables for the web service." (values come back masked)
   - "Redeploy the worker service."
   - "Set the variable LOG_LEVEL to debug on the api service."
   - "Add a Redis to this project."

3. Destructive actions need approval. If you ask it to delete a service,
   project, environment, variables, or wipe a volume, it will:
   - write a backup snapshot first,
   - post an **Approve / Deny** message in our Slack approvals channel,
   - wait. It only runs after an allowlisted person clicks **Approve**.

---

## Good to know

- **One project per session.** No mutating action runs until you select a
  project, and a session only ever touches that one project.
- **Staging only.** It will not change production when a staging environment
  exists.
- **Secrets stay secret.** Variable values are never shown; you only see keys
  with masked values.
- **Everything is logged.** Every action records who started it, what it did,
  and who approved it.
- **Keep your token private.** It is your key to the server. If it leaks, tell
  Jeremy so it can be rotated.
