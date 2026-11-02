import {
  FeeBumpTransaction,
  Keypair,
  MuxedAccount,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import { asBytes, bytesEqual, signatureParts } from './compat.js';
import { LocalValidationError } from './errors.js';

/** Anything `sponsor()` accepts: a signed `Transaction` or its base64 envelope XDR. */
export type InnerTransactionInput = Transaction | string;

/** Structural check, so a `FeeBumpTransaction` from a second copy of the SDK is still detected. */
export function isFeeBump(tx: unknown): tx is FeeBumpTransaction {
  return (
    tx instanceof FeeBumpTransaction ||
    (typeof tx === 'object' && tx !== null && 'innerTransaction' in tx && 'feeSource' in tx)
  );
}

/** Resolve a `G...` or `M...` address to its underlying `G...` ed25519 account ID. */
export function baseAccountId(address: string): string {
  if (StrKey.isValidMed25519PublicKey(address)) {
    return MuxedAccount.fromAddress(address, '0').baseAccount().accountId();
  }
  return address;
}

/**
 * Parse an inner transaction and apply the structural checks: parseable XDR, not a fee bump, at
 * least one operation. Does not require signatures (used for fee estimates before signing).
 */
export function parseTransaction(
  input: InnerTransactionInput,
  networkPassphrase: string,
): Transaction {
  let tx: Transaction | FeeBumpTransaction;
  if (typeof input === 'string') {
    try {
      tx = TransactionBuilder.fromXDR(input.trim(), networkPassphrase);
    } catch (cause) {
      throw new LocalValidationError(
        'INVALID_XDR',
        'Could not parse the transaction XDR as a base64 transaction envelope.',
        { cause },
      );
    }
  } else if (typeof input === 'object' && input !== null) {
    tx = input;
  } else {
    throw new LocalValidationError(
      'INVALID_XDR',
      'Expected a signed Transaction or a base64 transaction envelope XDR string.',
    );
  }

  if (isFeeBump(tx)) {
    throw new LocalValidationError(
      'FEE_BUMP_NOT_ALLOWED',
      'The transaction is already a fee bump. Send the signed inner transaction instead.',
    );
  }
  if (tx.operations.length === 0) {
    throw new LocalValidationError('NO_OPERATIONS', 'The transaction has no operations.');
  }
  return tx;
}

/**
 * Parse and fully check an inner transaction before it is sent to the relay.
 *
 * On top of {@link parseTransaction}: the network passphrase matches, and the transaction has at
 * least one signature. For XDR strings (which don't carry a passphrase), a signature from the
 * source account that fails to verify under `networkPassphrase` is reported as a network mismatch.
 */
export function parseInnerTransaction(
  input: InnerTransactionInput,
  networkPassphrase: string,
): { tx: Transaction; xdr: string } {
  const tx = parseTransaction(input, networkPassphrase);
  if (tx.networkPassphrase !== networkPassphrase) {
    throw new LocalValidationError(
      'NETWORK_MISMATCH',
      `Transaction was built for network "${tx.networkPassphrase}" but the client is configured for "${networkPassphrase}".`,
    );
  }
  if (tx.signatures.length === 0) {
    throw new LocalValidationError(
      'NOT_SIGNED',
      'The transaction is not signed. Sign it with its source account before requesting sponsorship: signatures cannot be added once it is wrapped in a fee bump.',
    );
  }
  checkSourceSignature(tx);

  return { tx, xdr: tx.toEnvelope().toXDR('base64') };
}

/**
 * If the source account signed, its signature must verify against this transaction hash. A
 * failure almost always means the transaction was signed for a different network passphrase.
 */
function checkSourceSignature(tx: Transaction): void {
  const source = Keypair.fromPublicKey(baseAccountId(tx.source));
  const hint = asBytes(source.signatureHint());
  const fromSource = tx.signatures.map(signatureParts).filter((sig) => bytesEqual(sig.hint, hint));
  if (fromSource.length === 0) return; // Signed only by other signers (multisig): can't tell.

  const hash = tx.hash();
  if (
    !fromSource.some((sig) =>
      source.verify(hash, sig.signature as Parameters<Keypair['verify']>[1]),
    )
  ) {
    throw new LocalValidationError(
      'NETWORK_MISMATCH',
      'The source account signature does not verify for the configured network passphrase. The transaction was probably signed for a different network.',
    );
  }
}

/**
 * The relay's sponsor cost: `ceil(innerFee / opCount) * (opCount + 1)` stroops.
 */
export function sponsorCost(innerFeeStroops: number, operationCount: number): number {
  const baseFee = Math.ceil(innerFeeStroops / operationCount);
  return baseFee * (operationCount + 1);
}
