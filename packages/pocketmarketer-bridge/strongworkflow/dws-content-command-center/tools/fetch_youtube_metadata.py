from __future__ import annotations

import json
from pathlib import Path

import requests

VIDEOS = {
    "SRC-001": "DEjw2Txc9oo",
    "SRC-002": "9lrPJH55rtw",
    "SRC-003": "PMoLVmTQypY",
    "SRC-004": "Pj0p9-G-DME",
    "SRC-005": "n9sBKW5UHno",
    "SRC-006": "hll8HIkKlDY",
    "SRC-007": "K31HX227ZPM",
    "SRC-008": "dG_mQ05v46Y",
    "SRC-009": "r_pmmIWu814",
    "SRC-010": "A223C62KMVg",
    "SRC-011": "DqQAFG5kW1E",
    "SRC-012": "JPprh0MeW6U",
    "SRC-013": "yK3SV5dTsi8",
    "SRC-014": "ubMrOQDxtOk",
    "SRC-015": "tgRs-9PKb_w",
    "SRC-016": "ib5ojVstPvM",
    "SRC-017": "cHjTr1943ks",
    "SRC-018": "cLSnuGR1opQ",
    "SRC-019": "gxx_s-RMvYg",
    "SRC-020": "q35pUe2kwJg",
    "SRC-021": "zS3FebPaqSw",
}

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+410; SOCS=CAI",
})


def raw_json(page: str, markers):
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


def text(value):
    if not isinstance(value, dict):
        return ""
    if isinstance(value.get("simpleText"), str):
        return value["simpleText"]
    return "".join(run.get("text", "") for run in value.get("runs", []) if isinstance(run, dict))


def chapter_renderers(value):
    found = []
    if isinstance(value, dict):
        marker = value.get("macroMarkersListItemRenderer")
        if isinstance(marker, dict):
            found.append(marker)
        for child in value.values():
            found.extend(chapter_renderers(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(chapter_renderers(child))
    return found


def main():
    output = {}
    for source_id, video_id in VIDEOS.items():
        response = SESSION.get(f"https://www.youtube.com/watch?v={video_id}&hl=en&gl=US", timeout=35)
        response.raise_for_status()
        player = raw_json(response.text, ("var ytInitialPlayerResponse =", "ytInitialPlayerResponse =", 'window[\"ytInitialPlayerResponse\"] =')) or {}
        initial = raw_json(response.text, ("var ytInitialData =", "ytInitialData =", 'window[\"ytInitialData\"] =')) or {}
        details = player.get("videoDetails") or {}
        chapters = []
        for marker in chapter_renderers(initial):
            endpoint = marker.get("onTap") or marker.get("onClick") or {}
            command = endpoint.get("watchEndpoint") or endpoint.get("commandMetadata") or {}
            start_ms = ((marker.get("timeDescription") or {}).get("simpleText") or "")
            start_seconds = None
            if isinstance(endpoint.get("watchEndpoint"), dict):
                start_seconds = endpoint["watchEndpoint"].get("startTimeSeconds")
            if start_seconds is None:
                start_seconds = ((marker.get("onTap") or {}).get("watchEndpoint") or {}).get("startTimeSeconds")
            chapters.append({
                "title": text(marker.get("title")),
                "time_text": start_ms,
                "start_seconds": start_seconds,
            })
        output[source_id] = {
            "video_id": video_id,
            "title": details.get("title", ""),
            "length_seconds": int(details.get("lengthSeconds") or 0),
            "channel_id": details.get("channelId", ""),
            "author": details.get("author", ""),
            "short_description": details.get("shortDescription", ""),
            "keywords": details.get("keywords", []),
            "chapters": chapters,
            "watch_bytes": len(response.content),
        }
        print(source_id, output[source_id]["length_seconds"], len(chapters))
    path = Path(__file__).resolve().parents[1] / "youtube-metadata.json"
    path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
