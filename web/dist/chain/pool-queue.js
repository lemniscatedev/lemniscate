// Writer Pool withdrawals go through a queue: requestWithdraw(shares) returns a ticket, the ticket matures after
// QUEUE_DELAY, then claim(ticket) pays (WriterPool.sol; redeem and withdraw always revert with UseWithdrawalQueue).
// Pure helpers: reading tickets out of receipts and logs, a per-wallet list kept in this browser, and ticket state.
export const TOPIC_QUEUED='0xbc1e9f1fe73cadc805864f37c2a9b99bcd6f8d00af936197460f64d127ca91c1';// not-a-key (event topic) WithdrawalQueued(address,uint256,uint256,uint64)
export const TOPIC_CLAIMED='0x2d43eb174787155132b52ddb6b346e2dca99302eac3df4466dbeff953d3c84d1';// not-a-key (event topic) WithdrawalClaimed(address,uint256,uint256)
export const STORE_KEY='lemniscate.pool-tickets.v1';
export const CLAIM_WINDOW_SECONDS=7*86400;

const lower=s=>String(s||'').toLowerCase();
const word=hex=>BigInt('0x'+(hex||'0').replace(/^0x/,'').padStart(64,'0').slice(0,64));

/** The WithdrawalQueued entries of `logs` emitted by `pool` for `owner`: [{id, shares, claimableAt}]. */
export function queuedFromLogs(logs,pool,owner){
 const out=[];
 for(const l of logs||[]){
  if(lower(l.address)!==lower(pool)||lower(l.topics?.[0])!==TOPIC_QUEUED)continue;
  if(owner&&lower('0x'+String(l.topics[1]||'').slice(-40))!==lower(owner))continue;
  const data=String(l.data||'').replace(/^0x/,'');
  out.push({id:word(l.topics[2]).toString(),shares:data.length>=64?word(data.slice(0,64)):0n,claimableAt:data.length>=128?Number(word(data.slice(64,128))):0});
 }
 return out;
}
export const queuedFromReceipt=(receipt,pool,owner)=>queuedFromLogs(receipt?.logs,pool,owner);

/** ticketOf(uint256) answer: (address owner, uint256 shares, uint64 claimableAt). */
export function parseTicketOf(hex){
 const d=String(hex||'').replace(/^0x/,'');
 if(d.length<192)return null;
 const shares=word(d.slice(64,128));
 if(shares===0n)return null;// unknown or fully paid
 return {owner:'0x'+d.slice(24,64),shares,claimableAt:Number(word(d.slice(128,192)))};
}

export function readTickets(address,storage){
 try{const all=JSON.parse((storage||localStorage).getItem(STORE_KEY));const v=all&&all[lower(address)];return Array.isArray(v)?v.map(String).filter(x=>/^\d+$/.test(x)):[]}catch{return []}
}
export function addTickets(address,ids,storage){
 try{
  const s=storage||localStorage;let all={};try{all=JSON.parse(s.getItem(STORE_KEY))||{}}catch{}
  const merged=[...new Set([...(all[lower(address)]||[]),...ids.map(String)])].slice(-100);
  all[lower(address)]=merged;s.setItem(STORE_KEY,JSON.stringify(all));return true;
 }catch{return false}
}
export function dropTicket(address,id,storage){
 try{const s=storage||localStorage;const all=JSON.parse(s.getItem(STORE_KEY))||{};all[lower(address)]=(all[lower(address)]||[]).filter(x=>x!==String(id));s.setItem(STORE_KEY,JSON.stringify(all));return true}catch{return false}
}
/** Ticket ids from every source, without duplicates, newest first. */
export function mergeIds(...lists){
 return [...new Set(lists.flat().filter(x=>x!=null&&/^\d+$/.test(String(x))).map(String))].sort((a,b)=>(BigInt(b)>BigInt(a)?1:BigInt(b)<BigInt(a)?-1:0));
}

/** 'waiting' (not yet claimable), 'ready', or 'late' (past the 7-day window: a claim re-queues it and pays nothing). */
export function ticketState(claimableAt,nowSec){
 if(nowSec<claimableAt)return 'waiting';
 return nowSec>claimableAt+CLAIM_WINDOW_SECONDS?'late':'ready';
}
export function waitText(seconds){
 const s=Math.max(0,Math.round(Number(seconds)||0));
 if(s<90)return `${s} seconds`;
 if(s<5400)return `${Math.round(s/60)} minutes`;
 if(s<2*86400)return `${Math.round(s/3600)} hours`;
 return `${Math.round(s/86400)} days`;
}
