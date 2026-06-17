/**
 * The credential-map parser is what reads GATEWAY_TOKENS and SLACK_APPROVER_IDS.
 * JSON in env vars is a common deploy trap, so the parser accepts a simple
 * token:name form and tolerates curly quotes and wrapping quotes. These tests
 * pin that forgiving behavior.
 */
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialMap } from '../src/config.js';

function parse(value: string): Record<string, string> {
  process.env.__TESTMAP = value;
  return credentialMap('__TESTMAP');
}

test('simple form with a colon', () => {
  assert.deepEqual(parse('gw_live_abc:jeremy'), { gw_live_abc: 'jeremy' });
});

test('simple form with an equals sign', () => {
  assert.deepEqual(parse('gw_live_abc=jeremy'), { gw_live_abc: 'jeremy' });
});

test('simple form with multiple entries', () => {
  assert.deepEqual(parse('gw_live_abc:jeremy, gw_live_def:taha'), {
    gw_live_abc: 'jeremy',
    gw_live_def: 'taha',
  });
});

test('JSON object form', () => {
  assert.deepEqual(parse('{"gw_live_abc":"jeremy"}'), { gw_live_abc: 'jeremy' });
});

test('JSON wrapped in stray outer quotes is tolerated', () => {
  assert.deepEqual(parse('\'{"gw_live_abc":"jeremy"}\''), { gw_live_abc: 'jeremy' });
});

test('curly quotes are normalized', () => {
  assert.deepEqual(parse('{“gw_live_abc”:“jeremy”}'), { gw_live_abc: 'jeremy' });
});

test('empty value yields an empty map', () => {
  assert.deepEqual(parse(''), {});
});

test('a malformed entry throws a clear error', () => {
  assert.throws(() => parse('just-a-token-no-name'), /token:name/);
});
