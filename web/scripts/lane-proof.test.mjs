// Unit tests for the one-tap sell-lane proof (backend R3-06): `npm test` (node:test, no dependencies).
// The message must match the backend byte for byte; a golden vector pins it, and when the backend checkout sits next to this
// repo (../backend, or LM_BACKEND_DIR) and bun is installed, the backend's own sellLaneProofMessage is compared too.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sellLaneProofMessage,createLaneProofCache,SELL_LANE_PROOF_MAX_SECONDS,CLOCK_SKEW_SECONDS,REFRESH_MARGIN_SECONDS} from '../dist/chain/lane-proof.js';

const ACCOUNT='0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const SIG='0x'+'11'.repeat(65);
const T0=1_800_000_000_000;// ms

test('message matches the backend format exactly (golden vector)',()=>{
 assert.equal(sellLaneProofMessage(ACCOUNT,4663,1800000840),
  'Lemniscate wants you to sign this message.\n\nAction: sell-lane\nAccount: 0xabcdef0123456789abcdef0123456789abcdef01\nExpires: 1800000840\nChain: 4663');
});

test('message matches the backend source when the backend checkout is present',t=>{
 const here=path.dirname(fileURLToPath(import.meta.url));
 const dir=process.env.LM_BACKEND_DIR||path.resolve(here,'../../backend');
 const src=path.join(dir,'app/src/api/sell-lane-proof.ts');
 if(!existsSync(src))return t.skip('backend checkout not found');
 const bun=['bun',path.join(process.env.HOME||'','.bun/bin/bun')].find(b=>spawnSync(b,['--version']).status===0);
 if(!bun)return t.skip('bun not installed');
 const cases=[[ACCOUNT,4663,1800000840],['0x0000000000000000000000000000000000000001',46630,1]];
 const code=`import {sellLaneProofMessage as m} from ${JSON.stringify(src)};console.log(JSON.stringify(${JSON.stringify(cases)}.map(c=>m(...c))))`;
 const out=spawnSync(bun,['-e',code],{cwd:path.join(dir,'app'),encoding:'utf8'});
 assert.equal(out.status,0,out.stderr);
 assert.deepEqual(JSON.parse(out.stdout.trim()),cases.map(c=>sellLaneProofMessage(...c)));
});

function harness({reject=false}={}){
 let now=T0;const signed=[];
 const cache=createLaneProofCache({now:()=>now,sign:async message=>{signed.push(message);if(reject)throw Object.assign(new Error('User rejected the request.'),{code:4001});return SIG}});
 return {cache,signed,advance:s=>{now+=s*1000},nowS:()=>Math.floor(now/1000)};
}

test('expiry is within the 15-minute limit, with room for clock skew',async()=>{
 const h=harness();
 const proof=await h.cache.get(ACCOUNT,4663);
 assert.equal(proof.signature,SIG);
 assert.ok(proof.expires>h.nowS());
 assert.ok(proof.expires<=h.nowS()+SELL_LANE_PROOF_MAX_SECONDS-CLOCK_SKEW_SECONDS);
 assert.equal(h.signed[0],sellLaneProofMessage(ACCOUNT,4663,proof.expires));
});

test('cache reuses the proof per (account, chain) and asks the wallet once',async()=>{
 const h=harness();
 const a=await h.cache.get(ACCOUNT,4663);
 h.advance(300);
 const b=await h.cache.get(ACCOUNT.toLowerCase(),4663);
 assert.equal(b,a);
 assert.equal(h.signed.length,1);
 // A different chain or account is a different proof.
 await h.cache.get(ACCOUNT,46630);
 await h.cache.get('0x0000000000000000000000000000000000000002',4663);
 assert.equal(h.signed.length,3);
});

test('concurrent requests share one wallet prompt',async()=>{
 const h=harness();
 const [a,b]=await Promise.all([h.cache.get(ACCOUNT,4663),h.cache.get(ACCOUNT,4663)]);
 assert.equal(a,b);assert.equal(h.signed.length,1);
});

test('a proof is refreshed about a minute before it expires',async()=>{
 const h=harness();
 const first=await h.cache.get(ACCOUNT,4663);
 const keep=first.expires-REFRESH_MARGIN_SECONDS-h.nowS()-1;
 h.advance(keep);
 assert.equal(await h.cache.get(ACCOUNT,4663),first);
 h.advance(1);
 const second=await h.cache.get(ACCOUNT,4663);
 assert.notEqual(second,first);
 assert.ok(second.expires>first.expires);
 assert.equal(h.signed.length,2);
 assert.ok(second.expires<=h.nowS()+SELL_LANE_PROOF_MAX_SECONDS);
});

test('a declined signature resolves to null (the sell goes on without a proof) and is not cached',async()=>{
 const h=harness({reject:true});
 assert.equal(await h.cache.get(ACCOUNT,4663),null);
 assert.equal(await h.cache.get(ACCOUNT,4663),null);
 assert.equal(h.signed.length,2);
 assert.equal(h.cache.peek(ACCOUNT,4663),null);
});

test('a malformed signature from the wallet is not sent',async()=>{
 const cache=createLaneProofCache({now:()=>T0,sign:async()=>'0x1234'});
 assert.equal(await cache.get(ACCOUNT,4663),null);
});
