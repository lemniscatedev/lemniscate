#!/usr/bin/env python3
"""Submit every contract of a deployment to Sourcify's /v2/verify/metadata with its build metadata.json and sources.

Why: `forge verify --verifier sourcify` reached only "match" on testnet. Sending the compiler metadata that the
deployed bytecode was built from (its IPFS metadata hash is in the bytecode) lets Sourcify return "exact_match" on the
first try.

Usage: sourcify-metadata.py DEPLOYMENT_FILE CHAIN_ID SOURCIFY_URL [--out DIR] [--root DIR] [--wait SECONDS]
Exit 0 when every submission was accepted and finished as exact_match; 1 otherwise (the `check` mode of
verify-deployment.sh is still the judge, this only submits).
"""
import argparse, json, os, sys, time, urllib.error, urllib.request

# deployment-file key -> (source file, contract name) of the artifact the address was built from.
CONTRACTS = {
    "engine": ("ERC1967Proxy.sol", "ERC1967Proxy"),
    "engineImpl": ("LemniscateEngine.sol", "LemniscateEngine"),
    "pool": ("ERC1967Proxy.sol", "ERC1967Proxy"),
    "poolImpl": ("WriterPool.sol", "WriterPool"),
    "registry": ("SeriesRegistry.sol", "SeriesRegistry"),
    "priceGuard": ("PriceGuard.sol", "PriceGuard"),
    "volOracle": ("VolOracle.sol", "VolOracle"),
    "marketHours": ("ERC1967Proxy.sol", "ERC1967Proxy"),
    "marketHoursImpl": ("MarketHours.sol", "MarketHours"),
    "agentRouter": ("AgentRouter.sol", "AgentRouter"),
    "reserve": ("Reserve.sol", "Reserve"),
    "feeRouter": ("FeeRouter.sol", "FeeRouter"),
    "hedgeAdapter": ("UniswapV3HedgeAdapter.sol", "UniswapV3HedgeAdapter"),
    "priceReference": ("UniswapV3TwapReference.sol", "UniswapV3TwapReference"),
    "timelock": ("TimelockController.sol", "TimelockController"),
}
ZERO = "0x" + "0" * 40


def load_artifact(out_dir, file_name, contract):
    path = os.path.join(out_dir, file_name, contract + ".json")
    with open(path) as handle:
        artifact = json.load(handle)
    metadata = artifact.get("metadata")
    if not isinstance(metadata, dict) or "sources" not in metadata:
        raise ValueError(f"{path} has no compiler metadata (build with forge, bytecode_hash and cbor_metadata on)")
    return metadata


def build_payload(metadata, root):
    """The /v2/verify/metadata body: the metadata object and the exact source text of every file it lists."""
    sources = {}
    for source_path in metadata["sources"]:
        with open(os.path.join(root, source_path), encoding="utf-8") as handle:
            sources[source_path] = handle.read()
    return {"sources": sources, "metadata": metadata}


def request(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"content-type": "application/json", "accept": "application/json",
                                          "user-agent": "lemniscate-verify/1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        except ValueError:
            return error.code, {}
    except (urllib.error.URLError, ValueError, TimeoutError):
        return 0, {}


def submit_one(base, chain, address, payload, wait):
    status, body = request("POST", f"{base}/v2/verify/metadata/{chain}/{address}", payload)
    if status == 409:  # already verified
        return "already_verified"
    if status not in (200, 201, 202):
        return f"rejected_http_{status}"
    job = body.get("verificationId")
    if not job:
        return "no_verification_id"
    deadline = time.time() + wait
    while time.time() < deadline:
        status, body = request("GET", f"{base}/v2/verify/{job}")
        if status == 200 and body.get("isJobCompleted"):
            match = (body.get("contract") or {}).get("match")
            return match or ("failed:" + str((body.get("error") or {}).get("customCode", "unknown")))
        time.sleep(2)
    return "timeout"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("deployment")
    parser.add_argument("chain")
    parser.add_argument("sourcify")
    parser.add_argument("--out", default="out")
    parser.add_argument("--root", default=".")
    parser.add_argument("--wait", type=int, default=120)
    args = parser.parse_args()
    base = args.sourcify.rstrip("/")
    with open(args.deployment) as handle:
        deployed = json.load(handle)["contracts"]
    bad = []
    for key, (file_name, contract) in CONTRACTS.items():
        address = deployed.get(key) or ZERO
        if address.lower() == ZERO:
            continue
        result = submit_one(base, args.chain, address, build_payload(load_artifact(args.out, file_name, contract), args.root), args.wait)
        print(f"sourcify-metadata {key:<16} {address} {result}")
        if result not in ("exact_match", "already_verified"):
            bad.append(key)
    if bad:
        print("sourcify-metadata: not exact_match: " + ", ".join(bad), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
