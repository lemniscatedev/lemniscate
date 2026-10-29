# Incident runbook

What to do when something is wrong with a live deployment. It names the levers that exist on chain, who can pull each one, how fast it takes
effect, and what users can still do. The on-chain facts here are checked against the contracts; see [SECURITY.md](SECURITY.md) for the roles and
the list of every privileged function. Nothing here needs a code change to use.

Placeholders: `<engine>`, `<pool>`, `<priceGuard>`, `<paymaster>` are the addresses in the deployment file
(`contracts/deployments/<profile>.json`, or the table in the README after launch). `<rpc>` is the chain RPC.

## Step 0: decide in five minutes

1. Is money at risk right now (a wrong price, a drained pool, a compromised key)? If yes, pause buys first (below), then investigate.
2. Is it only the website or API (down, wrong data)? The contracts are unaffected and permissionless: go to "Users can always exit".
3. Write down the time, what was seen, and who saw it. Keep every log; do not restart services before copying
   `journalctl -u 'lemniscate-*' --since '2 hours ago'` somewhere safe.

## Who signs what

| Action | Signer | Speed |
| --- | --- | --- |
| Pause buys (global, one series, one name) and pause pool deposits | Guardian (the guardian hot wallet; the keeper's risk monitor also pauses automatically) | Immediate |
| Pause the paymaster (sponsored gas) | Paymaster owner (the owner EOA, directly, no timelock) | Immediate |
| Stop a service (keeper, hedger, vol engine, API) | Server operator, `systemctl stop lemniscate-<service>` | Immediate |
| Unpause anything, change a parameter, rotate the vol signer, upgrade | Admin: the 48 hour timelock, run by the owner EOA (SECURITY.md, Owner model) | 48 hours after scheduling |
| Revoke a keeper or hedger role, grant a new one | Admin (same timelock path) | 48 hours |

Unpausing and every parameter change wait out the 48 hour timelock. Plan for that: a pause costs at least two days of lost buys. Pausing is
cheap to do and slow to undo on purpose, so pause when in doubt about a price or a key, and do not pause for a cosmetic problem.

## Pause

All of these are Guardian calls (`cast send ... --account <guardian keystore>`):

```sh
# every new buy and Shield
cast send <engine> "setBuysPaused(bool)" true --rpc-url <rpc> --account <guardian>
# one series
cast send <engine> "setSeriesBuysPaused(bytes32,bool)" <seriesId> true --rpc-url <rpc> --account <guardian>
# one name (the price guard)
cast send <priceGuard> "setBuysPaused(address,bool)" <stockToken> true --rpc-url <rpc> --account <guardian>
# new pool deposits
cast send <pool> "setDepositsPaused(bool)" true --rpc-url <rpc> --account <guardian>
```

Sells, queued-sell fills, withdrawal requests and claims are never paused by any of these. If the sponsored-gas paymaster misbehaves,
its owner calls `setPaused(true)` (users fall back to plain transactions).

Check it took effect: `cast call <engine> "flags()(bool,bool,bool,bool)"` (global pause, stress pause, drawdown pause, upgrades frozen) and `seriesBuysPaused(bytes32)`, and the API's `/v1/pool` pauses block.

## Stop what could make it worse

- Wrong or stale vol: `systemctl stop lemniscate-vol-engine`. Posts expire after 2 hours; after that buys are blocked and sells price at sigma x 1.2.
- Hedger misbehaving: `systemctl stop lemniscate-hedger` (it holds gas only; the pool holds the hedges). Hedge equity goes stale after 2 hours and pauses buys.
- Keeper misbehaving: `systemctl stop lemniscate-keeper`. Accrual, listing and the queued-sell and fee jobs stop; every one of them is
  also callable by anyone, so nothing is stuck.
- Website gate (closed beta only): `DATABASE_URL=... bun run scripts/invites/switch.ts on|off|status` sets the invite requirement without a restart. It
  controls who our website and API will build buy calldata for. It does not stop on-chain buys; only a pause does.

## Key compromise

### Timelock and owner alerts (keeper job `admin-watch`)

| Alert | Means | First action |
| --- | --- | --- |
| `ALERT: an admin action was scheduled on the timelock: ...` | Someone holding the owner key scheduled an admin call; it can run 48 hours later | Confirm with the owner that it is theirs and was announced. If not: owner key compromise (below) |
| `ALERT: a timelocked admin action was executed: ...` | A scheduled call ran | Check it is the call announced 48 hours earlier |
| `ALERT: a scheduled admin action was cancelled ...` | A scheduled call was withdrawn | Expected only when the owner withdraws its own call |
| `ALERT: the timelock delay changed ...` | The delay itself was changed through the timelock | Check the new value is at least 48 hours; otherwise treat as a compromise |
| `ALERT: the protocol owner address ... now has ...` | The owner key signed an EIP-7702 delegation or code appeared at it; whoever controls that code can act as the owner | Owner key compromise (below). Repeats hourly until `RESOLVED` |

| Key | First action | Then |
| --- | --- | --- |
| Vol signer | Stop the vol engine | Admin schedules `setSigner(new)` on the vol oracle (48h); until then the oracle's bounds (step, floor, rate, expiry) cap the damage and the guardian can pause buys |
| Keeper | Stop the keeper; pause buys if listings or sessions look wrong | Admin revokes `KEEPER_ROLE` and grants a new key (48h). The keeper cannot move funds or change parameters |
| Hedger | Stop the hedger | Admin revokes `HEDGER_ROLE` (48h). It can only post hedge equity and rebalance inside the pool's TWAP floor and slippage bound |
| Guardian hot wallet | Admin revokes its `GUARDIAN_ROLE` and grants a new key (48h); meanwhile the keeper's risk monitor still pauses | A guardian key cannot unpause or change parameters |
| Paymaster signer | Paymaster owner calls `setPaused(true)` then `setSigner(new)` | Sponsored gas only; no user funds |
| An owner wallet (a user) | Nothing on our side can move it | Tell the user to revoke the agent key in AgentRouter (`revoke(agent)`) and move funds |
| A Safe | Treat as a full compromise: pause everything you can, announce, and move to a new Safe through the timelock | |
| Timelock owner EOA (the keeper's `admin-watch` alerts on every scheduled call and on code at the owner) | Treat as a full compromise: the guardian pauses buys and deposits, announce, and tell users to exit (sells, withdrawals and claims stay open) | Watch the timelock for `CallScheduled`; while the key is still held, cancel every call you did not schedule, and schedule moving the proposer, executor and canceller roles to a new owner (48h). The same key owns the paymaster directly: pause it and withdraw its ETH first |

Never paste a key, keystore or password into a chat, ticket or log. Keystores live only under `/etc/lemniscate/keys` on the server and each
is readable by one service user.

## Users can always exit

State this plainly in every announcement. Whatever is paused:

- **Sell** any option: `engine.sell(...)` is permissionless and never paused. If the oracle is stale or the market is halted, the sell queues and
  is filled at the first fresh price (`fillQueued`, callable by anyone); the seller can `cancelQueued`.
- **Pool depositors:** `requestWithdraw(shares)` is never paused; it is paid at NAV after the 72 hour queue by `claim(ticket)`, pro rata if cash
  is short.
- **If the website or API is down:** the contracts need no API. Anyone can call the engine and pool from any wallet or script with the ABIs in
  `app/src/abi`. Publish the exact `cast send` commands in the announcement.
- Funds are never held by the keeper, hedger or vol signer.

## Communications

1. Within the first hour: post a short, factual status (what is paused, what still works, when the next update is). No blame, no cause guesses.
2. Use the project's public channels and the website banner. Only the people named by the team post. Do not DM users first; scammers do,
   so say so in the post.
3. Update at least every few hours while paused. Say when the timelock for the unpause was scheduled and when it can run.
4. After: a written post-mortem within a week (timeline, cause, what changed, what users lost if anything).

## Recovering

1. Fix the cause and show the fix with a test that failed before and passes now.
2. Admin schedules the unpause (and any parameter or role change) through the timelock; announce the earliest execution time.
3. Re-run `PostDeployCheck.s.sol` against the live deployment and `script/verify-deployment.sh check`.
4. Unpause in the smallest scope first (one name, then the rest), watch the risk monitor and the pool NAV, then widen.
5. File the post-mortem; add the missing check to `docs`, CI or the monitor so it cannot recur silently.
