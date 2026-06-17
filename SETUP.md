# Setup, step by step

This is everything **you** need to do by hand. The code is done. Follow the
steps in order. Each step is small. Do not skip any.

When a step says "copy this and save it," paste it into a notes file for now.
You will need them all together in Step 6.

---

## Step 1: Get your Railway token

1. Go to **https://railway.com** and log in.
2. Click your picture in the top right, then click **Account Settings**.
3. Click **Tokens** on the left.
4. In the box, type a name like `guardrail-mcp`.
5. Pick your **team / workspace** in the dropdown (not "no workspace").
6. Click **Create**.
7. A long secret string appears. **Copy it and save it.** You only see it once.
   - Save it as: `RAILWAY_TOKEN`

---

## Step 2: Make the database

1. Still on Railway, click **New Project**.
2. Click **Deploy PostgreSQL**. Wait about a minute for it to turn green.
3. Click the **Postgres** box you just made.
4. Click the **Variables** tab.
5. Find the one named **DATABASE_URL**. Click the copy button next to it.
   - Save it as: `DATABASE_URL`

Keep this project open. You will put the server in the same project in Step 7.

---

## Step 3: Make the Slack app

1. Go to **https://api.slack.com/apps**.
2. Click **Create New App**, then **From scratch**.
3. Name it `Railway Guardrail`. Pick your Slack workspace. Click **Create App**.

### 3a: Turn on the bot and its powers
4. On the left, click **OAuth & Permissions**.
5. Scroll to **Scopes** then **Bot Token Scopes**.
6. Click **Add an OAuth Scope** and add these three, one at a time:
   - `chat:write`
   - `chat:write.public`
   - `commands`
7. Scroll back up and click **Install to Workspace**, then **Allow**.
8. A token starting with **xoxb-** appears. **Copy it and save it.**
   - Save it as: `SLACK_BOT_TOKEN`

### 3b: Get the signing secret
9. On the left, click **Basic Information**.
10. Scroll to **App Credentials**.
11. Find **Signing Secret**, click **Show**, copy it.
    - Save it as: `SLACK_SIGNING_SECRET`

### 3c: Pick the channel for approvals
12. Open Slack. Make or pick a channel, like `#railway-approvals`.
13. Invite the bot: in that channel type `/invite @Railway Guardrail` and send.
14. Get the channel id: click the channel name at the top, scroll to the bottom
    of the popup, copy the **Channel ID** (it looks like `C0123ABCD`).
    - Save it as: `SLACK_APPROVAL_CHANNEL`

### 3d: Get your own Slack user id
15. In Slack, click your own name or picture to open your profile.
16. Click the three dots (**More**), then **Copy member ID**
    (it looks like `U0123ABCD`).
    - Save it as: your Slack user id.

> Note: Step 3e (the button web address) needs the server to be live first, so
> we do it later, in Step 8.

---

## Step 4: Make the gateway tokens (who can connect)

A gateway token is just a long secret password for one person. Right now you
only need one, for yourself (Jeremy).

1. Make a long random secret. An easy way: open a terminal and run:
   ```
   node -e "console.log('gw_live_' + require('crypto').randomBytes(24).toString('hex'))"
   ```
   Or just make up a long random string that starts with `gw_live_`.
2. **Copy it and save it.** This is the password you will give to Claude.
   - Save it as: your gateway token.

Now build two small settings using the things you saved:

- **GATEWAY_TOKENS**: this links your token to your name. Write it like this,
  putting your real token in place of the example:
  ```
  {"gw_live_PASTE_YOUR_TOKEN_HERE":"jeremy"}
  ```
- **SLACK_APPROVER_IDS**: this links your Slack id to your name. Write it like
  this, putting your real Slack id (from Step 3d) in place of the example:
  ```
  {"U0123ABCD":"jeremy"}
  ```

- **APPROVERS**: just type `jeremy`.

---

## Step 5: Put the code on GitHub

The code is already saved on the branch `claude/modest-lovelace-ldmife`. If you
want it on the main branch, merge it there. The Railway step below can deploy
straight from this GitHub repo.

---

## Step 6: Gather everything you saved

You should now have all of these. Check them off:

- [ ] `RAILWAY_TOKEN` (Step 1)
- [ ] `DATABASE_URL` (Step 2)
- [ ] `SLACK_BOT_TOKEN` (Step 3a)
- [ ] `SLACK_SIGNING_SECRET` (Step 3b)
- [ ] `SLACK_APPROVAL_CHANNEL` (Step 3c)
- [ ] `GATEWAY_TOKENS` (Step 4)
- [ ] `SLACK_APPROVER_IDS` (Step 4)
- [ ] `APPROVERS` = `jeremy` (Step 4)

---

## Step 7: Deploy the server on Railway

1. Go back to the Railway project that has your Postgres (from Step 2).
2. Click **New**, then **GitHub Repo**, and pick this repo
   (`railway-mcp-team-kean`). Pick the branch with the code.
3. Railway starts building it. While it builds, click the new service box, then
   the **Variables** tab.
4. Add each setting from Step 6 as a variable. Click **New Variable**, type the
   name on the left and the value on the right, for all eight:
   - `RAILWAY_TOKEN`
   - `DATABASE_URL`  (tip: you can set this to `${{Postgres.DATABASE_URL}}` to
     link it automatically, or paste the value you copied)
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_APPROVAL_CHANNEL`
   - `GATEWAY_TOKENS`
   - `SLACK_APPROVER_IDS`
   - `APPROVERS`
5. Click **Deploy** (or it redeploys on its own). Wait for green.
6. Click the **Settings** tab of the service. Under **Networking**, click
   **Generate Domain**. Copy the web address it gives you (it ends in
   `.up.railway.app`).
   - Save it as: your server address.
7. Add one more variable now that you have the address, then let it redeploy:
   - `PUBLIC_URL` = your server address, with `https://` and no slash at the end,
     for example `https://your-app.up.railway.app`. This lets Claude chat and
     Cowork connect.

### Check it is alive
8. Open a browser and go to: `https://YOUR-SERVER-ADDRESS/health`
9. You should see `{"status":"ok",...}`. If you do, the server is running.

---

## Step 8: Finish the Slack button setup

Now that the server is live, tell Slack where to send button clicks.

1. Go back to **https://api.slack.com/apps** and open your app.
2. On the left, click **Interactivity & Shortcuts**.
3. Turn the switch **On**.
4. In the **Request URL** box, paste your server address and add
   `/slack/interactions` at the end. Example:
   ```
   https://your-server.up.railway.app/slack/interactions
   ```
5. Click **Save Changes**.

---

## Step 9: Connect Claude to the server

There are two ways, depending on where you use Claude. Both check the same
allowlist, so you use your gateway token either way.

### Option A: Claude Code (on your computer)

Run this in a terminal, putting in your real server address and gateway token:

```
claude mcp add --transport http railway-guardrail https://YOUR-SERVER/mcp --header "Authorization: Bearer YOUR_GATEWAY_TOKEN" -s user
```

Then type `/mcp` inside Claude Code. You should see `railway-guardrail` connected.

### Option B: Claude chat, Projects, or Cowork (the website or desktop app)

These connect with a sign in, not a pasted header.

1. In Claude, open **Settings**, then **Connectors**.
2. Click **Add custom connector**.
3. For the URL, paste your server address with `/mcp` at the end, for example
   `https://your-server.up.railway.app/mcp`.
4. Click to connect. A **sign in page** from your server appears.
5. On that page, paste your **gateway token** (from Step 4) and click
   **Authorize**.
6. Claude is now connected. The connector works in normal chats and in Projects.

---

## Step 10: Test it

1. Ask Claude: **"Use railway_check_status."** You should see database ok and
   Railway token ok.
2. Ask Claude: **"List my Railway projects."** You should see your projects.
3. Ask Claude: **"Select project <a project name>."** It should bind to staging.
4. Ask Claude to **delete a test service** in that project. Claude will start
   the action, and a message with **Approve / Deny** buttons should appear in
   your Slack channel. Click **Deny**. The action should stop.
5. Try again and click **Approve**. The action should go through.

If all of that works, you are done. The server is live and safe.

---

## Adding Taha later (one change, no code)

1. In the Railway service Variables, change `APPROVERS` to `jeremy,taha`.
2. Add Taha's Slack id to `SLACK_APPROVER_IDS`, like
   `{"U0JEREMY":"jeremy","U0TAHA":"taha"}`.
3. Make Taha his own gateway token and add it to `GATEWAY_TOKENS`, like
   `{"gw_live_jeremy...":"jeremy","gw_live_taha...":"taha"}`.
4. Redeploy. That is it.
