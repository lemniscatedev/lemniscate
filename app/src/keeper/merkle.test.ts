import { describe, expect, test } from "bun:test";
import { keccak256, toHex, type Hex } from "viem";
import { EMPTY_ROOT, buildLevels, hashPair, merkleProof, merkleRoot, verifyMerkleProof } from "./merkle";

const leaves = (n: number): Hex[] => Array.from({ length: n }, (_, i) => keccak256(toHex(`leaf-${i}`)));

describe("merkle", () => {
  test("empty set has the zero root; one leaf is its own root", () => {
    expect(merkleRoot([])).toBe(EMPTY_ROOT);
    const [a] = leaves(1);
    expect(merkleRoot([a!])).toBe(a!);
    expect(merkleProof([a!], a!)).toEqual([]);
  });
  test("hand-computed three-leaf tree with sorted pairs and an unpaired node carried up", () => {
    const [x, y, z] = leaves(3).sort((p, q) => (BigInt(p) < BigInt(q) ? -1 : 1)) as [Hex, Hex, Hex];
    expect(merkleRoot([z, x, y])).toBe(hashPair(hashPair(x, y), z));
    expect(hashPair(y, x)).toBe(hashPair(x, y));
  });
  test("every leaf of trees of many sizes verifies, order and duplicates do not matter", () => {
    for (const n of [2, 3, 4, 5, 7, 8, 13, 33]) {
      const set = leaves(n);
      const root = merkleRoot(set);
      expect(merkleRoot([...set].reverse().concat(set[0]!))).toBe(root);
      for (const leaf of set) {
        const proof = merkleProof(set, leaf)!;
        expect(verifyMerkleProof(leaf, proof, root)).toBe(true);
        expect(proof.length).toBeLessThanOrEqual(buildLevels(set).length - 1);
      }
    }
  });
  test("a wrong leaf, a tampered proof or another root fail", () => {
    const set = leaves(9);
    const root = merkleRoot(set);
    const proof = merkleProof(set, set[4]!)!;
    expect(verifyMerkleProof(keccak256(toHex("other")), proof, root)).toBe(false);
    expect(verifyMerkleProof(set[4]!, [...proof.slice(1), proof[0]!], root)).toBe(false);
    expect(verifyMerkleProof(set[4]!, proof, merkleRoot(leaves(8)))).toBe(false);
    expect(merkleProof(set, keccak256(toHex("absent")))).toBeUndefined();
  });
});
