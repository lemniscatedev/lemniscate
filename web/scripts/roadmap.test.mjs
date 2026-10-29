import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {changelogUrl,parseChangelog,slotLabel,groupByDay} from '../dist/roadmap-lib.js';

const read=f=>readFile(new URL(f,import.meta.url),'utf8');

// A CHANGELOG.md exactly as docs/tools/sync-public.py render_entry/add_entry writes it (newest first).
const SAMPLE=`# Changelog

Plain-English notes for every Lemniscate update, newest first. Each entry links to the commit that shipped it.

## Fix: keep the footer link colour readable

2026-11-01 (UTC) - [commit 0123456789](https://github.com/lemniscatedev/example/commit/0123456789abcdef)

The footer links were too light on cream.

## Bonus update 1: Holder stats

2026-11-01 (UTC) - [commit 1111111111](https://github.com/lemniscatedev/example/commit/1111111111abcdef)

A bonus page.

## Update 2: Holding-cost calculator on every option

2026-11-01 (UTC) - [commit abcdef0123](https://github.com/lemniscatedev/example/commit/abcdef0123456789)

Every option on the dashboard now shows what holding it costs over 7 days and over 30 days.

## Update 1: Status page

2026-10-31 (UTC) - [commit fedcba9876](https://github.com/lemniscatedev/example/commit/fedcba9876543210)

There is now a status page at /status.
`;

test('live only from changelog entries, with their dates; fixes and bonus updates listed apart',()=>{
 const {live,extras}=parseChangelog(SAMPLE);
 assert.deepEqual([...live.entries()].sort(),[[1,'2026-10-31'],[2,'2026-11-01']]);
 assert.deepEqual(extras,[{label:'Fix',title:'keep the footer link colour readable',date:'2026-11-01'},{label:'Bonus update 1',title:'Holder stats',date:'2026-11-01'}]);
});
test('a failed fetch or junk marks nothing live',()=>{
 for(const x of [null,undefined,'','<html>404</html>','## Update x: nope\n## Updates 3: no']){
  const {live,extras}=parseChangelog(x);assert.equal(live.size,0);assert.equal(extras.length,0);
 }
});
test('changelog URL only for a plain repo name',()=>{
 assert.equal(changelogUrl('lemniscate'),'https://raw.githubusercontent.com/lemniscatedev/lemniscate/main/CHANGELOG.md');
 for(const bad of ['','  ','<PUBLIC_REPO>','a/b','..','x?y',null,undefined])assert.equal(changelogUrl(bad),'');
});
test('slots: hours after launch before a launch time, UTC dates after',()=>{
 assert.equal(slotLabel({day:2,hour:26},null),'Day 2, hour 26 after launch');
 assert.equal(slotLabel({day:1,hour:0},''),'Day 1, hour 00 after launch');
 assert.equal(slotLabel({day:1,hour:2},'2026-10-31T12:00:00Z'),'Scheduled Sat 31 Oct, 14:00 UTC');
 assert.equal(slotLabel({day:1,hour:22},'2026-10-31T12:00:00Z'),'Scheduled Sun 1 Nov, 10:00 UTC');
});
test('roadmap.json: all 36 updates in queue order, 12 a day, every 2 hours, nothing live before launch',async()=>{
 const d=JSON.parse(await read('../dist/roadmap.json'));
 assert.deepEqual(d.updates.map(u=>u.n),Array.from({length:36},(_,i)=>i+1));
 assert.deepEqual(d.updates.map(u=>u.hour),Array.from({length:36},(_,i)=>i*2));
 assert.deepEqual(groupByDay(d.updates).map(([day,us])=>[day,us.length]),[[1,12],[2,12],[3,12]]);
 for(const u of d.updates){assert.ok(u.title&&u.line,'title and line for '+u.n);assert.doesNotMatch(u.title+u.line,/—|\bAPY\b|\byield\b|\bincome\b/i)}
 assert.equal(changelogUrl(d.publicRepo),'https://raw.githubusercontent.com/lemniscatedev/lemniscate/main/CHANGELOG.md');assert.equal(d.launchAt,null);
});
test('the page is registered in the shipped site: route, explicit mount call, footer link, route list, title',async()=>{
 const js=await read('../dist/lemniscate.js');
 assert.match(js,/if\(path==='\/roadmap'\)\{shellPage\(/);
 assert.match(js,/import\('\/roadmap\.js\?v=1'\)\.then\(m=>m\.mountRoadmap\(document\.getElementById\('lm-roadmap'\)\)\)/);
 assert.match(js,/<a href="\/roadmap">Roadmap<\/a>/);
 const page=await read('../dist/roadmap.js');assert.match(page,/export async function mountRoadmap\(/);
 assert.ok(JSON.parse(await read('./routes.json')).includes('/roadmap'));
 assert.match(await read('../dist/roadmap/index.html'),/<title>Roadmap \| Lemniscate<\/title>/);
});
