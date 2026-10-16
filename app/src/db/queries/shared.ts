export function regimeName(value: unknown): "open" | "off_hours" | "paused" {
  const regime = typeof value === "string" && !/^\d+$/.test(value) ? value.toLowerCase() : Number(value);
  if (regime === 1 || regime === "off_hours") return "off_hours";
  if (regime === 2 || regime === "paused") return "paused";
  return "open";
}
