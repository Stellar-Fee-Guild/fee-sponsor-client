# Examples

Both examples run on **testnet** against a fee-sponsor-relay you control. Run one locally with
the [fee-sponsor-relay](https://github.com/Stellar-Fee-Guild/fee-sponsor-relay) README, configured for testnet.

## Node: sponsor and submit a payment

```sh
npm run build                 # at the repo root
cd examples/node
npm install
FEE_SPONSOR_RELAY_URL=http://localhost:8080 npm start
```

It creates two Friendbot-funded accounts, signs a 10 XLM payment with the source key, has the
relay sponsor it, verifies the fee bump and submits it to Horizon.

## Browser: Freighter-signed transaction

```sh
npm run build                 # at the repo root
npx http-server . -p 5173     # or: python3 -m http.server 5173
# open http://localhost:5173/examples/browser/
```

There's no bundler: an import map loads `@stellar/stellar-sdk` and `@stellar/freighter-api` from
esm.sh and this package from `dist/`. You need the [Freighter](https://www.freighter.app/)
extension set to Testnet and a Friendbot-funded account. The relay must allow your page's origin
(CORS).
