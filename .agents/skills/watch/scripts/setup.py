#!/usr/bin/env python3
"""Preflight and setup helper for the Codex /watch skill."""

from __future__ import annotations

import json
import os
import platform
import shutil
import sys
from pathlib import Path

REQUIRED_BINARIES = ["ffmpeg", "ffprobe", "yt-dlp"]
CONFIG_DIR = Path.home() / ".config" / "watch"
CONFIG_FILE = CONFIG_DIR / ".env"
ENV_TEMPLATE = """# /watch API configuration
# Whisper transcription fallback is used only when captions are unavailable.
# Groq is preferred; OpenAI is the fallback.
GROQ_API_KEY=
OPENAI_API_KEY=
"""


def which_missing() -> list[str]:
    return [name for name in REQUIRED_BINARIES if shutil.which(name) is None]


def secure_config_permissions() -> None:
    if CONFIG_FILE.exists() and CONFIG_FILE.stat().st_mode & 0o044:
        print(f"[watch] WARNING: {CONFIG_FILE} is readable by other users. Run: chmod 600 {CONFIG_FILE}", file=sys.stderr)


def read_env_key(name: str) -> str | None:
    if os.environ.get(name, "").strip():
        return os.environ[name].strip()
    if not CONFIG_FILE.exists():
        return None
    secure_config_permissions()
    for line in CONFIG_FILE.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        if key.strip() == name and value.strip():
            return value.strip().strip("'\"")
    return None


def api_key_status() -> tuple[bool, str | None]:
    if read_env_key("GROQ_API_KEY"):
        return True, "groq"
    if read_env_key("OPENAI_API_KEY"):
        return True, "openai"
    return False, None


def ensure_config() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_FILE.exists():
        CONFIG_FILE.write_text(ENV_TEMPLATE)
    CONFIG_FILE.chmod(0o600)


def status() -> dict[str, object]:
    missing = which_missing()
    has_key, backend = api_key_status()
    return {
        "status": "ready" if not missing else "needs_install",
        "missing_binaries": missing,
        "whisper_backend": backend,
        "has_api_key": has_key,
        "config_file": str(CONFIG_FILE),
        "platform": platform.system(),
    }


def brew_packages(missing: list[str]) -> list[str]:
    return list(dict.fromkeys("ffmpeg" if name in ("ffmpeg", "ffprobe") else name for name in missing))


def install_hint(system: str, missing: list[str]) -> str:
    packages = brew_packages(missing)
    if system == "Darwin":
        return f"brew install {' '.join(packages)}"
    if system == "Linux":
        return "sudo apt install ffmpeg && pipx install yt-dlp  # or: sudo dnf install ffmpeg && pipx install yt-dlp"
    if system == "Windows":
        return "winget install Gyan.FFmpeg yt-dlp.yt-dlp"
    return f"Install these tools manually: {', '.join(missing)}"


def run_check(strict: bool = False) -> int:
    current = status()
    if not current["missing_binaries"]:
        print("[watch] dependencies ready")
        return 0
    print(
        f"[watch] missing binaries: {', '.join(current['missing_binaries'])}. Run: python3 {Path(__file__).resolve()}",
        file=sys.stderr,
    )
    print("[watch] check completed; dependencies are not installed in this environment", file=sys.stderr)
    return 2 if strict else 0


def run_install() -> int:
    ensure_config()
    missing = which_missing()
    if not missing:
        print(f"[setup] dependencies ready. Config: {CONFIG_FILE}")
    else:
        print("[setup] dependencies missing. Install them with:", file=sys.stderr)
        print(f"  {install_hint(platform.system(), missing)}", file=sys.stderr)
        print("[setup] guardrail: no packages were installed automatically", file=sys.stderr)
        print(f"[setup] config scaffolded at {CONFIG_FILE}")
        return 2

    has_key, backend = api_key_status()
    if has_key:
        print(f"[setup] Whisper backend available: {backend}")
        return 0
    print(f"[setup] optional: add GROQ_API_KEY or OPENAI_API_KEY in {CONFIG_FILE} for Whisper fallback")
    return 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        return run_check("--strict" in sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "--strict-check":
        return run_check(True)
    if len(sys.argv) > 1 and sys.argv[1] == "--json":
        print(json.dumps(status(), indent=2))
        return 0
    return run_install()


if __name__ == "__main__":
    raise SystemExit(main())
