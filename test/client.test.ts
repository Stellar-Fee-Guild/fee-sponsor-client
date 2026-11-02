import { FeeBumpTransaction, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  FeeBumpVerificationError,
  FeeSponsorClient,
  HorizonSubmissionError,
  LocalValidationError,
  RelayUnavailableError,
  SponsorRejectedError,
  isPolicyRejection,
  isRateLimited,
} from '../src/index.js';
import type { FeeSponsorClientOptions, SponsorshipRejectionReason } from '../src/index.js';
import {
  HORIZON_URL,
  NETWORK,
  RELAY_URL,
  buildTx,
  calledPaths,
  fakeRelay,
  hex,
  jsonResponse,
  relayFeeBump,
} from './helpers.js';

function makeClient(fetchImpl: typeof fetch, extra: Partial<FeeSponsorClientOptions> = {}) {
  return new FeeSponsorClient({
    relayUrl: RELAY_URL,
    networkPassphrase: NETWORK,
    horizonUrl: HORIZON_URL,
    fetch: fetchImpl,
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
    ...extra,
  });
}

async function catchErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject');
}

describe('constructor', () => {
  const base = { relayUrl: RELAY_URL, networkPassphrase: NETWORK };

  it('normalises URLs', () => {
    const client = new FeeSponsorClient({
      ...base,
      relayUrl: 'https://relay.example.com/api/',
      horizonUrl: 'https://horizon.example.com//',
    });
    expect(client.relayUrl).toBe('https://relay.example.com/api');
    expect(client.horizonUrl).toBe('https://horizon.example.com');
    expect(client.networkPassphrase).toBe(NETWORK);
  });

  it.each([
    [{ relayUrl: 'not a url' }],
    [{ relayUrl: 'ftp://relay.example.com' }],
    [{ relayUrl: 'http://relay.example.com' }],
    [{ horizonUrl: 'http://horizon.example.com' }],
    [{ networkPassphrase: '' }],
    [{ relayUrl: undefined }],
    [{ relayUrl: 'https://relay.example.com/?key=1' }],
    [{ relayUrl: 'https://relay.example.com/#frag' }],
    [{ horizonUrl: 'https://horizon.example.com/?x=1' }],
    [{ timeoutMs: 0 }],
    [{ timeoutMs: Number.POSITIVE_INFINITY }],
    [{ timeoutMs: 2 ** 31 }],
    [{ timeoutMs: '1000' }],
    [{ retry: { retries: -1 } }],
    [{ retry: { baseDelayMs: Number.NaN } }],
    [{ retry: { maxDelayMs: -1 } }],
    [{ sponsorPublicKey: 'GNOTAKEY' }],
  ])('rejects invalid config %j', (override) => {
    const err = (() => {
      try {
        new FeeSponsorClient({ ...base, ...override } as FeeSponsorClientOptions);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(LocalValidationError);
    expect((err as LocalValidationError).code).toBe('INVALID_CONFIG');
  });

  it('reports invalid retry options as INVALID_CONFIG with the original error as cause', () => {
    let err: unknown;
    try {
      new FeeSponsorClient({ ...base, retry: { retries: -1 } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LocalValidationError);
    expect((err as LocalValidationError).message).toMatch(/retry\.retries/);
    expect((err as LocalValidationError).cause).toBeInstanceOf(RangeError);
  });

  it('rejects missing options', () => {
    expect(() => new FeeSponsorClient(undefined as unknown as FeeSponsorClientOptions)).toThrow(
      LocalValidationError,
    );
  });

  it('allows http for localhost, or anywhere with allowInsecureHttp', () => {
    for (const relayUrl of [
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
      'http://relay.localhost',
    ]) {
      expect(() => new FeeSponsorClient({ ...base, relayUrl })).not.toThrow();
    }
    expect(
      () =>
        new FeeSponsorClient({
          ...base,
          relayUrl: 'http://relay.internal',
          allowInsecureHttp: true,
        }),
    ).not.toThrow();
  });

  it('fails clearly when no fetch is available', () => {
    vi.stubGlobal('fetch', undefined);
    try {
      expect(() => new FeeSponsorClient(base)).toThrow(/fetch/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the global fetch by default', async () => {
    const relay = fakeRelay();
    vi.stubGlobal('fetch', relay.fetch);
    try {
      const client = new FeeSponsorClient(base);
      await expect(client.health()).resolves.toBe(relay.sponsor.publicKey());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('health()', () => {
  it('returns the sponsor public key', async () => {
    const relay = fakeRelay();
    const client = makeClient(relay.fetch);
    await expect(client.health()).resolves.toBe(relay.sponsor.publicKey());
    const [url, init] = relay.fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${RELAY_URL}/health`);
    expect(init?.method).toBe('GET');
  });

  it.each([
    [
      'bad status',
      () => jsonResponse({ status: 'degraded', sponsorPublicKey: Keypair.random().publicKey() }),
    ],
    ['bad key', () => jsonResponse({ status: 'ok', sponsorPublicKey: 'nope' })],
    ['not JSON', () => new Response('ok', { status: 200 })],
    ['404', () => jsonResponse({ status: 'ok' }, 404)],
  ])('throws RelayUnavailableError on %s', async (_name, healthResponse) => {
    const client = makeClient(fakeRelay({ healthResponse }).fetch);
    await expect(client.health()).rejects.toBeInstanceOf(RelayUnavailableError);
  });

  it('retries 5xx', async () => {
    let calls = 0;
    const sponsor = Keypair.random();
    const relay = fakeRelay({
      healthResponse: () =>
        ++calls === 1
          ? new Response('', { status: 503 })
          : jsonResponse({ status: 'ok', sponsorPublicKey: sponsor.publicKey() }),
    });
    await expect(makeClient(relay.fetch).health()).resolves.toBe(sponsor.publicKey());
    expect(calls).toBe(2);
  });
});

describe('sponsor()', () => {
  it('sponsors a signed Transaction and verifies the fee bump', async () => {
    const relay = fakeRelay();
    const client = makeClient(relay.fetch);
    const tx = buildTx({ operations: 2, feePerOp: 150 });

    const result = await client.sponsor(tx);

    expect(result.feeBump).toBeInstanceOf(FeeBumpTransaction);
    expect(result.feeBump.feeSource).toBe(relay.sponsor.publicKey());
    expect(hex(result.feeBump.innerTransaction.hash())).toBe(hex(tx.hash()));
    expect(result.feeBumpXdr).toBe(result.feeBump.toEnvelope().toXDR('base64'));
    expect(result.sourceAccount).toBe(tx.source);
    expect(result.innerFeeStroops).toBe(300);
    expect(result.sponsorFeeStroops).toBe(450);
    expect(result.verified).toBe(true);
    expect(calledPaths(relay.fetch)).toEqual(['/sponsor', '/health']);
  });

  it('sends exactly { transaction: <signed envelope XDR> } as JSON', async () => {
    const relay = fakeRelay();
    const client = makeClient(relay.fetch, { headers: { 'X-Api-Key': 'k' } });
    const tx = buildTx();
    await client.sponsor(tx);

    const [url, init] = relay.fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${RELAY_URL}/sponsor`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      transaction: tx.toEnvelope().toXDR('base64'),
    });
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Api-Key': 'k',
    });
  });

  it('accepts a base64 XDR string', async () => {
    const relay = fakeRelay();
    const tx = buildTx();
    const result = await makeClient(relay.fetch).sponsor(tx.toEnvelope().toXDR('base64'));
    expect(hex(result.feeBump.innerTransaction.hash())).toBe(hex(tx.hash()));
  });

  it('caches the sponsor key from /health across calls', async () => {
    const relay = fakeRelay();
    const client = makeClient(relay.fetch);
    await client.sponsor(buildTx());
    await client.sponsor(buildTx());
    expect(calledPaths(relay.fetch).filter((p) => p === '/health')).toHaveLength(1);
  });

  it('reuses the key from an explicit health() call', async () => {
    const relay = fakeRelay();
    const client = makeClient(relay.fetch);
    await client.health();
    await client.sponsor(buildTx());
    expect(calledPaths(relay.fetch)).toEqual(['/health', '/sponsor']);
  });

  it('does not cache a failed /health lookup', async () => {
    let healthy = false;
    const sponsor = Keypair.random();
    const relay = fakeRelay({
      sponsor,
      healthResponse: () =>
        healthy
          ? jsonResponse({ status: 'ok', sponsorPublicKey: sponsor.publicKey() })
          : jsonResponse({}, 404),
    });
    const client = makeClient(relay.fetch);
    await expect(client.sponsor(buildTx())).rejects.toBeInstanceOf(RelayUnavailableError);
    healthy = true;
    await expect(client.sponsor(buildTx())).resolves.toMatchObject({ verified: true });
  });

  it('uses a pinned sponsorPublicKey instead of /health', async () => {
    const relay = fakeRelay();
    const client = makeClient(relay.fetch, { sponsorPublicKey: relay.sponsor.publicKey() });
    await client.sponsor(buildTx());
    expect(calledPaths(relay.fetch)).toEqual(['/sponsor']);
  });

  it('rejects a fee bump from a different key than the pinned one, even if /health agrees', async () => {
    const relay = fakeRelay();
    const client = makeClient(relay.fetch, { sponsorPublicKey: Keypair.random().publicKey() });
    const err = await catchErr(client.sponsor(buildTx()));
    expect(err).toBeInstanceOf(FeeBumpVerificationError);
    expect((err as FeeBumpVerificationError).code).toBe('FEE_SOURCE_MISMATCH');
  });

  it('skips verification (and /health) with verify: false', async () => {
    const relay = fakeRelay({ feeBump: (_inner, sponsor) => relayFeeBump(buildTx(), sponsor) });
    const result = await makeClient(relay.fetch).sponsor(buildTx(), { verify: false });
    expect(result.verified).toBe(false);
    expect(calledPaths(relay.fetch)).toEqual(['/sponsor']);
  });

  it('falls back to local values when the relay omits optional fields', async () => {
    const sponsor = Keypair.random();
    const tx = buildTx();
    const relay = fakeRelay({
      sponsor,
      sponsorResponse: () =>
        jsonResponse({
          approved: true,
          feeBumpTransactionXdr: relayFeeBump(tx, sponsor).toEnvelope().toXDR('base64'),
        }),
    });
    const result = await makeClient(relay.fetch).sponsor(tx);
    expect(result.sourceAccount).toBe(tx.source);
    expect(result.innerFeeStroops).toBe(100);
  });

  describe('local validation (nothing is sent)', () => {
    it.each([
      ['unsigned', () => buildTx({ signers: [] }), 'NOT_SIGNED'],
      ['wrong network', () => buildTx({ network: Networks.PUBLIC }), 'NETWORK_MISMATCH'],
      ['fee bump', () => relayFeeBump(buildTx(), Keypair.random()), 'FEE_BUMP_NOT_ALLOWED'],
      ['bad XDR', () => 'AAAA', 'INVALID_XDR'],
    ])('%s', async (_name, make, code) => {
      const relay = fakeRelay();
      const err = await catchErr(makeClient(relay.fetch).sponsor(make() as never));
      expect(err).toBeInstanceOf(LocalValidationError);
      expect((err as LocalValidationError).code).toBe(code);
      expect(relay.fetch).not.toHaveBeenCalled();
    });
  });

  describe('relay rejections', () => {
    const REASONS: Array<[SponsorshipRejectionReason, number]> = [
      ['INVALID_TRANSACTION_XDR', 400],
      ['INVALID_INNER_TRANSACTION', 400],
      ['DENYLISTED_ACCOUNT', 403],
      ['NOT_ALLOWLISTED', 403],
      ['FEE_EXCEEDS_MAX', 403],
      ['HOURLY_CAP_EXCEEDED', 403],
      ['DAILY_CAP_EXCEEDED', 403],
      ['ACCOUNT_RATE_LIMITED', 429],
      ['IP_RATE_LIMITED', 429],
    ];

    it.each(REASONS)('%s (HTTP %i) → SponsorRejectedError, not retried', async (reason, status) => {
      const source = Keypair.random();
      const relay = fakeRelay({
        sponsorResponse: () =>
          jsonResponse(
            {
              approved: false,
              reason,
              detail: `detail for ${reason}`,
              sourceAccount: source.publicKey(),
              innerFeeStroops: 500000,
            },
            status,
          ),
      });
      const err = await catchErr(makeClient(relay.fetch).sponsor(buildTx({ source })));

      expect(err).toBeInstanceOf(SponsorRejectedError);
      expect(err).toMatchObject({
        reason,
        status,
        detail: `detail for ${reason}`,
        sourceAccount: source.publicKey(),
        innerFeeStroops: 500000,
      });
      expect(isRateLimited(err)).toBe(status === 429);
      expect(isPolicyRejection(err)).toBe(status === 403);
      expect(relay.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries 429 when retryOnRateLimit is enabled', async () => {
      let calls = 0;
      const sponsor = Keypair.random();
      const tx = buildTx();
      const relay = fakeRelay({
        sponsor,
        sponsorResponse: () =>
          ++calls === 1
            ? jsonResponse({ approved: false, reason: 'IP_RATE_LIMITED' }, 429)
            : jsonResponse({
                approved: true,
                feeBumpTransactionXdr: relayFeeBump(tx, sponsor).toEnvelope().toXDR('base64'),
              }),
      });
      const client = makeClient(relay.fetch, {
        retry: { retryOnRateLimit: true, baseDelayMs: 1, maxDelayMs: 2 },
      });
      await expect(client.sponsor(tx)).resolves.toMatchObject({ verified: true });
      expect(calls).toBe(2);
    });

    it('keeps unknown reasons and tolerates missing optional fields', async () => {
      const relay = fakeRelay({
        sponsorResponse: () => jsonResponse({ approved: false, reason: 'NEW_REASON' }, 403),
      });
      const err = (await catchErr(
        makeClient(relay.fetch).sponsor(buildTx()),
      )) as SponsorRejectedError;
      expect(err.reason).toBe('NEW_REASON');
      expect(err.detail).toBeUndefined();
      expect(err.sourceAccount).toBeUndefined();
      expect(err.innerFeeStroops).toBeUndefined();
      expect(isPolicyRejection(err)).toBe(false);
    });

    it('uses UNKNOWN when the rejection has no reason', async () => {
      const relay = fakeRelay({
        sponsorResponse: () => jsonResponse({ approved: false }, 400),
      });
      const err = (await catchErr(
        makeClient(relay.fetch).sponsor(buildTx()),
      )) as SponsorRejectedError;
      expect(err.reason).toBe('UNKNOWN');
    });
  });

  describe('relay unavailable', () => {
    it.each([
      ['HTML 429 from a proxy', () => new Response('<html>slow down</html>', { status: 429 })],
      ['404', () => new Response('Not Found', { status: 404 })],
      ['200 with non-JSON body', () => new Response('ok', { status: 200 })],
      ['200 with approved: false', () => jsonResponse({ approved: false })],
      ['200 without XDR', () => jsonResponse({ approved: true })],
      ['400 without approved: false', () => jsonResponse({ error: 'bad' }, 400)],
      ['JSON array body', () => jsonResponse([], 403)],
    ])('%s → RelayUnavailableError', async (_name, sponsorResponse) => {
      const err = await catchErr(
        makeClient(fakeRelay({ sponsorResponse }).fetch).sponsor(buildTx()),
      );
      expect(err).toBeInstanceOf(RelayUnavailableError);
    });

    it('an HTML 429 still counts as rate limited', async () => {
      const relay = fakeRelay({
        sponsorResponse: () => new Response('slow down', { status: 429 }),
      });
      const err = await catchErr(makeClient(relay.fetch).sponsor(buildTx()));
      expect(isRateLimited(err)).toBe(true);
    });

    it('retries 5xx and network errors, then gives up', async () => {
      let calls = 0;
      const relay = fakeRelay({
        sponsorResponse: () => {
          calls++;
          if (calls % 2) throw new TypeError('fetch failed');
          return new Response('', { status: 500 });
        },
      });
      const err = await catchErr(makeClient(relay.fetch).sponsor(buildTx()));
      expect(err).toBeInstanceOf(RelayUnavailableError);
      expect(calls).toBe(3);
    });

    it('honours retry: false', async () => {
      const relay = fakeRelay({ sponsorResponse: () => new Response('', { status: 503 }) });
      const client = makeClient(relay.fetch, { retry: false });
      await expect(client.sponsor(buildTx())).rejects.toBeInstanceOf(RelayUnavailableError);
      expect(relay.fetch).toHaveBeenCalledTimes(1);
    });

    it('times out', async () => {
      const relay = fakeRelay({ sponsorResponse: () => new Promise<Response>(() => {}) });
      const client = makeClient(relay.fetch, { timeoutMs: 5, retry: false });
      const err = await catchErr(client.sponsor(buildTx()));
      expect(err).toBeInstanceOf(RelayUnavailableError);
      expect((err as Error).message).toContain('timed out');
    });
  });

  describe('fee bump verification', () => {
    async function expectVerificationFailure(
      relay: ReturnType<typeof fakeRelay>,
      code: FeeBumpVerificationError['code'],
    ) {
      const err = await catchErr(makeClient(relay.fetch).sponsor(buildTx()));
      expect(err).toBeInstanceOf(FeeBumpVerificationError);
      expect((err as FeeBumpVerificationError).code).toBe(code);
    }

    it('throws when the relay wraps a DIFFERENT transaction', async () => {
      const relay = fakeRelay({
        feeBump: (_inner, sponsor) => relayFeeBump(buildTx(), sponsor),
      });
      await expectVerificationFailure(relay, 'INNER_TRANSACTION_MISMATCH');
    });

    it('throws when the relay strips or changes inner signatures', async () => {
      const relay = fakeRelay({
        feeBump: (inner, sponsor) => {
          inner.signatures.push(inner.signatures[0]!);
          return relayFeeBump(inner, sponsor);
        },
      });
      await expectVerificationFailure(relay, 'INNER_TRANSACTION_MISMATCH');
    });

    it('throws when the fee source is not the sponsor from /health', async () => {
      const relay = fakeRelay({ feeBump: (inner) => relayFeeBump(inner, Keypair.random()) });
      await expectVerificationFailure(relay, 'FEE_SOURCE_MISMATCH');
    });

    it('throws when the fee does not match the cost formula', async () => {
      const relay = fakeRelay({
        feeBump: (inner, sponsor) => relayFeeBump(inner, sponsor, { baseFee: 1000 }),
      });
      await expectVerificationFailure(relay, 'FEE_MISMATCH');
    });

    it('throws when the fee bump is not signed by the sponsor', async () => {
      const relay = fakeRelay({
        feeBump: (inner, sponsor) => relayFeeBump(inner, sponsor, { sign: false }),
      });
      await expectVerificationFailure(relay, 'MISSING_SPONSOR_SIGNATURE');
    });

    it('throws when the sponsor signed for another network', async () => {
      const relay = fakeRelay({
        feeBump: (inner, sponsor) => {
          const other = TransactionBuilder.buildFeeBumpTransaction(
            sponsor,
            String(Number(inner.fee) / inner.operations.length),
            inner,
            Networks.PUBLIC,
          );
          other.sign(sponsor);
          return other.toEnvelope().toXDR('base64');
        },
      });
      await expectVerificationFailure(relay, 'MISSING_SPONSOR_SIGNATURE');
    });

    it('throws when the relay returns a plain transaction instead of a fee bump', async () => {
      const relay = fakeRelay({ feeBump: (inner) => inner });
      await expectVerificationFailure(relay, 'INVALID_FEE_BUMP');
    });

    it('throws when the relay returns garbage XDR', async () => {
      const relay = fakeRelay({ feeBump: () => 'not-xdr' });
      await expectVerificationFailure(relay, 'INVALID_FEE_BUMP');
    });

    it('rejects a non-fee-bump even with verify: false', async () => {
      const relay = fakeRelay({ feeBump: (inner) => inner });
      const err = await catchErr(makeClient(relay.fetch).sponsor(buildTx(), { verify: false }));
      expect(err).toBeInstanceOf(FeeBumpVerificationError);
    });
  });
});

describe('verifyFeeBump()', () => {
  it('passes for a correct fee bump, given a Transaction or XDR', async () => {
    const relay = fakeRelay();
    const client = makeClient(relay.fetch);
    const tx = buildTx({ operations: 3, feePerOp: 101 });
    const feeBump = relayFeeBump(tx, relay.sponsor);
    await expect(client.verifyFeeBump(feeBump, tx)).resolves.toBeUndefined();
    await expect(
      client.verifyFeeBump(feeBump, tx.toEnvelope().toXDR('base64')),
    ).resolves.toBeUndefined();
  });

  it('rejects something that is not a fee bump', async () => {
    const relay = fakeRelay();
    const tx = buildTx();
    const err = await catchErr(
      makeClient(relay.fetch).verifyFeeBump(tx as unknown as FeeBumpTransaction, tx),
    );
    expect((err as FeeBumpVerificationError).code).toBe('INVALID_FEE_BUMP');
  });
});

describe('estimateSponsorCost()', () => {
  const client = makeClient(fakeRelay().fetch);

  it.each([
    [1, 100, 200],
    [2, 100, 300],
    [5, 1000, 6000],
  ])('%i ops at %i stroops/op → %i', (operations, feePerOp, expected) => {
    expect(client.estimateSponsorCost(buildTx({ operations, feePerOp }))).toBe(expected);
  });

  it('works on unsigned transactions and XDR', () => {
    const tx = buildTx({ signers: [], operations: 2 });
    expect(client.estimateSponsorCost(tx.toEnvelope().toXDR('base64'))).toBe(300);
  });

  it('rejects fee bumps', () => {
    expect(() =>
      client.estimateSponsorCost(relayFeeBump(buildTx(), Keypair.random()) as never),
    ).toThrow(LocalValidationError);
  });
});

describe('submit()', () => {
  function horizon(response: () => Response | Promise<Response>) {
    const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
    return fn as unknown as typeof fetch & typeof fn;
  }

  it('POSTs the fee bump to Horizon /transactions as a form', async () => {
    const relay = fakeRelay();
    const feeBump = relayFeeBump(buildTx(), relay.sponsor);
    const fetchImpl = horizon(() =>
      jsonResponse({ hash: 'abc', ledger: 123, successful: true, result_xdr: 'AAAA' }),
    );
    const result = await makeClient(fetchImpl).submit(feeBump);

    expect(result).toMatchObject({ hash: 'abc', ledger: 123, successful: true, resultXdr: 'AAAA' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${HORIZON_URL}/transactions`);
    expect(init?.method).toBe('POST');
    const form = new URLSearchParams(String(init?.body));
    expect(form.get('tx')).toBe(feeBump.toEnvelope().toXDR('base64'));
    expect(init?.headers).not.toHaveProperty('X-Api-Key');
  });

  it('accepts XDR and fills defaults for missing fields', async () => {
    const fetchImpl = horizon(() => jsonResponse({ hash: 'abc' }));
    const result = await makeClient(fetchImpl).submit('AAAA');
    expect(result).toMatchObject({ hash: 'abc', ledger: 0, successful: true, resultXdr: '' });
  });

  it('maps Horizon errors to HorizonSubmissionError with result codes', async () => {
    const fetchImpl = horizon(() =>
      jsonResponse(
        {
          title: 'Transaction Failed',
          extras: {
            result_codes: {
              transaction: 'tx_fee_bump_inner_failed',
              inner_transaction: 'tx_bad_seq',
            },
            result_xdr: 'BBBB',
          },
        },
        400,
      ),
    );
    const err = (await catchErr(makeClient(fetchImpl).submit('AAAA'))) as HorizonSubmissionError;
    expect(err).toBeInstanceOf(HorizonSubmissionError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('Transaction Failed');
    expect(err.message).toContain('tx_fee_bump_inner_failed');
    expect(err.resultCodes?.inner_transaction).toBe('tx_bad_seq');
    expect(err.resultXdr).toBe('BBBB');
  });

  it('handles non-JSON Horizon errors', async () => {
    const fetchImpl = horizon(() => new Response('gateway timeout', { status: 504 }));
    const err = (await catchErr(makeClient(fetchImpl).submit('AAAA'))) as HorizonSubmissionError;
    expect(err.status).toBe(504);
    expect(err.resultCodes).toBeUndefined();
  });

  it('handles Horizon errors without extras', async () => {
    const fetchImpl = horizon(() => jsonResponse({ title: 'Bad Request' }, 400));
    const err = (await catchErr(makeClient(fetchImpl).submit('AAAA'))) as HorizonSubmissionError;
    expect(err.resultCodes).toBeUndefined();
    expect(err.resultXdr).toBeUndefined();
  });

  it('wraps network failures and does not retry', async () => {
    const fetchImpl = horizon(() => {
      throw new TypeError('fetch failed');
    });
    const err = await catchErr(makeClient(fetchImpl).submit('AAAA'));
    expect(err).toBeInstanceOf(HorizonSubmissionError);
    expect((err as HorizonSubmissionError).cause).toBeInstanceOf(TypeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires horizonUrl', async () => {
    const client = makeClient(fakeRelay().fetch, { horizonUrl: undefined });
    const err = await catchErr(client.submit('AAAA'));
    expect((err as LocalValidationError).code).toBe('INVALID_CONFIG');
  });
});

describe('sponsorAndSubmit()', () => {
  it('sponsors, verifies, then submits the fee bump', async () => {
    const relay = fakeRelay();
    const submitted: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(HORIZON_URL)) {
        submitted.push(new URLSearchParams(String(init?.body)).get('tx')!);
        return jsonResponse({ hash: 'h', ledger: 1, successful: true, result_xdr: 'R' });
      }
      return relay.fetch(input, init);
    }) as unknown as typeof fetch;

    const tx = buildTx();
    const { sponsorship, submission } = await makeClient(fetchImpl).sponsorAndSubmit(tx);
    expect(sponsorship.verified).toBe(true);
    expect(submission.hash).toBe('h');
    expect(submitted).toEqual([sponsorship.feeBumpXdr]);
  });

  it('does not submit when verification fails', async () => {
    const relay = fakeRelay({ feeBump: (_i, sponsor) => relayFeeBump(buildTx(), sponsor) });
    const err = await catchErr(makeClient(relay.fetch).sponsorAndSubmit(buildTx()));
    expect(err).toBeInstanceOf(FeeBumpVerificationError);
    expect(calledPaths(relay.fetch)).not.toContain('/transactions');
  });

  it('requires horizonUrl before contacting the relay', async () => {
    const relay = fakeRelay();
    const client = makeClient(relay.fetch, { horizonUrl: undefined });
    await expect(client.sponsorAndSubmit(buildTx())).rejects.toBeInstanceOf(LocalValidationError);
    expect(relay.fetch).not.toHaveBeenCalled();
  });
});
