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
| `LemniscateEngine` | Market list, price checks, funding accrual, quotes, buy/sell |
| `OptionToken` | ERC-20 position token. Only the engine can mint/burn |
| `OptionTokenFactory` | Deploys new `OptionToken`s for the engine |
| `EngineHelper` | Admin checks and view math moved out of the engine (size limit) |
| `WriterPool` | ERC-4626 vault over USDG. Counterparty for all trades, holds the hedges |
| `MarketHours` | Market session calendar, pushed by the keeper |
| `UniswapV3HedgeAdapter` | Swaps through Uniswap v3 `SwapRouter02` for hedging |
| `UniswapV3TwapReference` | Pool TWAP that floors the pool's forced hedge sales |
| `LemniscateLens` | Read-only batched views for markets, the pool and accounts |

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
