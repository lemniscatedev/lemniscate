// Warm the fork right after anvil starts (crypto-local-testing section 1): the free public RPC prunes state older than
// ~15 minutes, so every piece of MUTABLE mainnet state the run will read (tokens, feeds, Uniswap pools including the
// ticks a hedge swap crosses, the USDG/stock holders) is read now, through anvil, and lands in the rpc cache and in
// anvil's own state. Slots read later fall back to latest state in the rpc cache (see rpc-cache.ts).
//
//   bun scripts/fork/warm.ts <deploy-config.json>
import { readFileSync } from "node:fs";
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { DEFAULT_USDG_HOLDER } from "./fund";
import { forkClients } from "./lib";

interface Cfg { usdg: string; uniswapV3Factory: string; swapRouter: string; stocks: { name: string; stock: string; feed: string; uniPool: string; poolFee: number }[] }

const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)",
  "function uiMultiplier() view returns (uint256)", "function newUIMultiplier() view returns (uint256)", "function effectiveAt() view returns (uint256)",
  "function oraclePaused() view returns (bool)", "function paused() view returns (bool)", "function isBlocked(address) view returns (bool)",
  "function isFrozen(address) view returns (bool)", "function transfer(address,uint256) returns (bool)", "function uid() view returns (bytes32)",
]);
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)",
  "function aggregator() view returns (address)", "function description() view returns (string)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)", "function liquidity() view returns (uint128)",
  "function observe(uint32[]) view returns (int56[],uint160[])", "function token0() view returns (address)", "function token1() view returns (address)",
  "function fee() view returns (uint24)", "function tickSpacing() view returns (int24)",
  "function swap(address,bool,int256,uint160,bytes) returns (int256,int256)",
]);
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const CODE_ONLY: Address[] = [
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032", // EntryPoint v0.7
  "0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C", // SenderCreator v0.7
  "0x2577507b78c2008Ff367261CB6285d44ba5eF2E9", // Kernel factory v3.3
  "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28", // Kernel v3.3
  "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57", // Kernel ECDSA validator
  "0x000000000022D473030F116dDEE9F6B43aC78BA3", // Permit2
  "0xcA11bde05977b3631167028862bE2a173976CA11", // Multicall3
  "0x4e59b44847b379578588920cA78FbF26c0B4956C", // CREATE2 deployer
];
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273184927183819136990092193n;

async function main(configPath: string) {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as Cfg;
  const { pub } = forkClients();
  const started = Date.now();
  const holder = DEFAULT_USDG_HOLDER;
  const soft = async (p: Promise<unknown>) => { try { await p; } catch { /* reverts are expected (swap callbacks) */ } };
  const usdg = getAddress(cfg.usdg);
  await Promise.all(CODE_ONLY.map((a) => pub.getCode({ address: a })));
  await Promise.all([pub.getCode({ address: getAddress(cfg.swapRouter) }), pub.getCode({ address: getAddress(cfg.uniswapV3Factory) })]);
  for (const fn of ["totalSupply", "decimals", "paused"] as const) await soft(pub.readContract({ address: usdg, abi: tokenAbi, functionName: fn }));
  await soft(pub.readContract({ address: usdg, abi: tokenAbi, functionName: "balanceOf", args: [holder] }));
  await soft(pub.readContract({ address: usdg, abi: tokenAbi, functionName: "isFrozen", args: [holder] }));
  await soft(pub.call({ account: holder, to: usdg, data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [MULTICALL3, 1_000_000n] }) }));

  await Promise.all(cfg.stocks.map(async (s) => {
    const stock = getAddress(s.stock);
    const feed = getAddress(s.feed);
    const pool = getAddress(s.uniPool);
    for (const fn of ["totalSupply", "decimals", "uiMultiplier", "newUIMultiplier", "effectiveAt", "oraclePaused", "paused", "uid"] as const) {
      await soft(pub.readContract({ address: stock, abi: tokenAbi, functionName: fn }));
    }
    await soft(pub.readContract({ address: stock, abi: tokenAbi, functionName: "balanceOf", args: [holder] }));
    await soft(pub.readContract({ address: stock, abi: tokenAbi, functionName: "isBlocked", args: [holder] }));
    await soft(pub.call({ account: holder, to: stock, data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [MULTICALL3, 10n ** 15n] }) }));
    await soft(pub.getStorageAt({ address: stock, slot: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" })); // not-a-key (EIP-1967 beacon slot)
    for (const fn of ["latestRoundData", "decimals", "aggregator", "description"] as const) await soft(pub.readContract({ address: feed, abi: feedAbi, functionName: fn }));
    for (const fee of [100, 500, 3000, 10000]) await soft(pub.readContract({ address: getAddress(cfg.uniswapV3Factory), abi: factoryAbi, functionName: "getPool", args: [stock, usdg, fee] }));
    for (const fn of ["slot0", "liquidity", "token0", "token1", "fee", "tickSpacing"] as const) await soft(pub.readContract({ address: pool, abi: poolAbi, functionName: fn }));
    for (const window of [[1800, 0], [3600, 0], [600, 0]]) await soft(pub.readContract({ address: pool, abi: poolAbi, functionName: "observe", args: [window] }));
    await soft(pub.readContract({ address: stock, abi: tokenAbi, functionName: "balanceOf", args: [pool] }));
    await soft(pub.readContract({ address: usdg, abi: tokenAbi, functionName: "balanceOf", args: [pool] }));
    // Walk the ticks a hedge could cross: simulated swaps to +-3% price in both directions (they revert at the callback,
    // after the tick traversal has read every word and tick on the way).
    const [sqrt] = await pub.readContract({ address: pool, abi: poolAbi, functionName: "slot0" });
    for (const pct of [1n, 3n]) {
      const down = (sqrt * (1000n - pct * 5n)) / 1000n; // sqrt price -0.5% / -1.5% = price -1% / -3%
      const up = (sqrt * (1000n + pct * 5n)) / 1000n;
      for (const [zeroForOne, limit] of [[true, down > MIN_SQRT ? down : MIN_SQRT + 1n], [false, up < MAX_SQRT ? up : MAX_SQRT - 1n]] as const) {
        await soft(pub.call({ account: MULTICALL3, to: pool, data: encodeFunctionData({ abi: poolAbi, functionName: "swap", args: [MULTICALL3, zeroForOne, 10n ** 30n, limit, "0x" as Hex] }) }));
      }
    }
    console.log(`warm: ${s.name} token, feed, pool and +-3% ticks read`);
  }));
  console.log(`warm: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: bun scripts/fork/warm.ts <deploy-config.json>");
  await main(path);
}
