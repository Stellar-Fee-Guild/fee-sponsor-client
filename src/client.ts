import { StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import type { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk';
import {
  FeeBumpVerificationError,
  HorizonSubmissionError,
  LocalValidationError,
  RelayUnavailableError,
  SponsorRejectedError,
} from './errors.js';
import { fetchOnce, requestWithRetry, resolveRetry } from './http.js';
import type { ReadResponse, ResolvedRetry } from './http.js';
import type {
  FeeSponsorClientOptions,
  RequestOptions,
  SponsorAndSubmitResult,
  SponsorOptions,
  SponsorResult,
  SubmitResult,
} from './types.js';
import { isFeeBump, parseInnerTransaction, parseTransaction, sponsorCost } from './validation.js';
import type { InnerTransactionInput } from './validation.js';
import { verifyFeeBumpAgainst } from './verify.js';

const DEFAULT_TIMEOUT_MS = 10_000;
/** Horizon holds a submission open until the transaction lands or times out (~30 s+). */
const MIN_SUBMIT_TIMEOUT_MS = 60_000;
const REJECTION_STATUSES = new Set([400, 403, 429]);
/** Largest delay `setTimeout` honours; anything above fires after ~1 ms instead. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

function normalizeBaseUrl(name: string, value: string, allowInsecureHttp: boolean): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LocalValidationError('INVALID_CONFIG', `${name} is required.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new LocalValidationError('INVALID_CONFIG', `${name} is not a valid URL: ${value}`, {
      cause,
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new LocalValidationError('INVALID_CONFIG', `${name} must be an http(s) URL.`);
  }
  if (url.protocol === 'http:' && !allowInsecureHttp && !isLocalHost(url.hostname)) {
    throw new LocalValidationError(
      'INVALID_CONFIG',
      `${name} must use https:// (got ${url.origin}). Set allowInsecureHttp only for local testing.`,
    );
  }
  if (url.search !== '' || url.hash !== '') {
    throw new LocalValidationError(
      'INVALID_CONFIG',
      `${name} must not include a query string or fragment: request paths are appended to it.`,
    );
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * Client for a [fee-sponsor-relay](https://github.com/Stellar-Fee-Guild/fee-sponsor-relay).
 *
 * @example
 * ```ts
 * const client = new FeeSponsorClient({
 *   relayUrl: 'https://relay.example.com',
 *   networkPassphrase: Networks.TESTNET,
 *   horizonUrl: 'https://horizon-testnet.stellar.org',
 * });
 * const { submission } = await client.sponsorAndSubmit(signedTx);
 * ```
 */
export class FeeSponsorClient {
  /** The relay base URL, without a trailing slash. */
  readonly relayUrl: string;
  /** The network passphrase every transaction is checked against. */
  readonly networkPassphrase: string;
  /** The Horizon base URL, if configured. */
  readonly horizonUrl: string | undefined;

  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #headers: Record<string, string>;
  readonly #retry: ResolvedRetry;
  readonly #pinnedSponsorKey: string | undefined;
  #sponsorKey: Promise<string> | undefined;

  constructor(options: FeeSponsorClientOptions) {
    if (!isRecord(options)) {
      throw new LocalValidationError('INVALID_CONFIG', 'FeeSponsorClient options are required.');
    }
    if (typeof options.networkPassphrase !== 'string' || options.networkPassphrase === '') {
      throw new LocalValidationError('INVALID_CONFIG', 'networkPassphrase is required.');
    }
    const insecure = options.allowInsecureHttp === true;
    this.relayUrl = normalizeBaseUrl('relayUrl', options.relayUrl, insecure);
    this.horizonUrl =
      options.horizonUrl === undefined
        ? undefined
        : normalizeBaseUrl('horizonUrl', options.horizonUrl, insecure);
    this.networkPassphrase = options.networkPassphrase;

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new LocalValidationError(
        'INVALID_CONFIG',
        'No fetch implementation available. Pass one with the `fetch` option.',
      );
    }
    // Call through a wrapper so browsers don't throw "Illegal invocation" on an unbound fetch.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || !(timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
      throw new LocalValidationError(
        'INVALID_CONFIG',
        `timeoutMs must be a positive number no larger than ${MAX_TIMER_MS}.`,
      );
    }
    this.#timeoutMs = timeoutMs;
    this.#headers = { ...options.headers };
    try {
      this.#retry = resolveRetry(options.retry);
    } catch (cause) {
      throw new LocalValidationError('INVALID_CONFIG', (cause as Error).message, { cause });
    }

    if (options.sponsorPublicKey !== undefined) {
      if (!StrKey.isValidEd25519PublicKey(options.sponsorPublicKey)) {
        throw new LocalValidationError(
          'INVALID_CONFIG',
          'sponsorPublicKey must be a valid G... public key.',
        );
      }
      this.#pinnedSponsorKey = options.sponsorPublicKey;
    }
  }

  /**
   * Call the relay's `GET /health` and return its sponsor public key. The key is cached for
   * {@link FeeSponsorClient.verifyFeeBump}.
   *
   * @throws {@link RelayUnavailableError} if the relay is unreachable or unhealthy.
   */
  async health(options: RequestOptions = {}): Promise<string> {
    const res = await this.#relayRequest('GET', '/health', undefined, options.signal);
    const body = res.json;
    if (
      res.status !== 200 ||
      !isRecord(body) ||
      body.status !== 'ok' ||
      typeof body.sponsorPublicKey !== 'string' ||
      !StrKey.isValidEd25519PublicKey(body.sponsorPublicKey)
    ) {
      throw new RelayUnavailableError(
        `Relay health check returned an unexpected response (HTTP ${res.status}).`,
        { status: res.status },
      );
    }
    const key = body.sponsorPublicKey;
    this.#sponsorKey = Promise.resolve(key);
    return key;
  }

  /**
   * Ask the relay to sponsor a signed transaction.
   *
   * The transaction is validated locally first (not a fee bump, at least one operation, signed,
   * right network). Unless `verify: false` is passed, the returned fee bump is checked with
   * {@link FeeSponsorClient.verifyFeeBump} before it is returned.
   *
   * @param tx A `Transaction` signed by its source account, or its base64 envelope XDR.
   * @throws {@link LocalValidationError} if the transaction fails a local check (nothing is sent).
   * @throws {@link SponsorRejectedError} if the relay declines (HTTP 400, 403, 429).
   * @throws {@link RelayUnavailableError} on network failures, timeouts, 5xx or malformed responses.
   * @throws {@link FeeBumpVerificationError} if the fee bump doesn't match what was sent.
   */
  async sponsor(tx: InnerTransactionInput, options: SponsorOptions = {}): Promise<SponsorResult> {
    const { tx: inner, xdr } = parseInnerTransaction(tx, this.networkPassphrase);
    const res = await this.#relayRequest(
      'POST',
      '/sponsor',
      JSON.stringify({ transaction: xdr }),
      options.signal,
    );
    const body = res.json;

    if (REJECTION_STATUSES.has(res.status) && isRecord(body) && body.approved === false) {
      throw new SponsorRejectedError({
        reason: typeof body.reason === 'string' ? body.reason : 'UNKNOWN',
        status: res.status,
        detail: optionalString(body.detail),
        sourceAccount: optionalString(body.sourceAccount),
        innerFeeStroops: optionalNumber(body.innerFeeStroops),
      });
    }
    if (
      res.status !== 200 ||
      !isRecord(body) ||
      body.approved !== true ||
      typeof body.feeBumpTransactionXdr !== 'string'
    ) {
      throw new RelayUnavailableError(
        `Relay returned an unexpected response to POST /sponsor (HTTP ${res.status}).`,
        { status: res.status },
      );
    }

    const feeBumpXdr = body.feeBumpTransactionXdr;
    let parsed: Transaction | FeeBumpTransaction;
    try {
      parsed = TransactionBuilder.fromXDR(feeBumpXdr, this.networkPassphrase);
    } catch {
      throw new FeeBumpVerificationError(
        'INVALID_FEE_BUMP',
        'The relay returned XDR that is not a valid transaction envelope.',
      );
    }
    if (!isFeeBump(parsed)) {
      throw new FeeBumpVerificationError(
        'INVALID_FEE_BUMP',
        'The relay returned a transaction that is not a fee bump.',
      );
    }

    const verify = options.verify !== false;
    if (verify) await this.verifyFeeBump(parsed, inner, { signal: options.signal });

    return {
      feeBump: parsed,
      feeBumpXdr,
      sourceAccount: optionalString(body.sourceAccount) ?? inner.source,
      innerFeeStroops: optionalNumber(body.innerFeeStroops) ?? Number(inner.fee),
      sponsorFeeStroops: Number(parsed.fee),
      verified: verify,
    };
  }

  /**
   * Check that a fee bump wraps exactly `inner`, is paid and signed by the relay's sponsor key,
   * and charges the expected fee ({@link FeeSponsorClient.estimateSponsorCost}).
   *
   * The sponsor key comes from the `sponsorPublicKey` option if set, otherwise from `GET /health`
   * (fetched once and cached).
   *
   * @throws {@link FeeBumpVerificationError} if any check fails.
   */
  async verifyFeeBump(
    feeBump: FeeBumpTransaction,
    inner: InnerTransactionInput,
    options: RequestOptions = {},
  ): Promise<void> {
    const innerTx = parseTransaction(inner, this.networkPassphrase);
    const sponsorKey = await this.#getSponsorKey(options.signal);
    verifyFeeBumpAgainst(feeBump, innerTx, sponsorKey);
  }

  /**
   * Submit a fee bump to Horizon. Requires `horizonUrl`. Not retried automatically: on a timeout
   * the transaction may still be included, so check its hash before resubmitting.
   *
   * @throws {@link HorizonSubmissionError} if Horizon rejects the transaction or can't be reached.
   */
  async submit(
    feeBump: FeeBumpTransaction | string,
    options: RequestOptions = {},
  ): Promise<SubmitResult> {
    if (this.horizonUrl === undefined) {
      throw new LocalValidationError(
        'INVALID_CONFIG',
        'horizonUrl is required to submit transactions.',
      );
    }
    const xdr = typeof feeBump === 'string' ? feeBump : feeBump.toEnvelope().toXDR('base64');

    let res: ReadResponse;
    try {
      res = await fetchOnce(
        this.#fetch,
        `${this.horizonUrl}/transactions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: `tx=${encodeURIComponent(xdr)}`,
        },
        Math.max(this.#timeoutMs, MIN_SUBMIT_TIMEOUT_MS),
        options.signal,
        'Horizon submission',
      );
    } catch (err) {
      const e = err as RelayUnavailableError;
      throw new HorizonSubmissionError(e.message, { cause: e.cause });
    }

    const body = res.json;
    if (res.status >= 200 && res.status < 300 && isRecord(body) && typeof body.hash === 'string') {
      return {
        hash: body.hash,
        ledger: optionalNumber(body.ledger) ?? 0,
        successful: body.successful !== false,
        resultXdr: optionalString(body.result_xdr) ?? '',
        raw: body,
      };
    }

    const extras = isRecord(body) && isRecord(body.extras) ? body.extras : undefined;
    const title = isRecord(body) ? optionalString(body.title) : undefined;
    const codes = extras && isRecord(extras.result_codes) ? extras.result_codes : undefined;
    const txCode = codes ? optionalString(codes.transaction) : undefined;
    throw new HorizonSubmissionError(
      `Horizon rejected the transaction (HTTP ${res.status})${title ? `: ${title}` : ''}${txCode ? ` [${txCode}]` : ''}`,
      {
        status: res.status,
        resultCodes: codes as HorizonSubmissionError['resultCodes'],
        resultXdr: extras ? optionalString(extras.result_xdr) : undefined,
      },
    );
  }

  /**
   * {@link FeeSponsorClient.sponsor} then {@link FeeSponsorClient.submit}. The fee bump is always
   * verified before submission.
   */
  async sponsorAndSubmit(
    tx: InnerTransactionInput,
    options: RequestOptions = {},
  ): Promise<SponsorAndSubmitResult> {
    if (this.horizonUrl === undefined) {
      throw new LocalValidationError(
        'INVALID_CONFIG',
        'horizonUrl is required to submit transactions.',
      );
    }
    const sponsorship = await this.sponsor(tx, { signal: options.signal });
    const submission = await this.submit(sponsorship.feeBump, { signal: options.signal });
    return { sponsorship, submission };
  }

  /**
   * What the sponsor will pay for this transaction, in stroops, computed locally with the relay's
   * formula: `ceil(innerFee / opCount) * (opCount + 1)`. Works on unsigned transactions.
   *
   * @throws {@link LocalValidationError} if the transaction can't be parsed, is a fee bump, or has
   *   no operations.
   */
  estimateSponsorCost(tx: InnerTransactionInput): number {
    const parsed = parseTransaction(tx, this.networkPassphrase);
    return sponsorCost(Number(parsed.fee), parsed.operations.length);
  }

  #getSponsorKey(signal: AbortSignal | undefined): Promise<string> {
    if (this.#pinnedSponsorKey !== undefined) return Promise.resolve(this.#pinnedSponsorKey);
    if (this.#sponsorKey === undefined) {
      const pending = this.health({ signal });
      this.#sponsorKey = pending;
      pending.catch(() => {
        if (this.#sponsorKey === pending) this.#sponsorKey = undefined;
      });
    }
    return this.#sponsorKey;
  }

  #relayRequest(
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ReadResponse> {
    const headers: Record<string, string> = { Accept: 'application/json', ...this.#headers };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return requestWithRetry(
      this.#fetch,
      `${this.relayUrl}${path}`,
      { method, headers, body },
      { timeoutMs: this.#timeoutMs, retry: this.#retry, signal, label: `${method} ${path}` },
    );
  }
}
