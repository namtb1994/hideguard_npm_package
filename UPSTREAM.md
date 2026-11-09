# Local package provenance

Copied on 2026-10-24 from the owner-supplied package at
`/Users/sspro/projects/wix_apps/hideguard-antidetect-browser/packages/hachitechs-hideguard` (0.4.0).
The source, tests, README, manifest and TypeScript configuration were copied; generated dist was rebuilt locally.
The original directory was not edited during the initial copy and is not a runtime/build dependency.
Subsequent owner-requested updates synchronized the 0.5.0 and 0.6.0 package back into the Wix repository.

This workspace version is 0.8.0, private and unpublished. Changes add framework-independent public verdict transport,
shared Collect/Verdict signature/envelope APIs and a bounded HTTP helper while preserving the original server APIs.
No Shopify, Wix, React or other framework dependency was added. The browser entry uses standard Web Crypto,
fetch, Streams and DOM APIs; root verification/client APIs work without a DOM.

The Shopify application owns bundling, diagnostics output, cart/property transport and action hooks outside this package.

Version 0.6.0 centralizes verdict groups in src/verdict-policy.json. Root/browser APIs and generated Shopify
constants consume this source; Wix receives the same package version. Signature verification preserves raw
signed bytes; lifecycle/private verifiers normalize the authenticated verdict to its policy group.

Version 0.7.0 adds root/browser mode endpoint defaults. This update is local to Shopify; no Wix source synchronization or registry publication was performed. Legacy protocol environments and explicit HTTPS origins remain supported.

Version 0.8.0 adds opt-in shared CAS circuit breaking for private VerdictClient, opt-in serializable Guard
transactions and bounded cleanup contracts/helpers. Existing CAS adapters and browser exports keep their contracts.
No runtime dependency, native database adapter, Shopify/Wix import, nonce protocol or capacity counter was added.
Native SQLite fixtures are test-only. See docs/HIGH-TRAFFIC-UPGRADE.md for adapter requirements and rollout.
No Wix synchronization, hosted-settings vendor refresh, registry publication or deployment was performed.

## Standalone shared source — 2026-11-09

Established at `/Users/sspro/projects/node-packages/hachitechs-hideguard` by owner request,
from the tested 0.8.0 source in the Shopify workspace. Source and tests were copied byte-for-byte;
README and upgrade commands were adapted for standalone development. The existing Shopify copy
was retained to preserve its current file/workspace dependency. Wix and hosted-settings copies
were not updated. Future shared changes should be developed/tested here and distributed as
versioned artifacts or verified snapshots; consumers do not update automatically. No registry
publication, deployment or Git repository initialization was performed by this extraction.
