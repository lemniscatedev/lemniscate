import { readFileSync } from "node:fs";
import { formatEther, type Address } from "viem";
import type { KeeperContext } from "../context";
import { saveJobMeta } from "../context";

/** Gas watch (launch ops): the ETH balance of the bot wallets, every 10 minutes. A wallet below its threshold posts one
 * plain message to the Lemniscate Telegram group (and the ops chat when set): which bot, the full address, the balance,
 * the time left at the measured burn rate, and how much to send for about two more days. One alert per wallet per 6 h,
 * then one "topped up" message when the balance recovers. Read-only: it never sends a transaction. OFF by default
 * (GAS_WATCH_ENABLED=0). The bot token and chat ids come from the root env file the release runner uses and are never
 * logged. */
export const SAMPLE_WINDOW_MS = 24 * 3_600_000;
export const MIN_BURN_WINDOW_MS = 30 * 60_000;
export const TOP_UP_HOURS = 48;

export interface Sample { t: number; wei: string }
export interface WalletState {
  below: boolean;
  alertedAtMs: number;
  samples: Sample[];
}
export interface GasWatchState { wallets: Record<string, WalletState>; loaded: boolean }
export const newGasWatchState = (): GasWatchState => ({ wallets: {}, loaded: false });

export interface WatchedWallet { bot: string; address: Address; minWei: bigint }

const toWei = (eth: number): bigint => BigInt(Math.round(eth * 1e18));

/** The wallets to watch, from the config and the deployment. The hedger is skipped in dry run (it holds no gas need). */
export function watchedWallets(context: KeeperContext): WatchedWallet[] {
  const c = context.config;
  const other = toWei(c.GAS_WATCH_MIN_OTHER_ETH);
  const list: { bot: string; address: string | undefined; minWei: bigint }[] = [
    { bot: "keeper", address: context.clients.walletClient?.account?.address, minWei: toWei(c.GAS_WATCH_MIN_KEEPER_ETH) },
    { bot: "vol-signer", address: c.GAS_WATCH_VOL_SIGNER_ADDRESS, minWei: toWei(c.GAS_WATCH_MIN_VOL_SIGNER_ETH) },
    { bot: "hedger", address: c.HEDGER_DRY_RUN ? undefined : c.GAS_WATCH_HEDGER_ADDRESS, minWei: other },
    { bot: "guardian-hot", address: c.GAS_WATCH_GUARDIAN_ADDRESS, minWei: other },
    { bot: "owner", address: c.GAS_WATCH_OWNER_ADDRESS || context.deployment.safe, minWei: other },
  ];
  return list.filter((w): w is WatchedWallet => Boolean(w.address)).map((w) => ({ ...w, address: w.address as Address }));
}

/** Wei burned per millisecond over the samples: only falling intervals count (a top-up interval is skipped on both the
 * amount and the time). undefined until at least 30 minutes of falling balance has been seen. */
export function burnPerMs(samples: Sample[]): number | undefined {
  let burned = 0n;
  let ms = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = BigInt(samples[i - 1]!.wei);
    const b = BigInt(samples[i]!.wei);
    if (b > a) continue;
    burned += a - b;
    ms += samples[i]!.t - samples[i - 1]!.t;
  }
  if (ms < MIN_BURN_WINDOW_MS || burned === 0n) return undefined;
  return Number(burned) / ms;
}

const eth = (wei: bigint, digits = 5) => Number(formatEther(wei)).toFixed(digits).replace(/\.?0+$/, "") || "0";

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours < 48 ? `about ${Math.round(hours)} hours` : `about ${(hours / 24).toFixed(1)} days`;
}

export function lowMessage(w: WatchedWallet, balance: bigint, rate: number | undefined, chainId: number): string {
  const left = rate ? duration(Number(balance) / rate) : "not measured yet (the watch has just started)";
  const topUp = rate ? rate * TOP_UP_HOURS * 3_600_000 : Number(w.minWei) * 2;
  const topUpEth = (Math.ceil((topUp / 1e18) * 10_000) / 10_000).toFixed(4);
  return [
    `Gas is running low on the ${w.bot} wallet.`,
    `Address: ${w.address}`,
    `Balance: ${eth(balance)} ETH (alert level ${eth(w.minWei)} ETH)`,
    `Time left at the current burn: ${left}`,
    `To cover about 2 more days, send about ${topUpEth} ETH.`,
    `Send ETH on Robinhood Chain (${chainId}) to ${w.address}`,
  ].join("\n");
}

export function recoveredMessage(w: WatchedWallet, balance: bigint): string {
  return `Topped up, thanks. The ${w.bot} wallet ${w.address} now has ${eth(balance)} ETH.`;
}

/** KEY=value lines of the root env file (parsed, never sourced). Returns "" for a missing key. */
function readEnvValue(text: string, key: string): string {
  let value = "";
  for (const line of text.split("\n")) if (line.startsWith(`${key}=`)) value = line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
  return value;
}

function apiBase(): string {
  const base = (process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/$/, "");
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base);
  if (base !== "https://api.telegram.org" && !local) throw new Error("TELEGRAM_API_BASE must be https://api.telegram.org or a local test server");
  return base;
}

/** Posts `text` to the community group and, when set, the ops chat. The token is read here and only ever placed in the
 * request URL; nothing from the file or the URL reaches a log. True when the group message was accepted. */
export async function sendTelegram(envFile: string, text: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const file = readFileSync(envFile, "utf8");
  const token = readEnvValue(file, "TELEGRAM_BOT_TOKEN");
  const community = readEnvValue(file, "TELEGRAM_COMMUNITY_CHAT_ID");
  const ops = readEnvValue(file, "TELEGRAM_OPS_CHAT_ID");
  if (!token || !community) throw new Error(`no TELEGRAM_BOT_TOKEN or TELEGRAM_COMMUNITY_CHAT_ID in ${envFile}`);
  const base = apiBase();
  let delivered = false;
  for (const [index, chat] of [community, ops].entries()) {
    if (!chat) continue;
    try {
      const response = await fetchImpl(`${base}/bot${token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      });
      if (!response.ok) throw new Error(`Telegram answered HTTP ${response.status}`);
      if (index === 0) delivered = true;
    } catch (error) {
      if (index === 0) throw new Error(`Telegram send failed: ${error instanceof Error ? error.message.replaceAll(token, "<token>") : "error"}`);
    }
  }
  return delivered;
}

async function load(context: KeeperContext, state: GasWatchState): Promise<void> {
  if (state.loaded) return;
  state.loaded = true;
  const rows = await context.sql<{ meta: { gasWatch?: Record<string, WalletState> } | null }[]>`select meta from keeper_status where job = 'gas-watch'`;
  const saved = rows?.[0]?.meta?.gasWatch;
  if (saved) state.wallets = saved;
}

export function createGasWatchJob(
  context: KeeperContext, state: GasWatchState = newGasWatchState(),
  deps: { send?: (text: string) => Promise<boolean>; nowMs?: () => number } = {},
) {
  const send = deps.send ?? ((text: string) => sendTelegram(context.config.GAS_WATCH_TELEGRAM_ENV_FILE, text));
  const nowMs = deps.nowMs ?? Date.now;
  return async (): Promise<Record<string, unknown>> => {
    if (!context.config.GAS_WATCH_ENABLED) return { idle: true, reason: "GAS_WATCH_ENABLED=0" };
    await load(context, state);
    const wallets = watchedWallets(context);
    const realertMs = context.config.GAS_WATCH_REALERT_HOURS * 3_600_000;
    const summary: Record<string, string> = {};
    for (const w of wallets) {
      const balance = await context.clients.stateClient.getBalance({ address: w.address });
      const t = nowMs();
      const st = state.wallets[w.bot] ?? (state.wallets[w.bot] = { below: false, alertedAtMs: 0, samples: [] });
      st.samples.push({ t, wei: balance.toString() });
      st.samples = st.samples.filter((s) => t - s.t <= SAMPLE_WINDOW_MS).slice(-300);
      summary[w.bot] = eth(balance);
      try {
        if (balance < w.minWei) {
          if (!st.below || t - st.alertedAtMs >= realertMs) {
            if (await send(lowMessage(w, balance, burnPerMs(st.samples), context.config.CHAIN_ID))) {
              st.below = true;
              st.alertedAtMs = t;
            }
          }
        } else if (st.below) {
          if (await send(recoveredMessage(w, balance))) st.below = false;
        }
      } catch (error) {
        context.logger.warn(`gas-watch: could not post the ${w.bot} message: ${error instanceof Error ? error.message : "error"}`);
      }
    }
    await saveJobMeta(context, "gas-watch", { gasWatch: state.wallets });
    return { idle: false, balancesEth: summary };
  };
}
