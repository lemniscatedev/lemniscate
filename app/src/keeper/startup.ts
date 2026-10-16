import { keccak256, stringToHex, parseAbi, type Address } from "viem";
import type { ServiceClients } from "../chain/clients";
import type { OptionDeployment } from "../chain/deployment";

const roleAbi = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);
const KEEPER_ROLE = keccak256(stringToHex("KEEPER_ROLE"));
const GUARDIAN_ROLE = keccak256(stringToHex("GUARDIAN_ROLE"));

export interface RoleRequirement { job: string; contract: string; address: Address; role: "KEEPER_ROLE" | "GUARDIAN_ROLE" }

/** The on-chain roles each enabled job needs from the keeper key. accrue is permissionless on the engine, so it needs
 * no role; corp-actions only pokes PriceGuard (also open); receipts, reference and earnings do not send transactions. */
export function requiredRoles(enabled: ReadonlySet<string>, deployment: OptionDeployment): RoleRequirement[] {
  const needs: RoleRequirement[] = [];
  if (enabled.has("sessions") && deployment.contracts.marketHours) {
    needs.push({ job: "sessions", contract: "marketHours", address: deployment.contracts.marketHours as Address, role: "KEEPER_ROLE" });
  }
  if (enabled.has("lister")) {
    needs.push({ job: "lister", contract: "registry", address: deployment.contracts.registry as Address, role: "KEEPER_ROLE" });
  }
  if (enabled.has("risk")) {
    needs.push({ job: "risk", contract: "engine", address: deployment.contracts.engine as Address, role: "GUARDIAN_ROLE" });
  }
  return needs;
}

/** Checks the keeper account holds every role its enabled jobs need. Returns the missing ones; a role that cannot be
 * read at all (the contract has no hasRole yet) is reported as unverified, not missing. */
export async function checkRoles(
  clients: Pick<ServiceClients, "stateClient">,
  needs: readonly RoleRequirement[],
  account: Address,
): Promise<{ missing: RoleRequirement[]; unverified: RoleRequirement[] }> {
  if (!needs.length) return { missing: [], unverified: [] };
  const results = await clients.stateClient.multicall({
    allowFailure: true,
    contracts: needs.map((need) => ({
      address: need.address, abi: roleAbi, functionName: "hasRole" as const,
      args: [need.role === "KEEPER_ROLE" ? KEEPER_ROLE : GUARDIAN_ROLE, account] as const,
    })),
  });
  const missing: RoleRequirement[] = [];
  const unverified: RoleRequirement[] = [];
  results.forEach((result, index) => {
    if (result.status !== "success") unverified.push(needs[index]!);
    else if (!result.result) missing.push(needs[index]!);
  });
  return { missing, unverified };
}
