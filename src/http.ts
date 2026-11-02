import { RelayUnavailableError } from './errors.js';
import type { RetryOptions } from './types.js';

/** A fully-read HTTP response. `json` is `undefined` when the body isn't valid JSON. */
export interface ReadResponse {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

export interface ResolvedRetry {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOnRateLimit: boolean;
}

export const DEFAULT_RETRY: ResolvedRetry = {
  retries: 2,
  baseDelayMs: 250,
  maxDelayMs: 5000,
  retryOnRateLimit: false,
};

export function resolveRetry(retry: RetryOptions | false | undefined): ResolvedRetry {
  if (retry === false) return { ...DEFAULT_RETRY, retries: 0 };
  const resolved = { ...DEFAULT_RETRY, ...stripUndefined(retry ?? {}) };
  if (!Number.isInteger(resolved.retries) || resolved.retries < 0) {
    throw new RangeError('retry.retries must be a non-negative integer');
  }
  return resolved;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Exponential backoff with "equal jitter": half the exponential delay is fixed, half is random.
 * `attempt` is 0 for the first retry.
 */
export function backoffDelay(
  attempt: number,
  opts: Pick<ResolvedRetry, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number = Math.random,
): number {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Parse a `Retry-After` header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Aborted');
}

/** Sleep for `ms`, rejecting early if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Thrown internally when a request is aborted by the caller's signal. */
class CallerAbort extends Error {}

/**
 * Perform one HTTP request with a timeout, reading the whole body.
 * Throws {@link RelayUnavailableError} for network failures, timeouts and caller aborts.
 */
export async function fetchOnce(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<ReadResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${label} timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  const onAbort = (): void => controller.abort(abortReason(signal as AbortSignal));
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });

  // Race against the abort signal too, so a fetch implementation that ignores `signal` still
  // honours the timeout.
  let rejectOnAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
  });
  aborted.catch(() => {});
  if (controller.signal.aborted) rejectOnAbort();
  controller.signal.addEventListener('abort', rejectOnAbort, { once: true });

  try {
    const res = await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      aborted,
    ]);
    const text = await Promise.race([res.text(), aborted]);
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  } catch (cause) {
    if (timedOut) {
      throw new RelayUnavailableError(`${label} timed out after ${timeoutMs} ms`, { cause });
    }
    if (signal?.aborted) {
      throw new RelayUnavailableError(`${label} was aborted`, {
        cause: new CallerAbort(String(abortReason(signal))),
      });
    }
    throw new RelayUnavailableError(`${label} failed: network error`, { cause });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}

/**
 * Request with retries. Retries network errors, timeouts and HTTP 5xx; retries HTTP 429 only when
 * `retryOnRateLimit` is set. Never retries any other status. After the last attempt, 5xx becomes a
 * {@link RelayUnavailableError}; every other response is returned for the caller to classify.
 */
export async function requestWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; retry: ResolvedRetry; signal: AbortSignal | undefined; label: string },
): Promise<ReadResponse> {
  const { retry, signal } = opts;
  for (let attempt = 0; ; attempt++) {
    let res: ReadResponse | undefined;
    let error: RelayUnavailableError | undefined;
    try {
      res = await fetchOnce(fetchImpl, url, init, opts.timeoutMs, signal, opts.label);
    } catch (err) {
      error = err as RelayUnavailableError;
      if (error.cause instanceof CallerAbort) throw error;
    }

    const retryable =
      error !== undefined ||
      (res !== undefined && res.status >= 500) ||
      (res !== undefined && res.status === 429 && retry.retryOnRateLimit);

    if (retryable && attempt < retry.retries) {
      let delay = backoffDelay(attempt, retry);
      if (res?.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        if (retryAfter !== undefined)
          delay = Math.min(retry.maxDelayMs, Math.max(delay, retryAfter));
      }
      try {
        await sleep(delay, signal);
      } catch (cause) {
        throw new RelayUnavailableError(`${opts.label} was aborted`, { cause });
      }
      continue;
    }

    if (error) throw error;
    const final = res as ReadResponse;
    if (final.status >= 500) {
      throw new RelayUnavailableError(`${opts.label} failed with HTTP ${final.status}`, {
        status: final.status,
      });
    }
    return final;
  }
}
