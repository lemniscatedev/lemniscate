// One place for every copy correction made inside generated native modules and CMS content (todo 18, R12/R13/R14 and
// the AAPL launch-name change). Idempotent: a replacement whose source text is already gone does nothing.
// Run: node scripts/apply-copy-fixes.mjs && npm run build
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {rewrite} from './cms-codec.mjs';

const runtime='dist/runtime';
const files=await readdir(runtime);
const mod=prefix=>{const f=files.find(x=>x.startsWith(prefix));if(!f)throw new Error('No runtime module '+prefix);return path.join(runtime,f)};

const moduleFixes=[
 // Home worked example and FAQ: no references to internal documents.
 [mod('9lNd'),[
  ['In the overview’s example, $100 NVDA at 50% volatility has an option price of about $2.45.','For example, with NVDA at $100 and 50% volatility, the model price is about $2.45.'],
  ['The overview estimates a holding cost near $0.02 per day at that price.','At that price the model holding cost is near $0.02 per day.'],
 ]],
 [mod('JWJx'),[['The overview uses a strike 10% below current price.','The default strike is 10% below the current price.']]],
 // Market detail template: agency statistics replaced by product facts.
 [mod('7MMn'),[
  ['PgJY3xDKH:e??a.PgJY3xDKH??`250k+`,QzLR3njrM:r??a.QzLR3njrM??`Revenue in first 30 days`','PgJY3xDKH:e??a.PgJY3xDKH??`0`,QzLR3njrM:r??a.QzLR3njrM??`Expiry dates`'],
  ['PgJY3xDKH:`250k+`,QzLR3njrM:`Revenue in first 30 days`','PgJY3xDKH:`0`,QzLR3njrM:`Expiry dates`'],
  ['PgJY3xDKH:`1.8M+ `,QzLR3njrM:`Reach through content`','PgJY3xDKH:`2`,QzLR3njrM:`Pricing speeds: Daily and Weekly`'],
  ['PgJY3xDKH:`32%`,QzLR3njrM:`Email conversion`','PgJY3xDKH:`3 bps`,QzLR3njrM:`Notional fee on each trade`'],
  ['PgJY3xDKH:`4.9-star`,QzLR3njrM:`Average rating`','PgJY3xDKH:`USDG`,QzLR3njrM:`Settlement and holding costs`'],
  ['children:`250k+`','children:`0`'],['"data-framer-name":`250k+`','"data-framer-name":`Stat value`'],
  ['children:`Revenue in first 30 days`','children:`Expiry dates`'],['"data-framer-name":`Revenue in first 30 days`','"data-framer-name":`Stat label`'],
  ['`Work Period`','`Pricing speed`'],
  ['PgJY3xDKH:{defaultValue:`250k+`','PgJY3xDKH:{defaultValue:`0`'],
 ]],
 [mod('YozOWmvsl'),[['title:`Work Period`','title:`Pricing speed`']]],
 // Shared sections: dormant template paragraphs and the launch names.
 [mod('yMm1'),[
  ['NVDA • TSLA • SPY • QQQ • HOOD','NVDA • TSLA • SPY • QQQ • AAPL'],
  ['Great UX writing doesn\'t happen in isolation. We partner closely with designers, product managers, and developers from concept to launch, ensuring every word is tested, refined, and aligned with the broader user journey.','Buyers have no margin debt and no liquidation. The most a buyer can lose is the amount paid, and an option can still fall to zero.'],
  ['children:`Empathy`','children:`Wallet native`'],
  ['children:`Clarity`','children:`Clear daily cost`'],
  ['We start every project by stepping into the user’s world—understanding their goals, frustrations, and context. This human-first approach ensures our copy feels supportive, not robotic. We write for real people, not metrics, creating digital experiences that respect users’ time, emotions, and needs.','Your option is a token in your wallet. You can hold it, transfer it, or sell its remaining units back at the quoted bid.'],
  ['In a noisy digital landscape, we believe every word must earn its place. We strip away jargon, ambiguity, and fluff to deliver copy that users can understand at a glance and act on with confidence. Clarity isn’t just about simplicity—it’s about respecting your audience enough to say exactly what you mean.','Every quote shows the premium, the holding cost per day in dollars, and the breakeven before you buy.'],
 ]],
 [mod('eGRC'),[['Why Most Marketing Campaigns Fail (And How to Fix Them)','Everlasting options, explained']]],
 [mod('LFgE'),[['F3s3CdhgA:l??f.F3s3CdhgA??`5000`','F3s3CdhgA:l??f.F3s3CdhgA??`2.45`'],['children:`5000`','children:`2.45`'],['`$ 5000 /yearly`','`$ 2.45 /option`']]],
 [mod('COpg'),[['We aim to deliver strong results, but we do not guarantee specific outcomes.','Options can lose their entire purchase amount. No outcome is guaranteed.']]],
 [mod('fLhV'),[['We may share information with trusted tools or partners required to deliver services.','The website does not sell personal information. Hosting may process access requests to deliver the pages.']]],
 [mod('sZuE'),[
  ['UI/UX Designer','Agent policy'],['Alisha Patel','Policy budget'],['Head of Paid Media','Set by you'],
  [' $20,000-$50,000',' Budget in USDG'],['Last Date: 19 April, 2026','Expiry you choose'],['Career at Lemniscate','Agent access'],['displayName=`Career Card`','displayName=`Policy Card`'],
  ['Open Positions','Policy controls'],['Find a role where your skills can create real impact.','Choose the names, budget and expiry an agent may use.'],
  ['Hear From Our Employees','How a policy works'],['See what our users are truly accomplishing with honest, and project based reviews','Every agent action stays inside a budget, an expiry and allowed names.'],
  ['Build Work That Actually Matters','A policy. A budget. Your permission.'],['Join a team focused on strategy, creativity, and real impact—not just deliverables.','Let an agent act only within the boundaries you set.'],
  ['From day one, I could feel the difference. The leadership team delivered a clear vision that immediately focused all of us. The growth in our client engagement metrics was noticeable within my first 60 days, ','A policy sets the budget, the allowed names and the expiry. '],
  ['From day one, I could feel the difference. The leadership team delivered a clear vision that immediately focused all of us. The growth in our client engagement metrics was noticeable within my first 60 days,','A policy sets the budget, the allowed names and the expiry.'],
  ['What drew me here was the focus on data driven work. What made me stay is the culture. The leadership team actually invests in the tools and training we need to do our best work. ','You can revoke a policy at any time from the agent desk. '],
  ['Apply Now','Open agent desk'],['children:`On site`','children:`Revocable`'],['children:`Full Time`','children:`Read or execute`'],['children:`Location:`','children:`Scope:`'],
 ]],
 // Native router: no hosting-wrapper canonical host (R14). The router treats an empty value as "no canonical".
 [mod('script_main'),[['siteCanonicalURL:`https://lemniscate-options.sleroy1312.chatgpt.site`','siteCanonicalURL:``']]],
];

const cmsFixes=[
 ['dist/assets/content/D4rvUy7SA.framercms',mod('D4rvUy7SA'),[
  ['When a stock session is closed, the design uses the last close','When a stock session is closed, the exit uses the last close'],
  [' per day under the design.',' per day.'],
  ['The specified trading spread is 1.5–4% of option price, with a minimum of $0.01, plus 3 basis points of underlying notional. A quote must show those amounts before an order is reviewed.','The trading spread is 1.5–4% of the option price, wider for strikes further from the current price, with a minimum of $0.01 per unit. It is 1.5 times wider in extended hours and 3 times wider while the market is closed. A fee of 3 basis points of the underlying notional is added. Every quote shows these amounts before you review an order.'],
  ['The overview uses a strike 10% below current price.','The default strike is 10% below the current price.'],
  ['The specification makes split-adjusted raw-token value continuous. Dividend multiplier changes enter the underlying value directly. Feed behavior and token compatibility need verification for deployment.','Split-adjusted raw-token value stays continuous. Dividend multiplier changes enter the underlying value directly. New buys pause around a split until the new multiplier is in place; sells stay open.'],
 ]],
 ['dist/assets/content/YozOWmvsl.framercms',mod('YozOWmvsl'),[
  ['The overview selects a strike 10% below current value.','The default strike is 10% below the current price.'],
  ['within specified caps.','within published caps.'],
 ]],
];

let total=0;
for(const [file,pairs] of moduleFixes){
 let text=await readFile(file,'utf8');const before=text;
 for(const [from,to] of pairs){if(from.includes('`')===false&&to.includes('`'))throw new Error('Unbalanced template literal in '+to);text=text.split(from).join(to)}
 if(text!==before){await writeFile(file,text);total++;console.log('updated',file)}
}
for(const [cms,module,pairs] of cmsFixes){const n=await rewrite(cms,module,pairs);if(n)console.log('updated',cms,n,'strings')}
console.log(`copy fixes applied (${total} modules changed)`);
