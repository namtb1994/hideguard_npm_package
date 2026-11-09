export class GuardError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

/** A refused purchase can be waiting for verification rather than a completed failure. */
export class ResourceVerificationError extends GuardError {
  constructor(public readonly verificationStatus: 'required' | 'pending' | 'failed' | 'blocked') {
    super('permission', 'Purchase flow verification is ' + verificationStatus + '.');
  }
}

export class ApiError extends Error {
  constructor(message: string, public readonly statusCode: number | null = null) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, name: string, maximum = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    throw new GuardError('invalid_input', `${name} is invalid.`);
  }
  return value;
}
