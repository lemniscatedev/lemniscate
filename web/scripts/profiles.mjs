// Local serving profiles for serve.mjs (LM_PROFILE). The shipped dist/config.js is the production (mainnet) config and
// is never modified; a profile only changes what the LOCAL preview server answers for /config.js, and (when a
// Content-Security-Policy header is sent) adds that profile's own API and RPC origins to connect-src for that response.
// Nothing here is used by the production build or by Vercel.
//   fork    : dist/config.fork.js    local anvil fork (chain 31337), dev wallet
//   testnet : dist/config.testnet.js Robinhood Chain testnet (chain 46630), test tokens only
// Both take LM_API_BASE / LM_RPC_URL overrides.
export const PROFILES=Object.freeze({
 fork:Object.freeze({file:'config.fork.js',chainId:31337,label:'LOCAL FORK profile: chain 31337, dev wallet'}),
 testnet:Object.freeze({file:'config.testnet.js',chainId:46630,label:'TESTNET profile: Robinhood Chain testnet, chain 46630, test tokens only'}),
});

/** The profile for an LM_PROFILE value: null for empty (production config), throws for an unknown name so a typo never
 * silently serves the mainnet config. */
export function resolveProfile(name){
 if(!name)return null;
 const p=PROFILES[name];
 if(!p)throw new Error(`Unknown LM_PROFILE "${name}". Use one of: ${Object.keys(PROFILES).join(', ')} (or leave it unset for the shipped config).`);
 return {name,...p};
}

const quote=v=>JSON.stringify(String(v)).replace(/^"|"$/g,'');
/** Apply LM_API_BASE / LM_RPC_URL to a profile config's source text. */
export function applyOverrides(text,env={}){
 let c=text;
 if(env.LM_API_BASE)c=c.replace(/apiBase:'[^']*'/,`apiBase:'${quote(env.LM_API_BASE)}'`);
 if(env.LM_RPC_URL)c=c.replace(/rpcUrl:'[^']*'/,`rpcUrl:'${quote(env.LM_RPC_URL)}'`);
 return c;
}

/** A string value from config source text (apiBase:'...'). */
export function configValue(text,key){return (text.match(new RegExp('\\b'+key+":'([^']*)'"))||[])[1]??''}

/** Origins of the config's apiBase and rpcUrl (https, or a localhost/127.0.0.1 http origin). */
export function profileOrigins(text){
 const out=[];
 for(const key of ['apiBase','rpcUrl']){
  try{const u=new URL(configValue(text,key));if(u.protocol==='https:'||u.hostname==='127.0.0.1'||u.hostname==='localhost')out.push(u.origin)}catch{}
 }
 return [...new Set(out)];
}

/** Add origins to the connect-src of a CSP string (only for the profile's response; the policy is otherwise unchanged).
 * A policy without connect-src falls back to default-src, so one is added from default-src. No policy: unchanged. */
export function withConnectOrigins(csp,origins){
 if(!csp||!origins.length)return csp;
 const parts=csp.split(';').map(s=>s.trim()).filter(Boolean);
 const i=parts.findIndex(p=>/^connect-src(\s|$)/i.test(p));
 if(i>=0){
  const have=new Set(parts[i].split(/\s+/).slice(1));
  parts[i]=parts[i]+origins.filter(o=>!have.has(o)).map(o=>' '+o).join('');
 }else{
  const def=parts.find(p=>/^default-src(\s|$)/i.test(p));
  const base=def?def.split(/\s+/).slice(1).filter(s=>s!=="'none'"):["'self'"];
  parts.push(['connect-src',...new Set([...base,...origins])].join(' '));
 }
 return parts.join('; ');
}

/** Response headers for a profile: the given headers with the profile's origins added to any CSP (header names are
 * matched case-insensitively, both enforcing and report-only). */
export function profileHeaders(headers,origins){
 const out={...headers};
 for(const k of Object.keys(out))if(/^content-security-policy(-report-only)?$/i.test(k))out[k]=withConnectOrigins(out[k],origins);
 return out;
}
