/**
 * The gateway allowlist and approver allowlist are the connect-time and
 * approve-time access controls. env.js seeds known tokens and approvers.
 */
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityForToken, identityForSlackUser, isApprover } from '../src/config.js';

test('a known gateway token maps to its human identity', () => {
  assert.equal(identityForToken('gw_test_abc'), 'jeremy');
  assert.equal(identityForToken('gw_test_def'), 'taha');
});

test('an unknown gateway token is rejected (null)', () => {
  assert.equal(identityForToken('not-a-real-token'), null);
  assert.equal(identityForToken(''), null);
});

test('only allowlisted humans are approvers', () => {
  assert.equal(isApprover('jeremy'), true);
  assert.equal(isApprover('JEREMY'), true); // case-insensitive
  assert.equal(isApprover('taha'), false); // mapped token, but not in APPROVERS for the MVP
  assert.equal(isApprover('mallory'), false);
  assert.equal(isApprover(null), false);
  assert.equal(isApprover(undefined), false);
});

test('slack user ids map to identities', () => {
  assert.equal(identityForSlackUser('U0JEREMY'), 'jeremy');
  assert.equal(identityForSlackUser('U0UNKNOWN'), null);
});
