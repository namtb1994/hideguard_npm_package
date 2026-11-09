import test from 'node:test';
import assert from 'node:assert/strict';
import { VerdictClient, ApiError } from '../dist/index.js';

test('default transport preserves the native global fetch receiver required by Workers', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async function (url, init) {
    assert.equal(this, globalThis);
    assert.equal(url, 'https://hideguard.io/api/v1/verdict');
    assert.equal(init.headers['x-api-key'], 'test-key');
    return Response.json({ visitorId: 'v-1', verdict: 'allow' });
  };
  const client = new VerdictClient({ baseUrl: 'https://hideguard.io', apiKey: 'test-key' });
  assert.deepEqual(await client.getVerdict('v-1'), { visitorId: 'v-1', verdict: 'allow' });
});

test('client sends the PHP-compatible request and preserves the complete JSON response', async () => {
  const result = { visitorId: 'v-1', verdict: 'allow', nested: { source: ['api', 1] } };
  const client = new VerdictClient({ baseUrl: 'https://EXAMPLE.com/', apiKey: 'server-secret', transport: async (url, init) => {
    assert.equal(url, 'https://example.com/api/v1/verdict');
    assert.equal(init.headers['x-api-key'], 'server-secret');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, '{"visitorId":"v-1"}');
    return Response.json(result);
  } });
  assert.deepEqual(await client.getVerdict('v-1'), result);
});

test('client rejects HTTP errors, redirects, malformed/scalar/oversized responses without disclosing secrets', async () => {
  for (const response of [new Response('secret error', { status: 403 }), new Response('', { status: 302 }),
    new Response('invalid'), Response.json(null), Response.json(1), Response.json('value'), new Response('x'.repeat(100))]) {
    const client = new VerdictClient({ baseUrl: 'https://hideguard.io', apiKey: 'server-secret', maximumResponseBytes: 50, transport: async () => response });
    await assert.rejects(client.getVerdict('v-1'), (error) => error instanceof ApiError && !error.message.includes('server-secret') && !error.message.includes('secret error'));
  }
});

test('client aborts a hung request', async () => {
  const client = new VerdictClient({ baseUrl: 'https://hideguard.io', apiKey: 'key', timeoutMs: 10,
    transport: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(client.getVerdict('v-1'), /timed out/);
});

test('client validates arguments before network access', async () => {
  for (const baseUrl of ['http://hideguard.io', 'https://hideguard.io/api', 'https://u:p@hideguard.io', 'https://hideguard.io?x=1']) {
    assert.throws(() => new VerdictClient({ baseUrl, apiKey: 'key' }));
  }
  assert.throws(() => new VerdictClient({ baseUrl: 'https://hideguard.io', apiKey: 'bad key' }));
  const client = new VerdictClient({ baseUrl: 'https://hideguard.io', apiKey: 'key', transport: async () => assert.fail('must not call') });
  await assert.rejects(client.getVerdict(''));
  await assert.rejects(client.getVerdict('v\n1'));
  await assert.rejects(client.getVerdict('\uD800'));
});

test('large JSON integers are preserved as strings without changing numbers inside JSON strings', async () => {
  const client = new VerdictClient({ baseUrl: 'https://hideguard.io', apiKey: 'key', transport: async () =>
    new Response('{"large":9007199254740993,"nested":[-9007199254740994],"text":"9007199254740993","score":42}') });
  assert.deepEqual(await client.getVerdict('v-1'), { large: '9007199254740993', nested: ['-9007199254740994'], text: '9007199254740993', score: 42 });
});
