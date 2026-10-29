import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { meets, unlockText, holderView, lockedPerkHtml, sessionMessage, readSession } from '../dist/chain/holder.js';

test('levels: whale has holder perks, none has neither', () => {
  assert.equal(meets('whale', 'holder'), true);
  assert.equal(meets('holder', 'whale'), false);
  assert.equal(meets('none', 'holder'), false);
  assert.equal(meets(undefined, 'holder'), false);
});

test('locked text and card say how much to hold, never price words', () => {
  assert.equal(unlockText('holder'), 'Hold 100,000 $LMNS to unlock');
  assert.equal(unlockText('whale', [{ level: 'whale', minimumLmns: 1000000 }]), 'Hold 1,000,000 $LMNS to unlock');
  const html = lockedPerkHtml({ name: 'Alerts <b>', level: 'holder' });
  assert.match(html, /Hold 100,000 \$LMNS to unlock/);
  assert.match(html, /Alerts &lt;b&gt;/);
  assert.match(html, /stay open to everyone/);
  assert.doesNotMatch(html, /apy|yield|return|invest/i);
});

test('view: no token yet, checking, and a real level', () => {
  assert.equal(holderView(null).locked('holder'), true);
  assert.match(holderView({ status: 'awaiting_token', tier: 'none' }).line, /when the token launches/);
  assert.equal(holderView({ status: 'checking', tier: 'none' }).locked('holder'), true);
  const v = holderView({ status: 'ok', tier: 'holder', balanceLmns: '150000' });
  assert.equal(v.locked('holder'), false);
  assert.equal(v.locked('whale'), true);
});

test('session message matches the API layout and payload hash of {}', async () => {
  const m = await sessionMessage('0xab', { nonce: 'n'.repeat(24), issued: 'I', expires: 'E' });
  const hash = createHash('sha256').update('{}').digest('hex');
  assert.equal(m, ['Lemniscate wants you to sign this message.', '', 'Action: holder.session', 'Address: 0xab', `Payload: ${hash}`, `Nonce: ${'n'.repeat(24)}`, 'Issued: I', 'Expires: E', 'Chain: 4663'].join('\n'));
});

test('a stored session is used only for its own wallet and before it expires', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  storage.setItem('lemniscate.holder.session.v1', JSON.stringify({ address: '0xab', token: 't', expires: new Date(Date.now() + 3600e3).toISOString() }));
  assert.equal(readSession('0xAB', storage), 't');
  assert.equal(readSession('0xcd', storage), null);
  storage.setItem('lemniscate.holder.session.v1', JSON.stringify({ address: '0xab', token: 't', expires: new Date(Date.now() + 1000).toISOString() }));
  assert.equal(readSession('0xab', storage), null);
});
