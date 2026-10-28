// /contracts page (todo 37, L5): every contract address with an explorer link and a Sourcify link.
import {rowsFrom,stocksFrom,explorerAddress,sourcifyPage,sourcifyApi,isVerified} from '/chain/contracts-list.js?v=1';

const esc=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const get=async(url,ms=8000)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{cache:'no-store',credentials:'omit',signal:c.signal});return r.ok?await r.json():null}catch{return null}finally{clearTimeout(t)}};

export async function mountContracts(root){
 const CFG=window.LM_CONFIG||{};
 const explorer=CFG.explorerUrl||'https://robinhoodchain.blockscout.com';
 const api=String(CFG.apiBase||'').replace(/\/+$/,'');
 let source=api?await get(api+'/v1/config'):null;
 let rows=rowsFrom(source?.contracts);
 if(!rows.length){const file=await get('/contracts.json');if(file){source=file;rows=rowsFrom(file.contracts)}}
 const chainId=Number(source?.chainId||CFG.chainId||4663);
 if(!rows.length){
  root.innerHTML='<div class="lm-contracts-empty" role="status"><h2>Addresses are published at launch</h2><p>Lemniscate has not been deployed yet, so there is nothing to list. When it is, every contract address appears here with its explorer link and a Sourcify link to the verified source. Until then, treat any address you are sent as unverified.</p></div>';
  return;
 }
 const stocks=stocksFrom(source?.stocks);
 const card=r=>`<article class="lm-contract" data-contract="${esc(r.key)}"><div class="lm-contract-head"><h3>${esc(r.label)}</h3><span class="lm-contract-badge" data-badge="${esc(r.address)}">Checking Sourcify</span></div>${r.about?`<p>${esc(r.about)}</p>`:''}<code>${esc(r.address)}</code><div class="lm-contract-links"><a href="${esc(explorerAddress(explorer,r.address))}" target="_blank" rel="noopener noreferrer">Explorer</a><a href="${esc(sourcifyPage(chainId,r.address))}" target="_blank" rel="noopener noreferrer">Verified on Sourcify</a></div></article>`;
 root.innerHTML=`<div class="lm-contract-grid">${rows.map(card).join('')}</div>${stocks.length?`<h2 class="lm-contracts-sub">Stock Tokens the system reads</h2><p class="lm-contracts-note">Issued by third parties, not by Lemniscate. Listed so you can check the address you are trading against.</p><ul class="lm-contract-stocks">${stocks.map(s=>`<li><strong>${esc(s.name)}</strong> <code>${esc(s.address)}</code> <a href="${esc(explorerAddress(explorer,s.address))}" target="_blank" rel="noopener noreferrer">Explorer</a></li>`).join('')}</ul>`:''}`;
 for(const r of rows){
  get(sourcifyApi(chainId,r.address)).then(body=>{
   const el=root.querySelector(`[data-badge="${r.address}"]`);if(!el)return;
   const ok=isVerified(body);el.textContent=ok?'Verified':'Not verified yet';el.dataset.state=ok?'verified':'unverified';
  });
 }
}
