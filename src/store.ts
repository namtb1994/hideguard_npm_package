import { GuardError } from './errors.js';

export interface StoredRecord {
  version: number;
  value: unknown;
  expiresAt: number;
}

/** Reads must be strongly consistent; CAS/insert must be atomic across workers. */
export interface GuardStore {
  read(key: string): Promise<StoredRecord | null>;
  insert(key: string, record: StoredRecord): Promise<boolean>;
  replace(key: string, expectedVersion: number, record: StoredRecord): Promise<boolean>;
}

/** Opt-in capability: serializable across all records/absence reads, commits before resolving, rolls back on throw.
 * Do not automatically retry the callback. Every writer must participate in the same coordination protocol.
 */
export interface TransactionalGuardStore extends GuardStore {
  transaction<T>(operation: (store: GuardStore) => Promise<T>): Promise<T>;
}

type RecordChange = Pick<StoredRecord, 'value' | 'expiresAt'> | null;

export async function recordKey(...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function mutateRecord(
  store: GuardStore,
  key: string,
  // Retried on contention: an async change may read state, but must not publish side effects.
  change: (current: StoredRecord | null) => RecordChange | Promise<RecordChange>,
): Promise<StoredRecord | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await store.read(key);
    const next = await change(current);
    if (next === null) return current;
    const record = { ...next, version: (current?.version ?? 0) + 1 };
    const saved = current ? await store.replace(key, current.version, record) : await store.insert(key, record);
    if (saved) return record;
  }
  throw new GuardError('contention', 'Access state changed concurrently. Please try again.');
}
