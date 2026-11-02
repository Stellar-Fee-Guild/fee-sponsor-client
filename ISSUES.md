# Planned issues

Twenty scoped issues for `fee-sponsor-client`, labelled by complexity (`trivial`, `medium`,
`high`; see [CONTRIBUTING.md](CONTRIBUTING.md#finding-something-to-work-on)). Issues marked
**needs relay change** depend on new behaviour in
[fee-sponsor-relay](https://github.com/Stellar-Fee-Guild/fee-sponsor-relay). The client must not
call endpoints or read fields that don't exist yet, so that work starts with a relay issue.

| #   | Title                                                                              | Label   |
| --- | ---------------------------------------------------------------------------------- | ------- |
| 1   | Export `SPONSORSHIP_REJECTION_REASONS` and an `isSponsorshipRejectionReason` guard | trivial |
| 2   | Add `toJSON()` to error classes for structured logging                             | trivial |
| 3   | Add an error-handling example with a mocked relay                                  | trivial |
| 4   | Add a troubleshooting section to the README                                        | trivial |
| 5   | Add issue and pull request templates                                               | trivial |
| 6   | Configure Dependabot for npm and GitHub Actions                                    | trivial |
| 7   | Add a CHANGELOG and a release checklist                                            | trivial |
| 8   | Ship a CommonJS build alongside ESM                                                | medium  |
| 9   | Enforce a bundle-size budget in CI                                                 | medium  |
| 10  | Telemetry hooks: `onRequest`, `onResponse`, `onRetry`, `onError`                   | medium  |
| 11  | CLI: `npx fee-sponsor-client sponsor <xdr>`                                        | medium  |
| 12  | Stricter local XDR validation (time bounds, fee ceiling, size)                     | medium  |
| 13  | Submission helpers: wait for result and recover from Horizon 504                   | medium  |
| 14  | Vite + TypeScript browser example with a wallet picker                             | medium  |
| 15  | API-key authentication support (**needs relay change**)                            | medium  |
| 16  | React hook `useSponsoredTransaction`                                               | high    |
| 17  | Soroban contract-call support: simulate, assemble, sign, sponsor                   | high    |
| 18  | Multiple relays with health-aware failover                                         | high    |
| 19  | Signed requests: prove the calling app's identity (**needs relay change**)         | high    |
| 20  | `quote()`: ask the relay before signing (**needs relay change**)                   | high    |

---

## 1. Export `SPONSORSHIP_REJECTION_REASONS` and an `isSponsorshipRejectionReason` guard

**Labels:** `trivial`, `enhancement`, `good first issue`

### Context

`SponsorshipRejectionReason` exists only as a type. `SponsorRejectedError.reason` is typed
`SponsorshipRejectionReason | (string & {})` because a newer relay may send reasons this version
doesn't know. Apps that want an exhaustive `switch` have to cast. A runtime list plus a type
guard lets them narrow safely, and lets `errors.ts` derive its internal sets from one source.

### Acceptance criteria

- [ ] `export const SPONSORSHIP_REJECTION_REASONS` is a `readonly` tuple of all nine reasons, and
      `SponsorshipRejectionReason` is derived from it (`(typeof X)[number]`).
- [ ] `export function isSponsorshipRejectionReason(value: unknown): value is SponsorshipRejectionReason`.
- [ ] `RATE_LIMIT_REASONS` / `POLICY_REASONS` in `errors.ts` stay correct (tests already cover them).
- [ ] TSDoc on both exports; README API reference updated.
- [ ] Unit tests for known reasons, unknown strings and non-strings.

### Pointers

`src/types.ts`, `src/errors.ts`, `src/index.ts`, `test/errors.test.ts`, `README.md#errors`

---

## 2. Add `toJSON()` to error classes for structured logging

**Labels:** `trivial`, `enhancement`, `good first issue`

### Context

`JSON.stringify(err)` on an `Error` gives `{}` in most runtimes, so structured loggers (pino,
Datadog and so on) lose `reason`, `status`, `code` and `detail` unless apps copy the fields by
hand.

### Acceptance criteria

- [ ] `FeeSponsorError.prototype.toJSON()` returns `{ name, message, status }` plus each
      subclass's own fields (`reason`, `detail`, `sourceAccount`, `innerFeeStroops`, `code`,
      `resultCodes`, `resultXdr`), leaving out `undefined` values.
- [ ] `cause` is included as `{ name, message }` only. No stack traces, and no recursion into
      arbitrary objects.
- [ ] Unit test for each error class.

### Pointers

`src/errors.ts`, `test/errors.test.ts`

---

## 3. Add an error-handling example with a mocked relay

**Labels:** `trivial`, `documentation`, `good first issue`

### Context

The README has an error table, but there's no runnable example that shows each error class. A
script that injects a fake `fetch` (via the `fetch` option) can show every branch offline, with no
relay or testnet needed.

### Acceptance criteria

- [ ] `examples/node/handle-errors.mjs` builds a signed transaction locally and runs it through a
      fake relay that returns, in turn: a policy rejection (403), a rate limit (429), a 503, and a
      fee bump wrapping a different transaction.
- [ ] Each case prints which error class was caught and the user-facing message from the README
      table.
- [ ] Runs with `node handle-errors.mjs` from `examples/node` with no network access.
- [ ] Linked from `examples/README.md`.

### Pointers

`examples/node/`, `examples/README.md`, `test/helpers.ts` (`fakeRelay` shows the pattern)

---

## 4. Add a troubleshooting section to the README

**Labels:** `trivial`, `documentation`, `good first issue`

### Context

Integrators keep hitting the same problems: CORS errors in the browser, `NETWORK_MISMATCH` when
a wallet is on the wrong network, `NOT_SIGNED` because they followed the relay README's
"unsigned" wording (a known doc error there), `tx_bad_seq` after reusing a built transaction, and
`INVALID_CONFIG` for `http://` URLs.

### Acceptance criteria

- [ ] A "Troubleshooting" section in `README.md` with one entry per symptom: what you see, why it
      happens, and how to fix it.
- [ ] Covers at least: CORS, `NETWORK_MISMATCH`, `NOT_SIGNED`, `tx_bad_seq`,
      `tx_fee_bump_inner_failed`, `INVALID_CONFIG` (HTTPS), and SDK/Node version mismatch.
- [ ] Linked from the table of contents.

### Pointers

`README.md`, `src/validation.ts` (error messages), `src/client.ts` (`normalizeBaseUrl`)

---

## 5. Add issue and pull request templates

**Labels:** `trivial`, `chore`, `good first issue`

### Context

CONTRIBUTING.md defines labels, branch prefixes and a PR checklist, but GitHub doesn't show any
of it when someone opens an issue or PR.

### Acceptance criteria

- [ ] `.github/pull_request_template.md` with the checklist from CONTRIBUTING.md.
- [ ] `.github/ISSUE_TEMPLATE/bug_report.yml` (SDK version, Node/browser, relay version, minimal
      repro; reminds people to remove secret keys).
- [ ] `.github/ISSUE_TEMPLATE/feature_request.yml` with a "Does this need a relay change?"
      checkbox.
- [ ] `.github/ISSUE_TEMPLATE/config.yml` points security reports to private vulnerability
      reporting.

### Pointers

`CONTRIBUTING.md`, `.github/`

---

## 6. Configure Dependabot for npm and GitHub Actions

**Labels:** `trivial`, `chore`, `good first issue`

### Context

Dev dependencies and pinned actions (`actions/checkout@v4`, `actions/setup-node@v4`) will drift.
The `@stellar/stellar-sdk` dev dependency is deliberately held at 13.x so CI can run on Node 18.
Dependabot must not bump it past that.

### Acceptance criteria

- [ ] `.github/dependabot.yml` with weekly updates for `npm` and `github-actions`.
- [ ] Dev dependencies are grouped into one PR.
- [ ] `@stellar/stellar-sdk` major updates are ignored, with a comment explaining why (Node 18
      support; the `test-latest-sdk` CI job already covers the newest version).
- [ ] PRs use the `chore/` branch prefix convention where Dependabot allows it.

### Pointers

`.github/workflows/ci.yml` (`test-latest-sdk` job), `package.json`

---

## 7. Add a CHANGELOG and a release checklist

**Labels:** `trivial`, `documentation`, `good first issue`

### Context

There's no record of changes between versions. Integrators need to know when, for example,
verification gets stricter.

### Acceptance criteria

- [ ] `CHANGELOG.md` in [Keep a Changelog](https://keepachangelog.com) format with a `0.1.0`
      entry summarising the initial API.
- [ ] A "Releasing" section in CONTRIBUTING.md: bump the version, update the changelog, tag
      `vX.Y.Z`, `npm publish --provenance`.
- [ ] PR checklist item: "CHANGELOG updated for user-visible changes".

### Pointers

`CONTRIBUTING.md`, `package.json`

---

## 8. Ship a CommonJS build alongside ESM

**Labels:** `medium`, `enhancement`

### Context

The package is ESM-only. Older Node backends, Jest setups without ESM support, and some
serverless bundlers still `require()` packages. `@stellar/stellar-sdk` itself ships CJS, so CJS
consumers exist.

### Acceptance criteria

- [ ] `npm run build` emits `dist/esm/` and `dist/cjs/` (the CJS folder gets its own
      `package.json` with `"type": "commonjs"`), plus type declarations for both
      (`.d.ts` / `.d.cts`).
- [ ] The `exports` map has `import` and `require` conditions with matching `types`.
- [ ] Still no runtime dependencies. `@stellar/stellar-sdk` stays external in both builds.
- [ ] CI smoke-tests `require('@stellar-fee-guild/fee-sponsor-client')` and `import` from a packed
      tarball (`npm pack`), on Node 18 and 22.
- [ ] [`publint`](https://publint.dev) and
      [`@arethetypeswrong/cli`](https://arethetypeswrong.github.io) pass in CI.
- [ ] `instanceof` across the two builds is documented as a dual-package hazard. Prefer the
      `isRateLimited` / `isPolicyRejection` helpers, or add `name`-based checks.

### Pointers

`package.json` (`exports`, `scripts.build`), `tsconfig.build.json`, `.github/workflows/ci.yml`
(`build` job)

---

## 9. Enforce a bundle-size budget in CI

**Labels:** `medium`, `chore`

### Context

Browser dApps care about bytes. The client should stay small, and it must never accidentally
bundle `@stellar/stellar-sdk` (a peer dependency). Nothing checks either today.

### Acceptance criteria

- [ ] A `size` script (e.g. `size-limit` with the esbuild preset, as a dev dependency) measures
      the minified + gzipped ESM entry with `@stellar/stellar-sdk` marked external.
- [ ] Budget set at current size + ~10%, recorded in `package.json` or `.size-limit.json`.
- [ ] CI fails if the budget is exceeded. On PRs, the size change is reported (comment or job
      summary).
- [ ] A test or check that fails if any `@stellar/stellar-sdk` code ends up in the bundle.

### Pointers

`.github/workflows/ci.yml`, `package.json`, `src/index.ts`

---

## 10. Telemetry hooks: `onRequest`, `onResponse`, `onRetry`, `onError`

**Labels:** `medium`, `enhancement`

### Context

Operators want to measure sponsorship latency, retry rates and rejection reasons, and to forward
them to OpenTelemetry, Sentry or their own metrics, without wrapping `fetch`. The client must stay
dependency-free, so this should be plain callbacks, not a tracing library.

### Acceptance criteria

- [ ] `FeeSponsorClientOptions.hooks?: { onRequest?, onResponse?, onRetry?, onError? }`, all
      optional and synchronous. A throwing hook is caught and never breaks the request.
- [ ] Events carry: method, URL path (not the full URL with query), attempt number, status,
      duration in ms, retry delay, and the typed error. Never the transaction XDR or headers,
      which may hold credentials.
- [ ] `onRetry` fires once per backoff with the delay chosen.
- [ ] Covers relay calls and Horizon submission (with a `target: 'relay' | 'horizon'` field).
- [ ] Unit tests for each hook, including a throwing hook.
- [ ] A README example forwarding to `console` and an OpenTelemetry sketch.

### Pointers

`src/http.ts` (`requestWithRetry`, `fetchOnce`), `src/client.ts`, `src/types.ts`

---

## 11. CLI: `npx fee-sponsor-client sponsor <xdr>`

**Labels:** `medium`, `enhancement`

### Context

Relay operators and integrators debugging a rejection want to send one XDR to a relay from the
terminal and see the typed result, without writing a script.

### Acceptance criteria

- [ ] A `bin` entry `fee-sponsor-client` with these commands:
  - `health --relay <url>`
  - `sponsor <xdr|-> --relay <url> --network testnet|public|<passphrase> [--submit --horizon <url>] [--no-verify] [--json]`
  - `estimate <xdr|->`
- [ ] Reads XDR from stdin when given `-`.
- [ ] Uses `node:util` `parseArgs` (Node 18.3+). No new runtime dependencies.
- [ ] Exit codes: `0` success, `2` local validation, `3` rejection, `4` relay unavailable,
      `5` verification failure, `6` Horizon failure. `--json` prints machine-readable output,
      including `reason`/`code`.
- [ ] Never accepts a secret key (no `--secret` flag). Documented in `--help`.
- [ ] Unit tests drive the CLI entry function with an injected `fetch`. A README section covers
      usage.

### Pointers

`package.json` (`bin`), new `src/cli.ts`, `src/client.ts`

---

## 12. Stricter local XDR validation (time bounds, fee ceiling, size)

**Labels:** `medium`, `enhancement`

### Context

`sponsor()` checks only the basics: parseable, not a fee bump, at least one op, signed, right
network. Some transactions are bound to fail and waste a relay round-trip or a rate-limit slot:
expired time bounds, absurd fees the relay will reject with `FEE_EXCEEDS_MAX`, or oversized
envelopes.

### Acceptance criteria

- [ ] New `LocalValidationCode`s: `EXPIRED` (`maxTime` in the past, with configurable clock
      skew), `FEE_TOO_HIGH` (inner fee above an optional `maxInnerFeeStroops` client option),
      `ENVELOPE_TOO_LARGE`.
- [ ] Optional `requireSourceSignature: true` makes a signature from the source account mandatory
      (today, signatures from other signers are accepted for multisig).
- [ ] Checks that need configuration are opt-in. Defaults stay backwards compatible.
- [ ] Every new branch is unit-tested with real SDK-built transactions.
- [ ] README validation table updated.

### Pointers

`src/validation.ts`, `src/errors.ts` (`LocalValidationCode`), `src/types.ts`,
`test/validation.test.ts`

---

## 13. Submission helpers: wait for result and recover from Horizon 504

**Labels:** `medium`, `enhancement`

### Context

`submit()` makes one synchronous `POST /transactions`. When Horizon returns 504 (or the request
times out), the transaction may still land. Apps currently have to work out the hash and poll
`GET /transactions/:hash` themselves.

### Acceptance criteria

- [ ] `HorizonSubmissionError` exposes the fee-bump `hash` when it is known.
- [ ] New `client.waitForTransaction(hash, { timeoutMs, signal })` polls Horizon until the
      transaction is found (returns a `SubmitResult`) or the timeout passes.
- [ ] `submit(feeBump, { recoverTimeout: true })` checks the hash after a 504 or timeout before
      throwing.
- [ ] Optional support for Horizon's `POST /transactions_async`, behind an option.
- [ ] No automatic resubmission of a transaction whose outcome is unknown.
- [ ] Unit tests with a mocked Horizon.

### Pointers

`src/client.ts` (`submit`), `src/errors.ts` (`HorizonSubmissionError`), `src/http.ts`

---

## 14. Vite + TypeScript browser example with a wallet picker

**Labels:** `medium`, `documentation`

### Context

`examples/browser` is deliberately bundler-free and Freighter-only. Most production dApps use a
bundler and support several wallets (Freighter, xBull, Albedo, Lobstr…).

### Acceptance criteria

- [ ] `examples/vite-wallets/` is a Vite + TypeScript app using
      [Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit) (or similar) to
      pick a wallet, sign a testnet payment and sponsor it.
- [ ] Shows estimated sponsor cost before signing, and user-friendly messages for every rejection
      reason (from the README table).
- [ ] Relay URL comes from `VITE_FEE_SPONSOR_RELAY_URL`.
- [ ] The example has its own `package.json` and isn't part of the root build. A CI job
      type-checks and builds it.

### Pointers

`examples/browser/` (current example), `examples/README.md`, `README.md#error-handling`

---

## 15. API-key authentication support (needs relay change)

**Labels:** `medium`, `enhancement`, `needs relay change`

### Context

Operators running a public relay want to know which app is calling and give each its own limits.
The client can already send arbitrary `headers`, but **fee-sponsor-relay doesn't check any
credential today**, so this needs a relay change first, plus a documented header name and a
rejection reason for bad keys.

### Acceptance criteria

- [ ] A linked issue on fee-sponsor-relay specifying: header name (e.g.
      `Authorization: Bearer <key>`), the HTTP status and `reason` for missing or invalid keys
      (e.g. `401` + `UNAUTHORIZED`), and whether `/health` needs a key.
- [ ] Once the relay ships it: a client option `apiKey?: string` sets the header on relay requests
      only (never Horizon). `SponsorshipRejectionReason` gains the new reason, and the 401 is
      parsed as a `SponsorRejectedError` and never retried.
- [ ] README security notes: API keys in browser code are public identifiers, not secrets. Use
      them for attribution and limits, not authorization. See #19 for real authentication.
- [ ] Unit tests with a mocked relay.

### Pointers

`src/client.ts` (`#relayRequest`, `REJECTION_STATUSES`), `src/types.ts`, `README.md#roadmap`

---

## 16. React hook `useSponsoredTransaction`

**Labels:** `high`, `enhancement`

### Context

Most dApps using this SDK are React apps. They all write the same state machine: idle → signing
→ sponsoring → submitting → success/error, with mapped messages, abort on unmount, and
double-submit protection.

### Acceptance criteria

- [ ] Ships as a separate entry point (`@stellar-fee-guild/fee-sponsor-client/react`) or a
      sibling package, with `react` as an **optional** peer dependency. The core entry must not
      import React.
- [ ] `useSponsoredTransaction(client, { sign })` returns
      `{ status, run(tx), result, error, reset, isRateLimited, isPolicyRejection }`, where `sign`
      is a wallet callback (`(xdr) => Promise<signedXdr>`).
- [ ] Aborts in-flight requests on unmount and when `run` is called again. Ignores stale results.
- [ ] Works with React 18 and 19, StrictMode-safe (double effects), SSR-safe (no `window` access
      at import).
- [ ] Tests with `@testing-library/react` (dev dependency) covering every state transition and
      abort.
- [ ] README section and an example using Freighter.

### Pointers

`src/client.ts` (`sponsorAndSubmit`, `signal` support), `src/errors.ts` (helpers),
`package.json` (`exports`, `peerDependenciesMeta`), `examples/browser/`

---

## 17. Soroban contract-call support: simulate, assemble, sign, sponsor

**Labels:** `high`, `enhancement`

### Context

Soroban `invokeHostFunction` transactions must be simulated (via Stellar RPC) and assembled with
the resulting footprint, auth and resource fee before signing. Their fee includes a resource fee,
which interacts with the relay's cost formula (`ceil(fee / ops) × (ops + 1)`, and Soroban
transactions have exactly one operation). Integrators need a guided path, and we need to confirm
the relay's policy and fee caps behave sensibly for Soroban fees.

### Acceptance criteria

- [ ] Investigate and document how the relay's formula and `FEE_EXCEEDS_MAX` apply to Soroban
      transactions (inclusion fee vs resource fee). If the relay needs changes (e.g. a
      resource-fee-aware cap), open a linked fee-sponsor-relay issue and note it in the README
      roadmap.
- [ ] A helper (e.g. `prepareSorobanTransaction(rpcUrl, tx)` or documented recipe) that
      simulates and assembles using the peer SDK's `rpc.Server`, then hands off to `sign` and
      `sponsor()`. No new runtime dependencies.
- [ ] `estimateSponsorCost` documented and tested for assembled Soroban transactions.
- [ ] Local validation is correct for `invokeHostFunction` (one op, `sorobanData` present).
- [ ] An integration test that invokes a known testnet contract through a relay (skipped without
      env).
- [ ] An example in `examples/`.

### Pointers

`src/validation.ts`, `src/verify.ts` (fee check), `src/client.ts`, `test/integration/`

---

## 18. Multiple relays with health-aware failover

**Labels:** `high`, `enhancement`

### Context

A single relay is a single point of failure. Apps want to configure several relays (their own
plus a partner's) and fail over when one is down or out of budget.

### Acceptance criteria

- [ ] An option like `relays: Array<{ url, sponsorPublicKey?, headers?, weight? }>` (mutually
      exclusive with `relayUrl`).
- [ ] Fail over on `RelayUnavailableError` and on budget rejections (`HOURLY_CAP_EXCEEDED`,
      `DAILY_CAP_EXCEEDED`). **Never** on `DENYLISTED_ACCOUNT`, `NOT_ALLOWLISTED`,
      `FEE_EXCEEDS_MAX` or 400s unless configured, because other relays should give the same
      answer. Rate limits are configurable.
- [ ] A circuit breaker: a relay that keeps failing is skipped for a cool-down period.
      Half-open probes use `GET /health`.
- [ ] **Verification uses the sponsor key of the relay that answered**, cached per relay. A test
      proves that relay B's fee bump is rejected when checked against relay A's key.
- [ ] `SponsorResult` reports which relay sponsored it.
- [ ] Unit tests with multiple mocked relays: ordering, failover, breaker open/half-open/close.

### Pointers

`src/client.ts` (`#relayRequest`, `#getSponsorKey`), `src/http.ts`, `src/types.ts`

---

## 19. Signed requests: prove the calling app's identity (needs relay change)

**Labels:** `high`, `enhancement`, `needs relay change`, `security`

### Context

API keys (#15) are bearer tokens, and in browsers they are public. Backends calling a relay can
do better: sign each request with an ed25519 key the relay knows, so the relay can authenticate
the app, reject replays and attribute spend. **This needs a relay change and a written spec
first.**

### Acceptance criteria

- [ ] A design doc and linked fee-sponsor-relay issue specifying: the signed payload (method,
      path, body hash, timestamp, nonce), headers, clock-skew window, replay protection, key
      registration, and the rejection reasons and HTTP status for bad signatures.
- [ ] Client: `requestSigner?: (req: { method, path, body, timestamp }) => Promise<Record<string, string>>`
      so keys can live in an HSM or KMS. The SDK never holds the key itself, plus a helper for
      Stellar `Keypair` signers in Node.
- [ ] A re-signed request on every retry (fresh timestamp and nonce).
- [ ] Browser guidance: don't do this in browsers. Use a backend.
- [ ] Unit tests with a mocked relay that verifies signatures.

### Pointers

`src/http.ts` (`requestWithRetry`, which must re-sign per attempt), `src/client.ts`,
`src/types.ts`, `README.md#security`

---

## 20. `quote()`: ask the relay before signing (needs relay change)

**Labels:** `high`, `enhancement`, `needs relay change`

### Context

Today an app only learns whether a transaction will be sponsored after the user has signed it.
If the relay then rejects it (`NOT_ALLOWLISTED`, `DAILY_CAP_EXCEEDED`), the user has signed for
nothing. `estimateSponsorCost()` runs locally and can't see policy. A relay "dry run" would let
apps check first and fall back to user-paid fees **before** prompting a signature. **The relay
has no such endpoint today.**

### Acceptance criteria

- [ ] A linked fee-sponsor-relay issue proposing e.g. `POST /quote` that takes an _unsigned_
      transaction and returns `{ approved, reason?, sponsorFeeStroops, expiresAt? }`, running the
      policy engine without consuming budget or signing. It also needs a decision on whether a
      quote reserves budget.
- [ ] Once shipped: `client.quote(tx)` returns a typed result. Rejections reuse
      `SponsorshipRejectionReason`.
- [ ] Docs: a quote is advisory, and `sponsor()` can still be rejected (budget is shared and rate
      limits apply).
- [ ] Unit tests, plus an integration test (skipped without env).

### Pointers

`src/client.ts`, `src/types.ts`, `src/validation.ts` (`parseTransaction` already handles
unsigned transactions), `README.md#roadmap`, sponsor-policy-engine (for which decisions can be
evaluated without side effects)
