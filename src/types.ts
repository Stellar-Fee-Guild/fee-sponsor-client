import type { FeeBumpTransaction } from '@stellar/stellar-sdk';

/**
 * Every `reason` a fee-sponsor-relay can return when it declines to sponsor a transaction.
 *
 * | reason                      | HTTP |
 * | --------------------------- | ---- |
 * | `INVALID_TRANSACTION_XDR`   | 400  |
 * | `INVALID_INNER_TRANSACTION` | 400  |
 * | `DENYLISTED_ACCOUNT`        | 403  |
 * | `NOT_ALLOWLISTED`           | 403  |
 * | `FEE_EXCEEDS_MAX`           | 403  |
 * | `HOURLY_CAP_EXCEEDED`       | 403  |
 * | `DAILY_CAP_EXCEEDED`        | 403  |
 * | `ACCOUNT_RATE_LIMITED`      | 429  |
 * | `IP_RATE_LIMITED`           | 429  |
 */
export type SponsorshipRejectionReason =
  | 'INVALID_TRANSACTION_XDR'
  | 'INVALID_INNER_TRANSACTION'
  | 'DENYLISTED_ACCOUNT'
  | 'NOT_ALLOWLISTED'
  | 'FEE_EXCEEDS_MAX'
  | 'HOURLY_CAP_EXCEEDED'
  | 'DAILY_CAP_EXCEEDED'
  | 'ACCOUNT_RATE_LIMITED'
  | 'IP_RATE_LIMITED';

/** Retry behaviour for requests to the relay. */
export interface RetryOptions {
  /** Maximum number of retries after the first attempt. Default `2`. */
  retries?: number;
  /** Base delay for exponential backoff, in milliseconds. Default `250`. */
  baseDelayMs?: number;
  /** Upper bound for any single backoff delay, in milliseconds. Default `5000`. */
  maxDelayMs?: number;
  /**
   * Also retry HTTP 429 (rate-limited) responses. Default `false`: a rate-limited user usually
   * wants to be told, not kept waiting. When enabled, a `Retry-After` header is honoured
   * (capped at `maxDelayMs`).
   */
  retryOnRateLimit?: boolean;
}

/** Options for {@link FeeSponsorClient}. */
export interface FeeSponsorClientOptions {
  /** Base URL of the fee-sponsor-relay, e.g. `https://relay.example.com`. Must be HTTPS unless it points at localhost. */
  relayUrl: string;
  /** Network passphrase the inner transactions are signed for, e.g. `Networks.TESTNET`. */
  networkPassphrase: string;
  /** Horizon URL used by {@link FeeSponsorClient.submit}. Required only for submitting. */
  horizonUrl?: string;
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default `10000`. */
  timeoutMs?: number;
  /** Extra headers sent with every request to the relay (not to Horizon). */
  headers?: Record<string, string>;
  /** Retry configuration, or `false` to disable retries entirely. */
  retry?: RetryOptions | false;
  /**
   * Pin the sponsor public key instead of trusting the relay's `GET /health`. Recommended in
   * production: a compromised relay could otherwise lie about its own key.
   */
  sponsorPublicKey?: string;
  /** Allow plain `http://` URLs for non-localhost hosts. Default `false`. Never enable in production. */
  allowInsecureHttp?: boolean;
}

/** Per-call options for {@link FeeSponsorClient.sponsor}. */
export interface SponsorOptions {
  /** Verify the returned fee bump against the inner transaction. Default `true`. */
  verify?: boolean;
  /** Abort the request (including any retries). */
  signal?: AbortSignal;
}

/** Per-call options for requests that only support cancellation. */
export interface RequestOptions {
  /** Abort the request. */
  signal?: AbortSignal;
}

/** A successful sponsorship. */
export interface SponsorResult {
  /** The parsed fee-bump transaction, ready to submit. */
  feeBump: FeeBumpTransaction;
  /** The fee bump as base64 envelope XDR, exactly as returned by the relay. */
  feeBumpXdr: string;
  /** Source account of the inner transaction, as reported by the relay. */
  sourceAccount: string;
  /** Fee of the inner transaction in stroops, as reported by the relay. */
  innerFeeStroops: number;
  /** Total fee the sponsor pays for the fee bump, in stroops. */
  sponsorFeeStroops: number;
  /** Whether the fee bump was verified locally (see {@link FeeSponsorClient.verifyFeeBump}). */
  verified: boolean;
}

/** The result of a successful Horizon submission. */
export interface SubmitResult {
  /** Hash of the submitted (fee-bump) transaction. */
  hash: string;
  /** Ledger the transaction was included in. */
  ledger: number;
  /** Whether Horizon reports the transaction as successful. */
  successful: boolean;
  /** Base64 `TransactionResult` XDR. */
  resultXdr: string;
  /** The raw Horizon response body. */
  raw: Record<string, unknown>;
}

/** The combined result of {@link FeeSponsorClient.sponsorAndSubmit}. */
export interface SponsorAndSubmitResult {
  sponsorship: SponsorResult;
  submission: SubmitResult;
}
