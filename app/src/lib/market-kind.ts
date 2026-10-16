export type Curve = "squared" | "ratio" | "cubed" | "root" | "downside" | "unknown";

const kindCurves: Record<number, Exclude<Curve, "unknown">> = {
  0: "squared",
  1: "ratio",
  2: "cubed",
  3: "root",
  4: "downside",
};

const exponents: Record<Exclude<Curve, "unknown">, number> = {
  squared: 2,
  ratio: 1,
  cubed: 3,
  root: 0.5,
  downside: -1,
};

export function decodeKind(kind: unknown): { curve: Curve; exponent: number | null; alwaysOpen: boolean } {
  if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 0 || kind > 255) {
    return { curve: "unknown", exponent: null, alwaysOpen: false };
  }

  const base = kind & 0x7f;
  const curve = kindCurves[base] ?? "unknown";
  return {
    curve,
    exponent: curve === "unknown" ? null : exponents[curve],
    alwaysOpen: (kind & 0x80) !== 0,
  };
}

export function underlyingOf(symbol: string, curve: Curve): string {
  const suffix = curve === "cubed" ? "3" : curve === "root" ? "ROOT" : curve === "downside" ? "INV" : "";
  return suffix && symbol.toUpperCase().endsWith(suffix)
    ? symbol.slice(0, -suffix.length)
    : symbol;
}
