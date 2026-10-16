# Operational scripts

Foundry scripts for checking and handing over a live deployment. Run them from `contracts/`. These are inherited and
will be reworked for the option engine (see the repository STATUS in the private workspace).

| Script | Sends transactions | Purpose |
| --- | --- | --- |
| `PostDeployCheck.s.sol` | never | Read-only health check of a deployment; reverts on any failed check |
| `TimelockHandoff.s.sol` | yes (with `--broadcast`) | Deploys a `TimelockController` owned by a Safe and moves `DEFAULT_ADMIN_ROLE` to it |
| `ListMarkets.s.sol` | yes (with `--broadcast`) | Lists markets on the engine |

Nothing here stores or reads keys. Sign with Foundry's own flags (`--ledger`, `--account <keystore>`, `--trezor`, ...).
Without `--broadcast`, Forge only simulates against the RPC and prints the transactions it would send.

## Addresses

Addresses are never built into the scripts (except USDG). They come from, in increasing priority:

1. A deployment file in the app's schema (`app/src/chain/deployment.ts`): `DEPLOYMENT_FILE=<path inside contracts/>`, or the
   raw JSON in `DEPLOYMENT_JSON`.
2. Per-address overrides: `ENGINE`, `VAULT`, `MARKET_HOURS`, `LENS`, `HEDGE_ADAPTER`, `USDG`, `ENGINE_IMPL`, `VAULT_IMPL`,
   `MARKET_HOURS_IMPL`, `ADMIN`, `KEEPER`.

## Fork rehearsal

Use a throwaway Anvil fork with the admin unlocked; never a shared node. `broadcast/`, `cache/` and `out/` are git-ignored.

```sh
anvil --fork-url "$RPC_URL" --port 7299 --chain-id 4663 &
F=http://127.0.0.1:7299
ENGINE=<engine> VAULT=<vault> forge script script/PostDeployCheck.s.sol --rpc-url $F
```
