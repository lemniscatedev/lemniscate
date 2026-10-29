// Transaction gas limits for buys, sells, deposits and every other site transaction. No imports: tested in node.
/** Gas limit with headroom, the keeper's policy (app/src/keeper/tx.ts keeperGasLimit): the larger of estimate x 1.5 and
 * estimate + 500,000, capped at 32M, never below estimate x 1.2. The engine's out-of-gas guard reverts a buy or sell sent
 * at the bare eth_estimateGas value (the estimate is taken in an earlier block), and some wallets send exactly that.
 * Unused gas is refunded, so the headroom costs nothing. */
export function paddedGasLimit(estimate){
 const e=BigInt(estimate),floor=(e*120n+99n)/100n,padded=e+500_000n;
 let limit=(e*15_000n+9_999n)/10_000n;if(padded>limit)limit=padded;if(limit>32_000_000n)limit=32_000_000n;
 return limit>floor?limit:floor;
}
/** eth_sendTransaction params with an explicit gas limit. `estimate` returns the node's estimate; when it fails (the call
 * would revert) no limit is set and the wallet shows its own error, as before. */
export async function txParams(from,{to,data,value='0'},estimate){
 const tx={from,to,data,value:'0x'+BigInt(value).toString(16)};
 try{const e=await estimate(tx);if(e!=null)tx.gas='0x'+paddedGasLimit(e).toString(16)}catch{}
 return tx;
}
