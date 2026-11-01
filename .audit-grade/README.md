# Audit history

| Date | Commit | Auditor | Grade | Report | Status |
|---|---|---|---|---|---|
| 2026-10-29 | `841251a` (deployed) | AI pre-audit, rubric v2 | 7.0 / 10 (weighted 8.3, capped: live deployment not yet compared) | [2026-10-29-audit.md](2026-10-29-audit.md) | M-1, M-2, L-1, L-2 fixed on the fix commit; upgrade executed through the 48 h timelock on 2026-11-01 ([live record](upgrade-live-2026-11-01.md)); live bytecode check 25/25 match ([output](live-bytecode-check-2026-10-29.txt)); mutation score 21/21 killed ([mutation-2026-10-29.md](mutation-2026-10-29.md)); Halmos: 2 properties proved ([halmos-2026-10-29.md](halmos-2026-10-29.md)) |

Tags on the public repo: `audit-2026-10-29-deployed` = the audited, deployed commit; `audit-2026-10-29-fixes` = the
commit with the fixes. PriceGuard's fixed source differs from the deployed PriceGuard. The engine and pool read only `twapSource` and
`tradeTwap`, which the live PriceGuard already has, so the live PriceGuard stays; both tags exist for that reason.

An AI audit grade is a pre-audit signal, not a substitute for a human audit before large deposits.
