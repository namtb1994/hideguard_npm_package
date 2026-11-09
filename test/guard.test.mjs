import test from 'node:test';
import assert from 'node:assert/strict';
import { Guard, GuardError, ResourceVerificationError, limitRequests } from '../dist/index.js';
import { MemoryStore, policy, now, context } from './support.mjs';

function setup() {
  let time = now;
  const store = new MemoryStore();
  return { store, guard: new Guard(store, () => time), advance: (ms) => { time += ms; } };
}
const verdict = (kind = 'allow', issuedAt = now) => ({ visitorId: 'hg-1', verdict: kind, issuedAt, score: 0, reasonCodes: [] });

test('resource refusals distinguish waiting, timeout, failure and block without granting permission', async () => {
  const { guard, advance } = setup();
  const check = () => guard.beginResourceCheck(context.scopeId, 'flow', context.actorId, policy());
  const refused = (status) => assert.rejects(check(), error => error instanceof ResourceVerificationError &&
    error instanceof GuardError && error.reason === 'permission' && error.verificationStatus === status);
  await refused('required');
  await guard.confirm(context, policy(), verdict(), 'confirmed');
  await guard.bindGrant(context, policy(), 'flow');
  const attempt = await check();
  await refused('pending');
  await guard.fail(context, policy(), attempt.verificationId);
  await refused('failed');
  await guard.confirm(context, policy(), verdict(), 'confirmed-again');
  await guard.bindGrant(context, policy(), 'flow');
  await check(); advance(35001);
  await refused('failed');
  await guard.confirm(context, policy(), verdict('block', now + 35001), 'blocked');
  await refused('blocked');
  await assert.rejects(guard.beginResourceCheck(context.scopeId, 'flow', 'another-actor', policy()),
    error => error instanceof GuardError && !(error instanceof ResourceVerificationError));
});

test('one-request confirmation creates backend state, but local proof alone cannot bind a resource', async () => {
  const { guard, advance } = setup();
  await assert.rejects(guard.bindGrant(context, policy(), 'flow'), /verification is required/);
  const first = await guard.confirm(context, policy(), verdict(), 'confirmation-1');
  assert.equal(first.status, 'allowed'); assert.equal(first.verificationId, 'confirmation-1');
  await guard.bindGrant(context, policy(), 'flow');
  advance(10000);
  const second = await guard.confirm(context, policy(), verdict(), 'confirmation-2');
  assert.equal(second.grantedUntil, first.grantedUntil, 'Replay must not extend a signed grant');
  await assert.rejects(guard.resourceContext(context.scopeId, 'flow', context.actorId, policy()), /expired/);
});

test('confirmation cannot clear an existing block, including after a changed fingerprint', async () => {
  const { guard } = setup();
  const blocked = await guard.confirm(context, policy(), verdict('block'), 'blocked');
  const other = { ...context, browserId: 'other-browser' };
  const result = await guard.confirm(other, policy(), { ...verdict(), visitorId: 'changed' }, 'allow');
  assert.equal(result.status, 'blocked'); assert.equal(result.blockedUntil, blocked.blockedUntil);
});

test('a proof that expires during confirmation storage reads cannot create a grant', async () => {
  const { guard, store, advance } = setup();
  const read = store.read.bind(store); let reads = 0;
  store.read = async (key) => { const row = await read(key); if (++reads === 2) advance(300001); return row; };
  await assert.rejects(guard.confirm(context, policy(), verdict(), 'expired'), /expired during confirmation/);
});

test('confirmation re-reads identity blocks on a CAS retry', async () => {
  const { guard, store } = setup(); await guard.preflight(context, policy());
  const replace = store.replace.bind(store); let raced = false;
  store.replace = async (...args) => {
    if (!raced) {
      raced = true;
      await guard.confirm({ ...context, browserId: 'other' }, policy(), verdict('block'), 'block-wins');
      return false;
    }
    return replace(...args);
  };
  assert.equal((await guard.confirm(context, policy(), verdict(), 'racing-allow')).status, 'blocked');
});

test('confirmation changing fingerprints still honors the prior fingerprint block from another actor', async () => {
  const { guard } = setup();
  await guard.confirm(context, policy(), verdict(), 'first');
  await guard.confirm({ ...context, actorId: 'other-actor' }, policy(), verdict('block'), 'block-visitor');
  const changed = await guard.confirm(context, policy(), { ...verdict(), visitorId: 'fresh-fingerprint' }, 'changed');
  assert.equal(changed.status, 'blocked');
});

test('fixed pending deadline, explicit retry, stale callbacks and completed failure handling', async () => {
  const { guard, advance } = setup();
  const attempt = await guard.preflight(context, policy());
  advance(1000);
  assert.equal((await guard.preflight(context, policy())).verificationUntil, attempt.verificationUntil);
  advance(35000);
  assert.equal((await guard.preflight(context, policy())).status, 'verification_failed');
  const retry = await guard.preflight(context, policy(), { retry: true });
  assert.notEqual(retry.verificationId, attempt.verificationId);
  await guard.report(context, policy(), verdict('block'), attempt.verificationId);
  assert.equal((await guard.inspect(context, policy())).status, 'verification_required');
  await guard.report(context, policy(), verdict('allow', now + 36000), retry.verificationId);
  await guard.fail(context, policy(), retry.verificationId);
  assert.equal((await guard.inspect(context, policy())).status, 'allowed');
});

test('pass/action refresh does not slide deadline; Always starts a fresh page attempt', async () => {
  const { guard, advance } = setup();
  const attempt = await guard.preflight(context, policy());
  const allow = await guard.report(context, policy(), verdict(), attempt.verificationId);
  advance(10000);
  assert.equal((await guard.preflight(context, policy())).grantedUntil, allow.grantedUntil);
  const refresh = await guard.preflight(context, policy(), { action: true });
  assert.equal((await guard.inspect(context, policy())).status, 'verification_required');
  assert.equal((await guard.report(context, policy(), verdict('allow', now + 10000), refresh.verificationId)).grantedUntil, allow.grantedUntil);
  const always = policy({ recheckSeconds: 0, revision: 'always' });
  const first = await guard.preflight(context, always);
  await guard.report(context, always, verdict('allow', now + 10000), first.verificationId);
  assert.equal((await guard.preflight(context, always)).status, 'verification_required');
});

test('block persists across browsers for the same actor and does not extend; reset epoch preserves other state', async () => {
  const { guard, advance } = setup();
  const attempt = await guard.preflight(context, policy());
  const blocked = await guard.report(context, policy(), verdict('block'), attempt.verificationId);
  advance(10000);
  await guard.report(context, policy(), verdict('allow', now + 10000), attempt.verificationId);
  const other = { ...context, browserId: 'other' };
  assert.equal((await guard.preflight(other, policy())).blockedUntil, blocked.blockedUntil);
  assert.equal((await guard.preflight(context, policy())).blockedUntil, blocked.blockedUntil);
  assert.equal((await guard.preflight(context, policy({ blockEpoch: 'reset' }))).status, 'verification_required');
});

test('resource ownership, policy revision, attempt renewal and consume are checked at the backend', async () => {
  const { guard } = setup();
  const attempt = await guard.preflight(context, policy());
  await guard.report(context, policy(), verdict(), attempt.verificationId);
  await guard.bindGrant(context, policy(), 'flow-1');
  assert.deepEqual(await guard.resourceContext('site-1', 'flow-1', context.actorId, policy()), context);
  await assert.rejects(guard.resourceContext('site-2', 'flow-1', context.actorId, policy()));
  await assert.rejects(guard.resourceContext('site-1', 'flow-1', 'other-user', policy()));
  await assert.rejects(guard.resourceContext('site-1', 'flow-1', context.actorId, policy({ revision: 'new' })));
  await guard.consumeGrant('site-1', 'flow-1');
  await assert.rejects(guard.resourceContext('site-1', 'flow-1', context.actorId, policy()));
});

test('concurrent preflights share an attempt and CAS rate limits never lose increments', async () => {
  const { guard, store } = setup();
  const checks = await Promise.all(Array.from({ length: 8 }, () => guard.preflight(context, policy())));
  assert.equal(new Set(checks.map((check) => check.verificationId)).size, 1);
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => limitRequests(store, 'site-1', 'actor-1', 4, now)));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 4);
});

test('storage failures do not create permission', async () => {
  const store = { read: async () => { throw new Error('database unavailable'); } };
  await assert.rejects(new Guard(store).inspect(context, policy()), /unavailable/);
});

test('reused preflights read fresh blocks without redundant session reads or writes', async () => {
  const { store, guard } = setup();
  let reads = 0;
  let writes = 0;
  const read = store.read.bind(store);
  const insert = store.insert.bind(store);
  const replace = store.replace.bind(store);
  store.read = async (...args) => { reads++; return read(...args); };
  store.insert = async (...args) => { writes++; return insert(...args); };
  store.replace = async (...args) => { writes++; return replace(...args); };
  const attempt = await guard.preflight(context, policy());
  reads = 0; writes = 0;
  assert.equal((await guard.preflight(context, policy())).verificationId, attempt.verificationId);
  assert.equal(reads, 2); assert.equal(writes, 0);
  await guard.report(context, policy(), verdict(), attempt.verificationId);
  reads = 0; writes = 0;
  assert.equal((await guard.preflight(context, policy())).status, 'allowed');
  assert.equal(reads, 3); assert.equal(writes, 0);
  // Another browser blocks the same identity after the first check.
  const other = { ...context, browserId: 'blocked-elsewhere' };
  const blocked = await guard.preflight(other, policy());
  await guard.report(other, policy(), verdict('block'), blocked.verificationId);
  assert.equal((await guard.preflight(context, policy())).status, 'blocked');
});

test('report cannot evade a previous visitor block by presenting a new signed visitor identity', async () => {
  const { guard } = setup();
  const first = await guard.preflight(context, policy());
  await guard.report(context, policy(), verdict(), first.verificationId);
  const next = await guard.preflight(context, policy(), { action: true });
  const other = { ...context, browserId: 'other-browser', actorId: 'other-actor' };
  const block = await guard.preflight(other, policy());
  await guard.report(other, policy(), verdict('block'), block.verificationId);
  const result = await guard.report(context, policy(), { ...verdict(), visitorId: 'new-visitor' }, next.verificationId);
  assert.equal(result.status, 'blocked');
});

test('report retries identity-block checks when a concurrent write changes its CAS version', async () => {
  const { store, guard } = setup();
  const pending = await guard.preflight(context, policy());
  const replace = store.replace.bind(store);
  let raced = false;
  store.replace = async (key, version, next) => {
    if (!raced && next.value.status === 'allowed') {
      raced = true;
      const other = { ...context, browserId: 'racer', actorId: 'other-actor' };
      const otherPending = await guard.preflight(other, policy());
      await guard.report(other, policy(), verdict('block'), otherPending.verificationId);
      const current = await store.read(key);
      await replace(key, version, { ...current, version: version + 1 });
      return false;
    }
    return replace(key, version, next);
  };
  const result = await guard.report(context, policy(), verdict(), pending.verificationId);
  assert.equal(raced, true); assert.equal(result.status, 'blocked');
});

test('a report whose deadline expires during identity-block I/O cannot approve access', async () => {
  const { store, guard, advance } = setup();
  const pending = await guard.preflight(context, policy());
  const read = store.read.bind(store);
  let reads = 0;
  store.read = async (key) => {
    const record = await read(key);
    if (++reads === 2) advance(36000);
    return record;
  };
  const result = await guard.report(context, policy(), verdict(), pending.verificationId);
  assert.equal(result.status, 'verification_failed');
});
