// After deploy.sh: the deployer (the only wallet Kal funds from the faucet) passes gas ETH to every wallet that sends,
// by the amounts in the gas ledger, and mints the mock tokens (it owns tUSDG and the test Stock Tokens) to the test users.
// Testnet only (refuses any chain but 46630; the real testnet also needs the arming flag, see env.sh).
//
//   bun scripts/testnet/fund.ts                         every role per the ledger + test users' tUSDG and Stock Tokens
//   bun scripts/testnet/fund.ts --kal 0xYourMetaMask     also Kal's MetaMask: KAL_ETH (default 0.0005) ETH, 10,000 tUSDG,
//                                                       2 NVDA, and the pool deposit allowlist through the owner Safe
// Never sends more than the ledger says; a wallet that already holds its amount is skipped (safe to re-run).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, formatEther, getAddress, parseEther, parseUnits, type Address } from "viem";
import { PoolAbi } from "@/abi";
import { safeExec } from "./safe";
import {
  addressOf, assertTestnet, erc20Abi, fmtEth, isLocalRpc, loadDeployment, log, publicClient, RPC, testnetStockAbi, txLink, walletFor,
  type TestnetRole,
} from "./lib";

export const LEDGER_FILE = process.env.LEDGER_FILE || join(homedir(), ".lemniscate", "testnet-ledger.json");

/** ETH per sending wallet when no ledger exists yet (the dry run replaces these with measured figures). */
export const DEFAULT_FUNDING: Partial<Record<TestnetRole, string>> = {
  keeper: "0.002", hedger: "0.0005", "vol-signer": "0.001", "feed-mirror": "0.0002", bundler: "0.0002", "x402-settler": "0.0001",
  "owner-1": "0.0002", guardian: "0.00005", agent: "0.0001", depositor: "0.00005", alice: "0.0003", bob: "0.0002", carol: "0.0001",
  "agent-owner": "0.00005", lp2: "0.00005", payer: "0.00005",
};

/** Test users' mock balances (tUSDG 6 dp, Stock Tokens 18 dp). */
export const USER_TOKENS: Partial<Record<TestnetRole, { usdg: number; stocks?: Record<string, number> }>> = {
  depositor: { usdg: 250_000 }, alice: { usdg: 50_000 }, bob: { usdg: 50_000 }, carol: { usdg: 20_000, stocks: { NVDA: 25, TSLA: 2 } },
  "agent-owner": { usdg: 5_000 }, lp2: { usdg: 2_000 }, payer: { usdg: 100 },
};

export function fundingPlan(): Partial<Record<TestnetRole, string>> {
  if (!existsSync(LEDGER_FILE)) return DEFAULT_FUNDING;
  const l = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as { funding?: Record<string, string> };
  return (l.funding ?? DEFAULT_FUNDING) as Partial<Record<TestnetRole, string>>;
}

async function main() {
  await assertTestnet();
  if (!isLocalRpc() && (process.env.LEMNISCATE_TESTNET_ARMED !== "1" || !existsSync(join(homedir(), ".lemniscate", "testnet-armed")))) {
    throw new Error(`${RPC} is the real testnet: set LEMNISCATE_TESTNET_ARMED=1 and create ~/.lemniscate/testnet-armed (docs/runbooks/testnet-run.md)`);
  }
  const pub = publicClient();
  const dep = loadDeployment();
  const deployer = walletFor("deployer");
  const send = async (to: Address, value: bigint, what: string) => {
    const hash = await deployer.sendTransaction({ account: deployer.account!, chain: deployer.chain, to, value });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${what}: ${hash} reverted`);
    log(`${what} (${txLink(hash)})`);
  };
  const call = async (to: Address, data: `0x${string}`, what: string) => {
    const hash = await deployer.sendTransaction({ account: deployer.account!, chain: deployer.chain, to, data });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${what}: ${hash} reverted`);
    log(`${what} (${txLink(hash)})`);
  };
  const before = await pub.getBalance({ address: addressOf("deployer") });
  log(`deployer ${addressOf("deployer")} holds ${fmtEth(before)} ETH`);

  // 1. Gas ETH, largest first, so a short budget funds the services before the test users.
  const plan = Object.entries(fundingPlan()).sort((a, b) => Number(b[1]) - Number(a[1])) as [TestnetRole, string][];
  for (const [role, eth] of plan) {
    const to = addressOf(role);
    const want = parseEther(eth);
    const have = await pub.getBalance({ address: to });
    if (have >= want) { log(`${role} already holds ${fmtEth(have)} ETH`); continue; }
    await send(to, want - have, `${role} +${formatEther(want - have)} ETH`);
  }
  // 2. Mock tokens for the test users (the deployer owns tUSDG and the test Stock Tokens).
  for (const [role, t] of Object.entries(USER_TOKENS) as [TestnetRole, { usdg: number; stocks?: Record<string, number> }][]) {
    const to = addressOf(role);
    const want = parseUnits(String(t.usdg), 6);
    const have = await pub.readContract({ address: dep.contracts.usdg, abi: erc20Abi, functionName: "balanceOf", args: [to] });
    if (have < want) await call(dep.contracts.usdg, encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [to, want - have] }), `${role} +${t.usdg} tUSDG`);
    for (const [name, n] of Object.entries(t.stocks ?? {})) {
      const stock = getAddress(dep.stocks.find((s) => s.name === name)!.stock);
      const held = await pub.readContract({ address: stock, abi: erc20Abi, functionName: "balanceOf", args: [to] });
      const target = parseEther(String(n));
      if (held < target) await call(stock, encodeFunctionData({ abi: testnetStockAbi, functionName: "mint", args: [to, target - held] }), `${role} +${n} test ${name}`);
    }
  }
  // 3. Kal's MetaMask (optional): a little ETH, tUSDG, 2 NVDA, and the deposit allowlist via the owner Safe.
  const i = process.argv.indexOf("--kal");
  if (i >= 0) {
    const kal = getAddress(process.argv[i + 1] ?? "");
    const eth = parseEther(process.env.KAL_ETH ?? "0.0005");
    const have = await pub.getBalance({ address: kal });
    if (have < eth) await send(kal, eth - have, `Kal ${kal} +${formatEther(eth - have)} ETH`);
    await call(dep.contracts.usdg, encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [kal, parseUnits("10000", 6)] }), "Kal +10,000 tUSDG");
    const nvda = getAddress(dep.stocks.find((s) => s.name === "NVDA")!.stock);
    await call(nvda, encodeFunctionData({ abi: testnetStockAbi, functionName: "mint", args: [kal, parseEther("2")] }), "Kal +2 test NVDA");
    const allowed = await pub.readContract({ address: dep.contracts.pool, abi: PoolAbi, functionName: "isDepositor", args: [kal] }).catch(() => false);
    if (!allowed) {
      const r = await safeExec(dep.contracts.pool, encodeFunctionData({ abi: PoolAbi, functionName: "setDepositor", args: [kal, true] }));
      log(`Kal may deposit into the Writer Pool: owner Safe ${r.safe} (${txLink(r.hash)})`);
    }
  }
  const after = await pub.getBalance({ address: addressOf("deployer") });
  log(`deployer spent ${fmtEth(before - after)} ETH; ${fmtEth(after)} ETH left`);
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (e) {
    console.error(`[testnet fund] ${(e as Error).message}`);
    process.exit(1);
  }
}
