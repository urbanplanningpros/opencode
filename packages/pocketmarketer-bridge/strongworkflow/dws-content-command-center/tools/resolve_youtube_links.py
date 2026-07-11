from __future__ import annotations

import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urlparse

import requests
from yt_dlp import YoutubeDL

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
    re.compile(r"youtube(?:-nocookie)?\.com/embed/([A-Za-z0-9_-]{11})"),
    re.compile(r"youtube\.com/watch\?v=([A-Za-z0-9_-]{11})"),
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(r"(?:youtubeId|videoId|data-video-id)[\"'=: ]+([A-Za-z0-9_-]{11})", re.I),
]


def normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def similarity(left: str, right: str) -> float:
    return SequenceMatcher(None, normalized(left), normalized(right)).ratio()


def youtube_ids_from_page(url: str) -> list[str]:
    if urlparse(url).netloc not in {"thecarlallen.com", "www.thecarlallen.com", "buzzsprout.com", "www.buzzsprout.com"}:
        return []
    try:
        response = requests.get(url, timeout=30, headers={"User-Agent":"Mozilla/5.0"})
        response.raise_for_status()
    except Exception as exc:
        print(f"page fetch failed for {url}: {exc}", file=sys.stderr)
        return []
    seen: list[str] = []
    for pattern in YOUTUBE_ID_PATTERNS:
        for match in pattern.findall(response.text):
            if match not in seen:
                seen.append(match)
    return seen


def compact(entry: dict, source: dict, embedded: bool = False) -> dict:
    video_id = entry.get("id") or entry.get("url")
    title = entry.get("title") or ""
    channel = entry.get("channel") or entry.get("uploader") or ""
    title_score = similarity(source["title"], title)
    creator_tokens = [token for token in normalized(source["creator"]).split() if token not in {"and", "member", "panel"}]
    channel_norm = normalized(channel)
    creator_score = sum(token in channel_norm for token in creator_tokens) / max(len(creator_tokens), 1)
    total = min(1.0, title_score * 0.82 + creator_score * 0.18 + (0.2 if embedded else 0.0))
    return {
        "video_id": video_id,
        "youtube_url": f"https://www.youtube.com/watch?v={video_id}" if video_id else "",
        "title": title,
        "channel": channel,
        "channel_id": entry.get("channel_id") or entry.get("uploader_id") or "",
        "duration": entry.get("duration"),
        "view_count": entry.get("view_count"),
        "upload_date": entry.get("upload_date") or entry.get("release_date"),
        "embedded_on_source_page": embedded,
        "title_similarity": round(title_score, 4),
        "creator_similarity": round(creator_score, 4),
        "score": round(total, 4),
    }


def metadata_for_ids(ydl: YoutubeDL, ids: list[str], source: dict) -> list[dict]:
    candidates: list[dict] = []
    for video_id in ids:
        try:
            entry = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        except Exception as exc:
            print(f"metadata failed for {video_id}: {exc}", file=sys.stderr)
            continue
        candidates.append(compact(entry, source, embedded=True))
    return candidates


def search_candidates(ydl: YoutubeDL, source: dict) -> list[dict]:
    query = f"{source['title']} {source['creator']}"
    try:
        results = ydl.extract_info(f"ytsearch12:{query}", download=False)
    except Exception as exc:
        print(f"search failed for {source['source_id']}: {exc}", file=sys.stderr)
        return []
    return [compact(entry, source) for entry in (results.get("entries") or []) if entry and entry.get("id")]


def choose(candidates: list[dict]) -> dict | None:
    if not candidates:
        return None
    ordered = sorted(candidates, key=lambda item: (item["embedded_on_source_page"], item["score"], item.get("view_count") or 0), reverse=True)
    top = ordered[0]
    if top["embedded_on_source_page"]:
        return top
    if top["title_similarity"] >= 0.78 and top["creator_similarity"] >= 0.5:
        return top
    if top["title_similarity"] >= 0.9:
        return top
    return None


def main() -> None:
    output_path = Path(__file__).resolve().parents[1] / "youtube-link-audit.json"
    ydl = YoutubeDL({
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
        "socket_timeout": 30,
        "retries": 3,
        "playlistend": 12,
    })
    audit: list[dict] = []
    for source in SOURCES:
        embedded_ids = youtube_ids_from_page(source["source_url"])
        candidates = metadata_for_ids(ydl, embedded_ids, source)
        seen = {candidate["video_id"] for candidate in candidates}
        for candidate in search_candidates(ydl, source):
            if candidate["video_id"] not in seen:
                candidates.append(candidate)
                seen.add(candidate["video_id"])
        candidates.sort(key=lambda item: (item["embedded_on_source_page"], item["score"], item.get("view_count") or 0), reverse=True)
        selected = choose(candidates)
        audit.append({
            **source,
            "embedded_video_ids": embedded_ids,
            "selected": selected,
            "selection_state": "AUTO_VERIFIED_EMBED" if selected and selected["embedded_on_source_page"] else "HIGH_CONFIDENCE_TITLE_MATCH" if selected else "MANUAL_REVIEW_REQUIRED",
            "candidates": candidates[:8],
        })
        print(source["source_id"], audit[-1]["selection_state"], selected["youtube_url"] if selected else "")
    output_path.write_text(json.dumps(audit, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
