import type { AccessDecision } from '../session.js';
import type { Environment } from '../policy.js';
import type { VerifiedVerdict } from '../verification.js';

export interface BrowserConfiguration {
  enabled: boolean;
  environment: string;
  endpointUrl: string;
  publicKey: string;
  revision: string;
  protectedPoints: string[];
  protectedPaths: string[];
}
export interface SignedBrowserConfiguration extends BrowserConfiguration {
  environment: Environment;
  signaturePublicKey: string;
  recheckSeconds: number;
  blockSeconds: number;
}
export interface BrowserReply {
  decision: AccessDecision;
  configuration: BrowserConfiguration;
  browserToken: string;
  serverTime: number;
  resourceBound?: boolean;
}
export type AccessOperation = 'preflight' | 'inspect' | 'report' | 'fail' | 'retry' | 'bind' | 'confirm';
export type AccessRequest = (operation: AccessOperation, body: Record<string, unknown>) => Promise<BrowserReply>;
export interface RuntimeOptions {
  request: AccessRequest;
  lockPage?: boolean;
  container?: HTMLElement;
  /** Resolve page scope from the backend reply, without a separate configuration request. */
  shouldProtect?: (configuration: BrowserConfiguration) => boolean;
  onState?: (reply: BrowserReply | null, error?: string) => void;
  onAllowed?: () => Promise<void>;
  /** Called synchronously when verification restarts or access is suspended. Never grants access. */
  onVerificationStart?: () => void;
  storageKey?: string;
  /** Opt in to local signed page access; only a backend reply can grant commerce access. */
  mode?: 'server' | 'signed';
  initialConfiguration?: SignedBrowserConfiguration;
  onLocalVerdict?: (verdict: VerifiedVerdict) => void;
  confirmationTimeoutMs?: number;
}

export interface AccessRuntime {
  start(): Promise<void>;
  refresh(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  /** Backend state only. Local approval never appears here as an allowed grant. */
  getState(): BrowserReply | null;
  bind(): Promise<boolean>;
  destroy(): void;
}
