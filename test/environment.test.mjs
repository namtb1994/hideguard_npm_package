import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultEndpointUrl, normalizeEndpointUrl, ENVIRONMENTS} from '../dist/index.js';
import {defaultEndpointUrl as browserDefault} from '../dist/browser/index.js';

test('mode defaults agree across root/browser without removing protocol compatibility', () => {
  assert.deepEqual(ENVIRONMENTS, ['development', 'staging', 'production']);
  for (const environment of ENVIRONMENTS) {
    const expected = environment === 'production' ? 'https://hideguard.io' : 'https://dev.hideguard.io';
    assert.equal(defaultEndpointUrl(environment), expected);
    assert.equal(browserDefault(environment), expected);
  }
  for (const value of ['testing', 'unknown', '', null, undefined]) {
    assert.throws(() => defaultEndpointUrl(value), /environment/);
  }
  assert.equal(normalizeEndpointUrl('https://custom.example/'), 'https://custom.example');
});
