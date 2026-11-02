import { Keypair } from '@stellar/stellar-sdk';
import type { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk';
import { asBytes, bytesEqual, signatureParts } from './compat.js';
import { FeeBumpVerificationError } from './errors.js';
import { baseAccountId, isFeeBump, sponsorCost } from './validation.js';

/**
 * Check that `feeBump` is exactly the sponsorship we asked for:
 *
 * 1. it wraps `inner` byte-for-byte (same envelope, same signatures);
 * 2. its fee source is `sponsorPublicKey`;
 * 3. its fee equals the relay's cost formula;
 * 4. it carries a valid signature from `sponsorPublicKey` for this network.
 *
 * @throws {@link FeeBumpVerificationError} on the first failed check.
 */
export function verifyFeeBumpAgainst(
  feeBump: FeeBumpTransaction,
  inner: Transaction,
  sponsorPublicKey: string,
): void {
  if (!isFeeBump(feeBump)) {
    throw new FeeBumpVerificationError('INVALID_FEE_BUMP', 'The relay did not return a fee bump.');
  }

  const sentXdr = inner.toEnvelope().toXDR('base64');
  const wrappedXdr = feeBump.innerTransaction.toEnvelope().toXDR('base64');
  if (wrappedXdr !== sentXdr) {
    throw new FeeBumpVerificationError(
      'INNER_TRANSACTION_MISMATCH',
      'The fee bump wraps a different transaction from the one that was sent. Do not submit it.',
    );
  }

  if (baseAccountId(feeBump.feeSource) !== sponsorPublicKey) {
    throw new FeeBumpVerificationError(
      'FEE_SOURCE_MISMATCH',
      `The fee bump's fee source ${feeBump.feeSource} is not the relay's sponsor ${sponsorPublicKey}.`,
    );
  }

  const expected = sponsorCost(Number(inner.fee), inner.operations.length);
  if (BigInt(feeBump.fee) !== BigInt(expected)) {
    throw new FeeBumpVerificationError(
      'FEE_MISMATCH',
      `The fee bump's fee is ${feeBump.fee} stroops; expected ${expected}.`,
    );
  }

  const sponsor = Keypair.fromPublicKey(sponsorPublicKey);
  const hint = asBytes(sponsor.signatureHint());
  const hash = feeBump.hash();
  const signed = feeBump.signatures
    .map(signatureParts)
    .some(
      (sig) =>
        bytesEqual(sig.hint, hint) &&
        sponsor.verify(hash, sig.signature as Parameters<Keypair['verify']>[1]),
    );
  if (!signed) {
    throw new FeeBumpVerificationError(
      'MISSING_SPONSOR_SIGNATURE',
      'The fee bump has no valid signature from the sponsor for this network.',
    );
  }
}
