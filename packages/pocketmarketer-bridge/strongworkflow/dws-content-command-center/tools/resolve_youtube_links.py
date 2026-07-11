from __future__ import annotations

import html
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import quote_plus, unquote, urlparse

import requests

SOURCES = [
    {"source_id":"SRC-001","creator":"Carl Allen","title":"The Real Reason Most Entrepreneurs Stay Broke","source_url":"https://www.youtube.com/@carlallenofficial/search?query=entrepreneurs%20stay%20broke"},
    {"source_id":"SRC-002","creator":"Carl Allen","title":"The Safer Way to Build Wealth: Buy, Don't Start","source_url":"https://www.youtube.com/@carlallenofficial/search?query=safer%20way%20build%20wealth"},
    {"source_id":"SRC-003","creator":"Carl Allen","title":"The Secret to Buying Businesses at the Right Price","source_url":"https://www.youtube.com/@carlallenofficial/search?query=right%20price"},
    {"source_id":"SRC-006","creator":"Carl Allen","title":"Mailbox Money From Buying Cash-Flowing Businesses","source_url":"https://www.youtube.com/@carlallenofficial/search?query=mailbox%20money"},
    {"source_id":"SRC-007","creator":"Chris Moore","title":"I Built a Complete Marketing Plan Live on Stage","source_url":"https://www.youtube.com/@Chrismoorespeaks/search?query=marketing%20plan"},
    {"source_id":"SRC-008","creator":"Chris Moore","title":"He Needed More Leads. We Built the Entire System Live.","source_url":"https://www.youtube.com/@Chrismoorespeaks/search?query=more%20leads"},
    {"source_id":"SRC-009","creator":"Carl Allen and Chris Moore","title":"How to Teach People How to Offer You Equity in Their Company","source_url":"https://thecarlallen.com/how-to-teach-people-how-to-offer-you-equity-in-their-company/"},
    {"source_id":"SRC-010","creator":"Carl Allen","title":"Why $3 Million in Profit is Worthless","source_url":"https://thecarlallen.com/why-3-million-in-profit-is-worthless/"},
    {"source_id":"SRC-011","creator":"Chris Moore","title":"Consulting for Equity: Become a Strategic Partner in Business","source_url":"https://www.youtube.com/@Chrismoorespeaks/search?query=consulting%20for%20equity"},
    {"source_id":"SRC-012","creator":"Carl Allen","title":"Real-Estate Compared To Business Buying!","source_url":"https://thecarlallen.com/real-estate-compared-to-business-buying/"},
    {"source_id":"SRC-013","creator":"Carl Allen and John Warrillow","title":"Revealed: The Secrets to Transforming Your Business for a Lucrative Sale","source_url":"https://thecarlallen.com/revealed-the-secrets-to-transforming-your-business-for-a-lucrative-sale/"},
    {"source_id":"SRC-014","creator":"Carl Allen","title":"Business Valuation: Your Expert Guide - Part 1","source_url":"https://thecarlallen.com/business-valuation-your-expert-guide-part-1/"},
    {"source_id":"SRC-015","creator":"Carl Allen","title":"Business Acquisition Deal Structures: Seller Financing vs. Annuity Deals","source_url":"https://thecarlallen.com/business-acquisition-deal-structures-seller-financing-vs-annuity-deals/"},
    {"source_id":"SRC-016","creator":"DWS member panel","title":"How These Dealmakers Bought Their First (and Multiple) Businesses!","source_url":"https://www.buzzsprout.com/2306481/episodes/16623981-how-these-dealmakers-bought-their-first-and-multiple-businesses"},
    {"source_id":"SRC-017","creator":"Carl Allen and Carlos Reyes","title":"Carlos Reyes on Buying Cash-Flowing Businesses (Instead of Building)","source_url":"https://www.buzzsprout.com/2306481/episodes"},
    {"source_id":"SRC-018","creator":"Carl Allen","title":"3 Power Plays to Build Rapport With Business Owners","source_url":"https://thecarlallen.com/3-power-plays-to-build-rapport-with-business-owners/"},
    {"source_id":"SRC-019","creator":"Carl Allen","title":"Use Theses 3 Strategies To Find Off-Market Deals","source_url":"https://thecarlallen.com/use-theses-3-strategies-to-find-off-market-deals/"},
    {"source_id":"SRC-020","creator":"Carl Allen","title":"Why FOCUS is Critical In A Rollup","source_url":"https://thecarlallen.com/why-focus-is-critical-in-a-rollup/"},
    {"source_id":"SRC-021","creator":"Carl Allen and Chris Moore","title":"Investor's Guide: 5 Essential Elements in Business Equity Deals","source_url":"https://thecarlallen.com/investors-guide-5-essential-elements-in-business-equity-deals/"},
]

YOUTUBE_ID_PATTERNS = [
    re.compile(r"youtube(?:-nocookie)?\.com/embed/([A-Za-z0-9_-]{11})", re.I),
    re.compile(r"youtube\.com/watch\?(?:[^\"'<> ]*&)?v=([A-Za-z0-9_-]{11})", re.I),
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})", re.I),
    re.compile(r"(?:youtubeId|videoId|data-video-id)[\\\"'=: ]+([A-Za-z0-9_-]{11})", re.I),
]

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+410; SOCS=CAI",
})


def normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def similarity(left: str, right: str) -> float:
    return SequenceMatcher(None, normalized(left), normalized(right)).ratio()


def text_value(value: object) -> str:
    if not isinstance(value, dict):
        return ""
    if isinstance(value.get("simpleText"), str):
        return value["simpleText"]
    runs = value.get("runs")
    if isinstance(runs, list):
        return "".join(run.get("text", "") for run in runs if isinstance(run, dict))
    return ""


def initial_data(page: str) -> dict | None:
    decoder = json.JSONDecoder()
    for marker in ("var ytInitialData =", "ytInitialData =", 'window[\"ytInitialData\"] ='):
        position = page.find(marker)
        if position < 0:
            continue
        start = page.find("{", position + len(marker))
        if start < 0:
            continue
        try:
            result, _ = decoder.raw_decode(page[start:])
            if isinstance(result, dict):
                return result
        except json.JSONDecodeError:
            continue
    return None


def video_renderers(value: object) -> list[dict]:
    found: list[dict] = []
    if isinstance(value, dict):
        for key in ("videoRenderer", "gridVideoRenderer", "compactVideoRenderer"):
            renderer = value.get(key)
            if isinstance(renderer, dict) and renderer.get("videoId"):
                found.append(renderer)
        for child in value.values():
            found.extend(video_renderers(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(video_renderers(child))
    return found


def youtube_search(query: str) -> tuple[list[dict], dict]:
    url = f"https://www.youtube.com/results?search_query={quote_plus(query)}&sp=EgIQAQ%253D%253D&hl=en&gl=US"
    debug = {"url": url, "status": None, "bytes": 0, "initial_data": False, "renderer_count": 0}
    try:
        response = SESSION.get(url, timeout=35)
        debug.update(status=response.status_code, bytes=len(response.content))
        response.raise_for_status()
    except Exception as exc:
        debug["error"] = str(exc)
        return [], debug
    data = initial_data(response.text)
    debug["initial_data"] = bool(data)
    if not data:
        debug["page_prefix"] = response.text[:180]
        return [], debug
    renderers = video_renderers(data)
    debug["renderer_count"] = len(renderers)
    candidates: list[dict] = []
    seen: set[str] = set()
    for renderer in renderers:
        video_id = renderer.get("videoId")
        if not video_id or video_id in seen:
            continue
        seen.add(video_id)
        channel = text_value(renderer.get("ownerText")) or text_value(renderer.get("longBylineText")) or text_value(renderer.get("shortBylineText"))
        browse = (((renderer.get("ownerText") or renderer.get("longBylineText") or {}).get("runs") or [{}])[0].get("navigationEndpoint") or {}).get("browseEndpoint") or {}
        candidates.append({
            "video_id": video_id,
            "youtube_url": f"https://www.youtube.com/watch?v={video_id}",
            "title": text_value(renderer.get("title")),
            "channel": channel,
            "channel_id": browse.get("browseId", ""),
            "channel_path": browse.get("canonicalBaseUrl", ""),
            "duration_text": text_value(renderer.get("lengthText")),
            "view_text": text_value(renderer.get("viewCountText")),
            "published_text": text_value(renderer.get("publishedTimeText")),
            "search_method": "youtube_html",
        })
    return candidates, debug


def page_ids(url: str) -> tuple[list[str], dict]:
    host = urlparse(url).netloc.lower()
    if host not in {"thecarlallen.com", "www.thecarlallen.com", "buzzsprout.com", "www.buzzsprout.com"}:
        return [], {"skipped": True}
    debug = {"url": url, "status": None, "bytes": 0}
    try:
        response = SESSION.get(url, timeout=35)
        debug.update(status=response.status_code, bytes=len(response.content))
        response.raise_for_status()
    except Exception as exc:
        debug["error"] = str(exc)
        return [], debug
    decoded = unquote(html.unescape(response.text))
    ids: list[str] = []
    for pattern in YOUTUBE_ID_PATTERNS:
        for video_id in pattern.findall(decoded):
            if video_id not in ids:
                ids.append(video_id)
    debug["video_ids"] = ids
    return ids, debug


def oembed(video_id: str) -> dict:
    url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
    try:
        response = SESSION.get(url, timeout=20)
        response.raise_for_status()
        data = response.json()
    except Exception:
        return {"video_id": video_id, "youtube_url": f"https://www.youtube.com/watch?v={video_id}", "title": "", "channel": "", "search_method": "page_embed"}
    return {
        "video_id": video_id,
        "youtube_url": f"https://www.youtube.com/watch?v={video_id}",
        "title": data.get("title", ""),
        "channel": data.get("author_name", ""),
        "channel_url": data.get("author_url", ""),
        "search_method": "page_embed",
    }


def bing_video_ids(query: str) -> tuple[list[str], dict]:
    url = f"https://www.bing.com/search?q={quote_plus('site:youtube.com/watch ' + query)}&count=20"
    debug = {"url": url, "status": None, "bytes": 0}
    try:
        response = SESSION.get(url, timeout=35)
        debug.update(status=response.status_code, bytes=len(response.content))
        response.raise_for_status()
    except Exception as exc:
        debug["error"] = str(exc)
        return [], debug
    body = unquote(html.unescape(response.text))
    ids: list[str] = []
    for video_id in re.findall(r"(?:youtube\.com/watch\?v=|youtu\.be/)([A-Za-z0-9_-]{11})", body, re.I):
        if video_id not in ids:
            ids.append(video_id)
    debug["video_ids"] = ids
    return ids, debug


def scored(candidate: dict, source: dict, embedded_ids: set[str]) -> dict:
    title_score = similarity(source["title"], candidate.get("title", ""))
    creator_tokens = [token for token in normalized(source["creator"]).split() if token not in {"and", "member", "panel"}]
    channel_norm = normalized(candidate.get("channel", ""))
    creator_score = sum(token in channel_norm for token in creator_tokens) / max(len(creator_tokens), 1)
    official_path = (candidate.get("channel_path") or candidate.get("channel_url") or "").lower()
    official_bonus = 0.14 if "carlallenofficial" in official_path or "chrismoorespeaks" in official_path else 0.0
    embedded_bonus = 0.25 if candidate["video_id"] in embedded_ids else 0.0
    total = min(1.0, title_score * 0.72 + creator_score * 0.18 + official_bonus + embedded_bonus)
    return {
        **candidate,
        "embedded_on_source_page": candidate["video_id"] in embedded_ids,
        "title_similarity": round(title_score, 4),
        "creator_similarity": round(creator_score, 4),
        "score": round(total, 4),
    }


def choose(candidates: list[dict]) -> tuple[dict | None, str]:
    if not candidates:
        return None, "MANUAL_REVIEW_REQUIRED"
    top = candidates[0]
    if top["embedded_on_source_page"] and (top["title_similarity"] >= 0.55 or not top.get("title")):
        return top, "VERIFIED_SOURCE_PAGE_EMBED"
    if top["title_similarity"] >= 0.82 and top["creator_similarity"] >= 0.5:
        return top, "HIGH_CONFIDENCE_TITLE_AND_CHANNEL"
    if top["title_similarity"] >= 0.92:
        return top, "HIGH_CONFIDENCE_TITLE_MATCH"
    return None, "MANUAL_REVIEW_REQUIRED"


def main() -> None:
    output_path = Path(__file__).resolve().parents[1] / "youtube-link-audit.json"
    audit: list[dict] = []
    for source in SOURCES:
        embedded, page_debug = page_ids(source["source_url"])
        candidates: list[dict] = [oembed(video_id) for video_id in embedded]
        youtube_candidates, youtube_debug = youtube_search(f"{source['title']} {source['creator']}")
        candidates.extend(youtube_candidates)
        bing_ids: list[str] = []
        bing_debug: dict = {}
        if not candidates:
            bing_ids, bing_debug = bing_video_ids(f"{source['title']} {source['creator']}")
            candidates.extend(oembed(video_id) for video_id in bing_ids)
        unique: dict[str, dict] = {}
        for candidate in candidates:
            video_id = candidate.get("video_id")
            if video_id and video_id not in unique:
                unique[video_id] = candidate
        ranked = [scored(candidate, source, set(embedded)) for candidate in unique.values()]
        ranked.sort(key=lambda item: (item["embedded_on_source_page"], item["score"]), reverse=True)
        selected, state = choose(ranked)
        record = {
            **source,
            "embedded_video_ids": embedded,
            "selected": selected,
            "selection_state": state,
            "candidates": ranked[:10],
            "debug": {"source_page": page_debug, "youtube": youtube_debug, "bing": bing_debug, "bing_video_ids": bing_ids},
        }
        audit.append(record)
        print(source["source_id"], state, selected["youtube_url"] if selected else "", file=sys.stderr)
    output_path.write_text(json.dumps(audit, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
