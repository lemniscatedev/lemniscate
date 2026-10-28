// Rewrites the <head> of every route from ONE config value (dist/config.js siteUrl), todo 18 R14:
//  - removes any absolute og:url, og:image, twitter:image and canonical link left in the HTML;
//  - when siteUrl is an https origin, writes canonical + og:url + og:image + twitter:image from it;
//  - loads /config.js on every page; fixes template page titles.
// Run after changing siteUrl: npm run stamp (also part of npm run build).
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const routes=JSON.parse(await readFile('scripts/routes.json','utf8'));
const config=await readFile('dist/config.js','utf8');
const siteUrl=(config.match(/\bsiteUrl\s*:\s*'([^']*)'/)?.[1]||'').replace(/\/+$/,'');
if(siteUrl&&!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(siteUrl))throw new Error('siteUrl must be an https origin without a path: '+siteUrl);
const TITLES={
 '/markets/upside':'Hold the upside - Lemniscate',
 '/markets/shield':'Protect the downside - Lemniscate',
 '/markets/daily-and-weekly':'Choose your pace - Lemniscate',
 '/markets/writer-pool':'Write with collateral - Lemniscate',
 '/contracts':'Contracts | Lemniscate',
 '/learn/stock-token-pricing':'One Stock Token. One consistent value. - Lemniscate',
};
const esc=s=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
let changed=0;
for(const route of routes){
 const file=path.join('dist',route,'index.html');let html=await readFile(file,'utf8');const before=html;
 html=html.replace(/[ \t]*<meta (?:property|name)="(?:og:url|og:image|twitter:image)"[^>]*>\n?/g,'');
 html=html.replace(/[ \t]*<link rel="canonical"[^>]*>\n?/g,'');
 html=html.replace(/<!-- lm:site-url -->[\s\S]*?<!-- \/lm:site-url -->\n?/g,'');
 const title=TITLES[route];
 if(title){html=html.replace(/<title>[^<]*<\/title>/,`<title>${esc(title)}</title>`).replace(/(<meta (?:property="og:title"|name="twitter:title") content=")[^"]*"/g,`$1${esc(title)}"`)}
 if(!html.includes('src="/config.js'))html=html.replace(/<head>/,'<head><script src="/config.js?v=10"></script>');
 // Token address box (todo 34): hidden until dist/launch.json holds an address.
 if(!html.includes('/token-bar.js'))html=html.replace('</body>','<script src="/token-bar.js?v=1" defer></script></body>');
 // Cache-busting versions of the files todo 18 changed.
 for(const f of ['/dashboard.css','/lemniscate.js','/assets/asset-loader.js','/assets/asset-plan.js'])html=html.split(f+'?v=9').join(f+'?v=10');
 if(siteUrl){
  const url=siteUrl+(route==='/'?'/':route);
  const tags=`<!-- lm:site-url --><link rel="canonical" href="${esc(url)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(siteUrl)}/assets/brand-banner.png"><meta name="twitter:image" content="${esc(siteUrl)}/assets/brand-banner.png"><!-- /lm:site-url -->`;
  html=html.replace('</head>',tags+'</head>');
 }
 if(html!==before){await writeFile(file,html);changed++}
}
console.log(`Stamped ${routes.length} routes (${changed} changed), siteUrl ${siteUrl?siteUrl:'empty: no absolute og:url, og:image or canonical'}.`);
