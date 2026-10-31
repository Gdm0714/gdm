#!/usr/bin/env python3
"""Freeze exact CLI sources and build both arms without editing the user repo."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
COPIED = ["Cargo.toml", "Cargo.lock", "bench/computer-use-jev/fixture.rs", "bench/computer-use-jev/stamp.rs"]


def prepare(build):
    work_path = ROOT / ".gdm/research-adoption-regression-20261029/checks.json"
    if work_path.is_file():
        work = json.loads(work_path.read_text())
        head = work["baseline"]["head"]
        baseline = {entry["path"]: entry["sha256"] for entry in work["baseline"]["files"]}
        baseline_uses_path_mode = True
    else:
        # Published provenance makes a clean checkout reproducible without
        # requiring the original private Work ledger.
        recorded = json.loads((HERE / "provenance.json").read_text())
        head = recorded["baseline_head"]
        baseline = recorded["source_hashes"]["before"]
        baseline_uses_path_mode = False
    for arm in ("before", "after"):
        path = HERE / arm
        path.mkdir(exist_ok=True)
        if arm == "before":
            archive = subprocess.check_output(["git", "archive", head, "src", *COPIED], cwd=ROOT)
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(path, filter="data")
        else:
            for name in COPIED:
                dest = path / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, dest)
            shutil.copytree(ROOT / "src", path / "src", dirs_exist_ok=True)
    hashes = {}
    for arm in ("before", "after"):
        path = HERE / arm
        files = [f for f in path.rglob("*") if f.is_file() and f.name != "gdm"]
        hashes[arm] = {str(f.relative_to(path)): hashlib.sha256(f.read_bytes()).hexdigest()
                       for f in sorted(files)}
        if arm == "before":
            for file in files:
                name = str(file.relative_to(path))
                mode = "executable" if file.stat().st_mode & 0o111 else "regular"
                prefix = f"path\0{name}\0file\0{mode}\0".encode()
                payload = prefix + file.read_bytes() if baseline_uses_path_mode else file.read_bytes()
                assert hashlib.sha256(payload).hexdigest() == baseline[name], name
    (HERE / "provenance.json").write_text(json.dumps({
        "baseline_head": head,
        "current_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "build_profile": "release (Cargo.toml profile, opt-level 3 default, thin LTO)",
        "source_hashes": hashes,
    }, indent=2) + "\n")
    if not build:
        return
    target = HERE / "build"
    target.mkdir(exist_ok=True)
    if not (target / "release").exists() and (ROOT / "target/release").exists():
        # APFS copy-on-write clone; subsequent compiler writes affect only this
        # benchmark's private copy, never the user's release artifacts.
        subprocess.run(["/bin/cp", "-cR", str(ROOT / "target/release"), str(target / "release")], check=True)
    env = dict(os.environ, CARGO_TARGET_DIR=str(target), CARGO_BUILD_JOBS="2")
    for arm in ("before", "after"):
        path = HERE / arm
        # Cargo may otherwise reuse a same-package fingerprint when restored
        # source mtimes are older than a shared target directory's previous build.
        for file in path.rglob("*"):
            if file.is_file() and file.name != "gdm":
                os.utime(file, None)
        subprocess.run(["cargo", "build", "--locked", "--offline", "--release", "--bin", "gdm",
                        "--manifest-path", str(path / "Cargo.toml")], cwd=ROOT, env=env, check=True)
        shutil.copy2(target / "release/gdm", path / "gdm")
    assert (HERE / "before/gdm").read_bytes() != (HERE / "after/gdm").read_bytes()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", action="store_true")
    args = parser.parse_args()
    prepare(args.build)
