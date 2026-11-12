import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultEndpointUrl, normalizeEndpointUrl, ENVIRONMENTS} from '../dist/index.js';
import {defaultEndpointUrl as browserDefault} from '../dist/browser/index.js';

test('mode defaults agree across root/browser without removing protocol compatibility', () => {
  assert.deepEqual(ENVIRONMENTS, ['development', 'staging', 'production']);
  for (const environment of ENVIRONMENTS) {
    const expected = 'https://hideguard.io';
    assert.equal(defaultEndpointUrl(environment), expected);
    assert.equal(browserDefault(environment), expected);
  }
  for (const value of ['testing', 'unknown', '', null]) {
    assert.throws(() => defaultEndpointUrl(value), /environment/);
  }
  assert.equal(defaultEndpointUrl(), 'https://hideguard.io');
  assert.equal(normalizeEndpointUrl('https://custom.example/'), 'https://custom.example');
});


test('private and public clients default to the configured API origin and retain explicit overrides', async () => {
  const {API_BASE_URL, VerdictClient, PublicVerdictClient} = await import('../dist/index.js');
  for (const baseUrl of [undefined, 'https://api-testing.example']) {
    const calls=[];
    const transport=async url=>{calls.push(url);return Response.json({});};
    await new VerdictClient({apiKey:'private-test', ...(baseUrl ? {baseUrl} : {}),transport}).getVerdict('visitor');
    await assert.rejects(new PublicVerdictClient({publicKey:'public-test', ...(baseUrl ? {baseUrl} : {}),transport}).getVerdicts('visitor',{}));
    assert.deepEqual(calls,[`${baseUrl || API_BASE_URL}/api/v1/verdict`,`${baseUrl || API_BASE_URL}/api/v1/verdict-public`]);
  }
});
