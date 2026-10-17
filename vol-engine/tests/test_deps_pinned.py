"""F46 / DEPS-1,2,3: every dependency is an exact pin, the lock carries hashes for all of them, deploy installs it with --require-hashes."""

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_pyproject_has_only_exact_pins():
    data = tomllib.loads((ROOT / "pyproject.toml").read_text())
    specs = data["project"]["dependencies"] + data["project"]["optional-dependencies"]["dev"] + data["build-system"]["requires"]
    for spec in specs:
        assert re.search(r"==\s*[0-9]", spec), f"not an exact pin: {spec}"
        assert not re.search(r"[<>~^]|!=", spec.split(";")[0]), f"range in {spec}"


def test_lock_files_pin_and_hash_every_package():
    for name in ("requirements.lock", "requirements-dev.lock"):
        text = (ROOT / name).read_text()
        entries = re.findall(r"^([A-Za-z0-9_.\-]+)==([^\s;]+).*?(?=^\S|\Z)", text, flags=re.M | re.S)
        assert entries, name
        blocks = re.split(r"(?m)^(?=[A-Za-z0-9_.\-]+==)", text)[1:]
        for block in blocks:
            assert "--hash=sha256:" in block, f"{name}: no hash for {block.splitlines()[0]}"
    runtime = (ROOT / "requirements.lock").read_text()
    for pkg in ("numpy", "eth-account", "psycopg", "tzdata", "setuptools"):
        assert re.search(rf"(?m)^{pkg}==", runtime), pkg


def test_deploy_installs_the_lock_with_require_hashes_and_no_resolution():
    deploy = (ROOT.parent / "app/scripts/server/deploy.sh").read_text()
    assert "--require-hashes --no-deps -r requirements.lock" in deploy
    assert "--no-deps --no-build-isolation ." in deploy
    assert "pip install --quiet --no-cache-dir ." not in deploy
