import { decodeFunctionData } from "viem";
import { VolOracleAbi } from "../../abi";
import type { ChainEvent, IndexerContext } from "../types";
import { asBigInt, asNumber, speedName, unixToDate } from "../units";
import { addr, iso } from "./common";

interface PostCalldata {
  readonly sig: string;
  readonly buyBlockFrom: bigint;
  readonly buyBlockTo: bigint;
}

/** post(Post, sig) calldata carries the signature and the earnings buy-block window the event omits. */
async function postCalldata(context: IndexerContext, event: ChainEvent): Promise<PostCalldata | undefined> {
  let input: string | undefined;
  try {
    input = await context.transactionInput(event.txHash);
  } catch {
    return undefined;
  }
  if (!input) return undefined;
  try {
    const decoded = decodeFunctionData({ abi: VolOracleAbi, data: input as `0x${string}` });
    if (decoded.functionName !== "post") return undefined;
    const [post, sig] = decoded.args as unknown as readonly [
      { stock: string; speed: number; nonce: bigint; buyBlockFrom: bigint; buyBlockTo: bigint },
      string,
    ];
    if (post.stock.toLowerCase() !== addr(event, "stock") || asBigInt(post.nonce) !== asBigInt(event.args.nonce)) return undefined;
    if (asNumber(post.speed) !== asNumber(event.args.speed)) return undefined;
    return { sig, buyBlockFrom: post.buyBlockFrom, buyBlockTo: post.buyBlockTo };
  } catch {
    // Posted through a wrapper (multicall, a smart account): the event alone is what we have.
    return undefined;
  }
}

export async function handleVolEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  if (event.eventName !== "VolPosted") return;
  const stock = addr(event, "stock");
  const extra = await postCalldata(context, event);
  const from = extra && extra.buyBlockFrom > 0n ? iso(unixToDate(extra.buyBlockFrom)) : null;
  const to = extra && extra.buyBlockTo > 0n ? iso(unixToDate(extra.buyBlockTo)) : null;
  await context.tx`
    INSERT INTO vol_posts (tx_hash, log_index, block, ts, stock_token, name, speed, sigma_bps, skew_k, event_bump_bps,
                           buy_block_from, buy_block_to, valid_until, nonce, sig)
    VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${stock},
      ${context.stockNames.get(stock) ?? null}, ${speedName(event.args.speed)}, ${asNumber(event.args.sigmaBps)},
      ${asBigInt(event.args.skewK).toString()}, ${asNumber(event.args.eventBumpBps)}, ${from}, ${to},
      ${iso(unixToDate(event.args.validUntil))}, ${asBigInt(event.args.nonce).toString()}, ${extra?.sig ?? null}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
  context.snapshotNeeded = true;
  context.kinds.add("vol");
}
