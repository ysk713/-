#!/usr/bin/env python3
"""世界の医療情報を収集して data/news/ に JSON として書き出す。

標準ライブラリだけで動く（GitHub Actions でも追加インストール不要）。

    python3 scripts/collect.py                # すべて収集
    python3 scripts/collect.py --only JP,US   # 指定した国だけ（動作確認用）
    python3 scripts/collect.py --no-country   # 国別検索を省略（全体フィードと動画のみ）

環境変数 YOUTUBE_API_KEY があれば YouTube Data API で国別の動画も検索する。
"""
from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "news"
UA = "Mozilla/5.0 (compatible; WorldHealthMap/1.0; +https://github.com/)"
NOW = dt.datetime.now(dt.timezone.utc)

# 見出しから病名タグを付ける（表示名: 検出語）
DISEASES = {
    "COVID-19": ["COVID", "新型コロナ", "SARS-CoV-2", "コロナウイルス"],
    "インフルエンザ": ["influenza", "インフルエンザ", "flu"],
    "鳥インフルエンザ": ["avian influenza", "bird flu", "H5N1", "H5N", "H7N9", "鳥インフル"],
    "デング熱": ["dengue", "デング"],
    "マラリア": ["malaria", "マラリア"],
    "コレラ": ["cholera", "コレラ"],
    "麻しん": ["measles", "麻しん", "麻疹", "はしか"],
    "エムポックス": ["mpox", "monkeypox", "エムポックス", "サル痘"],
    "エボラ": ["ebola", "エボラ"],
    "マールブルグ": ["marburg", "マールブルグ"],
    "結核": ["tuberculosis", "結核"],
    "HIV/エイズ": ["HIV", "AIDS", "エイズ"],
    "ポリオ": ["polio", "ポリオ"],
    "黄熱": ["yellow fever", "黄熱"],
    "狂犬病": ["rabies", "狂犬病"],
    "チクングニア": ["chikungunya", "チクングニア"],
    "ジカ熱": ["zika", "ジカ"],
    "MERS": ["MERS", "中東呼吸器症候群"],
    "ペスト": ["plague", "ペスト"],
    "ジフテリア": ["diphtheria", "ジフテリア"],
    "百日せき": ["pertussis", "whooping cough", "百日せき", "百日咳"],
    "髄膜炎": ["meningitis", "髄膜炎"],
    "ラッサ熱": ["lassa", "ラッサ"],
    "ニパウイルス": ["nipah", "ニパ"],
    "オロプーシェ": ["oropouche", "オロプーシェ"],
    "手足口病": ["hand, foot and mouth", "HFMD", "手足口病"],
    "食中毒": ["food poisoning", "foodborne", "食中毒"],
    "熱中症": ["heatstroke", "heat stroke", "heatwave", "熱中症", "熱波"],
    "大気汚染": ["air pollution", "smog", "大気汚染", "PM2.5"],
}
_DISEASE_RE = [
    (label, re.compile("|".join(
        # 英字の語は単語境界つき・大文字小文字を区別しない（略語は区別する）
        (rf"(?<![A-Za-z]){re.escape(w)}(?![A-Za-z])" if w.isascii() else re.escape(w))
        for w in words), 0 if all(w.isupper() for w in words if w.isascii()) else re.I))
    for label, words in DISEASES.items()
]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def fetch(url: str, retries: int = 2) -> bytes | None:
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja,en;q=0.8"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == retries:
                log(f"  ! 取得失敗 {url[:100]}: {e}")
                return None
            time.sleep(2 * (attempt + 1))
    return None


def parse_date(s: str | None) -> str | None:
    if not s:
        return None
    s = s.strip()
    try:
        d = email.utils.parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


def clean_text(s: str | None, limit: int = 280) -> str:
    if not s:
        return ""
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit] + ("…" if len(s) > limit else "")


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_feed(raw: bytes) -> list[dict]:
    """RSS 2.0 / Atom のどちらも読む。"""
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        log(f"  ! XML解析失敗: {e}")
        return []
    items = []
    for el in root.iter():
        if _local(el.tag) not in ("item", "entry"):
            continue
        f: dict = {}
        for c in el:
            name = _local(c.tag)
            if name == "link":
                f.setdefault("link", c.get("href") or (c.text or "").strip())
            elif name in ("title", "description", "summary", "pubDate", "published", "updated", "source", "videoId"):
                f.setdefault(name, c.text or "")
            elif name == "group":  # media:group (YouTube の説明文)
                for g in c:
                    if _local(g.tag) == "description":
                        f.setdefault("description", g.text or "")
        if f.get("title") and f.get("link"):
            items.append(f)
    return items


class CountryMatcher:
    """記事タイトルなどに含まれる国名を検出する。長い名前を優先（「インドネシア」を「インド」と誤認しない）。"""

    def __init__(self, countries: list[dict]):
        self.by_alias: dict[str, str] = {}
        for c in countries:
            for a in c["aliases_en"]:
                if len(a) >= 3 or a.isupper():
                    self.by_alias.setdefault(a, c["a2"])
            for a in c["aliases_ja"]:
                self.by_alias.setdefault(a, c["a2"])
        alts = sorted(self.by_alias, key=len, reverse=True)
        self.re = re.compile("|".join(
            rf"(?<![A-Za-z]){re.escape(a)}(?![A-Za-z])" if a.isascii() else re.escape(a) for a in alts))

    def find(self, text: str) -> list[str]:
        seen: list[str] = []
        for m in self.re.finditer(text):
            a2 = self.by_alias[m.group(0)]
            if a2 not in seen:
                seen.append(a2)
        return seen


def disease_tags(text: str) -> list[str]:
    return [label for label, rx in _DISEASE_RE if rx.search(text)]


def to_news(f: dict, source_name: str, lang: str, official: bool = False) -> dict:
    title = clean_text(f.get("title"), 300)
    src = clean_text(f.get("source")) or source_name
    # Google ニュースのタイトルは「見出し - 媒体名」形式
    if src and title.endswith(" - " + src):
        title = title[: -len(src) - 3]
    summary = "" if "news.google.com" in f.get("link", "") else clean_text(f.get("description") or f.get("summary"))
    return {
        "title": title,
        "link": f["link"].strip(),
        "source": src,
        # 日付のない記事は初めて見た日時を入れる（保持期間で消えるように）
        "date": parse_date(f.get("pubDate") or f.get("published") or f.get("updated")) or NOW.isoformat(timespec="seconds"),
        "lang": lang,
        "summary": summary,
        "tags": disease_tags(title + " " + summary),
        **({"official": True} if official else {}),
    }


def gnews_url(q: str, params: str) -> str:
    return f"https://news.google.com/rss/search?q={urllib.parse.quote(q)}&{params}"


def youtube_search(key: str, q: str, cfg: dict) -> list[dict]:
    after = (NOW - dt.timedelta(days=cfg["published_within_days"])).strftime("%Y-%m-%dT%H:%M:%SZ")
    params = urllib.parse.urlencode({
        "part": "snippet", "type": "video", "videoEmbeddable": "true", "order": "relevance",
        "maxResults": cfg["max_results"], "publishedAfter": after, "q": q, "key": key,
    })
    raw = fetch("https://www.googleapis.com/youtube/v3/search?" + params, retries=0)
    if not raw:
        return []
    out = []
    for it in json.loads(raw).get("items", []):
        sn = it["snippet"]
        out.append({
            "id": it["id"]["videoId"],
            "title": clean_text(sn["title"], 200),
            "channel": sn.get("channelTitle", ""),
            "date": parse_date(sn.get("publishedAt")),
        })
    return out


def merge(old: list[dict], new: list[dict], key: str, keep_days: int, limit: int) -> list[dict]:
    cutoff = (NOW - dt.timedelta(days=keep_days)).isoformat()
    by_key: dict[str, dict] = {}
    for item in old + new:  # 新しい方で上書き
        by_key[item[key]] = item
    items = [i for i in by_key.values() if (i.get("date") or NOW.isoformat()) >= cutoff]
    items.sort(key=lambda i: i.get("date") or "", reverse=True)
    return items[:limit]


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="国コード(ISO 2文字)をカンマ区切りで指定")
    ap.add_argument("--no-country", action="store_true", help="国別ニュース検索を省略")
    args = ap.parse_args()

    cfg = load_json(ROOT / "scripts" / "sources.json", {})
    countries = load_json(DATA / "countries.json", [])
    matcher = CountryMatcher(countries)
    # 地図上で1か国が複数の図形を持つ場合（例: オーストラリア）があるので国コードで重複を除く
    targets = list({c["a2"]: c for c in countries if not args.only or c["a2"] in args.only.upper().split(",")}.values())
    wait = cfg.get("request_interval_sec", 0.7)

    OUT.mkdir(parents=True, exist_ok=True)
    old_index = load_json(OUT / "index.json", {})
    news: dict[str, list[dict]] = {c["a2"]: [] for c in countries}
    videos: dict[str, list[dict]] = {c["a2"]: [] for c in countries}
    global_news: list[dict] = []
    global_videos: list[dict] = []
    source_status: list[dict] = []

    # 1) 全体フィード（WHO・CDC など）: 見出しの国名で振り分ける
    for feed in cfg.get("global_feeds", []):
        log(f"[feed] {feed['name']}")
        raw = fetch(feed["url"])
        items = parse_feed(raw) if raw else []
        source_status.append({"name": feed["name"], "ok": bool(items), "count": len(items)})
        for f in items:
            n = to_news(f, feed["name"], feed.get("lang", "en"), feed.get("official", False))
            hits = matcher.find(n["title"] + " " + n["summary"])
            n["countries"] = hits
            for a2 in hits:
                news[a2].append(n)
            global_news.append(n)
        time.sleep(wait)

    # 2) 国別ニュース検索（Google ニュース RSS）
    pcn = cfg.get("per_country_news", {})
    if pcn.get("enabled") and not args.no_country:
        for i, c in enumerate(targets, 1):
            log(f"[country {i}/{len(targets)}] {c['a2']} {c['ja']}")
            for q in pcn["queries"]:
                name = c["ja"] if q["lang"] == "ja" else c["en"]
                raw = fetch(gnews_url(q["q"].format(name=name), q["params"]))
                for f in (parse_feed(raw) if raw else [])[: q.get("max_items", 10)]:
                    n = to_news(f, "Google News", q["lang"])
                    n["countries"] = [c["a2"]]
                    news[c["a2"]].append(n)
                time.sleep(wait)

    # 3) 動画: YouTube チャンネル RSS
    for ch in cfg.get("video_channels", []):
        if not ch.get("channel_id"):
            continue
        log(f"[video] {ch['name']}")
        raw = fetch(f"https://www.youtube.com/feeds/videos.xml?channel_id={ch['channel_id']}")
        items = parse_feed(raw) if raw else []
        source_status.append({"name": "YouTube: " + ch["name"], "ok": bool(items), "count": len(items)})
        for f in items:
            vid = f.get("videoId") or urllib.parse.parse_qs(urllib.parse.urlparse(f["link"]).query).get("v", [""])[0]
            if not vid:
                continue
            v = {"id": vid, "title": clean_text(f["title"], 200), "channel": ch["name"],
                 "date": parse_date(f.get("published"))}
            hits = matcher.find(v["title"] + " " + clean_text(f.get("description"), 500))
            for a2 in hits:
                videos[a2].append(v)
            global_videos.append(v)

    # 4) 動画: YouTube Data API（キーがあるときだけ・日替わりで巡回）
    key = os.environ.get("YOUTUBE_API_KEY")
    ys = cfg.get("youtube_search", {})
    if key and ys:
        limit = ys.get("daily_country_limit", 90)
        start = (NOW.timetuple().tm_yday * limit) % max(len(targets), 1)
        rotation = (targets[start:] + targets[:start])[:limit]
        log(f"[youtube api] {len(rotation)} か国を検索")
        for c in rotation:
            videos[c["a2"]].extend(youtube_search(key, ys["q"].format(name=c["en"]), ys))
            time.sleep(wait)
        # トップ画面の「注目の動画」用
        for q in ys.get("global_queries", []):
            global_videos.extend(youtube_search(key, q, ys))

    # 5) 前回分とマージして書き出し（一定期間のニュースを蓄積）
    keep, vkeep = cfg.get("retention_days", 14), cfg.get("video_retention_days", 60)
    nmax, vmax = cfg.get("max_news_per_country", 30), cfg.get("max_videos_per_country", 8)
    index_countries = {}
    for c in countries:
        a2 = c["a2"]
        old = load_json(OUT / f"{a2}.json", {})
        n_list = merge(old.get("news", []), news[a2], "link", keep, nmax)
        v_list = merge(old.get("videos", []), videos[a2], "id", vkeep, vmax)
        tags: dict[str, int] = {}
        for n in n_list:
            for t in n["tags"]:
                tags[t] = tags.get(t, 0) + 1
        (OUT / f"{a2}.json").write_text(json.dumps(
            {"a2": a2, "updated_at": NOW.isoformat(timespec="seconds"), "news": n_list, "videos": v_list},
            ensure_ascii=False, separators=(",", ":")))
        index_countries[a2] = {
            "news": len(n_list),
            "videos": len(v_list),
            "official": sum(1 for n in n_list if n.get("official")),
            "tags": sorted(tags, key=tags.get, reverse=True)[:5],
        }

    old_global = old_index.get("global", {})
    index = {
        "generated_at": NOW.isoformat(timespec="seconds"),
        "sources": source_status,
        "countries": index_countries,
        "global": {
            "news": merge(old_global.get("news", []), global_news, "link", 3, 60),
            "videos": merge(old_global.get("videos", []), global_videos, "id", vkeep, 12),
        },
    }
    (OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    total = sum(v["news"] for v in index_countries.values())
    log(f"完了: ニュース {total} 件 / 動画 {sum(v['videos'] for v in index_countries.values())} 件 -> {OUT}")


if __name__ == "__main__":
    main()
