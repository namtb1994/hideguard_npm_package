import type { BrowserConfiguration } from './types.js';

interface Collector { collect: () => unknown; }
function collector(): Collector | null {
  const value: unknown = Reflect.get(window, 'FingerprintCollector');
  if (!value || typeof value !== 'object' || typeof Reflect.get(value, 'collect') !== 'function') return null;
  return value as Collector;
}

function waitForSdk(script: HTMLScriptElement, append: boolean): Promise<void> {
  if (script.dataset.hideguardLoad === 'loaded' || (script.dataset.hideguardLoad !== 'loading' && collector())) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      script.removeEventListener('load', loaded);
      script.removeEventListener('error', failed);
      if (error) { script.dataset.hideguardLoad = 'error'; script.remove(); reject(error); }
      else { script.dataset.hideguardLoad = 'loaded'; resolve(); }
    };
    const loaded = () => finish();
    const failed = () => finish(new Error('HideGuard SDK could not be loaded.'));
    const timer = setTimeout(() => finish(new Error('HideGuard SDK load timed out.')), 12000);
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', failed, { once: true });
    if (append) document.head.append(script);
  });
}

export async function collectSdk(configuration: BrowserConfiguration): Promise<unknown> {
  const endpoint = new URL(configuration.endpointUrl);
  if (endpoint.protocol !== 'https:' || endpoint.origin !== configuration.endpointUrl || !configuration.publicKey) throw new Error('HideGuard SDK configuration is invalid.');
  let existing = document.getElementById('hideguard-sdk');
  if (existing && (!(existing instanceof HTMLScriptElement) || existing.dataset.endpoint !== configuration.endpointUrl || existing.dataset.siteKey !== configuration.publicKey)) {
    // A loaded SDK owns global configuration. On reload bypass stale embed parameters once.
    try { sessionStorage.setItem('hideguard_skip_early_sdk', '1'); }
    catch { throw new Error('HideGuard SDK settings changed. Reload the storefront.'); }
    window.location.reload(); return;
  }
  if (existing instanceof HTMLScriptElement && existing.dataset.hideguardLoad === 'error') {
    existing.remove(); existing = null;
  }
  if (existing instanceof HTMLScriptElement) await waitForSdk(existing, false);
  else {
    const script = document.createElement('script'); script.id = 'hideguard-sdk'; script.async = true;
    script.src = `${endpoint.origin}/sdk/v1.js`; script.dataset.endpoint = endpoint.origin;
    script.dataset.siteKey = configuration.publicKey; script.dataset.auto = 'false';
    script.dataset.hideguardLoad = 'loading';
    await waitForSdk(script, true);
  }
  const sdk = collector();
  if (!sdk) throw new Error('HideGuard SDK did not initialize.');
  return sdk.collect();
}
