import type { FeeBumpTransaction } from '@stellar/stellar-sdk';
import {
  Account,
  Asset,
  Keypair,
  MuxedAccount,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { vi } from 'vitest';

export const NETWORK = Networks.TESTNET;
export const RELAY_URL = 'https://relay.example.com';
export const HORIZON_URL = 'https://horizon.example.com';

export interface BuildOptions {
  source?: Keypair;
  /** Use a muxed (M...) source account with this ID. */
  muxedId?: string;
  operations?: number;
  feePerOp?: number;
  network?: string;
  signers?: Keypair[];
}

/** Build a real payment transaction, signed by its source unless `signers` says otherwise. */
export function buildTx(opts: BuildOptions = {}): Transaction {
  const source = opts.source ?? Keypair.random();
  const base = new Account(source.publicKey(), '1000');
  const account = opts.muxedId === undefined ? base : new MuxedAccount(base, opts.muxedId);
  const builder = new TransactionBuilder(account, {
    fee: String(opts.feePerOp ?? 100),
    networkPassphrase: opts.network ?? NETWORK,
  }).setTimeout(0);
  const destination = Keypair.random().publicKey();
  for (let i = 0; i < (opts.operations ?? 1); i++) {
    builder.addOperation(
      Operation.payment({ destination, asset: Asset.native(), amount: String(i + 1) }),
    );
  }
  const tx = buildAllowingZeroOps(builder, opts);
  for (const signer of opts.signers ?? [source]) tx.sign(signer);
  return tx;
}

/** Wrap `inner` in a fee bump the way the relay does: `ceil(fee / ops)` base fee. */
export function relayFeeBump(
  inner: Transaction,
  sponsor: Keypair,
  opts: { baseFee?: number; sign?: boolean; network?: string } = {},
): FeeBumpTransaction {
  const baseFee = opts.baseFee ?? Math.ceil(Number(inner.fee) / inner.operations.length);
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    String(baseFee),
    inner,
    opts.network ?? NETWORK,
  );
  if (opts.sign !== false) feeBump.sign(sponsor);
  return feeBump;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export interface FakeRelayOptions {
  sponsor?: Keypair;
  /** Override the fee bump the relay returns for a parsed inner transaction. */
  feeBump?: (inner: Transaction, sponsor: Keypair) => FeeBumpTransaction | Transaction | string;
  /** Override the `/sponsor` response entirely. */
  sponsorResponse?: () => Response | Promise<Response>;
  healthResponse?: () => Response | Promise<Response>;
}

/** A `fetch` mock that behaves like a real fee-sponsor-relay, backed by the Stellar SDK. */
export function fakeRelay(opts: FakeRelayOptions = {}) {
  const sponsor = opts.sponsor ?? Keypair.random();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/health')) {
      if (opts.healthResponse) return opts.healthResponse();
      return jsonResponse({ status: 'ok', sponsorPublicKey: sponsor.publicKey() });
    }
    if (url.pathname.endsWith('/sponsor')) {
      if (opts.sponsorResponse) return opts.sponsorResponse();
      const { transaction } = JSON.parse(String(init?.body)) as { transaction: string };
      const inner = TransactionBuilder.fromXDR(transaction, NETWORK) as Transaction;
      const result = opts.feeBump ? opts.feeBump(inner, sponsor) : relayFeeBump(inner, sponsor);
      const xdr = typeof result === 'string' ? result : result.toEnvelope().toXDR('base64');
      return jsonResponse({
        approved: true,
        sourceAccount: inner.source,
        innerFeeStroops: Number(inner.fee),
        feeBumpTransactionXdr: xdr,
      });
    }
    return new Response('not found', { status: 404 });
  });
  return { sponsor, fetch: fetchMock as unknown as typeof fetch & typeof fetchMock };
}

export function calledPaths(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
}

/** Hex-encode bytes (`Buffer` or `Uint8Array`), for comparing hashes across SDK versions. */
export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Some SDK versions refuse to build a transaction with no operations. In that case build it with
 * one operation and strip it from the envelope, which is what a hand-crafted XDR would look like.
 */
function buildAllowingZeroOps(builder: TransactionBuilder, opts: BuildOptions): Transaction {
  if ((opts.operations ?? 1) > 0) return builder.build();
  try {
    return builder.build();
  } catch {
    builder.addOperation(Operation.bumpSequence({ bumpTo: '0' }));
    const env = builder.build().toEnvelope() as unknown as {
      v1(): { tx(): { operations(ops: unknown[]): void } };
    };
    env.v1().tx().operations([]);
    return new Transaction(env as never, opts.network ?? NETWORK);
  }
}
