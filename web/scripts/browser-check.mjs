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

const WIDTH=390,HEIGHT=844,SITE_PORT=4191,API_PORT=4192;
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
  if(method==='eth_call')return '0x'+'0'.repeat(64);
  if(method==='eth_blockNumber')return '0x10';
  if(method==='eth_getLogs')return [];
  if(method==='eth_sendTransaction'){window.__sent=(window.__sent||[]).concat(params[0]);const h='0x'+(BigInt(Date.now())*1000n+BigInt(++n)).toString(16).padStart(64,'0');await fetch('http://127.0.0.1:${API_PORT}/__test/settle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:params[0].data,hash:h})});return h}
  if(method==='eth_getTransactionReceipt')return {status:'0x1',transactionHash:params[0],blockNumber:'0x10'};
  throw Object.assign(new Error('unsupported '+method),{code:4200})},on(){},removeListener(){}};
 const info={uuid:'test-wallet-uuid',name:'Test Wallet',icon:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',rdns:'test.wallet'};
 const announce=()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:Object.freeze({info,provider})}));
 window.addEventListener('eip6963:requestProvider',announce);announce();})();`;

const browser=await chromium.launch();
async function newPage({apiBase=null,declared=true,wallet=false,config={}}={}){
 const context=await browser.newContext({viewport:{width:WIDTH,height:HEIGHT},deviceScaleFactor:1});
 if(apiBase!==null)await context.route('**/config.js*',route=>route.fulfill({status:200,contentType:'application/javascript',body:configWith(apiBase,config)}));
 if(declared)await context.addInitScript(()=>{try{localStorage.setItem('lemniscate.region.v1',JSON.stringify({resident:false,at:1}))}catch{}});
 if(wallet)await context.addInitScript(FAKE_WALLET);
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
 await page.click('[data-action="review"]');await page.click('[data-action="confirm-buy"]');
 await page.waitForFunction(()=>/Done\./.test(document.querySelector('#tx-status')?.innerText||''),null,{timeout:15_000}).catch(()=>{});
 const sent=await page.evaluate(()=>window.__sent||[]);
 ok('C buy: approve then engine call',sent.length===2&&sent[0].data.startsWith('0x095ea7b3')&&sent[1].to==='0x00000000000000000000000000000000000000e1',sent.map(s=>s.data.slice(0,10)).join(','));
 await page.keyboard.press('Escape');
 await page.goto(`${base}/dashboard?tab=positions`,{waitUntil:'load'});await settle(page);
 await page.waitForSelector('.dash-position',{timeout:10_000}).catch(()=>{});
 body=await text(page);
 ok('C position from API',/NVDA Up/.test(body)&&/Weekly · Strike \$180\.00/.test(body),'');
 ok('C positions 390px',(await width(page))===WIDTH,'');
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

await browser.close();await mock.close();site.close();
console.log(`\n${results.filter(r=>r.startsWith('PASS')).length} passed, ${failures} failed.`);
process.exitCode=failures?1:0;
