import { concat, encodePacked, getContractAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { kernelInitData } from "./kernel";
import { kernelSalt } from "./userop";

/** Kernel v3.3 implementation behind the v3.3 factory on Robinhood Chain (factory.implementation(), checked with cast). */
export const KERNEL_V33_IMPLEMENTATION = "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28";

export interface KernelDeployment {
  readonly factory: Address;
  readonly validator: Address;
  readonly implementation: Address;
}

// ERC-1967 proxy creation code (Solady LibClone, the clone KernelFactory deploys), split around the implementation address.
const PROXY_PREFIX = "0x603d3d8160223d3973" as Hex;
const PROXY_SUFFIX = ("0x6009" + "5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3") as Hex;

/**
 * The counterfactual Kernel account of an EOA owner, computed locally (no RPC): KernelFactory.getAddress(data, salt) is the
 * CREATE2 address of an ERC-1967 proxy of the Kernel implementation with salt keccak256(data ++ salt).
 * Verified against the live v3.3 factory (see the test).
 */
export function predictKernelAddressOffline(deployment: KernelDeployment, owner: Address, accountIndex = 0): Address {
  if (!isAddress(owner, { strict: false })) throw new Error("owner must be an EVM address");
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > 0xffff_ffff) throw new Error("account index out of range");
  const data = kernelInitData(deployment.validator, owner);
  const salt = keccak256(encodePacked(["bytes", "bytes32"], [data, kernelSalt(accountIndex)]));
  const bytecodeHash = keccak256(concat([PROXY_PREFIX, deployment.implementation, PROXY_SUFFIX]));
  return getContractAddress({ opcode: "CREATE2", from: deployment.factory, salt, bytecodeHash });
}
