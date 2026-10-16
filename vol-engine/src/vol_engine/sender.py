"""Pluggable senders for VolOracle.post. Dry-run by default; a real send needs VOL_SEND=1 plus an RPC and a gas key."""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from typing import Callable, Protocol

from eth_abi import encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address

from .config import Settings
from .signer import Post

POST_SIGNATURE = "post((address,uint8,uint64,uint64,uint64,uint64,uint64,uint64,uint64),bytes)"
POST_SELECTOR = keccak(text=POST_SIGNATURE)[:4]


@dataclass(frozen=True)
class SignedPost:
    post: Post
    digest: bytes
    signature: bytes


@dataclass(frozen=True)
class SendResult:
    status: str  # dry_run | sent | failed
    tx_hash: str | None = None
    error: str | None = None


class Sender(Protocol):
    def send(self, signed: SignedPost) -> SendResult: ...


def encode_post_call(signed: SignedPost) -> bytes:
    return POST_SELECTOR + encode(
        ["(address,uint8,uint64,uint64,uint64,uint64,uint64,uint64,uint64)", "bytes"],
        [signed.post.as_tuple(), signed.signature],
    )


class DryRunSender:
    def send(self, signed: SignedPost) -> SendResult:
        return SendResult("dry_run")


Transport = Callable[[str, list], object]


def http_transport(url: str) -> Transport:
    def call(method: str, params: list) -> object:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310 (operator-configured RPC URL)
            payload = json.loads(resp.read())
        if "error" in payload:
            raise RuntimeError(f"rpc {method} failed: {payload['error'].get('message', 'error')}")
        return payload["result"]

    return call


class RpcSender:
    """Signs a legacy transaction with the gas key and submits it. Only constructible with allow_send=True."""

    def __init__(self, oracle: str, chain_id: int, gas_key: str, transport: Transport, allow_send: bool = False) -> None:
        if not allow_send:
            raise RuntimeError("RpcSender refuses to send unless VOL_SEND=1")
        self._oracle = to_checksum_address(oracle)
        self._chain_id = chain_id
        self._key = gas_key
        self._rpc = transport
        self._from = Account.from_key(gas_key).address

    def send(self, signed: SignedPost) -> SendResult:
        try:
            data = encode_post_call(signed)
            nonce = int(self._rpc("eth_getTransactionCount", [self._from, "pending"]), 16)
            gas_price = int(self._rpc("eth_gasPrice", []), 16)
            call = {"from": self._from, "to": self._oracle, "data": "0x" + data.hex()}
            gas = int(int(self._rpc("eth_estimateGas", [call]), 16) * 1.25)
            tx = {"nonce": nonce, "gasPrice": gas_price, "gas": gas, "to": self._oracle, "value": 0,
                  "data": data, "chainId": self._chain_id}
            raw = Account.sign_transaction(tx, self._key).raw_transaction
            tx_hash = self._rpc("eth_sendRawTransaction", ["0x" + bytes(raw).hex()])
            return SendResult("sent", str(tx_hash))
        except Exception as exc:  # the caller records the failure; the message never contains key material
            return SendResult("failed", error=type(exc).__name__ + ": " + str(exc)[:200])


def make_sender(settings: Settings, transport: Transport | None = None) -> Sender:
    if not settings.send:
        return DryRunSender()
    key = settings.sender_key or settings.signer_key
    if not (settings.rpc_url and settings.oracle_address and key):
        raise RuntimeError("VOL_SEND=1 needs VOL_RPC_URL, VOL_ORACLE_ADDRESS and a key")
    return RpcSender(settings.oracle_address, settings.chain_id, key, transport or http_transport(settings.rpc_url), allow_send=True)
