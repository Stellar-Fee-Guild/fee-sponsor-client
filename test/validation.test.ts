import type { Transaction } from '@stellar/stellar-sdk';
import { Keypair, MuxedAccount, Account, Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { LocalValidationError } from '../src/errors.js';
import {
  baseAccountId,
  parseInnerTransaction,
  parseTransaction,
  sponsorCost,
} from '../src/validation.js';
import { NETWORK, buildTx, hex, relayFeeBump } from './helpers.js';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LocalValidationError);
    expect((err as LocalValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected LocalValidationError ${code}`);
}

describe('parseInnerTransaction', () => {
  it('accepts a signed Transaction and returns its envelope XDR', () => {
    const tx = buildTx();
    const result = parseInnerTransaction(tx, NETWORK);
    expect(result.tx).toBe(tx);
    expect(result.xdr).toBe(tx.toEnvelope().toXDR('base64'));
  });

  it('accepts a signed base64 XDR string (whitespace tolerated)', () => {
    const tx = buildTx();
    const xdr = tx.toEnvelope().toXDR('base64');
    const result = parseInnerTransaction(`  ${xdr}\n`, NETWORK);
    expect(result.xdr).toBe(xdr);
    expect(hex(result.tx.hash())).toBe(hex(tx.hash()));
  });

  it('rejects unparseable XDR', () => {
    expectCode(() => parseInnerTransaction('not-xdr', NETWORK), 'INVALID_XDR');
  });

  it('rejects non-transaction input', () => {
    expectCode(() => parseInnerTransaction(42 as unknown as string, NETWORK), 'INVALID_XDR');
    expectCode(() => parseInnerTransaction(null as unknown as string, NETWORK), 'INVALID_XDR');
  });

  it('rejects a FeeBumpTransaction object', () => {
    const feeBump = relayFeeBump(buildTx(), Keypair.random());
    expectCode(
      () => parseInnerTransaction(feeBump as unknown as Transaction, NETWORK),
      'FEE_BUMP_NOT_ALLOWED',
    );
  });

  it('rejects fee-bump XDR', () => {
    const xdr = relayFeeBump(buildTx(), Keypair.random()).toEnvelope().toXDR('base64');
    expectCode(() => parseInnerTransaction(xdr, NETWORK), 'FEE_BUMP_NOT_ALLOWED');
  });

  it('detects fee bumps structurally (duplicate SDK copies)', () => {
    const lookalike = { innerTransaction: {}, feeSource: 'G...' };
    expectCode(
      () => parseInnerTransaction(lookalike as unknown as Transaction, NETWORK),
      'FEE_BUMP_NOT_ALLOWED',
    );
  });

  it('rejects a transaction with zero operations', () => {
    const tx = buildTx({ operations: 0 });
    expectCode(() => parseInnerTransaction(tx, NETWORK), 'NO_OPERATIONS');
    expectCode(
      () => parseInnerTransaction(tx.toEnvelope().toXDR('base64'), NETWORK),
      'NO_OPERATIONS',
    );
  });

  it('rejects an unsigned transaction', () => {
    const tx = buildTx({ signers: [] });
    expectCode(() => parseInnerTransaction(tx, NETWORK), 'NOT_SIGNED');
    expectCode(() => parseInnerTransaction(tx.toEnvelope().toXDR('base64'), NETWORK), 'NOT_SIGNED');
  });

  it('rejects a Transaction built for another network', () => {
    const tx = buildTx({ network: Networks.PUBLIC });
    expectCode(() => parseInnerTransaction(tx, NETWORK), 'NETWORK_MISMATCH');
  });

  it('rejects XDR whose source signature was made for another network', () => {
    const xdr = buildTx({ network: Networks.PUBLIC }).toEnvelope().toXDR('base64');
    expectCode(() => parseInnerTransaction(xdr, NETWORK), 'NETWORK_MISMATCH');
  });

  it('accepts a transaction signed only by other signers (multisig)', () => {
    const tx = buildTx({ signers: [Keypair.random()] });
    expect(() => parseInnerTransaction(tx, NETWORK)).not.toThrow();
  });

  it('handles muxed (M...) source accounts', () => {
    const source = Keypair.random();
    const tx = buildTx({ source, muxedId: '42' });
    expect(tx.source.startsWith('M')).toBe(true);
    expect(() => parseInnerTransaction(tx, NETWORK)).not.toThrow();

    const wrongNetwork = buildTx({ source, muxedId: '42', network: Networks.PUBLIC });
    expectCode(
      () => parseInnerTransaction(wrongNetwork.toEnvelope().toXDR('base64'), NETWORK),
      'NETWORK_MISMATCH',
    );
  });
});

describe('parseTransaction', () => {
  it('does not require signatures', () => {
    expect(() => parseTransaction(buildTx({ signers: [] }), NETWORK)).not.toThrow();
  });
});

describe('baseAccountId', () => {
  it('returns G addresses unchanged and unwraps M addresses', () => {
    const kp = Keypair.random();
    const muxed = new MuxedAccount(new Account(kp.publicKey(), '1'), '7').accountId();
    expect(baseAccountId(kp.publicKey())).toBe(kp.publicKey());
    expect(baseAccountId(muxed)).toBe(kp.publicKey());
  });
});

describe('sponsorCost', () => {
  it.each([
    [100, 1, 200],
    [200, 2, 300],
    [250, 2, 375],
    [101, 2, 153],
    [500_000, 1, 1_000_000],
  ])('fee %i with %i ops costs %i', (fee, ops, expected) => {
    expect(sponsorCost(fee, ops)).toBe(expected);
  });
});
