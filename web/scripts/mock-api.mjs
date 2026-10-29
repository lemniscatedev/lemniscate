// Local mock of the Lemniscate API for website tests (todo 18). Same routes and response shapes as the backend
// (app/src/api, OpenAPI at /v1/openapi.json there), data from dist/chain/demo.js. Never used in production.
// Run: node scripts/mock-api.mjs [port]   (env MOCK_SESSION=REGULAR|EXTENDED|CLOSED|UNKNOWN|HALTED, MOCK_EARNINGS=TSLA,
// MOCK_SPLIT=AAPL, MOCK_NO_ROUTER=1, MOCK_INVITES=1 turns the invite gate on; the one valid code is ABCD-EFGH-2345,
// MOCK_POOL=empty|filling: the zero-seed launch states of the Writer Pool)
import http from 'node:http';
import {createDemoMarket} from '../dist/chain/demo.js';

export function startMockApi({port=4190,overrides={},seed=false}={}){
 const market=createDemoMarket(overrides);
 const held=new Map();// account -> Map(seriesId -> {units,cost,proceeds})
 const log=[];
 const feed=new Map();// account -> activity items, oldest first
 const agentBook=new Map();// owner -> agent rows
 const smartSeen=new Set();
 const approved=new Set();// wallets that redeemed an invite code (overrides.invites turns the gate on)
 const usedCodes=new Set();
 const VALID_CODE='ABCDEFGH2345';// the one code this mock accepts, once
 const ACCOUNT_SEED='0x00000000000000000000000000000000000a11ce';
 const cfg=market.config();
 const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Cache-Control':'no-store'});res.end(JSON.stringify(body))};
 const readBody=req=>new Promise(resolve=>{let s='';req.on('data',c=>s+=c);req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{resolve(null)}})});
 const FILL=['pool_deposit','withdraw_requested','withdraw_claimed','pool_withdraw'];
 const hex=(n,len=64)=>BigInt(n).toString(16).padStart(len,'0');
 function positions(account){
  const book=held.get(account)||new Map();let value=0,daily=0,cost=0,pnl=0;
  const rows=[...book.entries()].filter(([,p])=>p.units>1e-9).map(([id,p])=>{const s=market.series.get(id),q=market.quote(id,p.units,'sell');const v=Number(q.display.usdg),d=Number(q.display.dailyCostUsdg);value+=v;daily+=d;cost+=p.cost;pnl+=v+p.proceeds-p.cost;
   return {seriesId:id,name:s.name,isCall:s.isCall,speed:s.speed,strike:String(s.strike),token:s.token,balance:p.units.toFixed(6),norm:'1',units:p.units.toFixed(6),valueAtBidUsdg:v.toFixed(6),dailyCostUsdg:d.toFixed(6),displayCost:q.display.displayCost,costBasisUsdg:p.cost.toFixed(6),proceedsUsdg:p.proceeds.toFixed(6),pnlUsdg:(v+p.proceeds-p.cost).toFixed(6),session:q.display.session,sellQueued:q.sellQueued}});
  return {account,asOf:new Date().toISOString(),positions:rows,totals:{valueAtBidUsdg:value.toFixed(6),dailyCostUsdg:daily.toFixed(6),costBasisUsdg:cost.toFixed(6),pnlUsdg:pnl.toFixed(6)},queuedSells:[]};
 }
 function intent(kind,body){
  if(!body||!/^0x[0-9a-f]{40}$/i.test(body.account||''))return [400,{error:'BAD_REQUEST',message:'Invalid request parameters.'}];
  let id=body.series,units=Number(body.units);
  if(kind==='shield'){const c=market.chain(body.name);if(!c)return [404,{error:'NOT_FOUND',message:'Unknown name: '+body.name}];const S=Number(c.spot),target=S*(1-(body.strikePctBelowBps??1000)/10_000);
   const row=c.speeds.find(s=>s.speed==='WEEKLY').strikes.filter(r=>r.put?.buyable).sort((a,b)=>Math.abs(a.strike-target)-Math.abs(b.strike-target))[0];
   if(!row)return [409,{error:'NO_SHIELD_SERIES',message:'No Weekly Down option is open for purchase on this name.'}];id=row.put.id;units=Number(body.tokenUnits)}
  const side=kind==='sell'?'sell':'buy',q=market.quote(id,units,side);if(!q)return [404,{error:'NOT_FOUND',message:'Unknown series.'}];
  if(side==='buy'&&(overrides.pool||'open')==='empty')return [409,{error:'BUY_BLOCKED',message:'The pool is filling. Trading opens as writers deposit into the Writer Pool. Sells stay open.',reason:'POOL_FILLING',capacity:{maxBuyUsdg:'0.000000',poolFilling:true}}];
  if(side==='buy'&&q.blockReason)return [409,{error:'BUY_BLOCKED',message:'New purchases are paused.',reason:q.blockReason}];
  const raw=BigInt(q.quote.usdg),slip=BigInt(body.slippageBps??50);
  const maxCost=(raw*(10_000n+slip)+9_999n)/10_000n,minProceeds=q.sellQueued?0n:raw*(10_000n-slip)/10_000n;
  const deadline=Math.floor(Date.now()/1000)+(body.deadlineSeconds??300);
  const data='0x'+(side==='buy'?'b1a2c3d4':'5e11c0de')+id.slice(2)+hex(Math.round(units*1e6))+hex(side==='buy'?maxCost:minProceeds)+hex(deadline)+hex('0x'+body.account.slice(2));
  const intentId=`${body.account.toLowerCase()}:${id}:${units}:${side}:${q.display.usdg}`;
  log.push({kind,intentId,data});
  return [200,{kind,to:cfg.contracts.engine,data,value:'0',approvals:side==='buy'?[{token:cfg.contracts.usdg,spender:cfg.contracts.engine,amount:maxCost.toString()}]:[],
   ...(side==='buy'?{maxCostUsdg:maxCost.toString()}:{minProceedsUsdg:minProceeds.toString(),tokens:String(BigInt(Math.round(units*1e6))*10n**12n)}),
   deadline,series:id,quote:q.quote,display:{usdg:q.display.usdg,displayCost:q.display.displayCost,breakeven:q.display.breakeven},queued:q.sellQueued,
   note:q.sellQueued?'The price feed is halted. This sell joins a queue and fills at the first fresh price; no minimum is set because the fill price is not known yet.':kind==='shield'?'The engine picks the listed Weekly Down series nearest your protection level when the transaction runs.':null}];
 }
 /** Test hook: settle the last intent for this calldata, as if the transaction was mined. */
 function settle(data,hash){
  const entry=[...log].reverse().find(x=>x.data===data);if(!entry)return false;
  const [account,id,units,side,usdg]=entry.intentId.split(':');const book=held.get(account)||new Map();const p=book.get(id)||{units:0,cost:0,proceeds:0};
  if(side==='sell'){p.units=Math.max(0,p.units-Number(units));p.proceeds+=Number(usdg)}else{p.units+=Number(units);p.cost+=Number(usdg)}
  book.set(id,p);held.set(account,book);
  const s=market.series.get(id);const list=feed.get(account)||[];
  list.push(item({kind:side==='sell'?'sell':'buy',txHash:hash||'0x'+hex(9000+list.length),block:String(1000+list.length),seriesId:id,name:s.name,isCall:s.isCall,speed:s.speed,strike:String(s.strike),usdg:String(usdg),amount:String(units)}));feed.set(account,list);
  return true;
 }

 const item=(o)=>({kind:'buy',ts:new Date().toISOString(),block:'1',txHash:'0x'+hex(1),logIndex:0,seriesId:null,name:null,isCall:null,speed:null,strike:null,usdg:null,amount:null,ticket:null,agent:null,filler:null,status:null,...o});
 /** Seed: 25 older pool rows (so cursor paging shows) and two agent policies for the fake wallet. */
 if(seed){
  const rows=[];for(let k=0;k<25;k++)rows.push(item({kind:FILL[k%4],ts:new Date(Date.UTC(2020,8,1,12,0,0)+k*3600e3).toISOString(),block:String(100+k),txHash:'0x'+hex(5000+k),usdg:String(10+k),ticket:k%4===1||k%4===2?String(k):null}));
  feed.set(ACCOUNT_SEED,rows);
  const nvda=[...market.series.values()].find(x=>x.name==='NVDA'&&x.isCall);
  const trade=(agent,side,usdg,k)=>({txHash:'0x'+hex(7000+k),logIndex:0,ts:new Date(Date.UTC(2026,9,10,12,0,0)+k*60e3).toISOString(),agent,seriesId:nvda?.id||'0x'+'ab'.repeat(32),name:'NVDA',isCall:true,speed:'WEEKLY',strike:'180',side,usdg});
  const A1='0x00000000000000000000000000000000000a9e01',A2='0x00000000000000000000000000000000000a9e02';
  agentBook.set(ACCOUNT_SEED,[
   {agent:A1,budgetUsdg:'500',maxPerTradeUsdg:'100',spentUsdg:'120',remainingBudgetUsdg:'380',expiresAt:'2100-01-01T00:00:00.000Z',canSell:true,canShield:false,allowedStocks:[{stock:'0x00000000000000000000000000000000000a0001',name:'NVDA'},{stock:'0x00000000000000000000000000000000000a0002',name:'TSLA'}],setAt:'2026-10-09T00:00:00.000Z',revoked:false,revokedAt:null,expired:false,active:true,tradeCount:2,recentTrades:[trade(A1,'buy',70,1),trade(A1,'sell',50,2)]},
   {agent:A2,budgetUsdg:'200',maxPerTradeUsdg:'50',spentUsdg:'0',remainingBudgetUsdg:'200',expiresAt:'2020-09-01T00:00:00.000Z',canSell:false,canShield:false,allowedStocks:[],setAt:'2026-08-01T00:00:00.000Z',revoked:true,revokedAt:'2026-08-20T00:00:00.000Z',expired:true,active:false,tradeCount:0,recentTrades:[]},
  ]);
 }
 const ADDR=/^0x[0-9a-fA-F]{40}$/;
 // Zero-seed launch (overrides.pool = 'empty' | 'filling'): the pool starts empty and fills from the public.
 function pool(){
  const base=market.pool(),stage=overrides.pool||'open';
  const nav=stage==='empty'?0:stage==='filling'?10_000:Number(base.nav);
  // open: some option value is already outstanding on each stock, so the room is a little under the 2% series cap
  const room=()=>Math.max(0,Math.min(40_000,nav*0.02)-(stage==='open'?250:0));
  return {...base,...(stage==='open'?{}:{nav:nav.toFixed(6),usdg:nav.toFixed(6),optionLiability:'0',navPerShare:'1',fundingReceived:{...base.fundingReceived,usdg:'0.000000'}}),
   capacity:{stage,fillingBelowNavUsdg:'25000',minTradeUsdg:'1',names:cfg.names.map(name=>({name,session:overrides.session||'REGULAR',maxBuyUsdg:room().toFixed(6),canBuyMinimum:room()>=1}))},
   writers:stage==='empty'?{depositedUsdg:'0',claimedUsdg:'0',wallets:0}:{depositedUsdg:stage==='filling'?'10000':'1250000',claimedUsdg:'0',wallets:stage==='filling'?3:41}};
 }
 const capacityQuote=(q,side)=>{if(!q||side==='sell')return q;const p=pool(),filling=p.capacity.stage==='empty';const out={...q,capacity:{maxBuyUsdg:p.capacity.names[0].maxBuyUsdg,poolFilling:filling}};if(filling)out.blockReason='POOL_FILLING';return out};
 function writerRewards(url){
  const a=(url.searchParams.get('address')||'').toLowerCase();
  const program={status:'awaiting_token',message:'Rewards start when $LMNS launches. Until then the numbers here are a preview of the last 7 days.',tokenSymbol:'LMNS',tokenAddress:null,weeklyPoolTokens:'1000000',weeklyPoolPctOfSupply:0.1,tokenTotalSupply:'1000000000',weeks:8,startAt:null,perWalletCapPct:10,minTimeWeightedUsdg:1000,overCapPaidToOthers:false,rules:[]};
  const week={number:null,preview:true,start:new Date(Date.now()-7*86400e3).toISOString(),end:new Date().toISOString(),final:false,eligibleWallets:2,totalPointsUsdgDays:'30500.00',allocatedTokens:'200000',unallocatedTokens:'800000',digest:'0'.repeat(64)};
  const you=a?{address:a,excluded:false,eligible:true,reason:'',depositHeldUsdg:'2000.000000',timeWeightedUsdg:'1857.142857',pointsUsdgDays:'13000.00',tokens:'100000',capped:true}:null;
  return {program,week,you,notes:[]};
 }
 function activityPage(account,url){
  const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit')||50)));
  const all=[...(feed.get(account)||[])].sort((a,b)=>Date.parse(b.ts)-Date.parse(a.ts)||b.block-a.block);
  const c=url.searchParams.get('cursor');let offset=0;
  if(c!==null){if(!/^o\d+$/.test(c))return [400,{error:'BAD_REQUEST',message:'Invalid cursor.'}];offset=Number(c.slice(1))}
  const items=all.slice(offset,offset+limit),next=offset+limit<all.length?'o'+(offset+limit):null;
  return [200,{account,items,nextCursor:next}];
 }
 function smartAccount(owner,url){
  const index=Number(url.searchParams.get('index')||0);if(!Number.isInteger(index)||index<0)return [400,{error:'BAD_REQUEST',message:'Invalid request parameters.'}];
  if(overrides.noSmart)return [503,{error:'AA_UNAVAILABLE',message:'Smart accounts are not configured on this server.'}];
  return [200,{owner,accountIndex:index,address:('0x5a'+owner.slice(4)).toLowerCase(),deployed:overrides.smartDeployed?true:null,chainId:cfg.chainId,factory:'0x00000000000000000000000000000000000fac70',validator:'0x00000000000000000000000000000000000ca11d',entryPoint:'0x0000000071727de22e5e9d8baf0d75514f26e4e5'}];
 }
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),p=url.pathname;
  if(req.method==='OPTIONS')return send(res,204,{});
  let m;
  if(req.method==='GET'){
   if(p==='/v1/invites/status'){const a=(url.searchParams.get('address')||'').toLowerCase();return send(res,200,{required:!!overrides.invites,approved:a?approved.has(a):null})}
   if(p==='/v1/config')return send(res,200,cfg);
   if(p==='/v1/chains')return send(res,200,market.chains());
   if((m=p.match(/^\/v1\/chains\/([A-Za-z0-9.]{1,12})$/))){const c=market.chain(m[1].toUpperCase());return c?send(res,200,c):send(res,404,{error:'NOT_FOUND',message:'Unknown name: '+m[1]})}
   if((m=p.match(/^\/v1\/vol\/([A-Za-z0-9.]{1,12})$/))){const n=m[1].toUpperCase();return cfg.names.includes(n)?send(res,200,market.vol(n)):send(res,404,{error:'NOT_FOUND',message:'Unknown name'})}
   if((m=p.match(/^\/v1\/accounts\/(0x[0-9a-fA-F]{40})\/activity$/))){const [st,out]=activityPage(m[1].toLowerCase(),url);return send(res,st,out)}
   if((m=p.match(/^\/v1\/accounts\/(0x[0-9a-fA-F]{40})\/agents$/)))return send(res,200,{account:m[1].toLowerCase(),asOf:new Date().toISOString(),agents:agentBook.get(m[1].toLowerCase())||[]});
   if((m=p.match(/^\/v1\/accounts\/(0x[0-9a-fA-F]{40})\/smart-account$/))){const [st,out]=smartAccount(m[1].toLowerCase(),url);return send(res,st,out)}
   if(p==='/v1/pool')return send(res,200,pool());
   if(p==='/v1/writers/rewards')return send(res,200,writerRewards(url));
   if(p==='/v1/corporate-actions')return send(res,200,market.corporateActions((url.searchParams.get('symbol')||'').toUpperCase()));
   if((m=p.match(/^\/v1\/accounts\/(0x[0-9a-fA-F]{40})\/positions$/)))return send(res,200,positions(m[1].toLowerCase()));
   if((m=p.match(/^\/v1\/series\/(0x[0-9a-f]{64})$/))){const s=market.series.get(m[1]);return s?send(res,200,{...s,strike:String(s.strike)}):send(res,404,{error:'NOT_FOUND',message:'Unknown series.'})}
   if(p==='/v1/userop/config'&&overrides.sponsoring)return send(res,200,{chainId:cfg.chainId,sponsoring:true,...(overrides.sponsorMin?{sponsorMinNotionalUsdg:overrides.sponsorMin}:{}),paymaster:'0x00000000000000000000000000000000000fa7e0'});
   if(p==='/v1/userop/config')return send(res,503,{error:'AA_UNAVAILABLE',message:'One-tap flows are not configured on this server. Use the plain transaction.'});
  }
  if(req.method==='POST'){
   const body=await readBody(req);
   if(p==='/v1/quote'){const q=capacityQuote(body&&market.quote(body.series,Number(body.units),body.side),body?.side);
    // R02: a sell inside the seller's 30-minute hold carries the hold view (overrides.hold), as the API does for an account
    if(q&&body.side==='sell'&&body.account&&overrides.hold)q.hold={...overrides.hold};
    return q?send(res,200,q):send(res,404,{error:'NOT_FOUND',message:'Unknown series.'})}
   if((m=p.match(/^\/v1\/intent\/(buy|sell|shield)$/))){if(m[1]!=='sell'&&overrides.invites&&!approved.has(String(body?.account||'').toLowerCase())&&!approved.has(String(body?.owner||'').toLowerCase()))return send(res,403,{error:'INVITE_REQUIRED',message:'Lemniscate is invite-only for now. Enter your invite code to start buying. Selling is always open.'});if(url.searchParams.get('format')==='userop'&&overrides.userop){
     // R3-06: one-tap builds are recorded (the sell-lane proof is checked by the tests); 'busy' answers like a spent read lane.
     (overrides.useropBodies||=[]).push(body);
     if(overrides.userop==='busy')return send(res,503,{error:'CHAIN_UNAVAILABLE',message:'The chain could not be read right now.'});
    }
    if(url.searchParams.get('format')==='userop')return send(res,503,{error:'AA_UNAVAILABLE',message:'One-tap flows are not configured on this server. Use the plain transaction.'});const [status,out]=intent(m[1],body);return send(res,status,out)}
   if(p==='/v1/invites/redeem'){
    const code=String(body?.code||'').toUpperCase().replace(/[^A-Z0-9]/g,''),a=String(body?.address||'').toLowerCase();
    if(!/^0x[0-9a-f]{40}$/.test(a)||!/^0x[0-9a-fA-F]{130}$/.test(body?.signature||''))return send(res,401,{error:'UNAUTHORIZED',message:'Signature check failed.'});
    if(approved.has(a))return send(res,200,{approved:true,alreadyApproved:true});
    if(code!==VALID_CODE||usedCodes.has(code))return send(res,403,{error:'INVALID_CODE',message:'That code is not valid or has already been used.'});
    usedCodes.add(code);approved.add(a);return send(res,200,{approved:true,alreadyApproved:false});
   }
   if(p==='/__test/settle')return send(res,200,{ok:settle(body?.data,body?.hash)});
  }
  send(res,404,{error:'NOT_FOUND',message:'Route not found.'});
 });
 return new Promise(resolve=>server.listen(port,'127.0.0.1',()=>resolve({server,port,market,settle,approved,close:()=>new Promise(r=>server.close(r))})));
}

if(import.meta.url===`file://${process.argv[1]}`){
 const env=process.env,split=v=>v?v.split(',').map(x=>x.trim().toUpperCase()):[];
 const {port}=await startMockApi({port:Number(process.argv[2]||4190),seed:!!env.MOCK_SEED,overrides:{session:env.MOCK_SESSION,earnings:split(env.MOCK_EARNINGS),splitPause:split(env.MOCK_SPLIT),agentRouter:env.MOCK_NO_ROUTER?false:undefined,invites:!!env.MOCK_INVITES,pool:env.MOCK_POOL||undefined}});
 console.log(`Lemniscate mock API: http://127.0.0.1:${port}`);
}
