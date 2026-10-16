export function utcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function secondsBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 1000);
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
