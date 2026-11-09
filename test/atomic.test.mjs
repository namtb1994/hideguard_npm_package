import test from 'node:test';
import assert from 'node:assert/strict';
import { Guard, recordKey } from '../dist/index.js';
import { MemoryStore, context, policy, now } from './support.mjs';

class AtomicMemoryStore extends MemoryStore {
  queue = Promise.resolve();
  failWrite = 0;
  transactions = 0;
  transaction(operation) {
    const pending = this.queue.then(async () => {
      this.transactions++;
      const view = new MemoryStore(); view.records = structuredClone(this.records);
      let writes = 0;
      for (const method of ['insert', 'replace']) {
        const original = view[method].bind(view);
        view[method] = (...args) => {
          if (++writes === this.failWrite) throw new Error('fixture write failure');
          return original(...args);
        };
      }
      const result = await operation(view);
      this.records = view.records;
      return result;
    });
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
const verdict = (kind = 'allow') => ({visitorId: 'v', verdict: kind, issuedAt: now, score: 0, reasonCodes: []});

test('atomic mode refuses missing capability; legacy mode never calls an available transaction implicitly', async () => {
  assert.throws(() => new Guard(new MemoryStore(), () => now, {atomic: true}), /transactional store/);
  const store = new AtomicMemoryStore();
  await new Guard(store, () => now).confirm(context, policy(), verdict(), 'legacy');
  assert.equal(store.transactions, 0);
});

test('Block confirmation publishes session and both ledgers together or rolls everything back', async () => {
  const store = new AtomicMemoryStore(); const guard = new Guard(store, () => now, {atomic: true});
  store.failWrite = 2;
  await assert.rejects(guard.confirm(context, policy(), verdict('block'), 'blocked'), /write failure/);
  assert.equal(store.records.size, 0);
  store.failWrite = 0;
  assert.equal((await guard.confirm(context, policy(), verdict('block'), 'blocked')).status, 'blocked');
  assert.equal(store.records.size, 3);
  assert.equal((await guard.inspect({...context, browserId: 'other'}, policy())).status, 'blocked');
});

test('complete session + binding rolls back on second write; business HTTP remains outside transactions', async () => {
  const store = new AtomicMemoryStore(); const guard = new Guard(store, () => now, {atomic: true});
  await guard.confirm(context, policy(), verdict(), 'confirmed');
  await guard.bindGrant(context, policy(), 'flow');
  const check = await guard.beginResourceCheck(context.scopeId, 'flow', context.actorId, policy());
  const before = structuredClone(store.records);
  store.failWrite = 2;
  await assert.rejects(guard.completeResourceCheck(check, policy(), verdict()), /write failure/);
  assert.deepEqual(store.records, before, 'pending session and binding remain unchanged after rollback');
  store.failWrite = 0;
  assert.equal((await guard.completeResourceCheck(check, policy(), verdict())).status, 'allowed');
  const bound = await store.read(await recordKey('resource', context.scopeId, 'flow'));
  assert.equal(bound.value.verificationId, check.verificationId);
  await guard.consumeGrant(context.scopeId, 'flow');
  await assert.rejects(guard.beginResourceCheck(context.scopeId, 'flow', context.actorId, policy()));
});

test('concurrent atomic reservations admit one attempt, failures do not clear a newer Block', async () => {
  const store = new AtomicMemoryStore(); const guard = new Guard(store, () => now, {atomic: true});
  await guard.confirm(context, policy(), verdict(), 'confirmed'); await guard.bindGrant(context, policy(), 'flow');
  const checks = await Promise.allSettled(Array.from({length: 8}, () => guard.beginResourceCheck(context.scopeId, 'flow', context.actorId, policy())));
  assert.equal(checks.filter((r) => r.status === 'fulfilled').length, 1);
  const check = checks.find((r) => r.status === 'fulfilled').value;
  await guard.confirm(context, policy(), verdict('block'), 'new-block');
  assert.equal((await guard.fail(context, policy(), check.verificationId)).status, 'blocked');
  await assert.rejects(guard.completeResourceCheck(check, policy(), verdict()));
});

test('atomic binding refuses renewed/consumed flow while server verdict is in flight', async () => {
  for (const action of ['consume', 'rebind']) {
    const store = new AtomicMemoryStore(); const guard = new Guard(store, () => now, {atomic: true});
    await guard.confirm(context, policy(), verdict(), 'confirmed'); await guard.bindGrant(context, policy(), 'flow');
    const check = await guard.beginResourceCheck(context.scopeId, 'flow', context.actorId, policy());
    if (action === 'consume') await guard.consumeGrant(context.scopeId, 'flow');
    else {
      await guard.confirm(context, policy(), verdict(), 'new-confirmation');
      await guard.bindGrant(context, policy(), 'flow');
    }
    await assert.rejects(guard.completeResourceCheck(check, policy(), verdict()));
  }
});
