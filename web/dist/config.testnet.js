// TESTNET PROFILE. Served in place of config.js only by `npm run testnet` (LM_PROFILE=testnet, serve.mjs, bound to
// 127.0.0.1). It points the site at the Robinhood Chain TESTNET (chain 46630, test tokens only, never real money) and the
// API of the local testnet stack (backend app/scripts/testnet/up.sh, API on 127.0.0.1:3171). serve.mjs replaces apiBase
// and rpcUrl with LM_API_BASE / LM_RPC_URL when set. Contract addresses come from the API (/v1/config), not from here.
// The dashboard shows a "Testnet · chain 46630" badge whenever chainId is 46630. No dev wallet: sign with a real wallet
// (MetaMask) on the testnet network; the site offers to add the network with the values below.
window.LM_CONFIG=Object.freeze({
 apiBase:'http://127.0.0.1:3171',
 siteUrl:'',
 walletConnectProjectId:'',
 appKitUrl:'https://cdn.jsdelivr.net/npm/@reown/appkit-cdn@1.8.24/dist/appkit.js',
 chainId:46630,
 chainName:'Robinhood Chain Testnet',
 rpcUrl:'https://rpc.testnet.chain.robinhood.com',
 explorerUrl:'https://explorer.testnet.chain.robinhood.com',
 oneTap:true,
 blockedRegions:['GB','CA','CH'],
 geoEndpoint:'',
 devWallet:false,
});
