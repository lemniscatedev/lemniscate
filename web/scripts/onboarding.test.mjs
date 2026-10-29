import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSteps,accessLine,fundCopy,sponsorMin,suggestedTrade,readWallet,writeWallet,dismiss,isDismissed,STORE_KEY} from '../dist/chain/onboarding.js';

const memory=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),m}};
const base={address:'0xabc',chainOk:true,chainName:'Robinhood Chain',usdgRaw:null,ethWei:null,sponsoring:false,positions:0,seenPositions:false};

test('a wallet that is not connected starts at step 1',()=>{
 const {current,steps}=buildSteps({...base,address:''});
 assert.equal(current,0);assert.equal(steps.length,5);
});
test('wrong network stops at step 2',()=>assert.equal(buildSteps({...base,chainOk:false}).current,1));
test('funding needs 1 USDG and ETH unless gas is sponsored',()=>{
 assert.equal(buildSteps({...base,usdgRaw:5_000_000n,ethWei:0n}).current,2);
 assert.equal(buildSteps({...base,usdgRaw:5_000_000n,ethWei:1n}).current,3);
 assert.equal(buildSteps({...base,usdgRaw:5_000_000n,ethWei:0n,sponsoring:true}).current,3);
 assert.equal(buildSteps({...base,usdgRaw:1_000_000n,ethWei:0n,sponsoring:true}).current,2,'sponsored: $1 is below the suggested $5');
 assert.equal(buildSteps({...base,usdgRaw:999_999n,ethWei:1n}).current,2);
 assert.equal(buildSteps({...base,usdgRaw:null,ethWei:null}).current,2);
});
test('a position completes the trade step and viewing it finishes the tour',()=>{
 const funded={...base,usdgRaw:5_000_000n,ethWei:1n,positions:1};
 assert.equal(buildSteps(funded).current,4);
 assert.equal(buildSteps({...funded,seenPositions:true}).current,-1);
});
test('the fund step title follows sponsorship',()=>{
 assert.match(buildSteps(base).steps[2].title,/ETH for gas/);
 assert.doesNotMatch(buildSteps({...base,sponsoring:true}).steps[2].title,/ETH/);
});
test('access wording matches the invite gate',()=>{
 const r='the United Kingdom, Canada or Switzerland';
 assert.match(accessLine({required:true,approved:false,regions:r}),/invite-only for the first 8 hours/);
 assert.match(accessLine({required:true,approved:false,regions:r}),/everyone except residents of the United Kingdom/);
 assert.match(accessLine({required:true,approved:true,regions:r}),/approved/);
 const open=accessLine({required:false,approved:null,regions:r});
 assert.doesNotMatch(open,/invite/i);assert.match(open,/not offered to residents of the United Kingdom/);
});
test('fund copy names the address, the $1 minimum and the sponsorship rule',()=>{
 const a=fundCopy({sponsoring:false,fundAddress:'0xabc',chainName:'Robinhood Chain'});
 assert.match(a.usdg,/\$1 /);assert.doesNotMatch(a.usdg,/\$5/);assert.match(a.usdg,/0xabc/);assert.match(a.gas,/ETH pays the network gas/);
 assert.match(fundCopy({sponsoring:true}).gas,/sponsored/);
});
test('dismissal is remembered per wallet and survives bad storage',()=>{
 const s=memory();
 assert.equal(isDismissed('0xAbC',s),false);
 dismiss('0xAbC',s);
 assert.equal(isDismissed('0xabc',s),true);
 assert.equal(isDismissed('0xdef',s),false);
 writeWallet('0xabc',{seenPositions:true},s);
 assert.deepEqual(readWallet('0xabc',s),{dismissed:true,seenPositions:true});
 const broken={getItem:()=>{throw new Error('blocked')},setItem:()=>{throw new Error('blocked')}};
 assert.equal(isDismissed('0xabc',broken),false);
 assert.equal(dismiss('0xabc',broken),false);
 s.setItem(STORE_KEY,'not json');assert.equal(isDismissed('0xabc',s),false);
});

test('sponsorship minimum: from /v1/userop/config when present, else 5',()=>{
 assert.equal(sponsorMin({sponsorMinNotionalUsdg:7}),7);assert.equal(sponsorMin({sponsorMinNotionalUsdg:'10'}),10);
 assert.equal(sponsorMin({}),5);assert.equal(sponsorMin(null),5);assert.equal(sponsorMin({sponsorMinNotionalUsdg:0}),5);assert.equal(sponsorMin({sponsorMinNotionalUsdg:'x'}),5);
});
test('a sponsored first trade is suggested at the minimum; otherwise $1',()=>{
 assert.equal(suggestedTrade({sponsoring:true,sponsorMin:5}),5);assert.equal(suggestedTrade({sponsoring:true,sponsorMin:12}),12);
 assert.equal(suggestedTrade({sponsoring:false,sponsorMin:5}),1);
 const sp=buildSteps({...base,sponsoring:true,sponsorMin:5});
 assert.match(sp.steps[3].title,/first trade of \$5/);assert.match(sp.steps[3].title,/\$1 minimum also works/);
 assert.match(buildSteps(base).steps[3].title,/minimum \$1/);
 const c=fundCopy({sponsoring:true,sponsorMin:5,fundAddress:'0xabc'});
 assert.match(c.usdg,/\$5 or more gets its gas sponsored/);assert.match(c.usdg,/\$1 is the smallest/);assert.match(c.gas,/smaller trade.*ETH/);
});
