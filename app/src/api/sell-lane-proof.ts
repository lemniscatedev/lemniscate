import { recoverMessageAddress, type Address, type Hex } from "viem";
import { predictKernelAddressOffline, type KernelDeployment } from "../aa/counterfactual";

/**
 * R3-06 (H1): proof that the caller controls a Kernel account, checked with no chain read. The reserved read lane is for a
 * holder's own sells; Postgres can say an account holds a position but not who is asking, and strangers could otherwise
 * name real holders' accounts to drain the lane. The owner signs this message (EIP-191 personal_sign) once for up to 15
 * minutes; the API recovers the signer and checks that the standard Kernel account of that signer at `accountIndex` is the
 * account (the CREATE2 address, computed offline).
 */
export const SELL_LANE_PROOF_MAX_SECONDS = 900;

export function sellLaneProofMessage(account: Address, chainId: number, expires: number): string {
  return [
    "Lemniscate wants you to sign this message.",
    "",
    "Action: sell-lane",
    `Account: ${account.toLowerCase()}`,
    `Expires: ${expires}`,
    `Chain: ${chainId}`,
  ].join("\n");
}

export interface SellLaneProof { readonly expires: number; readonly signature: Hex }

export async function verifySellLaneProof(input: {
  readonly proof: SellLaneProof | undefined;
  readonly account: Address;
  readonly accountIndex: number;
  readonly chainId: number;
  readonly deployment: KernelDeployment;
  readonly nowSeconds: number;
}): Promise<boolean> {
  const { proof } = input;
  if (!proof) return false;
  if (!Number.isInteger(proof.expires) || proof.expires <= input.nowSeconds || proof.expires > input.nowSeconds + SELL_LANE_PROOF_MAX_SECONDS) return false;
  try {
    const signer = await recoverMessageAddress({ message: sellLaneProofMessage(input.account, input.chainId, proof.expires), signature: proof.signature });
    return predictKernelAddressOffline(input.deployment, signer, input.accountIndex).toLowerCase() === input.account.toLowerCase();
  } catch {
    return false;
  }
}
