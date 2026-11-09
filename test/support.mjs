import { generateKeyPairSync, sign } from 'node:crypto';
export class MemoryStore {
  records = new Map();
  async read(key) { return structuredClone(this.records.get(key) ?? null); }
  async insert(key, record) {
    if (this.records.has(key)) return false;
    this.records.set(key, structuredClone(record)); return true;
  }
  async replace(key, version, record) {
    if (this.records.get(key)?.version !== version) return false;
    this.records.set(key, structuredClone(record)); return true;
  }
}
const keys = generateKeyPairSync('ed25519');
export const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
export function policy(overrides = {}) {
  return { enabled: true, environment: 'production', endpointUrl: 'https://hideguard.io', publicKey: 'sdk-key',
    signaturePublicKey: publicKey, revision: 'revision-1', blockEpoch: 'epoch-1', recheckSeconds: 300,
    blockSeconds: 3600, verificationSeconds: 35, ...overrides };
}
export const context = { scopeId: 'site-1', browserId: 'browser-1', actorId: 'visitor:wix-1' };
export const now = 1792555200000;
export function signedPayload(overrides = {}, signedAt = now) {
  const reply = { siteId: 'site-1', environment: 'production', requestId: 'request-1', visitorId: 'visitor-1', verdict: 'allow', score: 0, reasons: [], ...overrides };
  const timestamp = String(Math.floor(signedAt / 1000));
  const message = ['hideguard-collect-ed25519-v2','alg=ed25519','kid=key-1',`t=${timestamp}`,`site=${reply.siteId}`,
    `environment=${reply.environment}`,`request=${reply.requestId}`,`visitor=${reply.visitorId}`,`verdict=${reply.verdict}`,
    `score=${reply.score}`,`reasons=${JSON.stringify(reply.reasons.map((reason) => reason.code))}`].join('\n');
  const signature = sign(null, Buffer.from(message), keys.privateKey).toString('base64url');
  return { ...reply, signature: `v=2,alg=ed25519,kid=key-1,t=${timestamp},sig=${signature}` };
}
