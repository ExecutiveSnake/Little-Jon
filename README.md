# Analysis Credits — Prepaid AI Trading-Analysis Credits on Robinhood Chain

An illiquid, non-transferable prepaid credit system for an AI trading-analysis
service, plus scaffolding for a guardrailed trading bot that consumes it.

```
contracts/          Foundry project: AnalysisCredits.sol + tests + deploy script
metering-service/    Node/TypeScript: listens for Deposit events, serves analysis
                     requests, debits credits idempotently
trading-bot/         Node/TypeScript scaffold: ERC-4337 session-key account,
                     Chainlink price reads, metering-gated trades, risk guardrails
```

## How it fits together

1. A user calls `AnalysisCredits.deposit(amount)` with USDe (or whatever
   `settlementToken` the contract is deployed with). They receive an internal,
   non-transferable `credits` balance — there is no `transfer`/`approve`, so credits
   can never move between accounts or trade on a secondary market.
2. `metering-service` watches for `Deposit` events (via an Alchemy WebSocket endpoint)
   and exposes an internal `POST /v1/analyze` API. On a request, it checks the user's
   on-chain credit balance, calls the Claude API for the actual analysis, and — only
   once analysis has actually been delivered — calls
   `AnalysisCredits.debitCredit(user, calls)` from a relayer key holding
   `RELAYER_ROLE`.
3. `trading-bot` is a scaffold for a strategy that, before every trade: checks a
   manual kill switch and daily loss circuit breaker, enforces a max position size,
   reads a Chainlink Stock Token price feed and enforces a max slippage band, calls
   the metering service for analysis (a trade never executes without it), and then
   builds/signs an ERC-4337 UserOperation with a session key that is scoped to a
   specific allowlist of target contracts and function selectors — never full account
   custody.

## Prerequisites

- [Foundry](https://getfoundry.sh) (`forge`, `cast`, `anvil`) for the contracts.
- Node.js 20+ for the two TypeScript services.
- An Alchemy account with Robinhood Chain support enabled, for the metering
  service's WebSocket event listener.
- An [Anthropic API key](https://console.anthropic.com/) for the metering service's
  Claude-based analysis agent.

Install Foundry:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

> **Foundry could not be installed in the sandbox this repo was built in**, so
> `forge build`/`forge test` were never run directly here — two independent things
> were tried and both were blocked by that environment's outbound network policy:
> the normal `foundryup` install (blocked at `foundry.paradigm.xyz`), and building
> `forge`/`cast`/`anvil` from source via `cargo install --git
> https://github.com/foundry-rs/foundry` (which compiles, but its `svm-rs-builds`
> build script fetches `https://binaries.soliditylang.org/.../list.json` at build
> time, which was also blocked). Neither is a Foundry problem — both are specific to
> that sandbox's network allowlist, and Foundry installs normally in an unrestricted
> environment.
>
> Instead, every contract, test, and script in `contracts/` was validated by
> compiling it with `solc` (0.8.24) directly against the real vendored
> `forge-std`/`openzeppelin-contracts` sources — all three files compile cleanly with
> no errors. That confirms syntax/type correctness (imports resolve, function/event
> signatures match, etc.) but **not** runtime behavior. Run `forge build && forge
> test -vvv` yourself before trusting the test suite's results — it's what actually
> exercises event emission, reverts, access control, and the fuzz tests.

## 1. Contracts (`contracts/`)

Dependencies (`forge-std` v1.9.6, `openzeppelin-contracts` v5.4.0) are vendored as git
submodules under `contracts/lib/`. If you cloned this repo without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

### Build & test

```bash
cd contracts
forge build
forge test -vvv
```

The suite in `test/AnalysisCredits.t.sol` covers deposit/credit-minting math (including
rounding), rate-change time-lock behavior (queued changes only apply to future
deposits, time-lock enforcement, event emission), `debitCredit` access control and
insufficient-balance reverts, treasury withdrawal access control, and fuzz tests for
the conversion-rate math and debit underflow safety.

### `AnalysisCredits.sol` summary

- `deposit(uint256 amount)` — pulls `amount` of the settlement token from the caller
  and mints `credits[msg.sender] += amount / (costPerCall * (1 + marginBps / 10_000))`
  (floored). Emits `Deposit`.
- `credits(address)` — public mapping, the only balance surface. No `transfer`,
  `approve`, or `transferFrom` exist anywhere in the contract.
- `debitCredit(address user, uint256 calls)` — burns `calls` credits from `user`.
  Restricted to `RELAYER_ROLE` (OpenZeppelin `AccessControl`). Emits `Debit`.
- `queueRateUpdate(uint256 newCostPerCall, uint256 newMarginBps)` — owner-only. Queues
  a new rate that only takes effect after `rateUpdateDelay` seconds, so depositors see
  pricing changes coming (`RateUpdateQueued` event) before they apply
  (`RateUpdated` event, once the delay elapses). Deposits already made are priced at
  the rate in effect at deposit time and are never retroactively repriced.
  `activatePendingRate()` lets anyone flip a due rate change on-chain explicitly.
- `withdrawTreasury(address to, uint256 amount)` — owner-only, sweeps accumulated
  settlement token out of the contract at any time. Does not touch user `credits`
  balances (those are an internal ledger, not a claim on the contract's token
  balance).
- Roles: `Ownable` gates treasury/rate-management/relayer-role management;
  `AccessControl`'s `RELAYER_ROLE` gates `debitCredit`. See the NatSpec on the
  constructor for how the two authority tracks relate if you transfer ownership.

### Deploy to Robinhood Chain testnet

1. **Get testnet funds and RPC/explorer details.** Robinhood Chain testnet's RPC
   endpoint, chain ID, block explorer, and faucet are not yet public as of this
   writing — check Robinhood's official developer documentation / status page for the
   current values before deploying, and do not rely on any URL you find elsewhere
   without verifying it against Robinhood's own docs. Once you have them, fill in
   `contracts/.env`:

   ```bash
   cd contracts
   cp .env.example .env
   # then edit .env:
   #   ROBINHOOD_TESTNET_RPC_URL=<official testnet RPC>
   #   ROBINHOOD_EXPLORER_API_URL=<official testnet explorer API>
   #   ROBINHOOD_EXPLORER_API_KEY=<explorer API key, if verification is supported>
   ```

2. **Get a settlement token address.** Either the real testnet USDe deployment (from
   Ethena's docs, if bridged to Robinhood Chain testnet) or deploy the included
   `test/mocks/MockUSDe.sol` for a throwaway testnet-only stand-in.

3. **Set deployment parameters** in `contracts/.env` (see `.env.example` for all
   fields): `PRIVATE_KEY`, `SETTLEMENT_TOKEN`, `COST_PER_CALL`, `MARGIN_BPS`,
   `RATE_UPDATE_DELAY`, and optionally `ADMIN_ADDRESS`/`RELAYER_ADDRESS`.

4. **Deploy:**

   ```bash
   source .env
   forge script script/DeployAnalysisCredits.s.sol:DeployAnalysisCredits \
     --rpc-url robinhood_testnet \
     --broadcast \
     --verify \
     -vvvv
   ```

   `--verify` requires `ROBINHOOD_EXPLORER_API_URL`/`ROBINHOOD_EXPLORER_API_KEY` to be
   set and the explorer to support the standard Etherscan-compatible verification API;
   drop `--verify` if the testnet explorer doesn't support it yet.

5. **Grant the relayer role** to the metering service's relayer address (skip this if
   you set `RELAYER_ADDRESS` in `.env` and `ADMIN_ADDRESS` equals the deployer):

   ```bash
   cast send <ANALYSIS_CREDITS_ADDRESS> "grantRelayer(address)" <RELAYER_ADDRESS> \
     --rpc-url robinhood_testnet --private-key $PRIVATE_KEY
   ```

6. Repeat against `robinhood_mainnet` in `foundry.toml` only after the testnet
   deployment has been reviewed/audited — this contract has not undergone an external
   audit.

## 2. Metering service (`metering-service/`)

```bash
cd metering-service
cp .env.example .env   # fill in ALCHEMY_*_URL, ANALYSIS_CREDITS_ADDRESS,
                        # RELAYER_PRIVATE_KEY, ANTHROPIC_API_KEY
npm install
npm test                # vitest — idempotency/retry + analysis-agent unit tests
npm run dev              # or: npm run build && npm start
```

- `src/chain/listener.ts` subscribes to `Deposit` on `ANALYSIS_CREDITS_ADDRESS` over
  the Alchemy WS endpoint, and backfills any events missed while offline using the
  HTTPS endpoint on startup.
- `src/api/analysisClient.ts` is the analysis agent: it calls the Claude API
  (`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`, default `claude-sonnet-5`) with
  `tool_choice` forced to a `submit_analysis` tool, so the response is always a
  structured `{ direction: "buy"|"sell"|"hold", score, summary, keyRisks }` —
  never free text that has to be parsed hopefully. It analyzes exactly what it's
  given (current price + optional recent history from the caller's oracle read, plus
  optional `newsContext`) and does **not** fetch news/sentiment from any social API
  itself — `newsContext` is meant to be manually curated (by an operator, or whatever
  trusted process you run) and passed straight through, precisely so a noisy or
  rate-limited feed (e.g. Twitter/X's API) can never silently degrade analysis
  quality. Point `analysisClient.ts` at your own curation pipeline later if you want
  that automated.
- `src/api/server.ts` exposes:
  - `GET /v1/credits/:address` — on-chain credit balance (source of truth; never
    trust a local cache for this).
  - `POST /v1/analyze` — `{ idempotencyKey, userAddress, calls, symbol, kind,
    priceContext: { currentPrice, asOf, recentHistory? }, newsContext? }` → checks
    balance, calls the Claude API, debits credits on success.
- `src/api/meteringService.ts` is the idempotency/retry core. Guarantees (see the unit
  tests in `test/meteringService.test.ts`):
  - A request is never charged (debited) unless analysis was actually delivered.
  - Retrying a request that already delivered analysis but failed to debit does
    **not** call the (potentially costly) Claude API a second time — it goes straight
    to retrying the debit.
  - Retrying a request that fully completed (`debited`) replays the cached result
    instead of re-running anything.
  - Reusing an idempotency key with different parameters is rejected outright.
- This API is internal-only — it has no authentication built in and is meant to sit
  behind a gateway/mTLS/VPC boundary that authenticates the caller (the trading bot,
  a frontend BFF, etc.).

## 3. Trading bot scaffold (`trading-bot/`)

```bash
cd trading-bot
cp .env.example .env
cp config/session-key-policy.example.json config/session-key-policy.json  # edit targets
npm install
npm test                 # vitest — guardrail and session-key-policy unit tests
npm run dev               # runs the single-cycle scaffold in src/index.ts
```

This is a **scaffold**, not a runnable strategy — `src/index.ts` submits a stub
`TradeRequest` and is meant to be replaced with real DEX-quote/calldata-building logic.
What it does provide, fully wired:

- **Session-key scoping** (`src/smartAccount/sessionKeyPolicy.ts`,
  `src/smartAccount/userOpBuilder.ts`): the bot holds a hot key that can only sign
  UserOperations, and `assertActionAllowed` rejects any call whose target contract,
  function selector, or value isn't explicitly allow-listed in
  `config/session-key-policy.json` before a UserOperation is ever built. **This
  off-chain check is a second line of defense, not the primary one** — the real
  enforcement has to live in your smart account's on-chain session-key validator
  module (ZeroDev Kernel, Safe{Core} session key module, or a bespoke validator),
  registered with the same constraints. The session key must never be able to change
  the account's owner/modules or move funds outside the allowlist.
- **Chainlink price reads** (`src/oracle/chainlinkPriceFeed.ts`): reads Robinhood
  Chain Stock Token feeds via the standard `AggregatorV3Interface`, and rejects
  stale or non-positive answers.
- **Mandatory analysis gating** (`src/analysis/meteringClient.ts`): every guarded
  trade calls the metering service first, passing along the Chainlink price just read
  and any operator-supplied `TradeRequest.newsContext` (again, manually curated —
  never auto-fetched); a metering-service failure or insufficient credits aborts the
  trade rather than proceeding without analysis. The result comes back as
  `{ direction, score, summary, keyRisks }`; `src/index.ts`'s example gate only
  proceeds when `direction === "buy" && score > 0.6` — replace with your own
  threshold/logic.
- **Hard guardrails** (`src/risk/guardrails.ts`):
  - Max position size (`MAX_POSITION_SIZE_USD`).
  - Max slippage vs. the Chainlink reference price (`MAX_SLIPPAGE_BPS`).
  - Daily loss circuit breaker (`DAILY_LOSS_LIMIT_USD`) — accumulates realized losses
    per UTC day across trades (persisted to disk so it survives a restart) and is
    one-directional: later gains don't "buy back" headroom once tripped.
  - Manual kill switch — `touch <KILL_SWITCH_PATH>` halts all trading immediately,
    independent of the chain/bundler/metering service being reachable; delete the
    file to resume.
- `src/trade/executor.ts#executeGuardedTrade` runs all of the above, in order, before
  ever building a UserOperation, and submits it via the ERC-4337 bundler
  (`eth_estimateUserOperationGas` / `eth_sendUserOperation`) once every check passes.

## Security notes

- Neither contract nor services here have been audited. Treat this as a starting
  point, not production-ready code — get an independent audit of `AnalysisCredits.sol`
  and a security review of the session-key scoping (both the off-chain check and
  whatever on-chain validator module you pair it with) before handling real funds.
- The relayer private key (`metering-service`) and the session key (`trading-bot`)
  should both live in a KMS/secrets manager in any real deployment, not a plaintext
  `.env` file.
- `AnalysisCredits` credits are intentionally illiquid and non-refundable to users by
  design (no `withdraw`/`redeem` for depositors) — make sure your terms of service
  reflect that before accepting deposits.
