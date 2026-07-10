# Little Jon — AI Trading-Analysis Bot on Robinhood Chain

Little Jon is a user-in-the-loop trading system for Robinhood Chain — with
cross-chain support for Ethereum and Solana: users prepay
for AI analysis with an illiquid, non-transferable credit, ask the bot to find a
trade setup on any tradable token, manually confirm (with their own position size)
any proposal that clears a confidence bar, and let a persistent watcher execute
entries, stop-losses, and take-profits on-chain through a scoped smart account.

```
contracts/          Foundry project: AnalysisCredits.sol (prepaid credits) + tests
metering-service/    Node/TS: Deposit-event indexer + credit-gated Claude analysis API
trading-bot/         Node/TS "Little Jon": token resolution, candle history, proposal
                     flow, SL/TP watcher, ZeroDev smart-account execution, CLI
```

## The flow

1. **Prepay.** A user deposits USDe (or the configured settlement token) into
   `AnalysisCredits.deposit()` and receives internal, non-transferable credits —
   no `transfer`/`approve` exists, so credits can never trade on a secondary market.
2. **Analyze.** `littlejon analyze <token>` — the token can be an address or a name
   ("NVDA", "pepe"); names resolve through the local registry + Blockscout search,
   ranked market-cap first, then volume, then holders. The bot verifies the token is
   actually tradable (stock token, or LP'd on Uniswap V2 — anything else is refused),
   seeds price history once (Chainlink round-walk / V2 swap replay), and asks the
   metering service for a trade plan. The metering service checks the user's on-chain
   credit balance, has Claude study the 1h/4h/1d charts, and only debits a credit when
   analysis is actually delivered.
3. **Gate.** A plan must clear the confidence threshold (user-settable, hard floor
   65%). Below it, the bot re-analyzes from a fresh angle up to
   `MAX_ANALYSIS_ATTEMPTS` times — each pass costs a credit — and if nothing
   qualifies it says so instead of trading a weak setup.
4. **Confirm.** A qualifying plan is saved as a *proposal*: direction (spot long),
   market-or-trigger entry, stop-loss, take-profit, confidence, rationale, risks.
   Nothing executes until the user runs `littlejon confirm <id> --size <USD>`.
5. **Watch & execute.** The watcher (one shared backend loop for all users'
   positions) polls trusted prices every 60 seconds by default
   (`WATCHER_POLL_INTERVAL_MS`) — cheap on-chain reads and free Pyth pulls, no
   credit cost — fires
   trigger entries, stop-losses, and take-profits, executes swaps through the smart
   account, and confirms every exit by measuring the USDG/rhETH actually received
   in the wallet before notifying. Realized P&L feeds a daily-loss circuit breaker.

## Chains

| Chain | Token classes | Execution |
| --- | --- | --- |
| Robinhood Chain (default) | stock, LP, major | full (0x RFQ / V2 router via smart account) |
| Ethereum | LP (canonical Uniswap V2), major | full — majors trade via their wrapped forms (ETH→WETH, BTC→WBTC ↔ USDC) |
| Solana | major only | **paper** (labeled; oracle-priced tracking, P&L excluded from the loss breaker) until a venue is wired |

Select with `littlejon analyze <token> --chain ethereum` (CLI) or the `chain`
field on `POST /api/analyze`. Non-home-chain data is namespaced in the local
store (`ethereum:0x…`, `major:SOL`), so nothing collides.

## Token classes & venues

| Class | Identified by | Price source | Executes via | History backfill |
| --- | --- | --- | --- | --- |
| Stock token | ERC-8056 `uiMultiplier()` | Chainlink feed (multiplier included) | 0x RFQ ↔ USDG | Chainlink round-walk |
| LP'd token | live Uniswap V2 pair vs the chain's USD/ETH quote | pair reserves | V2 router swap | Swap-event replay |
| Major asset (ETH, SOL, BTC, …) | symbol match | **Pyth oracle** (Hermes, staleness-checked) | wrapped form on EVM; paper elsewhere | Pyth Benchmarks bars |
| Anything else | — | — | **refused** | — |

Bonding-curve (RobinFun) tokens that haven't graduated to a Uniswap pool are
deliberately unsupported. Prices for LP tokens are denominated in their quote asset
(USDG or rhETH) end-to-end — candles, triggers, SL/TP all share the same units;
USD conversion (for sizing and P&L) goes through the ETH/USD feed or the
USDG/rhETH pair.

Oracle trust rules (per Robinhood Chain docs): staleness check against the feed
heartbeat, reject non-positive answers, respect the advisory `oraclePaused()` flag
during corporate actions, and check the L2 sequencer uptime feed (with a
post-recovery grace period) before trusting any price. When no trusted price is
available for a token, the watcher does nothing for it that tick — no trigger may
fire off an untrusted price.

## Safety model

- **Manual confirmation, always.** The bot never opens a position without an
  explicit `confirm` carrying a user-chosen size.
- **Guardrails** (all enforced in code, before any transaction):
  max position size · max slippage/price-impact vs reference · daily realized-loss
  circuit breaker (one-directional: wins don't re-arm it) · file-based kill switch
  (`littlejon killswitch on`) that halts everything instantly and works even if
  RPC/venues are down.
- **Scoped execution.** Trades go through a ZeroDev Kernel smart account
  (EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` on Robinhood
  Chain). Every call is checked off-chain against a session-key policy
  (target contract + function selector + value allowlist) before signing; the
  matching on-chain session-key permissions on the Kernel account are the real
  enforcement — register them before trading real funds (see
  `execution/zerodev.ts` for the current key model and the hardening path).
- **Exit-first bias.** On a reading that satisfies both stop and target, the stop
  wins. A pending trigger entry whose market has already blown through the stop or
  target is cancelled, not entered. Failed exits retry every tick and alert loudly;
  failed entries retry quietly; guardrail-rejected entries cancel.
- **Dry-run by default.** Without ZeroDev credentials the execution layer validates
  and logs every call but sends nothing.

## Getting started

### 0. Prerequisites

- Node.js 20+; [Foundry](https://getfoundry.sh) for the contracts.
- An Anthropic API key (metering service) — https://console.anthropic.com
- An Alchemy app on Robinhood Chain (metering service's WS event listener).
- A ZeroDev project for chain 4663/46630 (bot execution; optional until go-live).

### 1. Contracts

```bash
cd contracts
git submodule update --init --recursive   # forge-std, openzeppelin-contracts
forge build && forge test -vvv
cp .env.example .env                      # fill: RPC, PRIVATE_KEY, SETTLEMENT_TOKEN, rates
forge script script/DeployAnalysisCredits.s.sol:DeployAnalysisCredits \
  --rpc-url robinhood_testnet --broadcast -vvvv
cast send <DEPLOYED> "grantRelayer(address)" <RELAYER_ADDR> --rpc-url robinhood_testnet --private-key $PRIVATE_KEY
```

Testnet chain ID 46630, RPC `https://rpc.testnet.chain.robinhood.com`, explorer
`https://explorer.testnet.chain.robinhood.com` (Blockscout verification via
`--verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/`).
Fund the deployer with testnet ETH first (see Robinhood's chain docs for the
current faucet). Deploy to mainnet (4663) only after review/audit.

### 2. Metering service

```bash
cd metering-service
cp .env.example .env   # ALCHEMY_*_URL, ANALYSIS_CREDITS_ADDRESS, RELAYER_PRIVATE_KEY, ANTHROPIC_API_KEY
npm install && npm test && npm run dev
```

`POST /v1/analyze` takes `{ idempotencyKey, userAddress, calls, symbol,
tokenAddress, kind, currentPrice, asOf, candles: {h1,h4,d1}, attempt?,
newsContext? }` and returns a validated trade plan. Guarantees (unit-tested):
never debit without delivered analysis; a delivered-but-undebited request retries
only the debit (never re-bills the model); completed requests replay from cache;
plans that are internally inconsistent (stop ≥ entry ≥ target) are rejected before
they can reach the caller. `newsContext` is operator-curated only — this service
never fetches news/social data itself, by design.

### 3. Little Jon

```bash
cd trading-bot
cp .env.example .env
cp config/session-key-policy.example.json config/session-key-policy.json
cp config/chainlink-feeds.example.json config/chainlink-feeds.json
npm install && npm test

npm run dev -- analyze NVDA                 # or an 0x address; --news "..." to add context
npm run dev -- confirm 1 --size 100
npm run watch                                # the watcher process (keep it running!)
npm run dev -- positions
npm run dev -- killswitch on|off
npm run ui                                   # local dashboard at http://127.0.0.1:8788
```

The watcher **is** the stop-loss. Run it as a persistent service (systemd, pm2,
Docker) — SL/TP protection stops the moment it isn't running.

The dashboard (`littlejon ui`) is the same engine behind a browser form: analyze a
token, see the plan/confidence/SL/TP, confirm with a size, watch positions, and
toggle the kill switch. It binds to localhost and has **no authentication** — never
expose the port publicly.

### Configuration still pending publication

These are env-gated; the features that need them disable themselves with clear
errors until set (everything else works, including tests, in their absence):

| Setting | What it unlocks | Where to find it |
| --- | --- | --- |
| `UNIV2_FACTORY_ADDRESS` / `UNIV2_ROUTER_ADDRESS` | LP-token verification & trading | any graduated RobinFun pair's `factory()` on Blockscout |
| `ZEROX_RFQ_API_URL` (+ key) | stock-token trading | 0x docs once Robinhood Chain is listed |
| `SEQUENCER_UPTIME_FEED`, `ETH_USD_FEED`, `config/chainlink-feeds.json` | oracle hardening, rhETH sizing, stock prices | docs.chain.link → Robinhood Chain feeds |
| `ZERODEV_RPC_URL` + `SESSION_KEY_PRIVATE_KEY` | live execution (else dry-run) | your ZeroDev dashboard |

## Development notes

- Every workspace: `npm test` (vitest) and `npm run lint` (tsc). Contracts:
  `forge test`. Current suite: 17 metering + 58 bot tests.
- This repo was scaffolded in a network-restricted sandbox: `forge` could not be
  installed (both the installer host and solc binary host are blocked here), so
  contracts were validated with solc 0.8.24 against the vendored deps instead of a
  real `forge test` run — run it locally before trusting the Solidity suite. The
  0x RFQ response shape and ZeroDev calls are written to their published docs but
  could not be exercised against live endpoints from this environment; verify both
  on testnet first.
- Neither the contracts nor the services have been audited. Prepaid credits are
  intentionally non-refundable and illiquid — reflect that in your terms before
  accepting real deposits. Keys belong in a secrets manager, not `.env`, in any
  real deployment.
