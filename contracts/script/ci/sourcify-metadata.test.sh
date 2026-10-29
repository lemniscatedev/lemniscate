#!/usr/bin/env bash
# Offline test of script/ci/sourcify-metadata.py: a fake Sourcify records what /v2/verify/metadata receives and answers
# exact_match. Asserts the build metadata object and the source text of every listed file are sent, per contract.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
python3 - "$ROOT" "$T" <<'PY'
import json, os, subprocess, sys, threading, http.server
root, tmp = sys.argv[1:3]
sys.path.insert(0, os.path.join(root, "script", "ci"))
os.makedirs(f"{tmp}/out/WriterPool.sol"); os.makedirs(f"{tmp}/out/ERC1967Proxy.sol"); os.makedirs(f"{tmp}/src")
open(f"{tmp}/src/WriterPool.sol", "w").write("contract WriterPool {}\n")
open(f"{tmp}/src/Proxy.sol", "w").write("contract Proxy {}\n")
pool_meta = {"language": "Solidity", "sources": {"src/WriterPool.sol": {"keccak256": "0x1"}}, "settings": {"optimizer": {"enabled": True}}}
proxy_meta = {"language": "Solidity", "sources": {"src/Proxy.sol": {"keccak256": "0x2"}}, "settings": {}}
json.dump({"metadata": pool_meta}, open(f"{tmp}/out/WriterPool.sol/WriterPool.json", "w"))
json.dump({"metadata": proxy_meta}, open(f"{tmp}/out/ERC1967Proxy.sol/ERC1967Proxy.json", "w"))
A, B = "0x" + "0" * 39 + "a", "0x" + "0" * 39 + "b"
json.dump({"chainId": 4663, "contracts": {"poolImpl": A, "pool": B, "engine": "0x" + "0" * 40}}, open(f"{tmp}/dep.json", "w"))
seen = {}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body):
        data = json.dumps(body).encode(); self.send_response(code)
        self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        seen[self.path] = body
        self._send(202, {"verificationId": "job-" + self.path[-1]})
    def do_GET(self):
        self._send(200, {"isJobCompleted": True, "contract": {"match": "exact_match"}})
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_port}"
run = lambda: subprocess.run([sys.executable, os.path.join(root, "script/ci/sourcify-metadata.py"), f"{tmp}/dep.json", "4663", url,
                              "--out", f"{tmp}/out", "--root", tmp, "--wait", "5"], capture_output=True, text=True)
r = run()
assert r.returncode == 0, r.stdout + r.stderr
assert set(seen) == {f"/v2/verify/metadata/4663/{A}", f"/v2/verify/metadata/4663/{B}"}, list(seen)
sent = seen[f"/v2/verify/metadata/4663/{A}"]
assert sent["metadata"] == pool_meta, "metadata.json must be sent verbatim"
assert sent["sources"] == {"src/WriterPool.sol": "contract WriterPool {}\n"}, "source text must be sent"
assert seen[f"/v2/verify/metadata/4663/{B}"]["sources"] == {"src/Proxy.sol": "contract Proxy {}\n"}
assert "exact_match" in r.stdout
# a plain "match" (what forge's own Sourcify path gave on testnet) must make the submit step exit non-zero
H.do_GET = lambda self: self._send(200, {"isJobCompleted": True, "contract": {"match": "match"}})
r = run()
assert r.returncode == 1 and "not exact_match" in r.stderr, r.stdout + r.stderr
print("sourcify-metadata.test: ok")
PY
