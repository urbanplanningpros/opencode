from __future__ import annotations

import html
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urljoin

import requests

VIDEOS = {
    "SRC-001": "DEjw2Txc9oo",
    "SRC-002": "9lrPJH55rtw",
    "SRC-003": "PMoLVmTQypY",
    "SRC-004": "Pj0p9-G-DME",
    "SRC-006": "hll8HIkKlDY",
    "SRC-007": "K31HX227ZPM",
    "SRC-011": "DqQAFG5kW1E",
    "SRC-013": "yK3SV5dTsi8",
    "SRC-016": "ib5ojVstPvM",
    "SRC-017": "cHjTr1943ks",
}

PIPED_BASES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.reallyaweso.me",
    "https://pipedapi.r4fo.com",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.darkness.services",
]

INVIDIOUS_BASES = [
    "https://inv.zoomerville.com",
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://invidious.f5.si",
    "https://yt.chocolatemoo53.com",
]

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+410; SOCS=CAI",
})


def compact_segments(segments):
    result = []
    for segment in segments:
        text = re.sub(r"\s+", " ", html.unescape(str(segment.get("text", "")))).strip()
        if not text:
            continue
        result.append({
            "start": round(float(segment.get("start", 0)), 3),
            "duration": round(float(segment.get("duration", 0)), 3),
            "text": text,
        })
    return result


def clock_seconds(value: str) -> float:
    parts = value.replace(",", ".").split(":")
    try:
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        return float(parts[0])
    except Exception:
        return 0.0


def parse_caption_response(response):
    body = response.text.strip()
    content_type = response.headers.get("content-type", "")
    segments = []
    if "json" in content_type or body.startswith("{") or body.startswith("["):
        try:
            payload = response.json()
        except Exception:
            payload = None
        if isinstance(payload, dict) and isinstance(payload.get("events"), list):
            for event in payload["events"]:
                text = "".join(part.get("utf8", "") for part in event.get("segs", []) if isinstance(part, dict)).replace("\n", " ")
                segments.append({"start": event.get("tStartMs", 0) / 1000, "duration": event.get("dDurationMs", 0) / 1000, "text": text})
        elif isinstance(payload, list):
            for item in payload:
                if not isinstance(item, dict):
                    continue
                segments.append({"start": item.get("start", item.get("startTime", 0)), "duration": item.get("duration", 0), "text": item.get("text", item.get("content", ""))})
    if not segments and (body.startswith("<?xml") or "<transcript" in body or "<text " in body):
        try:
            root = ET.fromstring(body)
            for node in root.iter():
                if node.tag.rsplit("}", 1)[-1] not in {"text", "p"}:
                    continue
                start = node.attrib.get("start", node.attrib.get("t", "0"))
                duration = node.attrib.get("dur", node.attrib.get("d", "0"))
                if "t" in node.attrib:
                    start = float(start) / 1000
                if "d" in node.attrib:
                    duration = float(duration) / 1000
                segments.append({"start": start, "duration": duration, "text": "".join(node.itertext())})
        except Exception:
            pass
    if not segments and "-->" in body:
        blocks = re.split(r"\n\s*\n", body.replace("\r", ""))
        for block in blocks:
            lines = [line.strip() for line in block.split("\n") if line.strip()]
            timing_index = next((index for index, line in enumerate(lines) if "-->" in line), None)
            if timing_index is None:
                continue
            timing = lines[timing_index].split("-->")
            start = clock_seconds(timing[0].strip().split(" ")[0])
            end = clock_seconds(timing[1].strip().split(" ")[0])
            text = " ".join(re.sub(r"<[^>]+>", "", line) for line in lines[timing_index + 1 :])
            segments.append({"start": start, "duration": max(0, end - start), "text": text})
    return compact_segments(segments)


def transcript_api(video_id: str):
    from youtube_transcript_api import YouTubeTranscriptApi

    try:
        fetched = YouTubeTranscriptApi().fetch(video_id, languages=["en", "en-US", "en-GB"])
        raw = fetched.to_raw_data() if hasattr(fetched, "to_raw_data") else list(fetched)
        return compact_segments(raw), {"method": "youtube_transcript_api.fetch"}
    except Exception as error:
        return [], {"method": "youtube_transcript_api", "error": f"{type(error).__name__}: {error}"}


def raw_json_after(page: str, markers: tuple[str, ...]):
    decoder = json.JSONDecoder()
    for marker in markers:
        position = page.find(marker)
        if position < 0:
            continue
        start = page.find("{", position + len(marker))
        if start < 0:
            continue
        try:
            return decoder.raw_decode(page[start:])[0]
        except json.JSONDecodeError:
            continue
    return None


def direct_caption(video_id: str):
    debug = {"method": "direct_caption"}
    try:
        response = SESSION.get(f"https://www.youtube.com/watch?v={video_id}&hl=en&gl=US", timeout=30)
        debug.update(watch_status=response.status_code, watch_bytes=len(response.content))
        response.raise_for_status()
        player = raw_json_after(response.text, ("var ytInitialPlayerResponse =", "ytInitialPlayerResponse =", 'window[\"ytInitialPlayerResponse\"] ='))
    except Exception as error:
        debug["error"] = f"{type(error).__name__}: {error}"
        return [], debug
    tracks = (((player or {}).get("captions") or {}).get("playerCaptionsTracklistRenderer") or {}).get("captionTracks") or []
    debug["caption_tracks"] = [{"languageCode": track.get("languageCode"), "kind": track.get("kind", "")} for track in tracks]
    track = next((item for item in tracks if str(item.get("languageCode", "")).lower().startswith("en") and item.get("kind") != "asr"), None)
    track = track or next((item for item in tracks if str(item.get("languageCode", "")).lower().startswith("en")), None) or (tracks[0] if tracks else None)
    if not track or not track.get("baseUrl"):
        return [], debug
    separator = "&" if "?" in track["baseUrl"] else "?"
    try:
        caption = SESSION.get(track["baseUrl"] + separator + "fmt=json3", timeout=30)
        debug.update(caption_status=caption.status_code, caption_bytes=len(caption.content))
        caption.raise_for_status()
        return parse_caption_response(caption), debug
    except Exception as error:
        debug["caption_error"] = f"{type(error).__name__}: {error}"
        return [], debug


def caption_track_payload(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("captions", "subtitles", "tracks"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return []


def preferred_tracks(tracks):
    def language(track):
        return str(track.get("code") or track.get("languageCode") or track.get("language_code") or track.get("label") or track.get("name") or "").lower()
    english = [track for track in tracks if "english" in language(track) or language(track).startswith("en")]
    return english or tracks


def fetch_track(base: str, track: dict, debug: dict):
    value = track.get("url") or track.get("baseUrl") or track.get("href")
    if not value:
        return []
    url = urljoin(base + "/", value)
    for suffix in ("", "&fmt=json3" if "?" in url else "?fmt=json3"):
        try:
            response = SESSION.get(url + suffix, timeout=30)
            debug.setdefault("track_fetches", []).append({"url": url + suffix, "status": response.status_code, "bytes": len(response.content)})
            response.raise_for_status()
            segments = parse_caption_response(response)
            if segments:
                return segments
        except Exception as error:
            debug.setdefault("track_errors", []).append(f"{url + suffix}: {type(error).__name__}: {error}")
    return []


def proxy_caption(video_id: str):
    debug = {"method": "proxy_caption", "piped": [], "invidious": []}
    for base in PIPED_BASES:
        try:
            response = SESSION.get(f"{base}/captions/{video_id}", timeout=20)
            entry = {"base": base, "status": response.status_code, "bytes": len(response.content)}
            response.raise_for_status()
            tracks = caption_track_payload(response.json())
            entry["tracks"] = len(tracks)
            debug["piped"].append(entry)
            for track in preferred_tracks(tracks):
                segments = fetch_track(base, track, debug)
                if segments:
                    debug["provider"] = base
                    debug["track"] = track
                    return segments, debug
        except Exception as error:
            debug["piped"].append({"base": base, "error": f"{type(error).__name__}: {error}"})
    for base in INVIDIOUS_BASES:
        try:
            response = SESSION.get(f"{base}/api/v1/captions/{video_id}", timeout=20)
            entry = {"base": base, "status": response.status_code, "bytes": len(response.content)}
            response.raise_for_status()
            tracks = caption_track_payload(response.json())
            entry["tracks"] = len(tracks)
            debug["invidious"].append(entry)
            for track in preferred_tracks(tracks):
                segments = fetch_track(base, track, debug)
                if segments:
                    debug["provider"] = base
                    debug["track"] = track
                    return segments, debug
        except Exception as error:
            debug["invidious"].append({"base": base, "error": f"{type(error).__name__}: {error}"})
    return [], debug


def main():
    output = {}
    for source_id, video_id in VIDEOS.items():
        attempts = []
        segments, debug = transcript_api(video_id)
        attempts.append(debug)
        if not segments:
            segments, debug = proxy_caption(video_id)
            attempts.append(debug)
        if not segments:
            segments, debug = direct_caption(video_id)
            attempts.append(debug)
        output[source_id] = {
            "video_id": video_id,
            "youtube_url": f"https://www.youtube.com/watch?v={video_id}",
            "segment_count": len(segments),
            "duration_seconds": round(max((segment["start"] + segment["duration"] for segment in segments), default=0), 3),
            "attempts": attempts,
            "segments": segments,
        }
        print(source_id, len(segments), attempts[-1].get("method"))
    path = Path(__file__).resolve().parents[1] / "youtube-transcripts.json"
    path.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
