// Minimal ABI encoding for the few calls the website builds itself (pool deposit/redeem, agent policies, reads).
// Option trades never use this: their calldata comes from the API intents. Selectors were computed with viem's
// toFunctionSelector from the backend ABIs (backend app/src/abi) on 2026-10-16. The AgentRouter ABI there is a declared
// fallback until its contract lands (todo 09); recheck setPolicy/revoke against the real artifact then.
export const SELECTORS=Object.freeze({
 approve:'0x095ea7b3',                 // approve(address,uint256)
 allowance:'0xdd62ed3e',               // allowance(address,address)
 balanceOf:'0x70a08231',               // balanceOf(address)
 deposit:'0x6e553f65',                 // deposit(uint256,address)
 redeem:'0xba087652',                  // redeem(uint256,address,address)
 maxRedeem:'0xd905777e',               // maxRedeem(address)
 maxDeposit:'0x402d267d',              // maxDeposit(address)
 unlockTime:'0x76b467b7',              // unlockTime(address)
 isDepositor:'0x2f70d1ba',             // isDepositor(address)
 publicDeposits:'0x42f078e2',          // publicDeposits()
 previewDeposit:'0xef8b30f7',          // previewDeposit(uint256)
 previewRedeem:'0x4cdad506',           // previewRedeem(uint256)
 setPolicy:'0xbcabc742',               // setPolicy(address,uint128,uint128,uint64,bool,bool,address[])
 revoke:'0x74a8f103',                  // revoke(address)
});
export const AGENT_TRADE_TOPIC='0x2b620e696fe3e0a9b516baf0a401c9e7ab717a951572c3a7edca544a4a5c3c4a'; // not-a-key (event topic hash)

const word=hex=>hex.replace(/^0x/,'').padStart(64,'0');
export function isAddress(value){return typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value)}
export function encUint(value){const n=BigInt(value);if(n<0n)throw new Error('Negative amount');return word(n.toString(16))}
export function encAddress(value){if(!isAddress(value))throw new Error('Invalid address');return word(value.toLowerCase())}
export function encBool(value){return word(value?'1':'0')}

/** Encode a call whose arguments are static words, plus at most one trailing address[]. */
export function call(name,args=[],tail=null){
 const selector=SELECTORS[name];if(!selector)throw new Error('Unknown function '+name);
 const head=args.map(([type,value])=>type==='address'?encAddress(value):type==='bool'?encBool(value):encUint(value));
 if(!tail)return selector+head.join('');
 const offset=encUint((head.length+1)*32);
 const list=[encUint(tail.length),...tail.map(encAddress)];
 return selector+head.join('')+offset+list.join('');
}
export function decodeUint(hex){return hex&&hex!=='0x'?BigInt(hex.slice(0,66)):0n}
export function decodeBool(hex){return decodeUint(hex)!==0n}

/** Fixed-point helpers: raw integer <-> decimal string, no floating point on amounts that are signed. */
export function toRaw(text,decimals){
 const clean=String(text).trim();if(!/^\d+(\.\d+)?$/.test(clean))throw new Error('Enter a positive number.');
 const [whole,frac='']=clean.split('.');if(frac.length>decimals)throw new Error(`Use at most ${decimals} decimal places.`);
 return BigInt(whole+frac.padEnd(decimals,'0'));
}
export function fromRaw(raw,decimals,places=decimals){
 const n=BigInt(raw),neg=n<0n,abs=neg?-n:n,base=10n**BigInt(decimals);
 const whole=abs/base,frac=(abs%base).toString().padStart(decimals,'0').slice(0,places).replace(/0+$/,'');
 return (neg?'-':'')+whole.toString()+(frac?'.'+frac:'');
}
