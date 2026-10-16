import {build} from 'esbuild';
import {readFile,writeFile,mkdir,readdir,unlink} from 'node:fs/promises';
import path from 'node:path';

// Editable native layout modules are retained under dist/runtime.
// Use the route source map to keep preloading and dashboard return navigation
// aligned with esbuild's changing output hashes after every rebuild.
const runtimeRoutes=JSON.parse(await readFile('scripts/route-runtime-map.json','utf8'));
const planText=await readFile('dist/assets/asset-plan.js','utf8');
const plan=JSON.parse(planText.replace(/^window\.LEMN_ASSET_PLAN\s*=\s*/,'').replace(/;\s*$/,''));
await mkdir('dist/assets/app',{recursive:true});
const result=await build({
 entryPoints:['dist/runtime/script_main.CV1Flg4e.mjs'],outdir:'dist/assets/app',entryNames:'lemniscate-[hash]',chunkNames:'chunk-[hash]',
 bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2020',minify:true,metafile:true,
 external:['https://*','http://*'],
 plugins:[{name:'local-runtime',setup(builder){builder.onResolve({filter:/\.mjs\?lm=\d+$/},args=>/^https?:/.test(args.path)?{path:args.path,external:true}:{path:path.resolve(args.resolveDir,args.path.split('?')[0])});}}]
});
const entry=Object.entries(result.metafile.outputs).find(([,data])=>data.entryPoint?.endsWith('script_main.CV1Flg4e.mjs'))?.[0];
if(!entry)throw new Error('Native runtime entry was not emitted.');
const url=file=>'/'+file.replace(/^dist\//,'');
const outputBySource=new Map(Object.entries(result.metafile.outputs).filter(([,data])=>data.entryPoint).map(([file,data])=>[data.entryPoint,url(file)]));
const modules={};
for(const [route,source] of Object.entries(runtimeRoutes)){
 const output=outputBySource.get(source);
 if(!output)throw new Error(`No bundled module for ${route}: ${source}. Update scripts/route-runtime-map.json if a route module was renamed.`);
 modules[route]=output;
}
async function updateHTML(dir){
 for(const item of await readdir(dir,{withFileTypes:true})){
  const file=path.join(dir,item.name);
  if(item.isDirectory())await updateHTML(file);
  else if(item.name==='index.html'){
   const source=await readFile(file,'utf8');
   await writeFile(file,source.replace(/\/assets\/app\/lemniscate-[A-Z0-9]+\.js/g,url(entry)));
  }
 }
}
await updateHTML('dist');
plan.entry=url(entry);plan.modules=modules;
await writeFile('dist/assets/asset-plan.js','window.LEMN_ASSET_PLAN='+JSON.stringify(plan)+';\n');
for(const name of await readdir('dist/assets/app')){
 const file='dist/assets/app/'+name;
 if(name.endsWith('.js')&&!result.metafile.outputs[file])await unlink(file);
}
await writeFile('BUNDLE-METAFILE.json',JSON.stringify(result.metafile));
await writeFile('BUNDLE-REPORT.json',JSON.stringify({entry:url(entry),outputs:Object.entries(result.metafile.outputs).map(([file,data])=>({file,bytes:data.bytes,imports:data.imports.length}))},null,2)+'\n');
console.log('Bundled entry: '+url(entry));
