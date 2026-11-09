import { GuardError, isRecord } from './errors.js';
import { mutateRecord, recordKey, type GuardStore } from './store.js';

export async function limitRequests(store: GuardStore, scopeId: string, bucket: string, maximum: number, now = Date.now()): Promise<void> {
  await mutateRecord(store, await recordKey('rate', scopeId, bucket), (current) => {
    const count = current && current.expiresAt > now && isRecord(current.value) && typeof current.value.count === 'number' ? current.value.count : 0;
    if (count >= maximum) throw new GuardError('rate_limit', 'Too many access checks. Please try again in a minute.');
    return { value: { count: count + 1 }, expiresAt: count ? current?.expiresAt ?? now + 60000 : now + 60000 };
  });
}

/** One bounded document enforces both limits with two I/O operations in the common case. */
export async function limitAccessRequests(store: GuardStore, scopeId: string, actorId: string, now = Date.now()): Promise<void> {
  const actor = await recordKey(actorId);
  await mutateRecord(store, await recordKey('access-rate', scopeId), (record) => {
    const value = record && record.expiresAt > now && isRecord(record.value) ? record.value : {};
    const total = typeof value.total === 'number' ? value.total : 0;
    const actors = isRecord(value.actors) ? value.actors : {};
    const count = typeof actors[actor] === 'number' ? actors[actor] : 0;
    if (total >= 600 || count >= 60) throw new GuardError('rate_limit', 'Too many access checks. Please try again in a minute.');
    return { value: { total: total + 1, actors: { ...actors, [actor]: count + 1 } }, expiresAt: total ? record?.expiresAt ?? now + 60000 : now + 60000 };
  });
}
