// Sell-lane proof (backend R3-06). A one-tap sell is served from the API's reserved read lane only when the request carries
// the owner's personal_sign over this exact message, with an expiry at most 15 minutes ahead of the server's clock. The proof
// is cached in memory per (account, chain) so the wallet is asked about once per 15 minutes. Nothing is stored on disk.
// If the user declines, the sell still goes ahead without the proof (the shared lane).

/** The API refuses an expiry more than this many seconds ahead (SELL_LANE_PROOF_MAX_SECONDS in the backend). */
export const SELL_LANE_PROOF_MAX_SECONDS=900;
/** Room for a client clock that runs ahead of the server's, so the expiry is never past the server's limit. */
export const CLOCK_SKEW_SECONDS=60;
/** A cached proof is replaced this long before it expires, so it is never sent in its last minute. */
export const REFRESH_MARGIN_SECONDS=60;

/** The exact text the API recovers the signer from (backend app/src/api/sell-lane-proof.ts). */
export function sellLaneProofMessage(account,chainId,expires){
 return [
  'Lemniscate wants you to sign this message.',
  '',
  'Action: sell-lane',
  `Account: ${String(account).toLowerCase()}`,
  `Expires: ${expires}`,
  `Chain: ${chainId}`,
 ].join('\n');
}

/**
 * @param {{sign:(message:string)=>Promise<string>, now?:()=>number}} options
 *   sign: EIP-191 personal_sign by the account's owner. now: milliseconds, Date.now by default.
 * get(account, chainId) resolves to {expires, signature}, or null when the wallet declined or could not sign.
 */
export function createLaneProofCache({sign,now=()=>Date.now()}){
 const cache=new Map(),pending=new Map();
 const key=(account,chainId)=>String(account).toLowerCase()+':'+Number(chainId);
 const seconds=()=>Math.floor(now()/1000);
 async function get(account,chainId){
  const k=key(account,chainId);
  const hit=cache.get(k);
  if(hit&&hit.expires-REFRESH_MARGIN_SECONDS>seconds())return hit;
  cache.delete(k);
  if(pending.has(k))return pending.get(k);
  const expires=seconds()+SELL_LANE_PROOF_MAX_SECONDS-CLOCK_SKEW_SECONDS;
  const job=(async()=>{
   try{
    const signature=await sign(sellLaneProofMessage(account,Number(chainId),expires));
    if(typeof signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(signature))return null;
    const proof=Object.freeze({expires,signature});
    cache.set(k,proof);
    return proof;
   }catch{return null}
   finally{pending.delete(k)}
  })();
  pending.set(k,job);
  return job;
 }
 return {get,clear:()=>{cache.clear()},peek:(account,chainId)=>cache.get(key(account,chainId))||null};
}
