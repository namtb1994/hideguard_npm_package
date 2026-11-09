import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {generateKeyPairSync, sign} from 'node:crypto';
import * as core from '../dist/index.js';
import * as browser from '../dist/browser/index.js';
import {MemoryStore, policy, context, now} from './support.mjs';

async function packageWithPolicy(t, values) {
  const directory = await mkdtemp(join(tmpdir(), 'hideguard-policy-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await cp(new URL('../dist/', import.meta.url), join(directory, 'dist'), {recursive: true});
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'dist/verdict-policy.json'), JSON.stringify(values));
  return import(pathToFileURL(join(directory, 'dist/index.js')).href);
}

test('core and browser share immutable groups and reject unknown values', () => {
  for (const name of ['BLOCK_VERDICTS', 'CHALLENGE_VERDICTS', 'ALLOW_VERDICTS', 'verdictGroupFor']) {
    assert.equal(core[name], browser[name]);
  }
  for (const [group, name] of [['block', 'BLOCK_VERDICTS'], ['challenge', 'CHALLENGE_VERDICTS'], ['allow', 'ALLOW_VERDICTS']]) {
    assert(Object.isFrozen(core[name]));
    for (const value of core[name]) assert.equal(core.verdictGroupFor(value), group);
  }
  for (const value of ['unknown', 'ALLOW', 'block\n', '', null, undefined, {}, ['allow']]) {
    assert.equal(core.verdictGroupFor(value), undefined);
  }
});

test('one policy edit applies to signed Collect, public Verdict, private API and Guard decisions', async (t) => {
  const changed = {block: ['challenge', 'deny'], challenge: ['review'], allow: ['allow', 'block', 'permit']};
  const api = await packageWithPolicy(t, changed);
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({type: 'spki', format: 'pem'});
  const protection = policy({signaturePublicKey: publicKey});
  const verification = {publicKey, environment: 'production', maxAgeSeconds: 300, nowMs: now};
  function signed(verdict, kind) {
    const payload = {siteId: 'site-1', environment: 'production', requestId: 'request-1',
      visitorId: 'visitor-1', verdict, score: 0, reasons: []};
    const message = [`hideguard-${kind}-ed25519-v2`, 'alg=ed25519', 'kid=key-1', `t=${now / 1000}`,
      'site=site-1', 'environment=production', 'request=request-1', 'visitor=visitor-1',
      `verdict=${verdict}`, 'score=0', 'reasons=[]'].join('\n');
    return {...payload, signature: `v=2,alg=ed25519,kid=key-1,t=${now / 1000},sig=${sign(null, Buffer.from(message), keys.privateKey).toString('base64url')}`};
  }
  for (const [group, values] of Object.entries(changed)) {
    for (const verdict of values) {
      const payload = signed(verdict, 'collect');
      const verified = await api.verifyCollect(payload, protection, now);
      assert.equal(verified.verdict, group, `${verdict} normalizes only after verification`);
      assert.equal(api.verifyApiVerdict(payload, 'visitor-1', now).verdict, group);
      const raw = await api.verifySignedResponse(payload, verification);
      assert.equal(raw.verdict, verdict, 'signed bytes retain the original verdict');
      assert.equal((await api.verifySignedEnvelope(raw.signedResponse, verification)).verdict, verdict);
      await assert.rejects(api.verifyCollect({...payload, score: 1}, protection, now));
      const client = new api.PublicVerdictClient({baseUrl: 'https://hideguard.example', publicKey: 'site-key',
        now: () => now, transport: async () => Response.json(signed(verdict, 'verdict'))});
      assert.equal((await client.getVerdicts('visitor-1', verification))[0].verdict, verdict);
      const guard = new api.Guard(new MemoryStore(), () => now);
      const decision = await guard.confirm(context, protection, verified, 'confirmation-1');
      assert.equal(decision.status, group === 'block' ? 'blocked' : 'allowed');
      const reporting = new api.Guard(new MemoryStore(), () => now);
      const attempt = await reporting.preflight(context, protection);
      assert.equal((await reporting.report(context, protection, verified, attempt.verificationId)).status, decision.status);
      const commerce = new api.Guard(new MemoryStore(), () => now);
      const initial = await api.verifyCollect(signed('allow', 'collect'), protection, now);
      await commerce.confirm(context, protection, initial, 'initial');
      await commerce.bindGrant(context, protection, 'purchase-1');
      const check = await commerce.beginResourceCheck(context.scopeId, 'purchase-1', context.actorId, protection);
      assert.equal((await commerce.completeResourceCheck(check, protection, verified)).status, decision.status);
    }
  }
  await assert.rejects(api.verifyCollect(signed('unknown', 'collect'), protection, now));
  assert.throws(() => api.verifyApiVerdict(signed('unknown', 'collect'), 'visitor-1', now));
});

test('invalid or overlapping group definitions fail before any verdict can grant access', async (t) => {
  for (const values of [
    {block: ['same'], challenge: [], allow: ['same']},
    {block: [], challenge: [], allow: []},
    {block: ['block\n'], challenge: [], allow: ['allow']},
  ]) await assert.rejects(packageWithPolicy(t, values), /Invalid/);
});
