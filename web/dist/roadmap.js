// /roadmap page (todo 32): every launch update on a timeline by day, fixes and bonus updates, then "Coming soon".
// Data: /roadmap.json (same origin). LIVE badges: only from the public CHANGELOG.md (see roadmap-lib.js); a failed or
// skipped fetch shows the full timeline with its slots and no LIVE badge at all.
import {changelogUrl,parseChangelog,slotLabel,groupByDay} from '/roadmap-lib.js?v=1';

const esc=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const get=async(url,type,ms=8000)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{cache:'no-store',credentials:'omit',signal:c.signal});return r.ok?await r[type]():null}catch{return null}finally{clearTimeout(t)}};
const DAY=['','Day one','Day two','Day three','Day four','Day five'];

export async function mountRoadmap(root){
 const data=await get('/roadmap.json','json');
 if(!data||!Array.isArray(data.updates)||!data.updates.length){
  root.innerHTML='<p class="lm-roadmap-note">The roadmap could not be loaded. Reload the page to try again.</p>';
  return;
 }
 const url=changelogUrl(data.publicRepo);
 const parsed=url?parseChangelog(await get(url,'text')):parseChangelog(null);
 const live=parsed.live;
 const item=u=>{
  const on=live.has(u.n);
  const when=on?(live.get(u.n)?`Live since ${esc(live.get(u.n))}`:'Live'):esc(slotLabel(u,data.launchAt));
  return `<li class="lm-roadmap-item${on?' is-live':''}" data-update="${u.n}"><div class="lm-roadmap-num">${String(u.n).padStart(2,'0')}</div><div class="lm-roadmap-body"><div class="lm-roadmap-head"><h3>${esc(u.title)}</h3>${on?'<span class="lm-roadmap-live">LIVE</span>':''}</div><p>${esc(u.line)}</p><span class="lm-roadmap-when">${when}</span></div></li>`;
 };
 const days=groupByDay(data.updates).map(([d,us])=>`<section class="lm-roadmap-day" aria-labelledby="lm-roadmap-dayname-${d} lm-roadmap-day-${d}"><div class="lm-roadmap-dayhead"><span class="lm-eyebrow" id="lm-roadmap-dayname-${d}">${esc(DAY[d]||'Day '+d)}</span><h2 id="lm-roadmap-day-${d}">${us.length} updates, one every two hours</h2></div><ol class="lm-roadmap-list">${us.map(item).join('')}</ol></section>`).join('');
 const extras=parsed.extras.length?`<section class="lm-roadmap-day lm-roadmap-extras"><div class="lm-roadmap-dayhead"><span class="lm-eyebrow">Also shipped</span><h2>Fixes and bonus updates</h2></div><ul class="lm-roadmap-list">${parsed.extras.map(e=>`<li class="lm-roadmap-item is-live"><div class="lm-roadmap-num">${e.label==='Fix'?'FIX':'+'}</div><div class="lm-roadmap-body"><div class="lm-roadmap-head"><h3>${esc(e.label==='Fix'?e.title:e.label+': '+e.title)}</h3><span class="lm-roadmap-live">LIVE</span></div>${e.date?`<span class="lm-roadmap-when">${esc(e.date)}</span>`:''}</div></li>`).join('')}</ul></section>`:'';
 root.innerHTML=`<p class="lm-roadmap-note">${live.size?`${live.size} of ${data.updates.length} updates are live. `:''}Each update goes live only after its tests and checks pass. One that fails is held and fixed, never released broken, so a slot can move.</p>${days}${extras}<section class="lm-roadmap-day lm-roadmap-soon"><div class="lm-roadmap-dayhead"><span class="lm-eyebrow">After the launch updates</span><h2>Coming soon</h2></div><div class="lm-roadmap-soon-card"><p>More is being built. Nothing here is promised until it is on this page with a slot, and it is live only when its entry is in the public changelog.</p></div></section>`;
}
