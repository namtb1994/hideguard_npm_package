import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {PublicVerdictClient, verifySignedResponse, verifySignedEnvelope, verifyCollect} from '../dist/index.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({type: 'spki', format: 'pem'});
const now = 1800000000000;
const verification = {publicKey, environment: 'production', maxAgeSeconds: 300};

function proof({kind = 'verdict', timestamp = now / 1000, ...fields} = {}) {
  const reply = {siteId: 'site-1', environment: 'production', requestId: 'request-1',
    visitorId: 'visitor-1', verdict: 'allow', score: 0, reasons: [], ...fields};
  const message = [`hideguard-${kind}-ed25519-v2`, 'alg=ed25519', 'kid=key-1', `t=${timestamp}`,
    `site=${reply.siteId}`, `environment=${reply.environment}`, `request=${reply.requestId}`,
    `visitor=${reply.visitorId}`, `verdict=${reply.verdict}`, `score=${reply.score}`,
    `reasons=${JSON.stringify(reply.reasons.map((reason) => reason.code))}`].join('\n');
  reply.signature = `v=2,alg=ed25519,kid=key-1,t=${timestamp},sig=${sign(null, Buffer.from(message), keys.privateKey).toString('base64url')}`;
  return reply;
}

function client(reply, options = {}) {
  return new PublicVerdictClient({baseUrl: 'https://hideguard.example', publicKey: 'site-key',
    now: () => now, transport: async () => Response.json(reply), ...options});
}

test('public client sends only site key and visitor and returns verified proof for every decision', async () => {
  for (const verdict of ['allow', 'challenge', 'block']) {
    const reply = proof({verdict});
    const api = client(reply, {transport: async (url, init) => {
      assert.equal(url, 'https://hideguard.example/api/v1/verdict-public');
      assert.deepEqual(init.headers, {'Content-Type': 'application/json', Accept: 'application/json', 'x-site-key': 'site-key'});
      assert.equal(init.body, '{"visitorId":"visitor-1"}');
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.redirect, 'error');
      return Response.json(reply);
    }});
    const [verified] = await api.getVerdicts('visitor-1', verification);
    assert.equal(verified.verdict, verdict);
    assert.equal(verified.visitorId, 'visitor-1');
    assert.deepEqual(await verifySignedEnvelope(verified.signedResponse, {...verification, nowMs: now}), verified);
  }
});

test('public responses require Verdict labels and cannot use the unsigned private response checker', async () => {
  const reply = proof();
  const collect = proof({kind: 'collect'});
  const options = {...verification, nowMs: now};
  await verifySignedResponse(reply, options, 'verdict');
  await verifySignedResponse(collect, options);
  await assert.rejects(verifySignedResponse(reply, options), /signature is invalid/);
  await assert.rejects(verifySignedResponse(collect, options, 'verdict'), /signature is invalid/);
  await assert.rejects(client(collect).getVerdicts('visitor-1', verification));
  await assert.rejects(client({...reply, signature: undefined}).getVerdicts('visitor-1', verification));
  await assert.rejects(verifyCollect(reply, {signaturePublicKey: publicKey, environment: 'production',
    recheckSeconds: 300, blockSeconds: 3600}, now));
});

test('every array entry is verified, bound to requested visitor and checked using response-time freshness', async () => {
  for (const reply of [[], Array.from({length: 33}, () => proof()), [proof(), proof({visitorId: 'another'})],
    [proof(), {...proof(), score: 1}], proof({environment: 'staging'}), proof({timestamp: now / 1000 - 301}),
    proof({timestamp: now / 1000 + 31}), {...proof(), verdict: 'unknown'}]) {
    await assert.rejects(client(reply).getVerdicts('visitor-1', verification));
  }
  let clock = now;
  const api = client(proof(), {now: () => clock, transport: async () => {
    clock += 301000;
    return Response.json(proof());
  }});
  await assert.rejects(api.getVerdicts('visitor-1', verification), /expired/);
});

test('public client bounds streamed bytes before JSON parse and cancels oversized or timed-out streams', async () => {
  let cancelled = false;
  const oversized = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(100))); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(client(null, {maximumResponseBytes: 50, transport: async () => oversized})
    .getVerdicts('visitor-1', verification), /too large/);
  assert.equal(cancelled, true);
  cancelled = false;
  const hanging = new Response(new ReadableStream({cancel() { cancelled = true; }}));
  await assert.rejects(client(null, {timeoutMs: 10, transport: async () => hanging})
    .getVerdicts('visitor-1', verification), /timed out/);
  assert.equal(cancelled, true);
});

test('deadline is finite even when transport ignores abort; failures never expose response bodies or keys', async () => {
  await assert.rejects(client(null, {timeoutMs: 10, transport: () => new Promise(() => {})})
    .getVerdicts('visitor-1', verification), /timed out/);
  for (const response of [new Response('private response', {status: 401}), new Response('', {status: 302}),
    new Response('invalid'), new Response(new Uint8Array([0xff])), Response.json(null)]) {
    await assert.rejects(client(null, {transport: async () => response}).getVerdicts('visitor-1', verification),
      (error) => !error.message.includes('private response') && !error.message.includes('site-key'));
  }
});

test('diagnostics are optional, bounded and cannot grant or refuse access', async () => {
  const events = [];
  const reply = proof({source: 'unsigned source', extra: {secret: 'not diagnostic'}});
  const api = client(reply, {onVerification(event) { events.push(event); throw new Error('diagnostic unavailable'); }});
  const [verified] = await api.getVerdicts('visitor-1', verification);
  assert.equal(verified.verdict, 'allow');
  assert.equal(events[0].result, 'passed');
  const serialized = JSON.stringify(events);
  for (const value of [publicKey, reply.signature, 'visitor-1', 'site-key', 'not diagnostic', 'unsigned source']) {
    assert.equal(serialized.includes(value), false);
  }
  await assert.rejects(client({...reply, requestId: 'x'.repeat(129)}, {onVerification(event) {
    assert.equal(event.requestId, null);
    assert.equal(event.result, 'failed');
  }}).getVerdicts('visitor-1', verification));
  const asynchronous = client(reply, {onVerification: async () => { throw new Error('async diagnostic unavailable'); }});
  assert.equal((await asynchronous.getVerdicts('visitor-1', verification))[0].verdict, 'allow');
  await new Promise((resolve) => setImmediate(resolve));
});

test('error response streams and late responses after timeout are cancelled without being parsed', async () => {
  let cancelled = false;
  const denied = new Response(new ReadableStream({cancel() { cancelled = true; }}), {status: 403});
  await assert.rejects(client(null, {transport: async () => denied}).getVerdicts('visitor-1', verification), /403/);
  assert.equal(cancelled, true);
  cancelled = false;
  let release;
  const late = new Response(new ReadableStream({cancel() { cancelled = true; }}));
  const api = client(null, {timeoutMs: 10, transport: () => new Promise((resolve) => { release = () => resolve(late); })});
  await assert.rejects(api.getVerdicts('visitor-1', verification), /timed out/);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('arguments reject before network and cached block exemption cannot enter a fresh public check', async () => {
  const api = client(null, {transport: async () => assert.fail('must not call')});
  for (const value of ['', 'visitor\n', 'x'.repeat(129)]) {
    await assert.rejects(api.getVerdicts(value, verification));
  }
  for (const baseUrl of ['http://api.example', 'https:api.example', 'https://api.example/path']) {
    assert.throws(() => client(null, {baseUrl}));
  }
  assert.throws(() => client(null, {publicKey: ''}));
  assert.throws(() => client(null, {timeoutMs: 0}));
  const old = proof({verdict: 'block', timestamp: now / 1000 - 301});
  await assert.rejects(client(old).getVerdicts('visitor-1', {...verification, allowExpiredBlock: true}), /expired/);
  assert.equal((await verifySignedResponse(old, {...verification, nowMs: now, allowExpiredBlock: true}, 'verdict')).verdict, 'block');
});
