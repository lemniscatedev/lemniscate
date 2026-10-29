// Lemniscate workspace, wired to the Lemniscate API and the user's wallet (todo 18).
// Every market number comes from the API (LM_CONFIG.apiBase); `?demo=1` swaps in labelled offline demo data.
// Option trades use the API intents (unsigned calldata) and are signed in the user's wallet; nothing here holds keys.
import {createApi,plainError,SESSION_LABEL,SESSION_NOTE,BLOCK_REASON,sponsorNote} from '/chain/api.js?v=12';
import {createLaneProofCache} from '/chain/lane-proof.js?v=1';
import {createDemoApi} from '/chain/demo.js?v=11';
import * as W from '/chain/wallet.js?v=12';
import * as Onb from '/chain/onboarding.js?v=2';
import * as PQ from '/chain/pool-queue.js?v=1';
import {regionStatus,declare,regionList} from '/chain/region.js?v=10';
import {call,toRaw,fromRaw,decodeUint,decodeBool,isAddress} from '/chain/abi.js?v=10';

const DEFAULT_CONFIG={apiBase:'',siteUrl:'',walletConnectProjectId:'',appKitUrl:'',chainId:4663,chainName:'Robinhood Chain',rpcUrl:'https://rpc.mainnet.chain.robinhood.com',explorerUrl:'https://robinhoodchain.blockscout.com',oneTap:false,blockedRegions:['GB','CA','CH'],geoEndpoint:''};
const NAME_META={NVDA:['NVIDIA','N','#dfe8d1'],TSLA:['Tesla','T','#e7d8d2'],SPY:['S&P 500 ETF','S','#dce5ef'],QQQ:['Nasdaq 100 ETF','Q','#e5dfec'],AAPL:['Apple','A','#e8e1cc']};
const PREFS_KEY='lemniscate.prefs.v2',RECEIPTS_KEY='lemniscate.receipts.v2',DRAFT_KEY='lemniscate.policy-draft.v1';

window.LM.mountDashboard=function(root,requestedTab){'use strict';
const {icons,esc,fmt,money,modal,closeModal,toast,brand}=window.LM;
const CFG={...DEFAULT_CONFIG,...(window.LM_CONFIG||{})};
const params=new URLSearchParams(location.search);
const DEMO=params.get('demo')==='1';
const api=DEMO?createDemoApi():createApi(CFG.apiBase);
const MODE=DEMO?'demo':api.configured?'live':'offline';
const tabs=[['overview','Overview'],['trade','Option chain'],['positions','Positions'],['shield','Shield'],['pool','Writer Pool'],['agents','Agent desk'],['activity','Activity']];
let tab=requestedTab||params.get('tab')||'overview';if(!tabs.some(x=>x[0]===tab)&&tab!=='settings')tab='overview';
const events=new AbortController();const listen=(type,fn)=>root.addEventListener(type,fn,{signal:events.signal});
const timers=[];let disposed=false;

// ---------------------------------------------------------------- local preferences and receipts (no balances)
const load=(key,fallback)=>{try{const v=JSON.parse(localStorage.getItem(key));return v??fallback}catch{return fallback}};
const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value))}catch{}};
const prefs={slippageBps:50,deadlineSeconds:300,smartAccount:'',...load(PREFS_KEY,{})};
let receipts=DEMO?[]:load(RECEIPTS_KEY,[]);
try{localStorage.removeItem('lemniscate.policies.v2')}catch{}// old browser-local policy list, no longer a source of truth

// ---------------------------------------------------------------- data from the API
const data={config:null,names:[],chains:{},vol:{},corp:{},pool:null,positions:null,account:{},activity:null,agents:null,smart:null,invites:{required:false,approved:null},useropCfg:null,error:null,loading:true};
let region={status:'pending'};
let selected=params.get('name')||'NVDA',side='call',speed='WEEKLY',strike=null,units='10',shieldName=null,shieldUnits='',shieldStrike=null,poolMode='deposit';
let quoteState={key:'',result:null,error:null,loading:false};let quoteTimer=null;

const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
const compact=n=>n>=1e6?'$'+fmt(n/1e6,2)+'M':n>=1e4?'$'+fmt(n/1e3,1)+'k':money(n);
const short=a=>a?a.slice(0,6)+'…'+a.slice(-4):'';
const names=()=>data.config?.names||data.names.map(n=>n.name);
const meta=name=>{const m=NAME_META[name];return {name:m?.[0]||name,glyph:m?.[1]||name[0],color:m?.[2]||'#e8e1cc'}};
const chainOf=name=>data.chains[name]||null;
const speedRows=(name,sp=speed)=>chainOf(name)?.speeds?.find(s=>s.speed===sp)?.strikes||[];
const sessionOf=name=>chainOf(name)?.session||null;
// The smart account: an address typed in Settings wins, otherwise the one the API computes for the connected wallet (todo 18b R3).
const smartAddress=()=>{if(isAddress(prefs.smartAccount))return prefs.smartAccount.toLowerCase();const w=W.wallet().address;return w&&data.smart?.owner===w&&data.smart.address?data.smart.address.toLowerCase():''};
const owner=()=>DEMO?'0x00000000000000000000000000000000000de300':(CFG.oneTap&&smartAddress()?smartAddress():W.wallet().address);
const chainMismatch=()=>!DEMO&&data.config&&Number(data.config.chainId)!==Number(CFG.chainId);
// R3-06: one-tap sells carry the owner's sell-lane proof, signed at most about once per 15 minutes per account and chain.
const laneProofs=createLaneProofCache({sign:message=>W.signMessage(message)});
const explorerTx=hash=>CFG.explorerUrl.replace(/\/$/,'')+'/tx/'+hash;
const qs=extra=>{const p=new URLSearchParams();if(DEMO)p.set('demo','1');for(const [k,v] of Object.entries(extra))p.set(k,v);return '/dashboard?'+p.toString()};

async function loadMarkets(){
 try{
  const [config,list]=await Promise.all([api.config(),api.chains()]);
  data.config=config;data.names=list.names||[];
  if(!names().includes(selected))selected=names()[0];
  shieldName??=selected;
  const results=await Promise.allSettled(names().map(n=>api.chain(n)));
  results.forEach((r,i)=>{if(r.status==='fulfilled')data.chains[names()[i]]=r.value});
  data.pool=await api.pool().catch(()=>data.pool);
  await loadNameExtras(selected);
  data.error=null;
 }catch(error){data.error=plainError(error)}
 data.loading=false;
}
async function loadNameExtras(name){
 const [vol,corp]=await Promise.allSettled([api.vol(name),api.corporateActions?api.corporateActions(name):Promise.resolve([])]);
 if(vol.status==='fulfilled')data.vol[name]=vol.value;
 if(corp.status==='fulfilled')data.corp[name]=corp.value;
}
async function refreshChain(name){try{data.chains[name]=await api.chain(name)}catch{}}
async function loadSmart(){
 const w=W.wallet().address;
 if(DEMO||MODE!=='live'||!CFG.oneTap||!w){if(!w)data.smart=null;return}
 if(data.smart?.owner===w&&data.smart.address&&data.smart.deployed===true)return;
 try{const r=await api.smartAccount(w);data.smart={owner:w,address:r.address,deployed:r.deployed===true}}
 catch(error){data.smart={owner:w,address:'',deployed:false,error:plainError(error)}}
}
/** Server-side activity feed (cursor paging). A refresh keeps extra pages the visitor already loaded. */
async function loadActivity(more=false){
 const who=owner();
 if(!who||MODE!=='live'){data.activity=null;return}
 const cur=data.activity;
 if(more){
  if(cur?.account!==who||!cur.nextCursor)return;
  try{const r=await api.activity(who,{cursor:cur.nextCursor});data.activity={...cur,items:[...cur.items,...r.items],nextCursor:r.nextCursor,pages:cur.pages+1,moreError:null}}
  catch(error){data.activity={...cur,moreError:plainError(error)}}
  return;
 }
 if(cur&&cur.account===who&&cur.pages>1&&!cur.error)return;
 try{const r=await api.activity(who);data.activity={account:who,items:r.items||[],nextCursor:r.nextCursor||null,pages:1,error:null}}
 catch(error){data.activity={account:who,items:[],nextCursor:null,pages:0,error:plainError(error)}}
}
/** Agent policies and agent trades for the connected wallet, read from the indexer (todo 18b R2). */
async function loadAgents(){
 const w=W.wallet().address;
 if(!w||MODE!=='live'){data.agents=null;return}
 try{data.agents=await api.agents(w)}catch(error){data.agents={error:plainError(error)}}
}
async function loadUseropCfg(){
 if(DEMO||MODE!=='live'||!CFG.oneTap||data.useropCfg)return;
 try{data.useropCfg=await api.useropConfig()}catch{data.useropCfg={sponsoring:false}}
}
async function loadAccount(){
 await loadInvites();await loadUseropCfg();
 await loadSmart();
 const who=owner();
 if(!who||MODE==='offline'){data.positions=null;data.account={};data.activity=null;data.agents=null;return}
 await Promise.all([
  api.positions(who).then(r=>{data.positions=r},error=>{data.positions={error:plainError(error)}}),
  loadActivity(),loadAgents(),
 ]);
 if(!DEMO&&data.config)await loadPoolAccount(who);
}
/** QUEUE_DELAY in seconds, read from the pool; null when it cannot be read. */
async function readQueueDelay(pool){try{return Number(decodeUint(await W.ethCall(CFG,pool,call('queueDelay'))))}catch{return null}}
/** Open withdrawal tickets of this wallet. Sources: the activity feed, tickets this browser saved, and WithdrawalQueued logs.
 * Each id is then read with ticketOf, so the chain decides what is still open. */
async function loadTickets(pool,who){
 const fromFeed=(data.activity?.items||[]).filter(i=>i.kind==='withdraw_requested'&&i.ticket!=null).map(i=>i.ticket);
 let fromLogs=[];
 try{
  const logs=await W.getLogs(CFG,{address:pool,fromBlock:'0x0',toBlock:'latest',topics:[PQ.TOPIC_QUEUED,'0x'+who.slice(2).padStart(64,'0')]});
  fromLogs=PQ.queuedFromLogs(logs,pool,who).map(x=>x.id);
 }catch{/* some nodes limit log ranges: the saved and feed tickets still work */}
 const ids=PQ.mergeIds(PQ.readTickets(who),fromFeed,fromLogs);
 const open=[];
 for(const id of ids.slice(0,30)){
  try{const t=PQ.parseTicketOf(await W.ethCall(CFG,pool,call('ticketOf',[['uint',id]])));if(t&&t.owner.toLowerCase()===who.toLowerCase())open.push({id,shares:t.shares,claimableAt:t.claimableAt});else PQ.dropTicket(who,id)}catch{/* keep it for the next read */}
 }
 return open;
}
async function loadPoolAccount(who){
 const pool=data.config.contracts?.pool,usdg=data.config.contracts?.usdg;if(!pool)return;
 try{
  const [shares,unlock,depositor,isPublic,usdgBal]=await Promise.all([
   W.ethCall(CFG,pool,call('balanceOf',[['address',who]])),W.ethCall(CFG,pool,call('unlockTime',[['address',who]])),
   W.ethCall(CFG,pool,call('isDepositor',[['address',who]])),
   W.ethCall(CFG,pool,call('publicDeposits')),usdg?W.ethCall(CFG,usdg,call('balanceOf',[['address',who]])):'0x']);
  const eth=await W.ethBalance(CFG,who).catch(()=>null);
  const s=decodeUint(shares);
  const value=s>0n?decodeUint(await W.ethCall(CFG,pool,call('previewRedeem',[['uint',s]]))):0n;
  const stockBalance={};
  await Promise.all((data.config.stocks||[]).map(async st=>{try{stockBalance[st.name]=decodeUint(await W.ethCall(CFG,st.stock,call('balanceOf',[['address',who]])))}catch{}}));
  data.account={shares:s,value,unlock:Number(decodeUint(unlock)),queueDelay:await readQueueDelay(pool),tickets:await loadTickets(pool,who),depositor:decodeBool(depositor),publicDeposits:decodeBool(isPublic),usdg:decodeUint(usdgBal),eth,stockBalance,error:null};
 }catch{data.account={error:'Your pool balance could not be read from the chain right now.'}}
}

// ---------------------------------------------------------------- small view helpers
function symbol(name){const m=meta(name);return `<span class="dash-symbol" style="background:${m.color}">${esc(m.glyph)}</span>`}
function button(label,action,style='',attrs=''){label=label.replace(/↗|↙|↓|↘|✧|\s\+$/g,()=>window.LM_ICON_SVGS.arrow);return `<button class="lm-button ${style}" data-action="${action}" ${attrs}>${label}</button>`}
function line(label,value){return `<div class="dash-summary-line"><span>${label}</span><strong>${value}</strong></div>`}
function heading(title,sub,actions=''){return `<div class="dash-heading"><div><h1>${title}</h1><p>${sub}</p></div><div class="dash-actions">${actions}</div></div>`}
function empty(title,copy,action='trade',label='Explore options',attrs=''){return `<div class="glass dash-empty"><img src="/assets/lemniscate-mark-v2.webp" alt=""><h2>${title}</h2><p>${copy}</p>${action?button(label,action,'gold',attrs||`data-tab="${action}"`):''}</div>`}
function notice(text,kind=''){return text?`<p class="dash-notice ${kind}" role="status">${esc(text)}</p>`:''}
function chart(values,color='#b8873d',name='portfolio'){const v=values.length>1?values:[values[0]||0,values[0]||0];const min=Math.min(...v),max=Math.max(...v),spread=Math.max(1e-9,max-min);const points=v.map((x,i)=>[i/(v.length-1)*700,150-(x-min)/spread*110]);const d=points.map(([x,y],i)=>(i?'L':'M')+x.toFixed(2)+','+y.toFixed(2)).join(' ');return `<svg class="dash-chart" viewBox="0 0 700 190" preserveAspectRatio="none" role="img" aria-label="${esc(name)} chart"><defs><linearGradient id="area-${name}" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${color}" stop-opacity=".18"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="M0 40H700M0 95H700M0 150H700" stroke="#28324c0c" stroke-dasharray="3 5"/><path d="${d} L700,190 L0,190 Z" fill="url(#area-${name})"/><path class="chart-path" d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`}
function payoffShape(name,isCall,K){const S=num(chainOf(name)?.spot);if(!(S>0&&K>0))return [];return Array.from({length:25},(_,i)=>{const s=S*(.75+i/48);return Math.max(0,isCall?s-K:K-s)})}
function pays(name,isCall,breakeven){return `pays off if ${esc(name)} is ${isCall?'above':'below'} ${money(num(breakeven))}`}
function sessionPill(name){const s=sessionOf(name);return s?`<span class="dash-session" data-session="${s}"><i></i>${SESSION_LABEL[s]||s}</span>`:''}
function sessionNote(name){const s=sessionOf(name);return s?SESSION_NOTE[s]:''}
function blockNotes(name){
 const out=[];const vol=data.vol[name];const now=Date.now();
 for(const sp of vol?.speeds||[]){const l=sp.latest;if(l?.buyBlockFrom&&l?.buyBlockTo){const from=Date.parse(l.buyBlockFrom),to=Date.parse(l.buyBlockTo);if(now<=to&&now>=from-3*86400e3){out.push(`Earnings: new buys on ${name} are paused from ${fmtTime(from)} to ${fmtTime(to)}. Sells stay open.`);break}}}
 for(const c of data.corp[name]||[]){if(/split|merge|multiplier/i.test(c.kind)&&!/done|complete|processed/i.test(c.status))out.push(`A ${c.kind.replace(/_/g,' ')} is pending on ${name}${c.effectiveAt?' ('+fmtTime(Date.parse(c.effectiveAt))+')':''}. New buys pause around it until the new multiplier is in place; sells stay open.`)}
 return out;
}
// ---------------------------------------------------------------- zero-seed launch: the pool fills from the public
/** The pool's buy room per stock (/v1/pool capacity), or null when the API does not report it (older API, demo, offline). */
const poolCapacity=()=>{const c=data.pool?.capacity;return c&&Array.isArray(c.names)?c:null};
const roomOf=name=>{const c=poolCapacity();const r=c?.names.find(x=>x.name===name);return r?num(r.maxBuyUsdg):null};
/** Shown on the overview, option chain and Shield while the pool is empty or small: what is possible now, per stock. */
function poolFillingPanel(){
 const c=poolCapacity();if(!c||c.stage==='open')return '';
 const empty=c.stage==='empty';
 const rows=c.names.map(r=>`<li><strong>${esc(r.name)}</strong><span>${r.canBuyMinimum?'up to about '+money(num(r.maxBuyUsdg))+' per buy':'not yet'}</span></li>`).join('');
 return `<section class="glass dash-filling" aria-label="The pool is filling" data-stage="${esc(c.stage)}"><div><span class="lm-eyebrow">Writer Pool · ${empty?'empty':'filling'}</span><h2>The pool is filling. Trading opens as writers deposit.</h2><p>${empty
  ?`The Writer Pool sells every option, and it starts empty: the team does not seed it. Until writers deposit USDG, new options cannot be bought. Selling is never blocked.`
  :`Writers have started depositing, so small trades are open. Each buy is limited to a share of the pool’s NAV, so the room per buy grows as more writers deposit. Selling is never blocked.`}</p><div class="dash-filling-actions"><a class="lm-button gold small" href="/writers">Become a Writer ${icons.arrow}</a><span class="dash-muted">or check back later</span></div></div><div><span class="dash-label">Room for one buy, right now</span><ul class="dash-filling-list">${rows}</ul><small class="dash-muted">Option value, at the current NAV of ${money(num(data.pool.nav))}. The contracts check the exact limits at the trade.</small></div></section>`;
}
const fmtTime=t=>new Date(t).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
function modeBanner(){
 if(MODE==='demo')return `<div class="dash-demo-banner" role="note"><strong>Demo, not real funds.</strong> Prices, positions and the pool on this page are illustrative and reset when you close the tab. <a href="/dashboard">Leave the demo</a></div>`;
 if(MODE==='offline')return `<div class="dash-demo-banner offline" role="status"><strong>Live data is not available.</strong> This site is not connected to the Lemniscate service yet. <a href="/dashboard?demo=1">Open the demo</a></div>`;
 if(data.error)return `<div class="dash-demo-banner offline" role="status"><strong>Live data is unavailable right now.</strong> ${esc(data.error)} ${button('Try again','retry','small')}</div>`;
 if(chainMismatch())return `<div class="dash-demo-banner offline" role="status"><strong>Network mismatch.</strong> The service reports chain ${esc(data.config.chainId)}, this site expects ${esc(CFG.chainId)}. Trading is disabled.</div>`;
 return '';
}
// Local fork profile (config.fork.js): a visible badge, and a louder one while the dev wallet is connected.
// Testnet profile (config.testnet.js, chain 46630): a badge so test tokens are never mistaken for real money.
function forkBadge(){
 if(DEMO)return '';
 if(Number(CFG.chainId)===46630)return `<span class="dash-fork-label testnet" title="Robinhood Chain testnet (chain 46630). Test tokens only, not real money.">Testnet · chain 46630</span>`;
 if(Number(CFG.chainId)!==31337)return '';
 const dev=W.wallet().kind==='dev';
 return `<span class="dash-fork-label${dev?' dev':''}" title="Local anvil fork of Robinhood Chain (chain 31337). Not a real network.">${dev?'Dev wallet · local fork':'Local fork · chain 31337'}</span>`;
}
function walletChip(){
 if(DEMO)return `<span class="dash-account demo"><span>DEMO</span><span>Demo account</span></span>`;
 const w=W.wallet();
 if(!w.address)return `<button class="dash-account dash-connect" data-action="connect" aria-label="Connect a wallet"><span>${window.LM_ICON_SVGS.wallet||''}</span><span>Connect wallet</span></button>`;
 return `<button class="dash-account" data-action="tab" data-tab="settings" data-address="${esc(w.address)}" aria-label="Wallet ${esc(short(w.address))} and settings"><span>${esc(w.address.slice(2,4).toUpperCase())}</span><span>${esc(short(w.address))}</span><span class="dash-account-chevron">${window.LM_ICON_SVGS.arrow}</span></button>`;
}
const canTrade=()=>MODE!=='offline'&&!data.error&&!chainMismatch()&&!!data.config;


// ---------------------------------------------------------------- guided first trade (todo 37 L1)
let seenPositionsNow=false;
function onboardingCard(){
 if(DEMO||MODE!=='live'||data.error||!data.config)return '';
 const addr=W.wallet().address||'';
 const stored=Onb.readWallet(addr);
 if(stored.dismissed)return '';
 const nPos=data.positions&&!data.positions.error?data.positions.positions.length:null;
 if(addr&&nPos===null&&owner())return '';// wait for the positions read before deciding this is a new wallet
 const seen=stored.seenPositions===true||(seenPositionsNow&&nPos>0);
 if(addr&&nPos>0&&!stored.sawEmpty&&!seenPositionsNow)return '';// an existing trader: no tour
 if(addr&&nPos===0&&!stored.sawEmpty)Onb.writeWallet(addr,{sawEmpty:true});
 const sponsoring=!!CFG.oneTap&&data.useropCfg?.sponsoring===true;
 const fundAddr=owner()||addr;
 const {steps,current}=Onb.buildSteps({address:addr,chainOk:!!addr&&Number(W.wallet().chainId)===Number(CFG.chainId),chainName:CFG.chainName,
  usdgRaw:data.account?.usdg??null,ethWei:data.account?.eth??null,sponsoring,positions:nPos,seenPositions:seen,sponsorMin:Onb.sponsorMin(data.useropCfg)});
 const sMin=Onb.sponsorMin(data.useropCfg),suggested=Onb.suggestedTrade({sponsoring,sponsorMin:sMin});
 const fc=Onb.fundCopy({sponsoring,fundAddress:fundAddr,chainName:CFG.chainName,sponsorMin:sMin});
 const invite=data.invites;
 const access=Onb.accessLine({required:invite.required,approved:invite.approved,regions:regionList(CFG.blockedRegions)});
 const roomNow=roomOf(selected),poolTooSmall=roomNow!==null&&roomNow<suggested;
 const body={
  connect:`<p>Pick the wallet you will hold your options in. Lemniscate never asks for a seed phrase or private key.</p>${button('Connect wallet','connect','gold')}`,
  network:`<p>Your wallet needs to be on ${esc(CFG.chainName)} (chain ${esc(CFG.chainId)}). Options and USDG sent on another network will not show up here.</p>${button('Switch network','onb-switch','gold')}`,
  fund:`<p>${esc(fc.usdg)}</p><p>${esc(fc.gas)}</p>${fundAddr?`<p class="dash-onb-address"><code>${esc(fundAddr)}</code></p>`:''}<p class="dash-muted">USDG: ${data.account?.usdg!=null?money(Number(data.account.usdg)/1e6):'not read yet'}${sponsoring?'':` · ETH: ${data.account?.eth!=null?fmt(Number(data.account.eth)/1e18,5):'not read yet'}`}</p>`,
  trade:poolTooSmall?`<p>The Writer Pool is still filling: right now ${roomNow>=Onb.MIN_TRADE_USDG?`a buy on ${esc(selected)} can add only about ${money(roomNow)}`:'it cannot take a first trade yet'}. Trading opens as writers deposit. Become a Writer to help fill it, or check back later. Selling is never blocked.</p><a class="lm-button gold" href="/writers">Become a Writer ${icons.arrow}</a>`:`<p>Open the option chain, choose a name, direction and strike, and spend $${suggested} to start${sponsoring?` (gas is sponsored from $${suggested}; $${Onb.MIN_TRADE_USDG} is the smallest and uses ETH for gas)`:''}. You see the cost before you sign, and the most you can lose is the amount you pay.</p>${needsInvite()?button('Enter invite code','invite','gold'):button('Open the option chain ↗','tab','gold','data-tab="trade"')}`,
  position:`<p>Your position is an option token in your wallet. Open Positions to see its value at the bid, its daily holding cost and how to sell it.</p>${button('View positions','onb-positions','gold')}`,
 };
 const list=steps.map((s,i)=>`<li class="${s.done?'done':i===current?'current':''}"><span class="dash-onb-mark" aria-hidden="true">${s.done?'✓':i+1}</span><div><strong>${esc(s.title)}</strong>${i===current?`<div class="dash-onb-body">${body[s.key]}</div>`:''}</div></li>`).join('');
 const finished=current===-1;
 return `<section class="glass dash-onboarding" aria-label="Your first trade"><div class="dash-onb-head"><div><span class="lm-eyebrow">Your first trade</span><h2>${finished?'You are set up.':'Five steps to your first option.'}</h2></div><button class="lm-button ghost small" data-action="onb-dismiss">${finished?'Done':'Dismiss'}</button></div><p class="dash-onb-access">${esc(access)}</p><ol class="dash-onb-steps">${list}</ol></section>`;
}

// ---------------------------------------------------------------- tabs
function overview(){
 const t=data.positions?.totals,pool=data.pool;
 const connected=!!owner();
 const rows=names().map(n=>{const c=chainOf(n);return `<div class="dash-market-row">${symbol(n)}<div><h3>${esc(n)}</h3><p>${esc(meta(n).name)}</p></div><strong>${c?money(num(c.spot)):'—'}</strong><span class="dash-row-session">${c?SESSION_LABEL[c.session]||c.session:'No price yet'}</span><button class="dash-star" data-action="open-name" data-name="${esc(n)}" aria-label="Open the ${esc(n)} option chain">${window.LM_ICON_SVGS.arrow}</button></div>`}).join('');
 return onboardingCard()+poolFillingPanel()+heading('A little more room to grow.','Your options, the Writer Pool and the markets, in one view.',button('Open the option chain ↗','tab','gold','data-tab="trade"')+button('View positions','tab','','data-tab="positions"'))
 +`<div class="dash-hero-grid"><section class="glass dash-portfolio"><div class="dash-portfolio-top"><div><span class="lm-eyebrow">Open option value</span><h2>${t?money(num(t.valueAtBidUsdg)):connected?'—':'Connect a wallet'}</h2><span class="dash-change">${t?`${data.positions.positions.length} open ${data.positions.positions.length===1?'position':'positions'} <span>·</span> valued at the bid`:'Positions are read from the chain for your wallet'}</span></div></div>${chart(payoffShape(selected,true,num(chainOf(selected)?.spot)),'#b8873d','payoff')}<div class="dash-chart-labels"><span>Up call payoff shape on ${esc(selected)} at today’s price, before costs</span><span>75% → 125%</span></div></section>
 <section class="glass dash-orbits"><div class="dash-orbit gold"><span>Holding cost</span><strong>${t?money(num(t.dailyCostUsdg)):'—'}</strong><small>per day, today’s rate</small></div><div class="dash-orbit blue"><span>Profit and loss</span><strong>${t?(num(t.pnlUsdg)<0?'−':'')+money(Math.abs(num(t.pnlUsdg))):'—'}</strong><small>value at bid plus sales, minus cost</small></div><div class="dash-orbit blue"><span>Writer Pool NAV</span><strong>${pool?money(num(pool.nav)):'—'}</strong><small>USDG</small></div><div class="dash-orbit gold"><span>Share NAV</span><strong>${pool&&num(pool.navPerShare)>0?'$'+fmt(num(pool.navPerShare),4):'—'}</strong><small>per pool share</small></div></section></div>
 <div class="dash-under-grid"><section class="glass dash-panel"><div class="dash-panel-title"><h2>Markets</h2>${button('Open option chain ↗','tab','ghost small','data-tab="trade"')}</div>${rows||`<p class="dash-muted">${data.loading?'Loading markets…':'Markets are not available right now.'}</p>`}</section><section class="glass dash-panel"><div class="dash-panel-title"><h2>More time. Clearer choices.</h2><span class="lm-sparkle">${window.LM_ICON_SVGS.star}</span></div><article class="dash-principle"><span class="lm-eyebrow">Protection, with a purpose</span><h3 style="margin-top:12px">Shield a holding.</h3><p>Shield adds a Weekly Down option to a Stock Token holding. Choose a listed protection strike and see its daily cost.</p>${button('Explore Shield '+icons.arrow,'tab','small','data-tab="shield"')}</article><article class="dash-principle"><h3>Your pace is yours.</h3><p>Daily and Weekly describe pricing speeds. Neither is an expiry date.</p><a class="lm-button small" href="/learn/daily-holding-cost">Read the mechanics ${icons.arrow}</a></article></section></div>`;
}

function optionAt(row,isCall){return row?(isCall?row.call:row.put):null}
function currentRow(){const rows=speedRows(selected);if(!rows.length)return null;let r=rows.find(x=>x.strike===strike);if(!r){r=rows.reduce((a,b)=>Math.abs(b.moneynessPct)<Math.abs(a.moneynessPct)?b:a);strike=r.strike}return r}
function trade(){
 const c=chainOf(selected),rows=speedRows(selected),row=currentRow(),opt=optionAt(row,side==='call');
 const list=names().map(n=>`<button class="dash-instrument ${n===selected?'active':''}" data-action="market" data-market="${esc(n)}"><strong>${esc(n)}</strong><span>${esc(meta(n).name)}</span><small>${chainOf(n)?money(num(chainOf(n).spot)):'—'}</small></button>`).join('');
 const table=rows.length?`<div class="dash-table-scroll"><table class="dash-chain-table"><thead><tr><th>Strike</th><th>Up call</th><th>Down put</th><th>${speed==='WEEKLY'?'Weekly':'Daily'} cost / day</th><th></th></tr></thead><tbody>${rows.map(r=>{const o=optionAt(r,side==='call');return `<tr class="${r.strike===strike?'selected':''}"><td data-label="Strike">${money(num(r.strike))} ${Math.abs(r.moneynessPct)<.5?'<small style="color:#9b772f">ATM</small>':`<small>${r.moneynessPct>0?'+':''}${fmt(r.moneynessPct,1)}%</small>`}</td><td data-label="Up call">${r.call?money(num(r.call.ask)):'—'}</td><td data-label="Down put">${r.put?money(num(r.put.ask)):'—'}</td><td data-label="Cost / day">${o?esc(o.displayCost.replace('costs about ','')):'—'}</td><td data-label=""><button data-action="strike" data-strike="${esc(r.strike)}" aria-label="Select strike ${money(num(r.strike))}">Select ${window.LM_ICON_SVGS.arrow}</button></td></tr>`}).join('')}</tbody></table></div>`
  :`<p class="dash-muted" style="margin:24px 0">${MODE==='offline'?'The option chain appears here when the site is connected to the Lemniscate service.':data.loading?'Loading the option chain…':'No options are listed on this name right now.'}</p>`;
 return onboardingCard()+inviteBar()+poolFillingPanel()+heading('A view, without the deadline.','Choose an underlying, direction, strike, and pace.',button('Understand costs '+icons.arrow,'cost-help','ghost'))
 +`<div class="dash-trade-layout"><section class="glass dash-chain"><div class="dash-search"><span>${names().length} underlyings</span></div><div class="dash-instruments" id="market-results">${list}</div><div class="dash-chain-head"><div><h2>${esc(meta(selected).name)}</h2><p>${esc(selected)} · Underlying ${c?money(num(c.spot)):'—'}${c?.priceUpdatedAt?` · price ${fmtTime(Date.parse(c.priceUpdatedAt))}`:''}</p></div>${sessionPill(selected)}</div>${blockNotes(selected).map(t=>notice(t,'warn')).join('')}${notice(sessionNote(selected))}${chart(payoffShape(selected,side==='call',num(row?.strike)),'#b8873d','option-value')}<div class="dash-chart-caption"><span>${side==='call'?'Up call':'Down put'} payoff at the strike, before costs</span><span>75% of today’s price → 125%</span></div><div class="lm-segmented" aria-label="Pricing speed" style="margin:18px 0 6px"><button class="${speed==='DAILY'?'selected':''}" data-action="speed" data-speed="DAILY">Daily</button><button class="${speed==='WEEKLY'?'selected':''}" data-action="speed" data-speed="WEEKLY">Weekly</button></div>${table}</section>${ticket(row,opt)}</div>`;
}
function ticket(row,opt){
 return `<aside class="glass dash-ticket"><div class="dash-ticket-head"><h2>Your next view</h2><span>${esc(selected)}</span></div><div class="lm-segmented" aria-label="Option direction"><button class="${side==='call'?'selected':''}" data-action="direction" data-direction="call">Up call ${window.LM_ICON_SVGS.up}</button><button class="${side==='put'?'selected':''}" data-action="direction" data-direction="put">Down put ${window.LM_ICON_SVGS.shield}</button></div><div class="dash-label"><span>Pricing speed</span><small>${speed==='WEEKLY'?'Weekly':'Daily'} · no expiry</small></div><div class="dash-label">Strike</div><div class="dash-strikes">${speedRows(selected).map(r=>`<button class="${r.strike===strike?'active':''}" data-action="strike" data-strike="${esc(r.strike)}">${money(num(r.strike))}</button>`).join('')||'<span class="dash-muted">No listed strikes</span>'}</div><label class="dash-label" for="order-units">Option units<small>1 unit tracks 1 Stock Token</small></label><input class="dash-field" id="order-units" aria-label="Option units" inputmode="decimal" value="${esc(units)}"><div id="quote-summary">${quoteSummary(opt)}</div></aside>`;
}
function quoteSummary(opt){
 if(!opt)return `<p class="dash-ticket-note">${canTrade()?'Choose a listed strike to see a quote.':'Quotes appear when live data is available.'}</p>`;
 const q=quoteState.key===quoteKey()?quoteState.result:null,err=quoteState.key===quoteKey()?quoteState.error:null;
 const display=q?.display;const isCall=side==='call';
 const block=q?.blockReason||(!opt.buyable?opt.blockReason:null);
 const head=display?`<div class="dash-cost-first"><strong>${esc(display.displayCost.replace(/^costs/,'Costs'))}</strong><span>${pays(selected,isCall,display.breakeven)}</span></div>`:`<div class="dash-cost-first"><strong>${esc(opt.displayCost.replace(/^costs/,'Costs'))} per unit</strong><span>${pays(selected,isCall,opt.breakeven)} (one unit)</span></div>`;
 const lines=display?`${line('Purchase amount',money(num(display.usdg)))}${line('Notional fee (3 bps)',money(num(display.feeUsdg)))}${line('Spread',fmt(num(q.quote.spreadBps)/100,2)+'% of the mark')}${line('Slippage limit',fmt(prefs.slippageBps/100,1)+'% · '+Math.round(prefs.deadlineSeconds/60)+' min')}`:'';
 const greeks=`<details class="dash-greeks"><summary>Greeks for one unit</summary>${line('Delta',fmt(opt.delta,4))}${line('Gamma',fmt(opt.gamma,6))}${line('Vega (per vol point)',fmt(opt.vega,4))}${line('Volatility',fmt(opt.sigmaBps/100,1)+'%')}</details>`;
 const total=display?`<div class="dash-ticket-total"><small>Purchase amount · maximum buyer loss</small><strong>${money(num(display.usdg))}</strong></div>`:'';
 const reason=block?notice(BLOCK_REASON[block]||'New purchases are paused on this option right now.','warn')+(block==='POOL_FILLING'||block==='CAP_REACHED'?`<p class="dash-ticket-note"><a href="/writers">Become a Writer</a> to add room, or check back later.</p>`:''):'';
 const room=q?.capacity&&!q.capacity.poolFilling?line('Room on this option now',money(num(q.capacity.maxBuyUsdg))):'';
 const disabled=!canTrade()||!!block||!display||!!err;
 return `${head}${lines}${room}${greeks}${total}${err?`<p class="dash-error" role="alert">${esc(err)}</p>`:''}${reason}${quoteState.loading&&!display?'<p class="dash-muted">Fetching a quote…</p>':''}${button('Review '+(isCall?'Up call':'Down put')+' '+icons.arrow,'review','gold',disabled?'disabled':'')}<p class="dash-ticket-note">A continuing cost reduces effective units.<br>Loss is capped at your purchase amount.</p>`;
}
const quoteKey=()=>`${selected}|${side}|${speed}|${strike}|${units}`;
function requestQuote(){
 clearTimeout(quoteTimer);const opt=optionAt(currentRow(),side==='call');
 if(!opt||!canTrade()){return}
 const key=quoteKey();if(!/^\d{1,12}(\.\d{1,18})?$/.test(units)||num(units)<=0){quoteState={key,result:null,error:'Enter a positive number of option units.',loading:false};updateQuote();return}
 quoteState={key,result:null,error:null,loading:true};
 quoteTimer=setTimeout(async()=>{
  try{const r=await api.quote({series:opt.id,units,side:'buy'});if(quoteState.key===key)quoteState={key,result:r,error:null,loading:false}}
  catch(error){if(quoteState.key===key)quoteState={key,result:null,error:plainError(error),loading:false}}
  updateQuote();
 },250);
}
function updateQuote(){const el=root.querySelector('#quote-summary');if(el)el.innerHTML=quoteSummary(optionAt(currentRow(),side==='call'))}

function positions(){
 const head=heading('Your view, held in your wallet.','Effective units reduce with the continuing holding cost.',button('Export positions ↓','export-positions','ghost')+button('Open an option '+icons.arrow,'tab','gold','data-tab="trade"'));
 if(MODE==='offline')return head+empty('Positions need live data.','Your positions are read from the chain through the Lemniscate service. It is not connected on this site yet.','','');
 if(!owner())return head+empty('Connect a wallet to see your positions.','Lemniscate reads your option tokens from the chain. Nothing is stored in this browser.','connect','Connect wallet','');
 const p=data.positions;
 if(!p)return head+`<p class="dash-muted">Loading positions…</p>`;
 if(p.error)return head+notice(p.error,'warn');
 const queued=p.queuedSells?.length?notice(`${p.queuedSells.length} sell${p.queuedSells.length===1?' is':'s are'} queued and will fill at the first fresh price.`):'';
 if(p.positions.length&&Onb.readWallet(W.wallet().address||'').sawEmpty)Onb.writeWallet(W.wallet().address||'',{seenPositions:true});
 if(!p.positions.length)return head+queued+empty('Room for your first view.','Choose an everlasting Up or Down option.<br>Your position will appear here after the purchase.');
 return head+queued+`<div class="dash-info-strip"><div><strong>${p.positions.length} open ${p.positions.length===1?'position':'positions'}</strong> · ${money(num(p.totals.valueAtBidUsdg))} at the bid</div><span>${money(num(p.totals.dailyCostUsdg))} / day holding cost</span></div><div class="dash-position-grid">${p.positions.map(x=>{const pnl=x.pnlUsdg===null?null:num(x.pnlUsdg);return `<article class="glass dash-position"><div class="dash-position-head">${symbol(x.name||'?')}<div><h2>${esc(x.name||'Option')} ${x.isCall?'Up':'Down'}</h2><p>${x.speed==='WEEKLY'?'Weekly':'Daily'} · Strike ${money(num(x.strike))} · No expiry</p></div></div><div class="dash-position-value">${x.valueAtBidUsdg===null?'—':money(num(x.valueAtBidUsdg))}</div>${pnl===null?'':`<span class="dash-change" style="${pnl<0?'color:#af7a62;background:#f1e1d3':''}">${pnl>=0?'+':'−'}${money(Math.abs(pnl))} <span>since purchase</span></span>`}${line('Effective units',fmt(num(x.units),4))}${line('Holding cost',x.displayCost?esc(x.displayCost.replace('costs about ','')):'—')}${line('Paid in',money(num(x.costBasisUsdg)))}${x.sellQueued?notice('A sell on this option would queue for a fresh price.'):''}<div class="dash-position-actions">${button('Position details','position-detail','',`data-id="${esc(x.seriesId)}"`)}${button('Sell position ↗','sell','gold',`data-id="${esc(x.seriesId)}" ${canTrade()?'':'disabled'}`)}</div></article>`}).join('')}</div>`;
}

function shieldRows(name){const c=chainOf(name);const S=num(c?.spot);return speedRows(name,'WEEKLY').filter(r=>r.put&&S>0&&num(r.strike)<S).map(r=>({row:r,pct:(1-num(r.strike)/S)*100}))}
function shield(){
 const name=shieldName||selected,rows=shieldRows(name);
 if(rows.length&&!rows.some(r=>r.row.strike===shieldStrike))shieldStrike=rows.reduce((a,b)=>Math.abs(b.pct-10)<Math.abs(a.pct-10)?b:a).row.strike;
 const pick=rows.find(r=>r.row.strike===shieldStrike);
 const stock=data.config?.stocks?.find(s=>s.name===name);
 return inviteBar()+poolFillingPanel()+heading('A little protection.<br>A little more peace of mind.','Protect a Stock Token holding with an everlasting Weekly Down option.')
 +`<div class="dash-shield-layout"><section class="glass dash-shield-visual"><span class="lm-eyebrow">Shield / ${esc(name)}</span><h2>Keep your holding.<br>Add a floor below the strike.</h2><p>A Down option gains value below its strike. Choose how many Stock Token units to cover and a listed protection strike, then review the cost before you add Shield.</p>${chart(payoffShape(name,false,num(pick?.row.strike)),'#b8873d','shield')}<div class="dash-shield-legend"><span><i></i>Down payoff at the protection strike, before premium, funding and spread</span></div>${blockNotes(name).map(t=>notice(t,'warn')).join('')}${notice(sessionNote(name))}</section>
 <aside class="glass dash-ticket"><div class="dash-ticket-head"><h2>Add your Shield</h2><span>Weekly Down</span></div><label class="dash-label" for="shield-market">Stock Token</label><select class="dash-field" id="shield-market">${names().map(n=>`<option value="${esc(n)}" ${n===name?'selected':''}>${esc(n)} · ${esc(meta(n).name)}</option>`).join('')}</select><label class="dash-label" for="shield-units">Stock Token units to protect${stock&&data.account.stockBalance?.[name]!==undefined?`<small>You hold ${fmt(Number(fromRaw(data.account.stockBalance[name],18,4)),4)}</small>`:''}</label><input class="dash-field" id="shield-units" inputmode="decimal" value="${esc(shieldUnits||'1')}"><div class="dash-label">Protection strike (listed Weekly strikes)</div><div class="dash-strikes">${rows.map(r=>`<button class="${r.row.strike===shieldStrike?'active':''}" data-action="shield-level" data-strike="${esc(r.row.strike)}">${money(num(r.row.strike))}<small> · ${fmt(r.pct,1)}% below</small></button>`).join('')||'<span class="dash-muted">No listed protection strikes right now.</span>'}</div><div id="shield-summary">${shieldSummary(name,pick)}</div></aside></div>`;
}
let shieldQuote={key:'',result:null,error:null};let shieldTimer=null;
const shieldKey=()=>`${shieldName||selected}|${shieldStrike}|${shieldUnits||'1'}`;
function shieldSummary(name,pick){
 if(!pick)return `<p class="dash-ticket-note">${canTrade()?'Shield needs a listed Weekly Down strike below today’s price.':'Shield quotes appear when live data is available.'}</p>`;
 const q=shieldQuote.key===shieldKey()?shieldQuote.result:null,err=shieldQuote.key===shieldKey()?shieldQuote.error:null;
 const block=q?.blockReason||(!pick.row.put.buyable?pick.row.put.blockReason:null);
 return `<div class="dash-cost-first"><strong>${esc((q?.display.displayCost||pick.row.put.displayCost+' per unit').replace(/^costs/,'Costs'))}</strong><span>${pays(name,false,q?.display.breakeven||pick.row.put.breakeven)}</span></div>${line('Protection strike',money(num(pick.row.strike)))}${q?line('Shield purchase amount',money(num(q.display.usdg))):''}<div class="dash-ticket-total"><small>Purchase amount · maximum buyer loss</small><strong>${q?money(num(q.display.usdg)):'—'}</strong></div>${err?`<p class="dash-error" role="alert">${esc(err)}</p>`:''}${block?notice(BLOCK_REASON[block]||'New purchases are paused right now.','warn'):''}${button('Review protection '+icons.arrow,'review-shield','gold',!canTrade()||!q||block||err?'disabled':'')}<p class="dash-ticket-note">A Down option stays until you sell it.<br>Funding reduces its effective units.</p>`;
}
function requestShieldQuote(){
 clearTimeout(shieldTimer);const name=shieldName||selected,pick=shieldRows(name).find(r=>r.row.strike===shieldStrike);if(!pick||!canTrade())return;
 const key=shieldKey(),u=shieldUnits||'1';
 if(!/^\d{1,12}(\.\d{1,18})?$/.test(u)||num(u)<=0){shieldQuote={key,result:null,error:'Enter a positive number of Stock Token units.'};updateShield();return}
 shieldTimer=setTimeout(async()=>{try{const r=await api.quote({series:pick.row.put.id,units:u,side:'buy'});if(shieldQuote.key===key||shieldKey()===key)shieldQuote={key,result:r,error:null}}catch(e){shieldQuote={key,result:null,error:plainError(e)}}updateShield()},250);
}
function updateShield(){const el=root.querySelector('#shield-summary');const name=shieldName||selected;if(el)el.innerHTML=shieldSummary(name,shieldRows(name).find(r=>r.row.strike===shieldStrike))}

function meter(pct,cap){const w=cap>0&&pct!==null?Math.min(100,Math.max(0,pct/cap*100)):0;return `<div class="dash-meter"><span style="width:${w.toFixed(1)}%"></span></div>`}
function ticketList(a){
 if(!a.tickets?.length)return '<p class="dash-ticket-note">You have no open withdrawal tickets.</p>';
 const now=Math.floor(Date.now()/1000),dec=data.config?.poolShareDecimals??12;
 return `<h3 class="dash-ticket-sub">Your withdrawal tickets</h3>`+a.tickets.map(t=>{
  const st=PQ.ticketState(t.claimableAt,now);
  const when=st==='waiting'?`Claimable ${fmtTime(t.claimableAt*1000)} (in ${PQ.waitText(t.claimableAt-now)})`:st==='ready'?'Ready to claim':'Past the 7-day claim window: claiming puts it back in the queue and pays nothing this time';
  return `<div class="dash-ticket-row" data-ticket="${esc(t.id)}"><div><strong>Ticket #${esc(t.id)}</strong><small>${fmt(Number(fromRaw(t.shares,dec,4)),4)} shares · ${esc(when)}</small></div>${button(st==='late'?'Re-queue':'Claim','pool-claim','gold small',`data-ticket="${esc(t.id)}" ${st==='waiting'||!canTrade()?'disabled':''}`)}</div>`;
 }).join('');
}
function pool(){
 const p=data.pool,a=data.account,caps=p?.caps;
 const perName=p?Math.max(0,...p.exposures.map(e=>e.outstandingPctOfNav??0)):null;
 const art=p?`<div class="dash-pool-orb"><small>Writer Pool NAV</small><strong>${compact(num(p.nav))}</strong><small>USDG · ${p.asOf?'as of '+fmtTime(Date.parse(p.asOf)):'no snapshot yet'}</small></div><div class="dash-pool-info"><span class="lm-eyebrow">The writer side</span><h2>Funding received.<br>Exposure managed.</h2><p>The pool sells options, receives funding and spread, and hedges its exposure. Share NAV moves with the pool and can fall with market gaps or hedge losses. Writers can lose more than they earn.</p><div style="margin-top:20px">${line('Share NAV','$'+fmt(num(p.navPerShare),4))}${line('Funding received, last '+p.fundingReceived.windowHours+' h (estimate)',money(num(p.fundingReceived.usdg)))}${line('Option value vs NAV',(caps.totalOptionValuePct===null?'—':fmt(caps.totalOptionValuePct,1)+'%')+' of '+caps.totalOptionValueCapPct+'% cap')}${meter(caps.totalOptionValuePct,caps.totalOptionValueCapPct)}${line('Largest name vs NAV',fmt(perName,1)+'% of '+caps.perNameCapPct+'% cap')}${meter(perName,caps.perNameCapPct)}${caps.navCapUsdg==null?line('Deposit cap','No deposit cap'):line('Pool size vs deposit cap',(caps.navPctOfCap===null?'—':fmt(caps.navPctOfCap,1)+'%')+' of '+money(num(caps.navCapUsdg)))+meter(caps.navPctOfCap,100)}${line('30-day drawdown',(p.drawdown30dPct===null?'—':fmt(p.drawdown30dPct,2)+'%')+' · buys pause above '+p.drawdownPausePct+'%')}${line('Queue',`${p.queue.withdrawals} withdrawal${p.queue.withdrawals===1?'':'s'} · ${p.queue.sells} queued sell${p.queue.sells===1?'':'s'}`)}${p.buysPaused?notice('New option purchases are paused by the pool’s risk limits. Sells stay open.','warn'):''}</div></div>`
  :`<div class="dash-pool-info"><span class="lm-eyebrow">The writer side</span><h2>Pool data is not available.</h2><p>${MODE==='offline'?'NAV, funding received and caps appear when the site is connected to the Lemniscate service.':'Loading the pool…'}</p></div>`;
 const deposit=poolMode==='deposit';
 const allowed=DEMO?false:(a.publicDeposits||a.depositor);
 let body;
 if(DEMO)body=notice('Pool deposits and withdrawals are not simulated in the demo.');
 else if(!W.wallet().address)body=`<p class="dash-ticket-note">Connect a wallet to see your pool shares.</p>${button('Connect wallet','connect','gold')}`;
 else if(a.error)body=notice(a.error,'warn');
 else{
  const unlocked=!a.unlock||a.unlock*1000<=Date.now();
  body=`${line('Your pool shares',a.shares!==undefined?fmt(Number(fromRaw(a.shares,data.config?.poolShareDecimals??12,4)),4):'—')}${line('Your pool value',a.value!==undefined?money(Number(fromRaw(a.value,6,2))):'—')}${line('USDG in wallet',a.usdg!==undefined?money(Number(fromRaw(a.usdg,6,2))):'—')}${a.unlock?line('Withdrawals unlock',unlocked?'Now':fmtTime(a.unlock*1000)):''}
  <label class="dash-label" for="pool-amount">${deposit?'Deposit amount in USDG':'Shares to withdraw'}</label><input id="pool-amount" class="dash-field" inputmode="decimal" placeholder="0.00">
  ${deposit?(allowed?`<p class="dash-ticket-note">Deposits mint shares at the current NAV. New shares are locked for a short period before they can be withdrawn.</p>`:notice('Deposits are open to allowlisted writers only right now, and this address is not on the list. Public deposits are a pool setting the owner controls; see Become a Writer.','warn'))
   :`<p class="dash-ticket-note">Withdrawals use a queue. Asking to withdraw gives you a ticket${a.queueDelay!=null?`; it can be claimed after ${PQ.waitText(a.queueDelay)}`:''}. Then you claim it here. When many writers exit at once, a claim can be paid in part (pro rata) and the rest stays claimable.</p>${a.unlock&&!unlocked?notice('Your latest deposit is still locked until '+fmtTime(a.unlock*1000)+'.','warn'):''}`}
  ${button(deposit?'Review deposit '+icons.arrow:'Request withdrawal '+icons.arrow,'pool-review','gold',(deposit&&!allowed)||!canTrade()?'disabled':'')}${deposit?'':ticketList(a)}`;
 }
 const vaultsOpen=!!data.config?.caps?.writerVaultsOpen;
 return poolFillingPanel()+heading('Collateral with a clear role.','The counterparty pool, measured by NAV.',`<a class="lm-button gold" href="/writers">Become a Writer ${icons.arrow}</a>`+button('Pool mechanics '+icons.arrow,'pool-help','ghost'))
 +`<div class="dash-pool-grid"><section class="glass dash-pool-art">${art}</section><aside class="glass dash-ticket"><div class="dash-ticket-head"><h2>Your pool capital</h2><span>USDG</span></div><div class="lm-segmented"><button class="${deposit?'selected':''}" data-action="pool-mode" data-mode="deposit">Deposit</button><button class="${!deposit?'selected':''}" data-action="pool-mode" data-mode="withdraw">Withdraw</button></div>${body}</aside></div>
 <div class="dash-vault-grid"><article class="glass dash-vault"><span class="lm-eyebrow">Phase 2 / Covered Up${vaultsOpen?'':' · closed'}</span><h3>Write the upside you hold.</h3><p>Stock Tokens collateralize covered Up options, with one raw token unit per call unit. Deposits and withdrawals use seven-day epochs.</p>${button('Explore covered writing '+icons.arrow,'vault-up','small')}</article><article class="glass dash-vault"><span class="lm-eyebrow">Phase 2 / Cash Down${vaultsOpen?'':' · closed'}</span><h3>Back the downside with USDG.</h3><p>USDG collateral equals strike multiplied by option units. A vault takes a slice of the pool’s short exposure and receives its funding share.</p>${button('Explore cash-backed writing '+icons.arrow,'vault-down','small')}</article></div>`;
}

function agents(){
 const router=data.config?.contracts?.agentRouter;
 const nameChips=list=>{const items=(list||[]).map(x=>{const cfg=(data.config?.stocks||[]).find(c=>String(c.stock).toLowerCase()===String(x.stock).toLowerCase());return x.name||cfg?.name||short(x.stock)});return items.length?`<div class="dash-policy-names" aria-label="Allowed names">${items.map(n=>`<span class="dash-name-chip">${esc(n)}</span>`).join('')}</div>`:''};
 const head=heading('Permission, with a boundary.','Budgets, expiry, and allowed names belong beside every agent.',button('Export policies ↓','export-policies','ghost'));
 const banner=`<section class="glass dash-agent-banner"><div><span class="lm-eyebrow">Your agent desk</span><h2 style="margin-top:16px">Let a policy<br>hold the boundaries.</h2><p>An agent key can buy, sell or Shield for you only inside a budget, a per-trade limit, an expiry and the names you allow. Setting and revoking a policy are transactions you sign.</p></div>${button('Create a policy +','create-policy','gold',router&&!DEMO&&canTrade()?'':'disabled')}</section>`;
 if(MODE==='offline')return head+banner+empty('Agent policies need live data.','The agent router address comes from the Lemniscate service, which is not connected on this site yet.','','');
 if(DEMO)return head+banner+notice('Agent policies are not simulated in the demo.');
 if(!router)return head+banner+notice('Agent policies open once the agent router contract is deployed.');
 if(!W.wallet().address)return head+banner+empty('Connect a wallet to manage policies.','Policies belong to your wallet address.','connect','Connect wallet','');
 const ag=data.agents;
 const rows=ag?.agents||[];
 const list=ag?.error?notice(ag.error,'warn'):ag===null?'<p class="dash-muted" style="margin:24px 0">Loading your policies…</p>':rows.length?`<div class="dash-policy-grid">${rows.map(p=>{const status=p.revoked?'Revoked':p.expired?'Expired':'Active';return `<article class="glass dash-policy"><span class="dash-policy-status ${p.active?'':'revoked'}">${status}</span><h3>${esc(short(p.agent))}</h3>${line('Budget',money(num(p.budgetUsdg)))}${line('Spent',money(num(p.spentUsdg)))}${line('Left to spend',money(num(p.remainingBudgetUsdg)))}${line('Per trade',money(num(p.maxPerTradeUsdg)))}${line('Expires',fmtTime(Date.parse(p.expiresAt)))}${line('May sell / Shield',(p.canSell?'Yes':'No')+' / '+(p.canShield?'Yes':'No'))}${line('Trades',String(p.tradeCount))}${nameChips(p.allowedStocks)}<div class="dash-policy-actions">${!p.revoked?button('Revoke','revoke-policy','ghost small',`data-agent="${esc(p.agent)}"`):''}</div></article>`}).join('')}</div>`:empty('Your boundaries start here.','Create a policy with a budget, allowed names, and an expiry.','create-policy','Create a policy',' ');
 const trades=ag?.error||!ag?null:rows.flatMap(p=>p.recentTrades||[]).sort((a,b)=>Date.parse(b.ts)-Date.parse(a.ts)).slice(0,50);
 const tradeList=`<section class="glass dash-activity" style="margin-top:22px"><div class="dash-panel-title"><h2>Agent trades</h2>${button('Refresh','agent-trades','ghost small')}</div>${trades===null?'<p class="dash-muted">Agent trades appear here once your policies load.</p>':trades.length?trades.map(t=>`<div class="dash-activity-row"><span class="action-icon">${window.LM_ICON_SVGS.agents||window.LM_ICON_SVGS.activity}</span><div><strong>${t.side==='buy'?'Buy':'Sell'} by ${esc(short(t.agent))}</strong><small>${fmtTime(Date.parse(t.ts))}${t.name?' · '+esc(optionLabel(t)):''}</small></div><span>${esc(t.name||'—')}</span><span style="text-align:right">${money(num(t.usdg))}</span><a class="receipt" href="${esc(explorerTx(t.txHash))}" target="_blank" rel="noopener">Explorer ${window.LM_ICON_SVGS.arrow}</a></div>`).join(''):'<p class="dash-muted">No agent trades yet.</p>'}</section>`;
 return head+banner+list+tradeList;
}

const KIND_TITLE={buy:'Bought',sell:'Sold',shield:'Shield bought',sell_queued:'Sell queued',sell_filled:'Queued sell filled',sell_cancelled:'Queued sell cancelled',pool_deposit:'Pool deposit',pool_withdraw:'Pool withdrawal',withdraw_requested:'Withdrawal requested',withdraw_claimed:'Withdrawal claimed',agent_buy:'Agent bought',agent_sell:'Agent sold'};
const KIND_ICON={sell:'wallet',sell_filled:'wallet',agent_sell:'wallet',buy:'up',shield:'up',agent_buy:'up'};
function optionLabel(i){return i.name?`${i.name} ${i.isCall?'Up':'Down'}${i.speed?' · '+(i.speed==='WEEKLY'?'Weekly':'Daily'):''}${i.strike!=null&&i.strike!==''?' · Strike '+money(num(i.strike)):''}`:''}
function activityRow(i){
 const pool=/^(pool|withdraw)/.test(i.kind),extra=[i.ticket!=null?'Ticket #'+i.ticket:'',i.agent?'by '+short(i.agent):'',i.amount&&!pool?i.amount+' units':''].filter(Boolean);
 const what=pool?(KIND_TITLE[i.kind]||i.kind):`${KIND_TITLE[i.kind]||i.kind}${i.name?' · '+optionLabel(i):''}`;
 return `<div class="dash-activity-row"><span class="action-icon">${window.LM_ICON_SVGS[KIND_ICON[i.kind]||'activity']}</span><div><strong>${esc(what)}</strong><small>${[fmtTime(Date.parse(i.ts)),...extra].map(esc).join(' · ')}</small></div><span>${esc(pool?'Writer Pool':i.name||'—')}</span><span style="text-align:right">${i.usdg!=null?money(num(i.usdg)):'—'}</span><a class="receipt" href="${esc(explorerTx(i.txHash))}" target="_blank" rel="noopener">Receipt ${window.LM_ICON_SVGS.arrow}</a></div>`;
}
function receiptRow(r,pending){
 return `<div class="dash-activity-row"><span class="action-icon">${window.LM_ICON_SVGS[r.kind==='sell'?'wallet':r.kind==='buy'||r.kind==='shield'?'up':'activity']}</span><div><strong>${esc(r.description)}</strong><small>${fmtTime(r.t)}${r.queued?' · queued for a fresh price':''}${pending?' · waiting to appear in the service':''}</small></div><span>${esc(r.name||'Wallet')}</span><span style="text-align:right">${r.usdg?money(num(r.usdg)):'—'}</span>${r.demo?'<span class="receipt">Demo</span>':`<a class="receipt" href="${esc(explorerTx(r.hash))}" target="_blank" rel="noopener">Receipt ${window.LM_ICON_SVGS.arrow}</a>`}</div>`;
}
function activity(){
 const a=data.activity,me=owner(),wallet=W.wallet().address;
 const head=heading('Every move, in one place.',MODE==='live'?'Your trades, Shield, pool and agent activity, read from the chain through the Lemniscate service.':'Transactions sent from this browser, with their on-chain receipts.',button('Export activity ↓','export-activity','ghost'));
 const local=receipts.filter(r=>DEMO||!wallet||r.account===me||r.account===wallet);
 if(MODE==='live'&&!wallet&&!isAddress(prefs.smartAccount))return head+empty('Connect a wallet to see your activity.','Your history is read from the chain by your wallet address, so it follows you across browsers.','connect','Connect wallet',' ');
 if(MODE==='live'&&a&&!a.error){
  const seen=new Set(a.items.map(i=>String(i.txHash).toLowerCase()));
  const pending=local.filter(r=>!r.demo&&r.hash&&!seen.has(String(r.hash).toLowerCase())&&Date.now()-r.t<3_600_000);
  if(!a.items.length&&!pending.length)return head+empty('A fresh page for your next move.','Trades, Shield, pool and agent activity for this wallet appear here with a link to each receipt.');
  return head+`<section class="glass dash-activity">${pending.map(r=>receiptRow(r,true)).join('')}${a.items.map(activityRow).join('')}</section>`
   +(a.nextCursor?`<div class="dash-actions" style="margin-top:18px;justify-content:center">${button('Load older activity','activity-more','ghost')}</div>`:'')+(a.moreError?notice(a.moreError,'warn'):'');
 }
 const fallback=MODE==='live'&&a?.error?notice(a.error+' Showing receipts sent from this browser only.','warn'):'';
 return head+fallback+(local.length?`<section class="glass dash-activity">${local.map(r=>receiptRow(r,false)).join('')}</section>`
 :empty('A fresh page for your next move.','Transactions you send from this browser appear here with a link to their on-chain receipt.'));
}

function smartNote(){
 if(isAddress(prefs.smartAccount))return 'Using the address you entered. Clear the box and save to use the one worked out from your wallet.';
 if(!W.wallet().address)return 'Connect a wallet and its smart account address is filled in for you.';
 const s=data.smart;
 if(!s)return 'Looking up your smart account…';
 if(s.error)return esc(s.error)+' You can still paste an address above.';
 return `Filled in from your wallet: ${esc(short(s.address))}. ${s.deployed?'It is deployed.':'It is not deployed yet; it is created with your first one-tap trade.'}`;
}
function settings(){
 const w=W.wallet();
 return heading('Make the workspace yours.','Trading preferences, your wallet, and your region declaration.')
 +`<div class="dash-settings"><section class="glass"><h2>Trading preferences</h2><label class="dash-label" for="slippage">Slippage limit</label><select class="dash-field" id="slippage">${[10,50,100,200].map(x=>`<option value="${x}" ${prefs.slippageBps===x?'selected':''}>${x/100}%</option>`).join('')}</select><label class="dash-label" for="deadline">Transaction deadline</label><select class="dash-field" id="deadline">${[120,300,600,1200].map(x=>`<option value="${x}" ${prefs.deadlineSeconds===x?'selected':''}>${x/60} minutes</option>`).join('')}</select>${CFG.oneTap?`<label class="dash-label" for="smart-account">Smart account for one-tap trades<small>Kernel v3 account owned by your wallet</small></label><input class="dash-field" id="smart-account" value="${esc(prefs.smartAccount)}" placeholder="${esc(data.smart?.address||'Filled in from your wallet')}"><p class="dash-muted" id="smart-note" style="margin-top:8px">${smartNote()}</p>`:''}<div style="margin-top:25px">${button('Save preferences '+icons.arrow,'save-settings','gold')}</div></section>
 <section class="glass"><h2>Wallet</h2>${DEMO?'<p class="dash-muted">The demo uses a pretend account. No wallet is needed.</p>':w.address?`${line('Connected',esc(short(w.address)))}${line('Through',esc(w.name||w.kind))}${line('Network',w.chainId===Number(CFG.chainId)?esc(CFG.chainName):'Wrong network')}<div class="dash-actions" style="margin-top:20px">${button('Disconnect','disconnect','ghost')}</div>`:`<p class="dash-muted">No wallet connected.</p>${button('Connect wallet','connect','gold')}`}
 <div style="margin-top:30px">${line('Settlement unit','USDG')}${line('Pricing speeds','Daily · Weekly')}${line('Option expiry','None')}</div><div class="dash-actions" style="margin-top:22px">${button('Export receipts ↓','export-activity','')}${button('Change region answer','region-reset','ghost')}</div></section></div>`;
}

// ---------------------------------------------------------------- shell
const mobileIcon=key=>window.LM_ICON_SVGS[{overview:'home',trade:'chart',more:'menu'}[key]||key]||window.LM_ICON_SVGS.star;
function mobileNav(){return `<nav class="dash-mobile-nav" aria-label="Mobile workspace navigation">${[['overview','Home'],['trade','Trade'],['positions','Positions'],['shield','Shield'],['more','More']].map(([key,label])=>`<button class="${tab===key||(key==='more'&&['pool','agents','activity','settings'].includes(tab))?'active':''}" data-action="${key==='more'?'mobile-menu':'tab'}" ${key!=='more'?`data-tab="${key}"`:''} aria-label="${label}">${mobileIcon(key)}<span>${label}</span></button>`).join('')}</nav>`}
function mobileMenu(){const d=modal('Your workspace',`<div class="dash-mobile-menu">${[['pool','Writer Pool','NAV, deposits and withdrawals'],['agents','Agent desk','Budgets and permissions'],['activity','Activity','Your on-chain receipts'],['settings','Settings','Slippage, wallet and region']].map(([key,label,detail])=>`<button data-mobile-tab="${key}">${mobileIcon(key)}<span><strong>${label}</strong><small>${detail}</small></span><b>${window.LM_ICON_SVGS.arrow}</b></button>`).join('')}<a href="/">Explore Lemniscate ${icons.arrow}</a></div>`);d.classList.add('dash-menu-sheet');d.addEventListener('click',e=>{const b=e.target.closest('[data-mobile-tab]');if(b){closeModal();changeTab(b.dataset.mobileTab)}})}
function changeTab(t){tab=t;history.replaceState(null,'',qs({tab:t}));render();scrollTo({top:0,behavior:'instant'});if(t==='trade')requestQuote();if(t==='shield')requestShieldQuote();if(MODE==='live'&&(t==='activity'||t==='agents'))Promise.all([loadActivity(),loadAgents()]).then(()=>{if(tab===t&&!root.querySelector('input:focus'))render()})}
function gate(){
 if(region.status==='blocked')return `<div class="glass dash-empty dash-region"><img src="/assets/lemniscate-mark-v2.webp" alt=""><h2>Not available in your region.</h2><p>Lemniscate options are not offered to residents of ${esc(regionList(CFG.blockedRegions))}. You can still read about how they work.</p><a class="lm-button gold" href="/learn/everlasting-options">Read the mechanics ${icons.arrow}</a>${region.source==='declaration'?`<p style="margin-top:18px">${button('I answered by mistake','region-reset','ghost small')}</p>`:''}</div>`;
 return `<div class="glass dash-empty dash-region"><img src="/assets/lemniscate-mark-v2.webp" alt=""><h2>Before you continue.</h2><p>Lemniscate options are not offered to residents of ${esc(regionList(CFG.blockedRegions))}. Please confirm where you live. Your answer stays in this browser.</p><div class="dash-actions" style="justify-content:center;margin-top:22px">${button('I do not live there','region-ok','gold')}${button('I live in one of them','region-blocked','ghost')}</div></div>`;
}
function render(){
 if(disposed)return;
 const gated=region.status!=='allowed';
 const page=region.status==='pending'?'<p class="dash-muted" style="padding:60px 0">Loading…</p>':gated?gate():({overview,trade,positions,shield,pool,agents,activity,settings}[tab]||overview)();
 root.innerHTML=`<main class="lm-ui lm-dashboard" data-mode="${MODE}"><div class="dash-wrap"><header class="dash-header">${brand()}<div class="dash-header-right">${gated?'':sessionPill(selected)}${DEMO?'<span class="dash-demo-label">Demo, not real funds</span>':''}${forkBadge()}<a class="lm-button ghost small" href="/">Explore Lemniscate ${icons.arrow}</a>${gated?'':walletChip()}</div></header>${gated?'':`<nav class="dash-tabs" aria-label="Workspace navigation">${tabs.map(([key,label])=>`<button class="${tab===key?'active':''}" data-action="tab" data-tab="${key}" aria-current="${tab===key?'page':'false'}">${label}</button>`).join('')}</nav>${modeBanner()}`}<div class="dash-page-entrance">${page}</div><footer class="dash-bottom-line"><span>LEMNISCATE · More time. A clearer view.<br>Options can lose their entire purchase amount.</span><span><a href="/learn/everlasting-options">Understand your option ↗</a> &nbsp;·&nbsp; <a href="/product-terms">Product mechanics ↗</a></span></footer></div>${gated?'':mobileNav()}</main>`;
}

// ---------------------------------------------------------------- wallet picker
async function connect(){
 if(DEMO)return;
 const d=modal('Connect a wallet',`<p>Choose a wallet. Lemniscate never asks for a seed phrase or private key.</p><div class="dash-wallet-list" id="wallet-list"><p class="dash-muted">Looking for browser wallets…</p></div>`);
 d.classList.add('dash-wallet-sheet');
 const list=await W.discoverWallets(250,CFG);
 const wc=!!CFG.walletConnectProjectId;
 const items=list.map((w,i)=>`<button class="dash-wallet-option" data-wallet="${i}">${w.info.icon&&/^data:image\/(svg\+xml|png|webp);/.test(w.info.icon)?`<img src="${esc(w.info.icon)}" alt="" width="28" height="28">`:`<span class="dash-wallet-glyph">${esc(w.info.name[0]||'W')}</span>`}<span><strong>${esc(w.info.name)}</strong><small>Browser wallet</small></span></button>`).join('');
 const wcItem=`<button class="dash-wallet-option" data-wallet="walletconnect" ${wc?'':'disabled'}><span class="dash-wallet-glyph">WC</span><span><strong>WalletConnect</strong><small>${wc?'Mobile and desktop wallets by QR code':'Not set up on this site yet'}</small></span></button>`;
 const el=d.querySelector('#wallet-list');if(!el)return;
 el.innerHTML=(items||'<p class="dash-muted">No browser wallet found. Install one, or use WalletConnect.</p>')+wcItem+'<p id="wallet-error" class="dash-error" hidden></p>';
 el.addEventListener('click',async e=>{
  const b=e.target.closest('[data-wallet]');if(!b||b.disabled)return;
  const err=el.querySelector('#wallet-error');err.hidden=true;b.disabled=true;
  try{
   if(b.dataset.wallet==='walletconnect'){closeModal();await W.connectWalletConnect(CFG)}
   else await W.connectInjected(list[Number(b.dataset.wallet)],CFG);
   closeModal();toast('Wallet connected.');
  }catch(error){if(document.body.contains(err)){err.textContent=W.walletErrorText(error);err.hidden=false;b.disabled=false}else toast(W.walletErrorText(error))}
 });
}

// ---------------------------------------------------------------- invite codes (closed beta, website and API only)
async function loadInvites(){
 if(DEMO||MODE!=='live')return;
 try{const r=await api.invitesStatus(W.wallet().address||'');data.invites={required:r.required===true,approved:r.approved===null||r.approved===undefined?null:r.approved===true}}
 catch{/* the service enforces the gate either way; keep the last known state */}
}
const needsInvite=()=>!DEMO&&MODE==='live'&&data.invites.required&&data.invites.approved!==true;
function inviteBar(){
 if(!needsInvite())return '';
 return `<div class="glass dash-invite" role="status"><div><strong>Invite-only for now.</strong><span>Enter your invite code to start buying. Selling is always open.</span></div>${button('Enter invite code','invite','gold')}</div>`;
}
const INVITE_ALPHABET=/^[A-Z2-9]{12}$/;
async function sha256Hex(text){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(d),b=>b.toString(16).padStart(2,'0')).join('')}
async function redeemInvite(rawCode){
 const code=String(rawCode).toUpperCase().replace(/[^A-Z0-9]/g,'');
 if(!INVITE_ALPHABET.test(code))throw Object.assign(new Error('That code is not valid or has already been used.'),{status:403,code:'INVALID_CODE'});
 const address=W.wallet().address.toLowerCase();
 const nonce=Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,'0')).join('');
 const issued=new Date(Date.now()-1000).toISOString(),expires=new Date(Date.now()+5*60_000).toISOString();
 const payload=await sha256Hex(JSON.stringify({code}));
 const message=['Lemniscate wants you to sign this message.','','Action: invites.redeem',`Address: ${address}`,`Payload: ${payload}`,`Nonce: ${nonce}`,`Issued: ${issued}`,`Expires: ${expires}`,'Chain: 4663'].join('\n');
 const signature=await W.signMessage(message);
 return api.inviteRedeem({address,nonce,issued,expires,signature,code});
}
/** Resolves true once this wallet is approved, false if the person closes the sheet. */
function inviteModal(){
 return new Promise(async resolve=>{
  if(!W.wallet().address){await connect();if(!W.wallet().address)return resolve(false)}
  let done=false;const finish=v=>{if(!done){done=true;resolve(v)}};
  const d=modal('Enter your invite code',`<p>Lemniscate is invite-only for now. Paste the code you were given.</p><label class="dash-label" for="invite-code">Invite code</label><input class="dash-field" id="invite-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" maxlength="24"><p id="invite-error" class="dash-error" role="alert" hidden></p><div class="dash-actions" style="margin-top:18px">${button('Redeem code','invite-redeem','gold')}${button('Cancel','modal-cancel','ghost')}</div><p class="dash-muted" style="margin-top:14px">Your wallet asks you to sign a short message. It sends no transaction and costs no gas. Invite codes only gate this website; the contracts stay open to everyone.</p>`);
  const input=d.querySelector('#invite-code'),err=d.querySelector('#invite-error'),go=d.querySelector('[data-action="invite-redeem"]');
  d.querySelector('[data-action="modal-cancel"]').onclick=()=>{closeModal();finish(false)};
  const submit=async()=>{
   err.hidden=true;go.disabled=true;
   try{
    await redeemInvite(input.value);
    data.invites={required:true,approved:true};closeModal();toast('You are in. Buying is open for this wallet.');render();finish(true);
   }catch(error){
    err.textContent=error.status!==undefined&&error.code?error.message:W.walletErrorText(error);err.hidden=false;go.disabled=false;
   }
  };
  go.onclick=submit;input.addEventListener('keydown',e=>{if(e.key==='Enter')submit()});
  input.focus();
 });
}
async function ensureInvite(){
 await loadInvites();
 if(!needsInvite())return true;
 return inviteModal();
}

// ---------------------------------------------------------------- transactions
function progress(title,steps){
 const d=modal(title,`<ol class="dash-steps">${steps.map((s,i)=>`<li data-step="${i}">${esc(s)}</li>`).join('')}</ol><p class="dash-transaction-note" id="tx-status">Check your wallet.</p>`);
 return {
  step(i){d.querySelectorAll('[data-step]').forEach(li=>{const n=Number(li.dataset.step);li.classList.toggle('done',n<i);li.classList.toggle('active',n===i)})},
  status(text){const s=d.querySelector('#tx-status');if(s)s.innerHTML=text},
  dialog:d,
 };
}
async function ensureAllowance(token,spender,amount,ui,i){
 const who=W.wallet().address;
 const current=decodeUint(await W.ethCall(CFG,token,call('allowance',[['address',who],['address',spender]])));
 if(current>=BigInt(amount))return;
 ui.step(i);ui.status('Approve exactly '+money(Number(fromRaw(amount,6,2)))+' USDG in your wallet.');
 const hash=await W.sendTransaction(CFG,{to:token,data:call('approve',[['address',spender],['uint',amount]])});
 ui.status('Waiting for the approval to confirm…');await W.waitForReceipt(CFG,hash);
}
function record(r){receipts.unshift({t:Date.now(),account:owner(),...r});if(!DEMO)save(RECEIPTS_KEY,receipts.slice(0,200))}
async function afterTrade(){await loadAccount();await refreshChain(selected);render()}

async function runIntent(kind,body,label,nameForReceipt){
 if(!canTrade())return toast('Trading is not available right now.');
 if(DEMO){
  try{const intent=await api.intent(kind,{...body,account:owner()});const hash=api.settle(intent);record({hash,kind,description:label,usdg:intent.display.usdg,name:nameForReceipt,queued:intent.queued,demo:true});closeModal();toast(kind==='sell'?'Demo sale recorded.':'Demo position opened.');tab='positions';history.replaceState(null,'',qs({tab}));await afterTrade()}
  catch(error){toast(error.reason?BLOCK_REASON[error.reason]||error.message:error.message||'The demo trade failed.')}
  return;
 }
 if(!W.wallet().address){await connect();if(!W.wallet().address)return}
 if(kind!=='sell'&&!await ensureInvite())return;
 const oneTap=CFG.oneTap&&!!smartAddress();
 const ui=progress(label,oneTap?['Prepare the one-tap operation','Sign in your wallet','Wait for the network']:['Prepare the transaction','Approve USDG if needed','Confirm in your wallet','Wait for the network']);
 try{
  ui.step(0);ui.status('Preparing…');
  const full={...body,slippageBps:prefs.slippageBps,deadlineSeconds:prefs.deadlineSeconds};
  let hash,intent;
  if(oneTap){
   let laneProof=null;
   if(kind==='sell'){
    const account=smartAddress();
    if(!laneProofs.peek(account,CFG.chainId))ui.status('Sign the message in your wallet to show this account is yours. It sends nothing and costs no gas. If you decline, the sale still goes ahead.');
    laneProof=await laneProofs.get(account,CFG.chainId);
    ui.status('Preparing…');
   }
   const r=await api.intent(kind,{...full,account:smartAddress(),owner:W.wallet().address,...(laneProof?{laneProof}:{})},{userop:true});intent=r.fallback||r;
   const gasNote=sponsorNote(r.sponsorship);
   ui.step(1);ui.status('Sign the operation in your wallet.'+(gasNote?'<br>'+esc(gasNote):''));
   const signature=await W.signHash(r.userOpHash);
   const sent=await api.useropSend({...r.userOp,signature});
   ui.step(2);ui.status('Waiting for the network…');
   const end=Date.now()+180_000;
   while(Date.now()<end){const s=await api.useropStatus(sent.userOpHash).catch(()=>null);if(s?.status==='included'){hash=s.transactionHash;break}if(s?.status==='reverted')throw new Error('The operation was reverted on chain.');await new Promise(r=>setTimeout(r,2500))}
   if(!hash)throw new Error('The operation is still pending. Check Activity in a minute.');
  }else{
   intent=await api.intent(kind,{...full,account:W.wallet().address});
   for(const a of intent.approvals||[])await ensureAllowance(a.token,a.spender,a.amount,ui,1);
   ui.step(2);ui.status(intent.queued?'This sell joins the queue for a fresh price. Confirm it in your wallet.':'Confirm the transaction in your wallet.');
   hash=await W.sendTransaction(CFG,{to:intent.to,data:intent.data,value:intent.value});
   ui.step(3);ui.status('Waiting for the network…');await W.waitForReceipt(CFG,hash);
  }
  record({hash,kind,description:label,usdg:intent.display?.usdg,name:nameForReceipt,queued:!!intent.queued});
  ui.step(9);ui.status(`Done. <a href="${esc(explorerTx(hash))}" target="_blank" rel="noopener">View the receipt ↗</a>${intent.note?'<br>'+esc(intent.note):''}`);
  toast(kind==='sell'?(intent.queued?'Your sell is queued for a fresh price.':'Your sale is complete.'):kind==='shield'?'Your Shield is in place.':'Your option position is open.');
  await afterTrade();
 }catch(error){
  if(error.code==='INVITE_REQUIRED'){data.invites={required:true,approved:false};closeModal();render();if(await inviteModal())toast('Your wallet is approved. Open your option again.');return}
  const msg=error.status===503&&error.code!=='AA_UNAVAILABLE'&&oneTap?'One-tap trading is busy right now. Wait a moment and try again.':error.reason?(BLOCK_REASON[error.reason]||error.message):(error.status!==undefined&&error.code?error.message:W.walletErrorText(error));
  ui.status(`<span class="dash-error" role="alert">${esc(msg)}</span>`);
 }
}

function review(){
 const row=currentRow(),opt=optionAt(row,side==='call'),q=quoteState.result;if(!opt||!q)return;
 const isCall=side==='call',max=num(q.display.usdg)*(1+prefs.slippageBps/10_000);
 const label=`${selected} ${isCall?'Up':'Down'} · ${speed==='WEEKLY'?'Weekly':'Daily'} · ${money(num(row.strike))}`;
 const d=modal('Review your option',`<span class="lm-eyebrow">${esc(label)}</span><div class="dash-cost-first"><strong>${esc(q.display.displayCost.replace(/^costs/,'Costs'))}</strong><span>${pays(selected,isCall,q.display.breakeven)}</span></div><div class="dash-modal-row"><span>Option units</span><strong>${esc(units)}</strong></div><div class="dash-modal-row"><span>Quoted amount</span><strong>${money(num(q.display.usdg))}</strong></div><div class="dash-modal-row"><span>Includes notional fee</span><strong>${money(num(q.display.feeUsdg))}</strong></div><div class="dash-modal-row"><span>Most you can pay (slippage ${fmt(prefs.slippageBps/100,1)}%)</span><strong>${money(max)}</strong></div><div class="dash-modal-total"><small>Maximum buyer loss</small><strong>${money(max)}</strong></div>${notice(sessionNote(selected))}<p>The tokens this purchase gives you cannot be transferred for 30 minutes after it, and selling them in that time is priced at the less favourable of the current price and the purchase price. Options are bought for your own wallet only.</p><p>There is no expiry. The continuing holding cost reduces effective units. Your option can lose its entire purchase amount.</p>`,button('Go back','modal-cancel','ghost')+button('Open position','confirm-buy','gold'));
 d.querySelector('[data-action="modal-cancel"]').onclick=closeModal;
 d.querySelector('[data-action="confirm-buy"]').onclick=()=>runIntent('buy',{series:opt.id,units},label,selected);
}
function reviewShield(){
 const name=shieldName||selected,pick=shieldRows(name).find(r=>r.row.strike===shieldStrike),q=shieldQuote.result;if(!pick||!q)return;
 const S=num(chainOf(name).spot),bps=Math.min(5000,Math.max(100,Math.round((1-num(pick.row.strike)/S)*10_000)));
 const u=shieldUnits||'1',label=`Shield · ${name} Down · Weekly · ${money(num(pick.row.strike))}`;
 const d=modal('Review your protection',`<span class="lm-eyebrow">${esc(label)}</span><div class="dash-cost-first"><strong>${esc(q.display.displayCost.replace(/^costs/,'Costs'))}</strong><span>${pays(name,false,q.display.breakeven)}</span></div><div class="dash-modal-row"><span>Stock Token units covered</span><strong>${esc(u)}</strong></div><div class="dash-modal-row"><span>Quoted amount</span><strong>${money(num(q.display.usdg))}</strong></div><div class="dash-modal-total"><small>Most you can pay (slippage ${fmt(prefs.slippageBps/100,1)}%)</small><strong>${money(num(q.display.usdg)*(1+prefs.slippageBps/10_000))}</strong></div><p>The engine buys the listed Weekly Down option nearest ${fmt(bps/100,1)}% below the price when the transaction runs. It stays until you sell it.</p>`,button('Go back','modal-cancel','ghost')+button('Add Shield','confirm-shield','gold'));
 d.querySelector('[data-action="modal-cancel"]').onclick=closeModal;
 d.querySelector('[data-action="confirm-shield"]').onclick=()=>runIntent('shield',{name,tokenUnits:u,strikePctBelowBps:bps},label,name);
}
// R02 (decision 54): the hold binds only the tokens a recent purchase gave this wallet; they are priced at the less
// favourable of the current price and the purchase price, and cannot be transferred, until it ends. Selling stays open.
function holdText(h){const until=new Date(h.until);const at=isNaN(until)?'the hold ends':until.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});return `${h.tokens?esc(h.tokens)+' of these tokens were':'These tokens were'} bought less than 30 minutes ago. Until ${at} they are priced at the less favourable of the current price and your purchase price (${money(num(h.buyPrice))}) and cannot be transferred.`}
function sell(seriesId){
 const p=data.positions?.positions?.find(x=>x.seriesId===seriesId);if(!p)return;
 const max=(Math.floor(num(p.units)*1e6)/1e6).toFixed(6).replace(/\.?0+$/,'');
 const label=`${p.name} ${p.isCall?'Up':'Down'} exit`;
 const d=modal('Exit your position',`<span class="lm-eyebrow">${esc(p.name)} · ${p.isCall?'Up call':'Down put'} · ${p.speed==='WEEKLY'?'Weekly':'Daily'} · ${money(num(p.strike))}</span><label class="dash-label" for="sell-units">Effective units to sell<small>Up to ${esc(max)}</small></label><input class="dash-field" id="sell-units" inputmode="decimal" value="${esc(max)}"><div id="sell-summary"><p class="dash-muted">Fetching the bid…</p></div><p class="dash-transaction-note">Sells are always open. Outside regular hours the bid uses a wider spread; during a feed halt the sell joins a queue and fills at the first fresh price.</p>`,button('Keep holding','modal-cancel','ghost')+button('Confirm exit','confirm-sell','gold','disabled'));
 let current=null,timer=null;
 const update=()=>{clearTimeout(timer);const v=d.querySelector('#sell-units').value.trim();const okNum=/^\d{1,12}(\.\d{1,18})?$/.test(v)&&num(v)>0&&num(v)<=num(max);const confirm=d.querySelector('[data-action="confirm-sell"]');confirm.disabled=true;
  if(!okNum){d.querySelector('#sell-summary').innerHTML='<p class="dash-error">Enter an amount within your remaining units.</p>';return}
  timer=setTimeout(async()=>{try{const who=owner();const q=await api.quote({series:seriesId,units:v,side:'sell',...(who?{account:who}:{})});current={v,q};const s=q.display.session;
   d.querySelector('#sell-summary').innerHTML=`<div class="dash-modal-total"><small>Proceeds after spread and fee</small><strong>${money(num(q.display.usdg))}</strong></div>${line('Least you accept (slippage '+fmt(prefs.slippageBps/100,1)+'%)',q.sellQueued?'Set at the fill':money(num(q.display.usdg)*(1-prefs.slippageBps/10_000)))}${q.sellQueued?notice(SESSION_NOTE.HALTED,'warn'):s==='CLOSED'||s==='UNKNOWN'||s==='EXTENDED'?notice(SESSION_NOTE[s]):''}${q.hold?.applied?notice(holdText(q.hold)):''}`;confirm.disabled=false}
   catch(error){d.querySelector('#sell-summary').innerHTML=`<p class="dash-error">${esc(plainError(error))}</p>`}},250)};
 d.querySelector('#sell-units').addEventListener('input',update);update();
 d.querySelector('[data-action="modal-cancel"]').onclick=closeModal;
 d.querySelector('[data-action="confirm-sell"]').onclick=()=>{if(current)runIntent('sell',{series:seriesId,units:current.v},label,p.name)};
}

async function poolClaim(id){
 const pool=data.config.contracts.pool,who=W.wallet().address;
 const ui=progress('Claim withdrawal',['Confirm in your wallet','Wait for the network']);
 try{
  ui.step(0);ui.status('Confirm in your wallet.');
  const hash=await W.sendTransaction(CFG,{to:pool,data:call('claim',[['uint',id]])});
  ui.step(1);ui.status('Waiting for the network…');await W.waitForReceipt(CFG,hash);
  record({hash,kind:'pool',description:'Writer Pool withdrawal claimed · ticket #'+id,name:'Writer Pool'});
  ui.step(9);ui.status(`Done. If the pool could pay only part today, the ticket stays listed and you can claim again tomorrow. <a href="${esc(explorerTx(hash))}" target="_blank" rel="noopener">View the receipt ↗</a>`);
  await loadAccount();render();
 }catch(error){ui.status(`<span class="dash-error" role="alert">${esc(W.walletErrorText(error))}</span>`)}
}
async function poolReview(){
 const input=document.getElementById('pool-amount')?.value||'';const pool=data.config.contracts.pool,usdg=data.config.contracts.usdg,who=W.wallet().address;
 const deposit=poolMode==='deposit',dec=deposit?6:(data.config.poolShareDecimals??12);
 let raw;try{raw=toRaw(input,dec)}catch(error){return toast(error.message)}
 if(raw<=0n)return toast('Enter an amount above zero.');
 if(deposit&&data.account.usdg!==undefined&&raw>data.account.usdg)return toast('Your wallet holds less USDG than this deposit.');
 if(!deposit&&data.account.shares!==undefined&&raw>data.account.shares)return toast('That is more than your pool shares.');
 if(!deposit&&data.account.unlock&&data.account.unlock*1000>Date.now())return toast('Your latest deposit is still locked. Try again after '+fmtTime(data.account.unlock*1000)+'.');
 let preview=0n;try{preview=decodeUint(await W.ethCall(CFG,pool,call(deposit?'previewDeposit':'previewRedeem',[['uint',raw]])))}catch{}
 const d=modal(deposit?'Review pool deposit':'Review pool withdrawal',`<div class="dash-modal-total"><small>${deposit?'USDG deposit':'Shares to queue for withdrawal'}</small><strong>${deposit?money(Number(fromRaw(raw,6,2))):fmt(Number(fromRaw(raw,dec,4)),4)}</strong></div>${line(deposit?'Shares you receive (estimate)':'Worth now (estimate, paid at claim)',deposit?fmt(Number(fromRaw(preview,data.config.poolShareDecimals??12,4)),4):money(Number(fromRaw(preview,6,2))))}<p style="margin-top:20px">${deposit?'Deposits mint shares at NAV. Pool NAV can fall with losses, and writers can lose more than they earn.':`This puts your shares in the withdrawal queue and gives you a ticket. You claim it${data.account.queueDelay!=null?' after '+PQ.waitText(data.account.queueDelay):' once it matures'}, and the USDG is paid at NAV when you claim. When many writers exit at once, a claim can be paid in part and the rest stays claimable.`}</p>`,button('Go back','modal-cancel','ghost')+button(deposit?'Deposit':'Request withdrawal','confirm-pool','gold'));
 d.querySelector('[data-action="modal-cancel"]').onclick=closeModal;
 d.querySelector('[data-action="confirm-pool"]').onclick=async()=>{
  const ui=progress(deposit?'Writer Pool deposit':'Writer Pool withdrawal',deposit?['Approve USDG if needed','Confirm the deposit','Wait for the network']:['Confirm the request','Wait for the network']);
  try{
   if(deposit)await ensureAllowance(usdg,pool,raw,ui,0);
   ui.step(deposit?1:0);ui.status('Confirm in your wallet.');
   const hash=await W.sendTransaction(CFG,{to:pool,data:deposit?call('deposit',[['uint',raw],['address',who]]):call('requestWithdraw',[['uint',raw]])});
   ui.step(deposit?2:1);ui.status('Waiting for the network…');if(deposit)await W.waitForReceipt(CFG,hash);
   let queued=null;
   if(!deposit){const receipt=await W.waitForReceipt(CFG,hash).catch(()=>null);queued=PQ.queuedFromReceipt(receipt,pool,who)[0]||null;if(queued)PQ.addTickets(who,[queued.id])}
   record({hash,kind:'pool',description:deposit?'Writer Pool deposit':'Writer Pool withdrawal requested'+(queued?' · ticket #'+queued.id:''),usdg:deposit?fromRaw(raw,6):fromRaw(preview,6),name:'Writer Pool'});
   const wait=queued?.claimableAt?`Ticket #${esc(queued.id)}. You can claim it ${esc(fmtTime(queued.claimableAt*1000))}.`:'Your ticket is listed under Withdraw once the network has it.';
   ui.step(9);ui.status(`Done. ${deposit?'':wait+' '}<a href="${esc(explorerTx(hash))}" target="_blank" rel="noopener">View the receipt ↗</a>`);
   data.pool=await api.pool().catch(()=>data.pool);await loadAccount();render();
  }catch(error){ui.status(`<span class="dash-error" role="alert">${esc(W.walletErrorText(error))}</span>`)}
 };
}

function createPolicy(){
 const router=data.config?.contracts?.agentRouter;if(!router||DEMO)return;
 const stocks=data.config.stocks||[];
 const d=modal('Create an agent policy',`<label class="dash-label" for="policy-agent">Agent address</label><input class="dash-field" id="policy-agent" placeholder="0x…" autocomplete="off"><label class="dash-label" for="policy-budget">Budget in USDG</label><input class="dash-field" id="policy-budget" inputmode="decimal" value="500"><label class="dash-label" for="policy-trade">Most per trade in USDG</label><input class="dash-field" id="policy-trade" inputmode="decimal" value="100"><div class="dash-label">Allowed names</div><div class="dash-checks">${stocks.map((s,i)=>`<label><input type="checkbox" name="policy-market" value="${esc(s.name)}" ${i<2?'checked':''}>${esc(s.name)}</label>`).join('')}</div><div class="dash-checks"><label><input type="checkbox" id="policy-sell" checked>May sell</label><label><input type="checkbox" id="policy-shield">May Shield</label></div><label class="dash-label" for="policy-expiry">Expiry</label><select class="dash-field" id="policy-expiry"><option value="1">24 hours</option><option value="7" selected>7 days</option><option value="30">30 days</option></select><p class="dash-ticket-note">Two transactions: approve the budget in USDG for the agent router, then set the policy.</p><p id="policy-error" class="dash-error" hidden></p>`,button('Go back','modal-cancel','ghost')+button('Create policy','confirm-policy','gold'));
 d.classList.add('dash-policy-sheet');d.querySelector('[data-action="modal-cancel"]').onclick=closeModal;
 // Local storage holds only this unsent form (todo 18b R2); the policies themselves come from the service.
 const draft=load(DRAFT_KEY,null),f=id=>d.querySelector('#'+id);
 if(draft){f('policy-agent').value=draft.agent||'';f('policy-budget').value=draft.budget||f('policy-budget').value;f('policy-trade').value=draft.per||f('policy-trade').value;
  if(draft.days)f('policy-expiry').value=draft.days;if(draft.sell!=null)f('policy-sell').checked=!!draft.sell;if(draft.shield!=null)f('policy-shield').checked=!!draft.shield;
  if(Array.isArray(draft.names))d.querySelectorAll('[name="policy-market"]').forEach(x=>{x.checked=draft.names.includes(x.value)})}
 const keepDraft=()=>save(DRAFT_KEY,{agent:f('policy-agent').value.trim(),budget:f('policy-budget').value,per:f('policy-trade').value,days:f('policy-expiry').value,sell:f('policy-sell').checked,shield:f('policy-shield').checked,names:[...d.querySelectorAll('[name="policy-market"]:checked')].map(x=>x.value)});
 d.addEventListener('input',keepDraft);d.addEventListener('change',keepDraft);
 d.querySelector('[data-action="confirm-policy"]').onclick=async()=>{
  const err=d.querySelector('#policy-error');const agent=d.querySelector('#policy-agent').value.trim();
  const picked=[...d.querySelectorAll('[name="policy-market"]:checked')].map(x=>x.value);
  let budget,per;try{budget=toRaw(d.querySelector('#policy-budget').value,6);per=toRaw(d.querySelector('#policy-trade').value,6)}catch(e){err.textContent=e.message;err.hidden=false;return}
  if(!isAddress(agent)||agent.toLowerCase()===W.wallet().address){err.textContent='Enter the agent’s own wallet address (not yours).';err.hidden=false;return}
  if(budget<=0n||per<=0n||per>budget||!picked.length){err.textContent='Choose a budget, a per-trade limit no larger than the budget, and at least one name.';err.hidden=false;return}
  const days=Number(d.querySelector('#policy-expiry').value),expiresAt=Math.floor(Date.now()/1000)+days*86400;
  const canSell=d.querySelector('#policy-sell').checked,canShield=d.querySelector('#policy-shield').checked;
  const addrs=stocks.filter(s=>picked.includes(s.name)).map(s=>s.stock);
  const ui=progress('Agent policy',['Approve the USDG budget','Set the policy','Wait for the network']);
  try{
   await ensureAllowance(data.config.contracts.usdg,router,budget,ui,0);
   ui.step(1);ui.status('Confirm the policy in your wallet.');
   const hash=await W.sendTransaction(CFG,{to:router,data:call('setPolicy',[['address',agent],['uint',budget],['uint',per],['uint',expiresAt],['bool',canSell],['bool',canShield]],addrs)});
   ui.step(2);ui.status('Waiting for the network…');await W.waitForReceipt(CFG,hash);
   try{localStorage.removeItem(DRAFT_KEY)}catch{}
   record({hash,kind:'policy',description:'Agent policy set · '+short(agent),name:'Agent desk'});
   ui.step(9);ui.status(`Policy set. <a href="${esc(explorerTx(hash))}" target="_blank" rel="noopener">View the receipt ↗</a><br>It shows on this page once the service has read it from the chain.`);afterPolicy();
  }catch(error){ui.status(`<span class="dash-error" role="alert">${esc(W.walletErrorText(error))}</span>`)}
 };
}
async function revokePolicy(agent){
 const router=data.config?.contracts?.agentRouter;if(!router)return;
 const ui=progress('Revoke policy',['Confirm in your wallet','Wait for the network']);
 try{ui.step(0);const hash=await W.sendTransaction(CFG,{to:router,data:call('revoke',[['address',agent]])});ui.step(1);ui.status('Waiting for the network…');await W.waitForReceipt(CFG,hash);
  record({hash,kind:'policy',description:'Agent policy revoked · '+short(agent),name:'Agent desk'});
  ui.step(9);ui.status(`Revoked. <a href="${esc(explorerTx(hash))}" target="_blank" rel="noopener">View the receipt ↗</a><br>The card updates once the service has read it from the chain.`);afterPolicy();
 }catch(error){ui.status(`<span class="dash-error" role="alert">${esc(W.walletErrorText(error))}</span>`)}
}
/** After a policy transaction the indexer needs a few seconds; re-read now and again shortly after. */
function afterPolicy(){
 const reload=async()=>{if(disposed)return;await Promise.all([loadAgents(),loadActivity()]);if(!root.querySelector('input:focus'))render()};
 reload();[4000,12000,30000].forEach(ms=>timers.push(setTimeout(reload,ms)));
}

// ---------------------------------------------------------------- exports
function download(name,body,type){const url=URL.createObjectURL(new Blob([body],{type})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Your export is ready.')}
const csv=rows=>rows.map(r=>r.map(x=>'"'+String(x??'').replace(/"/g,'""')+'"').join(',')).join('\n');

// ---------------------------------------------------------------- events
listen('input',e=>{
 if(e.target.id==='order-units'){units=e.target.value.trim();requestQuote();updateQuote()}
 if(e.target.id==='shield-units'){shieldUnits=e.target.value.trim();requestShieldQuote()}
});
listen('change',async e=>{if(e.target.id==='shield-market'){shieldName=e.target.value;shieldStrike=null;await loadNameExtras(shieldName);render();requestShieldQuote()}});
listen('click',async e=>{const b=e.target.closest('[data-action]');if(!b||b.disabled)return;const a=b.dataset.action;
 if(a==='tab')changeTab(b.dataset.tab);
 else if(a==='mobile-menu')mobileMenu();
 else if(a==='connect')connect();
 else if(a==='onb-dismiss'){Onb.dismiss(W.wallet().address||'');render()}
 else if(a==='onb-switch'){try{await W.switchChain(CFG)}catch(error){toast(W.walletErrorText(error))}render()}
 else if(a==='onb-positions'){seenPositionsNow=true;Onb.writeWallet(W.wallet().address||'',{seenPositions:true});changeTab('positions')}
 else if(a==='invite'){if(await inviteModal())await loadAccount()}
 else if(a==='disconnect'){W.disconnect();toast('Wallet disconnected.')}
 else if(a==='retry'){data.loading=true;render();await loadMarkets();await loadAccount();render();requestQuote()}
 else if(a==='region-ok'){declare(false);region={status:'allowed',source:'declaration'};render();start()}
 else if(a==='region-blocked'){declare(true);region={status:'blocked',source:'declaration'};render()}
 else if(a==='region-reset'){try{localStorage.removeItem('lemniscate.region.v1')}catch{}region={status:'unknown'};render()}
 else if(a==='open-name'){selected=b.dataset.name;strike=null;changeTab('trade');loadNameExtras(selected).then(render)}
 else if(a==='market'){selected=b.dataset.market;strike=null;render();requestQuote();await Promise.all([refreshChain(selected),loadNameExtras(selected)]);render();requestQuote()}
 else if(a==='direction'){side=b.dataset.direction;render();requestQuote()}
 else if(a==='speed'){speed=b.dataset.speed;strike=null;render();requestQuote()}
 else if(a==='strike'){strike=b.dataset.strike;render();requestQuote()}
 else if(a==='review')review();
 else if(a==='review-shield')reviewShield();
 else if(a==='shield-level'){shieldStrike=b.dataset.strike;render();requestShieldQuote()}
 else if(a==='sell')sell(b.dataset.id);
 else if(a==='position-detail'){const p=data.positions?.positions?.find(x=>x.seriesId===b.dataset.id);if(p)modal(p.name+' position details',`${line('Direction',p.isCall?'Up call':'Down put')}${line('Pricing speed',p.speed==='WEEKLY'?'Weekly':'Daily')}${line('Strike',money(num(p.strike)))}${line('Token balance',fmt(num(p.balance),6))}${line('Normalization factor',fmt(num(p.norm),6))}${line('Effective units',fmt(num(p.units),6))}${line('Paid in',money(num(p.costBasisUsdg)))}${line('Received from sales',money(num(p.proceedsUsdg)))}<p style="overflow-wrap:anywhere;margin-top:18px;font-size:11px">Option token ${esc(p.token)}</p><p style="margin-top:14px">The normalization factor reduces effective option units with continuing funding. The option has no scheduled expiry.</p>`)}
 else if(a==='pool-mode'){poolMode=b.dataset.mode;render()}
 else if(a==='pool-review')poolReview();
 else if(a==='pool-claim')poolClaim(b.dataset.ticket);
 else if(a==='create-policy')createPolicy();
 else if(a==='revoke-policy')revokePolicy(b.dataset.agent);
 else if(a==='agent-trades'){await loadAgents();render()}
 else if(a==='activity-more'){await loadActivity(true);render()}
 else if(a==='export-positions'){const p=data.positions?.positions||[];download('lemniscate-positions.csv',csv([['Underlying','Direction','Speed','Strike','Effective units','Value at bid USDG','Paid in USDG','Series'],...p.map(x=>[x.name,x.isCall?'Up':'Down',x.speed,x.strike,x.units,x.valueAtBidUsdg,x.costBasisUsdg,x.seriesId])]),'text/csv')}
 else if(a==='export-activity'){const feed=MODE==='live'&&data.activity&&!data.activity.error?data.activity.items.map(i=>[i.ts,(KIND_TITLE[i.kind]||i.kind)+(i.name?' · '+optionLabel(i):''),i.usdg,i.txHash]):receipts.map(r=>[new Date(r.t).toISOString(),r.description,r.usdg,r.demo?'demo':r.hash]);download('lemniscate-activity.csv',csv([['Time','Action','Amount USDG','Transaction'],...feed]),'text/csv')}
 else if(a==='export-policies')download('lemniscate-agent-policies.json',JSON.stringify(data.agents?.agents||[],null,2),'application/json');
 else if(a==='save-settings'){prefs.slippageBps=Number(root.querySelector('#slippage').value);prefs.deadlineSeconds=Number(root.querySelector('#deadline').value);const sa=root.querySelector('#smart-account');if(sa){const v=sa.value.trim();if(v&&!isAddress(v))return toast('Enter a valid smart account address or leave it empty.');prefs.smartAccount=v}save(PREFS_KEY,prefs);toast('Preferences saved.');await loadAccount();render()}
 else if(a==='cost-help'){const pr=data.config?.pricing;modal('Know the cost',`<p>Everlasting pricing: Daily has a one-day mean and Weekly a seven-day mean. Neither expires.</p><p style="margin-top:18px">${pr?`The spread is ${pr.spreadBpsAtm/100}% of the option price at the money, rising to ${pr.spreadBpsFar/100}% for strikes far from the price, with a minimum of $${pr.minSpreadUsd.toFixed(2)} per unit. It is ${pr.sessionMultipliers.EXTENDED} times wider in extended hours and ${pr.sessionMultipliers.CLOSED} times wider while the market is closed. A ${pr.feeBps} basis point fee on the underlying notional is added.`:'Spread and fee figures appear when live data is available.'} The daily cost reduces effective option units.</p>`)}
 else if(a==='pool-help')modal('The writer side',`<p>The Writer Pool sells options, receives funding and spread, and hedges exposure. NAV accounts for collateral, hedge positions, option liabilities and the reserve.</p><p style="margin-top:18px">Deposits mint shares at NAV and are locked for a short period. Withdrawals are limited by free collateral, so in a rush of exits each one can be filled only in part. Market gaps and hedging losses can reduce NAV, and writers can lose more than they earn.</p>`);
 else if(a==='vault-up'||a==='vault-down')modal(a==='vault-up'?'Covered Up vault':'Cash Down vault',`<span class="lm-eyebrow">Phase 2 · closed until audit</span><p style="margin-top:20px">${a==='vault-up'?'Stock Tokens collateralize short calls at one raw unit per call unit.':'USDG collateral equals strike multiplied by put units.'} The vault takes a slice of pool exposure and receives its funding and spread share.</p><p style="margin-top:18px">Vault deposits and withdrawals use seven-day epochs. Collateral limits the vault’s loss, and the vault is never liquidated. Writers can lose more than they earn.</p>`);
});

// ---------------------------------------------------------------- start
const unWallet=W.onWallet(async()=>{await loadAccount();render()});
let started=false;
async function start(){
 if(started)return;started=true;
 if(MODE==='offline'){data.loading=false;render();return}
 await loadMarkets();if(disposed)return;
 if(!DEMO)await W.reconnect(CFG).catch(()=>null);
 await loadAccount();render();requestQuote();requestShieldQuote();
 timers.push(setInterval(async()=>{if(document.hidden||region.status!=='allowed')return;await refreshChain(selected);data.pool=await api.pool().catch(()=>data.pool);if(!root.querySelector('input:focus'))render();requestQuote()},15_000));
 timers.push(setInterval(async()=>{if(document.hidden||!owner()||region.status!=='allowed')return;await loadAccount();if(!root.querySelector('input:focus'))render()},30_000));
}
render();
regionStatus(CFG).then(r=>{region=r;render();if(r.status==='allowed')start()}).finally(()=>window.LM.finishLoading());
return {dispose:()=>{disposed=true;events.abort();timers.forEach(clearInterval);clearTimeout(quoteTimer);clearTimeout(shieldTimer);unWallet()}};
};
