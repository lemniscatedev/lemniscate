# Changelog

Plain-English notes for every Lemniscate update, newest first. Each entry links to the commit that shipped it.

## Security fixes: audit 2026-10-29 (M-1, M-2, L-1, L-2)

2026-10-29 (UTC)

An external pre-audit of commit `841251a` found two Medium and two Low issues in the contracts; nothing Critical or High.
All four are fixed with failing-then-passing tests (`contracts/test/audit/`). Buys at the exact quote now succeed (M-1);
the worse-of trade price can no longer be erased, and sells wait in escrow instead of using a stale price when it cannot
be read (M-2); LP claims no longer revert when only the Reserve keeps the pool positive (L-1); a claim's hedge-sale
shortfall is charged at the same price the claim was valued at (L-2). The fixes reach mainnet through the 48-hour
timelock; until then the deployed contracts are unchanged. Details: `.audit-grade/2026-10-29-audit.md`.

## Mainnet deployment

2026-10-29 (UTC)

Lemniscate deployed on Robinhood Chain mainnet (4663) at block 101,047,770. Every contract and library is source-verified
on Sourcify (exact match). Every admin action goes through a 48-hour timelock. Addresses: `app/deployments/4663.json` and
the README.
