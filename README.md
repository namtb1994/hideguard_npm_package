# @hachitechs/hideguard

Framework-independent HideGuard client, Ed25519 collect verifier, access lifecycle and browser UI. ESM + TypeScript declarations; Node 22+ or a server runtime supporting Web Crypto Ed25519, `fetch` and Web Streams. No production dependencies.

## Installation

```sh
npm install github:namtb1994/hideguard_npm_package
```

GitHub installation uses this repository directly and does not require an npm registry release or ownership of the `@hachitechs` npm scope. If the repository is private, the installing account needs GitHub access.
npm installs the build dependencies and runs `prepare` to generate the JavaScript and TypeScript declarations before installing the package. Git installations require Git, a Node version supported by the locked development dependencies (verified with Node 22.23.4), and npm lifecycle scripts enabled.

For a fixed revision, append `#<commit-sha>` to the GitHub dependency. The installed package name remains `@hachitechs/hideguard`.

Use `@hachitechs/hideguard` on the server and `@hachitechs/hideguard/browser` for browser integrations.
The package is ESM-only; use `import` or dynamic `import()`.

```ts
import { VerdictClient, verifyApiVerdict } from '@hachitechs/hideguard';

const client = new VerdictClient({
  baseUrl: 'https://hideguard.io',
  apiKey: process.env.HIDEGUARD_API_KEY!,
  timeoutMs: 5000,
});
// Obtain this ID from trusted server state, never directly from a request body.
const payload = await client.getVerdict(trustedVisitorId);
const verdict = verifyApiVerdict(payload, trustedVisitorId);
```

`VerdictClient` sends `POST /api/v1/verdict`, `x-api-key`, and JSON `{ visitorId }`. It rejects redirects, non-2xx responses, invalid/oversized JSON and timeouts. It returns the full JSON object/array; integer values outside JavaScript's safe range become strings. It never retries automatically or logs the response/API key. `ApiError.statusCode` is the HTTP status when available.

Use `verifyCollect(response, policy)` for browser SDK reports. It requires the current Ed25519 protocol v2 signature, public SPKI PEM key, matching environment and fresh timestamp. **Never pass a browser-supplied response to `verifyApiVerdict`**; that verifier is only for a response obtained directly by the authenticated server client. The current protocol has no browser nonce binding, so signature validity does not prove replay prevention across sessions.

## Optional backend capabilities (0.8.0)

Root exports now include `SharedCircuitBreaker`, `CircuitOpenError`, `TransactionalGuardStore`,
`BatchCleanupStore` and `cleanupExpired`. Circuit and atomic Guard are **off by default**; existing clients,
CAS stores, browser imports and signed bytes keep their contracts. No framework/database dependency is added.

See [the upgrade guide](docs/HIGH-TRAFFIC-UPGRADE.md) for usage, request-budget costs, shared-worker guarantees,
transaction/cleanup contracts and rollout. A package upgrade alone does not give a platform's store transactions.
No verdict cache, automatic HTTP retry, session capacity gate or new replay protocol is introduced.

## Mode defaults (since 0.7.0)

`defaultEndpointUrl(environment)` is exported from both root and browser entries.
All supported legacy environment arguments now return the deployment API origin. The default is `https://hideguard.io`. The source constant is `API_BASE_URL` in `src/api-url.ts`, exported from both root and browser entry points. Clients use it when `baseUrl` is omitted; explicit HTTPS `baseUrl` overrides remain supported.

From the origin source checkout, configure a test API and rebuild with:

```sh
npm run config -- --url-api https://api-testing.example
```

Restore the production default with `npm run config -- --url-api https://hideguard.io`. This command changes the package source constant and builds the artifact. Application adapters may instead pass their own deployment URL, without changing the installed package. Environment values inside signed responses remain protocol fields and must still match the expected signing context.

## Public verdict API (0.5.0)

The package remains framework-independent. `PublicVerdictClient`, `verifySignedResponse` and
`verifySignedEnvelope` are available from both the root and `@hachitechs/hideguard/browser`.
No platform route, cart attribute, action name, storage implementation or framework import is part of these APIs.
The browser entry excludes the private `VerdictClient` and server `Guard` exports. Runtime requirements are
Node 22+ or Web Crypto Ed25519, fetch, AbortController, TextDecoder and Web Streams. DOM APIs are needed
only when using `createAccessRuntime`, not for standalone public requests or verification.

```ts
import {PublicVerdictClient, verifySignedEnvelope} from '@hachitechs/hideguard/browser';

const client = new PublicVerdictClient({
  baseUrl: 'https://hideguard.io',
  publicKey: sitePublicKey,
  timeoutMs: 8000,
  maximumResponseBytes: 262144,
  // transport: yourFetchTransport,
});
const proofs = await client.getVerdicts(visitorFromVerifiedState, {
  publicKey: signaturePublicKeyPem,
  environment: 'production',
  maxAgeSeconds: 300,
});
// Every reply is verified, including signed Block; the adapter applies its policy.
// A rejected reply or mismatched visitor rejects the entire lookup.
const proof = proofs[0]!;
await verifySignedEnvelope(proof.signedResponse, {
  publicKey: signaturePublicKeyPem, environment: 'production',
  maxAgeSeconds: 300, nowMs: Date.now(),
});
```

The client posts `{visitorId}` to `/api/v1/verdict-public` with `x-site-key`. It omits credentials,
rejects redirects, disables HTTP cache requests, never retries, bounds streamed bytes before parsing, and accepts
one object or a list of 1–32 signed responses. All replies are checked with the **Verdict** label,
configured signing key/environment, response-time freshness and requested visitor. The finite HTTP deadline
also rejects transports/streams that ignore abort. An optional `onVerification` callback receives bounded
request/key IDs, verdict, environment, signing time, response index and verification outcome; never keys,
signatures, visitor IDs or raw bodies. Callback failures cannot change the access decision. The client itself
never logs. API/network/JSON errors are sanitized; `ApiError.statusCode` retains the HTTP status when known.

`verifySignedResponse(payload, options, kind = 'collect')` selects exactly one of
`hideguard-collect-ed25519-v2` or `hideguard-verdict-ed25519-v2`; failed signatures never retry another label.
It returns `{visitorId, verdict, signedAt, signedResponse}`. The envelope contains the original signature header
and exact canonical message. `verifySignedEnvelope` authenticates its label and bytes again. Neither uses unsigned
`source` metadata. `verifyCollect` keeps its original server contract and is Collect-only; `verifyApiVerdict`
remains exclusively for the private server client, never for public/browser responses.

`SignatureOptions.groupFor` optionally supplies a trusted application's verdict-group policy; unknown verdicts
are rejected. Without it only allow/block/challenge are recognized. `allowExpiredBlock` is solely for rechecking
an already accepted cached block while an adapter independently bounds its retention period. Public lookups
never enable that exemption, including when supplied at runtime by JavaScript. `normalizeEndpointUrl` is also
exported from the browser entry for adapters to share the HTTPS-origin validation.

HideGuard enforces key–registered-domain restrictions upstream (owner-confirmed contract). The package
sends the configured site key without inventing domain headers or CORS rules. This restriction and a valid
signature do not themselves establish guest/resource/action binding, single-use proof or backend revocation.
Adapters still own those authorization boundaries.

## Shared verdict policy (0.6.0)

Edit only `src/verdict-policy.json` to manage exact, case-sensitive verdict values for every adapter:

```json
{
  "block": ["block"],
  "challenge": ["challenge"],
  "allow": ["allow"]
}
```

Root and browser entries export frozen `BLOCK_VERDICTS`, `CHALLENGE_VERDICTS`, `ALLOW_VERDICTS`
and `verdictGroupFor(value)`. Unknown values return undefined and verification rejects them. Values must be
valid protocol tokens, unique across all groups, with 1–64 total values. Invalid policies fail before use.
Build tools can read the same source through `@hachitechs/hideguard/verdict-policy.json`; compiled JavaScript,
browser assets and any native-runtime constants are generated from it, never maintained separately.

`verifyCollect` verifies the original signed verdict and returns its normalized group as `VerifiedVerdict.verdict`;
`verifyApiVerdict` normalizes a trusted private server reply the same way. Guard therefore applies the shared
policy to confirmation, reporting and business checks without hard-coded lists of upstream values. Signature and
envelope APIs and PublicVerdictClient retain the original signed verdict; adapters classify it with
`verdictGroupFor`. Existing allow/block/challenge behavior is unchanged. The optional trusted `groupFor` hook
remains available for adapters needing an explicit custom policy.

Changing a group is an authorization-policy change. Rebuild, version and distribute the same package version
to each application, and rebuild/deploy generated native constants together. Copies in separate repositories
do not update each other automatically. Installations keep their
existing policy until the new application/package build is delivered.

## Server lifecycle

Create `new Guard(store)` with your framework's authenticated context `{ scopeId, actorId, browserId }` and a `ProtectionPolicy`. Resolve tenant and actor from your framework's authenticated identity. The opaque browser ID only selects a session scoped to that tenant and actor; it is never a credential or grant. Keep API keys and authoritative policy/signing-key configuration in backend storage.

1. `preflight(context, policy)` reuses a timed pass or reserves a verification attempt with a fixed deadline. Set `{ retry: true }` after a failed attempt.
2. Verify the SDK report with `verifyCollect`, then `report(context, policy, verified, verificationId)`. Call `fail` when verification fails.
3. Verify resource ownership through your platform API before calling `bindGrant(context, policy, resourceId)`.
4. Before **each** protected business action, call `beginResourceCheck`, request a fresh server verdict using `check.visitorId`, verify it, then call `completeResourceCheck`. Proceed only for an `allowed` result with the matching attempt ID. On transport/verification errors call `fail(check.context, policy, check.verificationId)` and deny the action.
5. Call `consumeGrant` after a completed purchase. This cleanup does not replace synchronous validation before ordering.

Allow and Challenge both grant access for compatibility with the existing Magento/Shopify integrations. Challenge is not proof that a CAPTCHA was completed. Backend checks do not extend the original pass expiry. Always mode collects afresh on page preflight and uses a bounded 5-minute internal grant for resource binding.

## Storage contract

Implement `GuardStore.read`, `insert` and `replace`. Reads must be strongly consistent; insert-if-absent and compare-and-swap by version must be atomic across workers. Return `false` only for confirmed contention and throw infrastructure errors. The package retries document contention at most eight times; adapters may enforce a tighter request budget.

Records contain hashed keys, session state, resource bindings, actor/visitor block ledgers and rate counters. Treat these collections as privileged server state. Enforce expiry on reads and arrange physical cleanup in the adapter. A single-document CAS does not provide transactions across session, binding and block-ledger documents. Storage errors deny the current operation; the package does not promise exactly-once orders or absolute cross-session replay protection.

## Browser integration

```ts
import { createAccessRuntime } from '@hachitechs/hideguard/browser';

const runtime = createAccessRuntime({ request: authenticatedBackendRequest });
await runtime.start();
// On navigation/unmount:
runtime.destroy();
```

The adapter implements the exported `AccessRequest` contract and returns server time, public configuration, a decision and the opaque browser token. Only this token is stored in sessionStorage. `lockPage: false` and `container` support an inline checkout panel; `onAllowed` can bind the platform's current purchase flow. The UI lock controls browser interaction and cannot prevent the platform from delivering HTML or replace backend authorization.

### Signed page mode (opt in, 0.2.0)

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

Supply `enabled`, `environment`, HTTPS-origin `endpointUrl`, SDK `publicKey`, Ed25519 SPKI PEM `signaturePublicKey`, `revision`, `protectedPoints`, `protectedPaths`, `recheckSeconds` and `blockSeconds` as public settings. These are public parameters, never authorization. They must not contain the API key or secret references. `shouldProtect` remains your framework's page-scope adapter.

This mode owns the SDK `collect()` Promise (the modern SDK returns the signed response). It verifies the actual signed v2 fields, environment and expiry locally before opening a page for `allow`. It does not trust a global `fpc:verdict` event from a previous route. Every start/resume collects afresh; recheck seconds bound signed-proof validity and the next expiry check. `block` stays locked; `challenge` waits for backend policy, retaining the existing server Allow policy without claiming CAPTCHA completion.

The adapter receives **one** `confirm` operation with `{ browserToken, response, revision, confirmationId }`, without a preceding `preflight`. The server must authenticate tenant/actor, load current policy, check revision, call `verifyCollect(response, policy)`, then `guard.confirm(context, policy, verified, confirmationId)`; rate-limit the endpoint and recheck revision before responding. Never pass an unverified browser object as a verified verdict. The confirmation ID correlates the operation; it does not authenticate the proof.

`getState()` stays `null` during local page approval. Only backend confirmation exposes an allowed grant and invokes `onAllowed`; resource ownership checks, binding, fresh server `/api/v1/verdict` and expiry remain mandatory for protected business actions. Local page approval may precede discovery of a persisted backend block; this is an explicit trade-off of signed page mode. Choose the default `server` mode when all page interaction must await fresh backend block state.

Backend refusal, revision change, local signature failure, expiry, timeout or transport error locks the page. Confirmation has a bounded 12-second default timeout (`confirmationTimeoutMs`, 1–35000 ms). Retry, pause, destroy and BFCache invalidate old SDK/HTTP callbacks. An optional `onLocalVerdict` callback can prefetch read-only platform data; it must not grant checkout access. Browser adapters may redirect after locking, but no block-page URL or Wix dependency is built into this package.

`onVerificationStart` is an optional synchronous lifecycle callback for adapters to lock purchase controls before collection/preflight or when access is suspended. It runs on rechecks, pause/resume, BFCache restoration and cross-tab inspection. Release purchase controls only after `onAllowed` completes resource binding and platform validation refresh; local signed page approval and `onState(allowed)` alone are insufficient.

Migration from the previous workspace package: change imports/dependencies from `@hideguard/antidetect` to `@hachitechs/hideguard` and rebuild. Existing `createAccessRuntime({ request })` callers keep server mode; only callers explicitly setting `mode: 'signed'` use the new flow. The HTTP adapter must support `confirm` before enabling it.

## Standalone development and packaging

`ResourceVerificationError` extends `GuardError` with the existing `permission` reason and a `verificationStatus` of `required`, `pending`, `failed` or `blocked`. Adapters can show a waiting message for `required`/`pending` and an error for `failed`/`blocked`. Every case still refuses the business action; a waiting message is never permission to proceed. Storage/identity/transport failures remain errors, and optimistic concurrency failures retain the `contention` reason.

```sh
npm ci
npm run build
npm test
npm run test:integration
npm pack
```

Build and test in this repository, then distribute the versioned npm package or tarball to each host application. Existing applications may keep a vendored workspace copy such as `file:packages/hachitechs-hideguard`; those copies do not update automatically. Avoid absolute external paths as production/build dependencies. A Shopify Node backend can supply its own store, authenticated identity, resource ownership and HTTP adapters. Shopify Functions remain a separate runtime and cannot directly execute this backend package.

`npm install`, `npm ci`, Git dependency installation and `npm pack` build the package through `prepare`. Registry publishing also runs the unit and native SQLite integration tests through `prepublishOnly`; development and release checks require a Node version supported by the locked development dependencies (verified with Node 22.23.4).

## Optional npm registry publishing

GitHub installation works independently of npm registry publishing. The package is also configured for future public releases on `https://registry.npmjs.org/`.
The publishing account must have access to the `@hachitechs` npm scope, and each release must use a version not already published.

```sh
npm publish --dry-run
npm publish
```

The dry run validates the local release process without uploading a release; npm authentication and scope permissions must be checked separately.

## License

MIT. See [LICENSE](LICENSE).
