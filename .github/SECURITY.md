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

## Audit history

None yet. Internal review, fuzzing, stateful invariants and mutation tests are documented in [contracts/INVARIANTS.md](../contracts/INVARIANTS.md).
This section will list each external audit, its date and its report once one exists.
