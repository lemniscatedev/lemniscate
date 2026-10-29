// Headless browser checks for todo 18 (R1-R4, R7, R9, R10, R12, R15, R16).
//  A. Shipped config (no API): all 18 routes at 390 px, no console errors, no page errors, scrollWidth == 390;
//     every dashboard tab too; no template leftovers in the rendered text.
//  B. API unreachable (apiBase pointing at a closed port): dashboard tabs degrade gracefully, no page errors.
//  C. Mock API (scripts/mock-api.mjs) + a fake EIP-6963 wallet: wallet picker, API-backed chain, cost-first copy,
//     buy -> position -> sell, Shield, pool, session/earnings/split/halt states, every tab at 390 px.
//  D. ?demo=1 shows the "Demo, not real funds" label.
// Run: npm run test:browser
import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {startMockApi} from './mock-api.mjs';

const WIDTH=390,HEIGHT=844,SITE_PORT=Number(process.env.SITE_PORT||4191),API_PORT=Number(process.env.API_PORT||4192);
const routes=JSON.parse(await readFile('scripts/routes.json','utf8'));
const TABS=['overview','trade','positions','shield','pool','agents','activity','settings'];
const LEFTOVERS=[/250k\+/,/1\.8M\+/,/Email conversion/,/4\.9-star/,/Work Period/,/Redefine Flow/,/Hypertech/,/\bAlongside\b/,/\bRecap\b/,/Career at/,/Alisha Patel/,/UX writing/,/\boverview[’']s\b/i,/The overview/,/The specification/,/supplied overview/,/under the design/,/\bHOOD\b/,/Robinhood ·/];
const results=[];let failures=0;
const ok=(name,pass,detail='')=>{const line=`${pass?'PASS':'FAIL'} ${name}${detail?' :: '+detail:''}`;results.push(line);console.log(line);if(!pass)failures++};
const section=async(name,fn)=>{try{await fn()}catch(error){ok(`${name} crashed`,false,String(error.message||error).split('\n')[0])}};

// ---- static server for dist (same behaviour as serve.mjs)
const root=path.resolve('dist');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.woff':'font/woff','.framercms':'application/octet-stream'};
const site=http.createServer(async(req,res)=>{try{const p=decodeURIComponent(new URL(req.url,'http://x').pathname);let f=path.resolve(root,'.'+p);if(f!==root&&!f.startsWith(root+path.sep))throw 0;if((await stat(f)).isDirectory())f=path.join(f,'index.html');const b=await readFile(f);res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});res.end(b)}catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('Page not found')}});
await new Promise(r=>site.listen(SITE_PORT,'127.0.0.1',r));
const overrides={};
const mock=await startMockApi({port:API_PORT,overrides,seed:true});
const base=`http://127.0.0.1:${SITE_PORT}`;
const shippedConfig=await readFile('dist/config.js','utf8');
const configWith=(apiBase,extra={})=>{let c=shippedConfig.replace(/apiBase:'[^']*'/,`apiBase:'${apiBase}'`);for(const [k,v] of Object.entries(extra))c=c.replace(new RegExp(k+':[^,}]*'),`${k}:${v}`);return c};

const FAKE_WALLET=`(()=>{const ACCOUNT='0x00000000000000000000000000000000000a11ce';let n=0;
 const provider={isFake:true,request:async({method,params})=>{
  if(method==='eth_requestAccounts'||method==='eth_accounts')return [ACCOUNT];
  if(method==='eth_chainId')return '0x1237';
  if(method==='wallet_switchEthereumChain')return null;
  if(method==='eth_call'){const m=window.__calls&&window.__calls[(params[0].data||'').slice(0,10)];const v=typeof m==='function'?m(params[0].data):m;return v||'0x'+'0'.repeat(64)}
  if(method==='eth_blockNumber')return '0x10';
  if(method==='eth_getBalance')return window.__eth||'0x0';
  if(method==='eth_getLogs')return [];
  if(method==='eth_sendTransaction'){window.__sent=(window.__sent||[]).concat(params[0]);const h='0x'+(BigInt(Date.now())*1000n+BigInt(++n)).toString(16).padStart(64,'0');await fetch('http://127.0.0.1:${API_PORT}/__test/settle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:params[0].data,hash:h})});return h}
  if(method==='personal_sign'){const hex=params[0].slice(2);const msg=new TextDecoder().decode(Uint8Array.from(hex.match(/../g)||[],b=>parseInt(b,16)));if(window.__rejectLaneProof&&/Action: sell-lane/.test(msg))throw Object.assign(new Error('User rejected the request.'),{code:4001});window.__signed=(window.__signed||[]).concat(msg);return '0x'+'11'.repeat(65)}
  if(method==='eth_getTransactionReceipt')return {status:'0x1',transactionHash:params[0],blockNumber:'0x10',logs:window.__receiptLogs||[]};
  throw Object.assign(new Error('unsupported '+method),{code:4200})},on(){},removeListener(){}};
 const info={uuid:'test-wallet-uuid',name:'Test Wallet',icon:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',rdns:'test.wallet'};
 const announce=()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:Object.freeze({info,provider})}));
 window.addEventListener('eip6963:requestProvider',announce);announce();})();`;

const browser=await chromium.launch();
// apiBase '' (the default) = the offline site: the shipped config.js now names the live API, which a local check must never
// call. null keeps the shipped config. The public CHANGELOG (read by /roadmap) is served empty unless a test routes it.
async function newPage({apiBase='',declared=true,wallet=false,config={},account=null,js=true}={}){
 const context=await browser.newContext({viewport:{width:WIDTH,height:HEIGHT},deviceScaleFactor:1,javaScriptEnabled:js});
 await context.route('https://raw.githubusercontent.com/**',r=>r.fulfill({status:200,contentType:'text/plain',headers:{'access-control-allow-origin':'*'},body:'# Changelog\n'}));
 if(apiBase!==null)await context.route('**/config.js*',route=>route.fulfill({status:200,contentType:'application/javascript',body:configWith(apiBase,config)}));
 if(declared)await context.addInitScript(()=>{try{localStorage.setItem('lemniscate.region.v1',JSON.stringify({resident:false,at:1}))}catch{}});
 if(wallet)await context.addInitScript(account?FAKE_WALLET.replaceAll('0x00000000000000000000000000000000000a11ce',account):FAKE_WALLET);
 const page=await context.newPage();
 const errors=[],network=[];
 page.on('pageerror',e=>errors.push('pageerror: '+e.message));
 page.on('console',m=>{if(m.type()==='error'){const t=m.text();(/Failed to load resource|net::ERR_/.test(t)?network:errors).push(t)}});
 return {page,context,errors,network};
}
async function settle(page){
 await page.waitForFunction(()=>document.documentElement.dataset.lmLoading==='false'||!document.querySelector('.lm-loader'),null,{timeout:20_000}).catch(()=>{});
 await page.waitForTimeout(700);
}
const width=page=>page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth));
const text=page=>page.evaluate(()=>document.body.innerText);

// ---- A. shipped config: all routes and dashboard tabs
await section('A',async()=>{
 for(const route of routes){
  const {page,context,errors,network}=await newPage();
  await page.goto(base+route,{waitUntil:'load'});await settle(page);
  if(route==='/'||route.startsWith('/markets')||route.startsWith('/learn')){await page.evaluate(async()=>{for(let y=0;y<document.body.scrollHeight;y+=600){scrollTo(0,y);await new Promise(r=>setTimeout(r,60))}scrollTo(0,0)});await page.waitForTimeout(500)}
  const w=await width(page),t=await text(page),left=LEFTOVERS.filter(re=>re.test(t)).map(String);
  ok(`A route ${route} 390px`,w===WIDTH,`scrollWidth ${w}`);
  ok(`A route ${route} console`,errors.length===0&&network.length===0,[...errors,...network].join(' | ').slice(0,300));
  ok(`A route ${route} no template leftovers`,left.length===0,left.join(','));
  if(route==='/markets/upside')ok('A market detail shows product stats',/Expiry dates/.test(t),'');
  await context.close();
 }
 for(const t of TABS){
  const {page,context,errors,network}=await newPage();
  await page.goto(`${base}/dashboard?tab=${t}`,{waitUntil:'load'});await settle(page);
  const w=await width(page),body=await text(page);
  ok(`A dashboard ${t} 390px`,w===WIDTH,`scrollWidth ${w}`);
  ok(`A dashboard ${t} console`,errors.length===0&&network.length===0,[...errors,...network].join(' | ').slice(0,300));
  ok(`A dashboard ${t} offline state`,/Live data is not available/.test(body)&&!/25,000\.00/.test(body),'');
  await context.close();
 }
 // Region gate
 const {page,context}=await newPage({declared:false});
 await page.goto(`${base}/dashboard?tab=trade`,{waitUntil:'load'});await settle(page);
 ok('A region gate asks first',/Before you continue/.test(await text(page))&&/United Kingdom, Canada or Switzerland/.test(await text(page)),'');
 await page.click('[data-action="region-blocked"]');await page.waitForTimeout(200);
 ok('A region gate blocks',/Not available in your region/.test(await text(page)),'');
 await context.close();
});

// ---- B. API unreachable
await section('B',async()=>{
 for(const t of ['overview','trade','pool']){
  const {page,context,errors,network}=await newPage({apiBase:'http://127.0.0.1:9'});
  await page.goto(`${base}/dashboard?tab=${t}`,{waitUntil:'load'});await settle(page);await page.waitForTimeout(800);
  const body=await text(page);
  ok(`B unreachable ${t} graceful`,/Live data is unavailable right now/.test(body),body.slice(0,120).replace(/\n/g,' '));
  ok(`B unreachable ${t} no page errors`,errors.length===0,errors.join(' | ').slice(0,300));
  ok(`B unreachable ${t} 390px`,(await width(page))===WIDTH,'');
  results.push(`INFO B unreachable ${t}: ${network.length} browser network error line(s) (the failed fetch itself, logged by Chromium)`);
  await context.close();
 }
});

// ---- C. mock API + fake wallet
await section('C',async()=>{
 const {page,context,errors,network}=await newPage({apiBase:`http://127.0.0.1:${API_PORT}`,wallet:true});
 overrides.session='REGULAR';
 await page.goto(`${base}/dashboard?tab=trade`,{waitUntil:'load'});await settle(page);
 await page.waitForSelector('.dash-chain-table',{timeout:10_000});
 let body=await text(page);
 ok('C chain from API',/NVIDIA/.test(body)&&/\$180\.00/.test(body),'');
 await page.waitForFunction(()=>/Purchase amount/.test(document.querySelector('#quote-summary')?.innerText||''),null,{timeout:10_000}).catch(()=>{});
 body=await page.locator('#quote-summary').innerText();
 ok('C cost first: costs about $X/day',/Costs about \$\d+\.\d\d\/day/.test(body),body.slice(0,80).replace(/\n/g,' '));
 ok('C cost first: pays off if NVDA is above',/pays off if NVDA is above \$\d/.test(body),'');
 ok('C cost before Greeks',body.indexOf('Costs about')<body.indexOf('Greeks'),'');
 ok('C no local balance seed',!/25,000/.test(await text(page)),'');
 // wallet picker
 await page.click('.dash-header [data-action="connect"]');await page.waitForSelector('.dash-wallet-option');
 const options=await page.locator('.dash-wallet-option').allInnerTexts();
 ok('C wallet picker lists EIP-6963 wallet and WalletConnect',options.some(o=>/Test Wallet/.test(o))&&options.some(o=>/WalletConnect/.test(o)),options.join(' / ').replace(/\n/g,' '));
 await page.locator('.dash-wallet-option',{hasText:'Test Wallet'}).click();
 await page.waitForSelector('.dash-header [data-address]',{timeout:5_000}).catch(()=>{});
 ok('C wallet connected chip',(await page.locator('.dash-header [data-address]').getAttribute('data-address').catch(()=>''))==='0x00000000000000000000000000000000000a11ce','');
 // buy
 await page.waitForSelector('[data-action="review"]:not([disabled])',{timeout:10_000});
 await page.click('[data-action="review"]');
 ok('C buy review: the 30-minute hold and no-gift rule are stated (R02)',/cannot be transferred for 30 minutes/.test(await page.locator('dialog[open]').first().innerText().catch(()=>'')),'');
 await page.click('[data-action="confirm-buy"]');
 await page.waitForFunction(()=>/Done\./.test(document.querySelector('#tx-status')?.innerText||''),null,{timeout:15_000}).catch(()=>{});
 const sent=await page.evaluate(()=>window.__sent||[]);
 ok('C buy: approve then engine call',sent.length===2&&sent[0].data.startsWith('0x095ea7b3')&&sent[1].to==='0x00000000000000000000000000000000000000e1',sent.map(s=>s.data.slice(0,10)).join(','));
 await page.keyboard.press('Escape');
 await page.goto(`${base}/dashboard?tab=positions`,{waitUntil:'load'});await settle(page);
 await page.waitForSelector('.dash-position',{timeout:10_000}).catch(()=>{});
 body=await text(page);
 ok('C position from API',/NVDA Up/.test(body)&&/Weekly · Strike \$180\.00/.test(body),'');
 ok('C positions 390px',(await width(page))===WIDTH,'');
 // R02: a sell inside the hold shows which tokens are held and how they are priced; the quote is asked for this account
 overrides.hold={until:new Date(Date.now()+20*60_000).toISOString(),buyPrice:'190',applied:true,tokens:'2'};
 await page.click('[data-action="sell"]');await page.waitForFunction(()=>/Proceeds after spread/.test(document.querySelector('#sell-summary')?.innerText||''),null,{timeout:8_000}).catch(()=>{});
 ok('C sell inside the hold explains it (R02)',/2 of these tokens/.test(await page.locator('#sell-summary').innerText().catch(()=>'')),'');
 delete overrides.hold;
 await page.keyboard.press('Escape');
 // revert reasons from the engine are shown in plain words (R02 HeldTokens / NotOwnBuy, Slippage)
 const decoded=await page.evaluate(async()=>{const W=await import('/chain/wallet.js?v=11');return [
  W.walletErrorText({message:'execution reverted',data:'0xb12fb612'+'0'.repeat(56)+'6553f100'}),
  W.walletErrorText({message:'Internal JSON-RPC error.',cause:{data:{data:'0xda7512ac'}}}),
  W.walletErrorText({message:'execution reverted: custom error 0x2746152a'+'0'.repeat(128)})]});
 ok('C engine reverts decoded',/cannot be transferred yet/.test(decoded[0])&&/your own wallet/.test(decoded[1])&&/slippage limit/.test(decoded[2]),decoded.join(' | '));
 // sell in a halt: queued notice
 overrides.session='HALTED';
 await page.click('[data-action="sell"]');await page.waitForFunction(()=>/Proceeds after spread/.test(document.querySelector('#sell-summary')?.innerText||''),null,{timeout:8_000}).catch(()=>{});
 ok('C halted sell shows queue notice',/sells join a queue/.test(await page.locator('#sell-summary').innerText()),'');
 await page.click('[data-action="confirm-sell"]');
 await page.waitForFunction(()=>/Done\./.test(document.querySelector('#tx-status')?.innerText||''),null,{timeout:15_000}).catch(()=>{});
 ok('C sell sent (always available)',(await page.evaluate(()=>(window.__sent||[]).length))===1,'');
 await page.keyboard.press('Escape');
 // closed session: buys blocked with a plain reason, off-hours spread note
 overrides.session='CLOSED';
 await page.goto(`${base}/dashboard?tab=trade`,{waitUntil:'load'});await settle(page);await page.waitForSelector('.dash-chain-table');
 body=await text(page);
 ok('C closed: plain session note',/The market is closed\. New buys are paused/.test(body),'');
 ok('C closed: buy disabled with reason',/New purchases are closed while the market is closed/.test(body)&&await page.locator('[data-action="review"]').isDisabled(),'');
 // overnight is EXTENDED with buys allowed
 overrides.session='EXTENDED';
 await page.goto(`${base}/dashboard?tab=trade`,{waitUntil:'load'});await settle(page);await page.waitForSelector('.dash-chain-table');
 await page.waitForSelector('[data-action="review"]:not([disabled])',{timeout:10_000}).catch(()=>{});
 body=await text(page);
 ok('C extended: buys allowed, caps-halved note',/position caps are halved/.test(body)&&!(await page.locator('[data-action="review"]').isDisabled()),'');
 // earnings and split
 overrides.session='REGULAR';overrides.earnings=['TSLA'];overrides.splitPause=['AAPL'];
 await page.click('[data-action="market"][data-market="TSLA"]');await page.waitForTimeout(900);
 body=await text(page);
 ok('C earnings buy block shown',/Earnings: new buys on TSLA are paused/.test(body)&&/earnings report/.test(body),'');
 await page.click('[data-action="market"][data-market="AAPL"]');await page.waitForTimeout(900);
 body=await text(page);
 ok('C split buy pause shown',/split is pending on AAPL/.test(body),'');
 overrides.earnings=[];overrides.splitPause=[];
 // Shield: listed strikes only, default about 10% below, Weekly
 await page.goto(`${base}/dashboard?tab=shield`,{waitUntil:'load'});await settle(page);
 await page.waitForSelector('[data-action="shield-level"]',{timeout:10_000});
 const levels=await page.locator('[data-action="shield-level"]').allInnerTexts();
 const active=await page.locator('[data-action="shield-level"].active').innerText();
 ok('C shield strikes are listed Weekly puts below spot',levels.length===2&&levels.every(l=>/below/.test(l)),levels.join(' / ').replace(/\n/g,' '));
 ok('C shield default 10% below',/\$162\.00/.test(active),active);
 await page.waitForSelector('[data-action="review-shield"]:not([disabled])',{timeout:10_000}).catch(()=>{});
 await page.click('[data-action="review-shield"]');await page.click('[data-action="confirm-shield"]');
 await page.waitForFunction(()=>/Done\./.test(document.querySelector('#tx-status')?.innerText||''),null,{timeout:15_000}).catch(()=>{});
 ok('C shield sent: approve + shield',(await page.evaluate(()=>(window.__sent||[]).length))===2,String(await page.evaluate(()=>(window.__sent||[]).length)));
 await page.keyboard.press('Escape');
 // pool: numbers from API, deposits disabled for non-allowlisted, risk text
 await page.goto(`${base}/dashboard?tab=pool`,{waitUntil:'load'});await settle(page);await page.waitForTimeout(800);
 body=await text(page);
 ok('C pool NAV from API',/\$1\.25M/.test(body)&&/\$1,840\.00/.test(body)&&/\$1\.0184/.test(body)&&!/\$2\.00M/.test(body),body.replace(/\n/g,' ').slice(0,600));
 ok('C pool shows no deposit cap (mainnet is unlimited)',/No deposit cap/.test(body)&&!/launch cap/.test(body),'');
 ok('C pool funding received wording',/Funding received, last 24 h/.test(body)&&/Writers can lose more than they earn/.test(body),'');
 ok('C pool deposits gated by allowlist',/allowlisted writers/.test(body)&&await page.locator('[data-action="pool-review"]').isDisabled(),'');
 await page.click('[data-action="pool-mode"][data-mode="withdraw"]');
 ok('C pool pro-rata exit note',/pro rata/.test(await text(page)),'');
 // every tab at 390 px with live data
 for(const t of TABS){
  await page.goto(`${base}/dashboard?tab=${t}`,{waitUntil:'load'});await settle(page);await page.waitForTimeout(500);
  ok(`C live ${t} 390px`,(await width(page))===WIDTH,`scrollWidth ${await width(page)}`);
 }
 // activity: server feed (todo 18b R1), newest first, cursor paging, no duplicate of the browser's own receipts
 await page.goto(`${base}/dashboard?tab=activity`,{waitUntil:'load'});await settle(page);
 await page.waitForSelector('.dash-activity-row',{timeout:10_000});
 const activity=await text(page);
 ok('C activity has receipts',/Receipt/.test(activity)&&/NVDA Up/.test(activity),'');
 ok('C activity from API: first page of 20, newest first',(await page.locator('.dash-activity-row').count())===20&&/Bought · NVDA Up/.test(activity)&&/Sold · NVDA Up/.test(activity)&&activity.indexOf('Bought')<activity.indexOf('Pool deposit'),String(await page.locator('.dash-activity-row').count()));
 ok('C activity: own sends not listed twice',!/waiting to appear/.test(activity),'');
 ok('C activity: Load older activity present',await page.locator('[data-action="activity-more"]').count()===1,'');
 await page.click('[data-action="activity-more"]');await page.waitForFunction(()=>document.querySelectorAll('.dash-activity-row').length>20,null,{timeout:8_000}).catch(()=>{});
 const rowsAfter=await page.locator('.dash-activity-row').count();
 const links=await page.locator('.dash-activity-row a.receipt').evaluateAll(a=>a.map(x=>x.href));
 ok('C activity: next page adds the rest with no overlap',rowsAfter===28&&new Set(links).size===links.length&&await page.locator('[data-action="activity-more"]').count()===0,`${rowsAfter} rows, ${new Set(links).size} unique, dup ${links.filter((x,i)=>links.indexOf(x)!==i).join(',')}`);
 ok('C activity 390px with pages',(await width(page))===WIDTH,'');
 // agents: policies and trades from the API (todo 18b R2), nothing from local storage
 await page.goto(`${base}/dashboard?tab=agents`,{waitUntil:'load'});await settle(page);
 await page.waitForSelector('.dash-policy',{timeout:10_000}).catch(()=>{});
 const agentsText=await text(page);
 ok('C agents: policies from API',(await page.locator('.dash-policy').count())===2&&/Active/.test(agentsText)&&/Revoked/.test(agentsText)&&/\$380\.00/.test(agentsText),'');
 ok('C agents: trades from API',/Buy by 0x0000…9e01/.test(agentsText)&&/Sell by 0x0000…9e01/.test(agentsText)&&/NVDA Up · Weekly/.test(agentsText),agentsText.slice(agentsText.indexOf('Agent trades'),agentsText.indexOf('Agent trades')+300).replace(/\n/g,' '));
 ok('C agents: allowed names as chips',(await page.locator('.dash-policy .dash-name-chip').allTextContents()).join(',')==='NVDA,TSLA','');
 ok('C agents: revoke only on a live policy',(await page.locator('[data-action="revoke-policy"]').count())===1,'');
 ok('C agents: no local policy list',await page.evaluate(()=>localStorage.getItem('lemniscate.policies.v2')===null),'');
 ok('C agents 390px',(await width(page))===WIDTH,'');
 await page.click('[data-action="create-policy"]');await page.waitForSelector('#policy-agent');
 await page.fill('#policy-agent','0x00000000000000000000000000000000000a9e03');await page.fill('#policy-budget','321');
 await page.keyboard.press('Escape');
 await page.goto(`${base}/dashboard?tab=agents`,{waitUntil:'load'});await settle(page);await page.waitForSelector('[data-action="create-policy"]:not([disabled])',{timeout:10_000}).catch(()=>{});
 await page.click('[data-action="create-policy"]');await page.waitForSelector('#policy-agent');
 ok('C agents: unsent form kept as a draft',(await page.inputValue('#policy-agent'))==='0x00000000000000000000000000000000000a9e03'&&(await page.inputValue('#policy-budget'))==='321','');
 ok('C live console clean',errors.length===0&&network.length===0,[...errors,...network].join(' | ').slice(0,400));
 await context.close();
});

// ---- E. one-tap: the smart account address comes from the API (todo 18b R3)
await section('E',async()=>{
 const {page,context,errors}=await newPage({apiBase:`http://127.0.0.1:${API_PORT}`,wallet:true,config:{oneTap:'true'}});
 overrides.session='REGULAR';delete overrides.smartDeployed;
 await page.goto(`${base}/dashboard?tab=settings`,{waitUntil:'load'});await settle(page);
 await page.waitForSelector('.dash-header [data-action="connect"]',{timeout:10_000});
 await page.click('.dash-header [data-action="connect"]');await page.waitForSelector('.dash-wallet-option');
 await page.locator('.dash-wallet-option',{hasText:'Test Wallet'}).click();
 await page.waitForFunction(()=>/Filled in from your wallet/.test(document.querySelector('#smart-note')?.innerText||''),null,{timeout:10_000}).catch(()=>{});
 let note=await page.locator('#smart-note').innerText().catch(()=>'');
 ok('E smart account filled in from the API, not deployed',/Filled in from your wallet: 0x5a00…11ce/.test(note)&&/not deployed yet/.test(note),note);
 ok('E field is empty (no manual paste), placeholder shows the address',(await page.inputValue('#smart-account'))===''&&(await page.getAttribute('#smart-account','placeholder'))==='0x5a'+'0x00000000000000000000000000000000000a11ce'.slice(4),await page.getAttribute('#smart-account','placeholder'));
 overrides.smartDeployed=true;
 await page.click('[data-action="save-settings"]');await page.waitForTimeout(800);
 note=await page.locator('#smart-note').innerText();
 ok('E deployed state shown',/It is deployed/.test(note),note);
 await page.fill('#smart-account','0x00000000000000000000000000000000000b0b01');await page.click('[data-action="save-settings"]');await page.waitForTimeout(500);
 note=await page.locator('#smart-note').innerText();
 ok('E manual override wins',/Using the address you entered/.test(note),note);
 ok('E settings 390px with one-tap',(await width(page))===WIDTH,'');
 ok('E console clean',errors.length===0,errors.join(' | ').slice(0,300));
 delete overrides.smartDeployed;
 await context.close();
});

// ---- F. invite codes (closed beta): gate on, redeem with a signed message, then buy; sells never gated
await section('F',async()=>{
 const A='0x00000000000000000000000000000000000a11ce';
 overrides.invites=true;overrides.session='REGULAR';mock.approved.clear();
 const api=`http://127.0.0.1:${API_PORT}`;
 const post=(kind,body)=>fetch(`${api}/v1/intent/${kind}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const sid=[...mock.market.series.keys()][0];
 const buyDirect=await post('buy',{series:sid,units:'1',account:A});
 ok('F API refuses buy for an unapproved wallet',buyDirect.status===403&&(await buyDirect.json()).error==='INVITE_REQUIRED','');
 ok('F API never gates a sell',(await post('sell',{series:sid,units:'1',account:A})).status===200,'');
 const {page,context,errors}=await newPage({apiBase:api,wallet:true});
 await page.goto(`${base}/dashboard?tab=trade`,{waitUntil:'load'});await settle(page);await page.waitForSelector('.dash-chain-table',{timeout:10_000});
 await page.waitForSelector('.dash-invite',{timeout:8_000}).catch(()=>{});
 ok('F invite banner shown before trading',/Invite-only for now/.test(await text(page)),'');
 ok('F banner 390px',(await width(page))===WIDTH,'');
 await page.click('.dash-header [data-action="connect"]');await page.waitForSelector('.dash-wallet-option');
 await page.locator('.dash-wallet-option',{hasText:'Test Wallet'}).click();
 await page.waitForSelector('.dash-header [data-address]',{timeout:5_000}).catch(()=>{});
 await page.click('.dash-invite [data-action="invite"]');await page.waitForSelector('#invite-code',{timeout:5_000});
 ok('F invite sheet 390px',(await width(page))===WIDTH,'');
 await page.fill('#invite-code','zzzz-zzzz-zzzz');await page.click('[data-action="invite-redeem"]');
 await page.waitForFunction(()=>!document.querySelector('#invite-error')?.hidden,null,{timeout:5_000}).catch(()=>{});
 ok('F a refused code shows a plain message and nothing is approved',/not valid or has already been used/.test(await page.locator('#invite-error').innerText())&&!mock.approved.has(A),'');
 await page.fill('#invite-code','abcd-efgh-2345');await page.click('[data-action="invite-redeem"]');
 await page.waitForFunction(()=>!document.querySelector('.dash-invite'),null,{timeout:5_000}).catch(()=>{});
 ok('F the right code approves the wallet and the banner goes',mock.approved.has(A)&&!/Invite-only for now/.test(await text(page)),'');
 const signed=(await page.evaluate(()=>window.__signed||[])).join('\n');
 ok('F redemption is a signed message with action, address and chain',/Action: invites\.redeem/.test(signed)&&signed.includes('Address: '+A)&&/Payload: [0-9a-f]{64}/.test(signed)&&/Chain: 4663/.test(signed),signed.slice(0,60).replace(/\n/g,' '));
 ok('F no transaction was sent to redeem',(await page.evaluate(()=>(window.__sent||[]).length))===0,'');
 await page.waitForSelector('[data-action="review"]:not([disabled])',{timeout:10_000});
 await page.click('[data-action="review"]');await page.click('[data-action="confirm-buy"]');
 await page.waitForFunction(()=>/Done\./.test(document.querySelector('#tx-status')?.innerText||''),null,{timeout:15_000}).catch(()=>{});
 ok('F approved wallet can buy',(await page.evaluate(()=>(window.__sent||[]).length))===2,'');
 ok('F console clean',errors.length===0,errors.join(' | ').slice(0,300));
 await context.close();
 overrides.invites=false;mock.approved.clear();
});

// ---- H. one-tap sells carry the sell-lane proof (backend R3-06): signed once, reused, and a declined proof still sells
await section('H',async()=>{
 const A='0x00000000000000000000000000000000000a11ce';
 overrides.session='REGULAR';overrides.invites=false;overrides.userop='busy';overrides.useropBodies=[];
 const run=async({reject=false}={})=>{
  const {page,context,errors}=await newPage({apiBase:`http://127.0.0.1:${API_PORT}`,wallet:true,config:{oneTap:'true'}});
  // The smart account is set to the test wallet's own address so the positions from section C are there to sell.
  await context.addInitScript(([a,r])=>{try{const k='lemniscate.prefs.v2';localStorage.setItem(k,JSON.stringify({...JSON.parse(localStorage.getItem(k)||'{}'),smartAccount:a}))}catch{};if(r)window.__rejectLaneProof=true},[A,reject]);
  await page.goto(`${base}/dashboard?tab=positions`,{waitUntil:'load'});await settle(page);
  await page.click('.dash-header [data-action="connect"]');await page.waitForSelector('.dash-wallet-option');
  await page.locator('.dash-wallet-option',{hasText:'Test Wallet'}).click();
  await page.waitForSelector('.dash-header [data-address]',{timeout:5_000}).catch(()=>{});
  const sell=async()=>{
   await page.waitForSelector('[data-action="sell"]',{timeout:10_000});
   await page.click('[data-action="sell"]');await page.waitForFunction(()=>/Proceeds after spread/.test(document.querySelector('#sell-summary')?.innerText||''),null,{timeout:8_000}).catch(()=>{});
   await page.click('[data-action="confirm-sell"]');
   await page.waitForFunction(()=>/busy right now/.test(document.querySelector('#tx-status')?.innerText||''),null,{timeout:10_000}).catch(()=>{});
   const status=await page.locator('#tx-status').innerText().catch(()=>'');
   await page.keyboard.press('Escape');
   return status;
  };
  return {page,context,errors,sell};
 };
 let s=await run();
 const status=await s.sell();
 ok('H 503 on a one-tap build: short plain message',/One-tap trading is busy right now\. Wait a moment and try again\./.test(status),status.replace(/\n/g,' ').slice(0,160));
 let signed=(await s.page.evaluate(()=>window.__signed||[])).filter(m=>/Action: sell-lane/.test(m));
 const proof=overrides.useropBodies[0]?.laneProof;
 const now=Math.floor(Date.now()/1000);
 ok('H sell-lane message signed in the backend format',signed.length===1&&signed[0]===`Lemniscate wants you to sign this message.\n\nAction: sell-lane\nAccount: ${A}\nExpires: ${proof?.expires}\nChain: 4663`,JSON.stringify(signed));
 ok('H build request carries laneProof {expires, signature}, expiry within 15 minutes',proof?.signature==='0x'+'11'.repeat(65)&&proof.expires>now&&proof.expires<=now+900,JSON.stringify(proof));
 await s.sell();
 signed=(await s.page.evaluate(()=>window.__signed||[])).filter(m=>/Action: sell-lane/.test(m));
 ok('H second sell reuses the cached proof (no new wallet prompt)',signed.length===1&&overrides.useropBodies.length===2&&JSON.stringify(overrides.useropBodies[1].laneProof)===JSON.stringify(proof),`${signed.length} signed, ${overrides.useropBodies.length} builds`);
 const decoded=await s.page.evaluate(async()=>{const m=await import('/chain/api.js?v=11');return [m.sponsorNote({requested:true,granted:false,reason:'NONCE_LANE'}),m.BLOCK_REASON.NONCE_LANE||'',m.sponsorNote({requested:true,granted:true})]});
 ok('H NONCE_LANE denial decoded in plain words',/main lane/.test(decoded[0])&&/pays the network gas/.test(decoded[0])&&/main lane/.test(decoded[1])&&decoded[2]==='',decoded.join(' | '));
 ok('H console clean',s.errors.length===0,s.errors.join(' | ').slice(0,300));
 await s.context.close();
 s=await run({reject:true});
 const before=overrides.useropBodies.length;
 const declined=await s.sell();
 ok('H declined proof: the sell is still built, without laneProof',overrides.useropBodies.length===before+1&&!('laneProof' in overrides.useropBodies[before])&&/busy right now/.test(declined),JSON.stringify(overrides.useropBodies[before]||{}).slice(0,160));
 await s.context.close();
 delete overrides.userop;delete overrides.useropBodies;
});

// ---- D. demo mode
await section('D',async()=>{
 const {page,context,errors}=await newPage();
 await page.goto(`${base}/dashboard?tab=trade&demo=1`,{waitUntil:'load'});await settle(page);await page.waitForSelector('.dash-chain-table',{timeout:10_000});
 const body=await text(page);
 ok('D demo label visible',/Demo, not real funds/.test(body),'');
 ok('D demo 390px',(await width(page))===WIDTH,'');
 ok('D demo console clean',errors.length===0,errors.join(' | '));
 await context.close();
});

// ---- G. token address box (todo 34): hidden until launch.json holds a valid address
await section('G',async()=>{
 const ADDR='0x'+'ab12cd34ef'.repeat(4);
 const shipped=JSON.parse(await readFile('dist/launch.json','utf8'));
 ok('G shipped launch.json has no address',shipped.tokenAddress==='','');
 for(const [name,body,shown] of [['shipped (empty)',null,false],['invalid address',{tokenAddress:'0x1234',tokenSymbol:'LMNS'},false],['valid address',{tokenAddress:ADDR,tokenSymbol:'LMNS',buyUrl:'https://example.org/buy'},true]]){
  for(const route of ['/','/dashboard']){
   const {page,context,errors}=await newPage();
   if(body)await context.route('**/launch.json*',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)}));
   await page.goto(base+route,{waitUntil:'load'});await settle(page);await page.waitForTimeout(500);
   const count=await page.locator('#token-bar').count();
   ok(`G ${name} ${route}: box ${shown?'shown':'hidden'}`,count===(shown?1:0),'count='+count);
   if(shown){
    const box=await page.locator('#token-bar').boundingBox();
    ok(`G ${route} fits 390 px`,box&&box.x>=0&&box.x+box.width<=WIDTH&&(await width(page))===WIDTH,JSON.stringify(box));
    const href=await page.locator('#token-bar .tb-explorer').getAttribute('href');
    ok(`G ${route} Explorer opens the token on Blockscout`,href==='https://robinhoodchain.blockscout.com/token/'+ADDR,href);
    await page.evaluate(()=>{window.__copied=null;Object.defineProperty(navigator,'clipboard',{value:{writeText:t=>{window.__copied=t;return Promise.resolve()}},configurable:true})});
    await page.click('#token-bar button:text("Copy")');
    ok(`G ${route} Copy copies the full address`,(await page.evaluate(()=>window.__copied))===ADDR,'');
    await page.click('#token-bar .tb-close');
    ok(`G ${route} close hides the box`,(await page.locator('#token-bar').count())===0,'');
   }
   ok(`G ${name} ${route} console clean`,errors.length===0,errors.join(' | ').slice(0,300));
   await context.close();
  }
 }
 const wide=await browser.newContext({viewport:{width:1440,height:900}});
 await wide.route('**/launch.json*',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({tokenAddress:ADDR,tokenSymbol:'LMNS'})}));
 const wp=await wide.newPage();const werr=[];wp.on('pageerror',e=>werr.push(e.message));
 await wp.goto(base+'/',{waitUntil:'load'});await wp.waitForSelector('#token-bar',{timeout:10_000}).catch(()=>{});
 ok('G desktop shows the full address',(await wp.locator('#token-bar .tb-full').isVisible().catch(()=>false)),'');
 ok('G desktop no page errors',werr.length===0,werr.join(' | '));
 await wide.close();
});


// ---- I. /contracts page (todo 37 L5)
await section('I',async()=>{
 {
  const {page,context,errors,network}=await newPage();
  // The shipped contracts.json is the mainnet deployment (4663): the page lists its addresses.
  const shipped=JSON.parse(await readFile('dist/contracts.json','utf8'));const engine=shipped.contracts?.engine||'none';
  await page.goto(base+'/contracts',{waitUntil:'load'});await settle(page);
  ok('I /contracts lists the shipped mainnet addresses',(await text(page)).toLowerCase().includes(engine.toLowerCase()),engine);
  ok('I /contracts empty 390px',(await width(page))===WIDTH,'');
  ok('I /contracts empty console clean',errors.length===0&&network.length===0,[...errors,...network].join(' | ').slice(0,300));
  ok('I footer links /contracts and /exit',(await page.locator('#lm-footer a[href="/contracts"]').count())===1&&(await page.locator('#lm-footer a[href="/exit"]').count())===1,'');
  await context.close();
 }
 {
  const {page,context,errors}=await newPage({apiBase:`http://127.0.0.1:${API_PORT}`});
  await context.route('https://sourcify.dev/**',r=>r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({match:'exact_match'})}));
  await page.goto(base+'/contracts',{waitUntil:'load'});await settle(page);await page.waitForSelector('.lm-contract',{timeout:10_000}).catch(()=>{});
  const cards=await page.locator('.lm-contract').count();
  const explorer=await page.locator('.lm-contract a:text("Explorer")').first().getAttribute('href').catch(()=>'');
  const sourcify=await page.locator('.lm-contract a:text("Verified on Sourcify")').first().getAttribute('href').catch(()=>'');
  ok('I /contracts lists every address from /v1/config',cards===4,'cards='+cards);
  ok('I explorer link opens the address on Blockscout',/^https:\/\/robinhoodchain\.blockscout\.com\/address\/0x[0-9a-f]{40}$/.test(explorer),explorer);
  ok('I Sourcify link per contract',/^https:\/\/repo\.sourcify\.dev\/4663\/0x[0-9a-f]{40}$/.test(sourcify)&&(await page.locator('.lm-contract a:text("Verified on Sourcify")').count())===4,sourcify);
  await page.waitForFunction(()=>document.querySelectorAll('[data-state=verified]').length===4,null,{timeout:8000}).catch(()=>{});
  ok('I Sourcify badge shows Verified',(await page.locator('[data-state=verified]').count())===4,'');
  ok('I /contracts with addresses 390px',(await width(page))===WIDTH,'scrollWidth '+await width(page));
  ok('I /contracts with addresses console clean',errors.length===0,errors.join(' | ').slice(0,300));
  await context.close();
 }
});

// ---- J. /exit page (todo 37 L2): static, no scripts, works with JavaScript off and saved locally
await section('J',async()=>{
 const {page,context,errors}=await newPage({js:false});
 const requests=[];page.on('request',r=>requests.push(r.url()));
 await page.goto(base+'/exit',{waitUntil:'load'});
 const body=await text(page);
 ok('J /exit renders with JavaScript off',/How to get your money out if this website is down/.test(body)&&/requestWithdraw\(uint256 shares\)/.test(body)&&/sell\(bytes32 id, uint128 tokens/.test(body),'');
 ok('J /exit 390px',(await width(page))===WIDTH,'scrollWidth '+await width(page));
 ok('J /exit loads nothing but itself',requests.length===1,requests.join(' '));
 ok('J /exit has no script element',(await page.locator('script').count())===0,'');
 await context.close();
 const local=await newPage();
 await local.page.goto('file://'+path.resolve('dist/lemniscate-exit.html'),{waitUntil:'load'});
 ok('J one-file copy renders from file://',/Withdraw from the Writer Pool/.test(await text(local.page)),'');
 ok('J one-file copy 390px',(await width(local.page))===WIDTH,'scrollWidth '+await width(local.page));
 ok('J one-file copy console clean',local.errors.length===0&&errors.length===0,local.errors.join(' | '));
 await local.context.close();
 const wide=await browser.newContext({viewport:{width:1440,height:900}});
 const wp=await wide.newPage();await wp.goto(base+'/exit',{waitUntil:'load'});
 ok('J /exit desktop renders',/Read your position/.test(await wp.evaluate(()=>document.body.innerText)),'');
 await wide.close();
});

// ---- K. guided first trade (todo 37 L1)
await section('K',async()=>{
 const NEW='0x0000000000000000000000000000000000000b0b';
 const open=async(extra={})=>{
  const s=await newPage({apiBase:`http://127.0.0.1:${API_PORT}`,wallet:true,account:NEW,...extra});
  await s.page.goto(`${base}/dashboard?tab=overview`,{waitUntil:'load'});await settle(s.page);
  await s.page.waitForSelector('[data-action="connect"]',{timeout:10_000});
  await s.page.click('.dash-header [data-action="connect"]');await s.page.waitForSelector('.dash-wallet-option');
  await s.page.locator('.dash-wallet-option',{hasText:'Test Wallet'}).click();
  await s.page.waitForSelector('.dash-onb-steps li:nth-child(3).current',{timeout:15_000}).catch(()=>{});
  return s;
 };
 overrides.session='REGULAR';
 let s=await open();
 let t=await s.page.locator('.dash-onboarding').innerText().catch(()=>'');
 ok('K new wallet sees the guided first trade, at the funding step',/Five steps to your first option/.test(t)&&/Add USDG and a little ETH for gas/.test(t)&&t.includes(NEW),t.replace(/\n/g,' | '));
 ok('K funding step states the $1 minimum and the region note',/\$1 /.test(t)&&/United Kingdom, Canada or Switzerland/.test(t),'');
 ok('K open access wording has no invite talk',!/invite/i.test(t),'');
 ok('K onboarding 390px',(await width(s.page))===WIDTH,'scrollWidth '+await width(s.page));
 await s.page.click('[data-action="onb-dismiss"]');
 ok('K dismissing hides it',(await s.page.locator('.dash-onboarding').count())===0,'');
 const stored=await s.page.evaluate(()=>localStorage.getItem('lemniscate.onboarding.v1'));
 ok('K dismissal is stored per wallet',!!stored&&JSON.parse(stored)[NEW]?.dismissed===true,stored);
 await s.page.reload({waitUntil:'load'});await settle(s.page);await s.page.waitForTimeout(1500);
 ok('K dismissal survives a reload',(await s.page.locator('.dash-onboarding').count())===0,'');
 ok('K console clean',s.errors.length===0,s.errors.join(' | ').slice(0,300));
 await s.context.close();
 // an existing trader gets no tour
 s=await newPage({apiBase:`http://127.0.0.1:${API_PORT}`,wallet:true});
 await s.page.goto(`${base}/dashboard?tab=overview`,{waitUntil:'load'});await settle(s.page);
 await s.page.click('.dash-header [data-action="connect"]');await s.page.locator('.dash-wallet-option',{hasText:'Test Wallet'}).click();
 await s.page.waitForTimeout(2000);
 ok('K a wallet with positions gets no tour',(await s.page.locator('.dash-onboarding').count())===0,'');
 await s.context.close();
 // invite-only wording
 overrides.invites=true;
 s=await open();
 t=await s.page.locator('.dash-onboarding').innerText().catch(()=>'');
 ok('K invite-only wording: first 8 hours, then open outside UK, CA, CH',/invite-only for the first 8 hours/.test(t)&&/everyone except residents of the United Kingdom/.test(t),t.slice(0,300).replace(/\n/g,' '));
 ok('K invite-only 390px',(await width(s.page))===WIDTH,'');
 await s.context.close();delete overrides.invites;
 // one-tap sponsorship: ETH becomes optional
 overrides.sponsoring=true;overrides.sponsorMin=8;
 s=await open({config:{oneTap:'true'}});
 t=await s.page.locator('.dash-onboarding').innerText().catch(()=>'');
 ok('K sponsored gas: the fund step says ETH is optional and suggests the API minimum ($8)',/Add USDG$/m.test(t)&&/ETH is optional/.test(t)&&/first trade of \$8/.test(t)&&/\$1 minimum also works/.test(t),t.slice(0,300).replace(/\n/g,' '));
 await s.context.close();delete overrides.sponsorMin;
 s=await open({config:{oneTap:'true'}});
 t=await s.page.locator('.dash-onboarding').innerText().catch(()=>'');
 ok('K sponsored gas without the API field defaults to $5',/first trade of \$5/.test(t),t.slice(0,200));
 await s.context.close();delete overrides.sponsoring;
});


// ---- L. Writer Pool withdrawals use the queue: requestWithdraw -> ticket -> claim (never redeem)
await section('L',async()=>{
 const NEW='0x0000000000000000000000000000000000000b0b';
 const word=n=>BigInt(n).toString(16).padStart(64,'0');
 const {page,context,errors}=await newPage({apiBase:`http://127.0.0.1:${API_PORT}`,wallet:true,account:NEW});
 await context.addInitScript(({me})=>{
  const word=n=>BigInt(n).toString(16).padStart(64,'0');
  window.__claimAt=Math.floor(Date.now()/1000)+259200;
  window.__calls={'0x70a08231':'0x'+word(5e12),'0xc0a096b8':'0x'+word(259200),
   '0x8bba0958':data=>BigInt('0x'+data.slice(10))===7n?'0x'+word(BigInt(me))+word(1e12)+word(window.__claimAt):'0x'+'0'.repeat(192)};
 },{me:NEW});
 const openWithdraw=async()=>{
  await page.waitForSelector('[data-action="pool-mode"][data-mode="withdraw"]',{timeout:10_000});
  await page.click('[data-action="pool-mode"][data-mode="withdraw"]');
 };
 await page.goto(`${base}/dashboard?tab=pool`,{waitUntil:'load'});await settle(page);
 await page.click('.dash-header [data-action="connect"]');await page.locator('.dash-wallet-option',{hasText:'Test Wallet'}).click();
 await openWithdraw();
 let body=await text(page);
 ok('L withdraw tab explains the queue and the wait read from the chain',/Withdrawals use a queue/.test(body)&&/after 3 days/.test(body)&&!/\bredeem\b/i.test(body),'');
 ok('L pool withdraw 390px',(await width(page))===WIDTH,'');
 await page.fill('#pool-amount','1');
 await page.click('[data-action="pool-review"]');
 await page.waitForSelector('[data-action="confirm-pool"]');
 const pool=(await (await fetch(`http://127.0.0.1:${API_PORT}/v1/config`)).json()).contracts.pool;
 await page.evaluate(({me,pool})=>{const w=n=>BigInt(n).toString(16).padStart(64,'0');window.__receiptLogs=[{address:pool,topics:['0xbc1e9f1fe73cadc805864f37c2a9b99bcd6f8d00af936197460f64d127ca91c1','0x'+me.slice(2).padStart(64,'0'),'0x'+w(7)],data:'0x'+w(1e12)+w(window.__claimAt)}]},{me:NEW,pool}); // not-a-key (event topic)
 await page.click('[data-action="confirm-pool"]');
 await page.waitForFunction(()=>/Ticket #7/.test(document.querySelector('#tx-status')?.innerText||''),null,{timeout:15_000}).catch(()=>{});
 const sent=await page.evaluate(()=>window.__sent||[]);
 ok('L withdrawal sends requestWithdraw(shares), not redeem',sent.length===1&&sent[0].data===('0x745400c9'+word(1e12)),JSON.stringify(sent.map(x=>x.data)).slice(0,160));
 ok('L the ticket and its claim time are shown',/Ticket #7/.test(await page.locator('#tx-status').innerText().catch(()=>'')),'');
 ok('L the ticket is saved for this wallet',(await page.evaluate(()=>localStorage.getItem('lemniscate.pool-tickets.v1')||'')).includes('"7"'),'');
 await page.reload({waitUntil:'load'});await settle(page);await openWithdraw();
 await page.waitForSelector('.dash-ticket-row',{timeout:10_000}).catch(()=>{});
 body=await text(page);
 ok('L open ticket listed with claim disabled until it matures',/Ticket #7/.test(body)&&(await page.locator('[data-action="pool-claim"][disabled]').count())===1,'');
 ok('L ticket list 390px',(await width(page))===WIDTH,'');
 await context.addInitScript(()=>{window.__claimAt=Math.floor(Date.now()/1000)-60});
 await page.reload({waitUntil:'load'});await settle(page);await openWithdraw();
 await page.waitForSelector('.dash-ticket-row',{timeout:10_000}).catch(()=>{});
 ok('L a matured ticket is claimable',(await page.locator('[data-action="pool-claim"]:not([disabled])').count())===1,'');
 await page.evaluate(()=>{window.__sent=[]});
 await page.click('[data-action="pool-claim"]');
 await page.waitForFunction(()=>/Done\./.test(document.querySelector('#tx-status')?.innerText||''),null,{timeout:15_000}).catch(()=>{});
 const claim=await page.evaluate(()=>window.__sent||[]);
 ok('L claim sends claim(ticket)',claim.length===1&&claim[0].data==='0x379607f5'+word(7),JSON.stringify(claim.map(x=>x.data)).slice(0,160));
 ok('L pool queue console clean',errors.length===0,errors.join(' | ').slice(0,300));
 await context.close();
});

// ---- M. /roadmap (todo 32): 36 updates by day, LIVE only from the public CHANGELOG.md, never from the clock
await section('M',async()=>{
 const shipped=JSON.parse(await readFile(new URL('../dist/roadmap.json',import.meta.url),'utf8'));
 const SAMPLE='# Changelog\n\nNotes.\n\n## Fix: keep the footer link colour readable\n\n2026-11-01 (UTC) - [commit 0123456789](https://example.invalid)\n\nx\n\n## Update 2: Holding-cost calculator on every option\n\n2026-11-01 (UTC) - [commit abcdef0123](https://example.invalid)\n\ny\n\n## Update 1: Status page\n\n2026-10-31 (UTC) - [commit fedcba9876](https://example.invalid)\n\nz\n';
 const open=async(changelog)=>{
  const {page,context,errors,network}=await newPage();
  const raw=[];
  if(changelog!==undefined){
   await context.route('**/roadmap.json',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...shipped,publicRepo:'example-repo'})}));
   await context.route('https://raw.githubusercontent.com/**',r=>{raw.push(r.request().url());return changelog===null?r.abort():r.fulfill({status:200,contentType:'text/plain',headers:{'access-control-allow-origin':'*'},body:changelog})});
  }
  await page.goto(base+'/roadmap',{waitUntil:'load'});await settle(page);await page.waitForSelector('.lm-roadmap-item',{timeout:10_000}).catch(()=>{});
  return {page,context,errors,network,raw};
 };
 {
  const {page,context,errors,network}=await open(undefined);
  const items=await page.locator('.lm-roadmap-day:not(.lm-roadmap-extras):not(.lm-roadmap-soon) .lm-roadmap-item').count();
  ok('M /roadmap lists all 36 updates',items===36,'items='+items);
  ok('M three days of 12',(await page.locator('.lm-roadmap-day').count())===4&&/Day one[\s\S]*Day two[\s\S]*Day three[\s\S]*Coming soon/i.test(await text(page)),'');
  ok('M before launch nothing is LIVE',(await page.locator('.lm-roadmap-live').count())===0,'');
  ok('M slots read "hour N after launch"',/Day 3, hour 70 after launch/.test(await text(page)),'');
  ok('M /roadmap 390px',(await width(page))===WIDTH,'scrollWidth '+await width(page));
  ok('M /roadmap console clean, no third-party fetch',errors.length===0&&network.length===0,[...errors,...network].join(' | ').slice(0,300));
  ok('M footer links /roadmap',(await page.locator('#lm-footer a[href="/roadmap"]').count())===1,'');
  await context.close();
 }
 {
  const {page,context,errors,raw}=await open(SAMPLE);
  await page.waitForFunction(()=>document.querySelectorAll('.lm-roadmap-live').length>0,null,{timeout:8000}).catch(()=>{});
  const liveN=await page.locator('.lm-roadmap-item.is-live[data-update]').evaluateAll(els=>els.map(e=>Number(e.dataset.update)));
  ok('M LIVE exactly for the changelog entries',JSON.stringify(liveN)==='[1,2]',JSON.stringify(liveN));
  ok('M fixes listed under "Fixes and bonus updates"',/Fixes and bonus updates[\s\S]*keep the footer link colour readable/.test(await text(page)),'');
  ok('M changelog read from the public repo raw URL',raw.length===1&&raw[0]==='https://raw.githubusercontent.com/lemniscatedev/example-repo/main/CHANGELOG.md',raw.join(' '));
  ok('M with LIVE badges 390px',(await width(page))===WIDTH,'');
  ok('M with LIVE badges console clean',errors.length===0,errors.join(' | ').slice(0,300));
  await context.close();
 }
 {
  const {page,context,errors}=await open(null);
  const items=await page.locator('.lm-roadmap-item').count();
  ok('M failed changelog fetch: full timeline, no LIVE badge',items===36&&(await page.locator('.lm-roadmap-live').count())===0,'items='+items);
  ok('M failed fetch no page errors',errors.length===0,errors.join(' | ').slice(0,300));
  await context.close();
 }
});

// ---- Z. zero-seed launch: the Writer Pool starts empty and fills from the public; /writers explains it (390 px)
await section('Z',async()=>{
 overrides.session='REGULAR';overrides.invites=false;overrides.pool='empty';
 const {page,context,errors,network}=await newPage({apiBase:`http://127.0.0.1:${API_PORT}`,wallet:true});
 await page.goto(`${base}/dashboard?tab=trade`,{waitUntil:'load'});await settle(page);
 await page.waitForSelector('.dash-filling',{timeout:10_000}).catch(()=>{});
 let body=await text(page);
 ok('Z empty pool: the chain says the pool is filling',/The pool is filling\. Trading opens as writers deposit\./.test(body)&&/the team does not seed it/.test(body),body.replace(/\n/g,' ').slice(0,300));
 ok('Z empty pool: room per stock shown as not yet',(await page.locator('.dash-filling-list li').count())>=5&&/NVDA\s*not yet/.test(await page.locator('.dash-filling-list').innerText()),'');
 ok('Z empty pool: Become a Writer link',(await page.locator('.dash-filling a[href="/writers"]').count())===1,'');
 await page.waitForFunction(()=>/filling/.test(document.querySelector('#quote-summary')?.innerText||''),null,{timeout:10_000}).catch(()=>{});
 const ticket=await page.locator('#quote-summary').innerText().catch(()=>'');
 ok('Z empty pool: buy shows POOL_FILLING in plain words, no revert text',/The pool is filling\. Trading opens as writers deposit into the Writer Pool\. Selling is never blocked\./.test(ticket)&&!/revert|0x[0-9a-f]{8}|CapExceeded/i.test(ticket),ticket.replace(/\n/g,' ').slice(0,300));
 ok('Z empty pool: buy button disabled',await page.locator('[data-action="review"]').isDisabled(),'');
 ok('Z empty pool: ticket points to Become a Writer',/Become a Writer to add room, or check back later/.test(ticket),'');
 ok('Z empty pool trade 390px',(await width(page))===WIDTH,`scrollWidth ${await width(page)}`);
 const sell=await page.evaluate(async api=>{const c=await (await fetch(api+'/v1/chains/NVDA')).json();const id=c.speeds[0].strikes[0].call.id;const r=await fetch(api+'/v1/intent/sell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({series:id,units:'1',account:'0x00000000000000000000000000000000000a11ce'})});return r.status},`http://127.0.0.1:${API_PORT}`);
 ok('Z empty pool: sells are never blocked',sell===200,String(sell));
 for(const t of ['overview','shield','pool']){
  await page.goto(`${base}/dashboard?tab=${t}`,{waitUntil:'load'});await settle(page);
  await page.waitForSelector('.dash-filling',{timeout:10_000}).catch(()=>{});
  ok(`Z empty pool ${t}: filling panel and 390px`,(await page.locator('.dash-filling').count())===1&&(await width(page))===WIDTH,`scrollWidth ${await width(page)}`);
 }
 ok('Z pool tab links to /writers',(await page.locator('.dash-heading a[href="/writers"]').count())===1,'');
 overrides.pool='filling';
 await page.goto(`${base}/dashboard?tab=trade`,{waitUntil:'load'});await settle(page);
 await page.waitForSelector('.dash-filling',{timeout:10_000}).catch(()=>{});
 body=await page.locator('.dash-filling').innerText().catch(()=>'');
 ok('Z small pool: small trades open, room per stock from the cap math',/small trades are open/.test(body)&&/up to about \$200\.00 per buy/.test(body),body.replace(/\n/g,' ').slice(0,300));
 ok('Z dashboard console clean',errors.length===0&&network.length===0,[...errors,...network].join(' | ').slice(0,300));
 await context.close();

 // /writers with the API: live NAV, the filling state, the rules with Kal's numbers, the wallet's own points
 overrides.pool='empty';
 const w=await newPage({apiBase:`http://127.0.0.1:${API_PORT}`,wallet:true});
 await w.page.goto(`${base}/writers`,{waitUntil:'load'});await settle(w.page);
 await w.page.waitForSelector('[data-writers-rewards]',{timeout:10_000}).catch(()=>{});
 await w.page.fill('#lm-writers-address','0x00000000000000000000000000000000000a11ce');
 await w.page.click('[data-writers-check] button[type="submit"]');
 await w.page.waitForFunction(()=>/Illustrative share/.test(document.querySelector('[data-writers-you]')?.innerText||''),null,{timeout:10_000}).catch(()=>{});
 body=await text(w.page);
 ok('Z /writers 390px',(await width(w.page))===WIDTH,`scrollWidth ${await width(w.page)}`);
 ok('Z /writers explains what the pool does',/sells the options and receives what buyers pay/.test(body),'');
 ok('Z /writers states the risks: NAV can fall, replay worst cases, 3-day queue, 24 h lock',/NAV can fall/.test(body)&&/0\.78/.test(body)&&/3-day withdrawal queue/.test(body)&&/locked for 24 hours/.test(body),'');
 ok('Z /writers live pool numbers and the filling state',/Pool NAV/i.test(body)&&/NAV per share/i.test(body)&&/Total deposited/i.test(body)&&/by 0 wallets/.test(body)&&/The pool is filling/.test(body),body.replace(/\n/g,' ').slice(0,300));
 ok('Z /writers reward rules: 1,000,000 LMNS a week, 8 weeks, 10% cap, 1,000 USDG minimum',/1,000,000 LMNS a week, for 8 weeks/.test(body)&&/at most 10%/.test(body)&&/at least 1,000 USDG/.test(body)&&/not paid out/.test(body),'');
 ok('Z /writers before the token: rewards start when $LMNS launches',/Rewards start when \$LMNS launches/.test(body),'');
 ok('Z /writers region rules',/United Kingdom, Canada or Switzerland/.test(body),'');
 ok('Z /writers no dollar value for LMNS and no yield words',!/LMNS[^.]{0,40}\$\d|\$\d[^.]{0,20}LMNS|\b(APY|APR|yield|income|guaranteed)\b/i.test(body),'');
 ok('Z /writers a wallet sees its own points, labelled illustrative before rewards start',/Illustrative share: 100,000 LMNS \(at the per-wallet cap\)/.test(body)&&/illustrative: the last 7 days/.test(body),'');
 ok('Z /writers says the cap is per wallet with no identity check',/no identity check/.test(body),'');
 ok('Z /writers footer and menu link',(await w.page.locator('#lm-footer a[href="/writers"]').count())>=1,'');
 ok('Z /writers console clean',w.errors.length===0&&w.network.length===0,[...w.errors,...w.network].join(' | ').slice(0,300));
 await w.context.close();

 // /writers with no API (the shipped config): rules still readable, no live numbers
 const n=await newPage();
 await n.page.goto(`${base}/writers`,{waitUntil:'load'});await settle(n.page);
 await n.page.waitForSelector('[data-writers-rewards]',{timeout:10_000}).catch(()=>{});
 body=await text(n.page);
 ok('Z /writers without the API: rules from writer-rewards.json, live numbers explained',/1,000,000 LMNS a week/.test(body)&&/appear here when the site is connected/.test(body)&&(await width(n.page))===WIDTH,'');
 await n.context.close();
 delete overrides.pool;
});

await browser.close();await mock.close();site.close();
console.log(`\n${results.filter(r=>r.startsWith('PASS')).length} passed, ${failures} failed.`);
process.exitCode=failures?1:0;
