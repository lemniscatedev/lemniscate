// Unit tests for the local serving profiles (scripts/profiles.mjs, serve.mjs LM_PROFILE) and the testnet config:
// `npm test` (node:test, no dependencies). Ports: three free ports chosen by the OS (PROFILE_TEST_PORT pins the first and the next two).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import vm from 'node:vm';
import {createServer} from 'node:net';
import {PROFILES,resolveProfile,applyOverrides,configValue,profileOrigins,withConnectOrigins,profileHeaders} from './profiles.mjs';

// A fixed port can be taken by another process on a shared machine: ask the OS for free loopback ports instead.
const freePort=()=>new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const{port}=s.address();s.close(()=>resolve(port))})});
const PINNED=process.env.PROFILE_TEST_PORT?Number(process.env.PROFILE_TEST_PORT):null;
const pick=async i=>PINNED===null?await freePort():PINNED+i;
const TESTNET={chainId:46630,chainName:'Robinhood Chain Testnet',rpcUrl:'https://rpc.testnet.chain.robinhood.com',
 explorerUrl:'https://explorer.testnet.chain.robinhood.com',apiBase:'http://127.0.0.1:3171'};

const load=async file=>{const ctx={window:{}};vm.runInNewContext(await readFile(file,'utf8'),ctx);return ctx.window.LM_CONFIG};

test('resolveProfile: empty is the shipped config, known names resolve, a typo refuses',()=>{
 assert.equal(resolveProfile(''),null);
 assert.equal(resolveProfile(undefined),null);
 assert.deepEqual(resolveProfile('testnet'),{name:'testnet',...PROFILES.testnet});
 assert.equal(resolveProfile('fork').file,'config.fork.js');
 assert.throws(()=>resolveProfile('testnte'),/Unknown LM_PROFILE "testnte"/);
 assert.throws(()=>resolveProfile('mainnet'),/Unknown LM_PROFILE/);
});

test('config.testnet.js: chain 46630, testnet RPC/explorer, local testnet API, no dev wallet, one-tap on',async()=>{
 const c=await load('dist/config.testnet.js'),prod=await load('dist/config.js');
 for(const [k,v] of Object.entries(TESTNET))assert.equal(c[k],v,k);
 assert.equal(c.devWallet,false);
 assert.equal(c.oneTap,true);
 assert.deepEqual([...c.blockedRegions],[...prod.blockedRegions]);
 assert.equal(c.appKitUrl,prod.appKitUrl);
 assert.ok(Object.isFrozen(c));
});

test('shipped config.js stays mainnet and never mentions the testnet',async()=>{
 const text=await readFile('dist/config.js','utf8'),c=await load('dist/config.js');
 assert.equal(c.chainId,4663);
 assert.equal(c.rpcUrl,'https://rpc.mainnet.chain.robinhood.com');
 assert.doesNotMatch(text,/testnet|46630/i);
});

test('wallet network-add parameters for 46630 (wallet.js ensureChain, run against a wallet without the network)',async()=>{
 const src=await readFile('dist/chain/wallet.js','utf8');
 const fn=src.match(/function hexChain[\s\S]*?\n}\n/)[0]+src.match(/async function ensureChain[\s\S]*?\n}\n/)[0];
 const ensureChain=vm.runInNewContext(fn+';ensureChain');
 const calls=[];
 const provider={request:async({method,params})=>{calls.push({method,params});
  if(method==='eth_chainId')return '0x1237';
  if(method==='wallet_switchEthereumChain')throw Object.assign(new Error('Unrecognized chain'),{code:4902});
  if(method==='wallet_addEthereumChain')return null;
  throw new Error('unexpected '+method)}};
 const id=await ensureChain(provider,await load('dist/config.testnet.js'));
 assert.equal(id,46630);
 assert.deepEqual(calls.map(c=>c.method),['eth_chainId','wallet_switchEthereumChain','wallet_addEthereumChain']);
 assert.equal(calls[1].params[0].chainId,'0xb626');
 assert.deepEqual(JSON.parse(JSON.stringify(calls[2].params[0])),{chainId:'0xb626',chainName:'Robinhood Chain Testnet',
  nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:['https://rpc.testnet.chain.robinhood.com'],
  blockExplorerUrls:['https://explorer.testnet.chain.robinhood.com']});
});

test('overrides and origins',()=>{
 const src="window.LM_CONFIG=Object.freeze({apiBase:'http://127.0.0.1:3171',rpcUrl:'https://rpc.testnet.chain.robinhood.com',explorerUrl:'https://explorer.testnet.chain.robinhood.com'});";
 assert.deepEqual(profileOrigins(src),['http://127.0.0.1:3171','https://rpc.testnet.chain.robinhood.com']);
 const o=applyOverrides(src,{LM_API_BASE:'http://127.0.0.1:3999',LM_RPC_URL:'http://127.0.0.1:8615'});
 assert.equal(configValue(o,'apiBase'),'http://127.0.0.1:3999');
 assert.equal(configValue(o,'rpcUrl'),'http://127.0.0.1:8615');
 assert.equal(applyOverrides(src,{}),src);
 assert.equal(configValue(applyOverrides(src,{LM_API_BASE:"x'y"}),'apiBase'),'x');// a quote cannot break out of the string
 assert.deepEqual(profileOrigins("apiBase:'',rpcUrl:'http://evil.example'"),[]);// plain http only for localhost
});

test('CSP: profile origins go into connect-src only; no policy stays no policy',()=>{
 const origins=['http://127.0.0.1:3171','https://rpc.testnet.chain.robinhood.com'];
 const csp="default-src 'self'; script-src 'self'; connect-src 'self' https://rpc.mainnet.chain.robinhood.com; frame-ancestors 'none'";
 assert.equal(withConnectOrigins(csp,origins),"default-src 'self'; script-src 'self'; connect-src 'self' https://rpc.mainnet.chain.robinhood.com http://127.0.0.1:3171 https://rpc.testnet.chain.robinhood.com; frame-ancestors 'none'");
 assert.equal(withConnectOrigins(withConnectOrigins(csp,origins),origins),withConnectOrigins(csp,origins));// idempotent
 assert.equal(withConnectOrigins("default-src 'self' https://a.example",origins),"default-src 'self' https://a.example; connect-src 'self' https://a.example http://127.0.0.1:3171 https://rpc.testnet.chain.robinhood.com");
 assert.equal(withConnectOrigins('',origins),'');
 assert.equal(withConnectOrigins(csp,[]),csp);
 const h=profileHeaders({'Content-Type':'text/html','content-security-policy':csp},origins);
 assert.match(h['content-security-policy'],/connect-src [^;]*https:\/\/rpc\.testnet\.chain\.robinhood\.com/);
 assert.match(h['content-security-policy'],/script-src 'self';/);
 assert.equal(h['Content-Type'],'text/html');
 assert.deepEqual(profileHeaders({'Cache-Control':'no-store'},origins),{'Cache-Control':'no-store'});
});

// serve.mjs end to end: start it (our own child processes only), fetch, stop it.
async function serve(env,port){
 const child=spawn(process.execPath,['serve.mjs'],{env:{...process.env,LM_PROFILE:'',LM_API_BASE:'',LM_RPC_URL:'',...env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d);
 const exited=new Promise(r=>child.on('exit',code=>r(code)));
 let timer;
 const ready=await Promise.race([new Promise(r=>{timer=setInterval(()=>{if(/Lemniscate preview/.test(out))r(true)},20)}),exited.then(()=>false),
  new Promise(r=>setTimeout(r,60_000,false).unref()).then(v=>{if(child.exitCode===null)child.kill();return v})]).finally(()=>clearInterval(timer));
 return {child,ready,out:()=>out,exited,stop:()=>{child.kill();return exited}};
}

test('serve.mjs: no profile serves config.js byte for byte; testnet serves config.testnet.js with overrides; typo refuses',async()=>{
 const PORT=await pick(0),P1=await pick(1),P2=await pick(2);
 const prod=await serve({},PORT);
 try{
  assert.ok(prod.ready,prod.out());
  const body=Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/config.js`)).arrayBuffer());
  assert.ok(body.equals(await readFile('dist/config.js')));
 }finally{await prod.stop()}
 const t=await serve({LM_PROFILE:'testnet'},P1);
 try{
  assert.ok(t.ready,t.out());
  assert.match(t.out(),/TESTNET profile: Robinhood Chain testnet, chain 46630/);
  const res=await fetch(`http://127.0.0.1:${P1}/config.js`);
  assert.equal(await res.text(),await readFile('dist/config.testnet.js','utf8'));
  assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal(res.headers.get('content-security-policy'),null);// no CSP shipped in this repo yet: none invented
  const page=await fetch(`http://127.0.0.1:${P1}/dashboard/`);
  assert.equal(page.status,200);
 }finally{await t.stop()}
 const o=await serve({LM_PROFILE:'testnet',LM_API_BASE:'http://127.0.0.1:3999'},P2);
 try{
  assert.ok(o.ready,o.out());
  const text=await (await fetch(`http://127.0.0.1:${P2}/config.js`)).text();
  assert.equal(configValue(text,'apiBase'),'http://127.0.0.1:3999');
  assert.equal(configValue(text,'rpcUrl'),TESTNET.rpcUrl);
 }finally{await o.stop()}
 const bad=await serve({LM_PROFILE:'testnte'},PORT);
 assert.equal(bad.ready,false);
 assert.equal(await bad.exited,1);
 assert.match(bad.out(),/Unknown LM_PROFILE/);
});
