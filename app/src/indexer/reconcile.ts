import assert from "node:assert/strict";
import type { Logger } from "pino";
import type { Sql } from "postgres";
import { erc20Abi, formatUnits, parseUnits, type Address, type Hex } from "viem";
import type { ServiceClients } from "../chain/clients";
import type { Deployment } from "../chain/deployment";
import { LemniscateEngineAbi } from "../abi/LemniscateEngine";

const ZERO = "0x0000000000000000000000000000000000000000";
export type Transfer = { transactionHash: Hex; logIndex: number; blockNumber: bigint; from: Address; to: Address; value: bigint };

/** Rebuild at a fixed cursor, so normal ingestion only applies later deltas. */
export function transferLedger(transfers: readonly Transfer[]) {
  const seen = new Set<string>();
  const balances = new Map<Address, bigint>();
  const ordered = [...transfers].sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
  for (const event of ordered) {
    const key = `${event.transactionHash}:${event.logIndex}`;
    assert(!seen.has(key), "Duplicate transfer log"); seen.add(key);
    assert(event.value >= 0n, "Invalid transfer amount");
    for (const [raw, delta] of [[event.from, -event.value], [event.to, event.value]] as const) {
      const account = raw.toLowerCase() as Address;
      if (account === ZERO) continue;
      const next = (balances.get(account) ?? 0n) + delta;
      assert(next >= 0n, "Transfer history starts after an account's balance");
      balances.set(account, next);
    }
  }
  return { ordered, balances };
}

/** Run with the normal indexer stopped; row locking also detects cursor drift. */
export async function reconcileListedMarkets(sql: Sql, clients: ServiceClients, deployment: Deployment, logger: Logger, confirmations: number) {
  assert.equal(await clients.logsClient.getChainId(), deployment.chainId);
  const reports = [];
  for (const market of deployment.markets) {
    if (!market.listing) continue;
    const listing = market.listing;
    const receipt = await clients.logsClient.getTransactionReceipt({ hash: listing.transactionHash as Hex });
    const block = await clients.logsClient.getBlock({ blockNumber: BigInt(listing.blockNumber) });
    assert.equal(receipt.status, "success");
    assert.equal(receipt.blockNumber, BigInt(listing.blockNumber));
    assert.equal(block.hash.toLowerCase(), listing.blockHash.toLowerCase());
    assert.equal(receipt.blockHash.toLowerCase(), listing.blockHash.toLowerCase());
    const config = await clients.stateClient.readContract({ address: deployment.contracts.engine, abi: LemniscateEngineAbi, functionName: "getConfig", args: [market.id] });
    assert.equal(config.token.toLowerCase(), market.token);
    assert.equal(config.stock.toLowerCase(), market.stock);
    assert.equal(config.feed.toLowerCase(), market.feed);
    const result = await sql.begin(async (tx) => {
      const known = await tx<{ token: string; stock: string; feed: string }[]>`SELECT token, stock, feed FROM markets WHERE id = ${market.id}`;
      if (known[0]) assert(known[0].token === market.token && known[0].stock === market.stock && known[0].feed === market.feed, "Stored market identity differs from verified deployment");
      const rows = await tx<{ block: string }[]>`SELECT block FROM cursors WHERE name = 'main' FOR UPDATE`;
      const cursor = rows[0] ? BigInt(rows[0].block) : BigInt(deployment.deployBlock) - 1n;
      const head = await clients.logsClient.getBlockNumber();
      assert(head >= BigInt(listing.blockNumber) + BigInt(confirmations), "Listing is not confirmed");
      assert(cursor <= head - BigInt(confirmations), "Indexer cursor is ahead of confirmed chain");
      if (cursor < BigInt(listing.blockNumber)) return { symbol: market.symbol, through: String(cursor), transfers: 0, pendingNormalIngestion: true };
      const boundary = await clients.logsClient.getBlock({ blockNumber: cursor });
      const transfers: Transfer[] = [];
      let from = BigInt(listing.blockNumber); let range = 5_000n;
      while (from <= cursor) {
        const to = from + range - 1n < cursor ? from + range - 1n : cursor;
        try {
          const logs = await clients.logsClient.getContractEvents({ address: market.token, abi: erc20Abi, eventName: "Transfer", fromBlock: from, toBlock: to, strict: true });
          for (const log of logs) {
            assert(!log.removed && log.transactionHash && log.blockNumber !== null && log.logIndex !== null, "Invalid transfer proof");
            transfers.push({ transactionHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber, ...log.args });
          }
          from = to + 1n;
        } catch (error) {
          if (range === 1n) throw error;
          range = range / 2n || 1n;
        }
      }
      const { ordered, balances } = transferLedger(transfers);
      let supply = 0n;
      for (const [account, balance] of balances) {
        const onchain = await clients.stateClient.readContract({ address: market.token, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber: cursor });
        assert.equal(balance, onchain, "Transfer ledger differs from canonical token balance"); supply += balance;
      }
      assert.equal(supply, await clients.stateClient.readContract({ address: market.token, abi: erc20Abi, functionName: "totalSupply", blockNumber: cursor }), "Transfer history is incomplete");
      const timestamps = new Map<bigint, Date>();
      for (const event of ordered) {
        let ts = timestamps.get(event.blockNumber);
        if (!ts) {
          const header = await clients.logsClient.getBlock({ blockNumber: event.blockNumber });
          ts = new Date(Number(header.timestamp) * 1000); timestamps.set(event.blockNumber, ts);
        }
        const fromAddr = event.from.toLowerCase(); const toAddr = event.to.toLowerCase();
        if (fromAddr !== ZERO && toAddr !== ZERO) {
          await tx`INSERT INTO transfers (tx_hash, log_index, block, ts, market_id, token, from_addr, to_addr, amount)
            VALUES (${event.transactionHash.toLowerCase()}, ${event.logIndex}, ${String(event.blockNumber)}, ${ts.toISOString()}, ${market.id}, ${market.token}, ${fromAddr}, ${toAddr}, ${formatUnits(event.value, 18)})
            ON CONFLICT (tx_hash, log_index) DO NOTHING`;
          const existing = await tx<{ token: string; from_addr: string; to_addr: string; amount: string; block: string; market_id: number }[]>`SELECT token, from_addr, to_addr, amount, block, market_id FROM transfers WHERE tx_hash = ${event.transactionHash.toLowerCase()} AND log_index = ${event.logIndex}`;
          const row = existing[0]!;
          assert(row.token === market.token && row.from_addr === fromAddr && row.to_addr === toAddr && BigInt(row.block) === event.blockNumber && row.market_id === market.id, "Stored transfer identity differs");
          assert.equal(parseUnits(row.amount, 18), event.value, "Stored transfer amount differs");
        }
        for (const account of new Set([fromAddr, toAddr])) {
          if (account === ZERO) continue;
          await tx`INSERT INTO account_metadata (address, first_seen_block, first_seen_at, last_seen_block, last_activity_at)
            VALUES (${account}, ${String(event.blockNumber)}, ${ts.toISOString()}, ${String(event.blockNumber)}, ${ts.toISOString()})
            ON CONFLICT (address) DO UPDATE SET first_seen_block = LEAST(account_metadata.first_seen_block, EXCLUDED.first_seen_block), first_seen_at = LEAST(account_metadata.first_seen_at, EXCLUDED.first_seen_at), last_seen_block = GREATEST(account_metadata.last_seen_block, EXCLUDED.last_seen_block), last_activity_at = GREATEST(account_metadata.last_activity_at, EXCLUDED.last_activity_at)`;
        }
      }
      assert.equal((await clients.logsClient.getBlock({ blockNumber: cursor })).hash, boundary.hash, "Reconciliation boundary was reorganized");
      assert.equal((await clients.logsClient.getBlock({ blockNumber: BigInt(listing.blockNumber) })).hash.toLowerCase(), listing.blockHash.toLowerCase(), "Listing was reorganized");
      await tx`DELETE FROM balances WHERE token = ${market.token}`;
      for (const [account, balance] of balances) {
        await tx`INSERT INTO balances (token, account, balance, updated_block, updated_at) VALUES (${market.token}, ${account}, ${formatUnits(balance, 18)}, ${String(cursor)}, NOW())`;
      }
      const report = { symbol: market.symbol, token: market.token, listing, through: String(cursor), blockHash: boundary.hash, transfers: ordered.length, accounts: balances.size };
      await tx`INSERT INTO keeper_status (job, last_run, last_ok, last_error, meta) VALUES (${"reconcile:" + market.token}, NOW(), NOW(), NULL, ${JSON.stringify(report)}::jsonb)
        ON CONFLICT (job) DO UPDATE SET last_run = NOW(), last_ok = NOW(), last_error = NULL, meta = EXCLUDED.meta`;
      return report;
    });
    reports.push(result); logger.info(result, "Market transfer history reconciled");
  }
  return reports;
}
