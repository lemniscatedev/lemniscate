// Offline demo data in the exact shape of the Lemniscate API (used by `?demo=1` and by scripts/mock-api.mjs).
// Prices here are illustrative constants, never live data; the dashboard labels demo mode "Demo, not real funds".
// The quote rules follow the canonical parameters (docs: design decisions, "Canonical quote parameters").
export const DEMO_NAMES=[
 {name:'NVDA',label:'NVIDIA',spot:180,sigmaBps:5000},
 {name:'TSLA',label:'Tesla',spot:430,sigmaBps:6000},
 {name:'SPY',label:'S&P 500 ETF',spot:660,sigmaBps:3000},
 {name:'QQQ',label:'Nasdaq 100 ETF',spot:600,sigmaBps:3500},
 {name:'AAPL',label:'Apple',spot:250,sigmaBps:3000},
];
export const QUOTE_PARAMS={feeBps:3,minSpreadUsd:0.01,spreadBpsAtm:150,spreadBpsFar:400,farMoneyness:0.3,
 sessionMultiplier:{REGULAR:1,EXTENDED:1.5,CLOSED:3,UNKNOWN:3,HALTED:3},staleVolSellBumpBps:2000};
export const TAU={DAILY:86400,WEEKLY:604800};
const YEAR=31_536_000;
const MONEYNESS=[-10,-5,0,5,10];

export function callValue(S,K,sigma,tauYears){
 const u=Math.sqrt(.25+2/(sigma*sigma*tauYears)),x=S/K;
 return S<=K?K/(2*u)*Math.pow(x,.5+u):(S-K)+K/(2*u)*Math.pow(x,.5-u);
}
export function optionValue(S,K,sigma,tauYears,isCall){const c=callValue(S,K,sigma,tauYears);return Math.max(0,isCall?c:c-(S-K))}

/** New York session: REGULAR 09:30-16:00, EXTENDED 04:00-09:30 and 16:00-04:00 on weekdays (overnight), else CLOSED. */
export function demoSession(now=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
 const m=Number(p.hour)*60+Number(p.minute),day=p.weekday;
 if(day==='Sat'||(day==='Sun'&&m<20*60)||(day==='Fri'&&m>=20*60))return 'CLOSED';
 return m>=570&&m<960?'REGULAR':'EXTENDED';
}

function hashHex(text){let out='';let h=2166136261;for(let round=0;round<8;round++){for(const ch of text+round){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)>>>0}out+=h.toString(16).padStart(8,'0')}return '0x'+out}
export function seriesId(name,isCall,strike,speed){return hashHex(`${name}|${isCall}|${strike}|${speed}`)}
const fixed=(n,d=6)=>(Math.max(0,n)).toFixed(d);
const addr=n=>'0x'+n.toString(16).padStart(40,'0');

export function unitQuote({spot,strike,sigmaBps,speed,isCall,session,forSell=false,volStale=false}){
 const sb=sigmaBps+(forSell&&volStale?QUOTE_PARAMS.staleVolSellBumpBps:0),sigma=sb/10_000,tau=TAU[speed]/YEAR;
 const v=optionValue(spot,strike,sigma,tau,isCall),payoff=Math.max(0,isCall?spot-strike:strike-spot);
 const away=Math.min(Math.abs(strike/spot-1)/QUOTE_PARAMS.farMoneyness,1);
 const spreadBps=(QUOTE_PARAMS.spreadBpsAtm+(QUOTE_PARAMS.spreadBpsFar-QUOTE_PARAMS.spreadBpsAtm)*away)*QUOTE_PARAMS.sessionMultiplier[session];
 const spread=Math.max(QUOTE_PARAMS.minSpreadUsd,v*spreadBps/10_000);
 const h=spot*1e-4,delta=(optionValue(spot+h,strike,sigma,tau,isCall)-optionValue(spot-h,strike,sigma,tau,isCall))/(2*h);
 const gamma=(optionValue(spot+h,strike,sigma,tau,isCall)-2*v+optionValue(spot-h,strike,sigma,tau,isCall))/(h*h);
 const vega=(optionValue(spot,strike,sigma+.01,tau,isCall)-v);
 const daily=(v-payoff)*86400/TAU[speed];
 return {v,payoff,spreadBps,spread,ask:v+spread,bid:Math.max(0,v-spread),delta,gamma,vega,daily,sigmaBps:sb};
}

export function displayCost(daily){if(daily<0.005)return 'costs less than $0.01/day';return `costs about $${daily.toFixed(2)}/day`}

function blockFor(session,market){
 if(market.buysPaused)return 'BUYS_PAUSED';
 if(session==='HALTED')return 'SESSION_HALTED';if(session==='CLOSED')return 'SESSION_CLOSED';if(session==='UNKNOWN')return 'SESSION_UNKNOWN';
 if(market.splitPause)return 'PRICE_PAUSED';if(market.earnings)return 'EARNINGS_BLOCK';return null;
}

/** Overrides let tests force a session or a block: {session, earnings:['TSLA'], splitPause:['AAPL'], buysPaused}. */
export function createDemoMarket(overrides={}){
 const names=DEMO_NAMES.map(x=>({...x}));
 const sessionOf=()=>overrides.session||demoSession();
 const marketOf=name=>({buysPaused:!!overrides.buysPaused,earnings:(overrides.earnings||[]).includes(name),splitPause:(overrides.splitPause||[]).includes(name)});
 const series=new Map();
 for(const n of names)for(const speed of ['DAILY','WEEKLY'])for(const pct of MONEYNESS){
  const strike=Math.round(n.spot*(1+pct/100)*100)/100;
  for(const isCall of [true,false]){const id=seriesId(n.name,isCall,strike,speed);series.set(id,{id,name:n.name,isCall,speed,strike,token:addr(series.size+0x1000),norm:1})}
 }
 const nameOf=name=>names.find(x=>x.name===name);
 function option(s,session){
  const n=nameOf(s.name),block=blockFor(session,marketOf(s.name));
  const u=unitQuote({spot:n.spot,strike:s.strike,sigmaBps:n.sigmaBps,speed:s.speed,isCall:s.isCall,session});
  const fee=QUOTE_PARAMS.feeBps/10_000*n.spot;
  return {id:s.id,isCall:s.isCall,token:s.token,ask:fixed(u.ask+fee),bid:fixed(u.bid-fee),mark:fixed(u.v),spreadBps:Math.round(u.spreadBps),
   dailyCostUsdg:fixed(u.daily),displayCost:displayCost(u.daily),breakeven:fixed(s.isCall?s.strike+u.ask+fee:Math.max(0,s.strike-u.ask-fee)),
   delta:Number(u.delta.toPrecision(6)),gamma:Number(u.gamma.toPrecision(6)),vega:Number(u.vega.toPrecision(6)),sigmaBps:n.sigmaBps,buyable:!block,blockReason:block};
 }
 function quote(id,units,side){
  const s=series.get(id);if(!s)return null;const n=nameOf(s.name),session=sessionOf();
  const u=unitQuote({spot:n.spot,strike:s.strike,sigmaBps:n.sigmaBps,speed:s.speed,isCall:s.isCall,session,forSell:side==='sell'});
  const fee=QUOTE_PARAMS.feeBps/10_000*n.spot*units;const usdg=side==='buy'?u.ask*units+fee:Math.max(0,u.bid*units-fee);
  const block=side==='buy'?blockFor(session,marketOf(s.name)):null;
  const allIn=u.ask+fee/(units||1);
  return {series:id,side,unitsWad:String(BigInt(Math.round(units*1e6))*10n**12n),
   quote:{usdg:String(Math.round(usdg*1e6)),vMarkWad:'0',spreadBps:String(Math.round(u.spreadBps)),feeUsdg:String(Math.round(fee*1e6)),dailyCostUsdg:String(Math.round(u.daily*units*1e6)),breakevenWad:'0',sigmaBps:String(n.sigmaBps),session:['REGULAR','EXTENDED','CLOSED','UNKNOWN','HALTED'].indexOf(session),buyable:!block},
   display:{session,usdg:fixed(usdg),feeUsdg:fixed(fee),dailyCostUsdg:fixed(u.daily*units),displayCost:displayCost(u.daily*units),breakeven:fixed(s.isCall?s.strike+allIn:Math.max(0,s.strike-allIn)),vMark:fixed(u.v)},
   blockReason:block,sellQueued:side==='sell'&&session==='HALTED',asOf:new Date().toISOString()};
 }
 return {
  names,series,sessionOf,quote,
  config:()=>({chainId:4663,network:'fork',contracts:{engine:addr(0xe1),pool:addr(0xb1),usdg:addr(0xd1),...(overrides.agentRouter===false?{}:{agentRouter:addr(0xa1)})},
   stocks:names.map((n,i)=>({name:n.name,stock:addr(0x5000+i),feed:null})),names:names.map(n=>n.name),usdgDecimals:6,optionDecimals:18,poolShareDecimals:12,
   speeds:[{speed:'DAILY',tauSeconds:TAU.DAILY},{speed:'WEEKLY',tauSeconds:TAU.WEEKLY}],
   caps:{poolNavUsdg:null,perSeriesOutstandingUsdg:'40000',perAccountSeriesUsdg:'25000',totalOptionValuePctOfNav:35,perNamePctOfNav:8,stressBudgetPctOfNav:20,drawdownPausePct:15,writerVaultsOpen:false},
   pricing:{feeBps:3,minSpreadUsd:0.01,spreadBpsAtm:150,spreadBpsFar:400,sessionMultipliers:{...QUOTE_PARAMS.sessionMultiplier}}}),
  chains:()=>({names:names.map(n=>({name:n.name,buyable:!blockFor(sessionOf(),marketOf(n.name))}))}),
  chain:name=>{const n=nameOf(name);if(!n)return null;const session=sessionOf();
   const speeds=['DAILY','WEEKLY'].map(speed=>{const rows=new Map();for(const s of series.values()){if(s.name!==name||s.speed!==speed)continue;const r=rows.get(s.strike)||{strike:String(s.strike),moneynessPct:Number(((s.strike/n.spot-1)*100).toFixed(4)),call:null,put:null};r[s.isCall?'call':'put']=option(s,session);rows.set(s.strike,r)}
    return {speed,tauSeconds:TAU[speed],sigmaBps:n.sigmaBps,volAgeSeconds:600,volStale:false,strikes:[...rows.values()].sort((a,b)=>a.strike-b.strike)}});
   return {name,spot:String(n.spot),session,asOf:new Date().toISOString(),priceUpdatedAt:new Date().toISOString(),buyable:speeds.some(s=>s.strikes.some(r=>r.call?.buyable||r.put?.buyable)),units:'1',speeds}},
  vol:name=>{const n=nameOf(name);const now=Date.now();const e=marketOf(name).earnings;
   return {name,asOf:new Date(now).toISOString(),spot:String(n.spot),session:sessionOf(),speeds:['DAILY','WEEKLY'].map(speed=>({speed,latest:{speed,sigmaBps:n.sigmaBps,skewK:'0',eventBumpBps:0,buyBlockFrom:e?new Date(now-3600e3).toISOString():null,buyBlockTo:e?new Date(now+20*3600e3).toISOString():null,validUntil:new Date(now+3600e3).toISOString(),ts:new Date(now-600e3).toISOString(),stale:false,ageSeconds:600,secondsToExpiry:3600}})),history:[]}},
  corporateActions:name=>(overrides.splitPause||[]).includes(name)?[{id:'demo-split',symbol:name,kind:'split',status:'pending',processDate:null,effectiveAt:new Date(Date.now()+86400e3).toISOString(),oldMultiplier:'1',newMultiplier:'4',verifiedContinuity:null,details:{}}]:[],
  pool:()=>({asOf:new Date().toISOString(),nav:'1250000.000000',navPerShare:'1.018400',usdg:'1180000.000000',hedgeEquity:'0',optionLiability:'186000.000000',reserve:'12500.000000',
   fundingReceived:{windowHours:24,usdg:'1840.000000',estimate:true},
   exposures:names.map((n,i)=>({name:n.name,netDelta:'0',netGamma:'0',netVega:'0',deltaNotionalUsdg:'0',stressLossBps:String(120+i*40),outstandingValueUsdg:String(20000+i*9000),outstandingPctOfNav:Number(((20000+i*9000)/1250000*100).toFixed(4))})),
   stressLossBps:'280',caps:{navCapUsdg:null,navPctOfCap:null,totalOptionValuePct:14.88,totalOptionValueCapPct:35,perNameCapPct:8,perSeriesCapUsdg:'40000',largestSeriesValueUsdg:'11000',stressBudgetPct:20,perAccountSeriesCapUsdg:'25000'},
   hedgeEquityAgeSeconds:null,drawdown30dPct:1.2,drawdownPausePct:15,queue:{withdrawals:3,withdrawalShares:'42000',sells:overrides.session==='HALTED'?2:0},buysPaused:!!overrides.buysPaused}),
 };
}

/** In-browser demo API: same methods as createApi(), positions kept in memory for this tab only. */
export function createDemoApi(overrides={}){
 const market=createDemoMarket(overrides);const held=new Map();
 const ok=v=>Promise.resolve(JSON.parse(JSON.stringify(v)));
 const fail=(message,code)=>Promise.reject(Object.assign(new Error(message),{status:409,code}));
 function positions(account){
  const list=[...held.values()].filter(p=>p.units>1e-9||p.cost>0);let value=0,daily=0,cost=0,pnl=0;
  const rows=list.filter(p=>p.units>1e-9).map(p=>{const s=market.series.get(p.seriesId),q=market.quote(p.seriesId,p.units,'sell');const v=Number(q.display.usdg),d=Number(q.display.dailyCostUsdg);
   value+=v;daily+=d;cost+=p.cost;pnl+=v+p.proceeds-p.cost;
   return {seriesId:p.seriesId,name:s.name,isCall:s.isCall,speed:s.speed,strike:String(s.strike),token:s.token,balance:p.units.toFixed(6),norm:'1',units:p.units.toFixed(6),valueAtBidUsdg:v.toFixed(6),dailyCostUsdg:d.toFixed(6),displayCost:q.display.displayCost,costBasisUsdg:p.cost.toFixed(6),proceedsUsdg:p.proceeds.toFixed(6),pnlUsdg:(v+p.proceeds-p.cost).toFixed(6),session:q.display.session,sellQueued:q.sellQueued}});
  return {account,asOf:new Date().toISOString(),positions:rows,totals:{valueAtBidUsdg:value.toFixed(6),dailyCostUsdg:daily.toFixed(6),costBasisUsdg:cost.toFixed(6),pnlUsdg:pnl.toFixed(6)},queuedSells:[]};
 }
 function intent(kind,body){
  if(kind==='shield'){const chain=market.chain(body.name);const spot=Number(chain.spot),target=spot*(1-body.strikePctBelowBps/10_000);
   const row=chain.speeds.find(s=>s.speed==='WEEKLY').strikes.filter(r=>r.put).sort((a,b)=>Math.abs(a.strike-target)-Math.abs(b.strike-target))[0];
   if(!row)return fail('No Weekly Down option is open for purchase on this name right now.','NO_SHIELD_SERIES');
   body={series:row.put.id,units:body.tokenUnits,account:body.account};kind='buyShield'}
  const side=kind==='sell'?'sell':'buy',q=market.quote(body.series,Number(body.units),side);
  if(!q)return fail('That option is not listed.','NOT_FOUND');
  if(side==='buy'&&q.blockReason)return Promise.reject(Object.assign(new Error('Buys are blocked right now.'),{status:409,code:'BUY_BLOCKED',reason:q.blockReason}));
  return ok({kind:kind==='buyShield'?'shield':kind,to:'0x'+'0'.repeat(40),data:'0x',value:'0',approvals:[],series:body.series,deadline:Math.floor(Date.now()/1000)+300,quote:q.quote,
   display:{usdg:q.display.usdg,displayCost:q.display.displayCost,breakeven:q.display.breakeven},queued:q.sellQueued,
   note:side==='sell'&&q.sellQueued?'The price feed is halted. This sell joins a queue and fills at the first fresh price.':null,demo:{units:Number(body.units),usdg:Number(q.display.usdg)}});
 }
 return {
  configured:true,demo:true,
  config:()=>ok(market.config()),chains:()=>ok(market.chains()),chain:n=>ok(market.chain(n)),vol:n=>ok(market.vol(n)),pool:()=>ok(market.pool()),
  corporateActions:n=>ok(market.corporateActions(n)),
  series:id=>{const s=market.series.get(id);return s?ok({...s,strike:String(s.strike)}):fail('That option is not listed.','NOT_FOUND')},
  positions:a=>ok(positions(a)),
  activity:a=>ok({account:a,items:[],nextCursor:null}),
  agents:a=>ok({account:a,asOf:new Date().toISOString(),agents:[]}),
  smartAccount:a=>ok({owner:a,accountIndex:0,address:addr(0x5a),deployed:null,chainId:4663}),
  quote:b=>ok(market.quote(b.series,Number(b.units),b.side)),
  intent:(kind,body)=>intent(kind,body),
  /** Demo settlement of an intent returned above. */
  settle(intentResult){const p=held.get(intentResult.series)||{seriesId:intentResult.series,units:0,cost:0,proceeds:0};
   if(intentResult.kind==='sell'){p.units=Math.max(0,p.units-intentResult.demo.units);p.proceeds+=intentResult.demo.usdg}else{p.units+=intentResult.demo.units;p.cost+=intentResult.demo.usdg}
   held.set(p.seriesId,p);return '0xdemo'+Math.random().toString(16).slice(2).padEnd(58,'0').slice(0,58)},
 };
}
