#!/usr/bin/env python3
"""Native distribution gate: real installers, isolated homes, no Bun/Node.

Runs the actual source installer (including Cargo release compilation), then
builds a local release fixture from that executable and native-rendered skills
for the actual remote installer. No provider, VM, credential, or network access
is needed. Cargo uses the existing toolchain/cache with offline mode enabled.
Pi still requires its JavaScript host; the allowed files below are UI/RPC glue.
This gate verifies native runtime/distribution boundaries, not Pi host behavior
or cross-platform release binaries.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
TARGETS = ("claude", "codex", "pi")
HOST_GLUE = {
    "pi/native.ts", "pi/gdm-delegate.ts", "pi/gdm-memory/index.ts",
    "pi/gdm-computer-use/index.ts", "pi/ax.mjs", "pi/presentation.mjs",
    "pi/presentation.d.mts",
}
LEGACY_NAMES = {
    "delegate-budget.ts", "delegate-state.ts", "delegate-policy.ts",
    "store.ts", "backend.ts", "rfb.ts", "bootstrap.ts", "lifecycle.ts",
    "graph-nav-provider.ts", "cli.ts", "package.json", "node_modules",
}
CHECKS = 0


def require(ok: bool, message: str) -> None:
    if not ok:
        raise AssertionError(message)


def passed(message: str) -> None:
    global CHECKS
    CHECKS += 1
    print(f"PASS {message}", flush=True)


def static_gate() -> None:
    cargo = (ROOT / "Cargo.toml").read_text()
    require('[package]' in cargo and 'name = "gdm"' in cargo, "native package missing")
    production = [p for p in (ROOT / "src").rglob("*.rs") if p.name != "tests.rs"]
    for path in production:
        text = path.read_text()
        require(not re.search(r'Command::new\(\s*"(?:bun|node|npx|tsx|ts-node)"', text),
                f"interpreter subprocess in production Rust: {path}")
        require("cli/src/" not in text and "tests/legacy/" not in text,
                f"legacy runtime reference in production Rust: {path}")
    for relative in ("install/install.sh", "install.sh", "script/release/gdm-package.zsh"):
        text = (ROOT / relative).read_text()
        require(not re.search(r"(?m)^\s*(?:exec\s+)?(?:bun|node|npx)\s", text),
                f"installer still launches interpreter: {relative}")
        require("render-skills.ts" not in text and "cli/src/cli.ts" not in text,
                f"legacy build/render entrypoint: {relative}")
    require("cargo build" in (ROOT / "install/install.sh").read_text(), "source installer does not compile Rust")
    require('render-skills' in (ROOT / "script/release/gdm-package.zsh").read_text(),
            "release packaging does not use native renderer")
    check_glue(ROOT / "agents")
    for name, command in {
        "run-role.sh": "role-run", "providers/codex.sh": "provider-run",
        "providers/claude.sh": "provider-run", "providers/pi.sh": "provider-run",
        "pi/gdm-pi": "pi-launch", "pi/gdm-computer-use/setup.sh": "computer-use setup",
    }.items():
        text = (ROOT / "agents" / name).read_text()
        require(command in text and 'exec "${GDM_NATIVE_EXECUTABLE' in text,
                f"entrypoint bypasses native runtime: {name}")
    passed("production runtime/install entrypoints are native; JavaScript is explicit Pi host glue")


def check_glue(agents: Path) -> None:
    actual = {p.relative_to(agents).as_posix() for p in agents.rglob("*")
              if p.is_file() and p.suffix in (".ts", ".js", ".mjs", ".mts")}
    require(actual == HOST_GLUE, f"unexpected/missing host glue: {actual ^ HOST_GLUE}")
    for relative in actual:
        text = (agents / relative).read_text()
        require(not re.search(r'from\s+[\'"](?:node:)?fs(?:/promises)?[\'"]', text),
                f"host glue owns filesystem state: {relative}")
        require("Bun." not in text and "tests/legacy" not in text and "cli/src" not in text,
                f"legacy behavior in shipped host glue: {relative}")
        if relative != "pi/native.ts":
            require("child_process" not in text, f"process lifecycle outside native transport: {relative}")
    for relative in ("pi/gdm-delegate.ts", "pi/gdm-memory/index.ts"):
        require("nativeRpc(" in (agents / relative).read_text(), f"native RPC missing: {relative}")
    require("ComputerTransport" in (agents / "pi/gdm-computer-use/index.ts").read_text(),
            "computer use bridge does not use native transport")


def run(args: list[str | Path], cwd: Path, env: dict[str, str], *,
        expect: int | None = 0, timeout: int = 180, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    # Temporary output files prevent pipe deadlocks during a first release build.
    # Only short failure tails are emitted; environment values are never logged.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = subprocess.Popen([str(a) for a in args], cwd=cwd, env=env,
                                stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                                stdout=out, stderr=err, start_new_session=True)
        if input_text is not None:
            proc.stdin.write(input_text.encode())
            proc.stdin.close()
        started = time.monotonic()
        heartbeat = started + 30
        while proc.poll() is None:
            now = time.monotonic()
            if now - started > timeout:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                raise AssertionError(f"timed out after {timeout}s: {Path(args[0]).name}")
            if now >= heartbeat:
                print(f"  still running {Path(args[0]).name}: {int(now - started)}s", flush=True)
                heartbeat = now + 30
            time.sleep(0.03)
        out.seek(0)
        err.seek(0)
        result = subprocess.CompletedProcess(args, proc.returncode,
                                            out.read().decode(errors="replace"),
                                            err.read().decode(errors="replace"))
    if expect is not None:
        require(result.returncode == expect,
                f"expected exit {expect}, got {result.returncode}: {args}\n"
                f"{result.stdout[-7000:]}\n{result.stderr[-7000:]}")
    return result


def write(path: Path, data: str | bytes, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)
    if executable:
        path.chmod(0o755)


def skill_roots(home: Path) -> list[Path]:
    return [home / ".claude/skills", home / ".codex/skills", home / ".pi/agent/skills"]


def seed(home: Path) -> dict[Path, bytes]:
    originals = {
        home / ".local/bin/gdm": b"#!/bin/sh\nprintf old-gdm\\n\n",
        home / ".local/bin/gdm-pi": b"#!/bin/sh\nprintf old-pi\\n\n",
    }
    for root in skill_roots(home):
        originals[root / "gdm-go/SKILL.md"] = b"prior GDM skill\n"
        originals[root / "user-owned/SKILL.md"] = b"user skill must survive\n"
    for path, data in originals.items():
        write(path, data, path.parent.name == "bin")
    return originals


def no_debris(home: Path) -> None:
    for root in [home / ".local/bin", *skill_roots(home)]:
        if root.is_dir():
            debris = [p.name for p in root.iterdir()
                      if p.name.startswith((".gdm-stage.", ".gdm-rollback.", ".gdm.tmp.", ".gdm-pi.tmp."))]
            require(not debris, f"installer transaction debris: {debris}")


def hook_assertions(home: Path, original_hooks: bytes, original_config: bytes) -> bytes:
    codex = home / ".codex"
    hooks = (codex / "hooks.json").read_bytes()
    value = json.loads(hooks)
    require(value["description"] == "user-owned hooks", "user hook metadata lost")
    for event in ("PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"):
        handlers = [h for group in value["hooks"][event] for h in group["hooks"]]
        require(sum("--handler-id gdm-agent-gate-v1" in h.get("command", "") for h in handlers) == 1,
                f"native gate duplicated or missing: {event}")
    stop = [h for group in value["hooks"]["Stop"] for h in group["hooks"]]
    require({"type": "command", "command": "/opt/user/stop-hook", "timeout": 7} in stop,
            "user Stop hook changed")
    require((codex / "hooks.json.gdm-backup").read_bytes() == original_hooks, "original hook backup changed")
    require((codex / "config.toml").read_bytes() == original_config, "Codex config changed")
    no_debris(home)
    return hooks


def native_workflow(binary: Path, workspace: Path, env: dict[str, str]) -> None:
    workspace.mkdir()
    native = lambda *args, **kw: run([binary, *args], workspace, env, **kw)
    native("plan", "init", "--slug", "native-smoke", "--brief", "Verify installed native evidence lifecycle",
           "--require", "Record evidence using the installed native executable")
    native("plan", "add", "--slug", "native-smoke", "--desc", "Native command records evidence",
           "--cmd", "printf native-proof", "--expect", "native-proof")
    denied = native("done", "--slug", "native-smoke", expect=None)
    require(denied.returncode != 0 and "unproven" in denied.stderr, "done accepted an unproven check")
    native("pass", "c1", "--slug", "native-smoke")
    native("done", "--slug", "native-smoke")
    work = json.loads(native("plan", "list", "--slug", "native-smoke", "--json").stdout)
    require(work["done"] is True and work["checks"][0]["status"] == "proven", "native Work was not completed")
    evidence = work["checks"][0]["evidence"]
    evidence_bytes = (workspace / evidence["observed"]).read_bytes()
    require(hashlib.sha256(evidence_bytes).hexdigest() == evidence["sha256"], "evidence hash mismatch")
    require(evidence["exitCode"] == 0 and b"native-proof" in evidence_bytes, "native execution evidence missing")
    native("resume", "--slug", "native-smoke", "--json")


def check_installed_assets(binary: Path, home: Path, env: dict[str, str]) -> None:
    manifests = []
    for target, root in zip(TARGETS, skill_roots(home)):
        manifests.append(root / "gdm-target-manifest.json")
        manifest = json.loads(manifests[-1].read_bytes())
        require(manifest["target"] == target, f"incorrect installed target {target}")
        check_glue(root / "gdm-agents")
        for path in root.rglob("*"):
            require(not path.is_symlink(), f"installed asset symlink: {path}")
            require(path.name not in LEGACY_NAMES, f"legacy runtime shipped: {path}")
        require((root / "user-owned/SKILL.md").read_bytes() == b"user skill must survive\n", "unrelated skill lost")
    run([binary, "verify-manifests", *manifests], ROOT, env)


def main() -> None:
    static_gate()
    inherited_home = Path.home()
    cargo = shutil.which("cargo")
    rustc = shutil.which("rustc")
    require(cargo is not None and rustc is not None, "Cargo/Rust toolchain required")
    with tempfile.TemporaryDirectory(prefix="gdm-native-install-") as temporary:
        temp = Path(temporary)
        guards = temp / "guard-bin"
        guards.mkdir()
        interpreter_log = temp / "forbidden-interpreter.log"
        for interpreter in ("bun", "node", "npx", "tsx", "ts-node"):
            write(guards / interpreter,
                  '#!/bin/sh\nprintf "%s\\n" "$0" >> "$GDM_FORBIDDEN_INTERPRETER_LOG"\nexit 97\n', True)
        (guards / "cargo").symlink_to(cargo)
        (guards / "rustc").symlink_to(rustc)
        system_path = f"{guards}:/usr/bin:/bin:/usr/sbin:/sbin"
        base_env = {
            "PATH": system_path, "LANG": "en_US.UTF-8", "SHELL": "/bin/bash",
            "CARGO_HOME": os.environ.get("CARGO_HOME", str(inherited_home / ".cargo")),
            "RUSTUP_HOME": os.environ.get("RUSTUP_HOME", str(inherited_home / ".rustup")),
            "CARGO_TARGET_DIR": str(ROOT / "target"), "CARGO_NET_OFFLINE": "true",
            "GDM_FORBIDDEN_INTERPRETER_LOG": str(interpreter_log),
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
        }
        for name in ("RUSTUP_TOOLCHAIN", "SDKROOT", "MACOSX_DEPLOYMENT_TARGET"):
            if name in os.environ:
                base_env[name] = os.environ[name]

        def environment(home: Path) -> dict[str, str]:
            home.mkdir(parents=True, exist_ok=True)
            return dict(base_env, HOME=str(home), CODEX_HOME=str(home / ".codex"),
                        PI_CODING_AGENT_DIR=str(home / ".pi/agent"))

        source_home = temp / "source-home"
        originals = seed(source_home)
        config = b'[agents]\nmax_concurrent_threads_per_session = 4\n\n[features]\nhooks = true\n'
        hooks = (json.dumps({"description": "user-owned hooks", "hooks": {"Stop": [{"hooks": [
            {"type": "command", "command": "/opt/user/stop-hook", "timeout": 7}]}]}}, indent=2) + "\n").encode()
        write(source_home / ".codex/config.toml", config)
        write(source_home / ".codex/hooks.json", hooks)
        source_env = environment(source_home)
        print("RUN actual source installer / Cargo release build (offline, isolated HOME)", flush=True)
        run(["/bin/bash", ROOT / "install/install.sh"], ROOT, source_env, timeout=1800)
        binary = source_home / ".local/bin/gdm"
        magic = binary.read_bytes()[:4]
        require(magic in (b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe"),
                "installed gdm is not a native executable")
        require(binary.read_bytes() != originals[binary], "old executable not replaced")
        native_workflow(binary, temp / "source-work", source_env)
        check_installed_assets(binary, source_home, source_env)
        first_hooks = hook_assertions(source_home, hooks, config)
        passed("actual source install + native Work lifecycle/evidence + all three installed manifests")

        run(["/bin/bash", ROOT / "install/install.sh"], ROOT, source_env, timeout=1800)
        require(hook_assertions(source_home, hooks, config) == first_hooks, "repeat install changed hooks")
        passed("actual reinstall preserves user hooks, backup, Codex config, and unrelated skills")

        rendered = temp / "release/targets"
        for target in TARGETS:
            run([binary, "render-skills", "--target", target, "--source-root", ROOT / "skills",
                 "--agents-root", ROOT / "agents", "--output", rendered / target], ROOT, source_env)
        manifests = [rendered / target / "gdm-target-manifest.json" for target in TARGETS]
        run([binary, "verify-manifests", *manifests], ROOT, source_env)
        passed("native render-skills and verify-manifests independently produce all targets")

        assets = temp / "assets"
        assets.mkdir()
        os_name = "darwin" if sys.platform == "darwin" else "linux"
        arch = "arm64" if platform.machine() in ("arm64", "aarch64") else "x64"
        asset = assets / f"gdm-{os_name}-{arch}"
        shutil.copy2(binary, asset)
        archive = assets / "gdm-skills.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(rendered, arcname="targets")
        write(assets / "SHASUMS256.txt", "".join(
            f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in (asset, archive)))

        for variant in ("source", "remote"):
            installer = ROOT / ("install/install.sh" if variant == "source" else "install.sh")
            for scenario in ("malformed-hooks", "backup-symlink", "malformed-toml", "live-hook-lock"):
                home = temp / f"{variant}-{scenario}"
                prior = seed(home)
                env = environment(home)
                if variant == "remote":
                    env["GDM_BASE_URL"] = assets.as_uri()
                hooks_path = home / ".codex/hooks.json"
                write(hooks_path, hooks)
                if scenario == "malformed-hooks":
                    write(hooks_path, '{"hooks":[\n')
                elif scenario == "backup-symlink":
                    write(home / "backup-sentinel", b"outside backup must survive\n")
                    (home / ".codex/hooks.json.gdm-backup").symlink_to(home / "backup-sentinel")
                elif scenario == "malformed-toml":
                    write(home / ".codex/config.toml", "[features\nhooks = true\n")
                else:
                    write(home / ".codex/hooks.json.gdm-lock", f"{os.getpid()}-{'a' * 24}\n")
                prior_hooks = hooks_path.read_bytes()
                result = run(["/bin/bash", installer], ROOT, env, expect=None, timeout=1800)
                require(result.returncode != 0, f"{variant} accepted {scenario}")
                if scenario == "live-hook-lock":
                    require("transactional" in result.stdout and "agent_state_lock_timeout" in result.stderr,
                            f"{variant} rollback never reached real post-swap hook commit")
                    require((home / ".codex/hooks.json.gdm-lock").exists(), "foreign live lock removed")
                require(hooks_path.read_bytes() == prior_hooks, "rejected install changed user hooks")
                for path, data in prior.items():
                    require(path.read_bytes() == data, f"{variant}/{scenario} failed to restore {path.name}")
                if scenario == "backup-symlink":
                    require((home / "backup-sentinel").read_bytes() == b"outside backup must survive\n", "backup symlink modified target")
                no_debris(home)
                passed(f"actual {variant} installer rejects {scenario} and preserves/restores existing install")

        remote_home = temp / "remote-success"
        seed(remote_home)
        remote_env = dict(environment(remote_home), GDM_BASE_URL=assets.as_uri())
        write(remote_home / ".codex/config.toml", config)
        write(remote_home / ".codex/hooks.json", hooks)
        run(["/bin/bash", ROOT / "install.sh"], ROOT, remote_env)
        remote_binary = remote_home / ".local/bin/gdm"
        require(hashlib.sha256(remote_binary.read_bytes()).digest() == hashlib.sha256(binary.read_bytes()).digest(),
                "remote installer installed different executable")
        check_installed_assets(remote_binary, remote_home, remote_env)
        hook_assertions(remote_home, hooks, config)
        native_workflow(remote_binary, temp / "remote-work", remote_env)
        passed("actual remote installer verifies local release checksums and native lifecycle")
        require(not interpreter_log.exists(), "Bun/Node invocation attempted in native runtime/install flow")
        passed("all runtime/render/source-install/remote-install paths ran with Bun and Node denied")
    print(f"Native distribution gate: {CHECKS} checks passed. Temporary homes removed; no global installation.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, OSError, ValueError, KeyError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        raise SystemExit(1)
