import { AccessView } from './view.js';
import { collectSdk } from './sdk.js';
import type { AccessRuntime, BrowserReply, RuntimeOptions } from './types.js';
import { createSignedRuntime } from './signed-runtime.js';

export function createAccessRuntime(options: RuntimeOptions): AccessRuntime {
  if (options.mode === 'signed') return createSignedRuntime(options);
  const storageKey = options.storageKey ?? 'hideguard_browser';
  let token = '';
  try { token = sessionStorage.getItem(storageKey) ?? ''; } catch { /* The current page still works with an in-memory token. */ }
  let reply: BrowserReply | null = null;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<void> | null = null;
  let collecting = false;
  let reporting = false;
  let disposed = false;
  let suspended = false;
  const view = new AccessView(options.lockPage !== false, options.container, () => { void check(true); });
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(storageKey) : null;

  async function call(operation: Parameters<RuntimeOptions['request']>[0], extra: Record<string, unknown> = {}) {
    return options.request(operation, { browserToken: token, ...extra });
  }

  function remember(value: BrowserReply): void {
    token = value.browserToken;
    try { sessionStorage.setItem(storageKey, token); } catch { /* Persisting a token is optional. */ }
  }

  async function accept(value: BrowserReply, sequence: number): Promise<void> {
    if (sequence !== generation || disposed || suspended) return;
    clearTimeout(timer); reply = value; remember(value); options.onState?.(value);
    if (!value.configuration.enabled || options.shouldProtect?.(value.configuration) === false) {
      collecting = false;
      view.hide();
      return;
    }
    const { decision } = value;
    if (decision.status === 'allowed' || decision.status === 'disabled') {
      collecting = false;
      if (decision.status === 'allowed') {
        try { await options.onAllowed?.(); }
        catch {
          if (sequence !== generation || disposed) return;
          const message = 'This purchase flow could not be verified. Please try again.';
          view.show('error', message); options.onState?.(value, message); return;
        }
        if (sequence !== generation || disposed) return;
        timer = setTimeout(() => { void check(); }, Math.max(1, decision.grantedUntil - value.serverTime));
      }
      view.hide();
      return;
    }
    if (decision.status === 'blocked') {
      collecting = false;
      view.show('blocked', `Please try again after ${new Date(decision.blockedUntil).toLocaleString()}.`);
      timer = setTimeout(() => { void check(); }, Math.max(1, decision.blockedUntil - value.serverTime));
      return;
    }
    if (decision.status === 'verification_failed') { collecting = false; view.show('error', 'Select Try again to start a new verification.'); return; }
    view.show('pending');
    timer = setTimeout(() => { void fail(sequence, 'Browser verification timed out.'); }, Math.max(1, decision.verificationUntil - value.serverTime));
    if (!collecting) {
      collecting = true;
      void collectSdk(value.configuration).catch(() => { void fail(sequence, 'The browser verification service could not be reached.'); });
    }
  }

  async function fail(sequence: number, message: string): Promise<void> {
    if (sequence !== generation || disposed || reply?.decision.status === 'allowed' || reply?.decision.status === 'blocked') return;
    clearTimeout(timer); collecting = false;
    const verificationId = reply?.decision.verificationId;
    if (verificationId) {
      try { await call('fail', { verificationId }); } catch { /* Backend deadline still refuses protected actions. */ }
    }
    if (sequence !== generation || disposed) return;
    options.onState?.(reply, message); view.show('error', message);
  }

  async function check(retry = false): Promise<void> {
    if (checking || disposed || suspended) return checking ?? undefined;
    const sequence = ++generation; collecting = false; reporting = false;
    view.show('pending');
    options.onVerificationStart?.();
    checking = (async () => {
      try { await accept(await call(retry ? 'retry' : 'preflight'), sequence); }
      catch { if (sequence === generation) { view.show('error', 'Access could not be verified. Select Try again.'); options.onState?.(null, 'Access service unavailable.'); } }
      finally { checking = null; }
    })();
    return checking;
  }

  async function report(event: Event): Promise<void> {
    if (!(event instanceof CustomEvent) || !collecting || reporting || disposed || reply?.decision.status !== 'verification_required') return;
    reporting = true;
    const sequence = generation;
    const verificationId = reply.decision.verificationId;
    try {
      const response: unknown = JSON.parse(JSON.stringify(event.detail));
      const value = await call('report', { verificationId, response });
      await accept(value, sequence);
      if (value.decision.status === 'blocked') channel?.postMessage('block');
    } catch { await fail(sequence, 'The verification response could not be accepted.'); }
    finally { if (sequence === generation) reporting = false; }
  }

  const listener = (event: Event) => { void report(event); };
  const onSignal = () => {
    if (suspended || disposed) return;
    const sequence = ++generation;
    options.onVerificationStart?.();
    void call('inspect').then((value) => accept(value, sequence)).catch(() => {
      if (sequence !== generation || disposed) return;
      clearTimeout(timer);
      view.show('error', 'Access could not be refreshed. Select Try again.');
      options.onState?.(reply, 'Access service unavailable.');
    });
  };
  window.addEventListener('fpc:verdict', listener);
  channel?.addEventListener('message', onSignal);
  async function resume(): Promise<void> {
    const sequence = generation;
    await checking;
    if (disposed || sequence !== generation) return;
    suspended = false;
    await check();
  }
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void resume(); };
  window.addEventListener('pageshow', onPageShow);

  return {
    start: () => check(),
    refresh: () => check(),
    pause() {
      if (disposed) return;
      suspended = true; generation++; collecting = false; reporting = false;
      clearTimeout(timer); view.show('pending');
      options.onVerificationStart?.();
    },
    resume,
    getState: () => reply,
    async bind(): Promise<boolean> {
      if (suspended || disposed) return false;
      if (reply?.decision.status !== 'allowed') { await check(); return false; }
      const sequence = generation;
      try {
        const value = await call('bind');
        await accept(value, sequence);
        return !disposed && !suspended && sequence === generation && value.decision.status === 'allowed';
      }
      catch {
        if (!disposed && !suspended && sequence === generation) view.show('error', 'This purchase flow could not be verified. Please try again.');
        return false;
      }
    },
    destroy() { disposed = true; generation++; clearTimeout(timer); view.destroy(); channel?.close(); window.removeEventListener('fpc:verdict', listener); window.removeEventListener('pageshow', onPageShow); },
  };
}
