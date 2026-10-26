// Feed mirror for the testnet: copies each NEW mainnet Chainlink round of every launch name into the testnet mock feed
// (TestnetFeed.push from the feed-mirror wallet, the feeds' updater). Mainnet is only read. A round is pushed once, so
// the mock feeds move exactly when the real ones do (deviation 0.5 % or the 24 h heartbeat; nothing off-hours, as on
// mainnet), and PriceGuard sees the same freshness pattern it will see in production.
//
//   MIRROR_SOURCE_RPC=<mainnet rpc> MIRROR_SOURCES=NVDA=0x..,TSLA=0x.. bun scripts/testnet/mirror.ts [--once]
// Refuses unless the testnet RPC answers 46630. Mainnet feed addresses come from the deploy config (docs), never source.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeFunctionData, getAddress, http, type Address } from "viem";
import { accountOf, assertTestnet, loadDeployment, log, publicClient, testnetFeedAbi, TESTNET_DIR, txLink, walletFor } from "./lib";

const STATE = join(TESTNET_DIR, "mirror-state.json");

export function parseSources(text: string): Record<string, Address> {
  const out: Record<string, Address> = {};
  for (const item of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, address] = item.split("=");
    if (!name || !address) throw new Error(`bad MIRROR_SOURCES item ${item}`);
    out[name.toUpperCase()] = getAddress(address);
  }
  return out;
}

/** True when the source has a round the mock has not had yet. */
export function needsPush(sourceRound: bigint, lastPushed: string | undefined): boolean {
  return lastPushed === undefined || BigInt(lastPushed) !== sourceRound;
}

async function pass(sources: Record<string, Address>, state: Record<string, string>) {
  const src = createPublicClient({ transport: http(process.env.MIRROR_SOURCE_RPC!, { timeout: 30_000, retryCount: 4, retryDelay: 1000 }) });
  if ((await src.getChainId()) !== 4663) throw new Error("MIRROR_SOURCE_RPC is not Robinhood Chain mainnet (4663)");
  const pub = publicClient();
  const wallet = walletFor("feed-mirror");
  const dep = loadDeployment();
  for (const s of dep.stocks) {
    const source = sources[s.name];
    const feed = s.feed ? getAddress(s.feed) : undefined;
    if (!source || !feed) continue;
    const [roundId, answer] = await src.readContract({ address: source, abi: testnetFeedAbi, functionName: "latestRoundData" });
    if (!needsPush(roundId, state[s.name])) continue;
    const updater = await pub.readContract({ address: feed, abi: testnetFeedAbi, functionName: "updater" });
    if (getAddress(updater) !== getAddress(accountOf("feed-mirror").address)) throw new Error(`${s.name} feed updater is ${updater}, not the feed-mirror wallet (run deploy.sh step 5)`);
    const hash = await wallet.sendTransaction({ account: wallet.account!, chain: wallet.chain, to: feed, data: encodeFunctionData({ abi: testnetFeedAbi, functionName: "push", args: [answer] }) });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${s.name} push ${hash} reverted`);
    state[s.name] = roundId.toString();
    writeFileSync(STATE, JSON.stringify(state));
    log(`mirror ${s.name} round ${roundId} answer ${answer} -> ${feed} (${txLink(hash)}, gas ${r.gasUsed})`);
  }
}

if (import.meta.main) {
  await assertTestnet();
  const sources = parseSources(process.env.MIRROR_SOURCES ?? "");
  if (!Object.keys(sources).length || !process.env.MIRROR_SOURCE_RPC) throw new Error("set MIRROR_SOURCE_RPC and MIRROR_SOURCES");
  const state: Record<string, string> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const every = Number(process.env.MIRROR_INTERVAL_SECONDS ?? "120") * 1000;
  for (;;) {
    try { await pass(sources, state); } catch (e) { log(`mirror pass failed: ${(e as Error).message.split("\n")[0]}`); }
    if (process.argv.includes("--once")) break;
    await Bun.sleep(every);
  }
}
