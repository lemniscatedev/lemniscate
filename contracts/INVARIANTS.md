# Invariants and properties

Every protocol invariant and per-function property, with the test that checks it (`path::function`, paths relative
to `contracts/`). Stateful invariants run the real `LemniscateEngine` and `WriterPool` behind ERC1967 proxies, two
hedged markets, and the real `UniswapV3HedgeAdapter` over a constant-product router.

How to run:

| What | Command |
|------|---------|
| Everything (fast defaults: fuzz 256 runs, invariants 50 x 20) | `forge test` |
| Deep stateful run (500 runs x 200 calls = 100k calls, fuzz 5,000) | `FOUNDRY_PROFILE=deep forge test --match-contract SystemInvariantTest` |
| Revert-reason histogram for the handler | `INVARIANT_REVERT_STATS=true forge test --match-contract SystemInvariantTest -vv` |
| Coverage | `forge coverage --ir-minimum --report summary --no-match-coverage "(test\|lib\|script)/"` |
| Mutation testing | `python3 script/mutation/mutate.py` (see `script/mutation/README.md`) |

## 1. System invariants (stateful, engine + vault)

Handler: `test/invariant/SystemHandler.sol` (buys, sells, same-block round trips, LP deposit / withdraw / redeem /
share transfer, keeper rebalance and base-carry updates, accrueAll, feed moves of at most ±10%, pool repricing
within ±3% of the feed, market open/closed, stock oracle pause, time warps with or without feed heartbeats).
Legitimate reverts are re-thrown so Foundry's revert table is meaningful; Panics are recorded instead and fail
`invariant_noPanicsAndTreasuryMonotone`.

Last deep run (`FOUNDRY_PROFILE=deep`): 500 runs x 200 depth = 100,000 handler calls, 12,307 reverts (12.3%), all
13 invariants held, 208 s. The reverts are guards being exercised: buy 19% / roundTrip 19% (paused regime,
off-hours staleness, caps), sell 6% (paused-sell budget), rebalance 36% (paused regime, pool off the oracle by more
than the slippage limit), setBaseCarry 24% (once-per-day cadence probes), withdraw 42% / redeem 39% (deposit locks
and LP-exit gating by the liability reserve, including deliberate probes of locked accounts). Every other action
reverted 0 times.

| # | Invariant | Test |
|---|-----------|------|
| S1 | OptionToken `totalSupply` == `getState(id).vaultShort` for every market | `test/invariant/SystemInvariant.t.sol::invariant_powerSupplyEqualsVaultShort`, `test/LemniscateEngine.t.sol::invariantOptionTokenSupplyMatchesVaultShort` |
| S2 | `vault.hedgeUnits(id)` <= `stock.balanceOf(vault)` (no phantom hedge) | `test/invariant/SystemInvariant.t.sol::invariant_hedgeUnitsBackedByStock` |
| S3 | `navView()` == USDG cash + Σ hedgeUnits·regime spot − Σ vaultShort·normFactor·index (liability recomputed independently) | `test/invariant/SystemInvariant.t.sol::invariant_navMatchesIndependentRecomputation` |
| S4 | `navLow <= nav <= navHigh` | `test/invariant/SystemInvariant.t.sol::invariant_navBandBracketsNav` |
| S5 | A buy followed by a sell of the same tokens at the same mark never returns more USDG than was paid | `test/invariant/SystemInvariant.t.sol::invariant_noRoundTripProfit` |
| S6 | Another LP's deposit / withdraw / redeem at an unchanged mark never lowers NAV per share (tolerance 1 wei + 1e-12 relative, ERC-4626 virtual-share rounding; observed max drop 3e-14 relative) | `test/invariant/SystemInvariant.t.sol::invariant_lpOperationsDoNotDiluteSharePrice` |
| S7 | Shares of an account inside its deposit lock never move (transfer, withdraw, redeem) | `test/invariant/SystemInvariant.t.sol::invariant_lockedSharesNeverMove` |
| S8 | USDG is conserved: Σ(actors, vault, treasury, routers) == totalSupply == minted; engine and adapters hold none | `test/invariant/SystemInvariant.t.sol::invariant_usdgConserved` |
| S9 | LWP totalSupply == Σ LP balances | `test/invariant/SystemInvariant.t.sol::invariant_writerPoolSupplyMatchesHolders` |
| S10 | Stored and projected normFactor ∈ [1e12, 1e18], projection <= stored, stored never increases | `test/invariant/SystemInvariant.t.sol::invariant_normFactorBoundedAndMonotone` |
| S11 | `lastUtilBps <= 10_000`; paused-sell bucket level <= cap | `test/invariant/SystemInvariant.t.sol::invariant_storedStateBounded` |
| S12 | No allowance left from the vault to an adapter or from an adapter to its router | `test/invariant/SystemInvariant.t.sol::invariant_noDanglingApprovals` |
| S13 | No action ever hits a Panic (overflow, division by zero, enum); treasury balance never decreases | `test/invariant/SystemInvariant.t.sol::invariant_noPanicsAndTreasuryMonotone` |

## 2. LemniscateEngine pricing, fees, carry

| # | Property | Test |
|---|----------|------|
| P1 | Buy price ∈ [fair·(1+spread), fair·(1+band)] for the regime | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_buyPriceWithinSpreadAndBand` |
| P2 | Sell price ∈ [fair·(1−band), fair·(1−spread)], paused band 3% | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_sellPriceWithinSpreadAndBand` |
| P3 | Larger buys never get a lower unit price; tokensOut is monotone up to one 1-bps impact step | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_buyQuoteMonotone` |
| P4 | Larger sells never get a higher unit price; usdgOut monotone up to one 1-bps step | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_sellQuoteMonotone` |
| P5 | (Documented edge) tokensOut dips by < 1 bps when one more wei crosses an impact bps step | `test/fuzz/EnginePricingFuzz.t.sol::testBuyTokensOutDipsAtImpactStep` |
| P6 | Buy fee = ceil(usdgIn·feeBps), tokens round down, execution == quote, treasury cut == fee·share | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_buyFeeAndRoundingFavourProtocol` |
| P7 | Sell gross rounds down, fee rounds up, payout == gross − fee == quote | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_sellFeeAndRoundingFavourProtocol` |
| P8 | Same-block buy→sell never profits (any prior book, open or off-hours) | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_roundTripNeverProfits` |
| P9 | normFactor projection = nf·(1 − carry·min(t, 7d)/1d), floored at 1e12, non-increasing in t; stored accrual equals the view | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_normFactorProjection`, `::testNormFactorFloorsJustBelowFullDecay`, `test/LemniscateEngine.t.sol::testCarryAccrualViewMatchesStoredAccrualForOneDay`, `test/LemniscateEngine.t.sol::testFirstBuyAfterLongIdleAccruesAndSubsequentPositionStillDecays` |
| P10 | Open carry = base + skew·util clamped to [minCarry, maxCarry]; stored utilization clamped at 100% even when a rally pushes liability past capacity; off-hours/paused use offHoursCarry | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_openCarryClamped`, `test/EdgeCases.t.sol::testUtilizationClampsAfterRallyPastCapacity`, `test/LemniscateEngine.t.sol::testCarryUsesRegimeUtilizationClampAndSingleLinearDay` |
| P11 | Paused mark = newer live round only if lower than last good and above ¼ of the last good index (a ≥50% spot drop is a transient); never above last good | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_pausedMarkRule`, `test/LemniscateEnginePricing.t.sol::testPausedSellUsesNewerLowerFeedRoundOverStaleAccruedIndex`, `::testPausedMarkIgnoresNewerHigherRound`, `::testPausedMarkIgnoresCorporateActionSizedDrop`, `::testPausedMarkIgnoresOlderRound` |
| P12 | Leaky-bucket paused-sell budget: over any interval [ti, tj] sells total <= cap·(1 + (tj−ti)/1h); < 2·cap within any interval shorter than the window; level <= cap | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_pausedSellBudget`, `test/LemniscateEnginePricing.t.sol::testPausedSellBudgetCannotBeDoubledAcrossHourBoundary`, `test/LemniscateEngine.t.sol::testPausedSellCapIsTimeWindowedNotBlockWindowed` |
| P13 | Buying `maxUsdgIn` fits the caps up to < 1 bps (buy succeeds, or a 2-bps-smaller buy does); caps always hold after a buy | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_maxUsdgInFitsCaps`, `::testMaxUsdgInCanOvershootMarketCapByUnderOneBps` |
| P14 | `grossInputForRoom` output's post-fee notional at its own floored-impact price fits the room within 1 bps | `test/fuzz/EnginePricingFuzz.t.sol::testFuzz_grossInputForRoomFits`, `test/EdgeCases.t.sol::testGrossInputForRoomEdges` |
| P15 | Market and global exposure caps enforced on buys; no capacity at NAV <= 0 | `test/LemniscateEngine.t.sol::testMarketAndGlobalExposureCaps`, `test/EdgeCases.t.sol::testEmptyVaultHasNoBuyCapacity`, `::testInsolventVaultClosesEntriesAndExits` |
| P16 | Regimes: open / off-hours / stale→paused / calendar failure / sequencer down + grace / reverting views | `test/LemniscateEngine.t.sol::testRegimeOpenOffHoursStalePausedAndCalendarFailure`, `::testSequencerDownAndGracePeriodPauseMarket`, `test/EdgeCases.t.sol::testRevertingStockViewsAndSequencerPauseTheMarket` |
| P17 | Off-hours buys close once the feed round is older than `offHoursBuyMaxAge`; sells stay open | `test/LemniscateEnginePricing.t.sol::testOffHoursBuysCloseOnceFeedIsStale`, `::testWeekendHeldCloseCannotBeBoughtBeforeGap` |
| P18 | Buy pauses (market, global, stock transfer pause) never block sells | `test/LemniscateEngine.t.sol::testGuardianBuyPauseDoesNotChangeRegimeOrRestrictHolderSell`, `::testGlobalBuyPauseStillAllowsHolderSell`, `::testStockTransferPauseBlocksBuysButNotSells` |
| P19 | Only the selling holder's tokens are burned; only the engine mints/burns | `test/LemniscateEngine.t.sol::testOnlySellingHolderCanBurnThroughEngine`, `test/OptionToken.t.sol::testOnlyEngineCanMintAndBurn` |
| P20 | Trade guards: deadline, zero recipient, min/max trade, slippage, vaultShort bound, unknown market | `test/AccessAndBounds.t.sol::testTradeGuards`, `test/LemniscateEngine.t.sol::testBuyBoundsDeadlineAndSlippage` |
| P21 | Base carry moves at most 25% once per 24 h inside its bounds (from zero, measured against the upper bound) | `test/AccessAndBounds.t.sol::testSetBaseCarryBoundsCadenceAndStep`, `test/LemniscateEngine.t.sol::testBaseCarryIsOneBoundedStepPerTwentyFourHours`, `::testBaseCarryCanLeaveZero` |

## 3. WriterPool

| # | Property | Test |
|---|----------|------|
| V1 | Deposit→redeem at the same mark never profits (any book state, hedged or not) | `test/fuzz/VaultRoundingFuzz.t.sol::testFuzz_depositRedeemRoundTripNeverProfits` |
| V2 | Mint→withdraw at the same mark burns at least the shares minted per asset | `test/fuzz/VaultRoundingFuzz.t.sol::testFuzz_mintWithdrawRoundTripNeverProfits` |
| V3 | Previews round toward the vault: entry at navHigh, exit at navLow, convertTo* between them | `test/fuzz/VaultRoundingFuzz.t.sol::testFuzz_previewsRoundTowardVault` |
| V4 | Another LP's entry and exit never dilute an existing LP | `test/fuzz/VaultRoundingFuzz.t.sol::testFuzz_otherLpFlowsDoNotDilute` |
| V5 | First-depositor inflation donation cannot capture a victim deposit | `test/WriterPool.t.sol::testInflationDonationDoesNotLetFirstDepositorCaptureVictimDeposit` |
| V6 | NAV guard band neutralizes feed-update front-running; fully hedged pays only gamma; closed move off-hours | `test/WriterPool.t.sol::testNavGuardNeutralizesDepositorFrontRunningOfFeedUpdate`, `::testWithoutNavGuardTheSameFrontRunProfits`, `::testNavGuardChargesOnlyGammaWhenFullyHedged`, `::testNavGuardUsesClosedMoveOffHoursAndIsAdminBounded` |
| V7 | Locks: self-receiver only; locked shares cannot move or be dusted; zero-asset exit still checks the lock; lock ends exactly at `lastDeposit + lockSeconds` | `test/WriterPool.t.sol::testSelfReceiverRulePreventsThirdPartyDepositFromResettingLock`, `::testLockedSharesCannotBeTransferredEvenToAnEmptyAccount`, `::testLockedSharesCannotDustAnExistingHolder`, `test/AccessAndBounds.t.sol::testDepositRulesAndLockBoundaries`, `test/EdgeCases.t.sol::testThirdPartyExitSpendsAllowanceAndZeroWithdrawHonoursLock` |
| V8 | LP exits stay inside NAV − liability / maxGlobalExposure, rechecked after a cash raise | `test/WriterPool.t.sol::testWithdrawAndRedeemStayInsideLiabilityReserve`, `::testWithdrawalRechecksReserveAfterCashRaiseChangesLiability`, `test/VaultCashRaise.t.sol::testLpExitsAreGatedByPowerBookUtilization` |
| V9 | Forced hedge sales charge the execution shortfall to the caller (seller or redeemer); sandwiches lose; LPs do not | `test/EdgeCases.t.sol::testRedeemChargesHedgeSaleShortfallToRedeemer`, `test/VaultCashRaise.t.sol::testOpenMarketSandwichLosesAndLpsLoseNothing`, `::testOffHoursLpRedeemSandwichWithTwapFloor`, `::testOffHoursSandwichWithTwapFloorIsBoundedBySlippage` |
| V10 | TWAP floor on forced sales: thin pool reverts instead of dumping; reverting reference falls back to the oracle | `test/VaultCashRaise.t.sol::testOffHoursLargeRedeemInThinPoolRevertsInsteadOfDumping`, `::testOffHoursRedeemRevertsWhenPoolIsBelowHeldClose`, `::testRevertingPriceReferenceFallsBackToOracle` |
| V11 | Swap results are checked by balance deltas: under-pull, short delivery, or a reverting route are rejected / skipped | `test/EdgeCases.t.sol::testSwapDeltaChecksRejectMisbehavingAdapters`, `test/WriterPool.t.sol::testPaySkipsFailingHedgeRouteAndUsesAnotherMarket`, `::testPayRaisesCashFromHedgeAndRevertsWhenHedgeCannotCoverPayment` |
| V12 | Rebalance tracks actual stock delta, resets approvals, skips dust, needs a route, rejects paused regimes, respects the cash buffer | `test/WriterPool.t.sol::testRebalanceTracksActualStockDeltaAndResetsApprovals`, `::testRebalanceRejectsPausedRegime`, `test/EdgeCases.t.sol::testRebalanceSkipsDustAndRequiresRoute`, `::testRebalanceBuyLimitedByCashBuffer` |
| V13 | Paused markets are valued at the last good price | `test/WriterPool.t.sol::testNavUsesLastGoodPriceWhilePausedEvenWhenSpotRoundIsValid` |
| V14 | Insolvent book: share price 0, deposits and exits closed, utilization clamped | `test/EdgeCases.t.sol::testInsolventVaultClosesEntriesAndExits` |
| V15 | Deposit and mint caps | `test/EdgeCases.t.sol::testDepositCapAndMintCap`, `test/WriterPool.t.sol::testBootstrapDepositUsesTwelveDecimalsAndMaxMintRoundsDown` |

## 4. Access control, bounds, upgrades

| # | Property | Test |
|---|----------|------|
| A1 | Initializers cannot be re-run on proxies; implementations are locked | `test/AccessAndBounds.t.sol::testInitializersCannotBeRerunOnProxies`, `::testImplementationsAreLocked` |
| A2 | Initializers reject zero addresses | `test/AccessAndBounds.t.sol::testInitializersRejectZeroAddresses` |
| A3 | `_authorizeUpgrade` is admin-only (keeper/guardian/stranger rejected) and state survives an upgrade | `test/AccessAndBounds.t.sol::testUpgradesAreAdminOnlyAndPreserveState`, `test/MarketHours.t.sol::testOnlyAdminCanUpgrade`, `test/AccessAndBounds.t.sol::testMarketHoursBoundsAtAndBeyondLimits` |
| A4 | Engine admin setters (listMarket, setMarketConfig, setGlobal) reject non-admins | `test/AccessAndBounds.t.sol::testEngineAdminSettersRejectStrangers` |
| A5 | Keeper/guardian setters reject others, including the admin | `test/AccessAndBounds.t.sol::testEngineKeeperAndGuardianSettersRejectOthers`, `::testGuardianPausesAreIdempotentAndCheckMarket` |
| A6 | `setGlobal` bounds: exposure ∈ [1,000, 10,000], fee share <= 5,000, treasury ≠ 0 | `test/AccessAndBounds.t.sol::testSetGlobalBoundsAtAndBeyondLimits`, `test/LemniscateEnginePricing.t.sol::testGlobalSettersAreBounded` |
| A7 | Every MarketConfig bound accepts its limit and rejects the next value (20 bounds) | `test/AccessAndBounds.t.sol::testMarketConfigBoundsAtAndBeyondLimits` |
| A8 | Identity fields immutable; kind/feed2 rejected; base carry must stay in new bounds | `test/AccessAndBounds.t.sol::testMarketConfigRejectsIdentityChangesAndUnsupportedKinds` |
| A9 | Listing: no preset token, one market per stock, carry in bounds, 8-decimal feed, 18-decimal stock, valid round, ≤ 255 markets | `test/AccessAndBounds.t.sol::testListMarketValidation`, `::testMarketCountIsCappedAt255`, `test/LemniscateEngine.t.sol::testListingRejectsDuplicateStockAndOversizedPausedSpread` |
| A10 | Vault admin/keeper setters reject others; keeper is not admin | `test/AccessAndBounds.t.sol::testVaultAdminSettersRejectStrangers` |
| A11 | Vault bounds: lock ≤ 30 d, cash buffer ≤ 5,000, hedge ratio ≤ 15,000, threshold ≤ 10,000, slippage ≤ 500, nav guard ≤ 2,000 | `test/AccessAndBounds.t.sol::testVaultParamBoundsAtAndBeyondLimits`, `test/WriterPool.t.sol::testLockDurationIsBounded` |
| A12 | Hedge route and sync validation; price reference must be a contract | `test/AccessAndBounds.t.sol::testHedgeRouteAndSyncValidation`, `test/VaultCashRaise.t.sol::testPriceReferenceIsAdminOnlyAndMustBeAContract` |
| A13 | `pay` is engine-only and rejects a zero recipient | `test/AccessAndBounds.t.sol::testPayIsEngineOnlyAndRejectsZeroRecipient` |
| A14 | MarketHours: keeper-only; ≤ 32 sessions; length ≤ 5 d 1 h; horizon ≤ 30 d; sorted, non-overlapping, back-to-back allowed; half-open intervals | `test/AccessAndBounds.t.sol::testMarketHoursBoundsAtAndBeyondLimits`, `test/MarketHours.t.sol::testIsOpenUsesInclusiveOpenAndExclusiveClose`, `::testRejectsInvalidAndUnsortedSessions`, `::testRejectsOverlappingSessions`, `::testRejectsSessionsLongerThanFiveDaysAndOneHour`, `::testRejectsMoreThanThirtyTwoSessions`, `::testRejectsSessionsMoreThanThirtyDaysAhead` |

## 5. Periphery

| # | Property | Test |
|---|----------|------|
| X1 | TWAP tick→price matches high-precision values, monotone in tick, both token orders, rounds negative ticks down, 0 when unavailable or out of range | `test/UniswapV3TwapReference.t.sol::testPriceAtTickMatchesHighPrecisionValues`, `::testFuzzPriceIsMonotonicInTick`, `::testStockAsToken0`, `::testStockAsToken1`, `::testNegativeMeanTickRoundsDown`, `::testUnavailablePoolOrWindowReturnsZero`, `test/EdgeCases.t.sol::testTwapReferenceOutOfRangeTicks` |
| X2 | Adapter pulls caller funds, resets router approval, validates inputs | `test/WriterPool.t.sol::testAdapterPullsCallerFundsAndResetsRouterApproval`, `test/EdgeCases.t.sol::testOptionTokenAndAdapterConstructorsAndSwapValidation` |
| X3 | LemniscateLens reports exactly the engine/vault values | `test/EdgeCases.t.sol::testLensMatchesEngineAndVault` |
| X4 | LemniscateMath rounding and guards | `test/EdgeCases.t.sol::testLemniscateMath` |

## 6. Findings surfaced by these tests

| # | Finding | Test |
|---|---------|------|
| F1 | **Fixed.** Exact-assets `withdraw` reverted whenever it needed a forced hedge sale that filled below oracle value: the cash raise stopped at `cash + shortfall >= assets` but the full `assets` were then transferred. Exact-assets withdraws now raise the full amount in cash (sales grossed up by the slippage allowance) and charge the shortfall in extra shares. | `test/EdgeCases.t.sol::testExactAssetWithdrawNeedingCashRaiseChargesExtraShares`; `test/invariant/SystemInvariant.t.sol::invariant_noPanicsAndTreasuryMonotone` requires `withdrawCashShortReverts == 0` |
| F4 | **Fixed.** Share conversions floored NAV to whole USDG units in every direction, so a deposit could dilute other LPs by up to one USDG unit (about 1e-6 USD). NAV is now rounded against the caller: up when pricing shares or assets received by the vault, down when pricing what leaves it. | `test/fuzz/VaultRoundingFuzz.t.sol::testFuzz_otherLpFlowsDoNotDilute` |
| F2 | `quoteBuy`'s `maxUsdgIn` can exceed the exposure cap by < 1 bps: `grossInputForRoom` models impact as continuous while the engine floors it to whole bps, so buying exactly `maxUsdgIn` can revert `MarketCapExceeded`. Frontends should shade it by 1–2 bps. | `test/fuzz/EnginePricingFuzz.t.sol::testMaxUsdgInCanOvershootMarketCapByUnderOneBps`, `::testFuzz_maxUsdgInFitsCaps` |
| F3 | Tokens out are not strictly monotone in input: one more wei across an impact bps step can buy < 1 bps fewer tokens. No value leak (unit price is monotone). | `test/fuzz/EnginePricingFuzz.t.sol::testBuyTokensOutDipsAtImpactStep` |

## 7. Mutation testing

`script/mutation/mutants.txt` holds 30 hand-picked mutants (dropped guards, flipped comparisons, changed rounding,
wrong pricing edge) across LemniscateEngine, WriterPool and MarketHours; `script/mutation/mutate.py` applies each, runs
`forge test --fail-fast`, and restores the source. Last run: 30/30 killed (100%). Before the edge tests in
`test/EdgeCases.t.sol` were added the suite killed 27/30; the survivors (normFactor floor, utilization clamp,
withdraw shortfall charge) each got a targeted test, and the third one led to finding F1.
