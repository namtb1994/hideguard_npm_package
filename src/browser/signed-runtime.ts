import { grantMilliseconds, type ProtectionPolicy } from '../policy.js';
import { verifyCollect, type VerifiedVerdict } from '../verification.js';
import { parseBrowserConfiguration } from './configuration.js';
import { collectSdk } from './sdk.js';
import { AccessView } from './view.js';
import type { AccessOperation, AccessRuntime, BrowserReply, RuntimeOptions } from './types.js';

/** Local signatures control page interaction. Backend replies alone control commerce grants. */
export function createSignedRuntime(options: RuntimeOptions): AccessRuntime {
  const configuration = parseBrowserConfiguration(options.initialConfiguration);
  const policy: ProtectionPolicy = { ...configuration, blockEpoch: 'local', verificationSeconds: 35 };
  const storageKey = options.storageKey ?? 'hideguard_browser';
  const timeout = options.confirmationTimeoutMs ?? 12000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 35000) throw new Error('Invalid confirmation timeout.');
  let token = '';
  try { token = sessionStorage.getItem(storageKey) ?? ''; } catch { /* Storage is optional. */ }
  let reply: BrowserReply | null = null;
  let generation = 0;
  let collecting = false;
  let disposed = false;
  let suspended = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let cancelRequest: (() => void) | null = null;
  let localVerdict: VerifiedVerdict | null = null;
  const view = new AccessView(options.lockPage !== false, options.container, () => { void start(); });
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(storageKey) : null;
  const current = (sequence: number) => !disposed && !suspended && generation === sequence;

  function invalidate(): void {
    generation++; collecting = false; reply = null; localVerdict = null;
    clearTimeout(expiry); cancelRequest?.();
  }

  function fail(sequence: number, message: string): void {
    if (!current(sequence)) return;
    invalidate();
    view.show('error', message); options.onState?.(null, message);
  }

  function call(operation: AccessOperation, body: Record<string, unknown> = {}): Promise<BrowserReply> {
    return new Promise((resolve, reject) => {
      const finish = (value: BrowserReply | null, error?: Error) => {
        clearTimeout(timer);
        if (cancelRequest === cancel) cancelRequest = null;
        if (value) resolve(value); else reject(error ?? new Error('Confirmation cancelled.'));
      };
      const cancel = () => finish(null);
      const timer = setTimeout(() => finish(null, new Error('Confirmation timed out.')), timeout);
      cancelRequest = cancel;
      Promise.resolve().then(() => options.request(operation, { browserToken: token, ...body }))
        .then((value) => finish(value), () => finish(null, new Error('Access service unavailable.')));
    });
  }

  async function accept(value: BrowserReply, sequence: number, runAllowed = true): Promise<void> {
    if (!current(sequence)) return;
    if (value.configuration.revision !== configuration.revision || value.decision.policyRevision !== configuration.revision) {
      fail(sequence, 'Protection settings changed. Reload the page.'); return;
    }
    token = value.browserToken;
    try { sessionStorage.setItem(storageKey, token); } catch { /* Storage is optional. */ }
    const decision = value.decision;
    if (decision.status === 'blocked') {
      clearTimeout(expiry); reply = value; options.onState?.(value);
      view.show('blocked', `Please try again after ${new Date(decision.blockedUntil).toLocaleString()}.`);
      expiry = setTimeout(() => { void start(); }, Math.max(1, decision.blockedUntil - value.serverTime));
      return;
    }
    if (decision.status !== 'allowed' || localVerdict?.verdict === 'block') {
      fail(sequence, 'The backend did not approve this browser. Select Try again.'); return;
    }
    const remaining = Math.min(decision.grantedUntil - value.serverTime,
      localVerdict ? localVerdict.issuedAt + grantMilliseconds(policy) - Date.now() : Infinity);
    if (remaining <= 0) { fail(sequence, 'Browser verification expired. Select Try again.'); return; }
    reply = value; options.onState?.(value);
    clearTimeout(expiry);
    expiry = setTimeout(() => { void start(); }, remaining);
    try { if (runAllowed) await options.onAllowed?.(); }
    catch { fail(sequence, 'This purchase flow could not be verified. Select Try again.'); return; }
    if (current(sequence)) view.hide();
  }

  async function report(detail: unknown, sequence: number): Promise<void> {
    if (!current(sequence) || !collecting) return;
    collecting = false;
    clearTimeout(expiry);
    try {
      const serialized = JSON.stringify(detail);
      if (!serialized || new TextEncoder().encode(serialized).length > 16384) throw new Error('Invalid SDK response.');
      const response: unknown = JSON.parse(serialized);
      const verdict = await verifyCollect(response, policy);
      if (!current(sequence)) return;
      localVerdict = verdict;
      const remaining = verdict.issuedAt + grantMilliseconds(policy) - Date.now();
      if (remaining <= 0) throw new Error('Expired SDK response.');
      options.onLocalVerdict?.(verdict);
      if (verdict.verdict === 'allow') view.hide();
      else if (verdict.verdict === 'block') view.show('blocked', 'This browser is blocked by HideGuard.');
      // Local approval expires even if confirmation is stalled. Never create a local backend grant.
      expiry = setTimeout(() => { void start(); }, remaining);
      const value = await call('confirm', { response, revision: configuration.revision, confirmationId: crypto.randomUUID() });
      await accept(value, sequence);
      if (current(sequence) && value.decision.status === 'blocked') channel?.postMessage('block');
    } catch { fail(sequence, 'The verification response could not be confirmed. Select Try again.'); }
  }

  async function start(): Promise<void> {
    if (disposed || suspended) return;
    invalidate();
    const sequence = generation;
    view.show('pending');
    if (!configuration.enabled || options.shouldProtect?.(configuration) === false) { view.hide(); return; }
    options.onVerificationStart?.();
    collecting = true;
    expiry = setTimeout(() => fail(sequence, 'Browser verification timed out. Select Try again.'), policy.verificationSeconds * 1000);
    // Own the collect Promise so an old route's global SDK event cannot approve a new route.
    void collectSdk(configuration).then((response) => report(response, sequence))
      .catch(() => fail(sequence, 'The browser verification service could not be reached.'));
  }

  const onSignal = () => {
    if (disposed || suspended) return;
    invalidate(); view.show('pending');
    options.onVerificationStart?.();
    const sequence = generation;
    void call('inspect').then((value) => accept(value, sequence)).catch(() => fail(sequence, 'Access could not be refreshed.'));
  };
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) { suspended = false; void start(); } };
  window.addEventListener('pageshow', onPageShow);
  channel?.addEventListener('message', onSignal);

  return {
    start, refresh: start,
    pause() { if (!disposed) { suspended = true; invalidate(); view.show('pending'); options.onVerificationStart?.(); } },
    async resume() { if (!disposed) { suspended = false; await start(); } },
    getState: () => reply,
    async bind() {
      if (disposed || suspended || reply?.decision.status !== 'allowed' || cancelRequest) return false;
      const sequence = generation;
      try {
        await accept(await call('bind'), sequence, false);
        return current(sequence) && reply?.decision.status === 'allowed';
      } catch { fail(sequence, 'This purchase flow could not be verified.'); return false; }
    },
    destroy() {
      disposed = true; invalidate(); view.destroy(); channel?.close();
      window.removeEventListener('pageshow', onPageShow);
    },
  };
}
