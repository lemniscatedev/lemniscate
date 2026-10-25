# Security policy

Lemniscate is pre-release software and has not been audited. Use only funds you can afford to lose entirely.

## Reporting a vulnerability

Please report privately and do not open a public issue. Contact details will be published with the first deployment.
Include the affected contract or service, steps to reproduce, and the impact you see.

## Scope

Contracts under `contracts/src` and services under `app/src` and `vol-engine/src`. Third-party contracts (Stock Tokens, USDG,
Chainlink feeds, Uniswap, the ERC-4337 EntryPoint and Kernel) and vendored libraries in `contracts/lib` are out of scope, but
what we assume about them is listed below because it is part of our threat model.

Status of the code behind this document: the pricing, price guard, vol oracle, series, funding and pool contracts are built and
tested; the engine and agent router are being rewritten. Every invariant and its test is in
[contracts/INVARIANTS.md](../contracts/INVARIANTS.md).

## What a buyer and a writer can lose

- A buyer's total outflow is the premium and the in-kind funding. There is no margin, no liquidation and no debt.
- Writer Pool depositors carry the pool's risk: gap moves on a name, hedge slippage, a bad oracle read. Losses are charged to the
  reserve first, then to pool NAV. Exits go through a 72 hour queue paid at NAV at claim time, pro rata if cash is short.
- Until an audit: Pool NAV capped at $2M, each series at $40k outstanding, each account at $25k option value per series, deposits on an
  allowlist, writer vaults closed. Per-name caps also respect the depth of the name's hedge pool.

## Invite codes are an off-chain gate only

During the closed beta the website and the API ask a wallet to redeem an invite code before the API builds calldata for a buy or a Shield
(`INVITES_REQUIRED`, switchable live without a restart). This is an access gate on our service, not a security control on the protocol:

- **The contracts stay permissionless.** Anyone can call the engine, the pool and the router directly from any wallet or script, with or without a code.
  Do not rely on invite codes for any safety property. Caps, pauses, price guards and roles are the only on-chain limits.
- **Sells, exits and claims are never gated**, by the API or the website, whatever the setting.
- A code is a bearer secret. The database stores only a SHA-256 hash of each code; the plaintext lives in the team's private file. Redeeming binds
  a code to a wallet with a signed message (same replay-protected scheme as other signed actions); a code admits one wallet, one time. Redemption is
  rate limited and answers with one message for unknown, revoked and used codes.
- In one-tap flows the smart account's owner wallet may be the approved address.
- Turning the gate off opens the website to everyone outside the blocked regions; the region block is a separate website control.

## Roles

Deployer keys hold nothing after the hand-off. Admin is a 48 hour `TimelockController` owned by a 3-of-5 Safe on mainnet. Keeper,
hedger and vol signer are three different addresses; the services refuse to start with a shared key, and the post-deploy check (in progress) asserts it.

| Role | Held by | Can | Cannot |
| --- | --- | --- | --- |
| Admin (`DEFAULT_ADMIN_ROLE`) | 48h timelock, owned by the Safe | List stocks and set price guard parameters; set caps, fee rates and spreads inside validated bounds; rotate the vol signer and floors; set pool deposit allowlist, hedge routes and caps; upgrade the UUPS proxies; freeze engine upgrades for good | Act without the 48h delay; move user funds; mint option tokens |
| Guardian (2-of-3) | Multisig, plus the keeper's risk monitor for automatic pauses | Pause buys, Shield and pool deposits; freeze the hedger (`rebalance` and `postHedgeEquity`) until the admin unfreezes it | Pause sells, withdrawals, claims or `fillQueued`; change parameters; upgrade |
| Keeper | One hot key | List series and set them buyable or archived; push market sessions; call `accrue` and `accrueMany`; pause buys (guardian role); poke the price guard around corporate actions | Change parameters; touch pool funds; sign vol posts |
| Hedger | One hot key | Post off-chain perp equity inside the admin cap and hourly bound; call the pool's `rebalance(stock, targetUnits, minOut)` inside its TWAP floor and slippage bound, and inside a daily budget of realised loss against the feed price (0.5% of NAV by default, admin-set 0.01% to 2%) | Withdraw pool funds; lose more than that daily budget to a pool it sandwiches, however many trades it makes; act while the guardian has frozen it; move USDG anywhere but through the pool's own swap route; post any equity while perps are off (cap 0, the launch value); post above the cap (at most 20% of NAV) or move equity more than 10% of the cap per hour, whatever the `ref` |
| Vol signer | One hot key, off the chain | Sign sigma posts that anyone can submit | Bypass the step limit, rate limit, floor, expiry or nonce rules; move funds |
| Engine | Contract | Call `pool.onSale`, `onFunding` and `pay`; mint and burn option tokens | Pull more USDG from a buyer than the quoted maximum |
| Agent key | Set by an owner through `AgentRouter` | Buy, sell and Shield for the owner within a budget, a per-trade limit, an expiry and a name list | Receive tokens or proceeds (always sent to the owner); raise its own budget; act after revoke |
| Anyone | | `poke` the price guard, `distribute` the fee router after 7 days, `fillQueued` for a queued sell, submit signed vol posts | |

## Service isolation

On the server every service runs as its own Unix user (`lem-api`, `lem-indexer`, `lem-keeper`, `lem-hedger`, `lem-vol-engine`, `lem-mcp`)
with its own state directory and env file. A keystore and its password file are readable only by the one service that signs with it,
so a compromise of the API, indexer or MCP server does not expose the keeper, hedger or vol signer key. The deploy refuses to continue if
another service user can open a keystore. Services still share one database role.

## Who calls what

Every on-chain safety lever, who may call it, and which paid job calls it. A lever with no scheduled caller is listed as such so it is never assumed to run.

| Lever | Who may call | Scheduled caller |
| --- | --- | --- |
| `engine.accrueMany` (funding, stress budget and drawdown re-check) | Anyone | Keeper job `accrue` (every 5 minutes, due series only, hourly at the latest, plus a forced pass at each session boundary) |
| `engine.fillQueued(ticket)` (queued sells) | Anyone | Keeper job `queued-sells` (every 2 minutes, oldest first, at most 25 per pass, one transaction per ticket, a failing ticket backs off 10 minutes) |
| `engine.cancelQueued` | The seller only | The seller |
| `FeeRouter.distribute()` | Anyone, once per period | Keeper job `fee-distribute` (hourly check; sends only when the period has passed and there is USDG to split) |
| `engine.setBuysPaused`, `setSeriesBuysPaused` | Guardian or admin to pause; admin only to unpause | Keeper job `risk` (pauses only, never unpauses) |
| `PriceGuard.setBuysPaused(stock)`, `pool.setDepositsPaused` | Guardian or admin to pause; admin only to unpause | The Safe (guardian). No automatic caller |
| `PriceGuard.poke(stock)` | Anyone | Keeper job `corp-actions` (around staged multiplier changes) |
| `registry.listSeries`, `setBuyable`, `archive`; `marketHours.setSessions` | Keeper role | Keeper jobs `lister` and `sessions` |
| `pool.postHedgeEquity` | Hedger role | The hedger service |
| `pool.rebalance(stock, targetUnits, limit)` | Hedger role | The hedger service, job `hedger` (every `HEDGER_CYCLE_SECONDS`): target = `engine.netGreeks(stock)` delta, capped per trade at a share of in-range Uniswap liquidity, skipped when the pool price is off its TWAP, dry run by default. The hedger wallet holds gas only; the pool holds the hedge and swaps its own USDG. Equity posts cover off-chain perp venues only, so `postHedgeEquity` is scheduled only when a perp account is configured |
| `engine.pokeRisk()` | Anyone | None needed: `accrueMany` and every trade run the same re-check |
| `engine.syncSeries(n)`, `engine.pruneShieldList(stock, n)` | Anyone | None: trades sync in batches and Shield drops archived candidates it meets; a keeper call only shortens the list |
| `pool.checkpoint()` | Anyone | None needed: deposits and claims record it |
| `volOracle.post(...)` | Anyone, with the vol signer's signature | The vol engine service |
| Timelocked parameters, upgrades, `freezeUpgrades` | Admin (48h timelock) | The Safe |

## Every privileged function

Generated by `contracts/script/ci/privileged-functions.py` from the built ABIs and the Solidity source, and checked in CI: a new
state-changing external function, or a changed gate, fails the build until `contracts/privileged-functions.json` and this table are
regenerated and the change is reviewed. "Delay" is how long a change takes once decided: admin actions pass the 48 hour timelock;
guardian pauses and keeper and hedger actions are instant and bounded by what the role can do (see Roles). The paymaster and the
option token factory have a plain owner (a Safe) with no timelock; the paymaster only holds gas funds and sponsors operations to the
engine and agent router, and the factory is owned by the series registry that created it. The paymaster sponsors only Kernel
accounts: ones it saw deployed through the Kernel factory in a sponsored operation (the sponsor signature covers the initCode the
server built) or ones the owner registered, because its call policy reads `execute(bytes32,bytes)` calldata that only a real Kernel
account runs as written. A Kernel owner can later change its own account (upgrade, hooks) in an operation it pays for itself; the
server reads the account's implementation slot before it signs, and the per-account and global daily caps bound what such an
account could spend in any case. Its caps cannot be switched off: they must be non-zero, nested (per op <= per account per day
<= global) and under hard ceilings, and the daily caps book the EntryPoint's charges after `postOp` (postOp gas and the unused-gas
penalty). It is deployed by `contracts/script/DeployPaymaster.s.sol` from the reviewed values in the deploy config, and the same
script's `check(address)` asserts the owner (the Safe), signer, immutables, stake, deposit and caps.

<!-- privileged-functions:start (generated by contracts/script/ci/privileged-functions.py) -->
| Contract | Function | Who may call | Delay |
| --- | --- | --- | --- |
| AgentRouter | `buyFor(address,bytes32,uint128,uint128,uint64)` | anyone (the owner's agent key, inside its policy) | none (permissionless) |
| AgentRouter | `cancelQueuedFor(uint256)` | anyone (the owner of that queued sell) | none (permissionless) |
| AgentRouter | `revoke(address)` | anyone (acts on the caller's own agents) | none (permissionless) |
| AgentRouter | `sellFor(address,bytes32,uint128,uint128,uint64)` | anyone (the owner's agent key, inside its policy) | none (permissionless) |
| AgentRouter | `setPolicy(address,uint128,uint128,uint64,bool,bool,address[])` | anyone (acts on the caller's own policy) | none (permissionless) |
| AgentRouter | `shieldFor(address,address,uint128,uint16,uint128,uint64)` | anyone (the owner's agent key, inside its policy) | none (permissionless) |
| CashDownVault | `approve(address,uint256)` | holder | n/a (caller's own balance, role or one-time setup) |
| CashDownVault | `claim()` | anyone (settles the caller's own requests) | none (permissionless) |
| CashDownVault | `creditFunding(uint256)` | contract:registry | registry only |
| CashDownVault | `deposit(uint256)` | anyone (the caller's own funds, only while the vault is open) | none (permissionless) |
| CashDownVault | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| CashDownVault | `payLoss(address,uint256)` | contract:registry | registry only |
| CashDownVault | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| CashDownVault | `requestWithdraw(uint256)` | anyone (the caller's own shares) | none (permissionless) |
| CashDownVault | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| CashDownVault | `roll()` | anyone (only after the epoch ends) | none (permissionless) |
| CashDownVault | `setOpen(bool)` | role:DEFAULT_ADMIN_ROLE or role:GUARDIAN_ROLE | default_admin 48h timelock / guardian instant |
| CashDownVault | `settleDebt()` | anyone (pays the vault's own debt to the pool) | none (permissionless) |
| CashDownVault | `transfer(address,uint256)` | holder | n/a (caller's own balance, role or one-time setup) |
| CashDownVault | `transferFrom(address,address,uint256)` | holder-or-approved | n/a (caller's own balance, role or one-time setup) |
| CoveredUpVault | `approve(address,uint256)` | holder | n/a (caller's own balance, role or one-time setup) |
| CoveredUpVault | `claim()` | anyone (settles the caller's own requests) | none (permissionless) |
| CoveredUpVault | `creditFunding(uint256)` | contract:registry | registry only |
| CoveredUpVault | `deposit(uint256)` | anyone (the caller's own funds, only while the vault is open) | none (permissionless) |
| CoveredUpVault | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| CoveredUpVault | `payLoss(address,uint256)` | contract:registry | registry only |
| CoveredUpVault | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| CoveredUpVault | `requestWithdraw(uint256)` | anyone (the caller's own shares) | none (permissionless) |
| CoveredUpVault | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| CoveredUpVault | `roll()` | anyone (only after the epoch ends) | none (permissionless) |
| CoveredUpVault | `setOpen(bool)` | role:DEFAULT_ADMIN_ROLE or role:GUARDIAN_ROLE | default_admin 48h timelock / guardian instant |
| CoveredUpVault | `settleDebt()` | anyone (pays the vault's own debt to the pool) | none (permissionless) |
| CoveredUpVault | `transfer(address,uint256)` | holder | n/a (caller's own balance, role or one-time setup) |
| CoveredUpVault | `transferFrom(address,address,uint256)` | holder-or-approved | n/a (caller's own balance, role or one-time setup) |
| FeeRouter | `distribute()` | anyone | none (permissionless) |
| FeeRouter | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| FeeRouter | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| FeeRouter | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| FeeRouter | `setProtocolFeeBps(uint16)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| FeeRouter | `setRecipient(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| FeeRouter | `setSplit(uint16,uint16,uint16,uint16)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| FeeRouter | `setWorkerSplit(uint16,uint16,uint16)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `accrue(bytes32)` | anyone | none (permissionless) |
| LemniscateEngine | `accrueMany(bytes32[])` | anyone | none (permissionless) |
| LemniscateEngine | `buy(bytes32,uint128,uint128,uint64,address)` | anyone | none (permissionless) |
| LemniscateEngine | `buyWithPermit(bytes32,uint128,uint128,uint64,address,uint256,uint8,bytes32,bytes32)` | anyone | none (permissionless) |
| LemniscateEngine | `cancelQueued(uint256)` | anyone (the ticket's seller only) | none (permissionless) |
| LemniscateEngine | `fillQueued(uint256)` | anyone | none (permissionless) |
| LemniscateEngine | `freezeUpgrades()` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `initialize(address,address,address,address,address,address)` | once:initializer | n/a (caller's own balance, role or one-time setup) |
| LemniscateEngine | `pokeRisk()` | anyone | none (permissionless) |
| LemniscateEngine | `pruneShieldList(address,uint256)` | anyone | none (permissionless) |
| LemniscateEngine | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| LemniscateEngine | `retireDust(bytes32[])` | anyone (only series whose whole value is under the minimum trade) | none (permissionless) |
| LemniscateEngine | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `sell(bytes32,uint128,uint128,uint64,address)` | anyone (sells the caller's own tokens; never paused) | none (permissionless) |
| LemniscateEngine | `sellFor(address,bytes32,uint128,uint128,uint64)` | contract:agent-router (the configured AgentRouter only, inside the owner's policy (R04)) | agent-router only |
| LemniscateEngine | `setAgentRouter(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `setBuysPaused(bool)` | role:DEFAULT_ADMIN_ROLE or role:GUARDIAN_ROLE | default_admin 48h timelock / guardian instant |
| LemniscateEngine | `setFeeTiers(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `setGuards(tuple)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `setHedgeDepthCap(address,uint256)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `setParams(tuple)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `setSeriesBuysPaused(bytes32,bool)` | role:DEFAULT_ADMIN_ROLE or role:GUARDIAN_ROLE | default_admin 48h timelock / guardian instant |
| LemniscateEngine | `settleHalted(address)` | anyone (only a stock HALTED for the settle delay (7 days), at its last good price) | none (permissionless) |
| LemniscateEngine | `shield(address,uint128,uint16,uint128,uint64)` | anyone | none (permissionless) |
| LemniscateEngine | `syncSeries(uint256)` | anyone | none (permissionless) |
| LemniscateEngine | `upgradeToAndCall(address,bytes)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscatePaymaster | `acceptOwnership()` | pending-owner | n/a (caller's own balance, role or one-time setup) |
| LemniscatePaymaster | `addStake(uint32)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `deposit()` | anyone (funds the paymaster) | none (permissionless) |
| LemniscatePaymaster | `postOp(uint8,bytes,uint256,uint256)` | contract:entrypoint (ERC-4337 entry point only) | entrypoint only |
| LemniscatePaymaster | `registerKernelAccount(address,bytes,bytes32)` | anyone (only a deployed standard Kernel account of KERNEL_FACTORY (R17)) | none (permissionless) |
| LemniscatePaymaster | `renounceOwnership()` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `setKernelAccounts(address[],bool)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `setLimits(uint256,uint256,uint256)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `setPaused(bool)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `setSigner(address)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `transferOwnership(address)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `unlockStake()` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `validatePaymasterUserOp(tuple,bytes32,uint256)` | contract:entrypoint (ERC-4337 entry point only) | entrypoint only |
| LemniscatePaymaster | `withdrawStake(address)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `withdrawTo(address,uint256)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LmnsBuyBurn | `buyAndBurn(uint256)` | role:KEEPER_ROLE (swaps only at the TWAP floor, burns what it buys) | keeper instant |
| LmnsBuyBurn | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LmnsBuyBurn | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| LmnsBuyBurn | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LmnsBuyBurn | `setMaxUsdgPerCall(uint256)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LmnsBuyBurn | `setRoute(address,address,uint24,uint16)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LmnsStaking | `cancelUnstake()` | anyone (the caller's own stake) | none (permissionless) |
| LmnsStaking | `claimRewards()` | anyone (the caller's own rewards) | none (permissionless) |
| LmnsStaking | `completeUnstake()` | anyone (the caller's own stake, after the unstake delay) | none (permissionless) |
| LmnsStaking | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LmnsStaking | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| LmnsStaking | `requestUnstake(uint256)` | anyone (the caller's own stake) | none (permissionless) |
| LmnsStaking | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LmnsStaking | `setCoverCap(uint256)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LmnsStaking | `setSlashRoute(address,address,uint24,uint16)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LmnsStaking | `setTiers(tuple[])` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LmnsStaking | `slash(uint256)` | contract:pool | pool only |
| LmnsStaking | `stake(uint256)` | anyone (the caller's own stake) | none (permissionless) |
| LmnsStaking | `stakeWithPermit(uint256,uint256,uint8,bytes32,bytes32)` | anyone (the caller's own stake) | none (permissionless) |
| LmnsStaking | `syncLoss()` | anyone | none (permissionless) |
| LmnsStaking | `syncRewards()` | anyone (streams fees already received) | none (permissionless) |
| MarketHours | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| MarketHours | `initialize(address,address)` | once:initializer | n/a (caller's own balance, role or one-time setup) |
| MarketHours | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| MarketHours | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| MarketHours | `setFallbackEnabled(bool)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| MarketHours | `setHolidays(tuple[])` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| MarketHours | `setSessions(tuple[])` | role:KEEPER_ROLE | keeper instant |
| MarketHours | `setSessionsWithKinds(tuple[],uint8[])` | role:KEEPER_ROLE | keeper instant |
| MarketHours | `upgradeToAndCall(address,bytes)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| OptionToken | `approve(address,uint256)` | holder | n/a (caller's own balance, role or one-time setup) |
| OptionToken | `burn(address,uint256)` | contract:engine | engine only |
| OptionToken | `initialize(address,bytes32,string,string)` | once:initializer | n/a (caller's own balance, role or one-time setup) |
| OptionToken | `mint(address,uint256)` | contract:engine | engine only |
| OptionToken | `transfer(address,uint256)` | holder | n/a (caller's own balance, role or one-time setup) |
| OptionToken | `transferFrom(address,address,uint256)` | holder-or-approved | n/a (caller's own balance, role or one-time setup) |
| OptionTokenFactory | `deploy(bytes32,address,string,string)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| PriceGuard | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| PriceGuard | `poke(address)` | anyone (records a price reading; cannot set one) | none (permissionless) |
| PriceGuard | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| PriceGuard | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| PriceGuard | `setBuysPaused(address,bool)` | role:DEFAULT_ADMIN_ROLE or role:GUARDIAN_ROLE | default_admin 48h timelock / guardian instant |
| PriceGuard | `setMarketHours(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| PriceGuard | `setMaxAgeClosed(uint32)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| PriceGuard | `setSequencerFeed(address,uint32)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| PriceGuard | `setStock(address,tuple)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| PriceGuard | `setTradeTwapWindow(uint32)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| PriceGuard | `setTwapSource(address,address,uint32,uint16)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| Reserve | `cover(uint256)` | contract:pool | pool only |
| Reserve | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| Reserve | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| Reserve | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| Reserve | `setParams(uint16,uint16)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| SeriesRegistry | `archive(bytes32)` | role:KEEPER_ROLE | keeper instant |
| SeriesRegistry | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| SeriesRegistry | `listSeries(address,bool,uint128,uint32)` | role:KEEPER_ROLE | keeper instant |
| SeriesRegistry | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| SeriesRegistry | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| SeriesRegistry | `setBuyable(bytes32,bool)` | role:KEEPER_ROLE | keeper instant |
| SeriesRegistry | `setEngine(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| SeriesRegistry | `setRelistNormThreshold(uint128)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| SeriesRegistry | `setStock(address,bool,uint128,string)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| SeriesRegistry | `storeAccrual(bytes32,uint128,uint64)` | contract:engine | engine only |
| UniswapV3HedgeAdapter | `swapExactIn(address,address,uint24,uint256,uint256,address)` | anyone | none (permissionless) |
| VaultRegistry | `addVault(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| VaultRegistry | `assume(address,bytes32,uint256)` | role:ALLOCATOR_ROLE | allocator instant |
| VaultRegistry | `debtPaid(uint256)` | contract:registered-vault | registered-vault only |
| VaultRegistry | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| VaultRegistry | `onBuyback(bytes32,uint256,uint256,uint256)` | contract:pool | pool only |
| VaultRegistry | `release(address,bytes32,uint256)` | role:ALLOCATOR_ROLE | allocator instant |
| VaultRegistry | `releaseFraction(uint256)` | contract:registered-vault | registered-vault only |
| VaultRegistry | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| VaultRegistry | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| VaultRegistry | `routeFunding(bytes32,uint256)` | contract:pool | pool only |
| VaultRegistry | `sweep()` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| VolOracle | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| VolOracle | `post(tuple,bytes)` | anyone (needs the vol signer's EIP-712 signature) | none (permissionless) |
| VolOracle | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| VolOracle | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| VolOracle | `revokeSigner()` | role:GUARDIAN_ROLE | guardian instant |
| VolOracle | `setFloor(address,uint64)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| VolOracle | `setSigner(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `approve(address,uint256)` | holder | n/a (caller's own balance, role or one-time setup) |
| WriterPool | `checkpoint()` | anyone | none (permissionless) |
| WriterPool | `claim(uint256)` | anyone (the ticket's owner only; re-queues a ticket left unclaimed past CLAIM_WINDOW) | none (permissionless) |
| WriterPool | `creditVaultStock(address,uint256)` | contract:vault-registry | vault-registry only |
| WriterPool | `deposit(uint256,address)` | anyone | none (permissionless) |
| WriterPool | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `initialize(address,address,address,address)` | once:initializer | n/a (caller's own balance, role or one-time setup) |
| WriterPool | `onBuyback(bytes32,uint256,uint256,uint256,uint256)` | contract:engine | engine only |
| WriterPool | `onFunding(bytes32,uint256)` | contract:engine | engine only |
| WriterPool | `onSale(bytes32,uint256,uint256)` | contract:engine | engine only |
| WriterPool | `pay(address,uint256,uint256)` | contract:engine | engine only |
| WriterPool | `postHedgeEquity(uint256,uint64,bytes32)` | role:HEDGER_ROLE | hedger instant |
| WriterPool | `rebalance(address,uint256,uint256)` | role:HEDGER_ROLE | hedger instant |
| WriterPool | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| WriterPool | `requestWithdraw(uint256)` | anyone (burns the caller's own shares; never paused) | none (permissionless) |
| WriterPool | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setDepositor(address,bool)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setDepositsPaused(bool)` | role:DEFAULT_ADMIN_ROLE or role:GUARDIAN_ROLE | default_admin 48h timelock / guardian instant |
| WriterPool | `setHedgeRoute(address,address,uint24)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setHedgerLimits(uint16,uint16,bool)` | role:DEFAULT_ADMIN_ROLE or role:GUARDIAN_ROLE | default_admin 48h timelock / guardian instant |
| WriterPool | `setModules(address,address,address,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setNavGuard(uint16,uint16)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setParams(uint32,uint16,uint16,uint128)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setPublicDeposits(bool)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setStaking(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setVaultHook(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `syncHedgeUnits(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `transfer(address,uint256)` | holder | n/a (caller's own balance, role or one-time setup) |
| WriterPool | `transferFrom(address,address,uint256)` | holder-or-approved | n/a (caller's own balance, role or one-time setup) |
| WriterPool | `upgradeToAndCall(address,bytes)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
<!-- privileged-functions:end -->

## Trust assumptions

1. **Off-chain vol signer.** One signer decides the sigma the engine prices with. Damage is bounded on chain: a post moves at most
   25% from the prior value, at most one post per name and speed every 5 minutes, at most +/-50% over any rolling hour, never below
   a per-name floor (30% default), and expires after 2 hours. The skew coefficients are capped (k_put 3.0, k_call 1.0) on every post
   and move at most 0.2 per post. A stale post blocks buys and prices sells at sigma x 0.8 (a lapse lowers the bid, never raises it
   above the pool's mark). A compromised signer can still push sigma to the bound within an hour; the guardian can revoke the signer at
   once (`VolOracle.revokeSigner`), after which every post fails until the admin (timelock) sets a new one.
2. **Hedge equity posts.** The hedger posts equity only for off-chain perp venues. Perps are off at launch: the pool's
   `maxPerpEquityBps` is 0, so only zero can be posted, and the post-deploy check fails otherwise. Once the admin (48h timelock)
   turns perps on, equity can never exceed that share of the last NAV (ceiling 20%) and NAV counts it clamped to the cap; every
   post, whatever its `ref` (a label only), moves at most 10% of max(previous, cap) per hour. Posts go stale after 2 hours, which
   pauses buys and drops them from NAV. Spot hedges are held by the pool and valued on chain.
3. **Price feed and TWAP.** Prices come from the Chainlink feed for each Stock Token. The feeds print on a 0.5% deviation or a 24 hour
   heartbeat, so a healthy in-session price can be about a day old. Age alone is therefore not trusted: the price guard cross-checks
   a 30 minute Uniswap v3 TWAP (75 bps band by default, wider for TSLA) and pauses buys when they disagree or the TWAP is unavailable.
   A continuity check pauses buys on a jump the multiplier does not explain. Every trade (buy, sell, queued fill) is priced at the worse
   for the trader of the feed (or last good) price and a 5-minute TWAP of the same pool, in every session, so a feed that lags, has
   stopped, or is frozen over a weekend cannot be traded against the market, and moving the pool only worsens the mover's own fill
   (others are bounded by their maxCost / minProceeds, which a queued sell keeps). A sell within 30 minutes of the same account's buy of
   that series (carried through token transfers) is priced at the worse of that and the buy price. A feed that was halted in session
   stays halted on weekends and holidays, and a last good price older than 5 days reads halted, so those sells queue. A stock halted
   for 7 days can be settled by anyone at its last good price (`settleHalted`): its sells and queued fills then go through at that
   price (worse-of the TWAP, closed-session spread) and buys stay off. No sequencer uptime feed exists on this chain; an optional one
   is supported if it appears.
4. **Thin hedge pools.** SPY and TSLA hedge pools are shallow. A manipulator can pause buys for a while by moving a thin pool
   (denial of service); the TWAP means one block cannot change the price the engine uses. Per-name caps are scaled to measured pool depth.
5. **Stock Token issuer powers.** The issuer can pause a token's transfers and block a single address, and the multiplier is changed by
   the issuer (splits and dividends, staged, with the oracle paused around the change). All Stock Tokens share one upgradeable beacon; who can
   upgrade its implementation is not published. A Lemniscate contract that holds Stock Tokens (the pool's hedges) could be paused or blocked.
   The price guard pauses buys around a staged multiplier change.
6. **USDG issuer powers.** USDG can be paused, frozen per address and upgraded (behind the issuer's 24 hour timelock). If a USDG or
   Stock Token transfer reverts, a sell does not fail into a loss: it goes to the sell queue and fills later; buys revert.
7. **Chain.** Robinhood Chain is an Orbit L2 with a single sequencer; ordering, censorship and downtime are outside our control.
8. **Public RPC.** Services use free public RPC with backoff; a bad or rate-limited endpoint delays the indexer and keeper but cannot change
   on-chain state. The API reads Postgres; only the one-tap routes (`?format=userop`) make a few chain reads, capped by `AA_RPC_CALLS_PER_SECOND`
   (default 5, a 503 when spent), cached, never retried, and on their own node when `AA_RPC_URL` is set.

## Accepted risks

- Gap and earnings moves on a name can exceed the pool's hedge before anyone can react. The stress budget, per-name caps and the
  earnings buy-block bound this; they do not remove it.
- Daily options have very high gamma and the equity market is closed on weekends: closed-session sells use the worse of the last close
  and the token pool's 5-minute TWAP, a wider spread and a weekend sigma, and may differ from the price on reopening.
- Feed lag (review F01/F02): the feed prints on a 0.5% move, so a trader can know the next print. A round trip around a print now
  loses (the hold prices it at the buy S). Someone who holds past the 30-minute hold keeps only the part of the lag the 5-minute TWAP
  had not caught up with at the buy, and carries 30 minutes of market risk and funding for it: about 2% of a Daily at-the-money
  premium in expectation against a standard deviation of about half the premium (LOW).
- Funding sampling (review F11/F34): a gap between accruals is charged at the larger of the rate at its start and the rate now, so a
  holder cannot pick a favourable price for a gap; the keeper also samples every live series on its own schedule. What remains is
  a holder accruing at two favourable prints with no keeper accrual between them (at most one keeper interval) (LOW).
- LP entry and exit pricing (review F12/F15): until the keeper re-marks every live series of a name, deposits use a lower bound and
  claims an upper bound of the liability at today's price (O(names)), so an LP who exits right after a move the keeper has not
  re-marked yet may get slightly less than the exact NAV (and an entrant slightly fewer shares); after the keeper's re-mark the two
  bounds are the exact book value. The hedge leg of an entry or exit is valued at the worse for that LP of the feed S and the
  5-minute trade TWAP, and the high-water checkpoint always uses the exit side. The vol part of the bound is first order (x1.5 on the conservative side). The entry bound also
  subtracts the most funding can have taken since the name's last full re-mark (book value x elapsed / tau per speed), so a
  deposit just before an accrual does not capture it; what remains is the NAV guard band being built from the greeks at the
  marks (second order, tens of ppm of NAV per keeper interval) (LOW).
- Withdrawal tickets (review F12(c)): only the ticket's owner can claim it, so nobody else picks the moment of someone's exit.
  A matured ticket is claimable for `CLAIM_WINDOW` (7 days) after it matured or after its last pro-rata payment; a later claim
  re-queues it for a fresh 72-hour delay, pays nothing and moves nothing, so the exit moment is never an open-ended option.
  Within the window the owner still chooses when to claim, at the exit-side NAV bound (LOW).
- Dust (review F08/F14/F24): every buy costs at least $1 and a partial sell must move and leave at least $1 (a whole-balance sell is
  always allowed); series worth under $1 in total can be retired from the keeper's live list by anyone and accrue only when touched.
- The off-chain signer and the issuers in items 5 and 6 are trusted parties. We cannot remove those powers; we limit what they can do to Lemniscate state.
- Rounding always goes to the protocol side; a round trip in one block never returns more than was paid. Sub-wei differences are not a vulnerability.
- Pricing uses fixed-point approximations of a closed-form model; accuracy is tested against a high-precision reference (see the invariants file), not proven.
- Phase 2 `$LMNS` staking (off until the admin turns it on): the stake's cover counts toward NAV at an `$LMNS`/USDG TWAP less a
  slippage allowance, only up to the high-water mark, and never above `coverCapUsdg`, which the admin (timelock) sets from the
  measured depth of the `$LMNS` pool (0 = no cover counted, the default). A claim realises its slice of the Reserve and of the
  stake pro rata; when a slash cannot clear its floor, the part it did not deliver is charged to that claim (and only the ticket
  owner may take such a claim), never to the LPs who stay. A loss the pool already counts against the stake is set aside in
  `$LMNS` (`lockedForPool`) before any unstake completes or new stake enters (and by anyone through `syncLoss`, run hourly by
  the keeper), so stakers cannot leave with the stake's part of it and new stakers do not absorb it; slashes sell the
  set-aside first, and it returns to the stakers if the loss recovers. A TWAP outage keeps the set-aside as it is. A manipulated TWAP can at most make an uncovered loss look covered up to
  the cap; the slash itself is floored at the same TWAP, so a bad price makes it sell nothing rather than sell cheap. Only the pool
  can slash. Both `$LMNS` swaps (the slash and the burn bucket's buy) run only while the `$LMNS` pool's spot price is within
  50 bps of its TWAP, so a caller cannot push spot to the slippage floor inside its own transaction and trade against them;
  the buy is keeper-only and capped per call (`maxUsdgPerCall`), and the activation check (`DeployLmns.lmnsFailures`) refuses
  a slippage above 150 bps, a price source without a spot read, an unset cover cap or a large per-call buy.
- Phase 2 writer vaults (closed and unwired at launch; `PostDeployCheck` fails if a deploy wires them without the flag, or wires
  `$LMNS` staking or fee tiers at all). A vault's loss on a buyback is the intrinsic value of the covered slice, and vaults cover
  out-of-the-money bands only. The vaults' share of funding and spread is paid only from the pool's cash at that moment: what cash
  cannot cover is not carried forward or owed later. A vault hook that reverts never blocks a buy, a sell or a funding report; one
  that runs out of gas reverts the sell (so a seller cannot pick the gas that skips the vaults' settlement).
- Loss order with both phase-2 modules on: the Reserve, then staked `$LMNS`, then LP NAV. Writer vaults bear only their covered
  slices and are settled in their own collateral.
- Dust positions (under `KEEPER_ACCRUE_DUST_USDG`, default 1 USDG outstanding) are accrued once a day, not hourly: their book value
  can lag by up to that amount per series for up to a day. The number of series is bounded by the lister, so the total is bounded.
  (Low; the alternative is an hourly accrual bill per dust position.)
- The vol-engine's holiday calendar (a copy of the keeper's, 2026 to 2028) ends in 2028. Past it, a holiday weekend is treated as a
  full-weight closed session from the first CLOSED tick, as before the ramp existed. Update the list each year. (Low.)
- Gas sponsorship is a privilege, not a right: a denied request (no invite, dust, no balance, quota) is returned unsponsored and the
  plain transaction always works. A holder with no ETH and a dust-sized position pays gas for that exit from the account, by design.

## Service protections added by the 2026-10-17 security review (lane C)

Off-chain services, each with a regression test that fails without the fix (finding numbers refer to the private review):

- **Indexer (F04).** Every event is applied inside its own savepoint. One that cannot be applied is rolled back alone, recorded in
  `indexer_skipped_events` with the reason, logged at error level, and ingestion continues. Chain timestamps a stranger controls are clamped to
  the year 9999 instead of throwing.
- **Vol-engine (F05, F43, F44, F45, F46).** Scheduled variance (earnings, the weekend) ramps in geometrically over at least two decay
  times instead of switching on, so holding through a ramp costs more in funding than it gains; the weekend ramp follows the NYSE closed
  run; a pre-market print feeds the overnight gap before the open; buys are blocked while the posted sigma lags a higher target.
  No post is signed from ticks older than 25 minutes (the oracle goes stale and buys pause). A post is `sent` only after a successful
  receipt; a reverted or dropped one is `failed` with an alert. The signer's virtualenv is built from a hash-pinned lock.
- **Keeper (F28, F29, F36).** Queued sells are selected round-robin across series with backed-off tickets excluded in SQL, dust last
  (one per pass); dust accruals run daily.
- **Hedger (F30).** Routes come from the reviewed deployment pools (AAPL included); startup fails if a deployed name has no route; a name
  that cannot be hedged for 15 minutes has its buys paused.
- **Gas sponsorship (F25, F31, F32).** The API signs paymaster data only for a verified owner with a real trade, inside per-day quotas
  booked in Postgres (per account, owner, network and global, exits in their own group), never over an operation that could not be
  simulated, and fails closed. Chain reads for these routes are budgeted and cached.
- **API (F33, F40, F41, F42).** The smart-account route never touches key material; MCP callers are counted per address; an `Origin`
  header never waives an x402 payment (the website's own server uses `X402_INTERNAL_TOKEN`); the x402 settler serialises its sends.
- **Follow-ups to the contract fixes (F01-F03, F06-F08, F10-F12, F17, F19, F21-F24, F26, F27, F37-F39).** The keeper sends
  `retireDust` for dust series, relists or archives every buyable series under the relist norm (1e15), accrues every live non-dust series
  once per 5-minute slot in REGULAR and EXTENDED whatever its `lastAccrual`, keeps `accrueMany` batches at 45 or fewer, backs a queued
  sell that reverts on `Slippage` off alone (doubling to 6 hours), settles stocks HALTED past the settle delay, calls `syncLoss` hourly
  and the keeper-only `buyAndBurn` when enabled. The API prices quotes and sells at the worse of S and `PriceGuard.tradeTwap`, shows
  and applies the 30-minute hold before a sell, and carries a halt notice. Gas is sponsored only for accounts the paymaster knows that
  run the Kernel implementation, at a fee that keeps the operation under `maxCostPerOp`. The hedger backs off on `HedgerFrozen`,
  `HedgeLossBudget` and `PerpEquityCap` with an alert instead of retrying.

Accepted risks of these follow-ups:

- The API reads holds and the trade TWAP from the indexer's last snapshot, not the chain. A sell quoted in the seconds between a buy
  (or a transfer) and the next snapshot can be priced without its hold, and a TWAP that moved since the snapshot shifts the quote. The
  engine prices the trade itself; the worst case is a sell that reverts on its own `minProceeds` and is quoted again. The quote never
  makes a seller accept less than the slippage they chose.
- The grid sample runs only while a name is in REGULAR or EXTENDED: outside those sessions the price guard does not move S, so there
  is no print to pick, and the hourly catch-up still accrues every held series.
- Market-wide events (retirement, halt latch, settlement) appear in the activity of accounts that hold the series or name now; an account
  that sold before the event does not see it.

## Service fixes from the round 2 review (lane b2, services only)

Each has a regression test that fails without it and a property or fuzz test of the general rule (finding numbers refer to the private review):

- **Vol-engine ramp (R01).** The earnings ramp now bounds the drift of the option's VALUE, not only of sigma: the weight follows
  `dw/dt = 2 share / (tau eps ln R)` where eps is the largest d ln(time value) / d ln sigma over strikes out to 20 % from spot, so at
  every grid strike (ITM, ATM and OTM, calls and puts, Daily and Weekly) a buyer's value, after what funding takes of the units,
  never rises over the ramp. The ramp is therefore weeks long (about 2 weeks Daily and 2 to 3 weeks Weekly at 50 % sigma and a 7 % move;
  up to 4 to 7 weeks at the 30 % floor) and starts slowly. The weekend ramp uses the same schedule from the first second of the closed run
  and is cut off at the run's end, so for Weekly it is small (a 48-hour run is a fraction of tau); it had paid about +30 % on a 5 % OTM
  Weekly option bought before the run. The two ramps can run together, so their drift shares add up to 0.9 of funding. Property tests
  (`vol-engine/tests/test_ramp_property.py`, `test_exploit_f05.py`) buy at every step and sell at every later step.
- **Halt latch (R05).** `PriceGuard.poke` is the only writer of `haltedSince` and only in a REGULAR or EXTENDED session, and the price
  upkeep skipped every stock that did not read live. It now pokes a stock that reads HALTED in session with no latch, once, so the
  CLOSED-price refusal and the settle clock start with only the operator's keeper running (property test over random session
  patterns and stop times in `prices.test.ts`).
- **Queued sells keep a floor (R06).** The sell intent used `minProceeds = 0` whenever the indexed snapshot said HALTED, so a
  permissionless `fillQueued` could be lined up with a pushed TWAP at the settle time or a resumption. The intent now sets the floor from
  the indexed quote minus the caller's slippage plus a wider queued band (1,500 bps), shows it in `queuedBandBps` and the note, and
  refuses to queue a position worth nothing at the indexed price. Property test: every sell intent in every session returns a
  minimum above 0 and no higher than the quote.
- **Sponsorship is booked as a reservation (R11).** A grant was counted for the whole UTC day from the moment the API signed, whether
  or not the operation was ever sent, so signatures nobody used could exhaust the day's global exit budget for free. A booking now
  expires when its paymaster signature can no longer be used (validity plus a minute) and becomes a spend only when
  `/v1/userop/send` relays that operation (matched by its hash). The per-account, per-owner and per-network limits count spends and
  live reservations, so a flood spends the flooder's own limits; the global limit counts spends only. The money stays bounded by the
  paymaster's own on-chain daily caps, and an operation sent to a bundler without our relay is not counted by the API (the
  chain caps still apply).
- **The account-abstraction read budget is partitioned (R12).** One 5 reads-per-second bucket let one client keep every `?format=userop`
  build at 503. Each client (IPv4 or IPv6 /64) now has a 1 read-per-second share with a burst under half the shared one, 40 % of the
  rate is reserved for sells of smart accounts a read has shown to have a stored owner, `?format=userop` builds are limited to 30 a
  minute per client, and cache entries that never expire (deployed accounts) are kept apart from throw-away keys, so a flood cannot evict
  them. Tests: one client at the route limit leaves another's sell build served; under any number of flooding clients a warm sell is
  always served.
- **The funding grid is bounded (R13).** The 5-minute grid accrued every live series worth at least a dollar, so deep-ITM series held
  for $1 each billed the keeper about 59 million gas a day apiece. The grid now samples only non-archived series with at least $100 of
  outstanding value (`KEEPER_ACCRUE_GRID_MIN_VALUE_USDG`), at most 450 per slot, the most valuable first (`KEEPER_ACCRUE_GRID_MAX_SERIES`),
  with an alert when more qualify; everything else stays on the hourly catch-up.
- **Hedger reverts are named (R19).** The keeper simulates with raw calldata, and a node reports a custom-error revert as `execution
  reverted` plus data, so no message ever carried `HedgerFrozen`, `HedgeLossBudget` or `PerpEquityCap` and the back-off and the alert never
  fired in production. The transaction queue now decodes the revert data (against every contract's errors, with the PoolHedging library
  errors added) and puts the error's name and arguments in the message; the hedger reads the decoded name. Tested against a real viem
  client talking to a geth-shaped JSON-RPC server.

- **A seller's failing tickets cannot hold a series (R14).** A queued sell that failed for any reason that is not a transient fault
  used to write off its whole series for the pass, and a Slippage revert was never recognised from a real node's error text, so six
  cheap tickets at the head of a series stopped the keeper from filling the honest ones behind them. Revert reasons are now decoded from
  the revert data; every failure backs the ticket off alone (doubling to 6 hours); a seller has at most 4 tickets of a series tried per
  pass, 2 once one of them has failed; and a stock whose feed is HALTED and unsettled is left out of the pass (read from the chain, not
  guessed from an error), so its tickets take no slots.

- **Retired series are accrued in an hourly dust pass, never re-sent in vain (R15, reconciled with the contracts' R07 fix).**
  `accrueMany` used to skip a series off the engine's live list without moving its `lastAccrual`, and the hourly list was built from
  the whole registry, so every retired dust series was sent again on every 5-minute run (about 288 no-op transactions a day per 45
  series). The engine now accrues retired series in `accrueMany` and re-lists one worth the minimum again, so the keeper sends every
  dust-tier series (retired, dust on the live list, or under `KEEPER_ACCRUE_DUST_USDG` by indexed value) together in one dust pass
  once the oldest is `KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS` old (default one hour; at most a week). The pass re-marks the whole dust
  tier (its NAV envelope resets) and bounds how long a series that regained value waits for the 5-minute grid. Its cost is
  ceil(N / batch) transactions an hour for N dust series, about 7 million gas a day per series at the hourly default; raise the age
  to trade gas for a looser dust-tier claim bound. Property test: a second run with nothing changed sends nothing, and over a day
  every held series is accrued within the cadence and a retired one at most 25 times.

## Contract protections added by the round-2 review (2026-10-25, lane A)

These amend the bullets above where they differ (decisions 54-64).

- Sell hold (R02): the 30-minute hold binds only the tokens the account's own buys minted; only those are priced at the buy S.
  Held tokens cannot be transferred until the hold ends, a transfer never writes the receiver's hold, and only the buyer itself
  (or the configured AgentRouter, for its owner) may receive a buy, so nobody can pin or extend another account's sell price.
  Accepted: a buyer cannot move its tokens for 30 minutes after a buy; selling is never blocked.
- Agent sells (R04/R03): the AgentRouter sells through `engine.sellFor`, which prices, sizes and escrows as the owner (balance,
  hold, fee tier, ticket). A partial sell whose remainder is worth less than the minimum trade sells the whole balance instead of
  reverting, so dust sent to a seller or a router never blocks an exit.
- Retired dust (R07): a series retired as dust still accrues when the keeper sends it, re-lists once worth the minimum again,
  stays in the NAV bounds and in `totalLiability`; retirement never changes a holder's funding.
- LP-flow bounds (R09/R16): the NAV envelope resets per pass (every series of a tier re-marked, in any batching), separately for
  live and dust series, and both bounds use the worse for the LP of the feed S and the trade TWAP. Accepted: between dust passes
  the dust tier's claim bound can be lower than exact (claims priced low, never high); the keeper's dust cadence bounds it.
- Reserve (R10/R08): the Reserve covers only a drop of the mid (book value, hedge at S) NAV below the high-water mark, never the exit
  side's pessimism; a pro-rata claim capped to the cash on hand burns only the shares it is paid for.
- Halts (R05): PriceGuard derives the halt start from the feed's own staleness, so the CLOSED-reads-HALTED rule and the ORC-4
  settle clock work with nobody calling `poke`. Accepted: the derived start can be up to 6 hours late when the first stale moment
  falls in a closure.
- Paymaster (R17/R18): anyone can register a deployed standard Kernel account (`registerKernelAccount`), so deploying a user's
  account first cannot make it unsponsorable; `DeployPaymaster` passes with the mainnet config (deposit funded after deploy).

## Audit history

None yet. Internal review, fuzzing, stateful invariants and mutation tests are documented in [contracts/INVARIANTS.md](../contracts/INVARIANTS.md).
This section will list each external audit, its date and its report once one exists.
