import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
audit = json.loads((root / "youtube-link-audit.json").read_text(encoding="utf-8"))
result = {}
for item in audit:
    selected = item.get("selected")
    result[item["source_id"]] = {
        "source_id": item["source_id"],
        "creator": item["creator"],
        "expected_title": item["title"],
        "selection_state": item.get("selection_state"),
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
            for candidate in item.get("candidates", [])[:5]
        ],
    }
(root / "youtube-link-map.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
