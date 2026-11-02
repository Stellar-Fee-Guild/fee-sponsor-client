# Contributing to fee-sponsor-client

Thanks for helping. This is the client SDK of the Stellar Fee Guild projects. Its siblings are
[fee-sponsor-relay](https://github.com/Stellar-Fee-Guild/fee-sponsor-relay) (the HTTP service) and
[sponsor-policy-engine](https://github.com/Stellar-Fee-Guild/sponsor-policy-engine) (its policy
library). By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Finding something to work on

Issues are labelled by how much work they take:

| Label     | Meaning                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| `trivial` | A few lines or a docs change. Good first issue.                               |
| `medium`  | A self-contained feature or fix with tests. Touches one or two modules.       |
| `high`    | Design work. May span several modules, add public API, or need relay changes. |

Comment on an issue before you start so two people don't build the same thing. For `high` issues,
agree the design in the issue thread before opening a PR.

**Relay API changes:** this client wraps the relay's API exactly as it is (`POST /sponsor`,
`GET /health`). If your feature needs a new endpoint or field, open an issue on
fee-sponsor-relay first and link it. Don't add client code for endpoints that don't exist yet.

## Development setup

Requires Node 18 or later.

```sh
git clone https://github.com/Stellar-Fee-Guild/fee-sponsor-client.git
cd fee-sponsor-client
npm ci
npm test
```

| Script                     | What it does                                             |
| -------------------------- | -------------------------------------------------------- |
| `npm run lint`             | ESLint (`@typescript-eslint` + `eslint-config-prettier`) |
| `npm run format`           | Prettier, writing changes (`format:check` only checks)   |
| `npm run typecheck`        | `tsc --noEmit` over sources and tests                    |
| `npm test`                 | Unit tests (Vitest, `fetch` mocked, no network)          |
| `npm run test:coverage`    | Unit tests with v8 coverage and enforced thresholds      |
| `npm run test:integration` | Testnet end-to-end, needs `FEE_SPONSOR_RELAY_URL`        |
| `npm run build`            | Compile ESM and type declarations to `dist/`             |

## Branches

Branch from `main` with one of these prefixes:

- `feat/`: new functionality (`feat/react-hook`)
- `fix/`: bug fixes (`fix/retry-after-parsing`)
- `docs/`: documentation only (`docs/error-table`)
- `chore/`: tooling, CI, dependencies, refactors (`chore/bump-vitest`)

## Code guidelines

- TypeScript strict mode with `noUncheckedIndexedAccess`. No `any` in the public API.
- Keep the public API small. Every export needs TSDoc. Anything exported from `src/index.ts` is a
  semver commitment.
- No new runtime dependencies. `@stellar/stellar-sdk` is a peer dependency and must stay one.
- Code must run in Node 18+ and modern browsers: no Node-only APIs in `src/` (`Buffer`, `fs`,
  `process`).
- The supported SDK range is `>=13 <18`. XDR accessors changed shape in v17. Go through
  `src/compat.ts` rather than calling `sig.hint()` or similar directly.
- Tests build real signed transactions with the SDK and mock `fetch`. They must not touch the
  network. Coverage thresholds: 90% statements, functions and lines, 85% branches.

## Pull request checklist

- [ ] The branch name uses `feat/`, `fix/`, `docs/` or `chore/`.
- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test` and `npm run build`
      all pass locally.
- [ ] New behaviour has unit tests. Bug fixes include a test that fails without the fix.
- [ ] Public API changes have TSDoc and are reflected in the README's API reference.
- [ ] No new runtime dependencies, and no Node-only APIs in `src/`.
- [ ] Anything that needs relay changes is linked to a fee-sponsor-relay issue.
- [ ] The PR description says what changed and why, and links the issue it closes.

## Reporting security issues

Please don't open public issues for vulnerabilities, for example a way to make `verifyFeeBump`
accept a swapped transaction. Use GitHub's private vulnerability reporting on this repository.
