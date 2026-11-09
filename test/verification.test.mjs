import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCollect, verifyApiVerdict, validatePublicKey, matchesPath } from '../dist/index.js';
import { policy, now, signedPayload } from './support.mjs';

test('Ed25519 canonical protocol v2 accepts authentic fields and rejects tampering', async () => {
  const payload = signedPayload({ reasons: [{ code: 'reason-1', description: 'unsigned text' }] });
  assert.equal((await verifyCollect(payload, policy(), now)).verdict, 'allow');
  for (const changed of [{ visitorId: 'another' }, { verdict: 'block' }, { score: 50 }, { environment: 'development' },
    { reasons: [{ code: 'tampered' }] }, { signature: undefined }]) {
    await assert.rejects(verifyCollect({ ...payload, ...changed }, policy(), now));
  }
  assert.equal((await verifyCollect({ ...payload, reasons: [{ code: 'reason-1', description: 'changed' }] }, policy(), now)).visitorId, 'visitor-1');
});

test('signature freshness, future skew, key format and strict schema are enforced', async () => {
  await assert.rejects(verifyCollect(signedPayload(), policy(), now + 300000));
  await assert.rejects(verifyCollect(signedPayload(), policy(), now - 31000));
  assert.throws(() => validatePublicKey('-----BEGIN PRIVATE KEY-----invalid'));
  for (const changed of [{ score: Number.MAX_SAFE_INTEGER + 1 }, { verdict: 'ALLOW' }, { reasons: [1] }]) {
    assert.throws(() => verifyApiVerdict({ visitorId: 'v-1', verdict: 'allow', score: 0, reasons: [], ...changed }, 'v-1', now));
  }
  assert.throws(() => verifyApiVerdict({ visitorId: 'v-2', verdict: 'allow', score: 0, reasons: [] }, 'v-1', now));
});

test('server API responses have a separate verifier and cannot pass the browser verifier unsigned', async () => {
  const payload = { visitorId: 'v-1', verdict: 'block', score: 5, reasons: [] };
  assert.equal(verifyApiVerdict(payload, 'v-1', now).verdict, 'block');
  await assert.rejects(verifyCollect(payload, policy(), now));
});

test('path rules treat metacharacters literally except wildcard and ignore query strings', () => {
  assert.equal(matchesPath('/customer/account?x=1', ['customer/*']), true);
  assert.equal(matchesPath('/product+a', ['product+a']), true);
  assert.equal(matchesPath('/productaa', ['product+a']), false);
  assert.equal(matchesPath('/contact', ['cart']), false);
});
