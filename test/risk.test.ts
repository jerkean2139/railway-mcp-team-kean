/**
 * Risk tiers drive every gate decision, so the mapping is security-critical.
 * These tests pin exactly which tools are gated and that annotations match tiers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_RISK, riskFor, isGated } from '../src/risk.js';

const EXPECTED_GATED = [
  'railway_delete_service',
  'railway_delete_project',
  'railway_delete_environment',
  'railway_wipe_volume',
  'railway_delete_variables',
].sort();

test('exactly the five irreversible tools are gated', () => {
  const gated = Object.keys(TOOL_RISK)
    .filter((name) => isGated(name))
    .sort();
  assert.deepEqual(gated, EXPECTED_GATED);
});

test('a tool is gated if and only if it is annotated destructive', () => {
  for (const [name, risk] of Object.entries(TOOL_RISK)) {
    assert.equal(isGated(name), risk.annotations.destructiveHint === true, name);
  }
});

test('read-tier tools are annotated read-only and never destructive', () => {
  for (const [name, risk] of Object.entries(TOOL_RISK)) {
    if (risk.tier === 'read') {
      assert.equal(risk.annotations.readOnlyHint, true, name);
      assert.equal(risk.annotations.destructiveHint, false, name);
    }
  }
});

test('mutating tiers are not read-only', () => {
  for (const [name, risk] of Object.entries(TOOL_RISK)) {
    if (risk.tier !== 'read') {
      assert.equal(risk.annotations.readOnlyHint, false, name);
    }
  }
});

test('riskFor throws for an unregistered tool', () => {
  assert.throws(() => riskFor('railway_not_a_real_tool'));
});

test('the new Redis and backup-flag tools are non-gated mutations', () => {
  for (const name of ['railway_add_redis', 'railway_edit_redis', 'railway_set_backup_flag']) {
    assert.ok(TOOL_RISK[name], `${name} should be registered`);
    assert.equal(isGated(name), false, name);
  }
});
