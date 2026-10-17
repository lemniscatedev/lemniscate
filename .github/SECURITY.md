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
| Guardian (2-of-3) | Multisig, plus the keeper's risk monitor for automatic pauses | Pause buys, Shield and pool deposits | Pause sells, withdrawals, claims or `fillQueued`; change parameters; upgrade |
| Keeper | One hot key | List series and set them buyable or archived; push market sessions; call `accrue` and `accrueMany`; pause buys (guardian role); poke the price guard around corporate actions | Change parameters; touch pool funds; sign vol posts |
| Hedger | One hot key | Post off-chain hedge equity; call the pool's `rebalance(stock, targetUnits, minOut)` inside its TWAP floor and slippage bound | Withdraw pool funds; move USDG anywhere but through the pool's own swap route |
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
engine and agent router, and the factory is owned by the series registry that created it.

<!-- privileged-functions:start (generated by contracts/script/ci/privileged-functions.py) -->
| Contract | Function | Who may call | Delay |
| --- | --- | --- | --- |
| AgentRouter | `buyFor(address,bytes32,uint128,uint128,uint64)` | anyone (the owner's agent key, inside its policy) | none (permissionless) |
| AgentRouter | `cancelQueuedFor(uint256)` | anyone (the owner of that queued sell) | none (permissionless) |
| AgentRouter | `revoke(address)` | anyone (acts on the caller's own agents) | none (permissionless) |
| AgentRouter | `sellFor(address,bytes32,uint128,uint128,uint64)` | anyone (the owner's agent key, inside its policy) | none (permissionless) |
| AgentRouter | `setPolicy(address,uint128,uint128,uint64,bool,bool,address[])` | anyone (acts on the caller's own policy) | none (permissionless) |
| AgentRouter | `shieldFor(address,address,uint128,uint16,uint128,uint64)` | anyone (the owner's agent key, inside its policy) | none (permissionless) |
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
| LemniscateEngine | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `sell(bytes32,uint128,uint128,uint64,address)` | anyone (sells the caller's own tokens; never paused) | none (permissionless) |
| LemniscateEngine | `setBuysPaused(bool)` | role:DEFAULT_ADMIN_ROLE or role:GUARDIAN_ROLE | default_admin 48h timelock / guardian instant |
| LemniscateEngine | `setHedgeDepthCap(address,uint256)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `setParams(tuple)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscateEngine | `setSeriesBuysPaused(bytes32,bool)` | role:DEFAULT_ADMIN_ROLE or role:GUARDIAN_ROLE | default_admin 48h timelock / guardian instant |
| LemniscateEngine | `shield(address,uint128,uint16,uint128,uint64)` | anyone | none (permissionless) |
| LemniscateEngine | `syncSeries(uint256)` | anyone | none (permissionless) |
| LemniscateEngine | `upgradeToAndCall(address,bytes)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| LemniscatePaymaster | `acceptOwnership()` | pending-owner | n/a (caller's own balance, role or one-time setup) |
| LemniscatePaymaster | `addStake(uint32)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `deposit()` | anyone (funds the paymaster) | none (permissionless) |
| LemniscatePaymaster | `postOp(uint8,bytes,uint256,uint256)` | contract:entrypoint (ERC-4337 entry point only) | entrypoint only |
| LemniscatePaymaster | `renounceOwnership()` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `setLimits(uint256,uint256,uint256)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `setPaused(bool)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `setSigner(address)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `transferOwnership(address)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `unlockStake()` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `validatePaymasterUserOp(tuple,bytes32,uint256)` | contract:entrypoint (ERC-4337 entry point only) | entrypoint only |
| LemniscatePaymaster | `withdrawStake(address)` | owner | owner (a Safe, 2-step ownership, no timelock) |
| LemniscatePaymaster | `withdrawTo(address,uint256)` | owner | owner (a Safe, 2-step ownership, no timelock) |
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
| PriceGuard | `setSequencerFeed(address,uint32)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| PriceGuard | `setStock(address,tuple)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
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
| VolOracle | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| VolOracle | `post(tuple,bytes)` | anyone (needs the vol signer's EIP-712 signature) | none (permissionless) |
| VolOracle | `renounceRole(bytes32,address)` | self | n/a (caller's own balance, role or one-time setup) |
| VolOracle | `revokeRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| VolOracle | `setFloor(address,uint64)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| VolOracle | `setSigner(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `approve(address,uint256)` | holder | n/a (caller's own balance, role or one-time setup) |
| WriterPool | `checkpoint()` | anyone | none (permissionless) |
| WriterPool | `claim(uint256)` | anyone (pays the ticket's owner) | none (permissionless) |
| WriterPool | `deposit(uint256,address)` | anyone | none (permissionless) |
| WriterPool | `grantRole(bytes32,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `initialize(address,address,address,address)` | once:initializer | n/a (caller's own balance, role or one-time setup) |
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
| WriterPool | `setModules(address,address,address,address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setNavGuard(uint16,uint16)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setParams(uint32,uint16,uint16,uint128)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `setPublicDeposits(bool)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `syncHedgeUnits(address)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
| WriterPool | `transfer(address,uint256)` | holder | n/a (caller's own balance, role or one-time setup) |
| WriterPool | `transferFrom(address,address,uint256)` | holder-or-approved | n/a (caller's own balance, role or one-time setup) |
| WriterPool | `upgradeToAndCall(address,bytes)` | role:DEFAULT_ADMIN_ROLE | default_admin 48h timelock |
<!-- privileged-functions:end -->

## Trust assumptions

1. **Off-chain vol signer.** One signer decides the sigma the engine prices with. Damage is bounded on chain: a post moves at most
   25% from the prior value, at most one post per name and speed every 5 minutes, at most +/-50% over any rolling hour, never below
   a per-name floor (30% default), and expires after 2 hours. A stale post blocks buys and prices sells at sigma x 1.2. A compromised
   signer can still push sigma to the bound within an hour; the signer is separate from every other key and rotation takes the admin path.
2. **Hedge equity posts.** The hedger posts equity only for off-chain perp venues, which are off and post zero until an account
   exists. Spot hedges are held by the pool and valued on chain. A post may move at most 10% per hour unless it carries a fill
   reference, and goes stale after 2 hours, which pauses buys.
3. **Price feed and TWAP.** Prices come from the Chainlink feed for each Stock Token. The feeds print on a 0.5% deviation or a 24 hour
   heartbeat, so a healthy in-session price can be about a day old. Age alone is therefore not trusted: the price guard cross-checks
   a 30 minute Uniswap v3 TWAP (75 bps band by default, wider for TSLA) and pauses buys when they disagree or the TWAP is unavailable.
   A continuity check pauses buys on a jump the multiplier does not explain. Sells keep working on the feed or the last good price at the
   wider spread. No sequencer uptime feed exists on this chain; an optional one is supported if it appears.
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
   on-chain state. The API reads only Postgres.

## Accepted risks

- Gap and earnings moves on a name can exceed the pool's hedge before anyone can react. The stress budget, per-name caps and the
  earnings buy-block bound this; they do not remove it.
- Daily options have very high gamma and the equity market is closed on weekends: closed-session sells use the last close, a wider
  spread and a weekend sigma, and may differ from the price on reopening.
- The off-chain signer and the issuers in items 5 and 6 are trusted parties. We cannot remove those powers; we limit what they can do to Lemniscate state.
- Rounding always goes to the protocol side; a round trip in one block never returns more than was paid. Sub-wei differences are not a vulnerability.
- Pricing uses fixed-point approximations of a closed-form model; accuracy is tested against a high-precision reference (see the invariants file), not proven.
- Phase 2 `$LMNS` staking (off until the admin turns it on): the stake's cover counts toward NAV at an `$LMNS`/USDG TWAP less a
  slippage allowance, and only up to the high-water mark. A manipulated TWAP can at most make an uncovered loss look covered until
  the next payout or claim; the slash itself is floored at the same TWAP, so a bad price makes it sell nothing rather than sell cheap.
  The admin (timelock) chooses the TWAP source and swap route; only the pool can slash.

## Audit history

None yet. Internal review, fuzzing, stateful invariants and mutation tests are documented in [contracts/INVARIANTS.md](../contracts/INVARIANTS.md).
This section will list each external audit, its date and its report once one exists.
