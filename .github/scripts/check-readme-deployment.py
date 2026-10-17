#!/usr/bin/env python3
"""DOC-6: the README's "Deployment" section must match app/deployments.

  - no live (mainnet or testnet) deployment file in app/deployments  -> the section must say "Not deployed" and list no address;
  - a live deployment file exists                                   -> the section must not say "Not deployed" and must list the
    network, the deployment block and every contract address of the file.
Fork files (network "fork") are local rehearsals and never count. Usage: check-readme-deployment.py [repo-root]
"""
import json, re, sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
readme = (root / "README.md").read_text()
m = re.search(r"^###\s+Deployment\s*$(.*?)(?=^#{1,3}\s|\Z)", readme, re.S | re.M)
if not m:
    sys.exit("check-readme-deployment: README.md has no '### Deployment' section")
section = m.group(1)
live = []
for f in sorted((root / "app" / "deployments").glob("*.json")) if (root / "app" / "deployments").is_dir() else []:
    data = json.loads(f.read_text())
    if data.get("network") in ("mainnet", "testnet"):
        live.append((f.name, data))
problems = []
addresses = set(a.lower() for a in re.findall(r"0x[0-9a-fA-F]{40}", section))
if not live:
    if not re.search(r"not deployed", section, re.I):
        problems.append("no live deployment file in app/deployments, but the Deployment section does not say 'Not deployed'")
    if addresses:
        problems.append("the Deployment section lists addresses but app/deployments has no live deployment file")
else:
    if re.search(r"^\s*not deployed\b", section, re.I | re.M):
        problems.append("app/deployments has a live deployment but the Deployment section still says 'Not deployed'")
    for name, data in live:
        if data["network"] not in section.lower():
            problems.append(f"{name}: network '{data['network']}' is not named in the Deployment section")
        if str(data.get("deployBlock")) not in section:
            problems.append(f"{name}: deployment block {data.get('deployBlock')} is not in the Deployment section")
        for key, addr in sorted(data.get("contracts", {}).items()):
            if re.fullmatch(r"0x[0-9a-fA-F]{40}", addr or "") and addr.lower() not in addresses and int(addr, 16) != 0:
                problems.append(f"{name}: {key} {addr} is missing from the Deployment section")
if problems:
    print("check-readme-deployment: FAILED", *problems, sep="\n  ", file=sys.stderr)
    sys.exit(1)
print("check-readme-deployment: ok (" + ("live deployment listed" if live else "not deployed, none listed") + ")")
