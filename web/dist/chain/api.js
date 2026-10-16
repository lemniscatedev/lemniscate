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
 BAD_REQUEST:'That request was not accepted. Reload the page and try again.',
 RATE_LIMITED:'Too many requests in a short time. Wait a moment and try again.',
};

export function plainError(error){
 if(error instanceof ApiError)return error.message;
 if(error?.name==='AbortError')return 'The request took too long. Check your connection and try again.';
 return 'Live data could not be reached. Check your connection and try again.';
}

export function createApi(base){
 const root=String(base||'').replace(/\/+$/,'');
 async function request(path,{method='GET',body,signal}={}){
  if(!root)throw new ApiError('Live data is not configured for this site yet.',{code:'NO_API'});
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  signal?.addEventListener('abort',()=>controller.abort(),{once:true});
  let response;
  try{
   response=await fetch(root+path,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:controller.signal,credentials:'omit',cache:'no-store'});
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
  corporateActions:name=>request('/v1/corporate-actions?symbol='+encodeURIComponent(name)),
  positions:address=>request('/v1/accounts/'+encodeURIComponent(address)+'/positions'),
  activity:(address,{cursor='',limit=20}={})=>request('/v1/accounts/'+encodeURIComponent(address)+'/activity?limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):'')),
  agents:address=>request('/v1/accounts/'+encodeURIComponent(address)+'/agents'),
  smartAccount:(address,index=0)=>request('/v1/accounts/'+encodeURIComponent(address)+'/smart-account'+(index?'?index='+index:'')),
  quote:body=>request('/v1/quote',{method:'POST',body}),
  intent:(kind,body,{userop=false}={})=>request('/v1/intent/'+kind+(userop?'?format=userop':''),{method:'POST',body}),
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
};
