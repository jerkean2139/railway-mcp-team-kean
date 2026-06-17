/**
 * Test environment shim. Import this FIRST in any test that transitively loads
 * src/config.ts, so the required env vars exist before config reads them. ESM
 * evaluates sibling imports in source order, so a top-of-file import of this
 * module runs before the source import below it.
 */
process.env.RAILWAY_TOKEN ??= 'test_railway_token';
process.env.DATABASE_URL ??= 'postgresql://postgres@localhost:5433/guardrail';
process.env.GATEWAY_TOKENS ??= 'gw_test_abc:jeremy,gw_test_def:taha';
process.env.APPROVERS ??= 'jeremy';
process.env.SLACK_BOT_TOKEN ??= 'xoxb-test';
process.env.SLACK_SIGNING_SECRET ??= 'testsigningsecret';
process.env.SLACK_APPROVAL_CHANNEL ??= 'C0TEST';
process.env.SLACK_APPROVER_IDS ??= '{"U0JEREMY":"jeremy","U0TAHA":"taha"}';

export {};
