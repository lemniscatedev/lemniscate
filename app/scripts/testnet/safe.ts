// The testnet owner is a 2-of-3 Safe (SafeL2 1.4.1). Every admin call of the testnet run goes through it, exactly as on
// mainnet (minus the 48h timelock): two owner keystores sign the SafeTx hash, the first owner submits execTransaction.
//
//   bun scripts/testnet/safe.ts <to> <calldata>         one admin call through the owner Safe (prints the tx hash)
import { concat, encodeFunctionData, getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { accountOf, loadConfig, publicClient, walletFor, type TestnetRole } from "./lib";

export const safeAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
]);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Signatures of `signers` over `safeTxHash`, ordered by signer address as the Safe requires (raw ECDSA, v 27/28). */
export async function signSafeTx(safeTxHash: Hex, signers: TestnetRole[]): Promise<Hex> {
  const sigs = await Promise.all(signers.map(async (r) => ({ who: accountOf(r).address.toLowerCase(), sig: await accountOf(r).sign({ hash: safeTxHash }) })));
  sigs.sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));
  return concat(sigs.map((s) => s.sig));
}

/** Builds, signs (owner-1 and owner-2) and submits (owner-1) one CALL through the owner Safe. Throws on ExecutionFailure. */
export async function safeExec(to: Address, data: Hex, opts: { pub?: PublicClient; signers?: TestnetRole[]; submitter?: TestnetRole; gas?: bigint } = {}) {
  const pub = opts.pub ?? publicClient();
  const safe = getAddress(loadConfig().roles.owner);
  const nonce = await pub.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  const args = [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO] as const;
  const safeTxHash = await pub.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: [...args, nonce] });
  const signatures = await signSafeTx(safeTxHash, opts.signers ?? ["owner-1", "owner-2"]);
  const wallet = walletFor(opts.submitter ?? "owner-1");
  const callData = encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [...args, signatures] });
  const gas = opts.gas ?? ((await pub.estimateGas({ account: wallet.account!, to: safe, data: callData })) * 13n) / 10n + 30_000n;
  const hash = await wallet.sendTransaction({ account: wallet.account!, chain: wallet.chain, to: safe, data: callData, gas });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const failed = receipt.logs.some((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0] === "0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23"); // not-a-key (ExecutionFailure topic)
  if (receipt.status !== "success" || failed) throw new Error(`Safe execTransaction ${hash} failed (inner call reverted)`);
  return { hash, receipt, safeTxHash, safe };
}

if (import.meta.main) {
  const [to, data] = process.argv.slice(2);
  if (!to || !data) throw new Error("usage: bun scripts/testnet/safe.ts <to> <calldata>");
  const r = await safeExec(getAddress(to), data as Hex);
  console.log(`safe: ${r.safe} executed ${r.safeTxHash} in ${r.hash} (gas ${r.receipt.gasUsed})`);
}
