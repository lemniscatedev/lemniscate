"""The JSON-RPC transport must not send urllib's default User-Agent: CDN-fronted public RPCs refuse it with 403."""
import io
import json

from vol_engine import sender


def test_transport_sends_its_own_user_agent(monkeypatch):
    seen = {}

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout):
        seen["ua"] = req.get_header("User-agent")
        seen["ct"] = req.get_header("Content-type")
        return Resp(json.dumps({"jsonrpc": "2.0", "id": 1, "result": "0xb626"}).encode())

    monkeypatch.setattr(sender.urllib.request, "urlopen", fake_urlopen)
    assert sender.http_transport("https://rpc.example")("eth_chainId", []) == "0xb626"
    assert seen["ct"] == "application/json"
    assert seen["ua"] and not seen["ua"].startswith("Python-urllib")
