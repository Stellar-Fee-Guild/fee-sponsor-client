import { describe, expect, it, vi } from 'vitest';
import { RelayUnavailableError } from '../src/errors.js';
import {
  DEFAULT_RETRY,
  backoffDelay,
  parseRetryAfter,
  requestWithRetry,
  resolveRetry,
  sleep,
} from '../src/http.js';
import type { ResolvedRetry } from '../src/http.js';
import { jsonResponse } from './helpers.js';

const FAST: ResolvedRetry = { retries: 3, baseDelayMs: 1, maxDelayMs: 5, retryOnRateLimit: false };

function run(
  fetchImpl: typeof fetch,
  retry: ResolvedRetry = FAST,
  signal?: AbortSignal,
  timeoutMs = 1000,
) {
  return requestWithRetry(
    fetchImpl,
    'https://relay.test/sponsor',
    { method: 'POST' },
    {
      timeoutMs,
      retry,
      signal,
      label: 'POST /sponsor',
    },
  );
}

function sequence(...steps: Array<Response | Error>) {
  const fn = vi.fn(async () => {
    const step = steps.shift();
    if (step === undefined) throw new Error('no more responses');
    if (step instanceof Error) throw step;
    return step;
  });
  return fn as unknown as typeof fetch & typeof fn;
}

/** A fetch that never resolves until its signal aborts. */
function hangingFetch() {
  const fn = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );
  return fn as unknown as typeof fetch & typeof fn;
}

describe('resolveRetry', () => {
  it('defaults: 2 retries, 429 not retried', () => {
    expect(resolveRetry(undefined)).toEqual(DEFAULT_RETRY);
    expect(DEFAULT_RETRY.retryOnRateLimit).toBe(false);
  });
  it('false disables retries', () => {
    expect(resolveRetry(false).retries).toBe(0);
  });
  it('merges partial options and ignores undefined', () => {
    expect(resolveRetry({ retries: 5, baseDelayMs: undefined })).toEqual({
      ...DEFAULT_RETRY,
      retries: 5,
    });
  });
  it('rejects invalid retry counts', () => {
    expect(() => resolveRetry({ retries: -1 })).toThrow(RangeError);
    expect(() => resolveRetry({ retries: 1.5 })).toThrow(RangeError);
  });
  it('rejects delays setTimeout cannot represent', () => {
    expect(() => resolveRetry({ baseDelayMs: -1 })).toThrow(RangeError);
    expect(() => resolveRetry({ baseDelayMs: Number.NaN })).toThrow(RangeError);
    expect(() => resolveRetry({ maxDelayMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(resolveRetry({ baseDelayMs: 0, maxDelayMs: 0 })).toMatchObject({
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
  });
});

describe('backoffDelay', () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1000 };
  it('grows exponentially with jitter between half and full delay', () => {
    expect(backoffDelay(0, opts, () => 0)).toBe(50);
    expect(backoffDelay(0, opts, () => 1)).toBe(100);
    expect(backoffDelay(2, opts, () => 0)).toBe(200);
    expect(backoffDelay(2, opts, () => 1)).toBe(400);
  });
  it('is capped at maxDelayMs', () => {
    expect(backoffDelay(10, opts, () => 1)).toBe(1000);
  });
  it('uses Math.random by default', () => {
    const d = backoffDelay(1, opts);
    expect(d).toBeGreaterThanOrEqual(100);
    expect(d).toBeLessThanOrEqual(200);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('-5')).toBe(0);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0);
  });
  it('ignores missing or garbage values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(' ')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });
  it('rejects immediately on an aborted signal', async () => {
    await expect(sleep(1000, AbortSignal.abort(new Error('stop')))).rejects.toThrow('stop');
  });
  it('rejects when the signal aborts mid-sleep', async () => {
    const ctrl = new AbortController();
    const p = sleep(10_000, ctrl.signal);
    ctrl.abort(new Error('cancelled'));
    await expect(p).rejects.toThrow('cancelled');
  });
  it('uses a default reason when none is given', async () => {
    const signal = { aborted: true, reason: undefined } as unknown as AbortSignal;
    await expect(sleep(1, signal)).rejects.toThrow('Aborted');
  });
});

describe('requestWithRetry', () => {
  it('returns a successful response with parsed JSON', async () => {
    const res = await run(sequence(jsonResponse({ ok: true })));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
  });

  it('leaves json undefined for non-JSON and empty bodies', async () => {
    const res = await run(sequence(new Response('<html>', { status: 404 })));
    expect(res.json).toBeUndefined();
    expect(res.text).toBe('<html>');
    const empty = await run(sequence(new Response('', { status: 404 })));
    expect(empty.json).toBeUndefined();
  });

  it('retries network errors, then succeeds', async () => {
    const fetchImpl = sequence(new TypeError('fetch failed'), jsonResponse({ ok: true }));
    const res = await run(fetchImpl);
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries 5xx, then gives up with RelayUnavailableError', async () => {
    const fetchImpl = sequence(
      ...Array.from({ length: 4 }, () => new Response('bad gateway', { status: 502 })),
    );
    const err = await run(fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayUnavailableError);
    expect((err as RelayUnavailableError).status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('throws the last network error after exhausting retries', async () => {
    const fetchImpl = sequence(new TypeError('a'), new TypeError('b'));
    const err = await run(fetchImpl, { ...FAST, retries: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayUnavailableError);
    expect((err as RelayUnavailableError).message).toContain('network error');
    expect((err as RelayUnavailableError).cause).toBeInstanceOf(TypeError);
  });

  it('does not retry when retries is 0', async () => {
    const fetchImpl = sequence(new Response('', { status: 503 }));
    await expect(run(fetchImpl, { ...FAST, retries: 0 })).rejects.toBeInstanceOf(
      RelayUnavailableError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([400, 403, 404])('never retries HTTP %i', async (status) => {
    const fetchImpl = sequence(jsonResponse({ approved: false }, status), jsonResponse({}));
    const res = await run(fetchImpl);
    expect(res.status).toBe(status);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry 429 by default', async () => {
    const fetchImpl = sequence(jsonResponse({ approved: false }, 429), jsonResponse({}));
    const res = await run(fetchImpl);
    expect(res.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 429 when retryOnRateLimit is set, honouring Retry-After', async () => {
    const fetchImpl = sequence(
      jsonResponse({ approved: false }, 429, { 'Retry-After': '0' }),
      jsonResponse({ approved: false }, 429),
      jsonResponse({ ok: true }),
    );
    const res = await run(fetchImpl, { ...FAST, retryOnRateLimit: true });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('caps Retry-After at maxDelayMs', async () => {
    const fetchImpl = sequence(
      jsonResponse({}, 429, { 'Retry-After': '3600' }),
      jsonResponse({ ok: true }),
    );
    const started = Date.now();
    await run(fetchImpl, { ...FAST, retryOnRateLimit: true, maxDelayMs: 10 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns the final 429 once rate-limit retries are exhausted', async () => {
    const fetchImpl = sequence(jsonResponse({}, 429), jsonResponse({}, 429));
    const res = await run(fetchImpl, { ...FAST, retries: 1, retryOnRateLimit: true });
    expect(res.status).toBe(429);
  });

  it('times out slow requests and retries them', async () => {
    const fetchImpl = hangingFetch();
    const err = await run(fetchImpl, { ...FAST, retries: 1 }, undefined, 5).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RelayUnavailableError);
    expect((err as Error).message).toContain('timed out after 5 ms');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops immediately when the caller aborts, without retrying', async () => {
    const ctrl = new AbortController();
    const fetchImpl = hangingFetch();
    const p = run(fetchImpl, FAST, ctrl.signal);
    ctrl.abort();
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayUnavailableError);
    expect((err as Error).message).toContain('aborted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honours an already-aborted signal', async () => {
    await expect(run(hangingFetch(), FAST, AbortSignal.abort())).rejects.toThrow('aborted');
  });

  it('stops when the caller aborts during backoff', async () => {
    const ctrl = new AbortController();
    const fetchImpl = vi.fn(async () => {
      queueMicrotask(() => ctrl.abort());
      return new Response('', { status: 503 });
    });
    const err = await run(
      fetchImpl as unknown as typeof fetch,
      { ...FAST, baseDelayMs: 10_000, maxDelayMs: 10_000 },
      ctrl.signal,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayUnavailableError);
    expect((err as Error).message).toContain('aborted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
