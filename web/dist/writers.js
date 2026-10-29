// /writers page ("Become a Writer", zero-seed launch). The Writer Pool starts empty and fills from the public.
// Live numbers come from the API (/v1/pool, /v1/writers/rewards); the reward rules also come from /writer-rewards.json,
// which a backend test keeps equal to the API's config, so the page reads correctly without the API too.
const esc=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
const fmt=(n,d=2)=>Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const money=n=>'$'+fmt(n);
const whole=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:0});
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
const get=async(url,ms=8000)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{cache:'no-store',credentials:'omit',signal:c.signal});return r.ok?await r.json():null}catch{return null}finally{clearTimeout(t)}};

function css(){
 if(document.getElementById('lm-writers-css'))return;
 const l=document.createElement('link');l.id='lm-writers-css';l.rel='stylesheet';l.href='/writers.css?v=1';document.head.append(l);
}

/** The page body; `rules` from writer-rewards.json (or the API), `pool` and `rewards` from the API (null without it). */
export function render({rules,pool,rewards,regions}){
 const r=rewards?.program||rules||{};
 const symbol=esc(r.tokenSymbol||'LMNS');
 const weekly=whole(num(r.weeklyPoolTokens||1000000));
 const pct=num(r.weeklyPoolPctOfSupply||0.1);
 const supply=whole(num(r.tokenTotalSupply||1e9));
 const weeks=num(r.weeks||8),cap=num(r.perWalletCapPct||10),min=whole(num(r.minTimeWeightedUsdg||1000));
 const launched=ADDRESS.test(String(r.tokenAddress||''));
 const stage=pool?.capacity?.stage;
 const stats=pool?`<div class="lm-writers-stats" data-writers-stats>
  <div><small>Pool NAV</small><strong>${money(num(pool.nav))}</strong><span>USDG${pool.asOf?' · as of '+esc(new Date(pool.asOf).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})):''}</span></div>
  <div><small>NAV per share</small><strong>$${fmt(num(pool.navPerShare),4)}</strong><span>what one pool share is worth now</span></div>
  <div><small>Total deposited</small><strong>${pool.writers?money(num(pool.writers.depositedUsdg)):'—'}</strong><span>${pool.writers?`by ${whole(pool.writers.wallets)} wallet${pool.writers.wallets===1?'':'s'} since launch`:'from pool deposit events'}</span></div>
  <div><small>Funding received</small><strong>${money(num(pool.fundingReceived?.usdg))}</strong><span>last ${esc(pool.fundingReceived?.windowHours??24)} h, estimate</span></div>
 </div>${stage&&stage!=='open'?`<p class="lm-writers-stage" role="status"><strong>The pool is filling.</strong> ${stage==='empty'?'It started empty: the team does not seed it. Trading opens as writers deposit.':'Small trades are open; the room per buy grows as writers deposit.'}</p>`:''}${pool.capacity?`<ul class="lm-writers-room">${pool.capacity.names.map(x=>`<li><strong>${esc(x.name)}</strong><span>${x.canBuyMinimum?'room for about '+money(num(x.maxBuyUsdg))+' per buy':'no buys yet'}</span></li>`).join('')}</ul>`:''}`
  :`<p class="lm-writers-note" data-writers-stats>Live NAV, NAV per share and total deposits appear here when the site is connected to the Lemniscate service. The pool starts empty: the team does not seed it, so trading opens as writers deposit.</p>`;
 const status=launched
  ?(rewards?.program?.message?esc(rewards.program.message):`Reward week 1 starts ${esc(r.startAt||'when announced')}.`)
  :`Rewards start when $${symbol} launches.`;
 return `<div class="lm-writers">
 <section class="lm-writers-live"><h2>The pool right now</h2>${stats}</section>
 <div class="lm-bento">
  <article class="lm-bento-card wide"><span class="lm-eyebrow">What the pool does</span><h2>It sells the options and receives what buyers pay.</h2><p>Every option on Lemniscate is sold by the Writer Pool. When someone buys, the pool receives the purchase price. While they hold, it receives the daily funding they pay. When they sell, the pool pays them the option’s value at the bid. It also holds Stock Token hedges to limit how much a price move costs it. Your part of all this is your pool shares, measured by NAV per share.</p></article>
  <article class="lm-bento-card"><span class="lm-eyebrow">The risks, plainly</span><h2>NAV can fall.</h2><p>If a stock moves sharply, holders can sell options back for more than the pool received, and NAV per share drops. You can get back less than you deposit.</p><p>Our replay of past market data showed the worst cases. In the hardest runs NAV per share fell to 0.78, a 22% loss. A buyer who knew the next big moves in advance caused a 30-day drop of up to 16.7%, and an injected 15% weekend gap one of 19.2%. In ordinary runs the worst 30-day drop was about 3.5% to 6%. A replay is not a forecast; real losses can be larger.</p></article>
  <article class="lm-bento-card"><span class="lm-eyebrow">Getting out</span><h2>A 3-day withdrawal queue.</h2><p>You ask to withdraw and get a ticket. After 3 days you claim it, and it pays the NAV at the moment you claim, not when you asked. If many writers leave at once, a claim can be paid in part (pro rata) and the rest stays claimable. Claim within 7 days of the ticket maturing, or it goes back into the queue.</p></article>
  <article class="lm-bento-card"><span class="lm-eyebrow">The deposit lock</span><h2>Deposits are locked for 24 hours.</h2><p>Each deposit locks your pool shares for 24 hours before you can ask to withdraw them. Deposits are priced at the upper edge of the pool’s NAV band plus 0.1%.</p></article>
  <article class="lm-bento-card"><span class="lm-eyebrow">How to deposit</span><h2>USDG, from your own wallet.</h2><p>Open the Writer Pool tab in the app, connect your wallet on Robinhood Chain, enter an amount of USDG and confirm two steps in your wallet: approve USDG, then deposit. Keep a little ETH for gas. Your shares appear on the same tab, with their value and your withdrawal tickets.</p><p><a class="lm-button gold small" href="/dashboard?tab=pool">Open the Writer Pool</a></p></article>
  <article class="lm-bento-card"><span class="lm-eyebrow">Who can write</span><h2>Region rules.</h2><p>Lemniscate is not offered to residents of ${esc(regions||'the United Kingdom, Canada or Switzerland')}. The website asks where you live and blocks those regions. The contracts themselves do not check where you are, so the rule is yours to follow.</p></article>
  <article class="lm-bento-card wide" data-writers-rewards><span class="lm-eyebrow">Early-writer $${symbol} rewards</span><h2>${weekly} ${symbol} a week, for ${weeks} weeks.</h2><p class="lm-writers-status" role="status">${status}</p>
   <ul class="lm-writers-rules">
    <li>Each week, ${weekly} ${symbol} (${pct}% of the ${supply} total supply) is shared between qualifying writers, for ${weeks} weeks. Then the program is reviewed.</li>
    <li>Points are the USDG you deposited that is still in the pool, multiplied by the days it stayed there that week. Only on-chain Writer Pool deposits count.</li>
    <li>To qualify, your deposits still in the pool must average at least ${min} USDG over the whole week.</li>
    <li>Your share is your points divided by all qualifying points, and at most ${cap}% of the week’s ${symbol} per wallet. Anything above that cap is ${r.overCapPaidToOthers?'shared among the other qualifying wallets':'not paid out; it stays with the owner'}.</li>
    <li>The cap is per wallet and there is no identity check, so one person can split deposits across several wallets and receive more than the cap in total. This is a known, accepted limit of the program.</li>
    <li>Asking to withdraw stops points for those shares at once. Shares received by transfer do not count.</li>
    <li>Team and operator wallets, Lemniscate contracts, the zero address and contract wallets are excluded.</li>
    <li>The owner pays each week from a list anyone can recompute from the chain. ${symbol} rewards have no cash value and are not a promise of any amount; amounts and dates are announced in the official channels.</li>
   </ul>
   <form class="lm-writers-check" data-writers-check><label for="lm-writers-address">Check a wallet’s points</label><div><input id="lm-writers-address" class="lm-writers-input" inputmode="text" autocomplete="off" spellcheck="false" placeholder="0x… wallet address"><button class="lm-button navy small" type="submit">Check</button></div><p class="lm-writers-you" data-writers-you aria-live="polite"></p></form>
  </article>
 </div>
 <p class="lm-writers-foot">Writing options is risky. Past results and replays are not a forecast and this page is not investment advice.</p>
</div>`;
}

export function youText(body){
 const you=body?.you;if(!you)return 'No reading for that address right now.';
 const basis=body.week?.basis||(body.week?.preview?'illustrative':'projected');
 const preview=basis==='illustrative'?' (illustrative: the last 7 days, before rewards start; nothing is paid for it)':basis==='projected'?' (projected if you stay in until the week ends)':' (final for this week)';
 if(you.excluded)return `This wallet is excluded from rewards: ${you.reason.replace(/^excluded: /,'')}.`;
 const base=`Deposit still in the pool: ${money(num(you.depositHeldUsdg))}. Time-weighted this week: ${money(num(you.timeWeightedUsdg))}. Points: ${fmt(num(you.pointsUsdgDays))} USDG-days${preview}.`;
 if(!you.eligible)return `${base} Not qualifying: ${you.reason}.`;
 return `${base} ${basis==='illustrative'?'Illustrative share':basis==='projected'?'Projected share':'Share'}: ${whole(num(you.tokens))} ${esc(body.program?.tokenSymbol||'LMNS')}${you.capped?' (at the per-wallet cap)':''}.`;
}

export async function mountWriters(root){
 css();
 const CFG=window.LM_CONFIG||{};
 const api=String(CFG.apiBase||'').replace(/\/+$/,'');
 const regionNames={GB:'the United Kingdom',CA:'Canada',CH:'Switzerland'};
 const list=(CFG.blockedRegions||['GB','CA','CH']).map(c=>regionNames[c]||c);
 const regions=list.length>1?list.slice(0,-1).join(', ')+' or '+list.at(-1):list[0];
 const [rules,pool,rewards]=await Promise.all([get('/writer-rewards.json'),api?get(api+'/v1/pool'):null,api?get(api+'/v1/writers/rewards'):null]);
 root.innerHTML=render({rules,pool,rewards,regions});
 const form=root.querySelector('[data-writers-check]'),out=root.querySelector('[data-writers-you]'),input=root.querySelector('#lm-writers-address');
 const check=async address=>{
  if(!ADDRESS.test(address)){out.textContent='Enter a wallet address (0x followed by 40 characters).';return}
  if(!api){out.textContent='Points appear here when the site is connected to the Lemniscate service.';return}
  out.textContent='Reading…';
  const body=await get(api+'/v1/writers/rewards?address='+encodeURIComponent(address));
  out.textContent=body?youText(body):'Points could not be read right now. Try again shortly.';
 };
 form.addEventListener('submit',e=>{e.preventDefault();check(input.value.trim())});
 // A wallet already connected to this site is read without a prompt (eth_accounts never asks).
 try{const accounts=await window.ethereum?.request?.({method:'eth_accounts'});if(accounts?.[0]&&ADDRESS.test(accounts[0])&&!input.value){input.value=accounts[0];if(api)check(accounts[0])}}catch{}
}
