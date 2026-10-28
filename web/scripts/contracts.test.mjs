import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {rowsFrom,stocksFrom,explorerAddress,sourcifyPage,sourcifyApi,isVerified} from '../dist/chain/contracts-list.js';

const a=n=>'0x'+n.toString(16).padStart(40,'0');
test('rows list valid addresses only, known contracts first',()=>{
 const rows=rowsFrom({usdg:a(1),zzz:a(2),engine:a(3),pool:'nope',empty:'',agentRouter:a(4)});
 assert.deepEqual(rows.map(r=>r.key),['engine','agentRouter','usdg','zzz']);
 assert.equal(rows[0].label,'Engine');assert.equal(rows[3].label,'zzz');
});
test('empty or odd input gives no rows',()=>{
 assert.deepEqual(rowsFrom({}),[]);assert.deepEqual(rowsFrom(null),[]);assert.deepEqual(rowsFrom(undefined),[]);
});
test('links',()=>{
 assert.equal(explorerAddress('https://x.test/',a(1)),`https://x.test/address/${a(1)}`);
 assert.equal(sourcifyPage(4663,a(1)),`https://repo.sourcify.dev/4663/${a(1)}`);
 assert.equal(sourcifyApi(4663,a(1)),`https://sourcify.dev/server/v2/contract/4663/${a(1)}`);
});
test('verified only on a source match',()=>{
 assert.equal(isVerified({match:'exact_match'}),true);assert.equal(isVerified({match:null}),false);assert.equal(isVerified(null),false);
});
test('stocks',()=>assert.deepEqual(stocksFrom([{name:'NVDA',stock:a(9)},{name:'bad',stock:'x'}]),[{name:'NVDA',address:a(9)}]));
test('the shipped deployment file has no addresses before launch',async()=>{
 const f=JSON.parse(await readFile(new URL('../dist/contracts.json',import.meta.url),'utf8'));
 assert.deepEqual(rowsFrom(f.contracts),[]);
});
