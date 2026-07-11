from pathlib import Path

import requests
from bs4 import BeautifulSoup

url = "https://thecarlallen.com/revealed-the-secrets-to-transforming-your-business-for-a-lucrative-sale/"
response = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
response.raise_for_status()
soup = BeautifulSoup(response.text, "html.parser")
text = "\n".join(line.strip() for line in soup.get_text("\n").splitlines() if line.strip())
start = text.find("Full Transcript:")
end = text.find("The Creative Dealmaker Podcast Channel", start)
if start < 0:
    raise SystemExit("Full Transcript marker not found")
transcript = text[start + len("Full Transcript:") : end if end > start else None].strip()
Path(__file__).resolve().parents[1].joinpath("src-013-transcript.txt").write_text(transcript + "\n", encoding="utf-8")
