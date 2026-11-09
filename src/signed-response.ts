import {isRecord} from './errors.js';
import {verdictGroupFor, type VerdictGroup} from './verdict-policy.js';
export type {VerdictGroup} from './verdict-policy.js';

export type SignatureKind = 'collect' | 'verdict';
export interface SignatureOptions {
  publicKey: string;
  environment: string;
  nowMs: number;
  maxAgeSeconds: number;
  /** Retain an already accepted block for a separate, bounded local block duration. */
  allowExpiredBlock?: boolean;
  groupFor?: (verdict: unknown) => VerdictGroup | undefined;
}
export interface SignedVerdict {
  verdict: string;
  visitorId: string;
  signedResponse: string;
  signedAt: number;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEADER = /^v=2,alg=ed25519,kid=([A-Za-z0-9][A-Za-z0-9._:-]{0,127}),t=([1-9][0-9]{0,11}),sig=([A-Za-z0-9_-]{86})$/;
const SPKI_PREFIX = [48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 33, 0];
const MAX_ENVELOPE_LENGTH = 12288;
const LABELS = Object.freeze({
  collect: 'hideguard-collect-ed25519-v2',
  verdict: 'hideguard-verdict-ed25519-v2',
});
let importedPem: string | undefined;
let importedKey: Promise<CryptoKey> | undefined;

export function protocolToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.exec(value)?.[0] === value;
}

function signatureHeader(signature: unknown) {
  const match = typeof signature === 'string' && HEADER.exec(signature);
  if (!match || match[0] !== signature) throw new Error('HideGuard signature format is invalid.');
  return {kid: match[1]!, timestamp: Number(match[2]), encoded: match[3]!};
}

function canonicalMessage(reply: Record<string, unknown>, header: ReturnType<typeof signatureHeader>,
  kind: SignatureKind, groupFor: NonNullable<SignatureOptions['groupFor']>) {
  if (typeof kind !== 'string' || !Object.hasOwn(LABELS, kind)) {
    throw new Error('HideGuard signature kind is invalid.');
  }
  if (![reply.siteId, reply.requestId, reply.visitorId].every(protocolToken)
    || !['development', 'staging', 'production'].includes(String(reply.environment))
    || !protocolToken(reply.verdict) || !groupFor(reply.verdict)
    || !Number.isSafeInteger(reply.score) || (reply.score as number) < 0
    || !Array.isArray(reply.reasons) || reply.reasons.length > 64
    || !reply.reasons.every((reason: unknown) => isRecord(reason) && protocolToken(reason.code))) {
    throw new Error('HideGuard signed response fields are invalid.');
  }
  return [
    LABELS[kind], 'alg=ed25519', `kid=${header.kid}`,
    `t=${header.timestamp}`, `site=${reply.siteId}`, `environment=${reply.environment}`,
    `request=${reply.requestId}`, `visitor=${reply.visitorId}`, `verdict=${reply.verdict}`,
    `score=${reply.score}`, `reasons=${JSON.stringify(reply.reasons.map((reason: Record<string, unknown>) => reason.code))}`,
  ].join('\n');
}

function decodeSignature(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '==');
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const canonical = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (bytes.length !== 64 || canonical !== encoded) throw new Error('HideGuard signature encoding is invalid.');
  return bytes;
}

export function publicKeyBytes(pem: string): Uint8Array<ArrayBuffer> {
  const match = /^-----BEGIN PUBLIC KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PUBLIC KEY-----$/.exec(pem.trim());
  if (!match) throw new Error('Signature public key must be an Ed25519 PEM public key.');
  const encoded = match[1]!.replace(/\s/g, '');
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (btoa(binary) !== encoded || bytes.length !== 44
    || SPKI_PREFIX.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('Signature public key must be an Ed25519 PEM public key.');
  }
  return bytes;
}

function publicKey(pem: string): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error('This runtime cannot verify HideGuard signatures.');
  if (pem !== importedPem || !importedKey) {
    const bytes = publicKeyBytes(pem);
    importedPem = pem;
    importedKey = crypto.subtle.importKey('spki', bytes, {name: 'Ed25519'}, false, ['verify']);
  }
  return importedKey;
}

/** Verify one fixed protocol kind. Never retry a failed signature with another kind. */
export async function verifySignedResponse(payload: unknown, options: SignatureOptions,
  kind: SignatureKind = 'collect'): Promise<SignedVerdict> {
  if (!Number.isFinite(options.nowMs) || !Number.isSafeInteger(options.maxAgeSeconds)
    || options.maxAgeSeconds < 1) throw new Error('HideGuard verification timing is invalid.');
  if (!isRecord(payload)) throw new Error('HideGuard signature format is invalid.');
  const signature = payload.signature;
  const header = signatureHeader(signature);
  // Snapshot signed fields before the first asynchronous operation.
  const reasons = payload.reasons;
  if (!Array.isArray(reasons) || reasons.length > 64) throw new Error('HideGuard reason codes are invalid.');
  const reply = {
    signature, siteId: payload.siteId, environment: payload.environment,
    requestId: payload.requestId, visitorId: payload.visitorId, verdict: payload.verdict,
    score: payload.score, reasons: reasons.map((reason: unknown) => ({code: isRecord(reason) ? reason.code : undefined})),
  };
  const groupFor = options.groupFor ?? verdictGroupFor;
  const message = canonicalMessage(reply, header, kind, groupFor);
  const envelope = `${signature}\n${message}`;
  if (envelope.length > MAX_ENVELOPE_LENGTH) throw new Error('HideGuard signed response is too large.');
  if (reply.environment !== options.environment) {
    throw new Error('HideGuard response does not match the configured environment.');
  }
  const age = options.nowMs / 1000 - header.timestamp;
  if (age < -30 || (!(options.allowExpiredBlock && groupFor(reply.verdict) === 'block')
    && age > options.maxAgeSeconds)) {
    throw new Error('HideGuard signed response has expired or has a future timestamp.');
  }
  const key = await publicKey(options.publicKey);
  const valid = await crypto.subtle.verify(
    {name: 'Ed25519'}, key, decodeSignature(header.encoded), new TextEncoder().encode(message),
  );
  if (!valid) throw new Error('HideGuard response signature is invalid.');
  return {
    verdict: reply.verdict as string, visitorId: reply.visitorId as string,
    signedResponse: envelope, signedAt: header.timestamp,
  };
}

/** Reuse exact authenticated bytes, selecting the protocol from the signed label. */
export async function verifySignedEnvelope(envelope: string, options: SignatureOptions): Promise<SignedVerdict> {
  if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE_LENGTH) {
    throw new Error('HideGuard signed response is invalid.');
  }
  const [signature, ...lines] = envelope.split('\n');
  const header = signatureHeader(signature);
  const kind = (Object.keys(LABELS) as SignatureKind[]).find((key) => LABELS[key] === lines[0]);
  if (!kind) throw new Error('HideGuard signature label is invalid.');
  const prefixes = [LABELS[kind], 'alg=ed25519', `kid=${header.kid}`,
    `t=${header.timestamp}`, 'site=', 'environment=', 'request=', 'visitor=', 'verdict=', 'score=', 'reasons='];
  if (lines.length !== prefixes.length || prefixes.some((prefix, index) =>
    index < 4 ? lines[index] !== prefix : !lines[index]?.startsWith(prefix))) {
    throw new Error('HideGuard signed response is invalid.');
  }
  const codes: unknown = JSON.parse(lines[10]!.slice(8));
  if (!Array.isArray(codes)) throw new Error('HideGuard reason codes are invalid.');
  const reply = {
    signature, siteId: lines[4]!.slice(5), environment: lines[5]!.slice(12),
    requestId: lines[6]!.slice(8), visitorId: lines[7]!.slice(8), verdict: lines[8]!.slice(8),
    score: Number(lines[9]!.slice(6)), reasons: codes.map((code: unknown) => ({code})),
  };
  if (canonicalMessage(reply, header, kind, options.groupFor ?? verdictGroupFor) !== lines.join('\n')) {
    throw new Error('HideGuard signed response is not canonical.');
  }
  return verifySignedResponse(reply, options, kind);
}
