import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paddedGasLimit, txParams } from '../dist/chain/gas.js';

test('the padded limit is well above the bare estimate (the buy that reverted at 1,830,365)', () => {
  assert.equal(paddedGasLimit(1_830_365n), 2_745_548n);   // x1.5 beats +500k
  assert.equal(paddedGasLimit(100_000n), 600_000n);        // +500k beats x1.5 for small calls
  assert.equal(paddedGasLimit(40_000_000n), 48_000_000n);  // above the cap: still x1.2, never the bare estimate
  assert.ok(paddedGasLimit(1_830_365n) > 1_830_365n * 13n / 10n);
});

test('a buy or sell is sent with an explicit gas limit, never the raw estimate', async () => {
  const tx = await txParams('0xab', { to: '0xcd', data: '0x01', value: '0' }, async () => 1_830_365n);
  assert.equal(BigInt(tx.gas), 2_745_548n);
  assert.equal(tx.from, '0xab');
});

test('an estimate that fails (the call would revert) leaves the limit to the wallet', async () => {
  const tx = await txParams('0xab', { to: '0xcd', data: '0x01' }, async () => { throw new Error('execution reverted'); });
  assert.equal(tx.gas, undefined);
});
