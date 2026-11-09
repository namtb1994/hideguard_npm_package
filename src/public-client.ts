import {isRecord} from './errors.js';
import {requestJson, validateHttpOptions, type HttpOptions, type HttpTransport} from './http.js';
import {normalizeEndpointUrl} from './policy.js';
import {protocolToken, verifySignedResponse, type SignatureOptions, type SignedVerdict} from './signed-response.js';

export interface PublicVerificationEvent {
  responseIndex: number;
  requestId: string | null;
  claimedVerdict: string | null;
  responseEnvironment: string | null;
  keyId: string | null;
  signedAt: number | null;
  result: 'passed' | 'failed';
  visitorMatches?: boolean;
  error?: string;
}
export interface PublicVerdictClientOptions {
  baseUrl: string;
  publicKey: string;
  timeoutMs?: number;
  maximumResponseBytes?: number;
  transport?: HttpTransport;
  now?: () => number;
  /** Bounded diagnostics only; no keys, signatures, visitor IDs or payloads. */
  onVerification?: (event: PublicVerificationEvent) => void | Promise<void>;
}
export type PublicVerificationOptions = Omit<SignatureOptions, 'nowMs' | 'allowExpiredBlock'>;

function metadata(payload: unknown) {
  const reply = isRecord(payload) ? payload : {};
  const token = (value: unknown) => protocolToken(value) ? value : null;
  const header = typeof reply.signature === 'string'
    && /^v=2,alg=ed25519,kid=([A-Za-z0-9][A-Za-z0-9._:-]{0,127}),t=([1-9][0-9]{0,11}),sig=[A-Za-z0-9_-]{86}$/.exec(reply.signature);
  const validHeader = header && header[0] === reply.signature;
  return {
    requestId: token(reply.requestId), claimedVerdict: token(reply.verdict),
    responseEnvironment: token(reply.environment),
    keyId: validHeader ? header[1]! : null,
    signedAt: validHeader ? Number(header[2]) : null,
  };
}

/** Public site-key requests are separate from the secret-key private VerdictClient. */
export class PublicVerdictClient {
  private readonly url: string;
  private readonly siteKey: string;
  private readonly http: HttpOptions;
  private readonly now: () => number;
  private readonly onVerification: PublicVerdictClientOptions['onVerification'];

  constructor(options: PublicVerdictClientOptions) {
    this.url = `${normalizeEndpointUrl(options.baseUrl)}/api/v1/verdict-public`;
    this.siteKey = options.publicKey.trim();
    if (!this.siteKey || /[\s\x00-\x1f\x7f]/.test(this.siteKey)) {
      throw new Error('A valid Public key is required to verify access.');
    }
    this.http = {
      timeoutMs: options.timeoutMs ?? 8000,
      maximumResponseBytes: options.maximumResponseBytes ?? 262144,
      transport: options.transport ?? ((url, init) => globalThis.fetch(url, init)),
    };
    validateHttpOptions(this.http);
    this.now = options.now ?? Date.now;
    this.onVerification = options.onVerification;
  }

  private emit(event: PublicVerificationEvent): void {
    try {
      void Promise.resolve(this.onVerification?.(event)).catch(() => undefined);
    } catch { /* Diagnostics never change the authorization result. */ }
  }

  async getVerdicts(visitorId: string, options: PublicVerificationOptions): Promise<SignedVerdict[]> {
    if (!protocolToken(visitorId)) throw new Error('A valid visitor ID is required to look up access.');
    const response = await requestJson(this.url, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: {'Content-Type': 'application/json', Accept: 'application/json', 'x-site-key': this.siteKey},
      body: JSON.stringify({visitorId}),
    }, this.http);
    const replies = Array.isArray(response) ? response : [response];
    if (!replies.length || replies.length > 32) {
      throw new Error('HideGuard verdict lookup returned an invalid response list.');
    }
    let verdicts: SignedVerdict[];
    try {
      verdicts = await Promise.all(replies.map(async (reply: unknown, responseIndex) => {
        const diagnostic = {responseIndex, ...metadata(reply)};
        try {
          const verified = await verifySignedResponse(reply, {
            publicKey: options.publicKey, environment: options.environment,
            maxAgeSeconds: options.maxAgeSeconds, nowMs: this.now(),
            ...(options.groupFor ? {groupFor: options.groupFor} : {}),
          }, 'verdict');
          this.emit({...diagnostic, result: 'passed', visitorMatches: verified.visitorId === visitorId});
          return verified;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'HideGuard verification failed.';
          this.emit({...diagnostic, result: 'failed', error: message});
          throw error;
        }
      }));
    } catch (error) {
      throw new Error(`HideGuard verdict lookup failed verification: ${error instanceof Error ? error.message : 'Invalid response.'}`);
    }
    if (verdicts.some((verdict) => verdict.visitorId !== visitorId)) {
      throw new Error('HideGuard verdict lookup does not match the requested visitor.');
    }
    return verdicts;
  }
}
