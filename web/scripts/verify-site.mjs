import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
const dist=path.resolve('dist');
const routes=JSON.parse(await readFile('scripts/routes.json','utf8'));
const plan=JSON.parse((await readFile('dist/assets/asset-plan.js','utf8')).replace(/^window\.LEMN_ASSET_PLAN\s*=\s*/,'').replace(/;\s*$/,''));
const meta=JSON.parse(await readFile('BUNDLE-METAFILE.json','utf8'));
const references=new Set([plan.entry,plan.brand,...Object.values(plan.modules),...Object.values(plan.pages).flat(),...Object.keys(plan.variants),...Object.values(plan.variants),...plan.fonts,...plan.content]);
const errors=[];
for(const route of routes){
 const file=path.join(dist,route,'index.html');
 let html;
 try{html=await readFile(file,'utf8')}catch{errors.push('Missing route: '+route);continue}
 for(const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)){
  const ref=match[1];if(ref.startsWith('/')&&!ref.startsWith('//'))references.add(ref.split(/[?#]/)[0]);
 }
 if(html.includes('data-framer-bundle=')&&!html.includes(plan.entry))errors.push('Runtime entry mismatch: '+route);
}
for(const ref of references){
 if(!ref||ref==='/')continue;
 try{await stat(path.join(dist,ref))}catch{errors.push('Missing asset or route: '+ref)}
}
for(const [file,data] of Object.entries(meta.outputs)){
 try{await stat(file)}catch{errors.push('Missing bundled output: '+file)}
 for(const item of data.imports||[]){
  if(item.external)continue;
  try{await stat(item.path)}catch{errors.push('Missing bundled import: '+item.path)}
 }
}
if(errors.length){console.error([...new Set(errors)].join('\n'));process.exitCode=1}
else console.log(`Verified ${routes.length} routes, ${references.size} local references, ${Object.keys(meta.outputs).length} bundled modules.`);
