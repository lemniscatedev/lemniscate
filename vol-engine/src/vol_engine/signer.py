"""EIP-712 signing of VolOracle posts (domain "LemniscateVolOracle" v1; type Post, see VolOracle.sol)."""

from __future__ import annotations

from dataclasses import dataclass, asdict

from eth_abi import encode
from eth_keys import keys
from eth_utils import keccak, to_checksum_address

DOMAIN_NAME = "LemniscateVolOracle"
DOMAIN_VERSION = "1"
POST_TYPE = (
    "Post(address stock,uint8 speed,uint64 sigmaBps,uint64 skewK,uint64 eventBumpBps,"
    "uint64 buyBlockFrom,uint64 buyBlockTo,uint64 validUntil,uint64 nonce)"
)
DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
POST_TYPEHASH = keccak(text=POST_TYPE)
DOMAIN_TYPEHASH = keccak(text=DOMAIN_TYPE)
_U64 = (1 << 64) - 1


@dataclass(frozen=True)
class Post:
    stock: str
    speed: int
    sigma_bps: int
    skew_k: int
    event_bump_bps: int
    buy_block_from: int
    buy_block_to: int
    valid_until: int
    nonce: int

    def __post_init__(self) -> None:
        for f in ("sigma_bps", "skew_k", "event_bump_bps", "buy_block_from", "buy_block_to", "valid_until", "nonce"):
            if not 0 <= getattr(self, f) <= _U64:
                raise ValueError(f"{f} does not fit uint64")
        if self.speed not in (0, 1):
            raise ValueError("speed must be 0 (DAILY) or 1 (WEEKLY)")

    def as_tuple(self) -> tuple:
        return (
            to_checksum_address(self.stock), self.speed, self.sigma_bps, self.skew_k, self.event_bump_bps,
            self.buy_block_from, self.buy_block_to, self.valid_until, self.nonce,
        )

    def typed_data(self, chain_id: int, verifying_contract: str) -> dict:
        """The eth_signTypedData_v4 payload, identical in shape to contracts/test/vectors/volpost-eip712.json."""
        return {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"},
                ],
                "Post": [
                    {"name": "stock", "type": "address"}, {"name": "speed", "type": "uint8"},
                    {"name": "sigmaBps", "type": "uint64"}, {"name": "skewK", "type": "uint64"},
                    {"name": "eventBumpBps", "type": "uint64"}, {"name": "buyBlockFrom", "type": "uint64"},
                    {"name": "buyBlockTo", "type": "uint64"}, {"name": "validUntil", "type": "uint64"},
                    {"name": "nonce", "type": "uint64"},
                ],
            },
            "primaryType": "Post",
            "domain": {
                "name": DOMAIN_NAME, "version": DOMAIN_VERSION, "chainId": chain_id,
                "verifyingContract": to_checksum_address(verifying_contract),
            },
            "message": {
                "stock": to_checksum_address(self.stock), "speed": self.speed, "sigmaBps": self.sigma_bps,
                "skewK": self.skew_k, "eventBumpBps": self.event_bump_bps, "buyBlockFrom": self.buy_block_from,
                "buyBlockTo": self.buy_block_to, "validUntil": self.valid_until, "nonce": self.nonce,
            },
        }


def domain_separator(chain_id: int, verifying_contract: str) -> bytes:
    return keccak(encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [DOMAIN_TYPEHASH, keccak(text=DOMAIN_NAME), keccak(text=DOMAIN_VERSION), chain_id,
         to_checksum_address(verifying_contract)],
    ))


def struct_hash(post: Post) -> bytes:
    return keccak(encode(
        ["bytes32", "address", "uint8", "uint64", "uint64", "uint64", "uint64", "uint64", "uint64", "uint64"],
        [POST_TYPEHASH, *post.as_tuple()],
    ))


def digest(post: Post, chain_id: int, verifying_contract: str) -> bytes:
    return keccak(b"\x19\x01" + domain_separator(chain_id, verifying_contract) + struct_hash(post))


def sign_digest(private_key: str, dig: bytes) -> bytes:
    """r || s || v (v in {27, 28}); eth-keys signs with RFC 6979 and emits low-s."""
    key = keys.PrivateKey(bytes.fromhex(private_key.removeprefix("0x")))
    sig = key.sign_msg_hash(dig)
    return sig.r.to_bytes(32, "big") + sig.s.to_bytes(32, "big") + bytes([sig.v + 27])


def sign_post(private_key: str, post: Post, chain_id: int, verifying_contract: str) -> tuple[bytes, bytes]:
    """Returns (digest, signature)."""
    dig = digest(post, chain_id, verifying_contract)
    return dig, sign_digest(private_key, dig)


def signer_address(private_key: str) -> str:
    return keys.PrivateKey(bytes.fromhex(private_key.removeprefix("0x"))).public_key.to_checksum_address()


def recover(dig: bytes, signature: bytes) -> str:
    sig = keys.Signature(vrs=(signature[64] - 27, int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:64], "big")))
    return sig.recover_public_key_from_msg_hash(dig).to_checksum_address()
