// Lemniscate API client. Every market number on the dashboard comes from here (todo 18 R2/R15).
// Errors are turned into plain sentences; the raw response never reaches the page.
const TIMEOUT_MS=12_000;

export class ApiError extends Error{
 constructor(message,{status=0,code='',reason=null}={}){super(message);this.status=status;this.code=code;this.reason=reason}
}

const PLAIN={
 BUY_BLOCKED:null,
 NO_VOL:'Volatility inputs are not posted for this option yet, so it cannot be priced.',
 NO_PRICE:'No price is available for this name yet.',
 NOT_FOUND:'That option is not listed.',
 NO_SHIELD_SERIES:'No Weekly Down option is open for purchase on this name right now.',
 AA_UNAVAILABLE:'One-tap trading is not available on this server. Use a regular transaction.',
 BUNDLER_ERROR:'The one-tap relay did not accept the operation. Try a regular transaction.',
 CHAIN_UNAVAILABLE:'One-tap trading is busy right now. Wait a moment and try again.',
 BAD_REQUEST:'That request was not accepted. Reload the page and try again.',
 RATE_LIMITED:'Too many requests in a short time. Wait a moment and try again.',
 INVITE_REQUIRED:'Lemniscate is invite-only for now. Enter your invite code to start buying. Selling is always open.',
 INVALID_CODE:'That code is not valid or has already been used.',
 UNAUTHORIZED:'Your wallet signature was not accepted. Try again.',
 HOLDER_SESSION_REQUIRED:'Connect your wallet and sign in to check your $LMNS level.',
};

export function plainError(error){
 if(error instanceof ApiError)return error.message;
 if(error?.name==='AbortError')return 'The request took too long. Check your connection and try again.';
 return 'Live data could not be reached. Check your connection and try again.';
}

export function createApi(base){
 const root=String(base||'').replace(/\/+$/,'');
 async function request(path,{method='GET',body,signal,token}={}){
  if(!root)throw new ApiError('Live data is not configured for this site yet.',{code:'NO_API'});
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  signal?.addEventListener('abort',()=>controller.abort(),{once:true});
  let response;
  try{
   const headers={...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})};
   response=await fetch(root+path,{method,headers:Object.keys(headers).length?headers:undefined,body:body?JSON.stringify(body):undefined,signal:controller.signal,credentials:'omit',cache:'no-store'});
  }catch(error){throw new ApiError(plainError(error),{code:'NETWORK'})}
  finally{clearTimeout(timer)}
  let json=null;try{json=await response.json()}catch{}
  if(!response.ok){
   const code=json?.error||(response.status===429?'RATE_LIMITED':'HTTP_'+response.status);
   const message=PLAIN[code]||json?.message||(response.status>=500?'The service is having trouble right now. Try again shortly.':'The request was not accepted.');
   throw new ApiError(message,{status:response.status,code,reason:json?.reason||null});
  }
  return json;
 }
 return {
  configured:!!root,
  config:()=>request('/v1/config'),
  chains:()=>request('/v1/chains'),
  chain:name=>request('/v1/chains/'+encodeURIComponent(name)),
  series:id=>request('/v1/series/'+encodeURIComponent(id)+'?history=0'),
  vol:name=>request('/v1/vol/'+encodeURIComponent(name)),
  pool:()=>request('/v1/pool'),
  writerRewards:({week,address}={})=>{const q=new URLSearchParams();if(week)q.set('week',String(week));if(address)q.set('address',address);const t=q.toString();return request('/v1/writers/rewards'+(t?'?'+t:''))},
  corporateActions:name=>request('/v1/corporate-actions?symbol='+encodeURIComponent(name)),
  positions:address=>request('/v1/accounts/'+encodeURIComponent(address)+'/positions'),
  activity:(address,{cursor='',limit=20}={})=>request('/v1/accounts/'+encodeURIComponent(address)+'/activity?limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):'')),
  agents:address=>request('/v1/accounts/'+encodeURIComponent(address)+'/agents'),
  smartAccount:(address,index=0)=>request('/v1/accounts/'+encodeURIComponent(address)+'/smart-account'+(index?'?index='+index:'')),
  quote:body=>request('/v1/quote',{method:'POST',body}),
  intent:(kind,body,{userop=false}={})=>request('/v1/intent/'+kind+(userop?'?format=userop':''),{method:'POST',body}),
  invitesStatus:address=>request('/v1/invites/status'+(address?'?address='+encodeURIComponent(address):'')),
  inviteRedeem:body=>request('/v1/invites/redeem',{method:'POST',body}),
  holder:address=>request('/v1/holder/'+encodeURIComponent(address)),
  holderSession:body=>request('/v1/holder/session',{method:'POST',body}),
  /** A $LMNS holder-perk route; `token` is the holder session from holderSession. */
  perk:(path,{token,method='GET',body}={})=>request(path,{method,body,token}),
  useropConfig:()=>request('/v1/userop/config'),
  useropSend:userOp=>request('/v1/userop/send',{method:'POST',body:{userOp}}),
  useropStatus:hash=>request('/v1/userop/'+encodeURIComponent(hash)),
 };
}

/** Session label for the header pill and tickets. Overnight is EXTENDED in the API (buys allowed at half caps). */
export const SESSION_LABEL={REGULAR:'Regular hours',EXTENDED:'Extended hours',CLOSED:'Market closed',UNKNOWN:'Session unknown',HALTED:'Price feed halted'};
export const SESSION_NOTE={
 REGULAR:'',
 EXTENDED:'Extended hours: spreads are 1.5 times wider and position caps are halved.',
 CLOSED:'The market is closed. New buys are paused; sells stay open at the last close with a spread 3 times wider and a weekend volatility adjustment.',
 UNKNOWN:'The session cannot be confirmed. New buys are paused; sells stay open at the last close with a wider spread.',
 HALTED:'The price feed is halted. New buys are paused and sells join a queue that fills at the first fresh price.',
};
export const BLOCK_REASON={
 SERIES_ARCHIVED:'This option is no longer listed for new purchases. It can still be sold.',
 SERIES_NOT_BUYABLE:'This option is not open for new purchases right now. It can still be sold.',
 BUYS_PAUSED:'New purchases are paused. Sells stay open.',
 SESSION_CLOSED:'New purchases are closed while the market is closed. Sells stay open.',
 SESSION_UNKNOWN:'New purchases are closed while the market session is unknown. Sells stay open.',
 SESSION_HALTED:'New purchases are paused while the price feed is halted. Sells queue until a fresh price returns.',
 PRICE_STALE:'New purchases are paused until the price is fresh.',
 PRICE_PAUSED:'New purchases are paused on this name while a price check completes, for example around a stock split. Sells stay open.',
 NO_VOL:'New purchases are paused until volatility inputs are posted.',
 VOL_STALE:'New purchases are paused until volatility inputs are refreshed.',
 EARNINGS_BLOCK:'New purchases are paused around this company’s earnings report. Sells stay open.',
 NO_PRICE:'No price is available for this name yet.',
 POOL_FILLING:'The pool is filling. Trading opens as writers deposit into the Writer Pool. Selling is never blocked.',
 CAP_REACHED:'This option is at its size limit for now: each buy is capped at a share of the pool’s NAV. Try a smaller amount. Selling is never blocked.',
 NONCE_LANE:'Gas is sponsored only on the account’s main lane. Your account pays the gas for this one.',
};
/** Why a one-tap operation came back unsponsored (sponsorship.reason, backend sponsorship.ts). The operation still works; the account pays gas. */
export const SPONSOR_DENIAL={
 NONCE_LANE:'Gas is sponsored only on the account’s main lane.',
 INVITE_REQUIRED:'Gas is sponsored for invited accounts only.',
 BELOW_MINIMUM:'This trade is below the smallest size that gets sponsored gas.',
 NO_POSITION:'The account does not hold what this sell needs.',
 OWNER_UNVERIFIED:'The account owner could not be checked.',
 QUOTA_ACCOUNT:'This account used its sponsored operations for today.',
 QUOTA_OWNER:'This wallet used its sponsored operations for today.',
 QUOTA_NETWORK:'This network used its sponsored operations for today.',
 QUOTA_GLOBAL:'Today’s sponsored operations are used up.',
 INSUFFICIENT_BALANCE:'The account does not hold the USDG this trade spends.',
 ACCOUNT_REGISTERING:'This account is being registered for sponsored gas. That takes a few minutes.',
 ACCOUNT_UNREGISTERED:'Gas is sponsored only for accounts made in the app or registered.',
 ACCOUNT_UNSUPPORTED:'This account type is not sponsored.',
 UNAVAILABLE:'Sponsorship could not be checked right now.',
};
export function sponsorNote(sponsorship){
 if(!sponsorship?.requested||sponsorship.granted)return '';
 const why=SPONSOR_DENIAL[sponsorship.reason]||'Gas is not sponsored for this one.';
 return why+' Your account pays the network gas.';
}
