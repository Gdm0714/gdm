"""Verify the installed hook using isolated ledgers; never mutate real sessions."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default=str(Path.home() / ".local/bin/gdm"))
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix="gdm-active-limit-qa-") as root:
        env = dict(os.environ, CODEX_HOME=root)

        def command(argv, payload=None):
            result = subprocess.run(
                [binary, *argv], input=None if payload is None else json.dumps(payload),
                text=True, capture_output=True, env=env, timeout=15, check=True,
            )
            return json.loads(result.stdout)

        def hook(session, index, event="PreToolUse", response=None):
            payload = {
                "session_id": session, "hook_event_name": event,
                "tool_name": "spawn_agent", "tool_use_id": f"qa-use-{index}",
                "tool_input": {"message": f"Isolated hook fixture {index}"},
            }
            if response is not None:
                payload["tool_response"] = response
            return command(["agent", "hook"], payload)

        def decision(result):
            return result["hookSpecificOutput"]["permissionDecision"]

        for index in range(40):
            assert decision(hook("finished", index)) == "allow"
            hook("finished", index, "PostToolUse", {"success": False, "error": "fixture"})
        assert decision(hook("finished", 40)) == "allow"
        for index in range(32):
            assert decision(hook("concurrent", index)) == "allow"
        assert decision(hook("concurrent", 32)) == "deny"
        hook("concurrent", 0, "PostToolUse", {"success": False, "error": "fixture"})
        assert decision(hook("concurrent", 32)) == "allow"

        # Exercise an unchanged legacy schema-v1 ledger with real historical data
        # under a new fixture session hash. No original session file is written.
        real_root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
        candidates = []
        for path in (real_root / "gdm/agent-ledgers").glob("*.json"):
            if path.is_symlink() or not path.is_file():
                continue
            raw = path.read_bytes()
            data = json.loads(raw)
            if data.get("totalAcceptedAttempts", 0) >= 32:
                candidates.append((path, raw, data))
        cloned_history = None
        if candidates:
            source, before, data = min(candidates, key=lambda entry: entry[2]["totalAcceptedAttempts"])
            session = "legacy-history-copy"
            directory = Path(root) / "gdm/agent-ledgers"
            target = directory / (hashlib.sha256(session.encode()).hexdigest() + ".json")
            target.write_bytes(before)
            target.chmod(0o600)
            # The fixture's existing 33 active leases belong to OTHER sessions.
            result = hook(session, "legacy-next")
            after = json.loads(target.read_text())
            assert decision(result) == "allow", result
            assert after["totalAcceptedAttempts"] == data["totalAcceptedAttempts"] + 1
            assert set(data["reservations"]) <= set(after["reservations"])
            assert source.read_bytes() == before, "original ledger changed during verification"
            cloned_history = {"previousAttempts": data["totalAcceptedAttempts"],
                              "newAttempts": after["totalAcceptedAttempts"],
                              "sourceSha256": hashlib.sha256(before).hexdigest(),
                              "originalUnchanged": True}
        summary = command(["agent", "hook-status", "--json"])["ledgers"]
        assert summary["hardSessionActiveExecutionLimit"] == 32
        assert "historical attempts are excluded" in summary["executionLimitBasis"]
        assert summary["corruptLedgers"] == 0
        skill = Path.home() / ".codex/skills/gdm-go/SKILL.md"
        assert "MAX_IN_FLIGHT_SPAWNS_PER_ROOT: 32" in skill.read_text()
        assert "MAX_TOTAL_SPAWNS_PER_ROOT" not in skill.read_text()
        print(json.dumps({"status": "pass", "binary": binary,
                          "binarySha256": hashlib.sha256(Path(binary).read_bytes()).hexdigest(),
                          "sequentialAccepted": 41, "activeLimit": 32,
                          "immediateSlotReuse": True, "legacyClone": cloned_history,
                          "installedSkillUpdated": True}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
