// Copy lint (todo 18 R8): fails on phrases the product must never use, in every user-visible string the site ships:
// HTML text, string literals in the custom layer and the native runtime modules, and the CMS content.
// Rules (CLAUDE.md copy rules): never "APY", "yield", "income" for the pool or vaults; never "can't lose", "free options",
// "no fees", "no time decay"; no partnership or endorsement wording with Robinhood, Chainlink, Cboe or any venue.
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {decode} from './cms-codec.mjs';

export const RULES=[
 [/\bAPY\b|\bAPR\b/,'APY/APR: say NAV or funding received'],
 [/\byield(s|ing)?\b/i,'"yield": say NAV or funding received'],
 [/\bincome\b/i,'"income": say funding received'],
 [/\bcan(?:'|’|no)?t lose\b|\bcannot lose\b|\bno risk\b|\brisk[- ]free\b|\bguaranteed (?:return|profit)/i,'no-loss or guarantee wording'],
 [/\bfree options?\b/i,'"free options"'],
 [/\bno fees?\b|\bzero fees?\b|\bfee[- ]free\b/i,'"no fees"'],
 [/\bno (?:time )?decay\b/i,'"no time decay"'],
 [/\b(?:partner(?:ed|s|ship)?|endorse(?:d|s|ment)?|affiliated|in association with|sponsored by|backed by|powered by|official (?:partner|integration))\b/i,'partnership or endorsement wording'],
];

const STRING=/`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
// Library modules (React, Framer, motion) carry developer messages, not product copy.
const LIBRARY=/^(react|framer|motion|rolldown-runtime|shared-lib)\./;

async function walk(dir,out=[]){for(const e of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory()){if(!['app','fonts','photos','slots','icons'].includes(e.name))await walk(f,out)}else out.push(f)}return out}

function htmlText(html){return html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<meta[^>]*content="([^"]*)"[^>]*>/gi,' $1 ').replace(/<[^>]+>/g,' ')}

export async function lint(root='dist'){
 const findings=[];
 const check=(file,text)=>{for(const [re,why] of RULES){const m=text.match(re);if(m)findings.push(`${file}: ${why}: "${text.slice(Math.max(0,m.index-50),m.index+m[0].length+50).replace(/\s+/g,' ')}"`)}};
 for(const file of await walk(root)){
  const base=path.basename(file);
  if(file.endsWith('.html'))check(file,htmlText(await readFile(file,'utf8')));
  else if(/\.(m?js)$/.test(file)&&!LIBRARY.test(base)){const src=await readFile(file,'utf8');for(const s of src.match(STRING)||[]){if(s.length>3&&!/__lmContentB64/.test(s))check(file,s)}}
  else if(file.endsWith('.framercms')){for(const fields of decode(await readFile(file)))for(const f of fields)if(typeof f.value==='string')check(file,f.value)}
 }
 return findings;
}

if(import.meta.url===`file://${process.argv[1]}`){
 const findings=await lint(process.argv[2]||'dist');
 if(findings.length){console.error(findings.join('\n'));console.error(`Copy lint: ${findings.length} forbidden phrase(s).`);process.exitCode=1}
 else console.log('Copy lint: no forbidden phrases.');
}
