import postgres from "postgres";

export function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }
  return postgres(url, { max: 2, idle_timeout: 5, connect_timeout: 10 });
}

export function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function positional(): string[] {
  const out: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i]!.startsWith("--")) i++;
    else out.push(process.argv[i]!);
  }
  return out;
}
