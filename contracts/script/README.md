# Operational scripts

Foundry scripts that deploy, check and hand over the option system. Run them from `contracts/`. Nothing here stores
or reads keys: sign with Foundry's own flags (`--account <keystore>`, `--ledger`, `--trezor`, or `--unlocked --sender`
on a local anvil). Without `--broadcast`, Forge only simulates against the RPC and prints the transactions.

| Script | Sends transactions | Purpose |
| --- | --- | --- |
| `DeploySystem.s.sol` | yes (with `--broadcast`) | Deploys and wires every contract, lists the launch names, hands admin to the timelock (or the testnet owner), runs the post-deploy check, writes `deployments/<profile>.json` |
| `PostDeployCheck.s.sol` | no | Checks a live deployment against its config; one named reason per failure |
| `TimelockHandoff.s.sol` | yes (with `--broadcast`) | Separate-step handoff for a deployment made with `"handoff": false` |

## Profiles

| Profile | Chain | Externals | Timers | Admin |
| --- | --- | --- | --- | --- |
| `fork` | 31337 (anvil forking mainnet) | real USDG, Stock Tokens, feeds, Uniswap pools | full | 48h `TimelockController` run by `roles.safe` (a `ForkSafe` stand-in is deployed when unset) |
| `testnet` | 46630 | mock USDG, mock Stock Tokens, keeper-pushed mock feeds, feed-priced swap venue (`script/testnet/`) | short, from `timers` (each bounded below by the contracts) | `roles.owner` directly |
| `mainnet` | 4663 only | real | full | 48h `TimelockController` run by a Safe with at least 3 of 5 signers |

Full timers: pool withdrawal queue 72h, deposit lock 24h, fee distribution 7 days, timelock 48h, vol post validity
2h and rate limit 5 minutes (rolling window 1h), split pause 24h before / 1h after. Fork and mainnet configs that
carry a `timers` key are refused.

## Inputs

No address of a token, feed, pool or deployment is built into source. The deploy config is a JSON file passed at
run time: `DEPLOY_CONFIG=<path inside contracts/>` or the raw JSON in `DEPLOY_CONFIG_JSON`. Keys: `profile`, `usdg`,
`uniswapV3Factory`, `swapRouter`, `referenceWindow`, `handoff` (default true), `roles` (`owner`, `safe`, `guardian`,
`keeper`, `hedger`, `volSigner`, `treasury`, `keepersPot`, `hedgerPot`, `depositors[]`), `timers` (testnet only),
`limits` (`maxTotalDepositsUsdg`, `seriesCapWad`, `accountCapWad`, 0 = unlimited; `publicDeposits`) and `stocks[]`
(`name`, `stock`, `feed`, `uniPool`, `poolFee`, `twapBandBps`, `twapWindow`, `maxAgeRegular`, `maxAgeExtended`,
`continuityBps`, `strikeStepUsd`, `hedgeDepthCapUsd`, `volFloorBps`, `mockPriceUsdE8` for testnet).
Keeper, hedger and vol signer must be three different addresses.

The deployment file (`deployments/<profile>.json`, git-ignored; `DEPLOYMENT_OUT` overrides) follows the app's
`OptionDeployment` schema (`app/src/chain/deployment.ts`) and adds the remaining contract and role addresses.

## Local rehearsal

```sh
anvil --fork-url "$RPC_URL" --chain-id 31337 --hardfork cancun &
DEPLOY_CONFIG_JSON="$(cat <fork config>)" forge script script/DeploySystem.s.sol \
  --rpc-url http://127.0.0.1:8545 --unlocked --sender <anvil account 0> --broadcast
DEPLOYMENT_FILE=deployments/fork.json DEPLOY_CONFIG_JSON="$(cat <fork config>)" \
  forge script script/PostDeployCheck.s.sol --rpc-url http://127.0.0.1:8545
```

`broadcast/`, `cache/`, `out/` and `deployments/` are git-ignored.
