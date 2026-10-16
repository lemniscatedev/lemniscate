import {
  erc20Abi,
  getContract,
  type Abi,
  type Address,
  type Client,
} from "viem";

// Accept an ABI argument so callers can use the generated modules in src/abi.
export function getEngine<const TAbi extends Abi>(client: Client, address: Address, abi: TAbi) {
  return getContract({ client, address, abi });
}

export function getVault<const TAbi extends Abi>(client: Client, address: Address, abi: TAbi) {
  return getContract({ client, address, abi });
}

export function getLens<const TAbi extends Abi>(client: Client, address: Address, abi: TAbi) {
  return getContract({ client, address, abi });
}

export function getMarketHours<const TAbi extends Abi>(
  client: Client,
  address: Address,
  abi: TAbi,
) {
  return getContract({ client, address, abi });
}

export function getOptionToken<const TAbi extends Abi>(
  client: Client,
  address: Address,
  abi: TAbi,
) {
  return getContract({ client, address, abi });
}

export function getErc20(client: Client, address: Address) {
  return getContract({ client, address, abi: erc20Abi });
}
