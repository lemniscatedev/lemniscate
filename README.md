# Lemniscate Backend

Smart contracts and backend services for Lemniscate: everlasting call and put options on Stock Tokens, settled in USDG, on Robinhood Chain (chain ID `4663`).

An option has no expiry and no liquidation, and the most a buyer can lose is the premium. The daily cost is paid in kind: the option token's `norm` factor shrinks, so the holder's units fall instead of being billed. The price is the Black-Scholes value with an exponentially distributed expiry (closed form), for a one-day (Daily) or seven-day (Weekly) speed. A USDG Writer Pool takes the other side of every trade and hedges its delta with spot positions.

Lemniscate is an independent project. Robinhood Chain, Chainlink and Uniswap are third-party infrastructure it reads from and trades on.

## Status

Pre-release, not deployed, not audited. No contract address exists yet, so none is listed here. Parts of the contract suite are still being rewritten; the table below says which. The services in `app/` and `vol-engine/` run against a local fork and against mocks; nothing here has been broadcast to a live network.

## Layout

```
contracts/    Solidity contracts (Foundry), deploy and check scripts in contracts/script
app/          Bun services: API, indexer, keeper, hedger, migrations
vol-engine/   Python volatility engine: signs and posts sigma to VolOracle (extra deliverable)
web/          Website (static build, subtree of the frontend repository; extra deliverable)
.github/      CI workflow and SECURITY.md
.githooks/    pre-commit public guard and the Gitleaks config
```

### Contracts (`contracts/src`)

| Contract | What it does | State |
| --- | --- | --- |
| `LemniscateEngine` | Buy, sell, accrue, quote and Shield. Spread, fee, caps, stress budget, HALTED sell queue, pauses. UUPS | built |
| `engine/EngineTradeLib`, `engine/EngineOpsLib`, `engine/EngineViewLib`, `EngineHelper` | The engine's trade, accrual, valuation, pricing and parameter-bound logic, as linked libraries (size limit) | built |
| `SeriesRegistry` | Lists series (`keccak256(stock, isCall, strike, tau)`), their strike band, buyable flag and funding state | built |
| `OptionToken`, `OptionTokenFactory` | One ERC-20 per series (EIP-1167 clones). Only the engine mints or burns; every balance change accrues funding first | built |
| `PriceGuard` | Reads a Chainlink feed and the Stock Token multiplier once, classifies the session, cross-checks a Uniswap v3 TWAP, never reverts on a bad read | built |
| `VolOracle` | Stores sigma posts signed by one off-chain signer (EIP-712): step limit, rate limit, floor, expiry, nonces, earnings buy-block window | built |
| `MarketHours` | Market session calendar, pushed by the keeper, with an NYSE calendar fallback | built |
| `WriterPool` | ERC-4626-style USDG pool. Counterparty for all trades, holds the spot hedges (linked library `PoolHedging`), fee split and loss layers (linked library `PoolLayers`), withdrawal queue paid at NAV (72h on mainnet) | built |
| `Reserve`, `FeeRouter` | First-loss reserve funded from a share of the spread; protocol fee split to the pool, keepers, hedger and treasury on a fixed period (7 days on mainnet) | built |
| `LmnsStaking`, `LmnsBuyBurn` | Phase 2, off at launch. Staked `$LMNS` (token issued by the launchpad, never by these contracts) is the second loss layer after the reserve, sets fee tiers, and receives the stakers' 5% of protocol fees; the burn 5% buys and burns `$LMNS` only when a TWAP is configured. Deployed by `script/DeployLmns.s.sol` | built |
| `vaults/CoveredUpVault`, `vaults/CashDownVault`, `vaults/VaultRegistry` | Phase 2, closed and unwired at launch (`vaults.enabled` deploy flag). Writer vaults sell covered calls or cash-secured puts on out-of-the-money bands of a series, receive their share of funding and spread, and pay the intrinsic value of the covered slice on a buyback | built |
| `AgentRouter` | Lets an owner give an agent key a budget, an expiry and a list of names; trades only through the engine, always to the owner | built |
| `UniswapV3HedgeAdapter`, `UniswapV3TwapReference` | Swap route for the pool's hedges and the TWAP that floors forced sales | built |
| `LemniscatePaymaster` | Verifying paymaster for ERC-4337 one-tap transactions | built |
| `libs/` | `FixedMath`, `EverlastingMath`, `EverlastingGreeks`, `Funding`, `NyseCalendar`, `Roles`, `TickPrice` | built |

Phase 2 writer vaults are written and stay closed and unwired until the deploy flag and the admin turn them on. `$LMNS` staking is written and stays off until the token exists and the admin turns it on.

The engine, pool and market hours sit behind UUPS proxies that only the admin can upgrade; the engine's upgrades can be frozen for good. OpenZeppelin v5.4.0 and forge-std v1.9.7 are vendored in `contracts/lib`. Roles, trust assumptions and accepted risks are in [SECURITY.md](.github/SECURITY.md), what to do in an emergency in [INCIDENT.md](.github/INCIDENT.md); each invariant and the test that checks it is in [contracts/INVARIANTS.md](contracts/INVARIANTS.md).

### Deployment

Not deployed. After the first deployment this section lists the network, the deployment block and one explorer link per contract.

### Services (`app/src`)

| Service | Entry | What it does |
| --- | --- | --- |
| API | `bin/api.ts` | Read-only REST API (Hono). Reads only from Postgres, makes no RPC calls |
| Indexer | `bin/indexer.ts` | The only process that polls the chain. Writes events and snapshots to Postgres |
| Keeper | `bin/keeper.ts` | Scheduled jobs that send transactions: `sessions`, `lister`, `accrue`, `risk`, `corp-actions`, `receipts`, `reference`, `earnings`, `queued-sells`, `fee-distribute` |
| Hedger | `bin/hedger.ts` | Computes the pool's net delta and calls the pool's `rebalance`. Dry run by default. Never holds pool funds |
| Migrate | `bin/migrate.ts` | Applies Drizzle migrations from `app/drizzle` |
| Launch switch | `bin/launch-market.ts` | Turns a name on or off for the website's market list |
| Agent server (MCP) | `bin/mcp.ts` | Quote, trade and Shield tools for agents, bounded by the on-chain `AgentRouter` policy (in progress) |
| Vol engine | `vol-engine` (`vol-engine` command) | Computes sigma per name and speed from 5-minute bars, signs it and posts it to `VolOracle` |

Other folders in `app/src`: `abi/` (contract ABIs, synced from the build), `chain/` (RPC pool, clients, deployment loader), `db/` (schema and queries), `pricing/` (TypeScript reference for the maths), `aa/` (ERC-4337 user operations), `sim/` (replay simulator), `lib/` (helpers).

## Requirements

- [Bun](https://bun.sh) 1.4.2
- [Foundry](https://getfoundry.sh) (solc 0.8.28 is set in `foundry.toml`)
- Postgres 16 with TimescaleDB (for example `timescale/timescaledb:latest-pg16`)
- Python 3.11+ for `vol-engine`

## Contracts

```sh
cd contracts
forge build
forge test
```

## Services

```sh
cd app
bun install
bun run migrate
bun run indexer
bun run keeper
bun run api
```

```sh
cd vol-engine
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
pytest -q
```

### Local mainnet fork

`app/scripts/fork/up.sh` runs the whole stack on an anvil fork of Robinhood Chain mainnet (chain id 31337, never 4663):
a caching proxy in front of the public RPC, the fork pinned to a block with its state saved, a local Postgres database,
the `DeploySystem` fork profile against the real Stock Tokens, feeds and Uniswap pools, then every service. `down.sh`
stops it and keeps the state; `reset.sh` starts over. `fund.ts` gives test wallets ETH and USDG (from a real holder,
never by writing storage), `warp.ts` moves the fork's clock, and `exercise.ts` runs every user and admin action with
expected failures and writes a report (`report.ts`). Ports move together with `PORT_OFFSET`; state lives in
`~/.lemniscate/fork` (`FORK_DIR`). The fork-only relaxations are listed at the top of `scripts/fork/setup.ts`.

### Configuration

All config comes from environment variables and is checked at startup (`app/src/config.ts`). `app/.env.example` lists them with safe defaults.

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | – | Required |
| `POSTGRES_PASSWORD` | – | Required |
| `NETWORK` | `fork` | `mainnet` or `fork` |
| `CHAIN_ID` | `4663` | |
| `PUBLIC_RPC_URL` | public Robinhood Chain RPC | Free public RPC, used with backoff |
| `ALCHEMY_API_KEYS` | empty | Optional comma-separated keys; empty means public RPC only |
| `DEPLOYMENT_FILE` | `/app/deployments/fork.json` | Contract addresses the services read |
| `KEEPER_ENABLED_JOBS` | all keeper jobs | Comma-separated list |
| `KEEPER_DRY_RUN` | `0` | `1` simulates and sends nothing |
| `KEEPER_KEYSTORE`, `KEEPER_KEYSTORE_PASSWORD_FILE` | – | Encrypted keystore and the file holding its password; read only by the keeper process. `KEEPER_PRIVATE_KEY` is for local development only: `NODE_ENV=production` refuses it |
| `HEDGER_DRY_RUN` | `1` | The hedger simulates until this is `0` |
| `HEDGER_KEYSTORE`, `HEDGER_KEYSTORE_PASSWORD_FILE` | – | Gas only. Must differ from the keeper and vol signer keys (`HEDGER_PRIVATE_KEY` for development) |
| `HEDGER_PERP_ENABLED` | `0` | Off-chain perp venues stay off until an account exists |
| `VOL_SIGNER_KEYSTORE`, `VOL_SIGNER_KEYSTORE_PASSWORD_FILE` | – | Signs sigma posts. Must differ from the keeper and hedger keys (`VOL_SIGNER_KEY` for development) |
| `VOL_SEND` | `0` | Only the exact value `1` makes the vol engine send transactions |
| `ALPHAVANTAGE_API_KEY` | empty | Earnings calendar source, free key |
| `API_PORT` | `3101` | |
| `CORS_ORIGINS` | empty | Comma-separated allowed origins |
| `API_RATE_LIMIT_PER_MINUTE` | `300` | Per client IP, `0` disables |
| `LOG_LEVEL` | `info` | |

The paymaster signer (`PAYMASTER_SIGNER_*`), the x402 settler (`X402_SETTLER_*`) and the agent (`AGENT_*`) follow the same
`<PREFIX>_KEYSTORE` + `<PREFIX>_KEYSTORE_PASSWORD_FILE` pattern. Keystores are supplied by the operator; the services only load them.

Never commit `.env` files or keys; they are ignored by `.gitignore`.

Every time rule is a deploy-time value with a hard minimum enforced by the contract: pool withdrawal queue (72h on
mainnet), deposit lock (24h), fee distribution period (7 days), vol post validity (2h) and rate limit (5 min), split
pause window (24h before, 1h after), timelock (48h). The testnet profile deploys minutes; services read the values from
the contracts.

### Deploy

`contracts/script/DeploySystem.s.sol` deploys and wires the whole system, lists the launch names, hands every admin
role to a 48h `TimelockController` run by a Safe (testnet: to the owner), runs the post-deploy check and writes the
deployment file. Profiles: `fork` (anvil, chain 31337), `testnet` (46630, with mock tokens and feeds) and `mainnet`
(4663 only, Safe of at least 3 of 5). Token, feed and pool addresses come from a JSON config passed at run time;
none is built into the source. Details: [contracts/script/README.md](contracts/script/README.md).

```sh
cd contracts
DEPLOY_CONFIG_JSON="$(cat <config.json>)" forge script script/DeploySystem.s.sol --rpc-url <rpc> --account <keystore> --broadcast
DEPLOYMENT_FILE=deployments/<profile>.json DEPLOY_CONFIG_JSON="$(cat <config.json>)" forge script script/PostDeployCheck.s.sol --rpc-url <rpc>
```

### Deployment file

The services read contract addresses from the JSON file named by `DEPLOYMENT_FILE` (schema: `app/src/chain/deployment.ts`): the engine, pool, registry, price guard, vol oracle, agent router and USDG addresses, the pool share decimals, and one entry per listed Stock Token with its feed and deploy block. `DeploySystem.s.sol` writes it to `contracts/deployments/<profile>.json` (git-ignored) with the remaining contract and role addresses alongside; chain IDs 4663 (mainnet), 31337 (fork) and 46630 (testnet) are accepted.

## API

All routes are versioned under `/v1`. The OpenAPI spec is at `/v1/openapi.json`.

| Route | |
| --- | --- |
| `GET /v1/health` | Service and indexer status |
| `GET /v1/config` | Chain, caps and fee parameters the website needs |
| `GET /v1/chains`, `GET /v1/chains/{name}` | Option chain per name and speed: bid, ask, daily cost, break-even, Greeks, whether a series is buyable and why not |
| `POST /v1/quote` | Quote for a buy or sell, with the same fields as the contract quote |
| `POST /v1/intent/buy`, `/sell`, `/shield` | Unsigned transaction data with the USDG approval and slippage bounds |
| `GET /v1/series/{id}` | One series: parameters, norm history, open interest |
| `GET /v1/vol/{name}` | Latest posted sigma, skew and validity |
| `GET /v1/pool` | Writer Pool NAV, caps, utilisation and queue |
| `GET /v1/upcoming`, `POST`/`DELETE /v1/upcoming/{id}/subscribe` | Names not yet listed and notify-me sign-ups |
| `GET /v1/corporate-actions` | Staged Stock Token multiplier changes |
| `GET /v1/accounts/{address}/positions`, `/activity`, `/agents`, `/smart-account` | Wallet positions, history, agent policies and the one-tap smart account address |
| `GET /v1/userop/config`, `POST /v1/userop/send`, `GET /v1/userop/{hash}` | ERC-4337 user operations |

## Checks

```sh
cd app
bun run typecheck
bun test
bun run lint:copy
bun run smoke [API_URL]
```

CI (`.github/workflows/ci.yml`) runs the contract build and tests with contract sizes, Slither, the app typecheck and tests against TimescaleDB, the vol-engine tests, Semgrep, Gitleaks and the copy lint on every push and pull request. Actions are pinned by commit SHA and no job needs a secret.

## License

[MIT](LICENSE)
