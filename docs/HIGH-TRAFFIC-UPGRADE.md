# Optional backend capabilities — 0.8.0

Runtime remains ESM, Node 22+ or compatible Web Crypto/fetch runtime, with no production dependencies.
Existing `new Guard(store, clock)` and `new VerdictClient(options)` behave as before. Features below are root-only;
the browser entry does not export server clients, stores, circuits or cleanup. No existing record/signature schema changes.

## Shared circuit breaker

```ts
import {SharedCircuitBreaker, VerdictClient, CircuitOpenError} from '@hachitechs/hideguard';

const circuit = new SharedCircuitBreaker({
  store: sharedCasStore, // trusted backend storage, atomic across every worker
  scopeId: trustedTenantId,
  failureThreshold: 5,
  failureWindowMs: 60000,
  openMs: 30000,
  probeLeaseMs: 15000, // must exceed VerdictClient's complete HTTP/body deadline
});
const client = new VerdictClient({
  baseUrl: configuredEndpoint,
  apiKey: serverApiKey,
  timeoutMs: 5000,
  circuitBreaker: circuit,
});
// Caller still obtains trusted visitor state, verifies the fresh private reply and completes Guard.
// CircuitOpenError is a refusal, never permission to use a previous Allow.
```

Client automatically partitions by tenant scope, normalized private-verdict endpoint and SHA-256-hashed credential.
Neither raw key, visitor, body nor endpoint is put in circuit records or error messages. Rotating a key isolates its circuit;
do not rotate credentials to bypass a failed service. Use a consistent tenant namespace on every worker.
Circuit records use the supplied GuardStore; adapters may use a separate privileged collection with the same contract.
Do not implement cross-worker state using module globals, process-local caches or a memory store in production.

Timeout/network errors, HTTP 429/5xx and malformed/oversized successful HTTP replies count as failures.
Other HTTP 3xx/4xx establish reachability and reset the failure sequence, but still throw ApiError and deny the request.
After the threshold within the failure window, requests are refused until cooldown; one CAS-leased half-open probe may run.
A failed probe reopens; a reachable/successful probe closes. Lease expiry permits a replacement probe after a crashed worker.
Generation/token checks keep late outcomes from changing a newer circuit state. Threshold is not a concurrent in-flight cap:
already admitted requests can still finish; use a platform admission/bulkhead adapter separately if measurements require one.
Workers must use comparable trusted clocks; allow for clock skew and scheduling delay in lease settings. Storage calls also
need finite adapter deadlines: VerdictClient's timeout bounds the HTTP/body operation, not time waiting on circuit storage.

`execute(partition, operation)` is also available for trusted backend adapters. Supply an opaque service partition and a bounded
operation whose deadline is shorter than `probeLeaseMs`. ApiError classifies upstream failures; other thrown errors are propagated.
No retries, response reuse, HTTP redirect following or logging is introduced. The private client explicitly requests no-store
and omits ambient credentials; the server API key remains in its explicit header.

Healthy circuit traffic costs **two additional state reads per verdict request**, with no writes while its healthy state remains
unexpired. State retention is failureWindowMs + openMs + probeLeaseMs (105 seconds by default); after expiry, initialization
adds a write even if the service stayed healthy. The 100-call zero-write fixture fits inside that retention window.
Failure settlement adds a CAS write; initialization/probe acquisition can add another write. Open refusal costs one read.
Contention can add bounded CAS retries (maximum eight attempts), and storage failure refuses the request.
**Recount the complete handler's platform subrequests before enabling**, including auth, config, Secrets, diagnostics and retries.
Do not enable automatically on Wix's existing 16/14-operation budgets. Default-disabled private clients add no circuit I/O.
This feature reduces outage HTTP calls; it does not claim lower healthy-request latency or production throughput.

## Serializable Guard operations

```ts
import {Guard, type TransactionalGuardStore} from '@hachitechs/hideguard';

const store: TransactionalGuardStore = yourNativeTransactionalAdapter;
const guard = new Guard(store, Date.now, {atomic: true});
const check = await guard.beginResourceCheck(tenant, resource, actor, policy);
// Outside any Guard transaction: perform exactly one fresh authenticated HTTP verdict request.
const verdict = await getAndVerifyPrivateVerdict(check.visitorId);
const decision = await guard.completeResourceCheck(check, policy, verdict);
// Proceed only for allowed; on transport/verification error call fail() and refuse the business action.
```

The optional capability is:

```ts
interface TransactionalGuardStore extends GuardStore {
  transaction<T>(operation: (transactionStore: GuardStore) => Promise<T>): Promise<T>;
}
```

Each public Guard operation runs within one serializable transaction. The supplied view must include all session, binding and
block-ledger records touched, including reads of absent records. Commit must finish before resolving; exceptions must roll back
all writes. Do not automatically retry callbacks or perform external HTTP/business side effects inside them. Bound lock waits,
choose the native lock order/coordination and handle database errors in the adapter. A mutex in one worker is insufficient.
Guard validates that the capability exists, not the database's correctness: native contract/concurrency tests remain mandatory.

This prevents partial Guard publication within an operation when a later write fails. It does not make the surrounding commerce
operation exactly-once, hold a transaction across HTTP, bind browser signatures to a nonce, or provide a single-use upstream proof.
Business begin and completion remain separate transactions; completion checks attempt, binding version, expiry and current state.
All security writers in that partition must use compatible coordination. Drain old writers before switching, and do not mix
atomic and legacy writers under an unsupported isolation model. Physical cleanup must also obey version/expiry predicates.

Unsupported atomic mode throws a configuration error at construction. Omit the option for existing single-record CAS adapters,
including the current WixStore. No transaction behavior is silently inferred from an SDK's conditional update.

## Bounded cleanup

```ts
import {cleanupExpired, type BatchCleanupStore} from '@hachitechs/hideguard';

const store: BatchCleanupStore = yourTenantScopedMaintenanceAdapter;
const result = await cleanupExpired(store, {limit: 100, timeBudgetMs: 1000, cursor: savedCursor});
// Persist result.nextCursor AND result.hasMore. null + hasMore=true means restart this page.
// Schedule another batch outside the access request; release database locks between batches.
```

`scanExpired({before, limit, cursor})` must return at most limit `{key, version, expiresAt}` records and an opaque `nextCursor`
(null at end). Use a stable keyset cursor, never an offset affected by deletion. Store instances/cursors are tenant/collection
scoped by the adapter. Do not accept arbitrary client-supplied tenant cursors or expose this helper as a public unauthenticated route.
`removeExpired(key, expectedVersion, before)` must atomically check **both version and 0 < expiry < before** and return false
for confirmed contention only. Infrastructure errors must throw. Do not delete a refreshed record or expiry=0 tombstone.
Changing active records must increment version according to the existing GuardStore contract.

The helper validates the complete bounded page, skips unsafe expiry candidates and returns scanned/removed/contended/skipped
counts, continuation and timeBudgetReached. Default limit 100 (1–1000); scheduling budget 1000 ms (1–60000).
The budget stops scheduling new deletes, not a hung native call: adapter must impose its own finite scan/delete I/O deadline.
If time expires mid-page, return the **input** cursor so remaining candidates are re-scanned, never the page end cursor.
After an exception retry that input cursor; prior successful deletes are idempotent. Revisit contended records on a subsequent
full sweep. A scan taking the entire budget may make no progress: report it and tune the maintenance adapter/scheduling,
do not spin indefinitely. No COUNT scan, capacity policy, automatic scheduler or cleanup on the authorization hot path is added.
Wix already has native bounded cleanup; adopting this helper is optional and must justify adapter changes.

## Verification and rollout

```sh
npm ci
npm test
npm run test:integration
npm pack
```

Native integration fixtures use Node 22's SQLite module in tests only (verified with Node 22.23.4), temporary isolated files and
independent processes. They prove the provided test adapter's CAS/transaction/circuit behavior, not Wix Data, Redis, PostgreSQL
or production-site performance. Runtime package does not depend on SQLite. Each platform must test its own native adapter.

First deliver the same verified package artifact/source to the host app, rebuild and test existing callers with features off.
Prepare any native collection/schema/indexes explicitly, then enable only supported capabilities with handler-budget/native
evidence. No public signature protocol, verdict groups, timing policy or mode defaults change. Session-capacity admission,
transactional quota counters, distributed partition locks, nonce protocol and platform cart event coalescing remain separate work.
Rollback with matching app/package/config artifacts, drain incompatible writers and preserve security records; never truncate
blocks/grants/tombstones. Installing a package version in one app does not upgrade another.
