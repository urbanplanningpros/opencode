import json
from pathlib import Path

OVERRIDES = {
    "SRC-016": {
        "video_id": "ib5ojVstPvM",
        "youtube_url": "https://www.youtube.com/watch?v=ib5ojVstPvM",
        "title": "How These Dealmakers Bought Their First (and Multiple) Businesses!",
        "channel": "Carl Allen - Dealmaker",
        "channel_id": "UCCcJzIkSSZxECZNtLG7Gteg",
        "channel_path": "/@carlallenofficial",
        "duration_text": "1:17:56",
        "view_text": "9,136 views",
        "published_text": "1 year ago",
        "score": 1.0,
        "title_similarity": 1.0,
        "creator_similarity": 1.0,
        "search_method": "targeted_youtube_html",
    },
    "SRC-017": {
        "video_id": "cHjTr1943ks",
        "youtube_url": "https://www.youtube.com/watch?v=cHjTr1943ks",
        "title": "Carlos Reyes on Acquiring Established Businesses",
        "channel": "Carl Allen - Dealmaker",
        "channel_id": "UCCcJzIkSSZxECZNtLG7Gteg",
        "channel_path": "/@carlallenofficial",
        "duration_text": "1:26:22",
        "view_text": "3,322 views",
        "published_text": "1 year ago",
        "score": 1.0,
        "title_similarity": 0.614,
        "creator_similarity": 0.5,
        "search_method": "targeted_youtube_html",
    },
}

root = Path(__file__).resolve().parents[1]
audit = json.loads((root / "youtube-link-audit.json").read_text(encoding="utf-8"))
result = {}
for item in audit:
    selected = OVERRIDES.get(item["source_id"]) or item.get("selected")
    selection_state = "HIGH_CONFIDENCE_TITLE_AND_CHANNEL" if item["source_id"] == "SRC-016" else "OFFICIAL_CHANNEL_TOPIC_MATCH" if item["source_id"] == "SRC-017" else item.get("selection_state")
    candidates = item.get("candidates", [])
    if item["source_id"] in OVERRIDES:
        candidates = [selected, *[candidate for candidate in candidates if candidate.get("video_id") != selected["video_id"]]]
    result[item["source_id"]] = {
        "source_id": item["source_id"],
        "creator": item["creator"],
        "expected_title": item["title"],
        "selection_state": selection_state,
        "youtube_url": selected.get("youtube_url", "") if selected else "",
        "video_id": selected.get("video_id", "") if selected else "",
        "matched_title": selected.get("title", "") if selected else "",
        "channel": selected.get("channel", "") if selected else "",
        "channel_id": selected.get("channel_id", "") if selected else "",
        "channel_path": selected.get("channel_path", "") if selected else "",
        "duration": selected.get("duration_text", "") if selected else "",
        "views": selected.get("view_text", "") if selected else "",
        "published": selected.get("published_text", "") if selected else "",
        "score": selected.get("score") if selected else None,
        "title_similarity": selected.get("title_similarity") if selected else None,
        "creator_similarity": selected.get("creator_similarity") if selected else None,
        "search_method": selected.get("search_method", "") if selected else "",
        "candidates": [
            {
                "youtube_url": candidate.get("youtube_url", ""),
                "title": candidate.get("title", ""),
                "channel": candidate.get("channel", ""),
                "score": candidate.get("score"),
                "title_similarity": candidate.get("title_similarity"),
                "creator_similarity": candidate.get("creator_similarity"),
            }
            for candidate in candidates[:5]
        ],
    }
(root / "youtube-link-map.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
