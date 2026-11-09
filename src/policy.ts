import { GuardError } from './errors.js';

export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type Environment = typeof ENVIRONMENTS[number];
export const TEST_HIDEGUARD_URL = 'https://dev.hideguard.io';
export const DEFAULT_HIDEGUARD_URL = 'https://hideguard.io';

/** Defaults only: legacy staging and explicit HTTPS overrides remain available to adapters. */
export function defaultEndpointUrl(environment: string): string {
  if (!ENVIRONMENTS.some((known) => known === environment)) throw new GuardError('configuration', 'HideGuard environment is invalid.');
  return environment === 'production' ? DEFAULT_HIDEGUARD_URL : TEST_HIDEGUARD_URL;
}
export const RECHECK_SECONDS = [0, 60, 120, 300, 900, 3600] as const;
export const BLOCK_SECONDS = [900, 3600, 21600, 86400] as const;
export const ACCESS_POINTS = ['all_pages', 'product', 'cart', 'checkout', 'complete_order'] as const;
export type AccessPoint = typeof ACCESS_POINTS[number];

export interface ProtectionPolicy {
  enabled: boolean;
  environment: Environment;
  endpointUrl: string;
  publicKey: string;
  signaturePublicKey: string;
  revision: string;
  blockEpoch: string;
  recheckSeconds: number;
  blockSeconds: number;
  verificationSeconds: number;
}

export function normalizeEndpointUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new GuardError('configuration', 'HideGuard URL must be an HTTPS origin.'); }
  if (value.length > 2048 || !/^https:\/\//i.test(value.trim()) || /[\s\\]/.test(value.trim()) || url.protocol !== 'https:' ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new GuardError('configuration', 'HideGuard URL must be an HTTPS origin without a path, credentials, query or fragment.');
  }
  return url.origin;
}

export function grantMilliseconds(policy: ProtectionPolicy): number {
  return (policy.recheckSeconds || 300) * 1000;
}

export function matchesPath(path: string, rules: readonly string[]): boolean {
  const normalized = path.split('?')[0]?.replace(/^\/+|\/+$/g, '') ?? '';
  return rules.some((rule) => {
    const pattern = rule.replace(/^\/+|\/+$/g, '').split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${pattern}$`).test(normalized);
  });
}
