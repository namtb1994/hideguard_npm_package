import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, Guard, SharedCircuitBreaker, cleanupExpired, recordKey } from '../../dist/index.js';
import { sqliteStore } from './sqlite-store.mjs';
import { context, policy, now } from '../support.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hideguard-native-'));
  const path = join(dir, 'state.sqlite'); const store = sqliteStore(path);
  t.after(async () => {store.close(); await rm(dir, {recursive: true, force: true});});
  return {path, store};
}

async function workers(t, path, mode, clock, count = 8) {
  const children = []; let ready = 0; let results = 0; let waiting = 0; let probes = 0; let probe; let released = false;
  const outcomes = []; let start;
  const started = new Promise((resolve) => {start = resolve;});
  const promises = Array.from({length: count}, () => new Promise((resolve, reject) => {
    const child = fork(new URL('./sqlite-worker.mjs', import.meta.url), [path, mode, String(clock)], {silent: true});
    children.push(child);
    let result; let stderr = '';
    child.stderr.on('data', (chunk) => {stderr += chunk;});
    child.on('error', reject);
    child.on('exit', (code) => code === 0 && result ? resolve(result) : reject(new Error(`worker exit ${code}: ${stderr}`)));
    child.on('message', (message) => {
      if (message.kind === 'ready' && ++ready === count) start();
      if (message.kind === 'probe') { probes++; probe = child; }
      if (message.kind === 'read' && ++waiting === count) for (const worker of children) worker.send('release');
      if (message.kind === 'result') {
        result = message; outcomes.push(message); results++;
      }
      if (mode === 'circuit' && results >= count - 1 && probe && !released) {
        released = true; probe.send('release');
      }
    });
  }));
  // Attach rejection handlers before waiting for the startup barrier.
  const completed = Promise.all(promises);
  void completed.catch(() => undefined);
  t.after(() => {for (const child of children) if (child.exitCode === null) child.kill();});
  await Promise.race([started, completed.then(() => {throw new Error('workers exited before ready');})]);
  for (const child of children) child.send('go');
  await completed;
  return {outcomes, probes};
}

test('native SQLite: eight independent processes with the same CAS version admit one writer', {timeout: 20000}, async (t) => {
  const {path, store} = await fixture(t);
  await store.insert('cas', {version: 1, value: {}, expiresAt: now + 10000});
  const {outcomes} = await workers(t, path, 'cas', now);
  assert.equal(outcomes.filter((r) => r.ok).length, 1);
  assert.equal((await store.read('cas')).version, 2);
});

test('native SQLite: twenty independent processes share exactly one half-open probe', {timeout: 20000}, async (t) => {
  const {path, store} = await fixture(t);
  const circuit = new SharedCircuitBreaker({store, scopeId: 'tenant', failureThreshold: 1, now: () => now});
  await assert.rejects(circuit.execute('service', async () => {throw new ApiError('down', 503);}));
  const {outcomes, probes} = await workers(t, path, 'circuit', now + 30001, 20);
  assert.equal(probes, 1); assert.equal(outcomes.filter((r) => r.ok).length, 1);
  assert.equal(outcomes.filter((r) => r.error === 'CircuitOpenError').length, 19);
});

test('native SQLite: serializable Guard reservation across eight processes and rollback on write failure', {timeout: 20000}, async (t) => {
  const {path, store} = await fixture(t);
  const guard = new Guard(store, () => now, {atomic: true});
  const verdict = {visitorId: 'v', verdict: 'allow', issuedAt: now, score: 0, reasonCodes: []};
  await guard.confirm(context, policy(), verdict, 'confirmed'); await guard.bindGrant(context, policy(), 'flow');
  const {outcomes} = await workers(t, path, 'reserve', now);
  assert.equal(outcomes.filter((r) => r.ok).length, 1);
  assert.equal(outcomes.filter((r) => r.status === 'pending').length, 7);
  const bindingKey = await recordKey('resource', context.scopeId, 'flow');
  const before = await store.read(bindingKey);
  await assert.rejects(store.transaction(async (view) => {
    await view.replace(bindingKey, before.version, {...before, version: before.version + 1, value: {consumed: true}});
    throw new Error('fixture failure');
  }), /fixture failure/);
  assert.deepEqual(await store.read(bindingKey), before);
});

test('native SQLite: cleanup batches and conditional delete preserve a concurrently refreshed row', async (t) => {
  const {path, store} = await fixture(t);
  const second = sqliteStore(path); t.after(() => second.close());
  for (const key of ['a', 'b', 'c']) await store.insert(key, {version: 1, value: {}, expiresAt: now - 1});
  await store.insert('tombstone', {version: 1, value: {consumed: true}, expiresAt: 0});
  const remove = store.removeExpired.bind(store);
  store.removeExpired = async (key, version, before) => {
    if (key === 'a') await second.replace(key, version, {version: version + 1, value: {active: true}, expiresAt: now + 10000});
    return remove(key, version, before);
  };
  const first = await cleanupExpired(store, {now: () => now, limit: 2});
  assert.equal(first.contended, 1); assert.equal(first.removed, 1); assert.equal(first.hasMore, true);
  const last = await cleanupExpired(store, {now: () => now, limit: 2, cursor: first.nextCursor});
  assert.equal(last.removed, 1); assert.equal(last.hasMore, false);
  assert.equal((await store.read('a')).value.active, true);
  assert.equal((await store.read('tombstone')).expiresAt, 0);
});
