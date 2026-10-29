// /roadmap helpers (todo 32): pure functions, shared by the page and its tests.
// LIVE comes only from the public CHANGELOG.md: an update is live when its "## Update N: <title>" entry is there.
// The clock never marks anything live (a held update would otherwise show as live).

const REPO=/^[A-Za-z0-9._-]{1,100}$/;

// Raw URL of the public repo's CHANGELOG.md, or '' when no valid repo name is configured (then nothing is fetched).
export function changelogUrl(publicRepo){
 const repo=String(publicRepo||'').trim();
 return REPO.test(repo)&&!/^\.+$/.test(repo)?`https://raw.githubusercontent.com/lemniscatedev/${repo}/main/CHANGELOG.md`:'';
}

// Parses CHANGELOG.md (docs/tools/sync-public.py format: "## Update 3: Title", next non-empty line "2026-11-02 (UTC) - [commit ...](...)").
// Returns {live: Map<n, date>, extras: [{label, title, date}]} where extras are fixes and bonus updates.
export function parseChangelog(md){
 const live=new Map(),extras=[];
 if(typeof md!=='string')return {live,extras};
 const lines=md.split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  const m=/^## (.+?):\s*(.+?)\s*$/.exec(lines[i]);if(!m)continue;
  let date='';
  for(let j=i+1;j<lines.length&&j<i+4;j++){const d=/^(\d{4}-\d{2}-\d{2})\b/.exec(lines[j].trim());if(d){date=d[1];break}if(lines[j].startsWith('## '))break}
  const u=/^Update (\d{1,3})$/.exec(m[1].trim());
  if(u){const n=Number(u[1]);if(n>0&&!live.has(n))live.set(n,date)}
  else if(/^(Fix|Bonus update \d{1,3})$/.test(m[1].trim()))extras.push({label:m[1].trim(),title:m[2],date});
 }
 return {live,extras};
}

// "Day 2, hour 26 after launch" before a launch time is set; "Scheduled Sat 31 Oct, 14:00 UTC" once it is.
export function slotLabel(update,launchAt){
 const t=Date.parse(launchAt||'');
 if(!Number.isFinite(t))return `Day ${update.day}, hour ${String(update.hour).padStart(2,'0')} after launch`;
 const d=new Date(t+update.hour*3600_000);
 const day=d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
 const time=d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'});
 return `Scheduled ${day}, ${time} UTC`;
}

export function groupByDay(updates){
 const days=new Map();
 for(const u of [...(updates||[])].sort((a,b)=>a.n-b.n)){if(!days.has(u.day))days.set(u.day,[]);days.get(u.day).push(u)}
 return [...days.entries()].sort((a,b)=>a[0]-b[0]);
}
