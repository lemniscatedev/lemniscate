import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('dist');
const port=Number(process.env.PORT||4189);
// LM_PROFILE=fork: /config.js is answered with dist/config.fork.js (local anvil fork, dev wallet), with apiBase and
// rpcUrl taken from LM_API_BASE / LM_RPC_URL when set. Any other profile serves the shipped config.js untouched.
const profile=process.env.LM_PROFILE||'';
async function forkConfig(){
 let c=await readFile(path.join(root,'config.fork.js'),'utf8');
 const q=v=>JSON.stringify(String(v)).replace(/^"|"$/g,'');
 if(process.env.LM_API_BASE)c=c.replace(/apiBase:'[^']*'/,`apiBase:'${q(process.env.LM_API_BASE)}'`);
 if(process.env.LM_RPC_URL)c=c.replace(/rpcUrl:'[^']*'/,`rpcUrl:'${q(process.env.LM_RPC_URL)}'`);
 return Buffer.from(c);
}
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.woff2':'font/woff2','.woff':'font/woff','.framercms':'application/octet-stream'};
http.createServer(async(req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  let file=path.resolve(root,'.'+pathname);
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  if((await stat(file)).isDirectory())file=path.join(file,'index.html');
  const body=profile==='fork'&&pathname==='/config.js'?await forkConfig():await readFile(file);
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':body.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:body);
 }catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Page not found')}
}).listen(port,'127.0.0.1',()=>console.log(`Lemniscate preview: http://127.0.0.1:${port}${profile==='fork'?' (LOCAL FORK profile: chain 31337, dev wallet)':''}`));
