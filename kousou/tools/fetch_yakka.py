"""厚労省「薬価基準収載品目リスト」（内用薬・外用薬のExcel）を取り込み、kousou/data/yakka.json を作る。
GitHub Actions（.github/workflows/kousou-yakka.yml）から月1回実行する。

  python kousou/tools/fetch_yakka.py                      # 今年度・前年度の掲載ページを自動で探す
  python kousou/tools/fetch_yakka.py --page-url URL       # 掲載ページを指定
  python kousou/tools/fetch_yakka.py --xlsx a.xlsx b.xlsx # 手元のExcelから作る（テスト用）

Excelの列の並びは年度で変わりうるので、見出しの文字（品名・成分名・規格…）で列を探す。
新薬（薬価収載から1年以内＝14日制限）は、成分名が初めてリストに現れた月を data/yakka_seen.json に記録して判定する。
実行のたびに data/yakka_report.md に結果（見つけたファイル・列・件数・エラー）を書く。"""
from __future__ import annotations

import argparse
import html
import io
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"
UA = {"User-Agent": "Mozilla/5.0 (kousou-yakka; +https://github.com/ysk713/-)"}
KINDS = ("内用薬", "外用薬")  # 注射薬・歯科用薬剤は購送の対象外なので取り込まない
HEADERS = {  # 列の役割 → 見出しに含まれる文字（先に書いたものほど優先）
    "kubun": ["区分"],
    "code": ["薬価基準収載医薬品コード", "医薬品コード", "コード"],
    "ingredient": ["成分名", "一般名"],
    "spec": ["規格"],
    "name": ["品名", "販売名"],
    "maker": ["メーカー", "会社名"],
    "senpatsu": ["先発医薬品"],
    "kouhatsu": ["後発医薬品"],
    "price": ["薬価"],
    "listed": ["収載年月日", "収載日"],
}


def nfkc(s) -> str:
    return unicodedata.normalize("NFKC", str(s or "")).strip()


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def candidate_pages(today: date) -> list[str]:
    fy = today.year if today.month >= 4 else today.year - 1
    return [f"https://www.mhlw.go.jp/topics/{y}/04/tp{y}0401-01.html" for y in (fy, fy - 1)]


ANCHOR = re.compile(r"""<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>""", re.I | re.S)
FILE_NO = {"内用薬": "_01", "外用薬": "_03"}   # 厚労省のファイル名の慣例（tpYYYYMMDD-01_01.xlsx＝内用薬、_03＝外用薬）


def page_links(page_html: str, base: str) -> list[tuple[str, str, str]]:
    """(URL, リンク文字, 直前の文脈) の一覧。"""
    out = []
    for m in ANCHOR.finditer(page_html):
        text = nfkc(re.sub(r"<[^>]+>", "", html.unescape(m.group(2))))
        ctx = nfkc(re.sub(r"<[^>]+>", " ", html.unescape(page_html[max(0, m.start() - 300):m.start()])))[-80:]
        out.append((urllib.parse.urljoin(base, html.unescape(m.group(1)).strip()), text, ctx))
    return out


def find_excel_links(page_html: str, base: str) -> dict[str, str]:
    """掲載ページから 内用薬・外用薬 のExcelへのリンクを探す。種別ごとに複数あれば、URL中の日付が新しいものを選ぶ。"""
    found: dict[str, list[str]] = {}
    for url, text, ctx in page_links(page_html, base):
        if not re.search(r"\.xlsx?(\?|$)", url, re.I):
            continue
        fname = url.rsplit("/", 1)[-1]
        for k in KINDS:
            others = [o for o in ("内用薬", "注射薬", "外用薬", "歯科用薬剤") if o != k]
            by_text = k in text
            by_ctx = k in ctx and not any(o in text for o in others) and not any(o in ctx[ctx.rfind(k):] for o in others)
            by_name = re.search(re.escape(FILE_NO[k]) + r"\.xlsx?$", fname, re.I) and not any(o in text for o in others)
            if by_text or by_ctx or by_name:
                found.setdefault(k, []).append(url)
                break
    date_of = lambda u: max(re.findall(r"20\d{6}", u) or ["0"])
    return {k: max(v, key=date_of) for k, v in found.items()}


def sub_pages(page_html: str, base: str) -> list[str]:
    """Excelが直接無いとき、たどる候補の下位ページ（同じサイト内で、薬価基準・収載品目などの文字があるリンク）。"""
    host = urllib.parse.urlparse(base).netloc
    out = []
    for url, text, _ in page_links(page_html, base):
        if urllib.parse.urlparse(url).netloc == host and re.search(r"\.html?(\?|#|$)", url) and re.search(r"薬価基準|収載品目|品目リスト|適用", text):
            if url.split("#")[0] not in out and url.split("#")[0] != base:
                out.append(url.split("#")[0])
    return out[:15]


def find_columns(rows) -> tuple[int, dict[str, int]] | None:
    """先頭20行から見出し行を探し、役割→列番号を返す。"""
    for i, row in enumerate(rows[:20]):
        cells = [nfkc(c).replace("\n", "") for c in row]
        if not (any("品名" in c or "販売名" in c for c in cells) and any("規格" in c for c in cells)):
            continue
        cols = {}
        for role, keys in HEADERS.items():
            for k in keys:
                # 完全一致を優先（「規格」が「同一剤形・規格の後発医薬品がある先発医薬品」に当たらないように）
                j = next((j for j, c in enumerate(cells) if c == k and j not in cols.values()), None)
                if j is None:
                    j = next((j for j, c in enumerate(cells) if k in c and j not in cols.values()), None)
                if j is not None:
                    cols[role] = j
                    break
        return i, cols
    return None


def parse_workbook(data: bytes, kind_hint: str, log: list[str]) -> list[dict]:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    items = []
    for ws in wb.worksheets:
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        found = find_columns(rows)
        if not found:
            log.append(f"- シート「{ws.title}」：見出し行が見つからないため読み飛ばし")
            continue
        hi, cols = found
        log.append(f"- シート「{ws.title}」：見出し {hi + 1}行目、列 = " + "、".join(f"{k}:{v + 1}" for k, v in cols.items()))
        for r in rows[hi + 1:]:
            get = lambda role: nfkc(r[cols[role]]) if role in cols and cols[role] < len(r) and r[cols[role]] is not None else ""
            name = get("name")
            if not name:
                continue
            kubun = get("kubun") or kind_hint
            items.append({
                "code": get("code"), "name": name, "ingredient": get("ingredient"), "spec": get("spec"),
                "kind": "外用" if "外" in kubun else "内用" if "内" in kubun else kind_hint[:2],
                "senpatsu": bool(get("senpatsu")), "kouhatsu": bool(get("kouhatsu")),
                "listed": _date(get("listed")),
            })
    return items


def _date(s: str) -> str:
    m = re.search(r"(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.search(r"(R|令和)\s*(\d{1,2})[./年](\d{1,2})[./月](\d{1,2})", s)
    return f"{int(m.group(2)) + 2018}-{int(m.group(3)):02d}-{int(m.group(4)):02d}" if m else ""


def ingredient_key(s: str) -> str:
    return re.sub(r"\s+", "", nfkc(s))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--page-url", help="薬価基準収載品目リストの掲載ページ")
    ap.add_argument("--xlsx", nargs="*", help="手元のExcel（指定するとダウンロードしない）")
    ap.add_argument("--out", type=Path, default=DATA)
    ap.add_argument("--today", help="YYYY-MM-DD（テスト用）")
    a = ap.parse_args(argv)
    today = date.fromisoformat(a.today) if a.today else date.today()
    a.out.mkdir(parents=True, exist_ok=True)
    log = [f"# 薬価基準収載品目リストの取り込み（{today}）", ""]
    files: list[tuple[str, str, bytes]] = []
    source = ""
    try:
        if a.xlsx:
            files = [(("外用薬" if "外" in Path(x).name else "内用薬"), x, Path(x).read_bytes()) for x in a.xlsx]
            source = "手元のファイル"
        else:
            pages = [a.page_url] if a.page_url else candidate_pages(today)
            queue, done = list(pages), set()
            while queue and not files and len(done) < 25:
                url = queue.pop(0)
                if url in done:
                    continue
                done.add(url)
                try:
                    body = fetch(url)
                    text = body.decode("utf-8", "replace")
                    if text.count("\ufffd") > 50:  # Shift_JIS のページ
                        text = body.decode("cp932", "replace")
                except Exception as e:  # noqa: BLE001
                    log.append(f"- ページを開けません：{url}（{e}）")
                    continue
                links = find_excel_links(text, url)
                log.append(f"- ページ {url}：" + ("、".join(f"{k}→{v}" for k, v in links.items()) or "Excelへのリンクなし"))
                if links:
                    source = url
                    files = [(k, u, fetch(u)) for k, u in links.items()]
                    break
                subs = sub_pages(text, url)
                if url in pages:  # 原因調査用に、最初のページのリンクを記録する
                    allL = page_links(text, url)
                    log.append(f"  - リンク{len(allL)}件（先頭40件）：")
                    log += [f"    - [{t[:40]}] {u}" for u, t, _ in allL[:40]]
                    log.append(f"  - たどる下位ページ：{len(subs)}件")
                queue += [u for u in subs if u not in done]
        items = []
        for kind, name, data in files:
            log.append(f"## {kind}：{name}")
            items += parse_workbook(data, kind, log)
    except Exception as e:  # noqa: BLE001
        items = []
        log.append(f"\n**エラー**：{type(e).__name__}: {e}")

    if len(items) < 1000:
        log += ["", f"**取り込み失敗**：品目が{len(items)}件しかありません。既存の yakka.json はそのまま残します。",
                "掲載ページのURLが変わった場合は、Actions の「Run workflow」で page_url に新しいURLを入れて実行してください。"]
        (a.out / "yakka_report.md").write_text("\n".join(log) + "\n", encoding="utf-8")
        print("\n".join(log))
        return 1

    # 成分名が初めて現れた月を記録（初回取り込み時の成分は「以前から収載」扱い）
    seen_path = a.out / "yakka_seen.json"
    first_run = not seen_path.exists()
    seen = {} if first_run else json.loads(seen_path.read_text(encoding="utf-8"))
    month = today.strftime("%Y-%m")
    new = []
    for it in items:
        k = ingredient_key(it["ingredient"] or it["name"])
        if k not in seen:
            seen[k] = "以前" if first_run else month
            if not first_run:
                new.append(it["ingredient"] or it["name"])
    seen_path.write_text(json.dumps(seen, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")

    # 画面に埋め込む形：[品名, 成分名, 規格, 内用/外用, 先発1/後発2/他0, 収載日]
    rows = sorted({(it["name"], it["ingredient"], it["spec"], it["kind"], 1 if it["senpatsu"] else 2 if it["kouhatsu"] else 0, it["listed"]) for it in items})
    out = {"source": source, "fetched": today.isoformat(), "count": len(rows), "items": [list(r) for r in rows],
           "first_seen": {k: v for k, v in seen.items() if v != "以前"}}
    (a.out / "yakka.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log += ["", f"**取り込み成功**：{len(rows)}品目（内用 {sum(r[3] == '内用' for r in rows)}・外用 {sum(r[3] == '外用' for r in rows)}）",
            f"- 収載日の列：{'あり' if any(r[5] for r in rows) else 'なし（成分名が初めて現れた月で新薬を判定）'}",
            f"- 新しく現れた成分：{len(new)}件" + (("（" + "、".join(sorted(set(new))[:30]) + "）") if new else ""),
            "- 先頭5品目：", *[f"  - {r[0]}／{r[1]}／{r[2]}" for r in rows[:5]]]
    (a.out / "yakka_report.md").write_text("\n".join(log) + "\n", encoding="utf-8")
    print("\n".join(log))
    return 0


if __name__ == "__main__":
    sys.exit(main())
