// Wallet connection: EIP-6963 browser wallets (always listed) and WalletConnect through Reown AppKit (pinned CDN build,
// loaded only when chosen and only when a project id is configured). The site never sees keys or seed phrases.
const LAST_KEY='lemniscate.wallet.v1';
const listeners=new Set();
const discovered=new Map();
let state={address:null,provider:null,kind:null,name:null,chainId:null};
let appKit=null,appKitLoading=null;

function emit(){for(const fn of listeners)try{fn(state)}catch{}}
export function onWallet(fn){listeners.add(fn);return()=>listeners.delete(fn)}
export function wallet(){return state}
const remember=v=>{try{v?localStorage.setItem(LAST_KEY,JSON.stringify(v)):localStorage.removeItem(LAST_KEY)}catch{}};
const recall=()=>{try{return JSON.parse(localStorage.getItem(LAST_KEY))}catch{return null}};

/** Browser wallets announced through EIP-6963, plus a legacy window.ethereum entry when nothing announces itself. */
export function discoverWallets(waitMs=250){
 return new Promise(resolve=>{
  const onAnnounce=event=>{const d=event.detail;if(d?.info?.uuid&&d.provider)discovered.set(d.info.uuid,d)};
  window.addEventListener('eip6963:announceProvider',onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  setTimeout(()=>{
   window.removeEventListener('eip6963:announceProvider',onAnnounce);
   const list=[...discovered.values()];
   if(!list.length&&window.ethereum)list.push({info:{uuid:'legacy-injected',name:window.ethereum.isMetaMask?'MetaMask':'Browser wallet',icon:'',rdns:'legacy.injected'},provider:window.ethereum});
   resolve(list);
  },waitMs);
 });
}

function hexChain(id){return '0x'+Number(id).toString(16)}
async function ensureChain(provider,config){
 const current=await provider.request({method:'eth_chainId'}).catch(()=>null);
 if(current&&parseInt(current,16)===Number(config.chainId))return Number(config.chainId);
 try{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:hexChain(config.chainId)}]})}
 catch(error){
  if(error?.code!==4902)throw new Error(`Switch your wallet to ${config.chainName} to continue.`);
  await provider.request({method:'wallet_addEthereumChain',params:[{chainId:hexChain(config.chainId),chainName:config.chainName,nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:[config.rpcUrl],blockExplorerUrls:[config.explorerUrl]}]});
 }
 return Number(config.chainId);
}

function attach(provider,kind,name,address,chainId){
 state={address:address.toLowerCase(),provider,kind,name,chainId};
 provider.on?.('accountsChanged',accounts=>{if(state.provider!==provider)return;if(!accounts?.length)disconnect();else{state={...state,address:accounts[0].toLowerCase()};emit()}});
 provider.on?.('chainChanged',id=>{if(state.provider!==provider)return;state={...state,chainId:parseInt(id,16)};emit()});
 emit();
}

export async function connectInjected(detail,config){
 const accounts=await detail.provider.request({method:'eth_requestAccounts'});
 if(!accounts?.length)throw new Error('The wallet did not share an account.');
 const chainId=await ensureChain(detail.provider,config);
 attach(detail.provider,'injected',detail.info.name,accounts[0],chainId);
 remember({kind:'injected',rdns:detail.info.rdns});
 return state;
}

function appKitNetwork(config){
 return {id:Number(config.chainId),name:config.chainName,nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
  rpcUrls:{default:{http:[config.rpcUrl]}},blockExplorers:{default:{name:'Explorer',url:config.explorerUrl}},caipNetworkId:`eip155:${config.chainId}`,chainNamespace:'eip155'};
}
async function loadAppKit(config){
 if(appKit)return appKit;
 if(!config.walletConnectProjectId)throw new Error('WalletConnect is not set up on this site yet.');
 appKitLoading??=(async()=>{
  const mod=await import(config.appKitUrl);
  const network=appKitNetwork(config);
  const adapter=new mod.WagmiAdapter({networks:[network],projectId:config.walletConnectProjectId});
  appKit=mod.createAppKit({adapters:[adapter],networks:[network],defaultNetwork:network,projectId:config.walletConnectProjectId,
   metadata:{name:'Lemniscate',description:'Everlasting options on Stock Tokens',url:location.origin,icons:[location.origin+'/assets/favicon.png']},
   features:{analytics:false,email:false,socials:false,swaps:false,onramp:false},themeMode:'light'});
  return appKit;
 })();
 try{return await appKitLoading}catch(error){appKitLoading=null;throw new Error('WalletConnect could not load. Check your connection and try again.')}
}

export async function connectWalletConnect(config){
 const kit=await loadAppKit(config);
 await kit.open();
 const address=await new Promise((resolve,reject)=>{
  let done=false;const timer=setTimeout(()=>{if(!done){done=true;reject(new Error('No wallet was connected.'))}},180_000);
  kit.subscribeAccount?.(account=>{if(!done&&account?.isConnected&&account.address){done=true;clearTimeout(timer);resolve(account.address)}});
  kit.subscribeState?.(s=>{if(!done&&s&&s.open===false&&!kit.getAddress?.()){done=true;clearTimeout(timer);reject(new Error('No wallet was connected.'))}});
 });
 const provider=kit.getWalletProvider?.()||kit.getProvider?.('eip155');
 if(!provider?.request)throw new Error('The connected wallet cannot sign transactions here.');
 attach(provider,'walletconnect','WalletConnect',address,Number(config.chainId));
 remember({kind:'walletconnect'});
 return state;
}

/** Silent reconnect to the last browser wallet (eth_accounts never prompts). */
export async function reconnect(config){
 const last=recall();if(!last||last.kind!=='injected')return null;
 const list=await discoverWallets();const detail=list.find(w=>w.info.rdns===last.rdns);if(!detail)return null;
 const accounts=await detail.provider.request({method:'eth_accounts'}).catch(()=>[]);
 if(!accounts?.length)return null;
 const id=await detail.provider.request({method:'eth_chainId'}).catch(()=>null);
 attach(detail.provider,'injected',detail.info.name,accounts[0],id?parseInt(id,16):null);
 return state;
}

export function disconnect(){
 try{if(state.kind==='walletconnect')appKit?.disconnect?.()}catch{}
 state={address:null,provider:null,kind:null,name:null,chainId:null};remember(null);emit();
}

export function walletErrorText(error){
 const code=error?.code??error?.cause?.code;
 if(code===4001||/denied|rejected/i.test(error?.message||''))return 'You declined the request in your wallet. Nothing was sent.';
 if(code===-32002)return 'Your wallet already has a request open. Finish it there first.';
 if(/insufficient funds/i.test(error?.message||''))return 'Your wallet does not have enough ETH to pay network gas.';
 return error?.message&&error.message.length<160?error.message:'The wallet could not complete the request.';
}

async function rpc(config,method,params){
 if(state.provider)return state.provider.request({method,params});
 const response=await fetch(config.rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const json=await response.json();if(json.error)throw new Error(json.error.message||'RPC error');return json.result;
}
export const ethCall=(config,to,data)=>rpc(config,'eth_call',[{to,data},'latest']);
export const getLogs=(config,filter)=>rpc(config,'eth_getLogs',[filter]);
export const blockNumber=async config=>parseInt(await rpc(config,'eth_blockNumber',[]),16);

export async function sendTransaction(config,{to,data,value='0'}){
 if(!state.address)throw new Error('Connect a wallet first.');
 if(state.chainId!==Number(config.chainId))await ensureChain(state.provider,config).then(id=>{state={...state,chainId:id}});
 return state.provider.request({method:'eth_sendTransaction',params:[{from:state.address,to,data,value:'0x'+BigInt(value).toString(16)}]});
}

export async function waitForReceipt(config,hash,{timeoutMs=180_000}={}){
 const end=Date.now()+timeoutMs;
 while(Date.now()<end){
  const receipt=await rpc(config,'eth_getTransactionReceipt',[hash]).catch(()=>null);
  if(receipt){if(receipt.status==='0x0')throw new Error('The transaction was reverted on chain. No funds moved except network gas.');return receipt}
  await new Promise(r=>setTimeout(r,2_000));
 }
 throw new Error('The transaction is still pending. Check it in the explorer.');
}

/** EIP-191 personal_sign over the raw 32-byte userOpHash (what the API's signing instructions ask for). */
export function signHash(hash){
 if(!state.address)throw new Error('Connect a wallet first.');
 return state.provider.request({method:'personal_sign',params:[hash,state.address]});
}
