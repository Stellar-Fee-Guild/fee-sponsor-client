import {
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction,
} from '@stellar/freighter-api';
import { Asset, Horizon, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  FeeSponsorClient,
  LocalValidationError,
  SponsorRejectedError,
  isRateLimited,
} from '@stellar-fee-guild/fee-sponsor-client';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const $ = (id) => document.getElementById(id);
const log = (msg) => ($('log').textContent += `${msg}\n`);

/** What to tell the user for each relay rejection. See the README's error-handling guide. */
const MESSAGES = {
  DENYLISTED_ACCOUNT: 'This account is not eligible for free transactions.',
  NOT_ALLOWLISTED: 'This account is not eligible for free transactions.',
  FEE_EXCEEDS_MAX: 'This transaction is too expensive to sponsor.',
  HOURLY_CAP_EXCEEDED: 'Free transactions are temporarily unavailable. Try again later.',
  DAILY_CAP_EXCEEDED: 'Free transactions are unavailable for today. Try again tomorrow.',
};

async function send() {
  $('log').textContent = '';
  if (!(await isConnected()).isConnected) throw new Error('Freighter is not installed.');

  const access = await requestAccess();
  if (access.error) throw new Error(access.error.message ?? 'Freighter access denied.');
  const network = await getNetworkDetails();
  if (network.networkPassphrase !== Networks.TESTNET)
    throw new Error('Switch Freighter to Testnet.');

  const client = new FeeSponsorClient({
    relayUrl: $('relay').value,
    networkPassphrase: Networks.TESTNET,
    horizonUrl: HORIZON_URL,
  });

  // Build the payment. Its fee is the *inner* fee; the sponsor pays it, not the user.
  const account = await new Horizon.Server(HORIZON_URL).loadAccount(access.address);
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({
        destination: $('destination').value.trim(),
        asset: Asset.native(),
        amount: $('amount').value.trim(),
      }),
    )
    .setTimeout(120)
    .build();

  // Freighter signs the inner transaction. Only the signed XDR goes to the relay.
  log('Waiting for Freighter signature…');
  const signed = await signTransaction(tx.toXDR(), {
    networkPassphrase: Networks.TESTNET,
    address: access.address,
  });
  if (signed.error) throw new Error(signed.error.message ?? 'Signing was cancelled.');

  log(
    `Requesting sponsorship (sponsor pays ${client.estimateSponsorCost(signed.signedTxXdr)} stroops)…`,
  );
  const { submission } = await client.sponsorAndSubmit(signed.signedTxXdr);
  log(`Done! https://stellar.expert/explorer/testnet/tx/${submission.hash}`);
}

$('send').addEventListener('click', () => {
  send().catch((err) => {
    if (isRateLimited(err)) log('Too many requests. Please wait a minute and try again.');
    else if (err instanceof SponsorRejectedError)
      log(MESSAGES[err.reason] ?? `Rejected: ${err.reason}`);
    else if (err instanceof LocalValidationError) log(`Invalid transaction: ${err.message}`);
    else log(`Error: ${err.message ?? err}`);
  });
});
