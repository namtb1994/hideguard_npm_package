import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupExpired } from '../dist/index.js';
import { now } from './support.mjs';

function setup(count) {
  const rows = new Map(Array.from({length: count}, (_, i) => [`key-${String(i).padStart(4, '0')}`, {version: 1, expiresAt: now - 1}]));
  const store = {
    async scanExpired({before, limit, cursor}) {
      const candidates = [...rows].filter(([key, row]) => (!cursor || key > cursor) && row.expiresAt > 0 && row.expiresAt < before)
        .sort(([a], [b]) => a.localeCompare(b));
      const page = candidates.slice(0, limit);
      return {records: page.map(([key, row]) => ({key, ...row})),
        nextCursor: candidates.length > limit ? page.at(-1)[0] : null};
    },
    async removeExpired(key, expectedVersion, before) {
      const row = rows.get(key);
      return !!row && row.version === expectedVersion && row.expiresAt > 0 && row.expiresAt < before && rows.delete(key);
    },
  };
  return {store, rows};
}

test('cleanup batches N/N+1 with keyset continuation, never skips rows after deletion', async () => {
  for (const count of [0, 3, 4, 10]) {
    const f = setup(count); let removed = 0; let cursor = null; let result;
    do {
      result = await cleanupExpired(f.store, {limit: 3, cursor, now: () => now});
      assert.ok(result.scanned <= 3); removed += result.removed; cursor = result.nextCursor;
    } while (result.hasMore);
    assert.equal(removed, count); assert.equal(f.rows.size, 0);
  }
});

test('refresh/version race, future expiry and persistent tombstones survive cleanup', async () => {
  const f = setup(2);
  f.rows.set('persistent', {version: 1, expiresAt: 0});
  f.rows.set('active', {version: 1, expiresAt: now + 1});
  const remove = f.store.removeExpired.bind(f.store);
  f.store.removeExpired = async (key, version, cutoff) => {
    if (key === 'key-0000') f.rows.set(key, {version: version + 1, expiresAt: now + 10000});
    return remove(key, version, cutoff);
  };
  const result = await cleanupExpired(f.store, {now: () => now});
  assert.equal(result.contended, 1); assert.equal(result.removed, 1);
  assert.deepEqual([...f.rows.keys()].sort(), ['active', 'key-0000', 'persistent']);
});

test('time budget resumes at input cursor, including null, without skipping the unprocessed page', async () => {
  const f = setup(5); let time = now;
  const remove = f.store.removeExpired.bind(f.store);
  f.store.removeExpired = async (...args) => {const result = await remove(...args); time += 10; return result;};
  let removed = 0; let cursor = null; let result;
  do {
    result = await cleanupExpired(f.store, {limit: 3, cursor, before: now, now: () => time, timeBudgetMs: 5});
    removed += result.removed; cursor = result.nextCursor;
    if (result.hasMore) assert.equal(result.timeBudgetReached, true);
  } while (result.hasMore);
  assert.equal(removed, 5); assert.equal(f.rows.size, 0);
});

test('retry input cursor after partial infrastructure failure is safe and idempotent', async () => {
  const f = setup(4); const remove = f.store.removeExpired.bind(f.store); let calls = 0;
  f.store.removeExpired = async (...args) => {
    if (++calls === 2) throw new Error('storage unavailable');
    return remove(...args);
  };
  await assert.rejects(cleanupExpired(f.store, {now: () => now}), /unavailable/);
  const result = await cleanupExpired(f.store, {now: () => now});
  assert.equal(result.removed, 3); assert.equal(f.rows.size, 0);
});

test('defensive expiry checks skip unsafe candidates and invalid pages fail before deleting', async () => {
  let deletes = 0;
  const store = {scanExpired: async () => ({records: [
    {key: 'persistent', version: 1, expiresAt: 0}, {key: 'future', version: 1, expiresAt: now},
  ], nextCursor: null}), removeExpired: async () => {deletes++; return true;}};
  assert.equal((await cleanupExpired(store, {now: () => now})).skipped, 2);
  assert.equal(deletes, 0);
  store.scanExpired = async () => ({records: [{key: 'valid', version: 1, expiresAt: 1}, {key: 'bad', version: -1, expiresAt: 1}], nextCursor: null});
  await assert.rejects(cleanupExpired(store, {now: () => now}), /invalid record/);
  assert.equal(deletes, 0);
  for (const options of [{limit: 0}, {limit: 1001}, {timeBudgetMs: 0}, {before: now + 1}]) {
    await assert.rejects(cleanupExpired(store, {...options, now: () => now}), /invalid/);
  }
});
