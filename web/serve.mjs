import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {resolveProfile,applyOverrides,profileOrigins,profileHeaders} from './scripts/profiles.mjs';
const root=path.resolve('dist');
const port=Number(process.env.PORT||4189);
// LM_PROFILE=fork|testnet: /config.js is answered with that profile's config (dist/config.fork.js: local anvil fork, dev
// wallet; dist/config.testnet.js: Robinhood Chain testnet 46630), with apiBase and rpcUrl taken from LM_API_BASE /
// LM_RPC_URL when set, and that profile's API and RPC origins added to connect-src of any Content-Security-Policy sent.
// No LM_PROFILE serves the shipped config.js untouched; an unknown LM_PROFILE refuses to start (scripts/profiles.mjs).
let profile;
try{profile=resolveProfile(process.env.LM_PROFILE||'')}catch(error){console.error(error.message);process.exit(1)}
const profileConfig=async()=>Buffer.from(applyOverrides(await readFile(path.join(root,profile.file),'utf8'),process.env));
const origins=profile?profileOrigins((await profileConfig()).toString()):[];
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.woff2':'font/woff2','.woff':'font/woff','.framercms':'application/octet-stream'};
http.createServer(async(req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  let file=path.resolve(root,'.'+pathname);
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  if((await stat(file)).isDirectory())file=path.join(file,'index.html');
  const body=profile&&pathname==='/config.js'?await profileConfig():await readFile(file);
  let headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':body.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(profile)headers=profileHeaders(headers,origins);
  res.writeHead(200,headers);
  res.end(req.method==='HEAD'?undefined:body);
 }catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Page not found')}
}).listen(port,'127.0.0.1',()=>console.log(`Lemniscate preview: http://127.0.0.1:${port}${profile?` (${profile.label})`:''}`));
