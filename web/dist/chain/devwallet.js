// Dev wallet for the LOCAL anvil fork only (todo 23). It is offered only when the site runs on localhost or 127.0.0.1,
// the configured chain is 31337 and LM_CONFIG.devWallet is true (config.fork.js). It holds no key: anvil's own dev
// accounts are unlocked, so the provider just forwards requests to the fork's RPC, which signs them. On any other host,
// chain or config it does not exist.
const LOCAL_HOSTS=new Set(['localhost','127.0.0.1','[::1]']);

export function devWalletAllowed(config,host=location.hostname){
 return config?.devWallet===true&&Number(config.chainId)===31337&&LOCAL_HOSTS.has(host);
}

async function rpc(url,method,params=[]){
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:Date.now(),method,params})});
 const j=await r.json();
 if(j.error)throw Object.assign(new Error(j.error.message||'RPC error'),{code:j.error.code});
 return j.result;
}

/** An EIP-6963-style entry for the dev wallet, or null when it is not allowed here. */
export function devWalletEntry(config,host=location.hostname){
 if(!devWalletAllowed(config,host))return null;
 let account=config.devWalletAddress?String(config.devWalletAddress).toLowerCase():null;
 const accounts=async()=>{
  if(!account){const list=await rpc(config.rpcUrl,'eth_accounts');account=(list[Number(config.devWalletIndex??9)]||list[0]||'').toLowerCase()}
  return account?[account]:[];
 };
 const provider={
  isLemniscateDevWallet:true,
  async request({method,params=[]}){
   if(method==='eth_requestAccounts'||method==='eth_accounts')return accounts();
   if(method==='eth_chainId')return '0x7a69';
   if(method==='wallet_switchEthereumChain'||method==='wallet_addEthereumChain')return null;
   if(method==='eth_sendTransaction'){const [tx]=params;const [from]=await accounts();return rpc(config.rpcUrl,method,[{...tx,from}])}
   return rpc(config.rpcUrl,method,params);
  },
  on(){},removeListener(){},
 };
 return {info:{uuid:'lemniscate-dev-wallet',name:'Dev wallet (local fork)',icon:'',rdns:'fork.lemniscate.dev',dev:true},provider};
}
