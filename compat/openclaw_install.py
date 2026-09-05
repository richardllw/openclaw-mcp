#!/usr/bin/env python3
"""Resolve the managed OpenClaw install used by the gateway.

Fail closed instead of silently falling back to an unrelated global npm copy.
The LaunchAgent ProgramArguments entry is authoritative on this macOS host.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys


GATEWAY_PLIST = Path.home() / "Library/LaunchAgents/ai.openclaw.gateway.plist"


def _validated_root(value: str | Path) -> Path | None:
    try:
        root = Path(value).expanduser().resolve()
    except OSError:
        return None
    if (root / "package.json").is_file() and (root / "dist/index.js").is_file():
        return root
    return None


def _plist_root() -> Path | None:
    if not GATEWAY_PLIST.is_file():
        return None
    try:
        with GATEWAY_PLIST.open("rb") as fh:
            payload = plistlib.load(fh)
    except (OSError, plistlib.InvalidFileException):
        return None
    for arg in payload.get("ProgramArguments", []):
        match = re.fullmatch(r"(.+)/dist/index\.js", str(arg))
        if match:
            return _validated_root(match.group(1))
    return None


def _managed_fallbacks() -> list[Path]:
    base = Path.home() / ".openclaw/tools"
    candidates = [base / "node/lib/node_modules/openclaw"]
    candidates.extend(sorted(base.glob("node-v*/lib/node_modules/openclaw"), reverse=True))
    exe = shutil.which("openclaw")
    if exe:
        resolved = Path(exe).resolve()
        if str(resolved).startswith(str(base.resolve()) + os.sep):
            candidates.append(resolved.parent)
    return candidates


def find_openclaw_root() -> Path:
    override = os.environ.get("OPENCLAW_INSTALL_ROOT")
    if override:
        root = _validated_root(override)
        if root:
            return root
        raise RuntimeError(f"OPENCLAW_INSTALL_ROOT is not a valid OpenClaw install: {override}")
    root = _plist_root()
    if root:
        return root
    for candidate in _managed_fallbacks():
        root = _validated_root(candidate)
        if root:
            return root
    raise RuntimeError(
        "managed OpenClaw install not found; expected the gateway LaunchAgent or ~/.openclaw/tools/node*"
    )


def find_running_openclaw_root() -> Path | None:
    try:
        commands = subprocess.check_output(["/bin/ps", "-axo", "command="], text=True)
    except (OSError, subprocess.SubprocessError):
        return None
    pattern = re.compile(r"(/\S+/lib/node_modules/openclaw)/dist/index\.js\s+gateway(?:\s|$)")
    for command in commands.splitlines():
        match = pattern.search(command)
        if match:
            return _validated_root(match.group(1))
    return None


def assert_running_match() -> tuple[Path, Path]:
    configured = find_openclaw_root()
    running = find_running_openclaw_root()
    if running is None:
        raise RuntimeError("OpenClaw gateway process not found")
    if configured != running:
        raise RuntimeError(f"configured OpenClaw root {configured} != running gateway root {running}")
    return configured, running


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--running-root", action="store_true")
    group.add_argument("--assert-running", action="store_true")
    args = parser.parse_args()
    try:
        if args.running_root:
            root = find_running_openclaw_root()
            if root is None:
                raise RuntimeError("OpenClaw gateway process not found")
            print(root)
        elif args.assert_running:
            configured, _ = assert_running_match()
            print(configured)
        else:
            print(find_openclaw_root())
        return 0
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
