#!/usr/bin/env python3
"""Create a timestamped visual/transcript report for a video URL or local file."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

MAX_FPS = 2.0
MAX_FRAMES = 100
CONFIG_FILE = Path.home() / ".config" / "watch" / ".env"


def run(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def require_binary(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f"Missing required binary: {name}. Run scripts/setup.py first.")


def is_url(source: str) -> bool:
    return source.startswith(("http://", "https://"))


def parse_time(value: str | None) -> float | None:
    if value is None:
        return None
    parts = value.split(":")
    if len(parts) == 1:
        return float(parts[0])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    raise SystemExit(f"Invalid time value: {value}")


def format_time(seconds: float) -> str:
    rounded = max(0, int(round(seconds)))
    hours = rounded // 3600
    minutes = (rounded % 3600) // 60
    secs = rounded % 60
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def auto_fps(duration: float, max_frames: int) -> tuple[float, int]:
    target = 30 if duration <= 30 else 40 if duration <= 60 else 60 if duration <= 180 else 80 if duration <= 600 else MAX_FRAMES
    target = min(target, max_frames, MAX_FRAMES)
    return min(MAX_FPS, max(1 / max(duration, 1), target / max(duration, 1))), target


def auto_fps_focus(duration: float, max_frames: int) -> tuple[float, int]:
    target = 10 if duration <= 5 else 30 if duration <= 15 else 60 if duration <= 30 else 80 if duration <= 60 else MAX_FRAMES
    target = min(target, max_frames, MAX_FRAMES)
    return min(MAX_FPS, max(1 / max(duration, 1), target / max(duration, 1))), target


def probe(video: Path) -> dict[str, float | int | str | None]:
    result = run([
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,codec_name:format=duration",
        "-of",
        "json",
        str(video),
    ])
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "ffprobe failed")
    data = json.loads(result.stdout)
    stream = (data.get("streams") or [{}])[0]
    return {
        "duration": float((data.get("format") or {}).get("duration") or 0),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "codec": stream.get("codec_name"),
    }


def download(source: str, out_dir: Path) -> tuple[Path, Path | None, dict[str, object]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    if not is_url(source):
        video = Path(source).expanduser().resolve()
        if not video.exists():
            raise SystemExit(f"Local video not found: {video}")
        return video, None, {}

    output = out_dir / "video.%(ext)s"
    command = [
        "yt-dlp",
        "--no-playlist",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "en.*,en",
        "--sub-format",
        "vtt/best",
        "--convert-subs",
        "vtt",
        "--print-json",
        "-o",
        str(output),
        source,
    ]
    result = run(command)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "yt-dlp failed")
    info = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {}
    videos = sorted(out_dir.glob("video.*"))
    subtitles = sorted(path for path in out_dir.glob("video*.vtt") if path.is_file())
    video = next((path for path in videos if path.suffix != ".vtt"), None)
    if video is None:
        raise SystemExit("yt-dlp did not produce a video file")
    return video, subtitles[0] if subtitles else None, info


def extract_frames(video: Path, frame_dir: Path, fps: float, width: int, max_frames: int, start: float | None, end: float | None) -> list[dict[str, object]]:
    frame_dir.mkdir(parents=True, exist_ok=True)
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if start is not None:
        command.extend(["-ss", str(start)])
    command.extend(["-i", str(video)])
    if end is not None:
        command.extend(["-to", str(end - (start or 0)) if start is not None else str(end)])
    command.extend([
        "-vf",
        f"fps={fps},scale={width}:-1",
        "-frames:v",
        str(min(max_frames, MAX_FRAMES)),
        "-q:v",
        "3",
        str(frame_dir / "frame_%04d.jpg"),
    ])
    result = run(command)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "ffmpeg frame extraction failed")
    return [
        {"path": str(path), "timestamp": (start or 0) + index / fps}
        for index, path in enumerate(sorted(frame_dir.glob("frame_*.jpg")))
    ]


def read_key(name: str) -> str | None:
    if os.environ.get(name, "").strip():
        return os.environ[name].strip()
    if not CONFIG_FILE.exists():
        return None
    for line in CONFIG_FILE.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        if key.strip() == name and value.strip():
            return value.strip().strip("'\"")
    return None


def parse_vtt(path: Path) -> list[tuple[float, float, str]]:
    timestamp = re.compile(r"(\d+:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(\d+:)?\d{2}:\d{2}\.\d{3}")
    blocks = re.split(r"\n\s*\n", path.read_text(errors="replace"))
    segments: list[tuple[float, float, str]] = []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        timing = next((line for line in lines if timestamp.search(line)), None)
        if timing is None:
            continue
        start_raw, _, end_raw = timing.partition("-->")
        text = " ".join(re.sub(r"<[^>]+>", "", line) for line in lines[lines.index(timing) + 1 :])
        if text:
            segments.append((parse_time(start_raw.strip().split()[0]) or 0, parse_time(end_raw.strip().split()[0]) or 0, text))
    return segments


def transcript_from_whisper(video: Path, audio: Path, backend: str, api_key: str, start: float | None, end: float | None) -> str:
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if start is not None:
        command.extend(["-ss", str(start)])
    command.extend(["-i", str(video)])
    if end is not None:
        command.extend(["-to", str(end - (start or 0)) if start is not None else str(end)])
    command.extend(["-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", str(audio)])
    result = run(command)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "ffmpeg audio extraction failed")

    url = "https://api.groq.com/openai/v1/audio/transcriptions" if backend == "groq" else "https://api.openai.com/v1/audio/transcriptions"
    model = "whisper-large-v3" if backend == "groq" else "whisper-1"
    boundary = "----watchboundary"
    body = b"".join([
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{model}\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\nverbose_json\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode(),
        audio.read_bytes(),
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    request = urllib.request.Request(url, data=body, headers={"Authorization": f"Bearer {api_key}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(request, timeout=120) as response:
        data = json.loads(response.read().decode())
    if data.get("segments"):
        return "\n".join(f"[{format_time(segment['start'] + (start or 0))} → {format_time(segment['end'] + (start or 0))}] {segment['text'].strip()}" for segment in data["segments"])
    return data.get("text", "")


def format_segments(segments: list[tuple[float, float, str]], start: float | None, end: float | None) -> str:
    selected = [segment for segment in segments if (start is None or segment[1] >= start) and (end is None or segment[0] <= end)]
    return "\n".join(f"[{format_time(segment[0])} → {format_time(segment[1])}] {segment[2]}" for segment in selected)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download/probe a video, extract frames, and print a report.")
    parser.add_argument("source")
    parser.add_argument("--max-frames", type=int, default=80)
    parser.add_argument("--resolution", type=int, default=512)
    parser.add_argument("--fps", type=float)
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--out-dir")
    parser.add_argument("--whisper", choices=["groq", "openai"])
    parser.add_argument("--allow-transcription-upload", action="store_true")
    parser.add_argument("--local-only", action="store_true")
    parser.add_argument("--no-network", action="store_true")
    parser.add_argument("--no-whisper", action="store_true")
    args = parser.parse_args()

    if args.local_only and is_url(args.source):
        raise SystemExit("--local-only rejects URL sources")
    if args.no_network and is_url(args.source):
        raise SystemExit("--no-network rejects URL sources")
    if args.no_network and args.allow_transcription_upload:
        raise SystemExit("--no-network cannot be combined with --allow-transcription-upload")
    if args.whisper and not args.allow_transcription_upload:
        raise SystemExit("--whisper requires --allow-transcription-upload to make external audio upload explicit")

    for binary in ["ffmpeg", "ffprobe", "yt-dlp"] if is_url(args.source) else ["ffmpeg", "ffprobe"]:
        require_binary(binary)

    work = Path(args.out_dir).expanduser().resolve() if args.out_dir else Path(tempfile.mkdtemp(prefix="watch-"))
    work.mkdir(parents=True, exist_ok=True)
    print(f"[watch] working dir: {work}", file=sys.stderr)

    video, subtitles, info = download(args.source, work / "download")
    metadata = probe(video)
    duration = float(metadata["duration"] or 0)
    start = parse_time(args.start)
    end = parse_time(args.end) or duration
    if start is not None and end <= start:
        raise SystemExit("--end must be greater than --start")
    effective_duration = max(0.1, end - (start or 0))
    focused = start is not None or args.end is not None
    fps, target = auto_fps_focus(effective_duration, args.max_frames) if focused else auto_fps(effective_duration, args.max_frames)
    if args.fps is not None:
        fps = min(MAX_FPS, args.fps)
        target = min(MAX_FRAMES, args.max_frames, math.ceil(fps * effective_duration))

    frames = extract_frames(video, work / "frames", fps, args.resolution, min(args.max_frames, MAX_FRAMES), start, end if focused else None)
    transcript = ""
    transcript_source = "none"
    if subtitles:
        transcript = format_segments(parse_vtt(subtitles), start, end if focused else None)
        transcript_source = "captions" if transcript else "captions (no lines in range)"
    if not transcript and not args.no_whisper and args.allow_transcription_upload and args.whisper:
        api_key = read_key("GROQ_API_KEY") if args.whisper == "groq" else read_key("OPENAI_API_KEY")
        if api_key:
            transcript = transcript_from_whisper(video, work / "audio.mp3", args.whisper, api_key, start, end if focused else None)
            transcript_source = f"whisper ({args.whisper})"

    print("\n# watch: video report\n")
    print(f"- **Source:** {args.source}")
    if info.get("title"):
        print(f"- **Title:** {info['title']}")
    print(f"- **Duration:** {format_time(duration)} ({duration:.1f}s)")
    if focused:
        print(f"- **Focus range:** {format_time(start or 0)} → {format_time(end)}")
    print(f"- **Resolution:** {metadata['width']}x{metadata['height']} ({metadata['codec'] or 'unknown codec'})")
    print(f"- **Frames:** {len(frames)} @ {fps:.3f} fps (budget {target}, max {min(args.max_frames, MAX_FRAMES)})")
    print(f"- **Transcript:** {transcript_source}")
    if not focused and duration > 600:
        print("\n> Warning: long video; frame coverage is sparse. Re-run with --start/--end for detailed analysis.")
    print("\n## Frames\n")
    print("Inspect each frame path below as an image:\n")
    for frame in frames:
        print(f"- `{frame['path']}` (t={format_time(float(frame['timestamp']))})")
    print("\n## Transcript\n")
    print("```")
    print(transcript or "No transcript available; proceed with frames only.")
    print("```")
    print("\n---")
    print(f"_Work dir: `{work}` — delete when done._")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
