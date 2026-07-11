from __future__ import annotations

import argparse
import json
import os
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from faster_whisper import WhisperModel

TARGETS = {
    "SRC-006": {
        "video_id": "hll8HIkKlDY",
        "title": "Mailbox Money From Buying Cash-Flowing Businesses",
        "kind": "youtube",
    },
    "SRC-017": {
        "video_id": "cHjTr1943ks",
        "title": "Carlos Reyes on Buying Cash-Flowing Businesses (Instead of Building)",
        "kind": "podcast",
    },
}

PIPED_BASES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.reallyaweso.me",
    "https://pipedapi.r4fo.com",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.darkness.services",
]

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "Mozilla/5.0"})


def podcast_audio(title: str):
    response = SESSION.get("https://rss.buzzsprout.com/2306481.rss", timeout=30)
    response.raise_for_status()
    root = ET.fromstring(response.content)
    for item in root.findall(".//item"):
        if (item.findtext("title") or "").strip() != title:
            continue
        enclosure = item.find("enclosure")
        if enclosure is None or not enclosure.attrib.get("url"):
            raise RuntimeError("Podcast enclosure URL missing")
        return enclosure.attrib["url"], {"provider": "buzzsprout-rss", "type": enclosure.attrib.get("type", ""), "length": enclosure.attrib.get("length", "")}
    raise RuntimeError("Podcast episode not found")


def youtube_audio(video_id: str):
    attempts = []
    for base in PIPED_BASES:
        try:
            response = SESSION.get(f"{base}/streams/{video_id}", timeout=25)
            attempts.append({"base": base, "status": response.status_code, "bytes": len(response.content)})
            response.raise_for_status()
            payload = response.json()
            streams = payload.get("audioStreams") or []
            candidates = [stream for stream in streams if stream.get("url")]
            if not candidates:
                continue
            candidates.sort(key=lambda stream: (stream.get("bitrate") or 10**12, stream.get("quality") or ""))
            selected = candidates[0]
            return selected["url"], {
                "provider": base,
                "mime_type": selected.get("mimeType", ""),
                "bitrate": selected.get("bitrate"),
                "quality": selected.get("quality", ""),
                "attempts": attempts,
            }
        except Exception as error:
            attempts[-1]["error"] = f"{type(error).__name__}: {error}"
    raise RuntimeError(json.dumps(attempts))


def download(url: str, path: Path):
    with SESSION.get(url, timeout=60, stream=True) as response:
        response.raise_for_status()
        size = 0
        with path.open("wb") as handle:
            for chunk in response.iter_content(1024 * 1024):
                if not chunk:
                    continue
                handle.write(chunk)
                size += len(chunk)
    return size


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source_id", choices=sorted(TARGETS))
    parser.add_argument("--output-dir", default="target-transcripts")
    args = parser.parse_args()
    target = TARGETS[args.source_id]
    audio_url, source_debug = podcast_audio(target["title"]) if target["kind"] == "podcast" else youtube_audio(target["video_id"])
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        audio_path = Path(directory) / "source-audio"
        audio_bytes = download(audio_url, audio_path)
        model = WhisperModel("tiny.en", device="cpu", compute_type="int8", cpu_threads=max(2, os.cpu_count() or 2))
        segments, info = model.transcribe(str(audio_path), beam_size=1, best_of=1, vad_filter=True, condition_on_previous_text=True)
        transcript = [
            {"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()}
            for segment in segments
            if segment.text.strip()
        ]
    result = {
        "source_id": args.source_id,
        "video_id": target["video_id"],
        "title": target["title"],
        "source_debug": source_debug,
        "audio_bytes": audio_bytes,
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "segment_count": len(transcript),
        "segments": transcript,
    }
    (output_dir / f"{args.source_id}.json").write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
