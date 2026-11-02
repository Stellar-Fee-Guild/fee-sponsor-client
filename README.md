# fee-sponsor-client

[![CI](https://github.com/Stellar-Fee-Guild/fee-sponsor-client/actions/workflows/ci.yml/badge.svg)](https://github.com/Stellar-Fee-Guild/fee-sponsor-client/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A TypeScript SDK for dApps, wallets and backends to get Stellar transactions **fee-sponsored**
by a [fee-sponsor-relay](https://github.com/Stellar-Fee-Guild/fee-sponsor-relay). It validates
your transaction, calls the relay, **verifies the fee bump it returns**, submits it to Horizon,
and returns typed errors you can show to users. You no longer need to hand-write that HTTP and
error-handling code.

```ts
const client = new FeeSponsorClient({ relayUrl, networkPassphrase: Networks.TESTNET, horizonUrl });
const { submission } = await client.sponsorAndSubmit(signedTx); // the user paid no fee
```

## Contents

- [What is fee sponsorship?](#what-is-fee-sponsorship)
- [How it fits together](#how-it-fits-together)
- [Install](#install)
- [Quick start](#quick-start)
- [API reference](#api-reference)
- [Error handling](#error-handling)
- [Security](#security)
- [Examples](#examples)
- [Development](#development)
- [Roadmap](#roadmap)

## What is fee sponsorship?

Every Stellar transaction pays a fee in XLM from its source account. A brand-new user often has
no XLM, so they can't do anything until someone sends them some.

Stellar's [fee-bump transactions](https://developers.stellar.org/docs/learn/encyclopedia/transactions-specialized/fee-bump-transactions)
(CAP-15) fix this. The user signs their transaction as usual. A **sponsor** account then wraps it
in a `FeeBumpTransaction`, signs that, and pays the fee. The user's transaction is unchanged:
same operations, same source, same sequence number. Only the fee comes from someone else.

Apps use this to:

- onboard users who hold no XLM ("gasless" UX);
- pay fees for their users while keeping custody with the user;
- run many accounts without topping up each with XLM for fees.

## How it fits together

```
 ┌──────────────┐ 1. build + sign tx  ┌──────────────────────┐
 │  your app    │────────────────────▶│ fee-sponsor-client   │ (this package)
 │ (dApp/wallet │                     │  validate locally    │
 │  /backend)   │◀────────────────────│  verify fee bump     │
 └──────────────┘ 4. result / errors  └───┬──────────────┬───┘
                                   2. POST /sponsor    3. POST /transactions
                                          ▼              ▼
                         ┌──────────────────────┐   ┌─────────┐
                         │  fee-sponsor-relay   │   │ Horizon │
                         │  ┌────────────────┐  │   └─────────┘
                         │  │ sponsor-policy │  │
                         │  │    -engine     │  │
                         │  └────────────────┘  │
                         └──────────────────────┘
```

- **[fee-sponsor-relay](https://github.com/Stellar-Fee-Guild/fee-sponsor-relay)** is a
  self-hostable HTTP service. It holds the sponsor key, wraps your signed transaction in a
  fee bump, signs it and returns the XDR. **It does not submit to the network. The client does.**
- **[sponsor-policy-engine](https://github.com/Stellar-Fee-Guild/sponsor-policy-engine)** is the
  dependency-free library behind the relay's decisions: allow and deny lists, fee caps, hourly and
  daily spend caps, rate limits. Its decisions reach you as `SponsorRejectedError.reason`.
- **fee-sponsor-client** (this repo) is the client side.

## Install

```sh
npm install @stellar-fee-guild/fee-sponsor-client @stellar/stellar-sdk
```

`@stellar/stellar-sdk` is a **peer dependency** (supported: `>=13 <18`), so your app's copy is
used and not bundled twice. There are no other runtime dependencies.

- **Node 18+.** Uses the global `fetch`. SDK v14+ needs Node 20+, and v16+ needs Node 22+, so on
  Node 18 use SDK 13.
- **Modern browsers.** Ships as ESM with type declarations, and works with any bundler or an
  import map.

## Quick start

```ts
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

const client = new FeeSponsorClient({
  relayUrl: 'https://relay.example.com',
  networkPassphrase: Networks.TESTNET,
  horizonUrl: 'https://horizon-testnet.stellar.org',
});

// 1. Build the transaction and sign it with the user's key. It MUST be signed before it is
//    sponsored: the fee-bump signature covers the inner signatures, so none can be added later.
const user = Keypair.fromSecret(process.env.USER_SECRET!); // or a wallet like Freighter
const account = await new Horizon.Server('https://horizon-testnet.stellar.org').loadAccount(
  user.publicKey(),
);
const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.payment({ destination: 'G...', asset: Asset.native(), amount: '10' }))
  .setTimeout(120)
  .build();
tx.sign(user);

// 2. Sponsor (validate, call the relay, verify the fee bump) and submit.
try {
  const { sponsorship, submission } = await client.sponsorAndSubmit(tx);
  console.log(`Sponsor paid ${sponsorship.sponsorFeeStroops} stroops; tx ${submission.hash}`);
} catch (err) {
  if (isRateLimited(err)) {
    // Ask the user to try again shortly.
  } else if (isPolicyRejection(err)) {
    // The relay won't sponsor this: fall back to the user paying, or explain why.
  } else if (err instanceof SponsorRejectedError) {
    console.error(err.reason, err.detail);
  } else {
    throw err;
  }
}
```

To submit through your own pipeline instead, call `sponsor()` and use `result.feeBump` or
`result.feeBumpXdr`.

## API reference

Every export has TSDoc, so your editor shows these descriptions inline.

### `new FeeSponsorClient(options)`

| Option              | Type                     | Default        | Description                                                                                                                                        |
| ------------------- | ------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relayUrl`          | `string`                 | **required**   | Relay base URL. May include a path prefix, but no query string or fragment. Must be `https://` unless the host is `localhost`/`127.0.0.1`/`[::1]`. |
| `networkPassphrase` | `string`                 | **required**   | e.g. `Networks.TESTNET`. Every transaction is checked against it.                                                                                  |
| `horizonUrl`        | `string`                 | none           | Needed only for `submit()` / `sponsorAndSubmit()`.                                                                                                 |
| `fetch`             | `typeof fetch`           | global `fetch` | Inject a custom implementation (tests, proxies, older runtimes).                                                                                   |
| `timeoutMs`         | `number`                 | `10000`        | Per-request timeout. Each retry gets a fresh timeout. `submit()` waits at least 60 s.                                                              |
| `headers`           | `Record<string, string>` | `{}`           | Extra headers sent to the **relay** only (never to Horizon).                                                                                       |
| `retry`             | `RetryOptions \| false`  | see below      | Retry policy, or `false` to disable retries.                                                                                                       |
| `sponsorPublicKey`  | `string`                 | from `/health` | Pin the sponsor key used for verification. Recommended in production (see [Security](#security)).                                                  |
| `allowInsecureHttp` | `boolean`                | `false`        | Allow `http://` for non-local hosts. For local testing only.                                                                                       |

Invalid options throw `LocalValidationError` with code `INVALID_CONFIG`.

**`RetryOptions`**

| Field              | Default | Description                                                                                      |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------ |
| `retries`          | `2`     | Retries after the first attempt.                                                                 |
| `baseDelayMs`      | `250`   | Backoff base. Delay for retry _n_ is `min(maxDelayMs, baseDelayMs·2ⁿ)`, half fixed, half random. |
| `maxDelayMs`       | `5000`  | Cap for any single delay, including a server's `Retry-After`.                                    |
| `retryOnRateLimit` | `false` | Also retry HTTP 429, honouring `Retry-After`.                                                    |

Network errors, timeouts and HTTP 5xx are retried. **400 and 403 are never retried**: the same
transaction would get the same answer. 429 is retried only when `retryOnRateLimit` is set.
Aborting via `signal` stops immediately, including during a backoff wait.

### `client.health(options?): Promise<string>`

Calls `GET /health` and returns the relay's sponsor public key (`G...`). Caches it for
verification. Throws `RelayUnavailableError` if the relay is down or the response isn't
`{ "status": "ok", "sponsorPublicKey": "G..." }`.

### `client.sponsor(tx, options?): Promise<SponsorResult>`

Gets a signed transaction fee-bumped by the relay.

- `tx`: a `Transaction` **signed by its source account**, or its base64 envelope XDR.
- `options.verify` (default `true`): run [`verifyFeeBump`](#clientverifyfeebumpfeebump-inner-options-promisevoid) on the result.
- `options.signal`: an `AbortSignal`.

Before anything is sent, the transaction is checked locally. Each failure throws a
`LocalValidationError` with a `code`:

| Check                                | `code`                 |
| ------------------------------------ | ---------------------- |
| XDR parses as a transaction envelope | `INVALID_XDR`          |
| It is not already a fee bump         | `FEE_BUMP_NOT_ALLOWED` |
| It has at least one operation        | `NO_OPERATIONS`        |
| It has at least one signature        | `NOT_SIGNED`           |
| It is for the configured network¹    | `NETWORK_MISMATCH`     |

¹ For a `Transaction` object, its `networkPassphrase` must match. For XDR (which carries no
passphrase), a signature from the source account must verify under the configured passphrase.

Then it sends `POST /sponsor` with `{ "transaction": "<xdr>" }` and returns:

```ts
interface SponsorResult {
  feeBump: FeeBumpTransaction; // parsed, ready to submit
  feeBumpXdr: string; // exactly as returned by the relay
  sourceAccount: string; // inner transaction source
  innerFeeStroops: number; // inner transaction fee
  sponsorFeeStroops: number; // what the sponsor pays
  verified: boolean; // false only with { verify: false }
}
```

### `client.verifyFeeBump(feeBump, inner, options?): Promise<void>`

Throws a `FeeBumpVerificationError` unless all of these hold:

| Check                                                                                  | `code` on failure            |
| -------------------------------------------------------------------------------------- | ---------------------------- |
| It is a fee bump                                                                       | `INVALID_FEE_BUMP`           |
| It wraps **exactly** `inner`, byte for byte, including signatures                      | `INNER_TRANSACTION_MISMATCH` |
| Its fee source is the sponsor key (pinned, or from `/health`, fetched once and cached) | `FEE_SOURCE_MISMATCH`        |
| Its fee equals `estimateSponsorCost(inner)`                                            | `FEE_MISMATCH`               |
| It has a valid signature from the sponsor key for this network                         | `MISSING_SPONSOR_SIGNATURE`  |

`sponsor()` calls this for you by default.

### `client.submit(feeBump, options?): Promise<SubmitResult>`

Submits a `FeeBumpTransaction` (or its XDR) to Horizon's `POST /transactions`. Requires
`horizonUrl`. Returns `{ hash, ledger, successful, resultXdr, raw }`. Failures throw
`HorizonSubmissionError` with `status`, `resultCodes` (e.g.
`{ transaction: 'tx_fee_bump_inner_failed', inner_transaction: 'tx_bad_seq' }`) and `resultXdr`.

Submissions are **not retried automatically**. After a timeout or a 504 the transaction may still
be included, so look up its hash before resubmitting.

### `client.sponsorAndSubmit(tx, options?): Promise<SponsorAndSubmitResult>`

`sponsor()` with verification always on, then `submit()`. Returns `{ sponsorship, submission }`.
Throws `INVALID_CONFIG` before contacting the relay if `horizonUrl` isn't set.

### `client.estimateSponsorCost(tx): number`

What the sponsor will pay, in stroops, computed locally with the relay's formula:

```
baseFee = ceil(innerTx.fee / innerOperationCount)
cost    = baseFee × (innerOperationCount + 1)
```

Works on unsigned transactions. Example: 2 operations with a 250-stroop inner fee give
`ceil(250 / 2) × 3 = 375`.

### Errors

All errors extend `FeeSponsorError` (which extends `Error`) and have an optional `status`.

| Class                      | When                                                                            | Key fields                                                       |
| -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `SponsorRejectedError`     | The relay declined (HTTP 400/403/429 with `approved: false`)                    | `reason`, `detail`, `status`, `sourceAccount`, `innerFeeStroops` |
| `RelayUnavailableError`    | Network failure, timeout, abort, 5xx, non-JSON or otherwise unexpected response | `status?`, `cause?`                                              |
| `LocalValidationError`     | A local check failed. Nothing was sent.                                         | `code`                                                           |
| `FeeBumpVerificationError` | The relay's fee bump doesn't match the request. **Don't submit it.**            | `code`                                                           |
| `HorizonSubmissionError`   | Horizon rejected the transaction or couldn't be reached                         | `status?`, `resultCodes?`, `resultXdr?`                          |

Helpers:

- `isRateLimited(err)`: `true` for `ACCOUNT_RATE_LIMITED` and `IP_RATE_LIMITED`, and for any
  relay HTTP 429 (including a proxy's HTML 429).
- `isPolicyRejection(err)`: `true` for policy decisions (`DENYLISTED_ACCOUNT`, `NOT_ALLOWLISTED`,
  `FEE_EXCEEDS_MAX`, `HOURLY_CAP_EXCEEDED`, `DAILY_CAP_EXCEEDED`).

Types: `SponsorshipRejectionReason`, `FeeSponsorClientOptions`, `RetryOptions`, `SponsorOptions`,
`RequestOptions`, `SponsorResult`, `SubmitResult`, `SponsorAndSubmitResult`,
`InnerTransactionInput`, `LocalValidationCode`, `FeeBumpVerificationCode`.

## Error handling

`SponsorRejectedError.reason` is typed as the `SponsorshipRejectionReason` union. A newer relay
may send a reason this version doesn't know, so always keep a `default` branch. `detail` is for
your logs. Don't show it to users verbatim.

| `reason`                    | HTTP | Meaning                                         | What the app should do / show                                                                                     |
| --------------------------- | ---- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `INVALID_TRANSACTION_XDR`   | 400  | The relay couldn't parse the transaction        | A bug in your app, not the user's fault. Log it and show "Something went wrong preparing your transaction."       |
| `INVALID_INNER_TRANSACTION` | 400  | Reserved: transaction structurally unacceptable | Same as above. Log `detail`.                                                                                      |
| `DENYLISTED_ACCOUNT`        | 403  | This account is blocked from sponsorship        | "This account isn't eligible for free transactions." Offer to let the user pay the fee. Don't retry.              |
| `NOT_ALLOWLISTED`           | 403  | The relay sponsors only allow-listed accounts   | "Free transactions aren't available for this account." Offer user-paid fees, or onboarding that adds the account. |
| `FEE_EXCEEDS_MAX`           | 403  | The inner fee is above the relay's cap          | Rebuild with a lower fee (check `estimateSponsorCost`). If surge pricing forced it, let the user pay or wait.     |
| `HOURLY_CAP_EXCEEDED`       | 403  | The sponsor's hourly budget is spent            | "Free transactions are busy right now. Try again later." Offer user-paid fees.                                    |
| `DAILY_CAP_EXCEEDED`        | 403  | The sponsor's daily budget is spent             | "Free transactions are unavailable for today." Offer user-paid fees.                                              |
| `ACCOUNT_RATE_LIMITED`      | 429  | This account sent too many requests             | "You're doing that too often. Wait a minute." Back off, or enable `retryOnRateLimit`.                             |
| `IP_RATE_LIMITED`           | 429  | Too many requests from this IP                  | As above. Backends sharing an IP may need the relay operator to raise the limit.                                  |

And for the other error classes:

| Error                                              | What to do                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `RelayUnavailableError`                            | Already retried. Show "Sponsorship is temporarily unavailable" and offer user-paid fees or a retry button.                   |
| `LocalValidationError` `NOT_SIGNED`                | Sign the transaction before calling `sponsor()`.                                                                             |
| `LocalValidationError` `NETWORK_MISMATCH`          | The wallet is on another network. Ask the user to switch (e.g. Freighter to Testnet).                                        |
| `LocalValidationError` (other codes)               | Bug in how the transaction was built. Log it.                                                                                |
| `FeeBumpVerificationError`                         | **Don't submit.** The relay is misconfigured or compromised. Alert the operator and fail closed.                             |
| `HorizonSubmissionError` with `resultCodes`        | Usual Horizon handling: `tx_bad_seq` means reload the account and rebuild; `tx_too_late` means rebuild with new time bounds. |
| `HorizonSubmissionError` `status: 504` / no status | The result is unknown. Look up the hash before retrying.                                                                     |

```ts
import {
  SponsorRejectedError,
  type SponsorshipRejectionReason,
} from '@stellar-fee-guild/fee-sponsor-client';

function userMessage(err: SponsorRejectedError): string {
  switch (err.reason as SponsorshipRejectionReason) {
    case 'ACCOUNT_RATE_LIMITED':
    case 'IP_RATE_LIMITED':
      return 'Too many requests. Please wait a minute and try again.';
    case 'HOURLY_CAP_EXCEEDED':
    case 'DAILY_CAP_EXCEEDED':
      return 'Free transactions are unavailable right now.';
    case 'DENYLISTED_ACCOUNT':
    case 'NOT_ALLOWLISTED':
      return "This account isn't eligible for free transactions.";
    case 'FEE_EXCEEDS_MAX':
      return 'This transaction is too expensive to sponsor right now.';
    default:
      return 'Something went wrong preparing your transaction.';
  }
}
```

## Security

- **Fee bumps are verified by default.** A relay that is malicious, compromised or misconfigured
  could return a fee bump wrapping a different transaction than the one you sent. If your app
  submits whatever comes back, it can be tricked into submitting it. `sponsor()` checks that the
  fee bump wraps your exact signed envelope, is paid and signed by the sponsor, and charges the
  expected fee. Only pass `{ verify: false }` if you verify elsewhere.
- **Pin the sponsor key in production.** By default the sponsor key comes from the relay's own
  `/health`, so a fully compromised relay could lie about it. Pass
  `sponsorPublicKey: 'G...'` to verify against a key you trust.
- **Never send secret keys anywhere.** The relay needs only the _signed_ transaction XDR. Sign on
  the client, in a wallet or with your backend's key management. Neither this SDK nor the relay
  ever asks for a secret key. If something does, it isn't legitimate.
- **Use HTTPS relay URLs in production.** The client refuses `http://` relay and Horizon URLs
  except on localhost. `allowInsecureHttp` exists for local testing only. Over plain HTTP, anyone
  on the path can read your transactions and tamper with responses.
- **Headers go to the relay only.** Credentials in `headers` (for example an API key for a
  gateway in front of the relay) are never sent to Horizon. In a browser, everything in `headers`
  is visible to the user, so don't put shared secrets there.
- **Sign last, for the right network.** Sign after the transaction is final. Signatures can't be
  added once it is wrapped, and the client checks they verify for the configured network.

## Examples

See [`examples/`](examples):

- [`examples/node/sponsor-payment.mjs`](examples/node/sponsor-payment.mjs): Friendbot-fund two
  accounts, then sponsor and submit a testnet payment.
- [`examples/browser/`](examples/browser): sign a payment with Freighter and get it sponsored,
  with no bundler (import map).

## Development

```sh
npm ci
npm run lint          # ESLint
npm run format:check  # Prettier (npm run format to fix)
npm run typecheck     # tsc --noEmit
npm test              # unit tests, mocked fetch, no network
npm run test:coverage # with coverage thresholds (90% statements/functions/lines, 85% branches)
npm run build         # ESM + .d.ts in dist/
```

**Integration tests** run against Stellar testnet and a real relay, using Friendbot-funded
accounts. They are skipped unless `FEE_SPONSOR_RELAY_URL` is set:

```sh
FEE_SPONSOR_RELAY_URL=http://localhost:8080 npm run test:integration
# optional: HORIZON_URL, FRIENDBOT_URL
```

CI runs lint, format check and typecheck, unit tests on Node 18, 20 and 22, tests against the
latest supported SDK, and a build. The integration job runs on pushes to `main` only (using the
`FEE_SPONSOR_RELAY_URL` repository secret) with `continue-on-error`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, labels and the PR checklist.

## Roadmap

Planned work is tracked in [ISSUES.md](ISSUES.md) and on GitHub. Some features need **relay
changes first**. This client only wraps endpoints that exist:

- **Quote endpoint** (e.g. `POST /quote`): ask whether a transaction _would_ be sponsored, and at
  what cost, without signing it. Today `estimateSponsorCost()` runs locally and can't see policy.
- **Request authentication**: API keys or signed requests verified by the relay. The client can
  already send arbitrary `headers`, but the relay doesn't check any.
- **Policy discovery**: expose fee caps and remaining budget, for example in `/health`, so apps
  can avoid a doomed request.
- **Structured rate-limit hints**: a documented `Retry-After` on 429 responses. The client already
  honours one if present.

Client-only items include a React hook, Soroban contract-call support, a CLI, relay failover,
a CommonJS build and telemetry hooks.

## License

[MIT](LICENSE) © Stellar Fee Guild
