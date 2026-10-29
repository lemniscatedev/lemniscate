import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const page=await readFile(new URL('../dist/exit/index.html',import.meta.url),'utf8');
const local=await readFile(new URL('../dist/lemniscate-exit.html',import.meta.url),'utf8');
const SRC=new URL('../../backend/contracts/src/',import.meta.url);

// Every function the guide tells people to call, as [contract source file, name].
const CALLS=[
 ['LemniscateEngine.sol','sell'],['LemniscateEngine.sol','quoteFor'],['LemniscateEngine.sol','holdOf'],['LemniscateEngine.sol','queuedSell'],
 ['LemniscateEngine.sol','fillQueued'],['LemniscateEngine.sol','cancelQueued'],['SeriesRegistry.sol','seriesOf'],['OptionToken.sol','seriesId'],
 ['WriterPool.sol','requestWithdraw'],['WriterPool.sol','claim'],['WriterPool.sol','ticketOf'],['WriterPool.sol','unlockTime'],['WriterPool.sol','previewRedeem'],
 ['WriterPool.sol','QUEUE_DELAY'],['AgentRouter.sol','revoke'],['vaults/WriterVault.sol','requestWithdraw'],['vaults/WriterVault.sol','claim'],['vaults/WriterVault.sol','roll'],['vaults/WriterVault.sol','claimable'],
];
test('the guide is self-contained',()=>{
 for(const html of [page,local]){
  assert.doesNotMatch(html,/<script\b/i);assert.doesNotMatch(html,/<img\b|stylesheet|@import|url\(/i);
  assert.doesNotMatch(html,/<!--LM:/);
 }
});
test('the guide names the exact functions',()=>{
 for(const sig of ['sell(bytes32 id, uint128 tokens, uint128 minProceedsUsdg, uint64 deadline, address recipient)','requestWithdraw(uint256 shares)','claim(uint256 ticket)','fillQueued(uint256 ticket)','cancelQueued(uint256 ticket)','revoke(address agent)'])assert.ok(page.includes(sig),sig);
 assert.match(page,/0x1C1f41721fe49c8dee117B17De1006817C974687/);assert.match(page,/0x67fF1306201bCbEBCBB749DcF0cb2686ec11B58A/);
});
test('the local copy has no link back to the site',()=>{
 assert.doesNotMatch(local,/href="\//);
 assert.match(page,/href="\/contracts"/);
});
test('copy rules',()=>{
 for(const re of [/\bAPY\b/,/yield/i,/\bincome\b/i,/—/,/free options/i,/no fees/i,/can't lose/i])assert.doesNotMatch(page,re);
});
test('every function exists in the contract sources (when the backend is checked out)',async t=>{
 let ok=true;try{await readdir(SRC)}catch{ok=false}
 if(!ok)return t.skip('backend sources not present');
 for(const [file,name] of CALLS){
  const src=await readFile(new URL(file,SRC),'utf8');
  assert.ok(new RegExp(`function\\s+${name}\\s*\\(|\\b${name}\\b\\s*(?:;|=)|\\b(public|external)\\b[^;]*\\b${name}\\b`).test(src),`${file} has no ${name}`);
 }
});
