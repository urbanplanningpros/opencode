from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

RSS_URLS = [
    "https://rss.buzzsprout.com/2306481.rss",
    "https://feeds.buzzsprout.com/2306481.rss",
]
TARGETS = {
    "SRC-016": "How These Dealmakers Bought Their First (and Multiple) Businesses!",
    "SRC-017": "Carlos Reyes on Buying Cash-Flowing Businesses (Instead of Building)",
}

session = requests.Session()
session.headers.update({"User-Agent": "Mozilla/5.0"})

rss = None
rss_debug = []
for url in RSS_URLS:
    try:
        response = session.get(url, timeout=30)
        rss_debug.append({"url": url, "status": response.status_code, "bytes": len(response.content), "final_url": response.url})
        response.raise_for_status()
        rss = response.content
        break
    except Exception as error:
        rss_debug.append({"url": url, "error": f"{type(error).__name__}: {error}"})

if rss is None:
    raise SystemExit(json.dumps(rss_debug))

root = ET.fromstring(rss)
items = root.findall(".//item")
output = {"rss_debug": rss_debug, "sources": {}}

for source_id, wanted_title in TARGETS.items():
    match = None
    for item in items:
        title = (item.findtext("title") or "").strip()
        if title == wanted_title:
            match = item
            break
    if match is None:
        output["sources"][source_id] = {"title": wanted_title, "error": "episode not found"}
        continue
    record = {
        "title": match.findtext("title") or "",
        "link": match.findtext("link") or "",
        "guid": match.findtext("guid") or "",
        "duration": "",
        "chapters_url": "",
        "transcript_urls": [],
        "chapters": [],
    }
    for child in match:
        local = child.tag.rsplit("}", 1)[-1]
        if local == "duration":
            record["duration"] = child.text or ""
        elif local == "chapters":
            record["chapters_url"] = child.attrib.get("url", "")
        elif local == "transcript":
            record["transcript_urls"].append({"url": child.attrib.get("url", ""), "type": child.attrib.get("type", ""), "rel": child.attrib.get("rel", "")})
    if record["chapters_url"]:
        response = session.get(record["chapters_url"], timeout=30)
        record["chapters_fetch"] = {"status": response.status_code, "bytes": len(response.content), "final_url": response.url}
        response.raise_for_status()
        payload = response.json()
        record["chapters"] = payload.get("chapters", payload) if isinstance(payload, dict) else payload
    output["sources"][source_id] = record

path = Path(__file__).resolve().parents[1] / "podcast-chapters.json"
path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
