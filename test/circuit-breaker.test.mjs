import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, CircuitOpenError, SharedCircuitBreaker, VerdictClient } from '../dist/index.js';
import { MemoryStore, now } from './support.mjs';

function setup(options = {}) {
  const store = new MemoryStore();
  let time = now;
  let calls = 0;
  let response = async () => new Response('', {status: 503});
  const breaker = () => new SharedCircuitBreaker({store, scopeId: 'tenant', now: () => time, ...options});
  const client = (overrides = {}) => new VerdictClient({baseUrl: 'https://hideguard.io', apiKey: 'fixture-secret',
    circuitBreaker: breaker(), transport: (...args) => { calls++; return response(...args); }, ...overrides});
  return {store, breaker, client, advance: (ms) => {time += ms;}, calls: () => calls,
    respond: (fn) => {response = fn;}};
}

test('100 outage attempts across client instances perform only five private requests; no payload/keys in state', async () => {
  const f = setup();
  let refused = 0;
  for (let i = 0; i < 100; i++) {
    await assert.rejects(f.client().getVerdict('fixture-visitor'), (error) => {
      assert.ok(error instanceof ApiError);
      if (error instanceof CircuitOpenError) { refused++; assert.equal(error.retryAt, now + 30000); }
      return true;
    });
  }
  assert.equal(f.calls(), 5); assert.equal(refused, 95);
  const state = JSON.stringify([...f.store.records]);
  for (const secret of ['fixture-secret', 'fixture-visitor', 'hideguard.io']) assert.equal(state.includes(secret), false);
});

test('one half-open probe across instances; failure reopens and success restores fresh requests', async () => {
  const f = setup({failureThreshold: 1});
  await assert.rejects(f.client().getVerdict('v'));
  f.advance(30001);
  let release;
  f.respond(() => new Promise((resolve) => {release = resolve;}));
  const attempts = Array.from({length: 20}, () => f.client().getVerdict('v'));
  // Observe rejections immediately, including the nineteen refused probes.
  const settled = Promise.allSettled(attempts);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release(new Response('', {status: 503}));
  const outcomes = await settled;
  assert.equal(outcomes.filter((r) => r.status === 'rejected' && r.reason instanceof CircuitOpenError).length, 19);
  assert.equal(f.calls(), 2);
  await assert.rejects(f.client().getVerdict('v'), CircuitOpenError);
  f.advance(30001);
  f.respond(async (_url, init) => {
    assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'omit');
    return Response.json({visitorId: 'v', verdict: 'allow'});
  });
  for (let i = 0; i < 2; i++) assert.equal((await f.client().getVerdict('v')).verdict, 'allow');
  assert.equal(f.calls(), 4, 'recovery must not become an Allow cache');
});

test('late ordinary success cannot close a circuit opened by another request', async () => {
  const f = setup({failureThreshold: 1});
  let release;
  f.respond(() => new Promise((resolve) => {release = resolve;}));
  const older = f.client().getVerdict('v');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.respond(async () => new Response('', {status: 503}));
  await assert.rejects(f.client().getVerdict('v'));
  release(Response.json({verdict: 'allow'}));
  await older;
  await assert.rejects(f.client().getVerdict('v'), CircuitOpenError);
});

test('expired probe lease permits a new generation; late probe cannot reset its failure', async () => {
  const f = setup({failureThreshold: 1});
  const breaker = f.breaker();
  await assert.rejects(breaker.execute('service', async () => { throw new ApiError('down', 503); }));
  f.advance(30001);
  let release;
  const older = breaker.execute('service', () => new Promise((resolve) => {release = resolve;}));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.advance(15001);
  await assert.rejects(f.breaker().execute('service', async () => {throw new ApiError('down', 503);}));
  release('late'); await older;
  await assert.rejects(breaker.execute('service', async () => assert.fail('open')), CircuitOpenError);
});

test('failure window resets and ordinary HTTP 4xx never trips the breaker or grants a verdict', async () => {
  const f = setup({failureThreshold: 2, failureWindowMs: 100});
  await assert.rejects(f.client().getVerdict('v'));
  f.advance(101);
  await assert.rejects(f.client().getVerdict('v'));
  f.respond(async () => new Response('', {status: 403}));
  for (let i = 0; i < 5; i++) await assert.rejects(f.client().getVerdict('v'),
    (error) => error instanceof ApiError && !(error instanceof CircuitOpenError) && error.statusCode === 403);
  assert.equal(f.calls(), 7);
});

test('429, timeout and malformed responses count as upstream failures; timeout does not retry', async () => {
  for (const response of [async () => new Response('', {status: 429}), async () => new Response('bad json'),
    () => new Promise(() => {})]) {
    const f = setup({failureThreshold: 1}); f.respond(response);
    await assert.rejects(f.client({timeoutMs: 10}).getVerdict('v'), ApiError);
    await assert.rejects(f.client().getVerdict('v'), CircuitOpenError);
    assert.equal(f.calls(), 1);
  }
});

test('tenant, normalized endpoint and credentials isolate circuits, never visitor IDs', async () => {
  const f = setup({failureThreshold: 1});
  await assert.rejects(f.client().getVerdict('v1'));
  await assert.rejects(f.client().getVerdict('v2'), CircuitOpenError);
  await assert.rejects(f.client({apiKey: 'rotated'}).getVerdict('v'));
  await assert.rejects(f.client({baseUrl: 'https://dev.hideguard.io'}).getVerdict('v'));
  await assert.rejects(f.client({circuitBreaker: new SharedCircuitBreaker({store: f.store, scopeId: 'other'})}).getVerdict('v'));
  assert.equal(f.calls(), 4);
});

test('storage failures and malformed circuit state deny before HTTP; options validate before effects', async () => {
  const f = setup();
  for (const field of ['failureThreshold', 'failureWindowMs', 'openMs', 'probeLeaseMs']) {
    assert.throws(() => new SharedCircuitBreaker({store: f.store, scopeId: 's', [field]: 0}));
  }
  assert.throws(() => f.client({timeoutMs: 15000}), /lease/);
  f.store.read = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.client().getVerdict('v'), /storage unavailable/);
  assert.equal(f.calls(), 0);
  const g = setup();
  await assert.rejects(g.client().getVerdict('v'));
  for (const [key, record] of g.store.records) g.store.records.set(key, {...record, value: {failures: -1}});
  await assert.rejects(g.client().getVerdict('v'), /circuit state is invalid/);
  assert.equal(g.calls(), 1);
});

test('healthy traffic makes no state writes after circuit initialization', async () => {
  const f = setup(); f.respond(async () => Response.json({verdict: 'allow'}));
  await f.client().getVerdict('v');
  let writes = 0;
  const replace = f.store.replace.bind(f.store);
  f.store.replace = async (...args) => {writes++; return replace(...args);};
  for (let i = 0; i < 100; i++) await f.client().getVerdict('v');
  assert.equal(writes, 0); assert.equal(f.calls(), 101);
});

test('settlement storage failure refuses a successful response; unknown probe error does not heal the circuit', async () => {
  const f = setup(); f.respond(async () => Response.json({verdict: 'allow'}));
  const read = f.store.read.bind(f.store); let reads = 0;
  f.store.read = (...args) => {
    if (++reads === 2) throw new Error('settlement unavailable');
    return read(...args);
  };
  await assert.rejects(f.client().getVerdict('v'), /settlement unavailable/);
  const g = setup({failureThreshold: 1}); const breaker = g.breaker();
  await assert.rejects(breaker.execute('service', async () => {throw new ApiError('down', 503);}));
  g.advance(30001);
  await assert.rejects(breaker.execute('service', async () => {throw new Error('adapter failed');}), /adapter failed/);
  await assert.rejects(breaker.execute('service', async () => assert.fail('leased probe')), CircuitOpenError);
});

test('probe acquisition never mutates adapter-owned read values before CAS, including a contention retry', async () => {
  const f = setup({failureThreshold: 1});
  await assert.rejects(f.client().getVerdict('v'));
  for (const record of f.store.records.values()) Object.freeze(record.value);
  // A valid read adapter may return an immutable/shared view rather than a detached JSON object.
  f.store.read = async (key) => f.store.records.get(key) ?? null;
  const replace = f.store.replace.bind(f.store); let attempts = 0;
  f.store.replace = async (...args) => ++attempts === 1 ? false : replace(...args);
  f.advance(30001); f.respond(async () => Response.json({verdict: 'allow'}));
  assert.equal((await f.client().getVerdict('v')).verdict, 'allow');
  assert.equal(attempts, 3, 'one contended acquisition, one committed acquisition and one settlement');
});
