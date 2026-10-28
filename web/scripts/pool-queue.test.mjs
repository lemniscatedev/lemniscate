import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TOPIC_QUEUED,queuedFromLogs,queuedFromReceipt,parseTicketOf,readTickets,addTickets,dropTicket,mergeIds,ticketState,waitText} from '../dist/chain/pool-queue.js';
import {call,SELECTORS} from '../dist/chain/abi.js';

const POOL='0x'+'b1'.repeat(20),ME='0x'+'0a'.repeat(20);
const w=n=>BigInt(n).toString(16).padStart(64,'0');
const log=(ticket,shares,at,owner=ME)=>({address:POOL,topics:[TOPIC_QUEUED,'0x'+owner.slice(2).padStart(64,'0'),'0x'+w(ticket)],data:'0x'+w(shares)+w(at)});
const memory=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v))}};

test('the pool selectors are the queue functions, and there is no redeem path',async()=>{
 assert.equal(SELECTORS.requestWithdraw,'0x745400c9');assert.equal(SELECTORS.claim,'0x379607f5');assert.equal(SELECTORS.ticketOf,'0x8bba0958');assert.equal(SELECTORS.queueDelay,'0xc0a096b8');
 assert.equal(SELECTORS.redeem,undefined);assert.equal(SELECTORS.maxRedeem,undefined);
 assert.equal(call('requestWithdraw',[['uint',5]]),'0x745400c9'+w(5));
 for(const f of ['dashboard.js','chain/abi.js']){
  const src=await readFile(new URL('../dist/'+f,import.meta.url),'utf8');
  assert.doesNotMatch(src,/call\('(redeem|maxRedeem|withdraw)'/);assert.doesNotMatch(src,/\bmaxRedeem\b|0xba087652/);
 }
});
test('a receipt gives the ticket, shares and claimableAt',()=>{
 const q=queuedFromReceipt({logs:[log(7,5_000_000_000_000,1800000000)]},POOL,ME);
 assert.deepEqual(q,[{id:'7',shares:5_000_000_000_000n,claimableAt:1800000000}]);
 assert.deepEqual(queuedFromLogs([log(7,1,1,'0x'+'cc'.repeat(20))],POOL,ME),[],'another owner');
 assert.deepEqual(queuedFromLogs([{...log(7,1,1),address:'0x'+'dd'.repeat(20)}],POOL,ME),[],'another contract');
 assert.deepEqual(queuedFromReceipt(null,POOL,ME),[]);
});
test('ticketOf answers',()=>{
 assert.deepEqual(parseTicketOf('0x'+w(BigInt(ME))+w(9)+w(1800000000)),{owner:ME,shares:9n,claimableAt:1800000000});
 assert.equal(parseTicketOf('0x'+'0'.repeat(192)),null);assert.equal(parseTicketOf('0x'),null);
});
test('tickets are kept per wallet in storage and merged without duplicates',()=>{
 const s=memory();
 addTickets(ME,['3','4'],s);addTickets(ME,['4','5'],s);addTickets('0xdead',['9'],s);
 assert.deepEqual(readTickets(ME,s),['3','4','5']);assert.deepEqual(readTickets('0xDEAD',s),['9']);
 dropTicket(ME,'4',s);assert.deepEqual(readTickets(ME,s),['3','5']);
 assert.deepEqual(mergeIds(['3','5'],[5,12],['x',null],[]),['12','5','3']);
 const broken={getItem:()=>{throw new Error('x')},setItem:()=>{throw new Error('x')}};
 assert.deepEqual(readTickets(ME,broken),[]);assert.equal(addTickets(ME,['1'],broken),false);
});
test('ticket state and wait text',()=>{
 assert.equal(ticketState(100,50),'waiting');assert.equal(ticketState(100,100),'ready');assert.equal(ticketState(100,100+7*86400),'ready');assert.equal(ticketState(100,101+7*86400),'late');
 assert.equal(waitText(259200),'3 days');assert.equal(waitText(300),'5 minutes');assert.equal(waitText(7200),'2 hours');assert.equal(waitText(30),'30 seconds');
});
