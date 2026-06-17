/**
 * Railway Guardrail MCP server.
 *
 * Remote MCP server over Streamable HTTP in stateless JSON mode. A fresh
 * McpServer + transport is built per request (no shared state, no request-id
 * collisions). Gateway bearer auth runs as Express middleware before the MCP
 * handler, so only allowlisted humans can connect. A separate endpoint receives
 * Slack Approve / Deny interactions.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config, identityForToken, identityForSlackUser, isApprover } from './config.js';
import { initSchema } from './db.js';
import { registerTools } from './tools.js';
import { decideApproval, getApproval } from './approvals.js';
import { verifySlackSignature } from './slack.js';

const app = express();

// ---- Health check (unauthenticated) ----------------------------------------
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'railway-guardrail-mcp' });
});

// ---- Gateway bearer auth ----------------------------------------------------
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const identity = token ? identityForToken(token) : null;
  if (!identity) {
    // A non-allowlisted identity is rejected at connect.
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: token is not on the allowlist.' },
      id: null,
    });
    return;
  }
  (req as Request & { identity?: string }).identity = identity;
  next();
}

// ---- MCP endpoint (stateless JSON) ------------------------------------------
app.post('/mcp', express.json(), requireAuth, async (req: Request, res: Response) => {
  const identity = (req as Request & { identity?: string }).identity as string;
  const server = new McpServer({ name: 'railway-guardrail-mcp', version: '1.0.0' });
  registerTools(server, identity);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true, // single JSON response, no SSE
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal server error: ${(err as Error).message}` },
        id: null,
      });
    }
  }
});

// Stateless mode does not use GET (SSE stream) or DELETE (session teardown).
const methodNotAllowed = (_req: Request, res: Response): void => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

// ---- Slack interactions endpoint --------------------------------------------
// Capture the raw body so we can verify Slack's request signature.
app.post(
  '/slack/interactions',
  express.urlencoded({
    extended: true,
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }),
  async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
    const ok = verifySlackSignature(
      rawBody,
      req.headers['x-slack-request-timestamp'] as string | undefined,
      req.headers['x-slack-signature'] as string | undefined,
    );
    if (!ok) {
      res.status(401).send('invalid signature');
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse((req.body as { payload?: string }).payload ?? '{}');
    } catch {
      res.status(400).send('bad payload');
      return;
    }

    if (payload.type !== 'block_actions' || !Array.isArray(payload.actions) || payload.actions.length === 0) {
      res.status(200).send('');
      return;
    }

    const action = payload.actions[0];
    const approvalId: string = action.value;
    const decision = action.action_id === 'approve' ? 'approved' : 'denied';
    const slackUserId: string = payload.user?.id ?? '';
    const identity = identityForSlackUser(slackUserId);

    // Only an allowlisted approver may decide.
    if (!isApprover(identity)) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: 'You are not on the approver allowlist, so this action was not recorded.',
      });
      return;
    }

    const existing = await getApproval(approvalId);
    if (!existing) {
      res.status(200).json({ replace_original: true, text: 'This approval request is no longer valid.' });
      return;
    }

    const finalStatus = await decideApproval(approvalId, decision as 'approved' | 'denied', identity as string);

    let text: string;
    if (finalStatus === 'approved') {
      text = `Railway Guardrail: ${existing.summary}\nApproved by ${identity}.`;
    } else if (finalStatus === 'denied') {
      text = `Railway Guardrail: ${existing.summary}\nDenied by ${identity}.`;
    } else {
      // Was already decided or timed out before this click landed.
      text = `Railway Guardrail: ${existing.summary}\nAlready resolved (${finalStatus}). No change made.`;
    }

    res.status(200).json({ replace_original: true, text });
  },
);

// ---- Boot -------------------------------------------------------------------
async function main(): Promise<void> {
  await initSchema();
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Railway Guardrail MCP listening on port ${config.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
