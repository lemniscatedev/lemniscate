// Front-end region block (design decision 8: block UK, CA, CH; the US is allowed).
// Country lookup without sending user data to third parties:
//  1. If LM_CONFIG.geoEndpoint is set, it must be SAME-ORIGIN (e.g. Cloudflare's /cdn-cgi/trace, which answers
//     "loc=XX" from the host's own edge). Nothing leaves the site's own origin.
//  2. Otherwise the visitor declares their country of residence once; the answer stays in this browser only.
const KEY='lemniscate.region.v1';
export const REGION_NAMES={GB:'the United Kingdom',CA:'Canada',CH:'Switzerland'};

export function regionList(codes){const names=codes.map(c=>REGION_NAMES[c]||c);return names.length>1?names.slice(0,-1).join(', ')+' or '+names.at(-1):names[0]||''}

async function edgeCountry(endpoint){
 if(!endpoint||!endpoint.startsWith('/')||endpoint.startsWith('//'))return null;
 try{const r=await fetch(endpoint,{cache:'no-store',credentials:'omit'});if(!r.ok)return null;const m=(await r.text()).match(/^loc=([A-Z]{2})$/m);return m?m[1]:null}catch{return null}
}

export function declared(){try{return JSON.parse(localStorage.getItem(KEY))}catch{return null}}
export function declare(blocked){try{localStorage.setItem(KEY,JSON.stringify({resident:!!blocked,at:Date.now()}))}catch{}}

/** {status:'allowed'|'blocked'|'unknown', source} */
export async function regionStatus(config){
 const blocked=new Set(config.blockedRegions||[]);
 const country=await edgeCountry(config.geoEndpoint);
 if(country)return {status:blocked.has(country)?'blocked':'allowed',source:'edge',country};
 const answer=declared();
 if(answer)return {status:answer.resident?'blocked':'allowed',source:'declaration'};
 return {status:'unknown',source:'none'};
}
