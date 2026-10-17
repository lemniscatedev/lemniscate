// LOCAL FORK PROFILE (todo 23). Served in place of config.js only by `LM_PROFILE=fork npm start` (serve.mjs, bound to
// 127.0.0.1). It points the site at the anvil mainnet fork (chain 31337, never a real network) and the API of the local
// fork stack (backend app/scripts/fork/up.sh). serve.mjs replaces apiBase and rpcUrl with LM_API_BASE / LM_RPC_URL when set.
// devWallet lists a "Dev wallet (local fork)" that signs through anvil's unlocked dev account devWalletIndex; it only
// exists on localhost with chain 31337 and shows a red badge while connected.
window.LM_CONFIG=Object.freeze({
 apiBase:'http://127.0.0.1:3101',
 siteUrl:'',
 walletConnectProjectId:'',
 appKitUrl:'https://cdn.jsdelivr.net/npm/@reown/appkit-cdn@1.8.24/dist/appkit.js',
 chainId:31337,
 chainName:'Lemniscate fork',
 rpcUrl:'http://127.0.0.1:8545',
 explorerUrl:'',
 oneTap:false,
 blockedRegions:['GB','CA','CH'],
 geoEndpoint:'',
 devWallet:true,
 devWalletIndex:9,
});
