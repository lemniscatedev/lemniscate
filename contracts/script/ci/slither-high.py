#!/usr/bin/env python3
"""Exit 1 if a Slither --json report has a High-impact finding not in the allowlist.
An allowlist entry matches one finding exactly: same detector, same file, and the flagged expression text in its description.
Usage: slither-high.py <report.json> <slither-allow.json>"""
import json, sys

report, allow_path = sys.argv[1:]
try:
    data = json.load(open(report))
except (OSError, ValueError) as e:
    sys.exit(f"slither report missing or unreadable ({e}): treating as failure")
if not data.get("success", False):
    sys.exit(f"slither failed: {data.get('error')}")
allow = json.load(open(allow_path))
used, bad = set(), []
for r in data.get("results", {}).get("detectors", []):
    if r.get("impact") != "High":
        continue
    files = {e.get("source_mapping", {}).get("filename_relative") for e in r.get("elements", [])}
    hit = next((i for i, a in enumerate(allow) if a["check"] == r["check"] and a["file"] in files
                and f'"{a["expression"]} (' in r.get("description", "")), None)
    if hit is None:
        bad.append(r)
    else:
        used.add(hit)
        print(f"allowed High: {r['check']} in {allow[hit]['file']} ({allow[hit]['reason'][:80]}...)")
for r in bad:
    print(f"HIGH: {r['check']}: {r['description'].strip()}")
sys.exit(1 if bad else 0)
