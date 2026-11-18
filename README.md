# HideGuard SDK: Bot Protection and Checkout Guard for JavaScript and TypeScript

[![npm version](https://img.shields.io/npm/v/@hachitechs/hideguard.svg)](https://www.npmjs.com/package/@hachitechs/hideguard)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-success.svg)

**HideGuard SDK** (`@hachitechs/hideguard`) is a framework-independent JavaScript/TypeScript library for [HideGuard](https://hideguard.io/) bot detection. It verifies Ed25519-signed bot verdicts, enforces checkout access control on the server, and locks protected pages in the browser until a visitor is verified.

It powers the **HideGuard Bot & Checkout Guard** Shopify app. It also runs in any Node.js 22+ backend, or in an edge/server runtime that supports Web Crypto Ed25519, `fetch`, and Web Streams.

## Features

- **Signed verdict verification**: Ed25519 protocol v2 signatures for Collect and Verdict responses, with environment, freshness, and visitor checks.
- **Server verdict client**: `VerdictClient` fetches fresh bot verdicts using your private API key, with timeouts and response size limits.
- **Public verdict client**: `PublicVerdictClient` looks up signed verdicts from browsers or edge runtimes using a public site key.
- **Checkout guard lifecycle**: `Guard` handles verification attempts, timed passes, resource (cart/checkout) binding, and per-action rechecks.
- **Browser access runtime**: `createAccessRuntime` locks pages or inline checkout panels until the backend grants access.
- **Shared verdict policy**: one JSON file maps upstream verdicts to the allow, challenge, and block groups.
- **High-traffic options**: a shared circuit breaker, transactional stores, and expired-record cleanup.
- **Lightweight**: ESM-only, TypeScript declarations included, no production dependencies.

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Entry points](#entry-points)
- [Public verdict API](#public-verdict-api)
- [Verdict policy](#verdict-policy)
- [Server checkout guard lifecycle](#server-checkout-guard-lifecycle)
- [Storage contract](#storage-contract)
- [Browser access runtime](#browser-access-runtime)
- [Error handling](#error-handling)
- [API endpoint configuration](#api-endpoint-configuration)
- [High-traffic backend options](#high-traffic-backend-options)
- [Security notes](#security-notes)
- [Development](#development)

## Installation

```sh
npm install @hachitechs/hideguard
```

## Quick start

### Verify a server-side bot verdict

```ts
import { VerdictClient, verifyApiVerdict } from '@hachitechs/hideguard';

const client = new VerdictClient({
  baseUrl: 'https://hideguard.io',
  apiKey: process.env.HIDEGUARD_API_KEY!,
  timeoutMs: 5000,
});

// Read the visitor ID from trusted server state, never directly from a request body.
const payload = await client.getVerdict(trustedVisitorId);
const verdict = verifyApiVerdict(payload, trustedVisitorId);
```

`VerdictClient` sends `POST /api/v1/verdict` with an `x-api-key` header and a JSON `{ visitorId }` body. It rejects redirects, non-2xx responses, invalid or oversized JSON, and timeouts. It never retries automatically and never logs the response or the API key. Integers outside JavaScript's safe range are returned as strings.

### Verify a browser Collect report

```ts
import { verifyCollect } from '@hachitechs/hideguard';

const verified = await verifyCollect(browserResponse, policy);
```

`verifyCollect` requires a valid Ed25519 protocol v2 signature, the public SPKI PEM key, a matching environment, and a fresh timestamp.

> **Never pass a browser-supplied response to `verifyApiVerdict`.** That verifier only accepts responses your authenticated server client fetched itself.

### Protect a page in the browser

```ts
import { createAccessRuntime } from '@hachitechs/hideguard/browser';

const runtime = createAccessRuntime({ request: authenticatedBackendRequest });
await runtime.start();
// On navigation/unmount:
runtime.destroy();
```

## Entry points

The package is ESM-only. Load it with `import` or dynamic `import()`.

| Import path | Use for | Main exports |
| --- | --- | --- |
| `@hachitechs/hideguard` | Server / backend | `VerdictClient`, `verifyApiVerdict`, `verifyCollect`, `Guard`, `PublicVerdictClient`, `verifySignedResponse`, `verifySignedEnvelope`, `SharedCircuitBreaker`, `cleanupExpired`, verdict policy helpers |
| `@hachitechs/hideguard/browser` | Browser / storefront | `createAccessRuntime`, `parseBrowserConfiguration`, `verifyCollect`, `PublicVerdictClient`, `verifySignedResponse`, `verifySignedEnvelope`, `normalizeEndpointUrl`, `defaultEndpointUrl`, `API_BASE_URL`, verdict policy helpers |
| `@hachitechs/hideguard/verdict-policy.json` | Build tools | The shared verdict policy source |

The browser entry leaves out the private `VerdictClient`, `Guard`, stores, circuit breaker, and cleanup helpers. It needs DOM APIs only when you use `createAccessRuntime`.

## Public verdict API

Use `PublicVerdictClient` to fetch signed verdicts with a public site key, for example from a storefront or an edge function.

```ts
import { PublicVerdictClient, verifySignedEnvelope } from '@hachitechs/hideguard/browser';

const client = new PublicVerdictClient({
  baseUrl: 'https://hideguard.io',
  publicKey: sitePublicKey,
  timeoutMs: 8000,
  maximumResponseBytes: 262144,
});

const proofs = await client.getVerdicts(visitorFromVerifiedState, {
  publicKey: signaturePublicKeyPem,
  environment: 'production',
  maxAgeSeconds: 300,
});

// Every reply is verified, including a signed Block; your adapter applies its own policy.
// A rejected reply or a mismatched visitor fails the whole lookup.
await verifySignedEnvelope(proofs[0]!.signedResponse, {
  publicKey: signaturePublicKeyPem,
  environment: 'production',
  maxAgeSeconds: 300,
  nowMs: Date.now(),
});
```

- The client posts `{ visitorId }` to `/api/v1/verdict-public` with an `x-site-key` header. It omits credentials, rejects redirects, bypasses the HTTP cache, never retries, and caps the number of bytes it streams before parsing.
- It accepts either one signed object or a list of 1–32 signed responses. Each reply is checked against the configured signing key, the environment, freshness, and the requested visitor.
- The optional `onVerification` callback receives request/key IDs, the verdict, the environment, the signing time, and the outcome. It never receives keys, signatures, visitor IDs, or raw bodies, and an error inside it cannot change the access decision.
- `verifySignedResponse(payload, options, kind = 'collect')` checks exactly one signature label (`hideguard-collect-ed25519-v2` or `hideguard-verdict-ed25519-v2`). It returns `{ visitorId, verdict, signedAt, signedResponse }`. `verifySignedEnvelope` re-authenticates a stored envelope.
- `SignatureOptions.groupFor` lets a trusted application supply its own verdict-group policy. `allowExpiredBlock` exists only for rechecking a block your adapter already accepted and cached. Public lookups never enable it.

HideGuard ties each site key to its registered domains on the server side. A valid signature does not by itself prove guest, resource, or action binding, single use, or revocation. Your adapter still owns those authorization checks.

## Verdict policy

`src/verdict-policy.json` is the single source of exact, case-sensitive verdict values:

```json
{
  "block": ["block"],
  "challenge": ["challenge"],
  "allow": ["allow"]
}
```

- Both entries export the frozen `BLOCK_VERDICTS`, `CHALLENGE_VERDICTS`, and `ALLOW_VERDICTS` arrays and `verdictGroupFor(value)`. Unknown values return `undefined` and fail verification.
- Values must be valid protocol tokens, unique across groups, with 1–64 values in total. An invalid policy fails before use.
- `verifyCollect` and `verifyApiVerdict` return the normalized group in `VerifiedVerdict.verdict`. The signature/envelope APIs and `PublicVerdictClient` keep the original signed verdict; classify it with `verdictGroupFor`.

Changing a group is an authorization-policy change. Rebuild and redeploy every application that uses the package.

## Server checkout guard lifecycle

Create `new Guard(store)`. Every call takes an authenticated context `{ scopeId, actorId, browserId }` and a `ProtectionPolicy`. Resolve the tenant and actor from your framework's authenticated identity. The opaque browser ID only selects a session; it is never a credential. Keep API keys, the policy, and the signing-key configuration in backend storage.

1. **`preflight(context, policy)`** reuses a timed pass or reserves a verification attempt with a fixed deadline. Pass `{ retry: true }` after a failed attempt.
2. **Verify the SDK report** with `verifyCollect`, then call `report(context, policy, verified, verificationId)`. If verification fails, call `fail` instead.
3. **`bindGrant(context, policy, resourceId)`**: call this only after your platform API confirms the visitor owns the resource.
4. **Before each protected business action**, call `beginResourceCheck`. Then request a fresh server verdict for `check.visitorId`, verify it, and call `completeResourceCheck`. Proceed only when the result is `allowed` and the attempt ID matches. On any transport or verification error, call `fail` and deny the action.
5. **`consumeGrant`** cleans up after a completed purchase. It does not replace validation before the order is placed.

Allow and Challenge both grant access. A Challenge result does not prove that a CAPTCHA was solved. Backend checks do not extend the original pass expiry. In Always mode, every page preflight collects a fresh report, and resource binding uses a bounded 5-minute internal grant.

## Storage contract

Implement `GuardStore` with three methods: `read`, `insert`, and `replace`.

- Reads must be strongly consistent. Insert-if-absent and compare-and-swap by version must be atomic across workers.
- Return `false` only for confirmed contention. Throw on infrastructure errors. The package retries contention at most eight times.
- Records hold hashed keys, session state, resource bindings, block ledgers, and rate counters. Treat them as privileged server state, enforce expiry on reads, and schedule physical cleanup.
- A storage error denies the current operation. A compare-and-swap on a single document is not a transaction across documents. For atomic multi-document updates, see [High-traffic backend options](#high-traffic-backend-options).

## Browser access runtime

Your adapter implements the exported `AccessRequest` contract. Each response returns the server time, the public configuration, a decision, and an opaque browser token. Only that token is stored, in `sessionStorage`.

- `lockPage: false` together with `container` renders an inline checkout panel instead of locking the whole page.
- `onAllowed` binds your platform's current purchase flow once access is granted.
- `onVerificationStart` runs synchronously before every collection, recheck, resume, or BFCache restore. Use it to lock purchase controls. Unlock them only after `onAllowed` has finished.

The UI lock controls browser interaction only. It does not replace backend authorization.

### Signed page mode

Signed mode is opt-in. It approves the page locally from a signed Collect response and then confirms with your backend.

```ts
import { createAccessRuntime, parseBrowserConfiguration } from '@hachitechs/hideguard/browser';

const configuration = parseBrowserConfiguration(publicSettingsFromYourServer);
const runtime = createAccessRuntime({
  mode: 'signed',
  initialConfiguration: configuration,
  request: authenticatedBackendRequest,
  onAllowed: bindYourVerifiedPurchaseFlow,
});
await runtime.start();
// Always destroy on unmount; pause/resume around route transitions.
```

- **Public settings:** `enabled`, `environment`, an HTTPS-origin `endpointUrl`, the SDK `publicKey`, the Ed25519 SPKI PEM `signaturePublicKey`, `revision`, `protectedPoints`, `protectedPaths`, `recheckSeconds`, and `blockSeconds`. These settings are public and must never contain the API key or any secret. `shouldProtect` decides which pages are protected.
- **Local check:** the runtime verifies the signed v2 fields, the environment, and the expiry before opening a page for `allow`. `block` stays locked, and `challenge` waits for the backend. Every start or resume collects a fresh report.
- **Backend confirm:** the adapter receives a single `confirm` operation with `{ browserToken, response, revision, confirmationId }`. The server authenticates the tenant and actor, checks the revision, and calls `verifyCollect(response, policy)` and then `guard.confirm(context, policy, verified, confirmationId)`. Rate-limit this endpoint.
- **Failures:** a backend refusal, a revision change, a signature failure, expiry, a timeout, or a transport error locks the page. The confirmation timeout defaults to 12 seconds (`confirmationTimeoutMs`, 1–35000 ms).

`getState()` stays `null` during local approval. Only backend confirmation exposes an allowed grant and calls `onAllowed`. A page can be approved locally before the backend reports a stored block. If every interaction must wait for the backend's block state, use the default server mode.

## Error handling

- `ApiError`: an API, network, or JSON failure with a sanitized message. `statusCode` holds the HTTP status when one is known.
- `CircuitOpenError`: the shared circuit breaker is open. Treat it as a refusal, never as permission to reuse an earlier Allow.
- `GuardError`: a lifecycle refusal with a `reason`, for example `permission` or `contention`.
- `ResourceVerificationError`: extends `GuardError`. Its `verificationStatus` is `required`, `pending`, `failed`, or `blocked`. You can show a waiting message for `required`/`pending`, but every status still refuses the business action.

## API endpoint configuration

The default API origin is `https://hideguard.io`. It is exported as `API_BASE_URL` and returned by `defaultEndpointUrl()` from both entries. Clients fall back to it when `baseUrl` is omitted, and an explicit HTTPS `baseUrl` always overrides it.

To build against a test API from a source checkout:

```sh
npm run config -- --url-api https://api-testing.example
# Restore production
npm run config -- --url-api https://hideguard.io
```

The `environment` values inside signed responses are protocol fields. They must still match the signing context you expect.

## High-traffic backend options

The root entry also exports `SharedCircuitBreaker`, `CircuitOpenError`, `TransactionalGuardStore`, `BatchCleanupStore`, and `cleanupExpired`. The circuit breaker and atomic Guard transactions are off by default. See the [high-traffic upgrade guide](docs/HIGH-TRAFFIC-UPGRADE.md) for setup, request-budget costs, shared-worker guarantees, transaction and cleanup contracts, and rollout.

The package has no verdict cache and no automatic HTTP retry.

## Security notes

- Keep the API key, the protection policy, and the signing keys on the server.
- Verify every browser report with `verifyCollect` before you pass it to `Guard`. Never treat an unverified browser object as a verdict.
- The current protocol does not bind a browser nonce. A valid signature does not prevent the same response from being replayed in another session.
- The package does not guarantee exactly-once orders or absolute cross-session replay protection.

## Development

```sh
npm ci
npm run build
npm test
npm run test:integration
npm pack
```

`npm install`, `npm ci`, and `npm pack` all build the package through `prepare`. `prepublishOnly` runs the unit tests and the native SQLite integration tests.

Shopify Functions are a separate runtime and cannot run this backend package directly.

## Links

- Website: [hideguard.io](https://hideguard.io/)
- npm: [@hachitechs/hideguard](https://www.npmjs.com/package/@hachitechs/hideguard)
- Issues: [GitHub issues](https://github.com/namtb1994/hideguard_npm_package/issues)

## License

MIT. See [LICENSE](LICENSE).
