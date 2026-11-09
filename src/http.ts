import {ApiError, isRecord} from './errors.js';

export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface HttpOptions {
  timeoutMs: number;
  maximumResponseBytes: number;
  transport: HttpTransport;
}

export function validateHttpOptions(options: HttpOptions): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
    || !Number.isSafeInteger(options.maximumResponseBytes) || options.maximumResponseBytes < 1) {
    throw new Error('HTTP timeout and response limit must be positive integers.');
  }
}

/** Bounded transport shared by public and private clients. No retries or payload logging. */
export async function requestJson(url: string, init: RequestInit, options: HttpOptions): Promise<unknown> {
  const controller = new AbortController();
  let status: number | null = null;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError('HideGuard verdict request timed out.', status));
    }, options.timeoutMs);
  });
  const active = () => {
    if (controller.signal.aborted) throw new ApiError('HideGuard verdict request timed out.', status);
  };
  const read = async () => {
    const response = await options.transport(url, {...init, signal: controller.signal});
    if (controller.signal.aborted || !response.ok) {
      void response.body?.cancel().catch(() => undefined);
    }
    active();
    status = response.status;
    if (!response.ok) throw new ApiError(`HideGuard verdict request returned HTTP ${status}.`, status);
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError('HideGuard verdict response is empty.', status);
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener('abort', cancel, {once: true});
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let bytes = 0;
    let body = '';
    try {
      while (true) {
        const chunk = await reader.read();
        active();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > options.maximumResponseBytes) throw new ApiError('HideGuard verdict response is too large.', status);
        body += decoder.decode(chunk.value, {stream: true});
      }
      body += decoder.decode();
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      // Do not let an uncooperative stream delay the timeout or completed response.
      cancel();
    }
    active();
    const losslessIntegers = body.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g,
      (token) => /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token);
    const result: unknown = JSON.parse(losslessIntegers);
    if (!isRecord(result) && !Array.isArray(result)) {
      throw new ApiError('HideGuard verdict response must be a JSON object or array.', status);
    }
    return result;
  };
  try {
    return await Promise.race([read(), timeout]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted ? 'HideGuard verdict request timed out.'
      : 'HideGuard verdict request or JSON response is invalid.', status);
  } finally {
    clearTimeout(timer!);
  }
}
