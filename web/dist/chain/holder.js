// $LMNS holder perks (2026-10-29). Core features (trade, writer deposit, withdraw, /exit, safety) are never gated. Two levels
// unlock extras: Holder (100,000+ $LMNS) and Whale (1,000,000+ $LMNS), read by the API from the wallet's own balance.
// Pure helpers plus one sign-in: the dashboard and pages render what these return. The level comes from GET /v1/holder/:address;
// a gated call needs the holder session from POST /v1/holder/session (one signature, kept for this tab only).
export const LEVELS={holder:{label:'Holder',minimum:100_000},whale:{label:'Whale',minimum:1_000_000}};
const RANK={none:0,holder:1,whale:2};
const SESSION_KEY='lemniscate.holder.session.v1';

export const meets=(tier,level)=>(RANK[tier]??0)>=(RANK[level]??99);
export const unlockText=(level,levels)=>{
 const m=(levels||[]).find(l=>l.level===level)?.minimumLmns??LEVELS[level]?.minimum;
 return `Hold ${Number(m).toLocaleString('en-US')} $LMNS to unlock`;
};

/** {tier,status,locked(level),line} from a /v1/holder response, or the locked default when there is none. */
export function holderView(level){
 const tier=level?.tier||'none';
 const status=level?.status||'awaiting_token';
 const line=status==='awaiting_token'?'$LMNS perks open when the token launches.'
  :status==='checking'?'Checking your $LMNS balance.'
  :tier==='none'?'No $LMNS level yet.':`${LEVELS[tier].label} level: ${level.balanceLmns} $LMNS.`;
 return {tier,status,line,locked:lv=>!meets(tier,lv)};
}

const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** The locked card a gated feature shows in place of itself. */
export function lockedPerkHtml({name,level,levels}){
 return `<div class="glass dash-perk-locked" role="note" data-perk-level="${esc(level)}"><strong>${esc(name)}</strong><span>${esc(unlockText(level,levels))}</span><small>${esc(LEVELS[level]?.label||'')} perk. Trading, deposits and withdrawals stay open to everyone.</small></div>`;
}

export function readSession(address,storage){
 try{const v=JSON.parse((storage||sessionStorage).getItem(SESSION_KEY));if(!v||v.address!==String(address).toLowerCase())return null;return Date.parse(v.expires)>Date.now()+60_000?v.token:null}catch{return null}
}
async function sha256Hex(text){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(d),b=>b.toString(16).padStart(2,'0')).join('')}
/** The holder.session message (same layout as the API's buildSignedMessage; payload is the hash of "{}"). */
export async function sessionMessage(address,{nonce,issued,expires}){
 return ['Lemniscate wants you to sign this message.','','Action: holder.session',`Address: ${address}`,`Payload: ${await sha256Hex('{}')}`,`Nonce: ${nonce}`,`Issued: ${issued}`,`Expires: ${expires}`,'Chain: 4663'].join('\n');
}
/** The cached session for this wallet, or a new one after one signature. */
export async function holderSession(api,address,signMessage,storage){
 const wallet=String(address).toLowerCase();
 const cached=readSession(wallet,storage);if(cached)return cached;
 const nonce=Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,'0')).join('');
 const issued=new Date(Date.now()-1000).toISOString(),expires=new Date(Date.now()+5*60_000).toISOString();
 const signature=await signMessage(await sessionMessage(wallet,{nonce,issued,expires}));
 const s=await api.holderSession({address:wallet,nonce,issued,expires,signature});
 try{(storage||sessionStorage).setItem(SESSION_KEY,JSON.stringify({address:wallet,token:s.token,expires:s.expires}))}catch{}
 return s.token;
}
