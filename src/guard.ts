import { GuardError, ResourceVerificationError, isRecord, requireString } from './errors.js';
import { grantMilliseconds, type ProtectionPolicy } from './policy.js';
import { decide, newSession, parseSession, type AccessContext, type AccessDecision, type SessionState } from './session.js';
import { mutateRecord, recordKey, type GuardStore, type TransactionalGuardStore } from './store.js';
import type { VerifiedVerdict } from './verification.js';

export interface GuardOptions { atomic?: boolean; }

export class Guard {
  private readonly atomic: boolean;
  constructor(private readonly store: GuardStore, private readonly now: () => number = Date.now, options: GuardOptions = {}) {
    this.atomic = options.atomic ?? false;
    if (this.atomic && typeof (store as Partial<TransactionalGuardStore>).transaction !== 'function') {
      throw new GuardError('configuration', 'Atomic Guard requires a transactional store.');
    }
  }

  private atomically<T>(operation: (guard: Guard) => Promise<T>): Promise<T> {
    return (this.store as TransactionalGuardStore).transaction((store) => operation(new Guard(store, this.now)));
  }

  private key(context: AccessContext): Promise<string> {
    return recordKey('session', context.scopeId, context.browserId, context.actorId);
  }

  async session(context: AccessContext): Promise<SessionState | null> {
    if (this.atomic) return this.atomically((guard) => guard.session(context));
    const record = await this.store.read(await this.key(context));
    return record && record.expiresAt > this.now() ? parseSession(record.value) : null;
  }

  private async blockUntil(context: AccessContext, policy: ProtectionPolicy, visitorId: string | null, previousVisitorId: string | null = null): Promise<number> {
    const visitors = [...new Set([visitorId, previousVisitorId].filter((id): id is string => id !== null))];
    const identities = [`actor:${context.actorId}`, ...visitors.map((id) => `visitor:${id}`)];
    const records = await Promise.all(identities.map(async (identity) => this.store.read(await recordKey('block', context.scopeId, policy.blockEpoch, identity))));
    return records.reduce((until, record) => Math.max(until, record?.expiresAt ?? 0), 0);
  }

  async inspect(context: AccessContext, policy: ProtectionPolicy): Promise<AccessDecision> {
    if (this.atomic) return this.atomically((guard) => guard.inspect(context, policy));
    const state = await this.session(context) ?? newSession(context, policy);
    return decide(state, policy, this.now(), await this.blockUntil(context, policy, state.visitorId));
  }

  async preflight(context: AccessContext, policy: ProtectionPolicy, options: { retry?: boolean; action?: boolean } = {}): Promise<AccessDecision> {
    if (this.atomic) return this.atomically((guard) => guard.preflight(context, policy, options));
    if (!policy.enabled) return decide(newSession(context, policy), policy, this.now());
    const existing = await this.inspect(context, policy);
    if (existing.status === 'blocked') return existing;
    const now = this.now();
    // These decisions need no mutation. inspect() has just checked current identity blocks.
    if (existing.status === 'allowed' && policy.recheckSeconds !== 0 && !options.action) return existing;
    if (existing.status === 'verification_failed' && !options.retry && !options.action) return existing;
    if (existing.status === 'verification_required' && existing.verificationId && existing.verificationUntil > now) return existing;
    await mutateRecord(this.store, await this.key(context), (record) => {
      let state = record && record.expiresAt > now ? parseSession(record.value) : newSession(context, policy);
      if (state.policyRevision !== policy.revision) {
        state = { ...newSession(context, policy), visitorId: state.visitorId, blockedUntil: state.blockedUntil, blockEpoch: state.blockEpoch };
      }
      const current = decide(state, policy, now);
      if (current.status === 'blocked' || (state.status === 'pending' && state.verificationUntil > now)) return null;
      if (current.status === 'verification_failed' && !options.retry && !options.action) return null;
      if (current.status === 'allowed' && policy.recheckSeconds !== 0 && !options.action) return null;
      const pending: SessionState = { ...state, status: 'pending', policyRevision: policy.revision, grantedUntil: options.action ? state.grantedUntil : 0,
        verificationId: crypto.randomUUID(), verificationUntil: now + policy.verificationSeconds * 1000 };
      return { value: pending, expiresAt: now + 30 * 86400000 };
    });
    return this.inspect(context, policy);
  }

  async report(context: AccessContext, policy: ProtectionPolicy, verdict: VerifiedVerdict, verificationId: string): Promise<AccessDecision> {
    if (this.atomic) return this.atomically((guard) => guard.report(context, policy, verdict, verificationId));
    requireString(verificationId, 'verificationId');
    let now = this.now();
    let acceptedBlock = 0;
    const stored = await mutateRecord(this.store, await this.key(context), async (record) => {
      now = this.now();
      acceptedBlock = 0;
      if (!record) throw new GuardError('attempt', 'Start an access check first.');
      const state = parseSession(record.value);
      if (state.policyRevision !== policy.revision || state.verificationId !== verificationId || state.status !== 'pending') return null;
      if (state.verificationUntil <= now) return { value: { ...state, status: 'failed', grantedUntil: 0 }, expiresAt: record.expiresAt };
      // Re-read identity blocks on each CAS attempt, including a previous fingerprint.
      const identityBlock = await this.blockUntil(context, policy, verdict.visitorId, state.visitorId);
      now = this.now();
      if (state.verificationUntil <= now) return { value: { ...state, status: 'failed', grantedUntil: 0 }, expiresAt: record.expiresAt };
      const currentBlock = Math.max(identityBlock, state.blockEpoch === policy.blockEpoch ? state.blockedUntil : 0);
      const blockedUntil = currentBlock > now ? currentBlock : verdict.verdict === 'block' ? Math.min(now, verdict.issuedAt) + policy.blockSeconds * 1000 : 0;
      acceptedBlock = blockedUntil;
      const next: SessionState = { ...state, visitorId: verdict.visitorId, blockEpoch: policy.blockEpoch, blockedUntil,
        status: blockedUntil > now ? 'blocked' : 'allowed',
        grantedUntil: blockedUntil > now ? 0 : Math.min(
          Math.min(now, verdict.issuedAt) + grantMilliseconds(policy),
          state.grantedUntil > now ? state.grantedUntil : Number.MAX_SAFE_INTEGER,
        ) };
      return { value: next, expiresAt: record.expiresAt };
    });
    if (acceptedBlock > now && stored) {
      await this.publishBlock(context, policy, verdict.visitorId, acceptedBlock);
      return decide(parseSession(stored.value), policy, now, acceptedBlock);
    }
    return this.inspect(context, policy);
  }

  /** Accept an already verified proof in one request. A browser's local allow is never trusted. */
  async confirm(context: AccessContext, policy: ProtectionPolicy, verdict: VerifiedVerdict, confirmationId: string): Promise<AccessDecision> {
    if (this.atomic) return this.atomically((guard) => guard.confirm(context, policy, verdict, confirmationId));
    requireString(confirmationId, 'confirmationId');
    if (!policy.enabled) return this.inspect(context, policy);
    let acceptedBlock = 0;
    const stored = await mutateRecord(this.store, await this.key(context), async (record) => {
      const state = record && record.expiresAt > this.now() ? parseSession(record.value) : newSession(context, policy);
      const identities = await this.blockUntil(context, policy, verdict.visitorId, state.visitorId);
      const now = this.now();
      const signedUntil = verdict.issuedAt + grantMilliseconds(policy);
      if (signedUntil <= now) throw new GuardError('invalid_verdict', 'The signed verdict expired during confirmation.');
      const currentBlock = Math.max(identities, state.blockEpoch === policy.blockEpoch ? state.blockedUntil : 0);
      acceptedBlock = currentBlock > now ? currentBlock : verdict.verdict === 'block' ? Math.min(now, verdict.issuedAt) + policy.blockSeconds * 1000 : 0;
      const next: SessionState = { ...state, actorId: context.actorId, visitorId: verdict.visitorId, policyRevision: policy.revision,
        blockEpoch: policy.blockEpoch, blockedUntil: acceptedBlock, verificationId: confirmationId, verificationUntil: now + policy.verificationSeconds * 1000,
        status: acceptedBlock > now ? 'blocked' : 'allowed', grantedUntil: acceptedBlock > now ? 0 : signedUntil };
      return { value: next, expiresAt: now + 30 * 86400000 };
    });
    if (acceptedBlock > this.now() && stored) await this.publishBlock(context, policy, verdict.visitorId, acceptedBlock);
    const decision = await this.inspect(context, policy);
    if (decision.status === 'allowed' && decision.verificationId !== confirmationId) throw new GuardError('contention', 'A newer confirmation replaced this one.');
    return decision;
  }

  private async publishBlock(context: AccessContext, policy: ProtectionPolicy, visitorId: string, until: number): Promise<void> {
    for (const identity of [`actor:${context.actorId}`, `visitor:${visitorId}`]) {
      await mutateRecord(this.store, await recordKey('block', context.scopeId, policy.blockEpoch, identity), (current) => {
        if (current && current.expiresAt > this.now()) return null;
        return { value: { blocked: true }, expiresAt: until };
      });
    }
  }

  async fail(context: AccessContext, policy: ProtectionPolicy, verificationId: string): Promise<AccessDecision> {
    if (this.atomic) return this.atomically((guard) => guard.fail(context, policy, verificationId));
    await mutateRecord(this.store, await this.key(context), (record) => {
      if (!record) return null;
      const state = parseSession(record.value);
      if (state.policyRevision !== policy.revision || state.verificationId !== verificationId || state.status !== 'pending') return null;
      return { value: { ...state, status: 'failed', grantedUntil: 0 }, expiresAt: record.expiresAt };
    });
    return this.inspect(context, policy);
  }

  async bindGrant(context: AccessContext, policy: ProtectionPolicy, resourceId: string): Promise<AccessDecision> {
    if (this.atomic) return this.atomically((guard) => guard.bindGrant(context, policy, resourceId));
    requireString(resourceId, 'resourceId');
    const decision = await this.inspect(context, policy);
    if (decision.status !== 'allowed') throw new GuardError('permission', 'Access verification is required.');
    await mutateRecord(this.store, await recordKey('resource', context.scopeId, resourceId), () => ({
      value: { ...context, policyRevision: policy.revision, verificationId: decision.verificationId }, expiresAt: decision.grantedUntil,
    }));
    const current = await this.inspect(context, policy);
    if (current.status !== 'allowed' || current.verificationId !== decision.verificationId) throw new GuardError('permission', 'Access changed while binding this purchase flow.');
    return current;
  }

  async resourceContext(scopeId: string, resourceId: string, actorId: string, policy: ProtectionPolicy): Promise<AccessContext> {
    if (this.atomic) return this.atomically((guard) => guard.resourceContext(scopeId, resourceId, actorId, policy));
    const binding = await this.store.read(await recordKey('resource', scopeId, resourceId));
    const value = binding?.value;
    if (!binding || binding.expiresAt <= this.now() || !isRecord(value) || value.scopeId !== scopeId ||
        value.actorId !== actorId || value.policyRevision !== policy.revision || typeof value.browserId !== 'string') {
      throw new GuardError('permission', 'Verify this purchase flow before continuing.');
    }
    const context = { scopeId, browserId: value.browserId, actorId };
    const decision = await this.inspect(context, policy);
    if (decision.status !== 'allowed' || decision.verificationId !== value.verificationId) throw new GuardError('permission', 'Purchase flow verification has expired.');
    return context;
  }

  async consumeGrant(scopeId: string, resourceId: string): Promise<void> {
    if (this.atomic) return this.atomically((guard) => guard.consumeGrant(scopeId, resourceId));
    await mutateRecord(this.store, await recordKey('resource', scopeId, resourceId), () => ({ value: { consumed: true }, expiresAt: 0 }));
  }

  /** Reserve a bound grant with one CAS, without repeating the page-preflight reads. */
  async beginResourceCheck(scopeId: string, resourceId: string, actorId: string, policy: ProtectionPolicy): Promise<ResourceCheck> {
    if (this.atomic) return this.atomically((guard) => guard.beginResourceCheck(scopeId, resourceId, actorId, policy));
    const bindingKey = await recordKey('resource', scopeId, resourceId);
    const binding = await this.store.read(bindingKey);
    const value = binding?.value;
    if (!binding || binding.expiresAt <= this.now()) throw new ResourceVerificationError('required');
    if (!isRecord(value) || value.scopeId !== scopeId || value.actorId !== actorId || typeof value.browserId !== 'string') {
      throw new GuardError('permission', 'Verify this purchase flow before continuing.');
    }
    if (value.policyRevision !== policy.revision) throw new ResourceVerificationError('required');
    const context = { scopeId, actorId, browserId: value.browserId };
    const sessionKey = await this.key(context);
    const record = await this.store.read(sessionKey);
    if (!record) throw new ResourceVerificationError('required');
    const state = parseSession(record.value);
    const current = decide(state, policy, this.now(), await this.blockUntil(context, policy, state.visitorId));
    if (current.status === 'blocked') throw new ResourceVerificationError('blocked');
    if (current.status === 'verification_failed') throw new ResourceVerificationError('failed');
    if (state.policyRevision === policy.revision && state.status === 'pending') {
      throw new ResourceVerificationError(state.verificationUntil > this.now() ? 'pending' : 'failed');
    }
    if (current.status !== 'allowed' || current.verificationId !== value.verificationId || !state.visitorId) {
      throw new ResourceVerificationError('required');
    }
    const verificationId = crypto.randomUUID();
    const pending: SessionState = { ...state, status: 'pending', verificationId, verificationUntil: this.now() + policy.verificationSeconds * 1000 };
    if (!await this.store.replace(sessionKey, record.version, { ...record, version: record.version + 1, value: pending })) {
      throw new GuardError('contention', 'Another access check is running. Please try again.');
    }
    return { context, visitorId: state.visitorId, verificationId, bindingKey, bindingVersion: binding.version };
  }

  async completeResourceCheck(check: ResourceCheck, policy: ProtectionPolicy, verdict: VerifiedVerdict): Promise<AccessDecision> {
    if (this.atomic) return this.atomically((guard) => guard.completeResourceCheck(check, policy, verdict));
    const { context, verificationId } = check;
    const now = this.now();
    const key = await this.key(context);
    const record = await this.store.read(key);
    if (!record) throw new GuardError('permission', 'Browser verification has expired.');
    const state = parseSession(record.value);
    if (verdict.visitorId !== check.visitorId || state.visitorId !== check.visitorId || state.policyRevision !== policy.revision ||
        state.status !== 'pending' || state.verificationId !== verificationId || state.verificationUntil <= now) {
      throw new GuardError('permission', 'The verification attempt is no longer current.');
    }
    const previousBlock = verdict.verdict === 'block' ? await this.blockUntil(context, policy, state.visitorId) : 0;
    const blockedUntil = previousBlock > now ? previousBlock : verdict.verdict === 'block' ? now + policy.blockSeconds * 1000 : 0;
    const next: SessionState = { ...state, status: blockedUntil > now ? 'blocked' : 'allowed', blockedUntil, blockEpoch: policy.blockEpoch,
      grantedUntil: blockedUntil > now ? 0 : Math.min(now + grantMilliseconds(policy), state.grantedUntil) };
    if (!await this.store.replace(key, record.version, { ...record, version: record.version + 1, value: next })) {
      throw new GuardError('contention', 'Access changed during verification. Please try again.');
    }
    if (blockedUntil > now) {
      await this.publishBlock(context, policy, check.visitorId, blockedUntil);
      return decide(next, policy, now);
    }
    const bound = await this.store.replace(check.bindingKey, check.bindingVersion, {
      version: check.bindingVersion + 1, value: { ...context, policyRevision: policy.revision, verificationId }, expiresAt: next.grantedUntil,
    });
    if (!bound) throw new GuardError('contention', 'Purchase flow ownership changed during verification.');
    const decision = await this.inspect(context, policy);
    if (decision.verificationId !== verificationId) throw new GuardError('contention', 'A newer access check has started.');
    return decision;
  }
}

export interface ResourceCheck {
  context: AccessContext;
  visitorId: string;
  verificationId: string;
  bindingKey: string;
  bindingVersion: number;
}
