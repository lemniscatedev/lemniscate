// Deployment settings for the website. This is the ONE file to edit per environment; everything else reads it.
// It ships with no API, no WalletConnect project id and no site URL: the app then shows its "live data unavailable"
// state, the wallet picker lists browser wallets only, and pages carry no absolute og:url or canonical link.
window.LM_CONFIG=Object.freeze({
 // Base URL of the Lemniscate API (no trailing slash), e.g. "https://api.example.org". Empty: no API calls are made.
 apiBase:'',
 // Public site origin used for og:url, canonical links and og:image (no trailing slash). Empty: none are emitted.
 // After changing it, run `npm run stamp` so the static HTML heads carry it too.
 siteUrl:'',
 // Reown (WalletConnect) Cloud project id. Empty: the WalletConnect option is shown as unavailable.
 walletConnectProjectId:'',
 // Pinned Reown AppKit CDN build, loaded only when someone picks WalletConnect.
 appKitUrl:'https://cdn.jsdelivr.net/npm/@reown/appkit-cdn@1.8.24/dist/appkit.js',
 // Robinhood Chain mainnet. The API's /v1/config chainId must match, or trading stays disabled.
 chainId:4663,
 chainName:'Robinhood Chain',
 rpcUrl:'https://rpc.mainnet.chain.robinhood.com',
 explorerUrl:'https://robinhoodchain.blockscout.com',
 // One-tap buys through an ERC-4337 smart account (POST /v1/intent/*?format=userop). Off: plain transactions.
 oneTap:false,
 // Front-end region block (ISO 3166-1 alpha-2). The US is allowed.
 blockedRegions:['GB','CA','CH'],
 // Optional SAME-ORIGIN country lookup that returns Cloudflare trace text ("loc=XX"), e.g. "/cdn-cgi/trace" when the
 // site is served by Cloudflare. Empty: visitors declare their country of residence in an on-page dialog instead.
 geoEndpoint:'',
});
