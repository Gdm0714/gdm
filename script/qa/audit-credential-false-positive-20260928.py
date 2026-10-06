#!/usr/bin/env python3
"""Offline native privacy/lifecycle regression; fixture values are never printed.

The provider path is deliberately nonexistent: preflight must stop before any
external process. Real credentials, external models, and project data are unused.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SLUG = "credential-fixture"
FAILURES: list[str] = []
PASSES = 0


def check(ok: bool, label: str) -> None:
    global PASSES
    if ok:
        PASSES += 1
    else:
        FAILURES.append(label)
    print(("PASS " if ok else "FAIL ") + label, flush=True)


def b64(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def authorization(value: str) -> str:
    return " ".join(["Bearer", value])


def cases() -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    public = [
        ("public_bundle_identifier", "com.godongmin.fitcoach.fitcoachFlutter"),
        ("nested_properties", "controller.nutritionState.targetCalories"),
        ("authorization_template", "const headers = {Authorization: `Bearer ${token}`};"),
        ("authorization_concatenation", "const header = 'Bearer ' + token;"),
        ("credential_detector_source", r"const markers = /ghp_|github_pat_|AKIA|Bearer |BEGIN [A-Z ]*PRIVATE KEY/;"),
        ("unicode_and_newlines", "공개 식별자\r\ncom.godongmin.fitcoach.fitcoach_flutter\n"),
    ]
    jwt = ".".join([b64('{"alg":"HS256","typ":"JWT"}'), b64("{}"), b64("x")])
    jwt_spaced = ".".join([b64('{ "alg" : "RS256" }'), b64('{"sub":"fixture"}'), b64("s")])
    jwt_unsigned = ".".join([b64('{"alg":"none"}'), b64("{}"), ""])
    jwe = ".".join([b64('{"alg":"dir","enc":"A256GCM"}'), "", b64("iv"), b64("cipher"), b64("tag")])
    private = [
        ("opaque_bearer", authorization("synthetic_opaque_value_7826")),
        ("short_bearer", authorization("fake")),
        ("case_insensitive_bearer", "bEaReR\t" + "synthetic" + "-opaque"),
        ("jose_short_segments", jwt),
        ("jose_spaced_header", jwt_spaced),
        ("unsigned_jwt", jwt_unsigned),
        ("direct_jwe", jwe),
        ("openai", "sk-" + "proj-" + "A1b2C3d4" * 8),
        ("github_classic", "ghp" + "_" + "Z9y8X7w6" * 5),
        ("github_fine_grained", "github" + "_pat_" + "F1e2D3c4" * 10),
        ("aws_access_key", "AK" + "IA" + "A1B2C3D4E5F6G7H8"),
        ("pem_private_header", "-----BEGIN " + "PRIVATE KEY-----"),
        ("pem_rsa_header", "-----BEGIN RSA " + "PRIVATE KEY-----"),
        ("public_prefix_does_not_exempt", "com.godongmin.fitcoach.\n" + jwt),
        ("dot_prefix_does_not_mask", "public.settings." + jwt),
    ]
    return public, private


class Fixture:
    def __init__(self, binary: Path, root: Path):
        self.binary, self.root = binary, root
        self.env = dict(os.environ)
        self.env["GDM_CLAUDE_EXECUTABLE"] = str(root / "never-exists-provider")
        subprocess.run(["/usr/bin/git", "init", "-q", str(root)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (root / ".gitignore").write_text("/fixture-packets/\n")
        (root / "fixture-packets").mkdir()
        result = self.run("plan", "init", "--slug", SLUG, "--brief", "Offline synthetic privacy regression",
                          "--require", "Preserve artifact bytes and reject credentials")
        if result.returncode:
            raise RuntimeError("fixture initialization failed")
        self.packet = root / "fixture-packets" / "fixture.txt"

    def run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(self.binary), *args], cwd=self.root, env=self.env,
                              capture_output=True, text=True, timeout=20)

    def offer(self, label: str, payload: str) -> subprocess.CompletedProcess[str]:
        self.packet.write_bytes(payload.encode())
        exported = self.run("protocol", "export", "--slug", SLUG)
        if exported.returncode:
            raise RuntimeError("fixture export failed")
        work = json.loads(exported.stdout)["work"]
        return self.run("protocol", "offer", "--slug", SLUG, "--handoff-id", label,
                        "--from-role", "root", "--to-role", "audit", "--intent", "Read synthetic fixture",
                        "--artifact", self.packet.relative_to(self.root).as_posix(),
                        "--expected-plan-fingerprint", work["planFingerprint"],
                        "--expected-state-fingerprint", work["stateFingerprint"],
                        "--expected-source-fingerprint", work["sourceFingerprint"]["sha256"])

    def claim(self, offered: dict, claim_id: str) -> subprocess.CompletedProcess[str]:
        return self.run("protocol", "claim", "--slug", SLUG,
                        "--handoff-event-id", offered["eventId"], "--claim-id", claim_id,
                        "--receiver-role", "audit", "--capability-profile", "gdm-read-only-specialist/v1")

    def preflight(self) -> subprocess.CompletedProcess[str]:
        return self.run("role-run", "--mode", "preflight", "--provider", "claude", "--role", "audit",
                        "--workspace", str(self.root), "--prompt", str(self.packet),
                        "--output", str(self.root / "fixture-packets" / "unused-output.txt"))

    def finish(self, claim_id: str, output: Path) -> subprocess.CompletedProcess[str]:
        return self.run("protocol", "finish", "--slug", SLUG, "--claim-id", claim_id,
                        "--exit-code", "0", "--output-artifact", output.relative_to(self.root).as_posix(),
                        "--provider-target", "local-fixture", "--adapter-version", "fixture-v1",
                        "--executable", str(self.binary), "--executable-version", "synthetic local fixture",
                        "--executable-sha256", hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                        "--argv-policy-id", "fixture-no-provider")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "target/debug/gdm")
    args = parser.parse_args()
    binary = args.binary.resolve()
    if not binary.is_file():
        raise SystemExit("Build the native binary first")
    public, private = cases()
    with tempfile.TemporaryDirectory(prefix="gdm-privacy-regression-") as directory:
        f = Fixture(binary, Path(directory))
        for index, (label, payload) in enumerate(public):
            offered = f.offer("public-" + str(index), payload)
            check(offered.returncode == 0, label + " accepted by offer")
            check(f.packet.read_bytes() == payload.encode(), label + " bytes preserved")
            preflight = f.preflight()
            check("INDEPENDENCE_BLOCKED" in preflight.stderr and
                  "CREDENTIAL_SIGNATURE" not in preflight.stderr,
                  label + " preflight reached deliberately absent provider")
            if offered.returncode == 0:
                claimed = f.claim(json.loads(offered.stdout), "public-claim-" + str(index))
                check(claimed.returncode == 0, label + " accepted by claim")
                if claimed.returncode == 0:
                    artifact = json.loads(claimed.stdout)["artifact"]
                    check(base64.b64decode(artifact["bytesBase64"]) == payload.encode() and
                          artifact["text"] == payload and
                          artifact["sha256"] == hashlib.sha256(payload.encode()).hexdigest(),
                          label + " exact dispatch text bytes hash")
        for index, (label, payload) in enumerate(private):
            for wrapper, text in (("plain", payload), ("fenced", "```text\n" + payload + "\n```"),
                                  ("comment", "// com.godongmin.fitcoach\n// " + payload)):
                offered = f.offer("private-" + str(index) + "-" + wrapper, text)
                check(offered.returncode != 0 and "privacy_rejected" in offered.stderr,
                      label + " " + wrapper + " offer rejected")
                preflight = f.preflight()
                check(preflight.returncode != 0 and "CREDENTIAL_SIGNATURE" in preflight.stderr,
                      label + " " + wrapper + " preflight rejected")
                check(payload not in offered.stdout + offered.stderr + preflight.stdout + preflight.stderr,
                      label + " " + wrapper + " value never echoed")
        for label, replacement, expected in (
            ("mutation", "changed harmless bytes", "artifact_changed"),
            ("injected-secret", private[0][1], "privacy_rejected"),
        ):
            offered = f.offer("lifecycle-" + label, "safe original bytes\n")
            check(offered.returncode == 0, label + " initial offer")
            if offered.returncode == 0:
                journal = f.root / ".gdm" / SLUG / "journal.jsonl"
                prior = journal.read_bytes()
                f.packet.write_text(replacement)
                claimed = f.claim(json.loads(offered.stdout), "claim-" + label)
                check(claimed.returncode != 0 and expected in claimed.stderr,
                      label + " claim fails closed")
                check(journal.read_bytes() == prior, label + " no accepted receipt")
        offered = f.offer("finish-lifecycle", "safe lifecycle fixture\n")
        check(offered.returncode == 0, "finish lifecycle initial offer")
        if offered.returncode == 0:
            offer = json.loads(offered.stdout)
            claimed = f.claim(offer, "finish-claim")
            check(claimed.returncode == 0, "finish lifecycle claim")
            if claimed.returncode == 0:
                bundle = json.loads(claimed.stdout)
                ack = {"schemaVersion": "gdm-receiver-ack/v1", "claimId": "finish-claim",
                       "handoffEventId": offer["eventId"], "bundleSha256": bundle["bundleSha256"],
                       "disposition": "completed"}
                output = f.root / "fixture-packets" / "synthetic-output.txt"
                raw = "Synthetic local result, no external model.\nGDM_RECEIVER_ACK_V1=" + json.dumps(ack) + "\n"
                output.write_text(raw)
                finished = f.finish("finish-claim", output)
                check(finished.returncode == 0, "finish records exact local fixture output")
                if finished.returncode == 0:
                    event = json.loads(finished.stdout)
                    check(event["runnerObserved"]["outputArtifact"]["sha256"] ==
                          hashlib.sha256(raw.encode()).hexdigest(), "finish output hash retained")
                    output.write_text(raw + "mutation\n")
                    rejected = f.run("protocol", "adopt", "--slug", SLUG, "--claim-id", "finish-claim")
                    check(rejected.returncode != 0 and "output_changed" in rejected.stderr,
                          "changed output cannot be adopted")
                    output.write_text(raw)
                    adopted = f.run("protocol", "adopt", "--slug", SLUG, "--claim-id", "finish-claim")
                    check(adopted.returncode == 0, "byte-identical output can be adopted")
        strict = f.run("plan", "contract", "--slug", SLUG, "--require", authorization("fake"))
        check(strict.returncode != 0, "contract metadata remains strict")
    print(json.dumps({"passed": PASSES, "failed": len(FAILURES), "failureLabels": FAILURES,
                      "externalProviderExecutions": 0, "fixtureValuesPrinted": False}, ensure_ascii=False))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
