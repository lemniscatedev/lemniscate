# Audit fixes live on mainnet (2026-11-01)

The timelock batch scheduled on 2026-10-29 executed on 2026-11-01 at block 103734846.

| Item | Value |
|---|---|
| Execute | block [103734846](https://robinhoodchain.blockscout.com/block/103734846), sent by the owner to the timelock |
| Timelock | `0x58C276f4A75602fCf722b0119Dc774466884A94E` |
| Engine proxy, new implementation | `0x1C1f41721fe49c8dee117B17De1006817C974687` -> `0x4cd274aA506E45616B1607c212696D01dBd825cF` |
| Pool proxy, new implementation | `0x67fF1306201bCbEBCBB749DcF0cb2686ec11B58A` -> `0x5983AB790ABa75c37AA7b8862686ad92BA16eF97` |
| Gas used | 89,851 |

Checks after the execute:
- Both proxies report the new implementation (ERC-1967 slot, read on chain).
- PostDeployCheck against live mainnet: `[PASS] every check`.
- Sourcify: both implementations and their seven linked libraries verified (`match`); every other contract unchanged.
