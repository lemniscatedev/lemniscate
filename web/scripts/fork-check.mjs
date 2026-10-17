// Playwright through every user flow against the LOCAL ANVIL FORK stack (backend app/scripts/fork/up.sh), with the fork
// profile (config.fork.js) and the dev wallet. Real API, real chain (31337), real transactions; screenshots per step.
//   LM_API_BASE=http://127.0.0.1:3101 LM_RPC_URL=http://127.0.0.1:8545 SHOTS=<dir> node scripts/fork-check.mjs
// The dev wallet (anvil account LM_DEV_INDEX, default 9 = the fork's allowlisted depositor) must hold USDG and a little
// NVDA first: bun scripts/fork/fund.ts <address> --usdg 50000 --stock NVDA=3 (backend app).
import http from 'node:http';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const API=process.env.LM_API_BASE||'http://127.0.0.1:3101';
const RPC=process.env.LM_RPC_URL||'http://127.0.0.1:8545';
const SITE_PORT=Number(process.env.SITE_PORT||7200);
const SHOTS=process.env.SHOTS||path.resolve('fork-shots');
const DEV_INDEX=Number(process.env.LM_DEV_INDEX||9);
await mkdir(SHOTS,{recursive:true});

const results=[];let failures=0;
const ok=(name,pass,detail='')=>{const line=`${pass?'PASS':'FAIL'} ${name}${detail?' :: '+detail:''}`;results.push(line);console.log(line);if(!pass)failures++};
const step=async(name,fn)=>{try{await fn()}catch(error){ok(name,false,String(error.message||error).split('\n')[0])}};

// static server: dist/, with /config.js answered by the fork profile (same substitution as serve.mjs LM_PROFILE=fork)
const root=path.resolve('dist');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.woff2':'font/woff2','.ico':'image/x-icon','.framercms':'application/octet-stream'};
const forkConfig=(await readFile('dist/config.fork.js','utf8')).replace(/apiBase:'[^']*'/,`apiBase:'${API}'`).replace(/rpcUrl:'[^']*'/,`rpcUrl:'${RPC}'`).replace(/devWalletIndex:\d+/,`devWalletIndex:${DEV_INDEX}`);
const site=http.createServer(async(req,res)=>{try{const p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p==='/config.js'){res.writeHead(200,{'Content-Type':types['.js'],'Cache-Control':'no-store'});res.end(forkConfig);return}let f=path.resolve(root,'.'+p);if(f!==root&&!f.startsWith(root+path.sep))throw 0;if((await stat(f)).isDirectory())f=path.join(f,'index.html');const b=await readFile(f);res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});res.end(b)}catch{res.writeHead(404);res.end('Page not found')}});
await new Promise(r=>site.listen(SITE_PORT,'127.0.0.1',r));
const base=`http://127.0.0.1:${SITE_PORT}`;

const rpc=async(method,params=[])=>{const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return (await r.json()).result};
const devAddress=(await rpc('eth_accounts'))[DEV_INDEX].toLowerCase();
const api=async p=>(await fetch(API+p)).json();

const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1});
await context.addInitScript(()=>{try{localStorage.setItem('lemniscate.region.v1',JSON.stringify({resident:false,at:1}))}catch{}});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource|net::ERR_/.test(m.text()))errors.push(m.text())});
let shot=0;
const snap=async name=>{shot++;await page.screenshot({path:path.join(SHOTS,`${String(shot).padStart(2,'0')}-${name}.png`),fullPage:true})};
const settle=async()=>{await page.waitForFunction(()=>!document.querySelector('.lm-loader')||document.documentElement.dataset.lmLoading==='false',null,{timeout:20_000}).catch(()=>{});await page.waitForTimeout(1200)};
const done=async(timeout=90_000)=>{await page.waitForFunction(()=>/Done\.|Policy set\./.test(document.querySelector('#tx-status')?.innerText||''),null,{timeout});};
const body=()=>page.evaluate(()=>document.body.innerText);
const goto=async t=>{await page.goto(`${base}/dashboard?tab=${t}`,{waitUntil:'load'});await settle()};

await step('overview loads from the fork API with the fork badge',async()=>{
 await goto('overview');
 const t=await body();
 ok('overview: fork badge',/Local fork · chain 31337/.test(t));
 ok('overview: live names from the API',/NVDA/.test(t)&&!/Network mismatch/.test(t),t.slice(0,160).replace(/\n/g,' '));
 await snap('overview');
});

await step('connect the dev wallet',async()=>{
 await page.click('.dash-header [data-action="connect"]');
 await page.waitForSelector('.dash-wallet-option');
 const options=await page.locator('.dash-wallet-option').allInnerTexts();
 ok('connect: dev wallet listed on localhost/31337',options.some(o=>/Dev wallet \(local fork\)/.test(o)),options.join(' / ').replace(/\n/g,' '));
 await snap('wallet-picker');
 await page.locator('.dash-wallet-option',{hasText:'Dev wallet'}).click();
 await page.waitForSelector('.dash-header [data-address]',{timeout:10_000});
 const addr=await page.locator('.dash-header [data-address]').getAttribute('data-address');
 ok('connect: chip shows the dev account',addr===devAddress,addr);
 ok('connect: red dev badge',/Dev wallet · local fork/.test(await body()));
 await snap('connected');
});

await step('buy an option (approve + buy, signed by the dev wallet on the fork)',async()=>{
 await goto('trade');
 await page.waitForSelector('.dash-chain-table',{timeout:15_000});
 await page.fill('#order-units','2').catch(()=>{});
 await page.waitForFunction(()=>/Purchase amount/.test(document.querySelector('#quote-summary')?.innerText||''),null,{timeout:20_000});
 await snap('trade-quote');
 await page.waitForSelector('[data-action="review"]:not([disabled])',{timeout:20_000});
 await page.click('[data-action="review"]');await snap('trade-review');
 await page.click('[data-action="confirm-buy"]');
 await done();
 await snap('trade-done');
 await page.keyboard.press('Escape');
 const pos=await (async()=>{for(let i=0;i<30;i++){const p=await api(`/v1/accounts/${devAddress}/positions`);if((p.positions||[]).length)return p;await new Promise(r=>setTimeout(r,2000))}return null})();
 ok('buy: position indexed for the dev wallet',!!pos,pos?`${pos.positions.length} position(s)`:'none');
});

await step('positions and sell',async()=>{
 await goto('positions');
 await page.waitForSelector('.dash-position',{timeout:30_000});
 await snap('positions');
 await page.click('[data-action="sell"]');
 await page.waitForFunction(()=>/Proceeds after spread/.test(document.querySelector('#sell-summary')?.innerText||''),null,{timeout:20_000});
 await snap('sell-review');
 await page.click('[data-action="confirm-sell"]');
 await done();
 await snap('sell-done');
 await page.keyboard.press('Escape');
 ok('sell: done in the wallet flow',true);
});

await step('Shield the NVDA held',async()=>{
 await goto('shield');
 await page.waitForSelector('[data-action="shield-level"]',{timeout:20_000});
 await page.fill('#shield-units','1');
 await page.waitForSelector('[data-action="review-shield"]:not([disabled])',{timeout:20_000});
 await snap('shield');
 await page.click('[data-action="review-shield"]');await page.click('[data-action="confirm-shield"]');
 await done();
 await snap('shield-done');
 await page.keyboard.press('Escape');
 ok('shield: done',true);
});

await step('Writer Pool deposit',async()=>{
 await goto('pool');
 await page.waitForSelector('#pool-amount',{timeout:20_000});
 await page.fill('#pool-amount','1000');
 await page.waitForSelector('[data-action="pool-review"]:not([disabled])',{timeout:20_000});
 await snap('pool');
 await page.click('[data-action="pool-review"]');await page.click('[data-action="confirm-pool"]');
 await done();
 await snap('pool-done');
 await page.keyboard.press('Escape');
 ok('pool: deposit done',true);
});

await step('Agent policy',async()=>{
 await goto('agents');
 await page.waitForSelector('[data-action="create-policy"]:not([disabled])',{timeout:20_000});
 await page.click('[data-action="create-policy"]');await page.waitForSelector('#policy-agent');
 const agent=(await rpc('eth_accounts'))[13];
 await page.fill('#policy-agent',agent);await page.fill('#policy-budget','50');await page.fill('#policy-trade','25');
 await snap('policy-form');
 await page.click('[data-action="confirm-policy"]');
 await done();
 await page.keyboard.press('Escape');
 await goto('agents');
 await page.waitForSelector('.dash-policy',{timeout:60_000});
 await snap('agents');
 ok('agents: policy listed from the API',true);
});

await step('Activity and settings',async()=>{
 await goto('activity');
 await page.waitForSelector('.dash-activity-row',{timeout:60_000});
 ok('activity: rows from the API',(await page.locator('.dash-activity-row').count())>=3,String(await page.locator('.dash-activity-row').count()));
 await snap('activity');
 await goto('settings');await snap('settings');
});

await step('phone width',async()=>{
 await page.setViewportSize({width:390,height:844});
 for(const t of ['overview','positions','trade']){await goto(t);const w=await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth));ok(`390px ${t}`,w===390,`scrollWidth ${w}`);await snap(`mobile-${t}`)}
});

ok('console clean through the run',errors.length===0,errors.join(' | ').slice(0,400));
await writeFile(path.join(SHOTS,'results.txt'),results.join('\n')+'\n');
await browser.close();site.close();
console.log(`fork-check: ${results.length-failures}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(failures?1:0);
