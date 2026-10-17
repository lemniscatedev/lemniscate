import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** PRIV-5: each service runs as its own Unix user, with its own state dir and only its own keystore. */
const DIR = join(import.meta.dir, "..", "scripts", "server");
const SERVICES = ["api", "indexer", "keeper", "hedger", "vol-engine", "mcp"] as const;
const unit = (name: string) => readFileSync(join(DIR, "systemd", `lemniscate-${name}.service`), "utf8");
const setting = (text: string, key: string) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);

/** key_owner() in provision.sh: keystore role -> service. */
function keyOwners(): Record<string, string> {
  const provision = readFileSync(join(DIR, "provision.sh"), "utf8");
  const body = /key_owner\(\) \{\n  case "\$1" in\n([\s\S]*?)  esac/.exec(provision)![1]!;
  const owners: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const match = /^\s*([a-z0-9| -]+)\) echo ([a-z-]+) ;;/.exec(line);
    if (!match) continue;
    for (const role of match[1]!.split("|").map((r) => r.trim())) owners[role] = match[2]!;
  }
  return owners;
}

describe("systemd units", () => {
  test("every service has its own user, group, home and writable dir", () => {
    const users = new Set<string>();
    for (const name of SERVICES) {
      const text = unit(name);
      expect(setting(text, "User")).toEqual([`lem-${name}`]);
      expect(setting(text, "Group")).toEqual([`lem-${name}`]);
      expect(setting(text, "Environment").filter((v) => v.startsWith("HOME="))).toEqual([`HOME=/var/lib/lemniscate/${name}`]);
      expect(setting(text, "ReadWritePaths")).toEqual([`/var/lib/lemniscate/${name}`]);
      expect(setting(text, "EnvironmentFile")).toContain(`-/etc/lemniscate/${name}.env`);
      expect(setting(text, "NoNewPrivileges")).toEqual(["true"]);
      users.add(setting(text, "User")[0]!);
    }
    expect(users.size).toBe(SERVICES.length);
  });

  test("a unit points only at keystores that provision.sh gives to that service", () => {
    const owners = keyOwners();
    expect(owners.keeper).toBe("keeper");
    for (const name of SERVICES) {
      for (const value of setting(unit(name), "Environment")) {
        const match = /^[A-Z_]+_KEYSTORE(?:_PASSWORD_FILE)?=\/etc\/lemniscate\/keys\/([a-z0-9-]+)\.(?:json|password)$/.exec(value);
        if (match) expect(owners[match[1]!]).toBe(name);
      }
    }
  });

  test("the api is the only service that can be handed the paymaster and x402 keystores", () => {
    const owners = keyOwners();
    expect(owners["paymaster-signer"]).toBe("api");
    expect(owners["x402-settler"]).toBe("api");
    expect(owners["vol-signer"]).toBe("vol-engine");
    expect(owners.hedger).toBe("hedger");
  });

  test("the shared lemniscate user only runs migrations", () => {
    expect(setting(unit("migrate"), "User")).toEqual(["lemniscate"]);
    for (const name of SERVICES) expect(setting(unit(name), "User")[0]).not.toBe("lemniscate");
  });
});
