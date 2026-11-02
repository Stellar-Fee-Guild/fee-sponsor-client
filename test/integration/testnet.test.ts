/**
 * End-to-end test against Stellar testnet and a real fee-sponsor-relay.
 *
 *   FEE_SPONSOR_RELAY_URL=https://your-relay.example.com npm run test:integration
 *
 * Skipped when FEE_SPONSOR_RELAY_URL is unset. The relay must be configured for testnet and must
 * sponsor freshly created accounts (no allowlist, or an allowlist that admits them).
 */
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { FeeSponsorClient, LocalValidationError } from '../../src/index.js';

const RELAY_URL = process.env.FEE_SPONSOR_RELAY_URL;
const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = process.env.FRIENDBOT_URL ?? 'https://friendbot.stellar.org';

interface HorizonAccount {
  sequence: string;
  balances: Array<{ asset_type: string; balance: string }>;
}

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) throw new Error(`Friendbot failed for ${publicKey}: HTTP ${res.status}`);
}

async function loadAccount(publicKey: string): Promise<HorizonAccount> {
  const res = await fetch(`${HORIZON_URL}/accounts/${publicKey}`);
  if (!res.ok) throw new Error(`Could not load ${publicKey}: HTTP ${res.status}`);
  return (await res.json()) as HorizonAccount;
}

function nativeBalance(account: HorizonAccount): string {
  const native = account.balances.find((b) => b.asset_type === 'native');
  if (!native) throw new Error('no native balance');
  return native.balance;
}

/** XLM balance as integer stroops, to compare without floating point. */
function toStroops(balance: string): bigint {
  const [whole = '0', frac = ''] = balance.split('.');
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, '0'));
}

describe.skipIf(!RELAY_URL)('testnet integration', () => {
  const source = Keypair.random();
  const destination = Keypair.random();
  let client: FeeSponsorClient;

  beforeAll(async () => {
    client = new FeeSponsorClient({
      relayUrl: RELAY_URL as string,
      networkPassphrase: Networks.TESTNET,
      horizonUrl: HORIZON_URL,
      timeoutMs: 30_000,
    });
    await Promise.all([fund(source.publicKey()), fund(destination.publicKey())]);
  });

  async function buildPayment(amount: string) {
    const loaded = await loadAccount(source.publicKey());
    const tx = new TransactionBuilder(new Account(source.publicKey(), loaded.sequence), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: destination.publicKey(), asset: Asset.native(), amount }),
      )
      .setTimeout(120)
      .build();
    return tx;
  }

  it('reads the sponsor key from /health', async () => {
    const key = await client.health();
    expect(key).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('sponsors and submits a payment; the source pays no fee', async () => {
    const before = toStroops(nativeBalance(await loadAccount(source.publicKey())));
    const tx = await buildPayment('1');
    tx.sign(source);

    const { sponsorship, submission } = await client.sponsorAndSubmit(tx);

    expect(sponsorship.verified).toBe(true);
    expect(sponsorship.feeBump.feeSource).toBe(await client.health());
    expect(sponsorship.sponsorFeeStroops).toBe(client.estimateSponsorCost(tx));
    expect(submission.successful).toBe(true);
    expect(submission.hash).toMatch(/^[0-9a-f]{64}$/);

    const after = toStroops(nativeBalance(await loadAccount(source.publicKey())));
    expect(before - after).toBe(10_000_000n); // exactly 1 XLM, no fee
  });

  it('refuses an unsigned transaction locally', async () => {
    const tx = await buildPayment('1');
    await expect(client.sponsor(tx)).rejects.toBeInstanceOf(LocalValidationError);
  });
});
