import { ApiError, GuardError, isRecord, requireString } from './errors.js';
import { mutateRecord, recordKey, type GuardStore, type StoredRecord } from './store.js';

export class CircuitOpenError extends ApiError {
  constructor(public readonly retryAt: number) {
    super('HideGuard verdict service is temporarily unavailable.');
    this.name = 'CircuitOpenError';
  }
}

export interface SharedCircuitBreakerOptions {
  store: GuardStore;
  /** Trusted tenant/application namespace, shared by every worker for this tenant. */
  scopeId: string;
  failureThreshold?: number;
  failureWindowMs?: number;
  openMs?: number;
  probeLeaseMs?: number;
  now?: () => number;
}

interface CircuitState {
  generation: string;
  failures: number;
  windowStart: number;
  openUntil: number;
  probeToken: string | null;
  probeUntil: number;
}
interface Permit { generation: string; probeToken: string | null; }

function decode(record: StoredRecord): CircuitState {
  const value = record.value;
  if (!isRecord(value) || typeof value.generation !== 'string' || !value.generation ||
      !(value.probeToken === null || (typeof value.probeToken === 'string' && value.probeToken.length > 0)) ||
      !['failures', 'windowStart', 'openUntil', 'probeUntil'].every((field) =>
        Number.isSafeInteger(value[field]) && Number(value[field]) >= 0)) {
    throw new GuardError('storage', 'Stored circuit state is invalid.');
  }
  if ((value.openUntil === 0 && value.probeToken !== null) ||
      (value.probeToken === null && value.probeUntil !== 0) ||
      (value.probeToken !== null && value.probeUntil === 0)) {
    throw new GuardError('storage', 'Stored circuit state is invalid.');
  }
  return value as unknown as CircuitState;
}

/** Shared CAS state, never an Allow cache. The operation must have a deadline shorter than the probe lease. */
export class SharedCircuitBreaker {
  readonly probeLeaseMs: number;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private readonly store: GuardStore;
  private readonly scopeId: string;

  constructor(options: SharedCircuitBreakerOptions) {
    this.store = options.store;
    this.scopeId = requireString(options.scopeId, 'scopeId');
    this.threshold = options.failureThreshold ?? 5;
    this.windowMs = options.failureWindowMs ?? 60000;
    this.openMs = options.openMs ?? 30000;
    this.probeLeaseMs = options.probeLeaseMs ?? 15000;
    this.now = options.now ?? Date.now;
    for (const value of [this.threshold, this.windowMs, this.openMs, this.probeLeaseMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
        throw new GuardError('configuration', 'Circuit limits must be positive bounded integers.');
      }
    }
  }

  private stored(state: CircuitState, now: number) {
    // Retain every open/probe/window state. An expired generation can never be recreated by a late result.
    return { value: state, expiresAt: now + this.windowMs + this.openMs + this.probeLeaseMs };
  }

  async execute<T>(partition: string, operation: () => Promise<T>): Promise<T> {
    requireString(partition, 'circuit partition', 1024);
    const key = await recordKey('circuit', this.scopeId, partition);
    let permit!: Permit;
    await mutateRecord(this.store, key, (record) => {
      const now = this.now();
      const state: CircuitState = record && record.expiresAt > now ? decode(record) : {
        generation: crypto.randomUUID(), failures: 0, windowStart: now, openUntil: 0, probeToken: null, probeUntil: 0,
      };
      if (state.openUntil > now) throw new CircuitOpenError(state.openUntil);
      if (state.openUntil !== 0) {
        if (state.probeUntil > now) throw new CircuitOpenError(state.probeUntil);
        const next = { ...state, generation: crypto.randomUUID(), probeToken: crypto.randomUUID(),
          probeUntil: now + this.probeLeaseMs };
        permit = { generation: next.generation, probeToken: next.probeToken };
        return this.stored(next, now);
      }
      permit = { generation: state.generation, probeToken: null };
      return record && record.expiresAt > now ? null : this.stored(state, now);
    });

    let result: T;
    try {
      result = await operation();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // HTTP 4xx/redirects establish reachability but still deny this verdict request.
      const status = error.statusCode;
      const failure = status === null || status === 429 || status >= 500 || (status >= 200 && status < 300);
      await this.settle(key, permit, failure);
      throw error;
    }
    await this.settle(key, permit, false);
    return result;
  }

  private async settle(key: string, permit: Permit, failed: boolean): Promise<void> {
    await mutateRecord(this.store, key, (record) => {
      const now = this.now();
      if (!record || record.expiresAt <= now) return null;
      const state = decode(record);
      if (state.generation !== permit.generation || state.probeToken !== permit.probeToken ||
          (permit.probeToken !== null && state.probeUntil <= now)) return null;
      if (!failed) {
        if (state.failures === 0 && state.openUntil === 0) return null;
        return this.stored({ generation: crypto.randomUUID(), failures: 0, windowStart: now,
          openUntil: 0, probeToken: null, probeUntil: 0 }, now);
      }
      const failures = state.windowStart + this.windowMs > now ? state.failures + 1 : 1;
      const windowStart = state.windowStart + this.windowMs > now ? state.windowStart : now;
      const open = permit.probeToken !== null || failures >= this.threshold;
      return this.stored({ generation: open ? crypto.randomUUID() : state.generation,
        failures: open ? 0 : failures, windowStart, openUntil: open ? now + this.openMs : 0,
        probeToken: null, probeUntil: 0 }, now);
    });
  }
}
