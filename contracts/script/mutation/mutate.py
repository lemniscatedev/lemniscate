#!/usr/bin/env python3
"""Tiny mutation-testing driver: applies each hand-picked mutant from mutants.txt, runs the test suite, restores.

A mutant is KILLED when the suite fails, SURVIVED when it passes, and STILLBORN when it does not compile.

Usage (from contracts/):
    python3 script/mutation/mutate.py                      # uses `forge test --fail-fast`
    FORGE="docker run --rm -v $PWD:/w -w /w --entrypoint forge ghcr.io/foundry-rs/foundry:latest" \
        python3 script/mutation/mutate.py [--only N,M]

Work on a scratch copy if you are editing in parallel: sources are restored after every mutant, but a crash mid-run
could leave one applied (the script restores from an in-memory copy on exit, including Ctrl-C).
"""
import os
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))


def load_mutants():
    mutants = []
    for raw in open(os.path.join(HERE, "mutants.txt")):
        line = raw.rstrip("\n")
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split(" | ")
        if len(parts) != 4:
            sys.exit(f"bad mutant line: {line}")
        path, original, replacement, label = (p.strip() for p in parts)
        mutants.append((path, original.replace("\\n", "\n"), replacement.replace("\\n", "\n"), label))
    return mutants


def run_tests(forge):
    cmd = shlex.split(forge) + ["test", "--fail-fast"]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    out = proc.stdout + proc.stderr
    if "Compiler run failed" in out:
        return "STILLBORN", out
    return ("SURVIVED" if proc.returncode == 0 else "KILLED"), out


def first_failure(out):
    for line in out.splitlines():
        if line.startswith("[FAIL"):
            return line[:160]
    return ""


def main():
    forge = os.environ.get("FORGE", "forge")
    only = None
    if "--only" in sys.argv:
        only = {int(x) for x in sys.argv[sys.argv.index("--only") + 1].split(",")}
    mutants = load_mutants()
    originals = {}
    results = []
    try:
        for idx, (path, original, replacement, label) in enumerate(mutants, 1):
            if only and idx not in only:
                continue
            full = os.path.join(ROOT, path)
            source = originals.setdefault(full, open(full).read())
            count = source.count(original)
            if count != 1:
                results.append((idx, path, label, f"SKIPPED (pattern found {count}x)", ""))
                continue
            open(full, "w").write(source.replace(original, replacement, 1))
            start = time.time()
            status, out = run_tests(forge)
            open(full, "w").write(source)
            results.append((idx, path, label, status, first_failure(out)))
            print(f"[{idx:2}] {status:9} {time.time() - start:5.0f}s {path}: {label}", flush=True)
    finally:
        for full, source in originals.items():
            open(full, "w").write(source)

    scored = [r for r in results if r[3] in ("KILLED", "SURVIVED")]
    killed = sum(1 for r in scored if r[3] == "KILLED")
    print("\n| # | File | Mutation | Result | First failing test |")
    print("|---|------|----------|--------|--------------------|")
    for idx, path, label, status, fail in results:
        print(f"| {idx} | {os.path.basename(path)} | {label} | {status} | {fail} |")
    if scored:
        print(f"\nKill rate: {killed}/{len(scored)} = {100 * killed / len(scored):.0f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
