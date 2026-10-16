// Read and rewrite the length-prefixed .framercms content files (and the base64 copy embedded in the matching
// dist/runtime module) so copy edits keep every length prefix correct.
// Format, as observed: uint32 itemCount, then per item uint16 fieldCount and fields of
// uint32 keyLength + key + type byte + value. Types: 0x0c string, 0x0a JSON and 0x0b rich text (one version byte first) (uint32 length + UTF-8), 0x04 number (8 bytes),
// 0x01/0x02 booleans (no payload), 0x00 null.
import {readFile,writeFile} from 'node:fs/promises';

export function decode(buf){
 let o=0;const u32=()=>{const v=buf.readUInt32BE(o);o+=4;return v},u16=()=>{const v=buf.readUInt16BE(o);o+=2;return v};
 const str=n=>{const v=buf.subarray(o,o+n).toString('utf8');o+=n;return v};
 const count=u32(),items=[];
 for(let i=0;i<count;i++){
  const n=u16(),fields=[];
  for(let j=0;j<n;j++){
   const key=str(u32()),type=buf[o++];let value=null;
   if(type===0x0c||type===0x0a)value=str(u32());
   else if(type===0x0b){const version=buf[o++];value=str(u32());fields.push({key,type,version,value});continue}
   else if(type===0x04){value=buf.subarray(o,o+8);o+=8}
   else if(type===0x01||type===0x02||type===0x00)value=null;
   else throw new Error(`Unknown CMS type 0x${type.toString(16)} at ${o-1}`);
   fields.push({key,type,value});
  }
  items.push(fields);
 }
 if(o!==buf.length)throw new Error(`Trailing bytes: parsed ${o} of ${buf.length}`);
 return items;
}

export function encode(items){
 const parts=[];const u32=v=>{const b=Buffer.alloc(4);b.writeUInt32BE(v);parts.push(b)};
 u32(items.length);
 for(const fields of items){
  const h=Buffer.alloc(2);h.writeUInt16BE(fields.length);parts.push(h);
  for(const f of fields){
   const k=Buffer.from(f.key,'utf8');u32(k.length);parts.push(k,Buffer.from([f.type]));
   if(f.type===0x0b){parts.push(Buffer.from([f.version]));const v=Buffer.from(f.value,'utf8');u32(v.length);parts.push(v)}
   else if(f.type===0x0c||f.type===0x0a){const v=Buffer.from(f.value,'utf8');u32(v.length);parts.push(v)}
   else if(f.type===0x04)parts.push(f.value);
  }
 }
 return Buffer.concat(parts);
}

/** Apply [from,to] replacements to every string value; returns the number of replacements made. */
export async function rewrite(cmsFile,moduleFile,replacements){
 const buf=await readFile(cmsFile);const items=decode(buf);
 if(!encode(items).equals(buf))throw new Error('Codec does not round-trip '+cmsFile);
 let changes=0;
 for(const fields of items)for(const f of fields){
  if(f.type!==0x0c&&f.type!==0x0a&&f.type!==0x0b)continue;
  for(const [from,to] of replacements){if(f.value.includes(from)){f.value=f.value.split(from).join(to);changes++}}
 }
 const out=encode(items);
 await writeFile(cmsFile,out);
 const mod=await readFile(moduleFile,'utf8');
 const next=mod.replace(/__lmContentB64="[^"]+"/,`__lmContentB64="${out.toString('base64')}"`);
 if(next===mod&&changes)throw new Error('Embedded content not found in '+moduleFile);
 await writeFile(moduleFile,next);
 return changes;
}

if(process.argv[2]==='dump'){
 for(const fields of decode(await readFile(process.argv[3])))for(const f of fields)if(f.type===0x0c||f.type===0x0a||f.type===0x0b)console.log(f.key+': '+f.value);
}
