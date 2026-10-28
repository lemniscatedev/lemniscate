// Builds the /exit guide (todo 37, L2) from scripts/exit.template.html.
//  dist/exit/index.html        the page the site serves at /exit
//  dist/lemniscate-exit.html   the same guide as ONE file for saving locally (no site link that would break offline)
// Both are fully self-contained: inline CSS, no scripts, no images, no fonts. Contract addresses are baked in as plain text
// from dist/contracts.json (the deployment file); with none, the page says they are published at launch.
// Run: npm run stamp (part of npm run build).
import {readFile,writeFile,mkdir} from 'node:fs/promises';

const esc=s=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const config=await readFile('dist/config.js','utf8');
const pick=name=>(config.match(new RegExp('\\b'+name+'\\s*:\\s*\'([^\']*)\''))?.[1]||'');
const explorer=pick('explorerUrl').replace(/\/$/,'')||'https://robinhoodchain.blockscout.com';
const rpc=pick('rpcUrl')||'https://rpc.mainnet.chain.robinhood.com';
const chainId=config.match(/\bchainId\s*:\s*(\d+)/)?.[1]||'4663';
const siteUrl=pick('siteUrl').replace(/\/$/,'');
const deployment=JSON.parse(await readFile('dist/contracts.json','utf8'));
const LABEL={engine:'Engine',pool:'Writer Pool',registry:'Series Registry',agentRouter:'Agent Router',usdg:'USDG (the settlement token)',priceGuard:'Price Guard',volOracle:'Volatility Oracle',marketHours:'Market Hours',reserve:'Reserve',feeRouter:'Fee Router'};
const rows=Object.entries(deployment.contracts||{}).filter(([,v])=>/^0x[0-9a-fA-F]{40}$/.test(v));
let addresses;
if(rows.length){
 addresses='<table><tr><th>Contract</th><th>Address</th></tr>'+rows.map(([k,v])=>`<tr><td>${esc(LABEL[k]||k)}</td><td><code>${esc(v)}</code><br><a href="${esc(explorer)}/address/${esc(v)}">Open on the explorer</a></td></tr>`).join('')+'</table>'
  +'<p>The option token for each series is its own contract. Find it in your wallet or under the Tokens tab of your address (section 1).</p>';
}else{
 addresses='<div class="card"><p><strong>Addresses are published at launch.</strong> When Lemniscate goes live, this page lists the Engine, Writer Pool, Series Registry and Agent Router addresses here. They are also on the Contracts page of the website and in the public repository.</p></div>';
}
const template=await readFile('scripts/exit.template.html','utf8');
const make=local=>{
 const nav=local
  ?(siteUrl?`<a href="${esc(siteUrl)}/contracts">Contracts page</a>`:'')
  :'<a href="/contracts">Contracts</a>';
 return template.replaceAll('<!--LM:NAV-->',nav).replaceAll('<!--LM:ADDRESSES-->',addresses)
  .replaceAll('<!--LM:EXPLORER-->',esc(explorer)).replaceAll('<!--LM:RPC-->',esc(rpc)).replaceAll('<!--LM:CHAINID-->',esc(chainId));
};
await mkdir('dist/exit',{recursive:true});
await writeFile('dist/exit/index.html',make(false));
await writeFile('dist/lemniscate-exit.html',make(true));
console.log(`Exit guide written: ${rows.length} contract address(es), explorer ${explorer}.`);
