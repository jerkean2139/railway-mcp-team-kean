/**
 * Secret redaction is a non-negotiable guardrail: no secret value may ever leave
 * the server. These tests pin that behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskValue, maskVariableMap, redactArgs } from '../src/redact.js';

test('maskValue keeps a typed key prefix but hides the secret', () => {
  assert.equal(maskValue('sk-abcdef1234567890'), 'sk-****');
  assert.equal(maskValue('ghp_xxxxxxxxxxxx'), 'ghp_****');
});

test('maskValue fully hides values with no recognizable prefix', () => {
  assert.equal(maskValue('hunter2'), '****');
  assert.equal(maskValue('a-very-long-database-url'), '****');
});

test('maskValue never returns the original secret', () => {
  for (const secret of ['supersecretpassword', 'sk-live-deadbeef', '12345678']) {
    assert.notEqual(maskValue(secret), secret);
    assert.ok(!maskValue(secret).includes(secret));
  }
});

test('maskVariableMap masks every value and sorts keys', () => {
  const out = maskVariableMap({ ZED: 'zzz', OPENAI_API_KEY: 'sk-secret', DB_PASS: 'pw' });
  assert.deepEqual(out, ['DB_PASS = ****', 'OPENAI_API_KEY = sk-****', 'ZED = ****']);
  // No raw value appears anywhere.
  assert.ok(!out.join('\n').includes('sk-secret'));
  assert.ok(!out.join('\n').includes('zzz'));
});

test('redactArgs reduces a variables map to its keys only', () => {
  const out = redactArgs('railway_set_variables', {
    variables: { OPENAI_API_KEY: 'sk-secret', DB_PASS: 'pw' },
    serviceId: 'svc_1',
  });
  assert.deepEqual(out.variables, { keys: ['OPENAI_API_KEY', 'DB_PASS'] });
  assert.equal(out.serviceId, 'svc_1');
  assert.ok(!JSON.stringify(out).includes('sk-secret'));
  assert.ok(!JSON.stringify(out).includes('"pw"'));
});

test('redactArgs strips obvious secret-bearing string args', () => {
  const out = redactArgs('whatever', { password: 'hunter2', token: 'abc', name: 'keep-me' });
  assert.equal(out.password, '****');
  assert.equal(out.token, '****');
  assert.equal(out.name, 'keep-me');
});
