from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import quote_plus

import requests

TARGETS = {
    "SRC-016": {
        "expected": "How These Dealmakers Bought Their First (and Multiple) Businesses!",
        "queries": [
            "How These Dealmakers Bought Their First and Multiple Businesses Carl Allen",
            "How These Dealmakers Bought Their First Multiple Businesses Carl Allen Dealmaker",
            "Dealmakers bought their first businesses Carl Allen panel",
            "first and multiple businesses Dealmaker Wealth Society",
            "16623981 dealmakers bought first multiple businesses",
        ],
    },
    "SRC-017": {
        "expected": "Carlos Reyes on Buying Cash-Flowing Businesses Instead of Building",
        "queries": [
            "Carlos Reyes on Acquiring Established Businesses Carl Allen",
            "Carlos Reyes buying cash flowing businesses Carl Allen",
            "Carlos Reyes established businesses Carl Allen Dealmaker",
            "Carlos Reyes instead of building buy businesses",
        ],
    },
}

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+410; SOCS=CAI",
})


def norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def sim(a: str, b: str) -> float:
    return SequenceMatcher(None, norm(a), norm(b)).ratio()


def text_value(value):
    if not isinstance(value, dict):
        return ""
    if isinstance(value.get("simpleText"), str):
        return value["simpleText"]
    return "".join(run.get("text", "") for run in value.get("runs", []) if isinstance(run, dict))


def initial_data(page: str):
    decoder = json.JSONDecoder()
    for marker in ("var ytInitialData =", "ytInitialData =", 'window[\"ytInitialData\"] ='):
        position = page.find(marker)
        if position < 0:
            continue
        start = page.find("{", position + len(marker))
        if start < 0:
            continue
        try:
            return decoder.raw_decode(page[start:])[0]
        except json.JSONDecodeError:
            pass
    return None


def renderers(value):
    found = []
    if isinstance(value, dict):
        for key in ("videoRenderer", "gridVideoRenderer", "compactVideoRenderer"):
            if isinstance(value.get(key), dict) and value[key].get("videoId"):
                found.append(value[key])
        for child in value.values():
            found.extend(renderers(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(renderers(child))
    return found


def search(query: str):
    url = f"https://www.youtube.com/results?search_query={quote_plus(query)}&sp=EgIQAQ%253D%253D&hl=en&gl=US"
    response = SESSION.get(url, timeout=30)
    response.raise_for_status()
    data = initial_data(response.text)
    if not data:
        return []
    result = []
    for item in renderers(data):
        byline = item.get("ownerText") or item.get("longBylineText") or item.get("shortBylineText") or {}
        browse = (((byline.get("runs") or [{}])[0].get("navigationEndpoint") or {}).get("browseEndpoint") or {}) if isinstance(byline, dict) else {}
        result.append({
            "video_id": item["videoId"],
            "youtube_url": f"https://www.youtube.com/watch?v={item['videoId']}",
            "title": text_value(item.get("title")),
            "channel": text_value(byline),
            "channel_path": browse.get("canonicalBaseUrl", ""),
            "duration": text_value(item.get("lengthText")),
            "views": text_value(item.get("viewCountText")),
            "published": text_value(item.get("publishedTimeText")),
            "query": query,
        })
    return result


output = {}
for source_id, target in TARGETS.items():
    candidates = {}
    for query in target["queries"]:
        for item in search(query):
            candidates.setdefault(item["video_id"], item)
    ranked = []
    for item in candidates.values():
        title_score = sim(target["expected"], item["title"])
        official = item["channel_path"].lower() == "/@carlallenofficial" or norm(item["channel"]) == "carl allen dealmaker"
        carlos = "carlos reyes" in norm(item["title"])
        dealmaker_terms = sum(term in norm(item["title"]) for term in ["deal", "business", "buy", "acquir"])
        score = title_score + (0.35 if official else 0) + (0.2 if source_id == "SRC-017" and carlos else 0) + dealmaker_terms * 0.03
        ranked.append({**item, "title_similarity": round(title_score, 4), "official_carl_channel": official, "score": round(score, 4)})
    ranked.sort(key=lambda item: item["score"], reverse=True)
    output[source_id] = ranked[:20]

path = Path(__file__).resolve().parents[1] / "remaining-youtube-candidates.json"
path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
