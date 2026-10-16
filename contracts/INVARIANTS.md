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
| R8 | Caps 3500 / 800 bps exposed (`capsFor`), admin only | `test/pool/WriterPool.t.sol::test_R8_capsExposedToEngine` |
| R9 | onSale / onFunding / pay engine only; pay raises cash from hedges, then the reserve share, else reverts Insolvent | `test/pool/WriterPool.t.sol::test_R9_engineOnly`, `::test_R9_payRaisesCashThenRevertsInsolvent` |
| R10 | Deposit then request + claim at an unchanged mark never returns more than deposited | `test/pool/PoolFuzz.t.sol::testFuzz_R10_navRoundTripNeverProfits`, `test/pool/WriterPool.t.sol::test_R10_navRoundTripNeverProfits` |
| R11 | Guardian can pause deposits only (not unpause, not params); claims and pay-outs keep working | `test/pool/WriterPool.t.sol::test_R11_guardianPausesDepositsOnly` |
| R12 | See section 3 (W1-W5) | `test/pool/PoolInvariant.t.sol` |
| R13 | Pool holds the spot hedge: HEDGER-only rebalance, TWAP-floored both ways, caller bound, fresh price, cash buffer, exact approvals cleared | `test/pool/WriterPool.t.sol::test_R13_poolHoldsSpotHedges`, `::test_R13_rebalanceIsTwapFlooredAndCallerBounded`, `::test_R13_rebalanceNeedsFreshPriceRouteAndCash`, `::test_R13_routeAndSyncAdminOnly` |
| - | Upgrades admin only; initializers locked; engine set once | `test/pool/WriterPool.t.sol::test_upgradeAdminOnlyAndInitLocked` |


## 5. Notes

- The stress book stores, per series, the value change in each scenario (S x 0.75, 0.9, 1.1, 1.25) from a full
  revaluation at the series' last touch, not a delta-gamma approximation: for Daily options a delta-gamma estimate of a
  25% gap overstates the loss about four times. The book is exact at the prices it was refreshed at and within 5% after
  a 0.5% move (`testFuzz_R4_stressWithin5PctAfterHalfPctMoves`); the keeper's hourly `accrueMany` refreshes it.
