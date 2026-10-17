import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi, type Abi } from "viem";

/** One entry of a Solidity ABI JSON. */
export interface AbiParam {
  readonly name?: string;
  readonly type: string;
  readonly components?: readonly AbiParam[];
  readonly indexed?: boolean;
  readonly internalType?: string;
}
export interface AbiEntry {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly AbiParam[];
  readonly outputs?: readonly AbiParam[];
  readonly stateMutability?: string;
  readonly anonymous?: boolean;
}

export interface AbiTarget {
  /** File written under src/abi, without extension. */
  readonly file: string;
  readonly exportName: string;
  /** Implementation contract names to try, in order. Used only when its ABI contains every entry of the interface. */
  readonly implementations: readonly string[];
  /** Frozen interface contract. Its ABI is the floor: the generated ABI always contains all of it. */
  readonly iface: string;
  /** Used only when there is no artifact for the interface (an interface that has not landed yet). */
  readonly fallback?: readonly string[];
  /** Entries services rely on that the frozen interface does not declare yet (human readable). Added only when the
   * chosen ABI has no entry of the same type and name. */
  readonly supplement?: readonly string[];
}

function canonicalType(param: AbiParam): string {
  if (!param.type.startsWith("tuple")) return param.type;
  const inner = (param.components ?? []).map(canonicalType).join(",");
  return `(${inner})${param.type.slice("tuple".length)}`;
}

/** `event:Bought(bytes32,address,...)`: stable identity of an ABI entry regardless of parameter names. */
export function entrySignature(entry: AbiEntry): string {
  const inputs = (entry.inputs ?? []).map(canonicalType).join(",");
  return `${entry.type}:${entry.name ?? ""}(${inputs})`;
}

const TRACKED = new Set(["function", "event", "error"]);

/** True when `impl` declares every function, event and error of `iface` with identical signatures. */
export function conforms(impl: readonly AbiEntry[], iface: readonly AbiEntry[]): boolean {
  const have = new Set(impl.filter((entry) => TRACKED.has(entry.type)).map(entrySignature));
  return iface.filter((entry) => TRACKED.has(entry.type)).every((entry) => have.has(entrySignature(entry)));
}

export function missingFrom(impl: readonly AbiEntry[], iface: readonly AbiEntry[]): string[] {
  const have = new Set(impl.filter((entry) => TRACKED.has(entry.type)).map(entrySignature));
  return iface.filter((entry) => TRACKED.has(entry.type)).map(entrySignature).filter((signature) => !have.has(signature));
}

/** Foundry artifact for a contract name: out/<Name>.sol/<Name>.json (returns the abi array). */
export function readArtifactAbi(outDir: string, contract: string): AbiEntry[] | undefined {
  const path = join(outDir, `${contract}.sol`, `${contract}.json`);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { abi?: AbiEntry[] };
  return Array.isArray(parsed.abi) ? parsed.abi : undefined;
}

export interface ResolvedAbi {
  readonly abi: readonly AbiEntry[];
  /** Human readable provenance, written into the file header. */
  readonly source: string;
}

export function resolveAbi(outDir: string, target: AbiTarget): ResolvedAbi {
  const iface = readArtifactAbi(outDir, target.iface);
  let chosen: AbiEntry[] | undefined;
  let source = "";
  if (iface) {
    chosen = [...iface];
    source = `interface ${target.iface}`;
    for (const name of target.implementations) {
      const impl = readArtifactAbi(outDir, name);
      if (impl && conforms(impl, iface)) {
        chosen = [...impl];
        source = `contract ${name} (conforms to ${target.iface})`;
        break;
      }
    }
  } else if (target.fallback) {
    chosen = parseAbi(target.fallback as string[]) as unknown as AbiEntry[];
    source = `declared fallback (no ${target.iface} artifact yet)`;
  }
  if (!chosen) throw new Error(`No ABI source for ${target.file}: missing artifact ${target.iface} and no fallback`);

  const supplemented: string[] = [];
  if (target.supplement && target.supplement.length > 0) {
    const have = new Set(chosen.filter((entry) => TRACKED.has(entry.type)).map((entry) => `${entry.type}:${entry.name}`));
    for (const entry of parseAbi(target.supplement as string[]) as unknown as AbiEntry[]) {
      const key = `${entry.type}:${entry.name}`;
      if (have.has(key)) continue;
      chosen.push(entry);
      have.add(key);
      supplemented.push(`${entry.type} ${entry.name}`);
    }
  }
  if (supplemented.length > 0) source += ` + supplement [${supplemented.join(", ")}]`;
  return { abi: chosen, source };
}

/** The generated TypeScript module text. Deterministic for a given ABI. */
export function renderModule(target: AbiTarget, resolved: ResolvedAbi): string {
  const body = JSON.stringify(resolved.abi, null, 2);
  return [
    "// AUTO-GENERATED by scripts/sync-abi.ts. Do not edit; run `bun run scripts/sync-abi.ts` (CI runs it with --check).",
    `// Source: ${resolved.source}`,
    `export const ${target.exportName} = ${body} as const;`,
    "",
  ].join("\n");
}

/** The frozen interfaces plus the extra entries services need. Edit here when an interface grows. */
export const ABI_TARGETS: readonly AbiTarget[] = [
  {
    file: "OptionEngine",
    exportName: "OptionEngineAbi",
    implementations: ["LemniscateEngine"],
    iface: "IOptionEngine",
    supplement: [
      // The HALTED-sell queue (design decision 3). 07 adds these; if it names them differently, adjust here and in
      // src/indexer/handlers/queue.ts.
      "event SellQueued(uint256 indexed ticket, bytes32 indexed id, address indexed seller, address recipient, uint128 tokens, uint64 queuedAt)",
      "event QueuedSellFilled(uint256 indexed ticket, address indexed filler, uint256 usdgOut)",
      "event QueuedSellCancelled(uint256 indexed ticket)",
      "function fillQueued(uint256 ticket)",
      // Emitted from the delegatecalled EngineOpsLib (review F07/F08/F21/F24, decisions 31-32): library events are not
      // in the engine's own ABI, but the engine address emits them.
      "event SeriesRetired(bytes32 indexed id)",
      "event StockSettled(address indexed stock, uint256 s)",
      "error NotSettleable(address stock)",
    ],
  },
  {
    file: "Pool",
    exportName: "PoolAbi",
    implementations: ["WriterPool"],
    iface: "IPool",
    supplement: [
      "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
      "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
      "event Transfer(address indexed from, address indexed to, uint256 value)",
      "function totalSupply() view returns (uint256)",
      "function decimals() view returns (uint8)",
    ],
  },
  { file: "SeriesRegistry", exportName: "SeriesRegistryAbi", implementations: ["SeriesRegistry"], iface: "ISeriesRegistry" },
  { file: "PriceGuard", exportName: "PriceGuardAbi", implementations: ["PriceGuard"], iface: "IPriceGuard" },
  { file: "VolOracle", exportName: "VolOracleAbi", implementations: ["VolOracle"], iface: "IVolOracle" },
  {
    file: "AgentRouter",
    exportName: "AgentRouterAbi",
    implementations: ["AgentRouter"],
    iface: "IAgentRouter",
  },
  { file: "OptionToken", exportName: "OptionTokenAbi", implementations: ["OptionToken"], iface: "IOptionToken" },
  // Keeper-pushed sessions with a kind per session (setSessionsWithKinds, kindAt), todo 04.
  { file: "MarketHours", exportName: "MarketHoursAbi", implementations: ["MarketHours"], iface: "IMarketHours" },
];

export function generateAll(outDir: string, targets: readonly AbiTarget[] = ABI_TARGETS): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const target of targets) files.set(`${target.file}.ts`, renderModule(target, resolveAbi(outDir, target)));
  return files;
}

export type { Abi };
