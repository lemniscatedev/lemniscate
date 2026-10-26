// READ-ONLY Playwright check of the TESTNET profile (LM_PROFILE=testnet, dist/config.testnet.js, chain 46630).
// It starts serve.mjs with the testnet profile itself, then checks: the testnet config is served; the API and the RPC
// both report chain 46630; the dashboard shows the "Testnet · chain 46630" badge and no network-mismatch banner;
// the option chains render; a wallet without the network is asked to add it with the right parameters (name, RPC,
// explorer, ETH); nothing is ever signed or sent; the console stays clean; phone width does not overflow.
//
// Live (the testnet stack from backend app/scripts/testnet/up.sh must be running; nothing is written anywhere):
//   node scripts/testnet-check.mjs                    (API http://127.0.0.1:3171, RPC https://rpc.testnet.chain.robinhood.com)
//   The site runs on SITE_PORT (default 7270), a port the testnet API allows through CORS (7270 and 4189).
// Self-test without the stack (scripts/mock-api.mjs answering as chain 46630, RPC stubbed, no network traffic):
//   node scripts/testnet-check.mjs --mock             (SITE_PORT default 5250, API_PORT default 5251)
//   It also proves the mismatch check is not vacuous: the same API reporting mainnet (4663) must raise the banner.
// Env: LM_API_BASE, LM_RPC_URL, SITE_PORT, API_PORT, SHOTS (screenshot dir, default testnet-shots/).
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const MOCK=process.argv.includes('--mock');
const CHAIN=46630,CHAIN_HEX='0xb626';
const SITE_PORT=Number(process.env.SITE_PORT||(MOCK?5250:7270));
const API_PORT=Number(process.env.API_PORT||5251);
const API=MOCK?`http://127.0.0.1:${API_PORT}`:(process.env.LM_API_BASE||'http://127.0.0.1:3171');
const RPC=process.env.LM_RPC_URL||'https://rpc.testnet.chain.robinhood.com';
const SHOTS=process.env.SHOTS||path.resolve('testnet-shots');
await mkdir(SHOTS,{recursive:true});

const results=[];let failures=0;
const ok=(name,pass,detail='')=>{const line=`${pass?'PASS':'FAIL'} ${name}${detail?' :: '+detail:''}`;results.push(line);console.log(line);if(!pass)failures++};
const step=async(name,fn)=>{try{await fn()}catch(error){ok(name,false,String(error.message||error).split('\n')[0])}};

// Mock API (self-test only) and the site, both started (and stopped) by this script.
const mock=MOCK?await (await import('./mock-api.mjs')).startMockApi({port:API_PORT,seed:true}):null;
const env={...process.env,LM_PROFILE:'testnet',PORT:String(SITE_PORT),LM_API_BASE:API};
if(process.env.LM_RPC_URL)env.LM_RPC_URL=RPC;else delete env.LM_RPC_URL;
const site=spawn(process.execPath,['serve.mjs'],{env,stdio:['ignore','pipe','pipe']});
let siteOut='';site.stdout.on('data',d=>siteOut+=d);site.stderr.on('data',d=>siteOut+=d);
const siteExit=new Promise(r=>site.on('exit',r));
for(let i=0;i<100&&!/Lemniscate preview/.test(siteOut)&&site.exitCode===null;i++)await new Promise(r=>setTimeout(r,50));
if(!/Lemniscate preview/.test(siteOut)){console.error('serve.mjs did not start:\n'+siteOut);site.kill();await mock?.close();process.exit(1)}
const base=`http://127.0.0.1:${SITE_PORT}`;
const cleanup=async()=>{site.kill();await siteExit;await mock?.close()};

await step('server and config',async()=>{
 ok('serve.mjs announces the testnet profile',/TESTNET profile: Robinhood Chain testnet, chain 46630/.test(siteOut),siteOut.trim());
 const c=await (await fetch(base+'/config.js')).text();
 ok('/config.js is the testnet config',/chainId:46630\b/.test(c)&&/rpcUrl:'https:\/\/rpc\.testnet\.chain\.robinhood\.com'/.test(c)&&/explorerUrl:'https:\/\/explorer\.testnet\.chain\.robinhood\.com'/.test(c)&&/devWallet:false/.test(c));
 ok('/config.js points at the API under test',c.includes(`apiBase:'${API}'`),API);
});

// The API as the site will read it (mock: rewritten to report 46630, as the real testnet API does).
const as46630=t=>t.replace(/"chainId":4663\b/g,`"chainId":${CHAIN}`);
await step('API and RPC report chain 46630',async()=>{
 const cfg=JSON.parse((MOCK?as46630:x=>x)(await (await fetch(API+'/v1/config')).text()));
 ok('API /v1/config chainId',Number(cfg.chainId)===CHAIN,String(cfg.chainId));
 ok('API lists contracts (addresses come from the API, not the site)',!!cfg.contracts?.pool&&!!cfg.contracts?.usdg);
 if(MOCK){ok('RPC eth_chainId (stubbed in --mock)',true);return}
 const r=await (await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})})).json();
 ok('RPC eth_chainId',r.result===CHAIN_HEX,r.result);
});

// A fake EIP-6963 wallet on mainnet (0x1237) that does not know the testnet: it records the switch/add requests and
// refuses (and records) anything that would sign or send.
const FAKE_WALLET=`(()=>{const ACCOUNT='0x00000000000000000000000000000000000a11ce';let chain='0x1237';window.__walletCalls=[];window.__refused=[];
 const provider={request:async({method,params})=>{window.__walletCalls.push({method,params:JSON.parse(JSON.stringify(params||[]))});
  if(method==='eth_requestAccounts'||method==='eth_accounts')return [ACCOUNT];
  if(method==='eth_chainId')return chain;
  if(method==='wallet_switchEthereumChain'){if(chain!=='${CHAIN_HEX}')throw Object.assign(new Error('Unrecognized chain ID'),{code:4902});return null}
  if(method==='wallet_addEthereumChain'){chain=params[0].chainId;return null}
  window.__refused.push(method);throw Object.assign(new Error('read-only check: '+method+' refused'),{code:4200})},on(){},removeListener(){}};
 const info={uuid:'testnet-check-wallet',name:'Check Wallet',icon:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',rdns:'check.wallet'};
 const announce=()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:Object.freeze({info,provider})}));
 window.addEventListener('eip6963:requestProvider',announce);announce();})();`;

const browser=await chromium.launch();
async function newPage({reportChain=CHAIN,wallet=false,width=1280,height=900}={}){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1});
 await context.addInitScript(()=>{try{localStorage.setItem('lemniscate.region.v1',JSON.stringify({resident:false,at:1}))}catch{}});
 if(wallet)await context.addInitScript(FAKE_WALLET);
 if(MOCK){
  await context.route(API+'/**',async route=>{const r=await route.fetch();const t=await r.text();await route.fulfill({response:r,body:reportChain===CHAIN?as46630(t):t})});
  await context.route(RPC+'/**',route=>{let id=1;try{id=JSON.parse(route.request().postData()||'{}').id??1}catch{}
   const m=(()=>{try{return JSON.parse(route.request().postData()||'{}').method}catch{return ''}})();
   const result=m==='eth_chainId'?CHAIN_HEX:m==='eth_blockNumber'?'0x10':m==='eth_getLogs'?[]:'0x'+'0'.repeat(64);
   return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({jsonrpc:'2.0',id,result})})});
 }
 const page=await context.newPage();
 const errors=[],sent=[];
 page.on('pageerror',e=>errors.push('pageerror: '+e.message));
 page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource|net::ERR_/.test(m.text()))errors.push(m.text())});
 page.on('request',r=>{if(r.method()==='POST'){let body='';try{body=r.postData()||''}catch{}if(/eth_sendRawTransaction|eth_sendTransaction/.test(body)||/\/v1\/(intent|userop|relay)/.test(r.url()))sent.push(r.url())}});
 return {page,context,errors,sent};
}
const settle=async page=>{await page.waitForFunction(()=>!document.querySelector('.lm-loader')||document.documentElement.dataset.lmLoading==='false',null,{timeout:20_000}).catch(()=>{});await page.waitForTimeout(1200)};
const text=page=>page.evaluate(()=>document.body.innerText);
const allErrors=[],allSent=[];

await step('dashboard on the testnet profile',async()=>{
 const {page,context,errors,sent}=await newPage({wallet:true});
 await page.goto(base+'/dashboard?tab=overview',{waitUntil:'load'});await settle(page);
 const t=await text(page);
 ok('badge: "Testnet · chain 46630" in the header',await page.locator('.dash-header .dash-fork-label.testnet').innerText().then(s=>s.trim()==='Testnet · chain 46630').catch(()=>false),t.slice(0,120).replace(/\n/g,' '));
 ok('no network-mismatch banner',!/Network mismatch/.test(t));
 ok('live data loaded (no unavailable banner)',!/Live data (is not available|is unavailable)/.test(t));
 ok('no fork or demo labels',!/Local fork|Dev wallet|Demo, not real funds/.test(t));
 await page.screenshot({path:path.join(SHOTS,'01-overview.png'),fullPage:true});

 await page.goto(base+'/dashboard?tab=trade',{waitUntil:'load'});await settle(page);
 await page.waitForSelector('.dash-chain-table',{timeout:20_000});
 const rows=await page.locator('.dash-chain-table tr').count();
 ok('option chains render',rows>1,`${rows} rows`);
 await page.screenshot({path:path.join(SHOTS,'02-trade.png'),fullPage:true});

 await page.click('.dash-header [data-action="connect"]');
 await page.waitForSelector('.dash-wallet-option');
 const options=await page.locator('.dash-wallet-option').allInnerTexts();
 ok('wallet picker: no dev wallet on the testnet',!options.some(o=>/Dev wallet/.test(o)),options.join(' / ').replace(/\n/g,' '));
 await page.locator('.dash-wallet-option',{hasText:'Check Wallet'}).click();
 await page.waitForSelector('.dash-header [data-address]',{timeout:15_000});
 const calls=await page.evaluate(()=>window.__walletCalls);
 const add=calls.find(c=>c.method==='wallet_addEthereumChain')?.params?.[0];
 ok('wallet asked to add chain 46630 with the testnet parameters',JSON.stringify(add)===JSON.stringify({chainId:CHAIN_HEX,chainName:'Robinhood Chain Testnet',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:['https://rpc.testnet.chain.robinhood.com'],blockExplorerUrls:['https://explorer.testnet.chain.robinhood.com']}),JSON.stringify(add));
 ok('badge still shown once connected',await page.locator('.dash-header .dash-fork-label.testnet').count()===1);
 await page.screenshot({path:path.join(SHOTS,'03-connected.png'),fullPage:true});
 const refused=await page.evaluate(()=>window.__refused);
 ok('nothing signed or sent by the wallet',!refused.some(m=>/send|sign/i.test(m)),refused.join(','));
 allErrors.push(...errors);allSent.push(...sent);
 await context.close();
});

await step('phone width',async()=>{
 const {page,context,errors,sent}=await newPage({width:390,height:844});
 for(const t of ['overview','trade','positions']){await page.goto(`${base}/dashboard?tab=${t}`,{waitUntil:'load'});await settle(page);
  const w=await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth));ok(`390px ${t}`,w===390,`scrollWidth ${w}`);
  if(t==='overview')ok('390px badge visible',await page.locator('.dash-header .dash-fork-label.testnet').isVisible());
  await page.screenshot({path:path.join(SHOTS,`04-phone-${t}.png`),fullPage:true})}
 allErrors.push(...errors);allSent.push(...sent);
 await context.close();
});

if(MOCK)await step('mismatch banner is not vacuous (API reports mainnet 4663)',async()=>{
 const {page,context}=await newPage({reportChain:4663});
 await page.goto(base+'/dashboard?tab=overview',{waitUntil:'load'});await settle(page);
 ok('API on 4663 with the testnet site: Network mismatch banner shown',/Network mismatch/.test(await text(page)));
 await context.close();
});

ok('no transaction or intent requests left the page',allSent.length===0,allSent.join(' '));
ok('console clean through the run',allErrors.length===0,allErrors.join(' | ').slice(0,400));
await writeFile(path.join(SHOTS,'results.txt'),results.join('\n')+'\n');
await browser.close();await cleanup();
console.log(`testnet-check${MOCK?' (--mock)':''}: ${results.length-failures}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(failures?1:0);
