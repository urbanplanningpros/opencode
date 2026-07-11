from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

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

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+410; SOCS=CAI",
})


def compact_segments(segments):
    result = []
    for segment in segments:
        text = re.sub(r"\s+", " ", str(segment.get("text", ""))).strip()
        if not text:
            continue
        result.append({
            "start": round(float(segment.get("start", 0)), 3),
            "duration": round(float(segment.get("duration", 0)), 3),
            "text": text,
        })
    return result


def transcript_api(video_id: str):
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    try:
        fetched = api.fetch(video_id, languages=["en", "en-US", "en-GB"])
        raw = fetched.to_raw_data() if hasattr(fetched, "to_raw_data") else list(fetched)
        return compact_segments(raw), {"method": "youtube_transcript_api.fetch"}
    except Exception as first_error:
        try:
            raw = YouTubeTranscriptApi.get_transcript(video_id, languages=["en", "en-US", "en-GB"])
            return compact_segments(raw), {"method": "youtube_transcript_api.get_transcript"}
        except Exception as second_error:
            return [], {"method": "youtube_transcript_api", "error": f"{type(first_error).__name__}: {first_error}; fallback: {type(second_error).__name__}: {second_error}"}


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
            value, _ = decoder.raw_decode(page[start:])
            return value
        except json.JSONDecodeError:
            continue
    return None


def player_response(video_id: str):
    url = f"https://www.youtube.com/watch?v={video_id}&hl=en&gl=US"
    response = SESSION.get(url, timeout=35)
    response.raise_for_status()
    value = raw_json_after(response.text, ("var ytInitialPlayerResponse =", "ytInitialPlayerResponse =", 'window[\"ytInitialPlayerResponse\"] ='))
    if value:
        return value, {"watch_status": response.status_code, "watch_bytes": len(response.content), "player_found": True}
    match = re.search(r'"playerResponse":"((?:\\.|[^"\\])*)"', response.text)
    if match:
        try:
            decoded = json.loads('"' + match.group(1) + '"')
            return json.loads(decoded), {"watch_status": response.status_code, "watch_bytes": len(response.content), "player_found": True, "player_source": "escaped"}
        except Exception:
            pass
    return None, {"watch_status": response.status_code, "watch_bytes": len(response.content), "player_found": False}


def direct_caption(video_id: str):
    try:
        player, debug = player_response(video_id)
    except Exception as error:
        return [], {"method": "direct_caption", "error": f"{type(error).__name__}: {error}"}
    tracks = (((player or {}).get("captions") or {}).get("playerCaptionsTracklistRenderer") or {}).get("captionTracks") or []
    debug["caption_tracks"] = [{"languageCode": track.get("languageCode"), "name": ((track.get("name") or {}).get("simpleText") or ""), "kind": track.get("kind", "")} for track in tracks]
    if not tracks:
        debug["method"] = "direct_caption"
        return [], debug
    track = next((item for item in tracks if str(item.get("languageCode", "")).lower().startswith("en") and item.get("kind") != "asr"), None)
    track = track or next((item for item in tracks if str(item.get("languageCode", "")).lower().startswith("en")), None) or tracks[0]
    base_url = track.get("baseUrl", "")
    if not base_url:
        return [], {**debug, "method": "direct_caption", "error": "caption baseUrl missing"}
    separator = "&" if "?" in base_url else "?"
    response = SESSION.get(base_url + separator + "fmt=json3", timeout=35)
    debug.update(method="direct_caption", caption_status=response.status_code, caption_bytes=len(response.content), selected_language=track.get("languageCode"), selected_kind=track.get("kind", ""))
    response.raise_for_status()
    payload = response.json()
    segments = []
    for event in payload.get("events", []):
        text = "".join(part.get("utf8", "") for part in event.get("segs", []) if isinstance(part, dict)).replace("\n", " ")
        if not text.strip():
            continue
        segments.append({"start": event.get("tStartMs", 0) / 1000, "duration": event.get("dDurationMs", 0) / 1000, "text": text})
    return compact_segments(segments), debug


def main():
    output = {}
    for source_id, video_id in VIDEOS.items():
        segments, debug = transcript_api(video_id)
        if not segments:
            segments, direct_debug = direct_caption(video_id)
            debug["direct"] = direct_debug
        output[source_id] = {
            "video_id": video_id,
            "youtube_url": f"https://www.youtube.com/watch?v={video_id}",
            "segment_count": len(segments),
            "duration_seconds": round(max((segment["start"] + segment["duration"] for segment in segments), default=0), 3),
            "debug": debug,
            "segments": segments,
        }
        print(source_id, len(segments), debug.get("method"))
    path = Path(__file__).resolve().parents[1] / "youtube-transcripts.json"
    path.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
