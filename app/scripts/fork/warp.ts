// Moves the fork's clock (anvil evm_increaseTime + one block). Fork only.
//   bun scripts/fork/warp.ts --hours 72          e.g. past the Writer Pool withdrawal queue
//   bun scripts/fork/warp.ts --next-regular      to the next weekday 10:00 New York time (buys need an open session)
// The vol-engine re-posts within a minute or two after a warp (VOL_CLOCK=chain); until then buys read "vol stale".
import { forkClients, nextNy } from "./lib";

const { pub, test } = forkClients();
if ((await pub.getChainId()) !== 31337) throw new Error("warp: not the anvil fork (31337); refusing");
const now = Number((await pub.getBlock()).timestamp);
let target = now;
const i = process.argv.indexOf("--hours");
if (i >= 0) target = now + Math.round(Number(process.argv[i + 1]) * 3600);
else if (process.argv.includes("--next-regular")) target = Math.min(...[1, 2, 3, 4, 5].map((d) => nextNy(now, d, 10, 0)));
else throw new Error("usage: bun scripts/fork/warp.ts --hours N | --next-regular");
await test.increaseTime({ seconds: target - now });
await test.mine({ blocks: 1 });
console.log(`warp: ${new Date(now * 1000).toISOString()} -> ${new Date(Number((await pub.getBlock()).timestamp) * 1000).toISOString()}`);
