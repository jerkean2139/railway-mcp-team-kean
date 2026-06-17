/**
 * Slack request signature verification gates who can approve a destructive
 * action, so forgery and replay must be rejected. env.js sets the signing
 * secret before slack.js (via config.js) reads it.
 */
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from '../src/slack.js';

const SECRET = 'testsigningsecret'; // must match test/env.ts

function sign(body: string, timestamp: string, secret = SECRET): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

const now = () => Math.floor(Date.now() / 1000).toString();

test('a correctly signed, fresh request verifies', () => {
  const body = 'payload=%7B%22ok%22%3Atrue%7D';
  const ts = now();
  assert.equal(verifySlackSignature(body, ts, sign(body, ts)), true);
});

test('a request signed with the wrong secret is rejected', () => {
  const body = 'payload=x';
  const ts = now();
  assert.equal(verifySlackSignature(body, ts, sign(body, ts, 'wrong-secret')), false);
});

test('a tampered body is rejected', () => {
  const body = 'payload=original';
  const ts = now();
  const sig = sign(body, ts);
  assert.equal(verifySlackSignature('payload=tampered', ts, sig), false);
});

test('a stale timestamp is rejected (replay protection)', () => {
  const body = 'payload=x';
  const old = (Math.floor(Date.now() / 1000) - 60 * 10).toString(); // 10 minutes ago
  assert.equal(verifySlackSignature(body, old, sign(body, old)), false);
});

test('missing timestamp or signature is rejected', () => {
  assert.equal(verifySlackSignature('body', undefined, 'v0=abc'), false);
  assert.equal(verifySlackSignature('body', now(), undefined), false);
});
