import { GuardError, isRecord } from './errors.js';
import type { ProtectionPolicy } from './policy.js';

export interface AccessContext { scopeId: string; browserId: string; actorId: string; }
export interface SessionState {
  status: 'idle' | 'pending' | 'allowed' | 'failed' | 'blocked';
  policyRevision: string;
  actorId: string;
  visitorId: string | null;
  verificationId: string | null;
  verificationUntil: number;
  grantedUntil: number;
  blockedUntil: number;
  blockEpoch: string;
}
export interface AccessDecision {
  status: 'disabled' | 'verification_required' | 'allowed' | 'blocked' | 'verification_failed';
  verificationId: string | null;
  verificationUntil: number;
  grantedUntil: number;
  blockedUntil: number;
  policyRevision: string;
}

export function newSession(context: AccessContext, policy: ProtectionPolicy): SessionState {
  return {
    status: 'idle', policyRevision: policy.revision, actorId: context.actorId, visitorId: null,
    verificationId: null, verificationUntil: 0, grantedUntil: 0, blockedUntil: 0, blockEpoch: policy.blockEpoch,
  };
}

export function parseSession(value: unknown): SessionState {
  if (!isRecord(value) || !['idle', 'pending', 'allowed', 'failed', 'blocked'].includes(String(value.status)) ||
      typeof value.policyRevision !== 'string' || typeof value.actorId !== 'string' ||
      !(value.visitorId === null || typeof value.visitorId === 'string') ||
      !(value.verificationId === null || typeof value.verificationId === 'string') || typeof value.blockEpoch !== 'string' ||
      !['verificationUntil', 'grantedUntil', 'blockedUntil'].every((field) => typeof value[field] === 'number' && Number.isSafeInteger(value[field]) && Number(value[field]) >= 0)) {
    throw new GuardError('storage', 'Stored access state is invalid.');
  }
  // Every field has been checked above; keep storage decoding at this boundary.
  return value as unknown as SessionState;
}

export function decide(state: SessionState, policy: ProtectionPolicy, now: number, identityBlock = 0): AccessDecision {
  const blockedUntil = Math.max(identityBlock, state.blockEpoch === policy.blockEpoch ? state.blockedUntil : 0);
  const current = state.policyRevision === policy.revision;
  const status = !policy.enabled ? 'disabled' : blockedUntil > now ? 'blocked' :
    current && state.status === 'allowed' && state.grantedUntil > now ? 'allowed' :
    current && (state.status === 'failed' || (state.status === 'pending' && state.verificationUntil <= now)) ? 'verification_failed' : 'verification_required';
  return { status, verificationId: current ? state.verificationId : null, verificationUntil: current ? state.verificationUntil : 0,
    grantedUntil: status === 'allowed' ? state.grantedUntil : 0, blockedUntil, policyRevision: policy.revision };
}
