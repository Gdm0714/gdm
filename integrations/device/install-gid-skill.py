#!/usr/bin/env python3
"""Copy the provider-neutral device skill, preserving any previous installation."""

import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import tempfile
import uuid


PAYLOAD = ("SKILL.md", "README.md", "example.json")


def same_payload(source: Path, destination: Path) -> bool:
    if destination.is_symlink() or not destination.is_dir():
        return False
    if {entry.name for entry in destination.iterdir()} != set(PAYLOAD):
        return False
    return all(
        not (destination / name).is_symlink()
        and (destination / name).is_file()
        and (destination / name).read_bytes() == (source / name).read_bytes()
        for name in PAYLOAD
    )


def install(source: Path, destination: Path, dry_run: bool) -> None:
    for name in PAYLOAD:
        if not (source / name).is_file():
            raise ValueError(f"Missing source file: {source / name}")
    # Resolve parents, but never follow an existing destination symlink.
    destination = destination.parent.resolve() / destination.name
    if destination == Path.home().resolve() or destination == Path(destination.anchor):
        raise ValueError("Choose a skill directory, not the home or filesystem root")
    if destination == source or destination in source.parents or source in destination.parents:
        raise ValueError("Destination must be separate from the source directory and its parents")
    if same_payload(source, destination):
        print(f"Already current: {destination}")
        return
    previous = destination.exists() or destination.is_symlink()
    # gid discovers SKILL.md recursively; keep default backups outside skills.
    backup_parent = (destination.parent.parent / "skill-backups"
                     if destination.parent.name == "skills" else destination.parent)
    if dry_run:
        print(f"Would install {', '.join(PAYLOAD)} into {destination}")
        if previous:
            print(f"Would preserve the existing path under {backup_parent}")
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix=f".{destination.name}.install-", dir=destination.parent))
    backup = None
    try:
        for name in PAYLOAD:
            shutil.copy2(source / name, staged / name)
        if previous:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup_parent.mkdir(parents=True, exist_ok=True)
            backup = backup_parent / f"{destination.name}.backup-{stamp}-{uuid.uuid4().hex[:8]}"
            destination.rename(backup)
        staged.rename(destination)
    except BaseException:
        if backup is not None and not destination.exists() and not destination.is_symlink():
            backup.rename(destination)
        raise
    finally:
        if staged.exists():
            shutil.rmtree(staged)
    print(f"Installed: {destination}")
    if backup is not None:
        print(f"Previous contents preserved: {backup}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--destination",
        type=Path,
        default=Path.home() / ".agents" / "skills" / "gdm-device",
        help="Full destination skill directory (default: ~/.agents/skills/gdm-device)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Describe changes without writing files")
    args = parser.parse_args()
    destination = Path(os.path.abspath(args.destination.expanduser()))
    try:
        install(Path(__file__).resolve().parent, destination, args.dry_run)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Install failed: {error}\n")


if __name__ == "__main__":
    main()
