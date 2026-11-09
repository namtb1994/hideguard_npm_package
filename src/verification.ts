import { GuardError, isRecord } from './errors.js';
import {verdictGroupFor, type VerdictGroup} from './verdict-policy.js';
import {protocolToken as token, publicKeyBytes, verifySignedResponse} from './signed-response.js';
import { grantMilliseconds, type ProtectionPolicy } from './policy.js';

export interface VerifiedVerdict {
  visitorId: string;
  /** Normalized policy group; the signature verifier retains the original verdict bytes. */
  verdict: VerdictGroup;
  issuedAt: number;
  score: number;
  reasonCodes: string[];
}

function invalid(): never { throw new GuardError('invalid_verdict', 'HideGuard verdict is invalid.'); }

export function validatePublicKey(pem: string): Uint8Array<ArrayBuffer> {
  try { return publicKeyBytes(pem); } catch { return invalid(); }
}

function fields(payload: unknown): Omit<VerifiedVerdict, 'issuedAt'> {
  if (!isRecord(payload) || !token(payload.visitorId) ||
      typeof payload.score !== 'number' || !Number.isSafeInteger(payload.score) || payload.score < 0 ||
      !Array.isArray(payload.reasons) || payload.reasons.length > 64) return invalid();
  const verdict = verdictGroupFor(payload.verdict);
  if (!verdict) return invalid();
  const reasonCodes = payload.reasons.map((reason: unknown) => {
    if (!isRecord(reason) || !token(reason.code)) return invalid();
    return reason.code;
  });
  return {visitorId: payload.visitorId, verdict, score: payload.score, reasonCodes};
}

export async function verifyCollect(payload: unknown, policy: ProtectionPolicy, now = Date.now()): Promise<VerifiedVerdict> {
  const {verdict, score, reasonCodes} = fields(payload);
  const maximumAge = verdict === 'block' ? Math.min(grantMilliseconds(policy), policy.blockSeconds * 1000) : grantMilliseconds(policy);
  try {
    const verified = await verifySignedResponse(payload, {
      publicKey: policy.signaturePublicKey, environment: policy.environment,
      nowMs: now, maxAgeSeconds: maximumAge / 1000,
    });
    const issuedAt = verified.signedAt * 1000;
    if (issuedAt + maximumAge <= now) return invalid();
    return {visitorId: verified.visitorId, verdict, issuedAt: Math.min(issuedAt, now), score, reasonCodes};
  } catch { return invalid(); }
}

/** Only pass a response obtained directly from the authenticated server-side client. */
export function verifyApiVerdict(payload: unknown, expectedVisitorId: string, now = Date.now()): VerifiedVerdict {
  const { visitorId, verdict, score, reasonCodes } = fields(payload);
  if (visitorId !== expectedVisitorId) return invalid();
  return { visitorId, verdict, issuedAt: now, score, reasonCodes };
}
