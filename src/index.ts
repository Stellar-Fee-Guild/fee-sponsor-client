/**
 * Client SDK for [fee-sponsor-relay](https://github.com/Stellar-Fee-Guild/fee-sponsor-relay).
 *
 * @packageDocumentation
 */
export { FeeSponsorClient } from './client.js';
export {
  FeeBumpVerificationError,
  FeeSponsorError,
  HorizonSubmissionError,
  LocalValidationError,
  RelayUnavailableError,
  SponsorRejectedError,
  isPolicyRejection,
  isRateLimited,
} from './errors.js';
export type { FeeBumpVerificationCode, LocalValidationCode } from './errors.js';
export type {
  FeeSponsorClientOptions,
  RequestOptions,
  RetryOptions,
  SponsorAndSubmitResult,
  SponsorOptions,
  SponsorResult,
  SponsorshipRejectionReason,
  SubmitResult,
} from './types.js';
export type { InnerTransactionInput } from './validation.js';
