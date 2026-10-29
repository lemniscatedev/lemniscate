// Guided first trade (todo 37, L1). Pure helpers: which step a new wallet is on, what to fund, the words that match the
// access policy, and a per-wallet "dismissed" flag kept in localStorage. The dashboard renders what this returns.
// Nothing here talks to the network or the DOM.
export const STORE_KEY='lemniscate.onboarding.v1';
export const MIN_TRADE_USDG=1;
export const DEFAULT_SPONSOR_MIN_USDG=5;// SPONSOR_MIN_NOTIONAL_USDG default in the backend
const USDG_RAW=1_000_000n;

/** The sponsorship minimum from /v1/userop/config (`sponsorMinNotionalUsdg`), else the backend default of 5. */
export function sponsorMin(useropConfig){
 const n=Number(useropConfig?.sponsorMinNotionalUsdg);
 return Number.isFinite(n)&&n>0?n:DEFAULT_SPONSOR_MIN_USDG;
}
/** What the guide suggests for a first trade: the sponsorship minimum when gas is sponsored, otherwise the $1 minimum. */
export const suggestedTrade=({sponsoring,sponsorMin:min})=>sponsoring?Math.max(MIN_TRADE_USDG,min||DEFAULT_SPONSOR_MIN_USDG):MIN_TRADE_USDG;

const key=address=>String(address||'none').toLowerCase();

/** The whole stored map {address: {dismissed, seenPositions}}; {} on any storage problem. */
export function readStore(storage){
 try{const v=JSON.parse((storage||localStorage).getItem(STORE_KEY));return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}catch{return {}}
}
export function readWallet(address,storage){const v=readStore(storage)[key(address)];return v&&typeof v==='object'?v:{}}
/** Merges `patch` into this wallet's entry. Returns false when the browser would not store it. */
export function writeWallet(address,patch,storage){
 try{const s=storage||localStorage;const all=readStore(s);all[key(address)]={...(all[key(address)]||{}),...patch};s.setItem(STORE_KEY,JSON.stringify(all));return true}catch{return false}
}
export const isDismissed=(address,storage)=>readWallet(address,storage).dismissed===true;
export const dismiss=(address,storage)=>writeWallet(address,{dismissed:true},storage);

/** Words about who may use the site. `required` is the API's invite gate (/v1/invites/status). */
export function accessLine({required,approved,regions}){
 const where=regions||'the United Kingdom, Canada or Switzerland';
 if(required&&approved!==true)return `Lemniscate is invite-only for the first 8 hours after launch. Invite codes are posted in the Lemniscate Telegram group. Enter your invite code to start buying; selling is always open. After that it opens to everyone except residents of ${where}.`;
 if(required)return `Your wallet is approved. Lemniscate is invite-only for the first 8 hours after launch and then opens to everyone except residents of ${where}.`;
 return `Lemniscate is not offered to residents of ${where}.`;
}

/**
 * ctx: {address, chainOk, chainName, usdgRaw (bigint|null), ethWei (bigint|null), sponsoring (bool), positions (number|null),
 *       seenPositions (bool)}
 * Returns the steps in order with `done` flags and the index of the first step that is not done (-1 when all are).
 */
export function buildSteps(ctx){
 const suggested=suggestedTrade(ctx);
 const hasUsdg=ctx.usdgRaw!=null&&ctx.usdgRaw>=BigInt(Math.round(suggested*1e6));
 const hasGas=ctx.sponsoring||(ctx.ethWei!=null&&ctx.ethWei>0n);
 const traded=(ctx.positions??0)>0;
 const steps=[
  {key:'connect',title:'Connect your wallet',done:!!ctx.address},
  {key:'network',title:`Check the network: ${ctx.chainName||'Robinhood Chain'}`,done:!!ctx.address&&ctx.chainOk===true},
  {key:'fund',title:'Add USDG'+(ctx.sponsoring?'':' and a little ETH for gas'),done:hasUsdg&&hasGas,hasUsdg,hasGas},
  {key:'trade',title:ctx.sponsoring?`Place a first trade of $${suggested} (the $${MIN_TRADE_USDG} minimum also works)`:`Place a small first trade (minimum $${MIN_TRADE_USDG})`,done:traded},
  {key:'position',title:'See your position',done:traded&&ctx.seenPositions===true},
 ];
 return {steps,current:steps.findIndex(s=>!s.done)};
}

/** What to say about funding, given whether gas is sponsored. Plain strings; the caller escapes them. */
export function fundCopy({sponsoring,fundAddress,chainName,sponsorMin:min}){
 const where=fundAddress?`Send it to ${fundAddress} on ${chainName||'Robinhood Chain'}.`:`Send it on ${chainName||'Robinhood Chain'}.`;
 const usdg=sponsoring
  ?`USDG pays for the option. A first trade of $${suggestedTrade({sponsoring,sponsorMin:min})} or more gets its gas sponsored; $${MIN_TRADE_USDG} is the smallest the engine accepts. ${where}`
  :`USDG pays for the option. A first trade of $${MIN_TRADE_USDG} is the smallest the engine accepts. ${where}`;
 const gas=sponsoring
  ?`Gas on eligible one-tap trades of $${suggestedTrade({sponsoring,sponsorMin:min})} or more is sponsored, so ETH is optional for those. A smaller trade, or one after the daily limit, is paid in ETH from the same account, and the ticket says so before you sign.`
  :'ETH pays the network gas for each transaction. Keep a small amount of ETH in the same account as your USDG.';
 return {usdg,gas};
}
