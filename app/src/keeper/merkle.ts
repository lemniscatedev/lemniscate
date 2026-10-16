import { concatHex, keccak256, type Hex } from "viem";

/** Merkle trees for the hourly receipts (todo 13 R6).
 *
 * Hashing: keccak256. Parent = keccak256(min(a, b) ++ max(a, b)) over the two 32-byte children compared as numbers
 * ("sorted pairs", the OpenZeppelin MerkleProof convention), so a proof is only the list of sibling hashes and needs no
 * left/right flags.
 * Layout: leaves are sorted ascending and de-duplicated; each level pairs neighbours (0,1), (2,3), ...; an unpaired
 * last node moves up to the next level unchanged (it is not hashed with itself). An empty set has the zero root. */
export const EMPTY_ROOT: Hex = `0x${"00".repeat(32)}`;

const compare = (a: Hex, b: Hex): number => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

export function hashPair(a: Hex, b: Hex): Hex {
  return keccak256(compare(a, b) <= 0 ? concatHex([a, b]) : concatHex([b, a]));
}

export function sortedUnique(leaves: readonly Hex[]): Hex[] {
  const unique = [...new Set(leaves.map((leaf) => leaf.toLowerCase() as Hex))];
  return unique.sort(compare);
}

/** Every level of the tree, leaves first, root level (one node) last. */
export function buildLevels(leaves: readonly Hex[]): Hex[][] {
  const bottom = sortedUnique(leaves);
  if (!bottom.length) return [];
  const levels: Hex[][] = [bottom];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!;
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
    levels.push(next);
  }
  return levels;
}

export function merkleRoot(leaves: readonly Hex[]): Hex {
  const levels = buildLevels(leaves);
  return levels.length ? levels.at(-1)![0]! : EMPTY_ROOT;
}

/** Sibling hashes from the leaf up to the root; undefined when the leaf is not in the set. */
export function merkleProof(leaves: readonly Hex[], leaf: Hex): Hex[] | undefined {
  const levels = buildLevels(leaves);
  if (!levels.length) return undefined;
  let index = levels[0]!.indexOf(leaf.toLowerCase() as Hex);
  if (index < 0) return undefined;
  const proof: Hex[] = [];
  for (let depth = 0; depth < levels.length - 1; depth++) {
    const level = levels[depth]!;
    const sibling = index % 2 === 0 ? index + 1 : index - 1;
    if (sibling < level.length) proof.push(level[sibling]!);
    index = Math.floor(index / 2);
  }
  return proof;
}

export function verifyMerkleProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  let hash = leaf.toLowerCase() as Hex;
  for (const sibling of proof) hash = hashPair(hash, sibling);
  return hash.toLowerCase() === root.toLowerCase();
}
