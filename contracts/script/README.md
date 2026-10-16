# Operational scripts

Foundry scripts for handing over a live deployment. Run them from `contracts/`. The deploy and post-deploy check scripts
for the option system are not written yet; the power-payoff ones were removed with that engine.

| Script | Sends transactions | Purpose |
| --- | --- | --- |
| `TimelockHandoff.s.sol` | yes (with `--broadcast`) | Deploys a `TimelockController` owned by a Safe and moves `DEFAULT_ADMIN_ROLE` to it |

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
SAFE=<safe> forge script script/TimelockHandoff.s.sol --rpc-url $F
```
