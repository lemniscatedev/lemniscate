import json
from pathlib import Path

from vol_engine.guard import clamp_step, step_bounds
from vol_engine.signer import Post, digest, domain_separator, recover, sign_digest, sign_post, signer_address, struct_hash, POST_TYPEHASH

from helpers import ANVIL_KEY

VECTOR = Path(__file__).resolve().parents[2] / "contracts" / "test" / "vectors" / "volpost-eip712.json"


def load():
    v = json.loads(VECTOR.read_text())
    m, d = v["typedData"]["message"], v["typedData"]["domain"]
    post = Post(m["stock"], m["speed"], m["sigmaBps"], m["skewK"], m["eventBumpBps"], m["buyBlockFrom"], m["buyBlockTo"],
                m["validUntil"], m["nonce"])
    return v, post, d["chainId"], d["verifyingContract"]


def test_signatureMatchesVolOracle_every_component_byte_for_byte():
    v, post, chain, oracle = load()
    assert "0x" + POST_TYPEHASH.hex() == v["typeHash"]
    assert "0x" + domain_separator(chain, oracle).hex() == v["domainSeparator"]
    assert "0x" + struct_hash(post).hex() == v["structHash"]
    dig, sig = sign_post(ANVIL_KEY, post, chain, oracle)
    assert "0x" + dig.hex() == v["digest"]
    assert "0x" + sig.hex() == v["signature"]
    assert recover(dig, sig) == v["signer"] == signer_address(ANVIL_KEY)


def test_signature_is_low_s_and_27_28():
    _, post, chain, oracle = load()
    _, sig = sign_post(ANVIL_KEY, post, chain, oracle)
    assert sig[64] in (27, 28)
    assert int.from_bytes(sig[32:64], "big") <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0  # // not-a-key (half the curve order)


def test_typed_data_payload_matches_vector_shape():
    v, post, chain, oracle = load()
    td = post.typed_data(chain, oracle)
    assert td["types"] == v["typedData"]["types"] and td["primaryType"] == "Post"
    assert td["domain"]["name"] == v["typedData"]["domain"]["name"]


def test_stepGuard_never_leaves_25_percent():
    # Mirror of the contract rule: |new - ref| * 10000 <= ref * 2500, ref = max(prior, floor).
    for prior in (3000, 3001, 4999, 5200, 12345):
        lo, hi = step_bounds(prior, 3000)
        for target in (0, 3000, prior, lo - 1, hi + 1, hi * 3):
            v, ramped = clamp_step(target, prior, 3000)
            ref = max(prior, 3000)
            assert abs(v - ref) * 10_000 <= ref * 2_500
            assert v >= 3000
            assert ramped == (v != target)


def test_stepGuard_ramps_in_steps_and_says_so():
    v, ramped = clamp_step(12_000, 5_000, 3_000)
    assert v == 6_250 and ramped
    v2, r2 = clamp_step(12_000, v, 3_000)
    assert v2 == 7_812 and r2  # 6250 + floor(6250/4)
    assert clamp_step(5_100, 5_000, 3_000) == (5_100, False)


def test_stepGuard_first_post_only_needs_the_floor():
    assert clamp_step(2_000, None, 3_000) == (3_000, True)
    assert clamp_step(90_000, None, 3_000) == (90_000, False)


def test_stepGuard_raised_floor_reference():
    # Floor raised above the prior: reference is the floor, as in the contract.
    assert step_bounds(2_000, 4_500) == (4_500, 5_625)
