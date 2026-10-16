# Lemniscate Backend

Smart contracts and backend services for Lemniscate: everlasting options on Stock Tokens on Robinhood Chain (chain ID `4663`).

Status: work in progress, not deployed. The code currently in `contracts/` and `app/` is the starting skeleton (engine, vault,
market hours, hedge adapter, indexer, keeper, API) that the option engine is being built on.

## Layout

```
contracts/   Solidity contracts (Foundry)
app/         Bun services: API, indexer, keeper, migrations
```

### Contracts (`contracts/src`)

| Contract | What it does |
| --- | --- |
| `LemniscateEngine` | Buys and sells everlasting options at the model price plus spread, accrues in-kind funding, caps, stress budget, the HALTED sell queue, Shield (UUPS) |
| `engine/EngineTradeLib`, `engine/EngineOpsLib` | The engine's trade, accrual and valuation logic, as linked libraries (size limit) |
| `EngineHelper` | Pure pricing, risk and parameter bounds used by the engine |
| `SeriesRegistry` | Option series (stock, Up/Down, strike, Daily/Weekly) and their funding state |
| `OptionToken` | ERC-20 clone per series. Only the engine can mint/burn; every transfer accrues funding first |
| `OptionTokenFactory` | Deploys an `OptionToken` clone per series for the registry |
| `PriceGuard`, `VolOracle` | The underlying price with session and freshness, and the signed volatility posts |
| `WriterPool` | USDG Writer Pool (ERC-4626 shares, 12 decimals). Counterparty for all trades, holds the spot hedges; deposits at NAV + 10 bps, withdrawals through a 72h queue paid at NAV |
| `Reserve` | First-loss layer of the pool: covers losses before LP NAV, funded from a share of the spread |
| `FeeRouter` | Collects the protocol fee and splits it weekly (pool writers, keepers, hedger, treasury, stakers, burn) |
| `PoolHedging` | External library linked into `WriterPool`: hedge valuation, TWAP-floored swaps, cash raising |
| `MarketHours` | Market session calendar, pushed by the keeper |
| `UniswapV3HedgeAdapter` | Swaps through Uniswap v3 `SwapRouter02` for hedging |
| `UniswapV3TwapReference` | Pool TWAP that floors the pool's forced hedge sales |

OpenZeppelin v5.4.0 and forge-std v1.9.7 are vendored in `contracts/lib`.

### Services (`app/src`)

| Service | Entry | What it does |
| --- | --- | --- |
| API | `bin/api.ts` | Read-only REST API (Hono). Reads only from Postgres, makes no RPC calls |
| Indexer | `bin/indexer.ts` | The only process that polls the chain. Writes events and snapshots to Postgres |
| Keeper | `bin/keeper.ts` | Scheduled jobs that send transactions |
| Migrate | `bin/migrate.ts` | Applies Drizzle migrations from `app/drizzle` |

## Security

See [SECURITY.md](SECURITY.md). Contract invariants and the tests that check them are in
[contracts/INVARIANTS.md](contracts/INVARIANTS.md).

## Requirements

- [Bun](https://bun.sh) 1.2+
- [Foundry](https://getfoundry.sh) (solc 0.8.28 is set in `foundry.toml`)
- Postgres 16 with TimescaleDB (e.g. `timescale/timescaledb:latest-pg16`)

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

Configuration is read from environment variables and validated at startup (`app/src/config.ts`); see `app/.env.example`.

## License

[MIT](LICENSE)
