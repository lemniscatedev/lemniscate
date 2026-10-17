# Invariants and properties

Every protocol invariant and per-function property, with the test that checks it (`path::function`, paths relative
to `contracts/`). The engine tests run the real `LemniscateEngine` behind an ERC1967 proxy, the real `SeriesRegistry`
and option-token clones, and mock PriceGuard / VolOracle / Writer Pool (`test/mocks/EngineMocks.sol`);
`test/engine/EngineGas.t.sol` uses the real PriceGuard (feed + Uniswap TWAP cross-check) and the real VolOracle.

How to run:

| What | Command |
|------|---------|
| Everything (fast defaults: fuzz 256 runs, invariants 50 x 20) | `forge test` |
| Deep stateful run (500 runs x 200 calls, fuzz 5,000) | `FOUNDRY_PROFILE=deep forge test --match-contract EngineInvariantTest` |
| Gas record (buy, sell, accrueMany(50), totalLiability(200)) | `forge test --match-contract EngineGasTest -vv` |
| System gas table, real engine + pool, isolated calls (todo 07b R5) | `forge test --match-contract SystemGasTest -vv` |
| Deep system run (real engine + pool, 500 runs x 200 calls) | `FOUNDRY_PROFILE=deep forge test --match-contract SystemInvariantTest` |
| Mutation testing | `python3 script/mutation/mutate.py` (see `script/mutation/README.md`) |

## 1. Engine invariants (stateful)

Handler: `test/engine/EngineHandler.sol` (buys, sells, same-block round trips, token transfers, HALTED sells with
fills and cancels, accrueMany, price moves of at most 3% per step, session changes including HALTED, time warps).
Expected reverts are swallowed; a Panic is recorded and fails `invariant_noPanic`.

| # | Invariant | Test (`test/engine/EngineInvariant.t.sol::`) |
|---|-----------|------|
| E1 | norm never rises | `invariant_normMonotone` |
| E2 | norm in [Funding.MIN_NORM, 1e18] | `invariant_normBounds` |
| E3 | the engine's norm / lastAccrual equal the registry's | `invariant_registryMirror` |
| E4 | `totalLiability()` equals an independent supply x norm x V recomputation | `invariant_totalLiabilityEqualsRecomputation` |
| E5 | each name book is exactly the sum of its series' contributions | `invariant_nameBookIsSumOfSeries` |
| E6 | `bookValue` is the sum of the name books | `invariant_bookValueIsSumOfNames` |
| E7 | USDG conserved | `invariant_usdgConserved` |
| E8 | the engine never holds USDG | `invariant_engineHoldsNoUsdg` |
| E9 | pool cash moves only by buys and sell payouts (funding moves no USDG) | `invariant_poolCashOnlyByTrades` |
| E10 | a buyer's USDG only leaves as buy cost (no debt state exists) | `invariant_buyerOutflowIsPremiumOnly` |
| E11 | escrowed option tokens equal the open sell tickets, per series | `invariant_escrowMatchesTickets` |
| E12 | supply x norm solvency: balances add up to supply, holder units <= supply x norm | `invariant_supplyNormSolvency` |
| E13 | no Panic | `invariant_noPanic` |
| E14 | same-block round trips never profit | `invariant_noRoundTripProfit` |
| E15 | `netGreeks` is the name book (holders' long side) | `invariant_netGreeksAreTheBook` |
| E16 | the live list of each stock is exactly its series with tokens outstanding (todo 07b R2) | `invariant_liveSetIsNonZeroSupply` |

## 2. Engine rules (engine todo R1-R21)

| Rule | Tests (`test/engine/`) |
|------|------|
| R1 buy maths: V_mark = V(sigma)(1 + a n), spread, fee, $0.01 floor, cost up / tokens down, quote == execution | `EngineTrade.t.sol::test_R1_*`, `testFuzz_R1_*` |
| R2 spread schedule and the 20 API-model cases (`test/vectors/quote-vectors.json`), skew decoding, stale-vol x1.2, daily cost | `EngineRisk.t.sol::test_R2_*` |
| R3 buy checks, each with its own error; EXTENDED halves the caps | `EngineTrade.t.sol::test_R3_*` |
| R4 stress budget; incremental book vs brute-force revaluation | `EngineRisk.t.sol::test_R4_stressBudget`, `testFuzz_R4_*` |
| R5 sells never blocked by pauses | `EngineSell.t.sol::test_R5_*`, `testFuzz_R5_*` |
| R6 CLOSED / UNKNOWN sells at last good S, posted sigma, 3x spread | `EngineSell.t.sol::test_R6_*` |
| R7 HALTED sell queue: escrow, fill by anyone, cancel by seller, escrow keeps paying funding | `EngineSell.t.sol::test_R7_*` |
| R8 no round-trip profit | `EngineSell.t.sol::testFuzz_R8_*`, `test_R8_*` |
| R9 buyer max loss = premium | `EngineTrade.t.sol::test_R9_*`, `testFuzz_R9_*` |
| R10 accrue first; no-op in the same block; accrueMany(50) gas | `EngineAccrue.t.sol::test_R10_*` |
| R11 shield series choice | `EngineTrade.t.sol::test_R11_*` |
| R12 funding flows to the pool exactly; a failing pool never blocks accrual | `EngineAccrue.t.sol::test_R12_*`, `testFuzz_R12_*` |
| R13 deadline and slippage | `EngineTrade.t.sol::test_R13_*` |
| R14 UUPS admin-only, freeze, namespaced storage, locked implementation | `EngineAdmin.t.sol::test_R14_*` |
| R15 events and topic layout the indexer decodes; netGreeks sign | `EngineAdmin.t.sol::test_R15_*` |
| R17 / R21 name cap = min(8% NAV, hedge depth cap) | `EngineTrade.t.sol::test_R17_*`, `test_R21_*` |
| R18 blocked USDG transfers queue sells, buys revert | `EngineSell.t.sol::test_R18_*` |
| R19 one PriceGuard read per stock per transaction; readLite == read minus TWAP | `EngineAccrue.t.sol::test_R19_*`, `PriceGuardTwap.t.sol::test_R19_*` |
| R20 stress re-checked on accrue and sells; auto-pause and auto-resume | `EngineAccrue.t.sol::test_R20_*` |

## 3. Writer Pool invariants (stateful)

Handler: `test/pool/PoolInvariant.t.sol::PoolHandler` (LP deposit / request / claim / share transfer, engine buy / sell /
accrual through `MockPoolEngine`, hedger rebalance, price moves of at most 10%, warps, fee distribution, checkpoints)
over the real `WriterPool` (ERC1967 proxy), `Reserve`, `FeeRouter` and `UniswapV3HedgeAdapter`. 64 runs x 120 calls.

| # | Invariant | Test |
|---|-----------|------|
| W1 | Share supply == sum of holders (LPs + the pool's queue escrow); escrow == `queuedShares` == open ticket shares | `test/pool/PoolInvariant.t.sol::invariant_R12_sharesSupplyEqualsHolders` |
| W2 | USDG conserved: everything minted sits with a known holder; engine and adapter hold none | `test/pool/PoolInvariant.t.sol::invariant_R12_usdgConserved` |
| W3 | No allowance left from the pool to the adapter or from the adapter to the router | `test/pool/PoolInvariant.t.sol::invariant_R12_noDanglingApprovals` |
| W4 | Tracked hedge units <= Stock Tokens held (no phantom hedge) | `test/pool/PoolInvariant.t.sol::invariant_R12_hedgeUnitsBackedByStock` |
| W5 | NAV == cash + hedge x S + fresh perp equity - fees owed - liability + reserve share; reserve share <= reserve; navLow <= nav <= navHigh | `test/pool/PoolInvariant.t.sol::invariant_R12_navMatchesRecomputation` |

## 4. WriterPool, Reserve, FeeRouter rules (todo 08)

| # | Property | Test |
|---|----------|------|
| R1 | Shares minted at NAV (guard high edge) x 1.001; 12-decimal shares; first deposit >= 1 USDG; a donation cannot capture a later deposit | `test/pool/WriterPool.t.sol::test_R1_depositMintsAtNavPlus10Bps`, `::test_R1_firstDepositorCannotInflate` |
| R2 | Allowlist or public (admin switch); self-received deposits; 24h lock blocks transfers and queue requests | `test/pool/WriterPool.t.sol::test_R2_depositAllowlistOrPublic`, `::test_R2_depositLock24hAndSelfReceiver` |
| R3 | 72h queue paid at claim-time NAV (guard low edge); cash raised from hedges; pro rata when liquid assets cannot pay every queued share, rest of the ticket stays claimable; the queue is the only exit | `test/pool/WriterPool.t.sol::test_R3_withdrawalQueue72h`, `::test_R3_claimRaisesCashFromHedges`, `::test_R3_massExitProRataNeverLost`, `::test_R3_queueIsTheOnlyExit` |
| R4 | NAV formula equals an independent recomputation; readLite preferred; NAV guard band from the engine's net greeks (gamma only when hedged, wider when closed) | `test/pool/PoolFuzz.t.sol::testFuzz_R4_navFormula`, `test/pool/WriterPool.t.sol::test_R4_navFormula`, `::test_R4_navPrefersReadLite`, `::test_R4_navGuardBandFromNetGreeks` |
| R5 | Perp equity: HEDGER only, asOf not in the future and increasing, <= 10%/h move without a fill ref, stale after 2h (excluded from NAV) | `test/pool/WriterPool.t.sol::test_R5_hedgeEquityPosts` |
| R6 | Reserve takes 15% of spread up to 5% of NAV; losses below the high-water mark are covered by the reserve before LP NAV; exits and payouts draw only the reserve share | `test/pool/WriterPool.t.sol::test_R6_reserveAbsorbsFirst`, `::test_R6_payDrawsReserveOnlyUpToItsShare`, `test/pool/FeeRouter.t.sol::test_R6_reserveCoverIsPoolOnly` |
| R7 | Protocol fee 10% of spread and funding; owed when cash is short; weekly 80/10/5/5 split (workers: pool/keepers/hedger), unset buckets held, dust stays | `test/pool/WriterPool.t.sol::test_R7_protocolFeeOnSpreadAndFunding`, `::test_R7_feeOwedWhenCashIsShort`, `test/pool/FeeRouter.t.sol::test_R7_feeRouterSplit`, `::test_R7_roundingDustStaysInRouter`, `::test_R7_splitsAreAdminOnlyAndSumToOne` |
| R8 | Caps 3500 / 800 bps exposed (`capsFor`), mirrored from the engine's `capBps()` (one source of truth, todo 07b) | `test/pool/WriterPool.t.sol::test_R8_capsExposedToEngine` |
| R9 | onSale / onFunding / pay engine only; pay raises cash from hedges, then the reserve share, else reverts Insolvent | `test/pool/WriterPool.t.sol::test_R9_engineOnly`, `::test_R9_payRaisesCashThenRevertsInsolvent` |
| R10 | Deposit then request + claim at an unchanged mark never returns more than deposited | `test/pool/PoolFuzz.t.sol::testFuzz_R10_navRoundTripNeverProfits`, `test/pool/WriterPool.t.sol::test_R10_navRoundTripNeverProfits` |
| R11 | Guardian can pause deposits only (not unpause, not params); claims and pay-outs keep working | `test/pool/WriterPool.t.sol::test_R11_guardianPausesDepositsOnly` |
| R12 | See section 3 (W1-W5) | `test/pool/PoolInvariant.t.sol` |
| R13 | Pool holds the spot hedge: HEDGER-only rebalance, TWAP-floored both ways, caller bound, fresh price, cash buffer, exact approvals cleared | `test/pool/WriterPool.t.sol::test_R13_poolHoldsSpotHedges`, `::test_R13_rebalanceIsTwapFlooredAndCallerBounded`, `::test_R13_rebalanceNeedsFreshPriceRouteAndCash`, `::test_R13_routeAndSyncAdminOnly` |
| - | Upgrades admin only; initializers locked; engine set once | `test/pool/WriterPool.t.sol::test_upgradeAdminOnlyAndInitLocked` |


## 5. Notes

- The stress book stores, per series, the value change in each scenario (S x 0.75, 0.9, 1.1, 1.25) from a full
  revaluation at the series' last touch, not a delta-gamma approximation: for Daily options a delta-gamma estimate of a
  25% gap overstates the loss about four times. The book is exact at the prices it was refreshed at. After a move from
  S to S' it stays within a proven bound: per name, 1.25 |S' - S| per unit outstanding (option deltas lie in [0, 1] or
  [-1, 0]) plus the hedge's |m| |S' - S| and the re-skew of sigma, and the worst case moves by at most
  sum eps + 2 max eps (`testFuzz_R4_staleStressWithinProvenBoundAfterHalfPctMoves`). No relative bound holds in
  general: the old "within 5% after a 0.5% move" claim failed at 5.05% (`test_R4_staleStressCounterexampleWithinProvenBound`).
  The keeper's hourly `accrueMany` refreshes the book.

## 6. Engine + pool integration (todo 07b)

`test/system/` runs the REAL `LemniscateEngine` and REAL `WriterPool` (with `Reserve`, `FeeRouter`, `PoolHedging`,
`UniswapV3HedgeAdapter`), the real `SeriesRegistry`, `PriceGuard` and `VolOracle` (signed posts) over mock feeds
(`SystemFixture`). Handler `SystemHandler`: buys, sells, LP deposits / requests / claims, hedger rebalances, keeper
accruals, moves of up to 3%, 25% gaps (others up to 10%), session changes, time, and (todo 10 R4) guardian pauses with
admin unpauses, vol posts that move sigma, and hedge-equity posts. Deep run: `FOUNDRY_PROFILE=deep forge test --match-path 'test/system/*'`.

| Rule | Property | Test (`test/system/`) |
|------|----------|------|
| R1 | Pool NAV, deposits, claims, payouts use `engine.bookValue()` (O(1)); sell < 1.2M gas with 200 listed series; `nav()` < 2M gas with 1,000 series | `SystemGas.t.sol::test_R1_sellGasWith200ListedSeries`, `::test_R1_navGasWith1000Series` |
| R1 | `bookValue == totalLiability` right after accrueMany of every live series | `SystemGas.t.sol::test_R1_bookValueEqualsTotalLiabilityAfterAccrueAll`, `SystemInvariant.t.sol::invariant_totalLiabilityRecompute` |
| R1 | One source for the 35% / 8% caps: the engine's parameters; the pool mirrors `engine.capBps()` | `test/pool/WriterPool.t.sol::test_R8_capsExposedToEngine` |
| R2 | 1,000 archived zero-supply series change buy, sell, accrueMany(live), totalLiability and shield gas by < 5%; accrueMany skips an empty series for < 5k gas | `SystemGas.t.sol::test_R2_onlyLiveSeriesCost` |
| R3 | Epoch ids, relist below norm 0.001 or when archived, old epoch archived and sellable, `.N` symbols | `test/SeriesRegistry.t.sol::test_R3_seriesEpochs`, `::test_R3_relistThresholdAdminOnlyAndBounded`, `SystemGas.t.sol::test_R3_seriesEpochsEndToEnd` |
| R4 | USDG conserved; engine and adapter hold none | `SystemInvariant.t.sol::invariant_usdgConserved` |
| R4 | NAV > 0 through moves and 25% gaps; a gap never loses more than the stress loss measured on the book; no buy leaves the book over the budget | `SystemInvariant.t.sol::invariant_poolSolventWithinCaps`, `::test_R4_fullBookGapWithinStressBudget` |
| R4 | A trader's USDG only leaves as a buy's returned cost (loss bounded by premium) | `SystemInvariant.t.sol::invariant_buyerLossBoundedByPremium` |
| R4 | Norm monotone; pool shares supply == holders; no Panic | `SystemInvariant.t.sol::invariant_normMonotone`, `::invariant_sharesSupplyMatchesHolders`, `::invariant_noPanics` |
| R4 (todo 10) | A sell on a fresh price never reverts, through every pause, sigma move and hedge post | `SystemInvariant.t.sol::invariant_sellsWorkWhenPriceFresh` |
| R5 | Gas table: buy, sell, accrueMany(50), deposit, claim, rebalance, nav, totalLiability | `SystemGas.t.sol::test_R5_gasTable` |

## Deployment and timers (todo 10)

| Rule | Property | Test (`test/system/`) |
|------|----------|------|
| R1 | The deploy script's code path deploys and wires every contract (fork profile over mocks, testnet profile with its own mocks), writes the app's deployment file, and the system trades | `DeploySystem.t.sol::test_R1_deployOnAnvilWorks_forkProfile`, `::test_R1_testnetProfileDeploysMocksAndTrades` |
| R2 | Deployer holds no role after handoff; admin = 48h timelock run by a Safe (a contract on forks); keeper, hedger, vol signer are three addresses; the guardian can only pause buys, shield and deposits | `DeploySystem.t.sol::test_R2_rolesWired`, `::test_R2_botsMustBeThreeDifferentAddresses`, `::test_R2_guardianCanOnlyPauseBuysShieldAndDeposits` |
| R3 | Post-deploy check passes on a fresh system and names each misconfiguration | `DeploySystem.t.sol::test_R3_postDeployCheckPassesOnFreshDeployment`, `::test_R3_fails_*` (19 cases) |
| R8 | Every time rule is deploy-time with a hard minimum (pool queue, deposit lock, fee period, vol validity and rate limit, split windows, timelock); fork and mainnet deploy full values | `Timers.t.sol::test_R8_*`, `DeploySystem.t.sol::test_R8_*` |
| R9 | Profiles: mainnet refuses any chain but 4663 and any Safe below 3-of-5; testnet only on 46630; fork/mainnet configs cannot shorten timers | `DeploySystem.t.sol::test_R9_*` |
| R5 | With `FORK_RPC_URL`: PriceGuard reads every launch name's real feed and Stock Token, S within 2% of the Uniswap v3 TWAP | `test/fork/Fork.t.sol::test_R5_forkFeedsReadable` (skipped without the variable) |

## Writer vaults (todo 19, phase 2; closed and unwired at launch)

| Rule | Property | Test (`test/vaults/`) |
|------|----------|------|
| R1 | A vault covers only its side and an out-of-the-money band, with exact collateral; pending deposits are not writable; slices shrink with funding and free collateral | `WriterVault.t.sol::test_R1_*` |
| R2 | A vault never loses more than its collateral | `VaultFuzz.t.sol::testFuzz_R2_*` |
| R3 | On a buyback or release the vault pays the intrinsic value of the covered slice at the trade's PriceGuard S (OTM pays nothing, partial is pro rata, queued-sell fills settle too); a failed payout becomes debt and is settled later | `WriterVault.t.sol::test_R3_*` |
| R4 | Epoch accounting; the epoch timer is deploy-time with a hard minimum; roll only after the epoch; withdrawals are never blocked | `WriterVault.t.sol::test_R4_*` |
| R5 | The vaults' share of funding and spread is conserved; hook checks; no hook = no change (the share is paid from pool cash only, no carry-forward: see SECURITY.md) | `WriterVault.t.sol::test_R5_*` |
| R6 | Closed by default; closing blocks deposits only; minimum deposit | `WriterVault.t.sol::test_R6_*` |
| R7 | Every bucket held in balances, coverage within supply, locked within collateral, stock conserved, no dangling approvals, no panics (deep 500x200) | `VaultInvariant.t.sol::invariant_R7_*`, `WriterVault.t.sol::test_R7_*` |
| 20c | A buyback report that runs out of gas reverts the sell; DeploySystem leaves vaults off unless flagged and `$LMNS` unwired (`LMNS_NOT_OFF`) | `EngineAccrue.t.sol::test_R20_buybackReportCannotBeSkippedWithTightGas`, `DeploySystem.t.sol::test_T19_*`, `::test_T20_lmnsOffByDefaultAndChecked` |

## $LMNS staking, fee tiers and burn (todo 20, phase 2; module off until the admin turns it on)

| Rule | Property | Test (`test/lmns/`) |
|------|----------|------|
| R1 | No token contract: the launchpad's $LMNS address is a deploy parameter, nothing mints it; unset or route-less = module off and no read reverts | `LmnsStaking.t.sol::test_R1_*`, `LmnsDeploy.t.sol::test_R1_noTokenNoDeploy`, `LmnsWaterfall.t.sol::test_R1_stakingUnsetOrRouteOffIsReserveOnly` |
| R2 | Unstake = request, deploy-time delay (14 days on fork and mainnet, hard minimum 5 minutes), complete or cancel; requested stakes are slashed pro rata too | `LmnsStaking.t.sol::test_R2_*`, `LmnsDeploy.t.sol::test_R2_*` |
| R3 | Loss order: Reserve, then staked $LMNS (TWAP value less slippage, capped by the stake), then LP NAV; only the pool can slash; a failing route returns 0 | `LmnsWaterfall.t.sol::test_R3_*`, `LmnsStaking.t.sol::test_R3_*` |
| R4 | Fee tiers lower the 3 bps fee (at most 50%) and the spread (at most 20%); the engine's read is gas-capped, clamped and defaults to no discount | `LmnsEngineTiers.t.sol::test_R4_*`, `::testFuzz_R4_discountNeverRaisesCost`, `LmnsStaking.t.sol::test_R4_*` |
| R5 | The stakers bucket streams per second to active stakes (same-block stake earns nothing, minimum stake age to claim, dust never overpays) | `LmnsStaking.t.sol::test_R5_*`, `::testFuzz_R5_owedNeverExceedsInflow` |
| R6 | The burn bucket buys and burns only with a TWAP source and route; otherwise it accumulates | `LmnsStaking.t.sol::test_R6_burnOnlyWithTwapElseAccumulates`, `::test_R5_R6_feeRouterBucketsReachStakingAndBurn` |
| R7 | Staked balances equal contract holdings (plus donations); shares add up; owed USDG never exceeds the balance or the inflow; no panics | `LmnsInvariant.t.sol::invariant_R7_*` |

Notes:
- `bookValue` staleness bound: each series is valued at its last touch; the keeper accrues every live series
  (`engine.liveSeries(stock)`) at least hourly, so NAV lags the exact liability by at most about one hour of price and
  vol moves; the NAV guard band (entries at the high edge, exits at the low edge) covers the first part of it.
- The stress test counts the pool's spot hedge only on names the engine has a book for (priced at the name's last
  refresh). The hedger hedges names with live options and unwinds the rest; the handler does the same.
