// /contracts page data (todo 37, L5). Pure helpers: labels, explorer and Sourcify links, and the rows to show.
// Addresses come from the API (/v1/config) or, when that is not reachable or empty, from /contracts.json (the deployment
// file this site ships). With no addresses the page says "Addresses are published at launch".
export const ADDRESS=/^0x[0-9a-fA-F]{40}$/;

export const LABELS={
 engine:['Engine','Buy, sell, quote and Shield. Selling is never blocked by a pause.'],
 pool:['Writer Pool','The USDG pool that takes the other side of every trade. Withdrawals use its queue.'],
 registry:['Series Registry','Lists every option series and holds its funding state.'],
 priceGuard:['Price Guard','Reads the price feed and the session, and checks it against a second source.'],
 volOracle:['Volatility Oracle','Stores the signed volatility posts the engine prices from.'],
 marketHours:['Market Hours','The market session calendar.'],
 agentRouter:['Agent Router','Lets an owner give an agent key a budget and a list of names.'],
 reserve:['Reserve','The first loss layer of the Writer Pool.'],
 feeRouter:['Fee Router','Splits the protocol fee.'],
 staking:['Staking','Phase 2, off at launch.'],
 buyBurn:['Buy and burn','Phase 2, off at launch.'],
 usdg:['USDG','The settlement token. A third-party token, listed so you can check the address.'],
};
const ORDER=Object.keys(LABELS);

export const explorerAddress=(explorer,address)=>String(explorer||'').replace(/\/$/,'')+'/address/'+address;
export const sourcifyPage=(chainId,address)=>`https://repo.sourcify.dev/${chainId}/${address}`;
export const sourcifyApi=(chainId,address)=>`https://sourcify.dev/server/v2/contract/${chainId}/${address}`;

/** Rows for every valid address in `contracts` (a {key: address} object), known contracts first. */
export function rowsFrom(contracts){
 const entries=Object.entries(contracts&&typeof contracts==='object'?contracts:{}).filter(([k,v])=>typeof v==='string'&&ADDRESS.test(v));
 entries.sort((a,b)=>{const ia=ORDER.indexOf(a[0]),ib=ORDER.indexOf(b[0]);return (ia<0?99:ia)-(ib<0?99:ib)||a[0].localeCompare(b[0])});
 return entries.map(([key,address])=>({key,address,label:LABELS[key]?.[0]||key,about:LABELS[key]?.[1]||''}));
}
export const stocksFrom=stocks=>(Array.isArray(stocks)?stocks:[]).filter(s=>s&&ADDRESS.test(s.stock||'')).map(s=>({name:String(s.name||''),address:s.stock}));

/** True for a Sourcify answer that means the source matches the chain. */
export const isVerified=body=>!!body&&(body.match==='exact_match'||body.match==='match'||body.creationMatch==='exact_match'||body.runtimeMatch==='exact_match');
