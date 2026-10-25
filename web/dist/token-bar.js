(() => {
// Shows the token's contract address once dist/launch.json has one. Until then nothing is shown.
// Launch day: put the address in launch.json (and optionally buyUrl, https only) and publish. No other change needed.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EXPLORER = 'https://robinhoodchain.blockscout.com/token/';
const HIDDEN_KEY = 'lemniscate-token-bar-hidden';

function link(text, href, cls) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = text;
  if (cls) a.className = cls;
  return a;
}

function hiddenByVisitor() {
  try { return sessionStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
}

function mountTokenBar() {
  if (document.getElementById('token-bar') || hiddenByVisitor()) return;
  fetch('/launch.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      const address = cfg && typeof cfg.tokenAddress === 'string' ? cfg.tokenAddress.trim() : '';
      if (!ADDRESS.test(address) || document.getElementById('token-bar')) return;
      if (!document.getElementById('token-bar-css')) {
        const css = document.createElement('link');
        css.id = 'token-bar-css';
        css.rel = 'stylesheet';
        css.href = '/token-bar.css?v=1';
        document.head.append(css);
      }
      const symbol = typeof cfg.tokenSymbol === 'string' && cfg.tokenSymbol ? cfg.tokenSymbol : 'Token';
      const bar = document.createElement('div');
      bar.id = 'token-bar';
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', `${symbol} contract address`);
      const label = document.createElement('span');
      const sym = document.createElement('span');
      sym.className = 'tb-sym';
      sym.textContent = `${symbol} `;
      label.append(sym, 'CA:');
      const code = document.createElement('code');
      code.title = address;
      const full = document.createElement('span');
      full.className = 'tb-full';
      full.textContent = address;
      const short = document.createElement('span');
      short.className = 'tb-short';
      short.textContent = `${address.slice(0, 6)}…${address.slice(-4)}`;
      code.append(full, short);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.setAttribute('aria-label', `Copy the ${symbol} contract address`);
      copy.addEventListener('click', () => {
        navigator.clipboard?.writeText(address).then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        }, () => {});
      });
      bar.append(label, code, copy, link('Explorer', EXPLORER + address, 'tb-explorer'));
      if (typeof cfg.buyUrl === 'string' && /^https:\/\/[^\s"'<>]+$/.test(cfg.buyUrl.trim())) bar.append(link('Buy', cfg.buyUrl.trim()));
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tb-close';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Hide the contract address bar');
      close.addEventListener('click', () => {
        try { sessionStorage.setItem(HIDDEN_KEY, '1'); } catch { /* private mode: hide for this page only */ }
        bar.remove();
      });
      bar.append(close);
      document.body.append(bar);
    })
    .catch(() => {});
}

if (document.readyState === 'complete') mountTokenBar();
else addEventListener('load', mountTokenBar, { once: true });
})();
