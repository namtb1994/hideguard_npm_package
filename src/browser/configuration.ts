import { GuardError, isRecord } from '../errors.js';
import { ACCESS_POINTS, BLOCK_SECONDS, ENVIRONMENTS, RECHECK_SECONDS, normalizeEndpointUrl } from '../policy.js';
import { validatePublicKey } from '../verification.js';
import type { SignedBrowserConfiguration } from './types.js';

/** Decode only public settings. These settings cannot authorize a backend operation. */
export function parseBrowserConfiguration(value: unknown): SignedBrowserConfiguration {
  if (!isRecord(value)) throw new GuardError('configuration', 'Browser configuration is invalid.');
  const environment = ENVIRONMENTS.find((name) => name === value.environment);
  const recheckSeconds = RECHECK_SECONDS.find((seconds) => seconds === value.recheckSeconds);
  const blockSeconds = BLOCK_SECONDS.find((seconds) => seconds === value.blockSeconds);
  if (!environment || recheckSeconds === undefined || blockSeconds === undefined || typeof value.enabled !== 'boolean' ||
      typeof value.endpointUrl !== 'string' || typeof value.publicKey !== 'string' || value.publicKey.length > 1024 ||
      typeof value.signaturePublicKey !== 'string' || value.signaturePublicKey.length > 4096 ||
      typeof value.revision !== 'string' || !value.revision || value.revision.length > 128 ||
      !Array.isArray(value.protectedPoints) || value.protectedPoints.length > ACCESS_POINTS.length ||
      !value.protectedPoints.every((point: unknown) => ACCESS_POINTS.some((known) => known === point)) ||
      !Array.isArray(value.protectedPaths) || value.protectedPaths.length > 50 ||
      !value.protectedPaths.every((path: unknown) => typeof path === 'string' && path.length <= 4096 && !/[?#\x00-\x1f\x7f]/.test(path) && !path.includes('://'))) {
    throw new GuardError('configuration', 'Browser configuration is invalid.');
  }
  if (value.enabled && !value.publicKey.trim()) throw new GuardError('configuration', 'SDK public key is missing.');
  if (value.enabled || value.signaturePublicKey) validatePublicKey(value.signaturePublicKey);
  return { enabled: value.enabled, environment, endpointUrl: normalizeEndpointUrl(value.endpointUrl), publicKey: value.publicKey,
    signaturePublicKey: value.signaturePublicKey, revision: value.revision, recheckSeconds, blockSeconds,
    protectedPoints: value.protectedPoints.filter((point): point is string => typeof point === 'string'),
    protectedPaths: value.protectedPaths.filter((path): path is string => typeof path === 'string') };
}
