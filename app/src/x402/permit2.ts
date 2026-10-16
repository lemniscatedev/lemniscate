import {
  encodeAbiParameters, getAddress, isAddress, isHex, keccak256, parseAbi, toBytes, type Address, type Hex,
} from "viem";

/** Canonical Permit2, same address on both chains (verified in docs/research/chain-facts.md). */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

export const WITNESS_TYPE_NAME = "LemniscatePayment";
export const WITNESS_TYPE_DEF = "LemniscatePayment(address payTo,bytes32 resource)";
/** What Permit2 expects as `witnessTypeString`: `<TypeName> witness)<defs sorted by name, TokenPermissions last here>`. */
export const WITNESS_TYPE_STRING = `${WITNESS_TYPE_NAME} witness)${WITNESS_TYPE_DEF}TokenPermissions(address token,uint256 amount)` as const;
const WITNESS_TYPEHASH = keccak256(toBytes(WITNESS_TYPE_DEF));

export const permit2Abi = parseAbi([
  "function permitWitnessTransferFrom(((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, (address to, uint256 requestedAmount) transferDetails, address owner, bytes32 witness, string witnessTypeString, bytes signature)",
  "function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)",
]);

export const permit2Types = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: WITNESS_TYPE_NAME },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  [WITNESS_TYPE_NAME]: [
    { name: "payTo", type: "address" },
    { name: "resource", type: "bytes32" },
  ],
} as const;

/** The request a payment is bound to: method, path and query. Hashed into the signed witness. */
export function resourceKey(method: string, pathAndQuery: string): string {
  return `${method.toUpperCase()} ${pathAndQuery}`;
}
export const resourceHash = (key: string): Hex => keccak256(toBytes(key));

/** Permit2's witness argument: the EIP-712 struct hash of the witness. */
export function witnessHash(payTo: Address, resource: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
    [WITNESS_TYPEHASH, payTo, resource],
  ));
}

export interface PermitFields {
  readonly token: Address;
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly spender: Address;
  readonly payTo: Address;
  readonly resource: Hex;
}

export function permitTypedData(chainId: number, fields: PermitFields, verifyingContract: Address = PERMIT2_ADDRESS) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract },
    types: permit2Types,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: {
      permitted: { token: fields.token, amount: fields.amount },
      spender: fields.spender,
      nonce: fields.nonce,
      deadline: fields.deadline,
      witness: { payTo: fields.payTo, resource: fields.resource },
    },
  };
}

// ---- wire format -----------------------------------------------------------------------------------------

export interface PaymentPayload {
  readonly x402Version: 1;
  readonly scheme: "exact";
  readonly network: string;
  readonly payload: {
    readonly signature: Hex;
    readonly owner: Address;
    readonly permit: { readonly permitted: { readonly token: Address; readonly amount: string }; readonly nonce: string; readonly deadline: string };
    readonly witness: { readonly payTo: Address; readonly resource: Hex };
  };
}

export const networkId = (chainId: number): string => `eip155:${chainId}`;

export function encodePayment(payment: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
}

const uintText = (value: unknown): bigint | null => {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed < 1n << 256n ? parsed : null;
};

export interface ParsedPayment {
  readonly network: string;
  readonly signature: Hex;
  readonly owner: Address;
  readonly token: Address;
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly payTo: Address;
  readonly resource: Hex;
}

/** Strict decode of an X-PAYMENT header; null when anything is malformed. */
export function decodePayment(header: string): ParsedPayment | null {
  if (header.length > 4_096) return null;
  try {
    const raw: any = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (raw?.x402Version !== 1 || raw.scheme !== "exact" || typeof raw.network !== "string") return null;
    const p = raw.payload;
    const amount = uintText(p?.permit?.permitted?.amount);
    const nonce = uintText(p?.permit?.nonce);
    const deadline = uintText(p?.permit?.deadline);
    if (amount === null || nonce === null || deadline === null) return null;
    const { signature, owner } = p;
    const token = p?.permit?.permitted?.token;
    const payTo = p?.witness?.payTo;
    const resource = p?.witness?.resource;
    if (!isHex(signature) || signature.length < 130 || signature.length > 1_000) return null;
    if (![owner, token, payTo].every((a) => typeof a === "string" && isAddress(a, { strict: false }))) return null;
    if (!isHex(resource) || resource.length !== 66) return null;
    return {
      network: raw.network, signature, owner: getAddress(owner), token: getAddress(token), amount, nonce, deadline,
      payTo: getAddress(payTo), resource,
    };
  } catch {
    return null;
  }
}

