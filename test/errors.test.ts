import { describe, expect, it } from 'vitest';
import {
  FeeBumpVerificationError,
  FeeSponsorError,
  HorizonSubmissionError,
  LocalValidationError,
  RelayUnavailableError,
  SponsorRejectedError,
  isPolicyRejection,
  isRateLimited,
} from '../src/index.js';
import type { SponsorshipRejectionReason } from '../src/index.js';

const ALL: Array<[SponsorshipRejectionReason, number, 'policy' | 'rate' | 'invalid']> = [
  ['INVALID_TRANSACTION_XDR', 400, 'invalid'],
  ['INVALID_INNER_TRANSACTION', 400, 'invalid'],
  ['DENYLISTED_ACCOUNT', 403, 'policy'],
  ['NOT_ALLOWLISTED', 403, 'policy'],
  ['FEE_EXCEEDS_MAX', 403, 'policy'],
  ['HOURLY_CAP_EXCEEDED', 403, 'policy'],
  ['DAILY_CAP_EXCEEDED', 403, 'policy'],
  ['ACCOUNT_RATE_LIMITED', 429, 'rate'],
  ['IP_RATE_LIMITED', 429, 'rate'],
];

describe('SponsorRejectedError', () => {
  it('carries every field and a readable message', () => {
    const err = new SponsorRejectedError({
      reason: 'DAILY_CAP_EXCEEDED',
      status: 403,
      detail: 'daily cap reached',
      sourceAccount: 'GABC',
      innerFeeStroops: 500000,
    });
    expect(err).toBeInstanceOf(FeeSponsorError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SponsorRejectedError');
    expect(err.message).toBe('Relay rejected sponsorship: DAILY_CAP_EXCEEDED (daily cap reached)');
    expect(err).toMatchObject({
      reason: 'DAILY_CAP_EXCEEDED',
      status: 403,
      detail: 'daily cap reached',
      sourceAccount: 'GABC',
      innerFeeStroops: 500000,
    });
  });

  it('omits detail from the message when absent', () => {
    const err = new SponsorRejectedError({ reason: 'IP_RATE_LIMITED', status: 429 });
    expect(err.message).toBe('Relay rejected sponsorship: IP_RATE_LIMITED');
    expect(err.detail).toBeUndefined();
  });
});

describe('isRateLimited / isPolicyRejection', () => {
  it.each(ALL)('%s (HTTP %i) is classified as %s', (reason, status, kind) => {
    const err = new SponsorRejectedError({ reason, status });
    expect(isRateLimited(err)).toBe(kind === 'rate');
    expect(isPolicyRejection(err)).toBe(kind === 'policy');
  });

  it('treats any relay HTTP 429 as rate limited', () => {
    expect(isRateLimited(new RelayUnavailableError('proxy', { status: 429 }))).toBe(true);
    expect(isRateLimited(new SponsorRejectedError({ reason: 'SOMETHING_NEW', status: 429 }))).toBe(
      true,
    );
    expect(isRateLimited(new RelayUnavailableError('down', { status: 503 }))).toBe(false);
  });

  it('returns false for unrelated values', () => {
    for (const value of [
      new Error('x'),
      null,
      undefined,
      'IP_RATE_LIMITED',
      { reason: 'IP_RATE_LIMITED', status: 429 },
      new LocalValidationError('NOT_SIGNED', 'x'),
    ]) {
      expect(isRateLimited(value)).toBe(false);
      expect(isPolicyRejection(value)).toBe(false);
    }
  });
});

describe('other errors', () => {
  it('keep their codes, status and cause', () => {
    const cause = new TypeError('fetch failed');
    const unavailable = new RelayUnavailableError('down', { status: 502, cause });
    expect(unavailable.status).toBe(502);
    expect(unavailable.cause).toBe(cause);
    expect(unavailable.name).toBe('RelayUnavailableError');

    const local = new LocalValidationError('NO_OPERATIONS', 'none');
    expect(local.code).toBe('NO_OPERATIONS');
    expect(local.status).toBeUndefined();

    const verification = new FeeBumpVerificationError('FEE_MISMATCH', 'bad fee');
    expect(verification.code).toBe('FEE_MISMATCH');

    const horizon = new HorizonSubmissionError('rejected', {
      status: 400,
      resultCodes: { transaction: 'tx_bad_seq' },
      resultXdr: 'AAAA',
    });
    expect(horizon.resultCodes?.transaction).toBe('tx_bad_seq');
    expect(horizon.resultXdr).toBe('AAAA');
    expect(new HorizonSubmissionError('x').resultCodes).toBeUndefined();
  });
});
