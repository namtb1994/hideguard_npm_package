import { GuardError, requireString } from './errors.js';
import {requestJson, type HttpTransport} from './http.js';
import { API_BASE_URL, normalizeEndpointUrl } from './policy.js';
import { recordKey } from './store.js';
import type { SharedCircuitBreaker } from './circuit-breaker.js';
export type {HttpTransport} from './http.js';

export interface VerdictClientOptions {
  baseUrl?: string;
  apiKey: string;
  timeoutMs?: number;
  maximumResponseBytes?: number;
  transport?: HttpTransport;
  circuitBreaker?: SharedCircuitBreaker;
}

export class VerdictClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maximumBytes: number;
  private readonly transport: HttpTransport;
  private readonly circuitBreaker: SharedCircuitBreaker | undefined;

  constructor(options: VerdictClientOptions) {
    this.url = `${normalizeEndpointUrl(options.baseUrl ?? API_BASE_URL)}/api/v1/verdict`;
    if (!options.apiKey || /[\s\x00-\x1f\x7f]/.test(options.apiKey)) {
      throw new GuardError('configuration', 'API key must be non-empty without whitespace.');
    }
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maximumBytes = options.maximumResponseBytes ?? 262144;
    this.circuitBreaker = options.circuitBreaker;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 ||
        !Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1) {
      throw new GuardError('configuration', 'HTTP timeout and response limit must be positive integers.');
    }
    if (this.circuitBreaker && this.circuitBreaker.probeLeaseMs <= this.timeoutMs) {
      throw new GuardError('configuration', 'Circuit probe lease must exceed the HTTP deadline.');
    }
    // Worker runtimes require native fetch to be called with the global receiver.
    this.transport = options.transport ?? ((url, init) => globalThis.fetch(url, init));
  }

  async getVerdict(visitorId: string): Promise<Record<string, unknown> | unknown[]> {
    requireString(visitorId, 'visitorId', 1024);
    const request = async () => await requestJson(this.url, {
      method: 'POST', redirect: 'manual', cache: 'no-store', credentials: 'omit',
      headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': this.apiKey},
      body: JSON.stringify({visitorId}),
    }, {transport: this.transport, timeoutMs: this.timeoutMs, maximumResponseBytes: this.maximumBytes}) as Record<string, unknown> | unknown[];
    // Isolate endpoint + credential rotations without storing either the key or visitor in circuit state.
    return this.circuitBreaker
      ? this.circuitBreaker.execute(await recordKey('private-verdict', this.url, this.apiKey), request)
      : request();
  }
}
