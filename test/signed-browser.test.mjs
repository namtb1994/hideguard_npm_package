import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAccessRuntime, parseBrowserConfiguration } from '../dist/browser/index.js';
import { policy, signedPayload } from './support.mjs';

const config = () => ({ ...policy(), protectedPoints: ['all_pages'], protectedPaths: [] });
const proof = (changes = {}) => signedPayload(changes, Date.now());
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  assert.fail('Expected state was not reached.');
}
function browser(t, collect = async () => proof(), extra = {}) {
  const dom = new JSDOM('<head></head><body><main><button>Buy</button></main></body>', { url: 'https://store.example' });
  const originals = new Map();
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLScriptElement', 'MutationObserver', 'CustomEvent', 'sessionStorage']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  const sdk = document.createElement('script'); sdk.id = 'hideguard-sdk'; sdk.dataset.endpoint = config().endpointUrl;
  sdk.dataset.siteKey = config().publicKey; sdk.dataset.hideguardLoad = 'loaded'; document.head.append(sdk);
  dom.window.FingerprintCollector = { collect };
  const pending = deferred(); const requests = []; let grants = 0;
  const runtime = createAccessRuntime({ mode: 'signed', initialConfiguration: config(),
    request: async (operation, body) => { requests.push({ operation, body }); return pending.promise; },
    onAllowed: async () => { grants++; }, ...extra });
  t.after(() => {
    runtime.destroy(); dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { runtime, pending, requests, dom, grants: () => grants,
    locked: () => document.querySelector('main').inert === true,
    reply(status = 'allowed') {
      return { configuration: config(), browserToken: 'server-token', serverTime: Date.now(),
        decision: { status, policyRevision: config().revision, verificationId: requests.at(-1)?.body.confirmationId ?? 'inspection',
          verificationUntil: 0, grantedUntil: Date.now() + 300000, blockedUntil: Date.now() + 900000 } };
    } };
}

test('signed allow opens the page before backend completion with exactly one confirm and no local commerce grant', async (t) => {
  const b = browser(t); const started = performance.now();
  await b.runtime.start(); assert.equal(b.locked(), true);
  await until(() => !b.locked());
  assert(performance.now() - started < 500, 'Local verification must not wait for a simulated 5-second backend.');
  assert.deepEqual(b.requests.map((r) => r.operation), ['confirm']);
  assert.equal(b.runtime.getState(), null); assert.equal(b.grants(), 0); assert.equal(await b.runtime.bind(), false);
  b.pending.resolve(b.reply()); await until(() => b.grants() === 1);
  assert.equal(b.runtime.getState().decision.status, 'allowed'); assert.equal(b.locked(), false);
});

test('verification lifecycle callback runs synchronously before collection and again on pause/resume and BFCache', async (t) => {
  let starts = 0;
  const b = browser(t, undefined, { onVerificationStart: () => { starts++; } });
  const starting = b.runtime.start(); assert.equal(starts, 1); await starting;
  await until(() => !b.locked()); assert.equal(starts, 1, 'Local allow is not a new verification');
  b.runtime.pause(); assert.equal(starts, 2);
  await b.runtime.resume(); assert.equal(starts, 3);
  b.dom.window.dispatchEvent(new b.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(starts, 4);
});

test('a forged allow never opens the page or reaches backend confirmation', async (t) => {
  const b = browser(t, async () => ({ ...proof(), visitorId: 'tampered' }));
  await b.runtime.start();
  await until(() => document.querySelector('[data-hideguard-root]').shadowRoot.textContent.includes('could not be confirmed'));
  assert.equal(b.locked(), true); assert.equal(b.requests.length, 0); assert.equal(b.runtime.getState(), null);
});

test('backend rejection after valid local allow immediately restores the lock', async (t) => {
  const b = browser(t); await b.runtime.start(); await until(() => !b.locked());
  b.pending.reject(new Error('Backend refused'));
  await until(b.locked); assert.equal(b.runtime.getState(), null); assert.equal(b.grants(), 0);
});

test('confirmation timeout locks again and a late server allow cannot reopen it', async (t) => {
  const b = browser(t, undefined, { confirmationTimeoutMs: 25 });
  await b.runtime.start(); await until(() => !b.locked()); await until(b.locked);
  b.pending.resolve(b.reply()); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(b.locked(), true); assert.equal(b.runtime.getState(), null); assert.equal(b.grants(), 0);
});

test('SDK replies from a paused route cannot approve or confirm the resumed route', async (t) => {
  const first = deferred(), second = deferred(); let collections = 0;
  const b = browser(t, () => (++collections === 1 ? first.promise : second.promise));
  await b.runtime.start(); b.runtime.pause(); await b.runtime.resume();
  first.resolve(proof()); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(b.locked(), true); assert.equal(b.requests.length, 0);
  second.resolve(proof()); await until(() => !b.locked()); assert.equal(b.requests.length, 1);
});

test('pause keeps a late confirm from unlocking; destroying removes its view', async (t) => {
  const b = browser(t); await b.runtime.start(); await until(() => !b.locked());
  b.runtime.pause(); b.pending.resolve(b.reply()); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(b.locked(), true); assert.equal(b.runtime.getState(), null);
  b.runtime.destroy(); assert.equal(document.querySelector('[data-hideguard-root]'), null);
});

test('signed block remains locked and is confirmed to persist the block', async (t) => {
  const b = browser(t, async () => proof({ verdict: 'block' }));
  await b.runtime.start(); await until(() => b.requests.length === 1);
  assert.equal(b.locked(), true); b.pending.resolve(b.reply('blocked'));
  await until(() => b.runtime.getState()?.decision.status === 'blocked'); assert.equal(b.grants(), 0);
});

test('challenge keeps the existing server policy and never receives early local access', async (t) => {
  const b = browser(t, async () => proof({ verdict: 'challenge' }));
  await b.runtime.start(); await until(() => b.requests.length === 1); assert.equal(b.locked(), true);
  b.pending.resolve(b.reply()); await until(() => !b.locked()); assert.equal(b.grants(), 1);
});

test('stale backend configuration and failed resource binding both close local page access', async (t) => {
  const b = browser(t); await b.runtime.start(); await until(() => !b.locked());
  b.pending.resolve({ ...b.reply(), configuration: { ...config(), revision: 'changed' } });
  await until(b.locked); assert.equal(b.runtime.getState(), null);
});

test('resource callback failure cannot leave a backend grant exposed through getState', async (t) => {
  const b = browser(t, undefined, { onAllowed: async () => { throw new Error('Cart owner mismatch'); } });
  await b.runtime.start(); await until(() => !b.locked()); b.pending.resolve(b.reply());
  await until(b.locked); assert.equal(b.runtime.getState(), null);
});

test('disabled and out-of-scope pages do not collect or confirm', async (t) => {
  let collected = 0;
  const b = browser(t, () => { collected++; }, { shouldProtect: () => false });
  await b.runtime.start(); assert.equal(b.locked(), false); assert.equal(collected, 0); assert.equal(b.requests.length, 0);
});

test('BFCache restoration invalidates the prior backend grant and collects afresh', async (t) => {
  let collections = 0;
  const b = browser(t, async () => { collections++; return proof(); });
  await b.runtime.start(); await until(() => !b.locked()); b.pending.resolve(b.reply());
  await until(() => b.runtime.getState()?.decision.status === 'allowed');
  b.dom.window.dispatchEvent(new b.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(b.runtime.getState(), null); assert.equal(b.locked(), true);
  await until(() => collections === 2);
});

test('cross-tab block locks immediately and inspects backend state without a broadcast loop', async (t) => {
  const operations = [];
  const b = browser(t, undefined, { request: async (operation) => {
    operations.push(operation); return operation === 'inspect' ? b.reply('blocked') : b.pending.promise;
  } });
  const other = new BroadcastChannel('hideguard_browser'); t.after(() => other.close());
  let echoed = 0; other.onmessage = () => { echoed++; };
  await b.runtime.start(); await until(() => !b.locked()); b.pending.resolve(b.reply());
  await until(() => b.runtime.getState()?.decision.status === 'allowed');
  other.postMessage('block'); await until(() => b.runtime.getState()?.decision.status === 'blocked');
  assert.equal(b.locked(), true); assert.deepEqual(operations, ['confirm', 'inspect']);
  await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(echoed, 0);
});

test('an expired authentic SDK response cannot open a page or reach confirmation', async (t) => {
  const b = browser(t, async () => signedPayload({}, Date.now() - 301000));
  await b.runtime.start();
  await until(() => document.querySelector('[data-hideguard-root]').shadowRoot.textContent.includes('could not be confirmed'));
  assert.equal(b.locked(), true); assert.equal(b.requests.length, 0);
});

test('public browser configuration rejects private keys, invalid policy and malformed path rules', () => {
  assert.equal(parseBrowserConfiguration(config()).revision, config().revision);
  for (const changed of [{ signaturePublicKey: 'PRIVATE KEY' }, { environment: 'other' }, { recheckSeconds: 1 },
    { endpointUrl: 'http://unsafe.example' }, { protectedPoints: ['login'] }, { protectedPaths: ['/cart?x=1'] }]) {
    assert.throws(() => parseBrowserConfiguration({ ...config(), ...changed }));
  }
});
