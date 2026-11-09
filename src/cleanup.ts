import { GuardError, requireString } from './errors.js';

export interface ExpiredRecord {
  key: string;
  version: number;
  expiresAt: number;
}
/** Server-only adapter, already scoped to the collection/tenant it may maintain.
 * Scan must use stable keyset cursors (never offsets), and at most limit records.
 * Delete must atomically check BOTH expectedVersion and 0 < expiresAt < before.
 * Adapter owns finite I/O deadlines; no transaction/lock spans a batch.
 */
export interface BatchCleanupStore {
  scanExpired(options: { before: number; limit: number; cursor: string | null }): Promise<{
    records: ExpiredRecord[];
    nextCursor: string | null;
  }>;
  removeExpired(key: string, expectedVersion: number, before: number): Promise<boolean>;
}

export interface CleanupOptions {
  limit?: number;
  timeBudgetMs?: number;
  cursor?: string | null;
  before?: number;
  now?: () => number;
}
export interface CleanupResult {
  scanned: number;
  removed: number;
  contended: number;
  skipped: number;
  nextCursor: string | null;
  hasMore: boolean;
  timeBudgetReached: boolean;
}

/** One bounded batch. On error retry the input cursor; successful deletes are idempotent.
 * A time budget bounds scheduling, not an uncooperative adapter's wall-clock I/O.
 */
export async function cleanupExpired(store: BatchCleanupStore, options: CleanupOptions = {}): Promise<CleanupResult> {
  const limit = options.limit ?? 100;
  const timeBudget = options.timeBudgetMs ?? 1000;
  const now = options.now ?? Date.now;
  const started = now();
  const before = options.before ?? started;
  const cursor = options.cursor ?? null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
      !Number.isSafeInteger(timeBudget) || timeBudget < 1 || timeBudget > 60000 ||
      !Number.isSafeInteger(before) || before < 0 || before > started) {
    throw new GuardError('configuration', 'Cleanup limits and expiry cutoff are invalid.');
  }
  if (cursor !== null) requireString(cursor, 'cleanup cursor', 8192);
  const page = await store.scanExpired({ before, limit, cursor });
  if (!page || !Array.isArray(page.records) || page.records.length > limit ||
      !(page.nextCursor === null || typeof page.nextCursor === 'string') ||
      (page.nextCursor !== null && page.nextCursor === cursor)) {
    throw new GuardError('storage', 'Cleanup adapter returned an invalid page.');
  }
  if (page.nextCursor !== null) requireString(page.nextCursor, 'cleanup cursor', 8192);
  const seen = new Set<string>();
  // Validate the whole bounded page before starting deletes.
  for (const record of page.records) {
    if (!record || typeof record.key !== 'string' || !record.key || seen.has(record.key) ||
        !Number.isSafeInteger(record.version) || record.version < 1 ||
        !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0) {
      throw new GuardError('storage', 'Cleanup adapter returned an invalid record.');
    }
    seen.add(record.key);
  }
  const result: CleanupResult = { scanned: 0, removed: 0, contended: 0, skipped: 0,
    nextCursor: page.nextCursor, hasMore: page.nextCursor !== null, timeBudgetReached: false };
  for (const record of page.records) {
    if (now() - started >= timeBudget) {
      // Re-scan this page, never skip unprocessed records by returning its end cursor.
      return { ...result, nextCursor: cursor, hasMore: true, timeBudgetReached: true };
    }
    result.scanned++;
    if (record.expiresAt === 0 || record.expiresAt >= before) { result.skipped++; continue; }
    if (await store.removeExpired(record.key, record.version, before)) result.removed++;
    else result.contended++;
  }
  return result;
}
