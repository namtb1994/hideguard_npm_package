import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAccessRuntime } from '../dist/browser/index.js';

function browser(t, collect = () => Promise.resolve()) {
  const dom = new JSDOM('<html><head></head><body><main id="page"><button>Purchase</button></main><aside id="existing"></aside></body></html>', { url: 'https://store.example/product-page/test' });
  const originals = new Map();
  const runtimes = [];
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLScriptElement', 'MutationObserver', 'CustomEvent', 'sessionStorage']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  dom.window.document.getElementById('existing').inert = true;
  const sdk = dom.window.document.createElement('script'); sdk.id = 'hideguard-sdk'; sdk.dataset.endpoint = 'https://hideguard.io'; sdk.dataset.siteKey = 'public-key';
  dom.window.document.head.append(sdk); dom.window.FingerprintCollector = { collect };
  t.after(() => {
    for (const runtime of runtimes) runtime.destroy();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return { window: dom.window, track: (runtime) => runtimes.push(runtime) };
}
function reply(status = 'verification_required', remaining = 35000) {
  const now = Date.now();
  return { decision: { status, verificationId: 'attempt-1', verificationUntil: now + remaining, grantedUntil: now + 300000, blockedUntil: now + 3600000, policyRevision: 'r-1' },
    configuration: { enabled: true, endpointUrl: 'https://hideguard.io', publicKey: 'public-key', environment: 'production', revision: 'r-1', protectedPoints: ['product'], protectedPaths: [] },
    browserToken: 'browser-token', serverTime: now };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('browser remains inert until the backend accepts a report; existing inert attributes are retained', async (t) => {
  let collections = 0;
  const { window, track } = browser(t, () => { collections++; });
  const requests = [];
  const runtime = createAccessRuntime({ request: async (operation) => { requests.push(operation); return reply(operation === 'report' ? 'allowed' : 'verification_required'); } });
  track(runtime);
  await runtime.start();
  assert.equal(document.getElementById('page').inert, true);
  assert.equal(collections, 1);
  window.dispatchEvent(new window.CustomEvent('fpc:verdict', { detail: { verdict: 'allow' } }));
  await settle();
  assert.equal(document.getElementById('page').inert, false);
  assert.equal(document.getElementById('existing').inert, true);
  assert.deepEqual(requests, ['preflight', 'report']);
});

test('active server blocks do not collect SDK data', async (t) => {
  let collections = 0;
  const { track } = browser(t, () => { collections++; });
  const runtime = createAccessRuntime({ request: async () => reply('blocked') });
  track(runtime);
  await runtime.start();
  assert.equal(collections, 0);
  assert.equal(document.getElementById('page').inert, true);
  assert.match(document.querySelector('[data-hideguard-root]').shadowRoot.textContent, /Access is blocked/);
});

test('SDK errors notify the backend, retain the lock and require explicit retry', async (t) => {
  const { track } = browser(t, () => Promise.reject(new Error('network')));
  const requests = [];
  const runtime = createAccessRuntime({ request: async (operation) => { requests.push(operation); return reply(); } });
  track(runtime);
  await runtime.start(); await settle();
  assert.deepEqual(requests, ['preflight', 'fail']);
  assert.equal(document.getElementById('page').inert, true);
  assert.equal(document.querySelector('[data-hideguard-root]').shadowRoot.querySelector('button').hidden, false);
});

test('rejected/unsigned browser reports never unlock without backend approval', async (t) => {
  const { window, track } = browser(t);
  const runtime = createAccessRuntime({ request: async (operation) => { if (operation === 'report') throw new Error('invalid signature'); return reply(); } });
  track(runtime);
  await runtime.start();
  window.dispatchEvent(new window.CustomEvent('fpc:verdict', { detail: { verdict: 'allow' } }));
  await settle();
  assert.equal(document.getElementById('page').inert, true);
});

test('a failed purchase binding displays an error and keeps the page locked', async (t) => {
  const { track } = browser(t);
  const runtime = createAccessRuntime({ request: async () => reply('allowed'), onAllowed: async () => { throw new Error('ownership mismatch'); } });
  track(runtime);
  await runtime.start();
  assert.equal(document.getElementById('page').inert, true);
  assert.match(document.querySelector('[data-hideguard-root]').shadowRoot.textContent, /purchase flow could not be verified/);
});

test('a destroyed runtime cannot restore its lock after a late binding failure', async (t) => {
  const { track } = browser(t);
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const runtime = createAccessRuntime({ request: async () => reply('allowed'), onAllowed: () => pending });
  track(runtime);
  const starting = runtime.start();
  await settle();
  assert.equal(document.getElementById('page').inert, true);
  runtime.destroy(); reject(new Error('Late failure'));
  await starting;
  assert.equal(document.querySelector('[data-hideguard-root]'), null);
  assert.equal(document.getElementById('page').inert, false);
});

test('the page is locked before a slow preflight and remains locked while a report is pending', async (t) => {
  const { window, track } = browser(t);
  let resolvePreflight, resolveReport;
  const preflight = new Promise((resolve) => { resolvePreflight = resolve; });
  const report = new Promise((resolve) => { resolveReport = resolve; });
  const runtime = createAccessRuntime({ request: (operation) => operation === 'report' ? report : preflight });
  track(runtime);
  const starting = runtime.start();
  assert.equal(document.getElementById('page').inert, true);
  resolvePreflight(reply()); await starting;
  window.dispatchEvent(new window.CustomEvent('fpc:verdict', { detail: { verdict: 'allow' } }));
  await settle();
  assert.equal(document.getElementById('page').inert, true);
  resolveReport(reply('allowed')); await settle();
  assert.equal(document.getElementById('page').inert, false);
});

test('server verification lifecycle callback locks controls before preflight and navigation suspension', async (t) => {
  const { track } = browser(t);
  let starts = 0;
  const runtime = createAccessRuntime({ onVerificationStart: () => { starts++; }, request: async () => {
    assert(starts > 0); return reply('allowed');
  } });
  track(runtime);
  const starting = runtime.start(); assert.equal(starts, 1); await starting;
  runtime.pause(); assert.equal(starts, 2);
  await runtime.resume(); assert.equal(starts, 3);
});

test('server configuration releases pages outside protection without SDK collection or purchase binding', async (t) => {
  let collections = 0, bindings = 0;
  const { track } = browser(t, () => { collections++; });
  const runtime = createAccessRuntime({ request: async () => reply(), shouldProtect: () => false,
    onAllowed: async () => { bindings++; } });
  track(runtime);
  await runtime.start();
  assert.equal(document.getElementById('page').inert, false);
  assert.equal(collections, 0); assert.equal(bindings, 0);
});

test('pausing navigation invalidates a late preflight and resume requires a new backend check', async (t) => {
  const { track } = browser(t);
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  let calls = 0;
  const runtime = createAccessRuntime({ request: async () => { calls++; return calls === 1 ? pending : reply('allowed'); } });
  track(runtime);
  const starting = runtime.start(); runtime.pause();
  resolve(reply('allowed')); await starting;
  assert.equal(document.getElementById('page').inert, true);
  assert.equal(await runtime.bind(), false); assert.equal(calls, 1);
  await runtime.resume();
  assert.equal(calls, 2); assert.equal(document.getElementById('page').inert, false);
});

test('a report arriving during navigation cannot unlock the destination page', async (t) => {
  const { window, track } = browser(t);
  let resolve;
  const report = new Promise((done) => { resolve = done; });
  let preflights = 0;
  const runtime = createAccessRuntime({ request: async (operation) => operation === 'report' ? report : reply(++preflights === 1 ? 'verification_required' : 'allowed') });
  track(runtime); await runtime.start();
  window.dispatchEvent(new window.CustomEvent('fpc:verdict', { detail: { verdict: 'allow' } }));
  runtime.pause(); resolve(reply('allowed')); await settle();
  assert.equal(document.getElementById('page').inert, true);
  await runtime.resume();
  assert.equal(preflights, 2); assert.equal(document.getElementById('page').inert, false);
});

test('a paused page restored from back-forward cache verifies again before unlocking', async (t) => {
  const { window, track } = browser(t);
  let calls = 0;
  const runtime = createAccessRuntime({ request: async () => { calls++; return reply('allowed'); } });
  track(runtime); await runtime.start(); runtime.pause();
  const event = new window.Event('pageshow'); Object.defineProperty(event, 'persisted', { value: true });
  window.dispatchEvent(event); await settle();
  assert.equal(calls, 2); assert.equal(document.getElementById('page').inert, false);
});

for (const action of ['pause', 'destroy']) test(`a late bind failure cannot replace the ${action} lifecycle state`, async (t) => {
  const { track } = browser(t);
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const runtime = createAccessRuntime({ request: async (operation) => operation === 'bind' ? pending : reply('allowed') });
  track(runtime); await runtime.start();
  const binding = runtime.bind(); runtime[action](); reject(new Error('Late bind failure'));
  assert.equal(await binding, false);
  if (action === 'destroy') {
    assert.equal(document.querySelector('[data-hideguard-root]'), null);
    assert.equal(document.getElementById('page').inert, false);
  } else {
    assert.equal(document.getElementById('page').inert, true);
    assert.match(document.querySelector('[data-hideguard-root]').shadowRoot.textContent, /Verifying access/);
  }
});
