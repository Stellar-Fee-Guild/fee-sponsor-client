import type { SponsorshipRejectionReason } from './types.js';

/** Base class for every error thrown by this package. */
export class FeeSponsorError extends Error {
  /** HTTP status, when the error came from an HTTP response. */
  readonly status: number | undefined;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
  }
}

/** The relay answered and declined to sponsor the transaction (HTTP 400, 403 or 429). */
export class SponsorRejectedError extends FeeSponsorError {
  /**
   * Machine-readable rejection reason. Typed as the known union, but a newer relay may send a
   * reason this version doesn't know about, so handle the default case.
   */
  readonly reason: SponsorshipRejectionReason | (string & {});
  /** Human-readable detail from the relay. Useful for logs; don't show it to end users verbatim. */
  readonly detail: string | undefined;
  /** Source account of the inner transaction, when the relay could parse it. */
  readonly sourceAccount: string | undefined;
  /** Fee of the inner transaction in stroops, when the relay could parse it. */
  readonly innerFeeStroops: number | undefined;
  declare readonly status: number;

  constructor(fields: {
    reason: SponsorshipRejectionReason | (string & {});
    status: number;
    detail?: string;
    sourceAccount?: string;
    innerFeeStroops?: number;
  }) {
    super(
      `Relay rejected sponsorship: ${fields.reason}${fields.detail ? ` (${fields.detail})` : ''}`,
      { status: fields.status },
    );
    this.reason = fields.reason;
    this.detail = fields.detail;
    this.sourceAccount = fields.sourceAccount;
    this.innerFeeStroops = fields.innerFeeStroops;
  }
}

/**
 * The relay could not be reached or did not answer usefully: network failure, timeout, HTTP 5xx,
 * a non-JSON body, or any other response that isn't a documented sponsorship result.
 */
export class RelayUnavailableError extends FeeSponsorError {}

/** Error codes for {@link LocalValidationError}. */
export type LocalValidationCode =
  | 'INVALID_XDR'
  | 'FEE_BUMP_NOT_ALLOWED'
  | 'NO_OPERATIONS'
  | 'NOT_SIGNED'
  | 'NETWORK_MISMATCH'
  | 'INVALID_CONFIG';

/** The transaction (or client configuration) failed a local check. Nothing was sent. */
export class LocalValidationError extends FeeSponsorError {
  readonly code: LocalValidationCode;

  constructor(code: LocalValidationCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.code = code;
  }
}

/** Error codes for {@link FeeBumpVerificationError}. */
export type FeeBumpVerificationCode =
  | 'INNER_TRANSACTION_MISMATCH'
  | 'FEE_SOURCE_MISMATCH'
  | 'FEE_MISMATCH'
  | 'MISSING_SPONSOR_SIGNATURE'
  | 'INVALID_FEE_BUMP';

/**
 * The relay returned a fee bump that doesn't match what was sent: a different inner transaction,
 * an unexpected fee source, a wrong fee, or no valid sponsor signature. Do not submit it.
 */
export class FeeBumpVerificationError extends FeeSponsorError {
  readonly code: FeeBumpVerificationCode;

  constructor(code: FeeBumpVerificationCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Horizon refused the transaction, or could not be reached. */
export class HorizonSubmissionError extends FeeSponsorError {
  /** Horizon `extras.result_codes`, e.g. `{ transaction: 'tx_bad_seq' }`. */
  readonly resultCodes:
    { transaction?: string; inner_transaction?: string; operations?: string[] } | undefined;
  /** Horizon `extras.result_xdr`, when present. */
  readonly resultXdr: string | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      cause?: unknown;
      resultCodes?: HorizonSubmissionError['resultCodes'];
      resultXdr?: string;
    } = {},
  ) {
    super(message, options);
    this.resultCodes = options.resultCodes;
    this.resultXdr = options.resultXdr;
  }
}

const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set<SponsorshipRejectionReason>([
  'ACCOUNT_RATE_LIMITED',
  'IP_RATE_LIMITED',
]);

const POLICY_REASONS: ReadonlySet<string> = new Set<SponsorshipRejectionReason>([
  'DENYLISTED_ACCOUNT',
  'NOT_ALLOWLISTED',
  'FEE_EXCEEDS_MAX',
  'HOURLY_CAP_EXCEEDED',
  'DAILY_CAP_EXCEEDED',
]);

/**
 * `true` if the error means "slow down": a `SponsorRejectedError` with a rate-limit reason, or any
 * relay response with HTTP 429 (for example from a proxy in front of the relay).
 */
export function isRateLimited(err: unknown): err is FeeSponsorError {
  if (err instanceof SponsorRejectedError && RATE_LIMIT_REASONS.has(err.reason)) return true;
  return (
    (err instanceof SponsorRejectedError || err instanceof RelayUnavailableError) &&
    err.status === 429
  );
}

/**
 * `true` if the relay's sponsorship policy declined the transaction (deny/allow lists, fee cap,
 * hourly or daily spend caps). Retrying the same transaction will not help.
 */
export function isPolicyRejection(err: unknown): err is SponsorRejectedError {
  return err instanceof SponsorRejectedError && POLICY_REASONS.has(err.reason);
}
