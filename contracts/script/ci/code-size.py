#!/usr/bin/env python3
"""EIP-170 headroom check (hygiene 27e): every deployable contract under src/ keeps at least MIN_HEADROOM bytes below the
24,576-byte runtime limit. Reads the forge build output (out/), so run `forge build` first. Usage: code-size.py [out-dir]"""
import json
import pathlib
import sys

LIMIT = 24_576
MIN_HEADROOM = 1_024

def main() -> int:
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "out")
    rows = []
    for artifact in sorted(out.glob("*.sol/*.json")):
        try:
            data = json.loads(artifact.read_text())
        except (OSError, ValueError):
            continue
        targets = (data.get("metadata") or {}).get("settings", {}).get("compilationTarget", {})
        if not any(path.startswith("src/") for path in targets):
            continue
        code = (data.get("deployedBytecode") or {}).get("object", "0x")
        size = (len(code) - 2) // 2 if code.startswith("0x") else len(code) // 2
        if size > 0:
            rows.append((artifact.stem, size))
    if not rows:
        print("code-size: no src/ artifacts under", out, "(run forge build first)", file=sys.stderr)
        return 2
    failed = False
    for name, size in sorted(rows, key=lambda r: -r[1]):
        headroom = LIMIT - size
        bad = headroom < MIN_HEADROOM
        failed |= bad
        print(f"{'FAIL' if bad else 'ok  '} {name:<34} {size:>6} B  headroom {headroom:>6} B")
    if failed:
        print(f"code-size: a contract has less than {MIN_HEADROOM} B of EIP-170 headroom ({LIMIT} B limit)", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
