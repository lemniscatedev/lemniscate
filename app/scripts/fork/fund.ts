// Funds addresses on the anvil fork: ETH with anvil_setBalance, USDG by impersonating a large REAL holder and calling
// transfer (no storage writes, so USDG's own accounting stays exact). Fork only: refuses any chain but 31337.
//
//   bun scripts/fork/fund.ts 0xYourAddress [more addresses] [--usdg 100000] [--eth 10] [--stock NVDA=10 ...] [--depositor]
// --depositor also puts the addresses on the Writer Pool's closed-beta deposit allowlist (the timelock's
// pool.setDepositor, sent through anvil impersonation: on the fork Claude plays the Safe + 48h timelock).
//
// Holder: FUND_USDG_HOLDER, else the Uniswap v4 PoolManager (chain-facts: about 40M USDG at the pinned block; the fork
// never uses v4, so moving its USDG cannot disturb anything the protocol touches).
import { formatUnits, getAddress, parseEther, parseUnits, type Address } from "viem";
import { PoolAbi } from "@/abi";
import { erc20Abi, forkClients, impersonated, loadDeployment } from "./lib";

export const DEFAULT_USDG_HOLDER = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");

export async function fund(targets: Address[], usdg: number, eth: number, stocks: Record<string, number> = {}): Promise<{ address: Address; usdg: bigint; eth: bigint; hash?: string }[]> {
  const { pub, test } = forkClients();
  if ((await pub.getChainId()) !== 31337) throw new Error("fund: not the anvil fork (31337); refusing");
  const dep = loadDeployment();
  const token = dep.contracts.usdg;
  const holder = getAddress(process.env.FUND_USDG_HOLDER ?? DEFAULT_USDG_HOLDER);
  const wallet = await impersonated(test, holder);
  const out = [];
  try {
    for (const address of targets) {
      if (eth > 0) await test.setBalance({ address, value: parseEther(String(eth)) });
      let hash: string | undefined;
      if (usdg > 0) {
        const amount = parseUnits(String(usdg), 6);
        const held = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
        if (held < amount) throw new Error(`holder ${holder} has only ${formatUnits(held, 6)} USDG`);
        hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [address, amount], chain: null, account: holder });
        const r = await pub.waitForTransactionReceipt({ hash: hash as `0x${string}` });
        if (r.status !== "success") throw new Error(`USDG transfer to ${address} reverted`);
      }
      for (const [name, amount] of Object.entries(stocks)) {
        const stock = dep.stocks.find((x) => x.name === name)?.stock;
        if (!stock) throw new Error(`unknown stock ${name}`);
        const h = await wallet.writeContract({ address: stock, abi: erc20Abi, functionName: "transfer", args: [address, parseEther(String(amount))], chain: null, account: holder });
        if ((await pub.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error(`${name} transfer to ${address} reverted`);
      }
      const bal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
      out.push({ address, usdg: bal, eth: await pub.getBalance({ address }), ...(hash ? { hash } : {}) });
    }
  } finally {
    await test.stopImpersonatingAccount({ address: holder });
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: number) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback;
  };
  const usdg = opt("usdg", 100_000);
  const eth = opt("eth", 10);
  const stocks: Record<string, number> = {};
  for (let i = args.indexOf("--stock"); i >= 0; i = args.indexOf("--stock")) {
    const [name, amount] = args.splice(i, 2)[1]!.split("=");
    stocks[name!.toUpperCase()] = Number(amount);
  }
  const depositor = args.includes("--depositor");
  if (depositor) args.splice(args.indexOf("--depositor"), 1);
  const targets = args.map((a) => getAddress(a));
  if (!targets.length) throw new Error("usage: bun scripts/fork/fund.ts <address...> [--usdg N] [--eth N]");
  for (const r of await fund(targets, usdg, eth, stocks)) {
    console.log(`fund: ${r.address} ${formatUnits(r.usdg, 6)} USDG, ${formatUnits(r.eth, 18)} ETH${r.hash ? ` (${r.hash})` : ""}`);
  }
  if (depositor) {
    const { pub, test } = forkClients();
    const dep = loadDeployment();
    const timelock = getAddress(dep.contracts.timelock ?? "");
    const admin = await impersonated(test, timelock);
    for (const a of targets) {
      const hash = await admin.writeContract({ address: dep.contracts.pool, abi: PoolAbi, functionName: "setDepositor", args: [a, true], chain: null, account: timelock });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`fund: ${a} may deposit into the Writer Pool (${hash})`);
    }
    await test.stopImpersonatingAccount({ address: timelock });
  }
}
