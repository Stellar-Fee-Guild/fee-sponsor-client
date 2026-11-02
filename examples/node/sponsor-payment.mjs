// Sponsor and submit a testnet payment through a fee-sponsor-relay.
//
//   cd examples/node && npm install
//   FEE_SPONSOR_RELAY_URL=https://your-relay.example.com npm start
//
// Creates two Friendbot-funded accounts, sends 10 XLM from one to the other, and lets the relay's
// sponsor account pay the fee. The source's balance drops by exactly 10 XLM.

import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
  FeeSponsorClient,
  SponsorRejectedError,
  isPolicyRejection,
  isRateLimited,
} from '@stellar-fee-guild/fee-sponsor-client';

const RELAY_URL = process.env.FEE_SPONSOR_RELAY_URL;
const HORIZON_URL = 'https://horizon-testnet.stellar.org';

if (!RELAY_URL) {
  console.error('Set FEE_SPONSOR_RELAY_URL to your relay, e.g. http://localhost:8080');
  process.exit(1);
}

async function fund(publicKey) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  if (!res.ok) throw new Error(`Friendbot failed: HTTP ${res.status}`);
}

const horizon = new Horizon.Server(HORIZON_URL);
const client = new FeeSponsorClient({
  relayUrl: RELAY_URL,
  networkPassphrase: Networks.TESTNET,
  horizonUrl: HORIZON_URL,
});

const source = Keypair.random();
const destination = Keypair.random();
console.log('Funding', source.publicKey(), 'and', destination.publicKey(), 'with Friendbot...');
await Promise.all([fund(source.publicKey()), fund(destination.publicKey())]);

console.log('Relay sponsor key:', await client.health());

// 1. Build and sign the inner transaction with the *source* key. The client never sees it.
const account = await horizon.loadAccount(source.publicKey());
const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
  .addOperation(
    Operation.payment({
      destination: destination.publicKey(),
      asset: Asset.native(),
      amount: '10',
    }),
  )
  .setTimeout(120)
  .build();
tx.sign(source);

console.log('Sponsor will pay', client.estimateSponsorCost(tx), 'stroops');

// 2. Get it sponsored (verified locally) and submit it.
try {
  const { sponsorship, submission } = await client.sponsorAndSubmit(tx);
  console.log(
    'Fee paid by',
    sponsorship.feeBump.feeSource,
    '-',
    sponsorship.sponsorFeeStroops,
    'stroops',
  );
  console.log('Submitted:', `https://stellar.expert/explorer/testnet/tx/${submission.hash}`);
} catch (err) {
  if (isRateLimited(err)) console.error('Rate limited by the relay; try again later.');
  else if (isPolicyRejection(err)) console.error('The relay will not sponsor this:', err.reason);
  else if (err instanceof SponsorRejectedError) console.error('Rejected:', err.reason, err.detail);
  else console.error(err);
  process.exitCode = 1;
}
