import { getAddress, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import {
  PERMIT2_ADDRESS, WITNESS_TYPE_STRING, encodePayment, networkId, permitTypedData, resourceHash, resourceKey, type PaymentPayload,
} from "./permit2";

export class PaymentRefused extends Error {}

/** Sign the first acceptable requirement of a 402 body. Refuses anything that would sign for a contract other than
 * the canonical Permit2, a different witness layout, another network, or more than `maxAmount` raw USDG. */
export async function signPayment(body: any, account: LocalAccount, limits: { chainId: number; maxAmount: bigint }): Promise<string> {
  const req = Array.isArray(body?.accepts) ? body.accepts.find((a: any) => a?.scheme === "exact") : undefined;
  if (!req) throw new PaymentRefused("no supported payment option");
  if (req.network !== networkId(limits.chainId)) throw new PaymentRefused("payment option is for another network");
  const extra = req.extra ?? {};
  if (extra.assetTransferMethod !== "permit2" || getAddress(extra.permit2) !== PERMIT2_ADDRESS) throw new PaymentRefused("not the canonical Permit2");
  if (extra.witnessTypeString !== WITNESS_TYPE_STRING) throw new PaymentRefused("unexpected witness layout");
  // The signed witness must commit to the URL we actually asked for, not to something the server picked.
  if (extra.witness?.resource !== resourceHash(resourceKey("GET", String(req.resource)))) throw new PaymentRefused("witness does not match the resource");
  const amount = BigInt(req.maxAmountRequired);
  if (amount > limits.maxAmount) throw new PaymentRefused("price exceeds the per-call limit");
  const fields = {
    token: getAddress(req.asset) as Address, amount, nonce: BigInt(extra.nonce), deadline: BigInt(extra.deadline),
    spender: getAddress(extra.spender) as Address, payTo: getAddress(req.payTo) as Address, resource: extra.witness.resource as Hex,
  };
  const signature = await account.signTypedData(permitTypedData(limits.chainId, fields));
  const payment: PaymentPayload = {
    x402Version: 1, scheme: "exact", network: req.network, payload: {
      signature, owner: account.address,
      permit: { permitted: { token: fields.token, amount: amount.toString() }, nonce: fields.nonce.toString(), deadline: fields.deadline.toString() },
      witness: { payTo: fields.payTo, resource: fields.resource },
    },
  };
  return encodePayment(payment);
}

/** fetch that answers one 402 by signing and retrying once. */
export function createPayingFetch(
  base: typeof fetch, account: LocalAccount, limits: { chainId: number; maxAmount: bigint },
): typeof fetch {
  return (async (input: any, init?: any) => {
    const first = await base(input, init);
    if (first.status !== 402) return first;
    const body = await first.json().catch(() => null);
    const header = await signPayment(body, account, limits);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("X-PAYMENT", header);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}
