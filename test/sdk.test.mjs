import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { collectSdk } from '../dist/browser/sdk.js';

const configuration = { endpointUrl: 'https://hideguard.io', publicKey: 'pk' };
function browser(t, status = 'loading') {
  const dom = new JSDOM('<head></head><body></body>', { url: 'https://store.example' });
  const originals = new Map();
  for (const key of ['window', 'document', 'HTMLScriptElement', 'sessionStorage']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  const script = document.createElement('script');
  script.id = 'hideguard-sdk'; script.dataset.endpoint = configuration.endpointUrl;
  script.dataset.siteKey = configuration.publicKey; script.dataset.hideguardLoad = status;
  document.head.append(script);
  t.after(() => {
    dom.window.close();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { script, window: dom.window };
}

test('runtime waits for the HEAD SDK already loading, without appending a duplicate or collecting early', async (t) => {
  const { script, window } = browser(t);
  let collections = 0;
  const pending = collectSdk(configuration);
  await Promise.resolve();
  assert.equal(collections, 0); assert.equal(document.querySelectorAll('#hideguard-sdk').length, 1);
  window.FingerprintCollector = { collect() { collections++; } };
  script.dispatchEvent(new window.Event('load'));
  await pending;
  assert.equal(collections, 1);
});

test('runtime reuses a HEAD SDK whose load event has already fired', async (t) => {
  const { window } = browser(t, 'loaded');
  let collections = 0;
  window.FingerprintCollector = { collect() { collections++; } };
  await collectSdk(configuration);
  assert.equal(collections, 1); assert.equal(document.querySelectorAll('#hideguard-sdk').length, 1);
});

test('a HEAD SDK load failure rejects; a later retry can load one replacement', async (t) => {
  const { script, window } = browser(t);
  const failed = assert.rejects(collectSdk(configuration), /could not be loaded/);
  script.dispatchEvent(new window.Event('error'));
  await failed; assert.equal(document.getElementById('hideguard-sdk'), null);
  const retry = collectSdk(configuration);
  const replacement = document.getElementById('hideguard-sdk');
  assert(replacement); assert.notEqual(replacement, script);
  let collections = 0;
  window.FingerprintCollector = { collect() { collections++; } };
  replacement.dispatchEvent(new window.Event('load'));
  await retry; assert.equal(collections, 1);
});

test('a stalled HEAD SDK load is bounded instead of leaving initialization pending forever', async (t) => {
  browser(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failed = assert.rejects(collectSdk(configuration), /load timed out/);
  t.mock.timers.tick(12000);
  await failed; assert.equal(document.getElementById('hideguard-sdk'), null);
});
