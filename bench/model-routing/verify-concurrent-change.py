#!/usr/bin/env python3
"""Preserve the completed repository separation observed during this benchmark."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
receipt = json.loads((Path(__file__).parent / "concurrent-change.json").read_text())
owner = json.loads((ROOT / ".gdm" / receipt["ownerSlug"] / "checks.json").read_text())
assert owner["done"] and owner["doneAt"] == receipt["ownerDoneAt"], "owner completion changed"
for expected in receipt["ownerChecks"]:
    current = next(c for c in owner["checks"] if c["id"] == expected["id"])
    assert current["status"] == "proven", f"owner check no longer proven: {current['id']}"
    assert current["evidence"]["sha256"] == expected["sha256"], "owner evidence changed"
    evidence = (ROOT / current["evidence"]["observed"]).read_bytes()
    assert hashlib.sha256(evidence).hexdigest() == expected["sha256"], "owner evidence mismatch"
for relative, expected in receipt["preservedFiles"].items():
    assert hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() == expected, relative
for relative in receipt["preservedAbsences"]:
    path = ROOT / relative
    assert not path.exists() and not path.is_symlink(), f"separated path restored: {relative}"
print(json.dumps({"owner": receipt["ownerSlug"], "filesPreserved": len(receipt["preservedFiles"]),
                  "absencesPreserved": len(receipt["preservedAbsences"]), "ownerEvidenceVerified": True}))
