"""月報PDFの読み込みと甲表・乙表・丙表の解析。

月報PDFは2形式ある:
  形式A: 拡張子は .pdf だが中身は ZIP（N.jpeg / N.txt / manifest.json）
  形式B: 本物のPDF（テキスト層があれば pdfplumber で抽出）
どちらも pages = [{"num", "text", "image", "needs_visual"}] に揃えてから解析する。
"""
import io
import json
import re
import unicodedata
import zipfile
from collections import defaultdict

from . import posts
from .icd import classify

# ---------------------------------------------------------------- PDF読み込み


def read_pages(data: bytes):
    """PDF(両形式)のバイト列 -> (形式, pages)。"""
    if data[:4] == b"PK\x03\x04":
        return "zip", _read_zip(data)
    return "pdf", _read_pdf(data)


def _num(name):
    return int(re.sub(r"\D", "", name) or 0)


def _read_zip(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    visual = set()
    if "manifest.json" in names:
        try:
            m = json.loads(z.read("manifest.json"))
            visual = {int(p.get("page_number")) for p in m.get("pages", []) if p.get("has_visual_content")}
        except Exception:
            pass
    pages = {}
    for n in names:
        if n.endswith(".txt"):
            pages.setdefault(_num(n), {})["text"] = z.read(n).decode("utf-8", errors="replace")
        elif n.lower().endswith((".jpeg", ".jpg", ".png")):
            pages.setdefault(_num(n), {})["image"] = z.read(n)
    out = []
    for k in sorted(pages):
        p = pages[k]
        text = p.get("text", "")
        out.append(dict(num=k, text=text, image=p.get("image"),
                        needs_visual=(not text.strip()) or k in visual))
    return out


def _read_pdf(data):
    import pdfplumber
    out = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            text = page.extract_text(layout=False) or ""
            out.append(dict(num=i, text=text, image=None, needs_visual=not text.strip()))
    if any(p["needs_visual"] for p in out):
        # テキスト層のないスキャンPDF: 目視確認用に画像化しておく
        try:
            import pypdfium2 as pdfium
            doc = pdfium.PdfDocument(data)
            for p in out:
                if p["needs_visual"]:
                    img = doc[p["num"] - 1].render(scale=1.5).to_pil()
                    buf = io.BytesIO()
                    img.save(buf, format="JPEG", quality=80)
                    p["image"] = buf.getvalue()
        except Exception:
            pass
    return out


# ---------------------------------------------------------------- 対象月


def detect_month(text: str, filename: str = ""):
    """'2026-07' 形式で返す。見つからなければ None。"""
    t = unicodedata.normalize("NFKC", text or "")
    m = re.search(r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*分", t)
    if m:
        return f"{int(m.group(1))}-{int(m.group(2)):02d}"
    m = re.search(r"令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月", t)
    if m:
        return f"{int(m.group(1)) + 2018}-{int(m.group(2)):02d}"
    f = unicodedata.normalize("NFKC", filename or "")
    m = re.search(r"(20\d{2})[-_年]?(0[1-9]|1[0-2])(?!\d)", f)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return None


# ---------------------------------------------------------------- ページ分類


def classify_pages(pages):
    """各ページを 甲/乙/丙/他 に振り分け、丙表テキストを切り出す。"""
    kou, otsu, hei = [], [], []
    in_hei = False
    for p in pages:
        t = p["text"]
        if "疾病分類件数表" in t or re.search(r"[ＡA][0０][0０].{0,3}[ＢB][9９][9９]", t):
            head, sep, tail = t.partition("報告事項")
            otsu.append(head)
            if sep:
                in_hei = True
                hei.append(tail)
            continue
        if "報告事項" in t:
            in_hei = True
            hei.append(t.split("報告事項", 1)[1])
            continue
        if "受診者数" in t and not in_hei:
            kou.append(t)
            continue
        if in_hei:
            hei.append(t)
        elif not kou:
            kou.append(t)
        else:
            hei.append(t)
    return kou, otsu, hei


# ---------------------------------------------------------------- 甲表


def parse_kou(text: str):
    """甲表から (公館名の生文字列, 医務官名, (職員, 家族, その他, 計)) を返す。"""
    t = unicodedata.normalize("NFKC", text)
    embassy = officer = None
    lines = t.split("\n")
    for i, ln in enumerate(lines):
        m = re.search(r"在\S{1,25}?(?:日本国)?(?:大使館|総領事館|政府代表部|領事事務所)", ln)
        if m:
            embassy = m.group(0)
            rest = re.sub(r"医務官\s*$", "", ln[m.end():]).strip()
            if rest:
                officer = rest
            else:
                for cand in lines[i + 1:i + 3]:
                    cand = cand.strip()
                    if cand and not re.search(r"受診者数|調査票|駐在公館|年|月", cand):
                        officer = re.sub(r"医務官\s*$", "", cand).strip()
                        break
            break
    if officer:
        officer = re.sub(r"^(医務官|報告者)[:：]?", "", officer).strip() or None

    counts = None
    m = re.search(r"受診者数[^\d\n]*(\d+)\D+?(\d+)\D+?(\d+)\D+?(\d+)", t)
    if m:
        counts = tuple(int(x) for x in m.groups())
    else:
        for ln in lines:
            nums = re.findall(r"\d+", ln)
            if len(nums) == 4 and re.fullmatch(r"[\d\s]+", ln.strip()):
                counts = tuple(int(n) for n in nums)
                break
    if counts and counts[0] + counts[1] + counts[2] != counts[3]:
        counts = counts + ("合計不一致",)
    return embassy, officer, counts


# ---------------------------------------------------------------- 乙表

PAIR_RE = re.compile(r"([^()\d][^()]*?)\((\d+)\)")
_CODE_RE = re.compile(r"^[A-Z]\d{2}([-~][A-Z]?\d{2})?$")
_NOISE_LINE = [r"^[\d\s]+$", r"^\(.*年.*月分\)$", r"^報告者", r"^\d{4}\s*\d{1,2}$",
               r"毎月分を翌月", r"甲表は延べ件数", r"^疾病分類件数表$", r"^在.+(大使館|総領事館)"]
_CHAPTER_WORDS = ["感染症及び寄生虫症", "新生物", "の疾患", "障害", "症状", "損傷", "要因", "分類", "件数", "内訳"]


def parse_otsu(page_texts):
    """乙表から [(病名, 件数)] を返す。

    OCRで表の列順が崩れても拾えるよう、内訳欄の「病名(件数)」ペアだけを抜き出す。
    """
    pairs = []
    for page in page_texts:
        t = unicodedata.normalize("NFKC", page)
        kept = [ln.strip() for ln in t.split("\n")
                if ln.strip() and not any(re.search(p, ln.strip()) for p in _NOISE_LINE)]
        joined = " ".join(kept)
        for raw, cnt in PAIR_RE.findall(joined):
            toks = raw.split()
            # 直前の行番号・ICDコード・章見出し・件数を落とし、最後の塊だけを病名とする
            cut = 0
            for i, tok in enumerate(toks):
                if tok.isdigit() or _CODE_RE.match(tok) or any(w in tok for w in _CHAPTER_WORDS[:1]) \
                        or re.fullmatch(r"[A-Z]\d{2}.*[A-Z]\d{2}", tok):
                    cut = i + 1
            name = "".join(toks[cut:]).strip("、,，;；:：")
            if len(name) < 2 or int(cnt) > 500:
                continue
            pairs.append((name, int(cnt)))
    return pairs


# ---------------------------------------------------------------- 丙表: 出来事・巡回健診

EVENT_KEYWORDS = {
    "感染症": ["デング", "マラリア", "コレラ", "エボラ", "マールブルグ", "エムポックス", "サル痘", "麻疹", "はしか",
             "黄熱", "チクングニア", "ジカ", "鳥インフルエンザ", "新型コロナ", "COVID", "インフルエンザ", "狂犬病",
             "ペスト", "腸チフス", "ポリオ", "髄膜炎", "ラッサ熱", "A型肝炎", "結核", "百日咳", "手足口病", "オロプーシェ"],
    "気象・災害": ["熱波", "猛暑", "洪水", "豪雨", "サイクロン", "台風", "ハリケーン", "地震", "干ばつ", "森林火災",
               "山火事", "大気汚染", "PM2.5", "砂嵐", "寒波"],
    "治安・社会": ["デモ", "暴動", "テロ", "爆発", "銃撃", "ストライキ", "クーデター", "戦闘", "紛争", "空爆", "避難", "退避"],
    "邦人保護": ["邦人保護", "邦人旅行者", "邦人患者", "事故", "緊急移送", "医療搬送", "搬送", "入院", "死亡"],
}


def sentences(text):
    t = unicodedata.normalize("NFKC", text or "")
    t = re.sub(r"[ \t]+", " ", t)
    parts = re.split(r"(?<=。)|\n", t)
    out = []
    for s in parts:
        s = re.sub(r"^(?:[・●○■□◆◇\-\*]|[(（]?\d{1,2}[)）.．、](?!\d))\s*", "", s.strip())
        if len(s) >= 8:  # 「巡回健診」「邦人保護」のような見出しだけの行は除く
            out.append(s)
    return out


def detect_events(hei_text):
    """[(種別, キーワード, 文)]"""
    out, seen = [], set()
    for s in sentences(hei_text):
        for kind, kws in EVENT_KEYWORDS.items():
            for kw in kws:
                if kw in s and (kind, kw) not in seen:
                    seen.add((kind, kw))
                    out.append((kind, kw, s[:160]))
    return out


_PERIOD_RE = re.compile(
    r"(\d{1,2})月\s*(\d{1,2})日(?:\s*\([^)]\))?\s*(?:[~〜～\-－ー]|から)\s*(?:(\d{1,2})月\s*)?(\d{1,2})日")


def detect_junkai(hei_text, own_post):
    """巡回健診の記述を拾う -> [dict(from_post, dest, period, note)]"""
    out = []
    for s in sentences(hei_text):
        if "巡回" not in s:
            continue
        places = [p for p in posts.find_in_text(s) if p != own_post]
        m = _PERIOD_RE.search(s)
        period = ""
        if m:
            m1, d1, m2, d2 = m.groups()
            period = f"{m1}/{d1}〜{m2 or m1}/{d2}"
        incoming = bool(re.search(r"(による|が来訪|を受け|来館)", s))
        if not places and period:
            out.append(dict(from_post=own_post, dest="", period=period, note=s[:160]))
        for p in places:
            if incoming and posts.INFO.get(p, {}).get("is_post"):
                out.append(dict(from_post=p, dest=own_post, period=period, note=s[:160]))
            else:
                out.append(dict(from_post=own_post, dest=p, period=period, note=s[:160]))
    return out


# ---------------------------------------------------------------- 1ファイル解析


def parse_report(data: bytes, filename: str):
    fmt, pages = read_pages(data)
    full = "\n".join(p["text"] for p in pages)
    kou, otsu, hei = classify_pages(pages)
    raw_emb, officer, counts = parse_kou("\n".join(kou) if kou else full)
    post = posts.canonical(raw_emb) if raw_emb else None
    if not post:
        # ファイル名（国名ローマ字など）から推定
        stem = re.sub(r"\.pdf$", "", filename, flags=re.I)
        cands = posts.find_in_text(stem) or posts.find_in_text(re.sub(r"[\d_\-]", " ", stem))
        post = cands[0] if cands else None
    warnings = []
    if not post:
        warnings.append("公館名を特定できません")
    if not officer:
        warnings.append("医務官名を読み取れません")
    if not counts:
        warnings.append("受診者数を読み取れません")
    elif len(counts) == 5:
        warnings.append("受診者数の合計が一致しません")
        counts = counts[:4]
    vis = [p["num"] for p in pages if p["needs_visual"]]
    if vis:
        warnings.append(f"OCRテキストなし（要目視）: p.{', '.join(map(str, vis))}")
    diseases = parse_otsu(otsu)
    if otsu and not diseases:
        warnings.append("乙表の病名を抽出できません")
    hei_text = "\n".join(hei).strip()
    return dict(
        filename=filename, format=fmt, month=detect_month(full, filename),
        post=post, raw_embassy=raw_emb, officer=officer,
        staff=counts[0] if counts else None, family=counts[1] if counts else None,
        other=counts[2] if counts else None, total=counts[3] if counts else None,
        diseases=[dict(name=n, count=c, category=classify(n)) for n, c in diseases],
        hei_text=hei_text,
        events=[dict(kind=k, keyword=kw, snippet=s) for k, kw, s in detect_events(hei_text)],
        junkai=detect_junkai(hei_text, post),
        warnings=warnings,
        images={p["num"]: p["image"] for p in pages if p["needs_visual"] and p.get("image")},
    )


# ---------------------------------------------------------------- 医務官配置表


def parse_roster(data: bytes):
    """配置表xlsx -> [dict(post, officer, kana, staffed, note)]"""
    import pandas as pd
    raw = pd.read_excel(io.BytesIO(data), sheet_name=None, header=None, dtype=str)
    sheet = next((df for name, df in raw.items() if "配置" in name), next(iter(raw.values())))
    hdr_row = None
    for i in range(min(15, len(sheet))):
        row = " ".join(str(x) for x in sheet.iloc[i].tolist())
        if "公館" in row:
            hdr_row = i
            break
    if hdr_row is None:
        raise ValueError("配置表に「公館」を含む見出し行が見つかりません")
    cols = [str(c).strip() for c in sheet.iloc[hdr_row].tolist()]
    df = sheet.iloc[hdr_row + 1:].copy()
    df.columns = cols

    def pick(*keys, exclude=()):
        for c in cols:
            if any(k in c for k in keys) and not any(e in c for e in exclude):
                return c
        return None
    c_post = pick("駐在公館", "公館")
    c_name = pick("氏名", "医務官", exclude=("ふりがな", "フリガナ", "公館"))
    c_kana = pick("ふりがな", "フリガナ", "よみ")
    c_note = pick("備考", "状況")
    out = []
    for _, r in df.iterrows():
        rawp = str(r.get(c_post) or "").strip()
        if not rawp or rawp == "nan":
            continue
        post = posts.canonical(rawp) or (posts.find_in_text(rawp) or [rawp])[0]
        name = str(r.get(c_name) or "").strip() if c_name else ""
        name = "" if name == "nan" else name
        kana = str(r.get(c_kana) or "").strip() if c_kana else ""
        note = str(r.get(c_note) or "").strip() if c_note else ""
        note = "" if note == "nan" else note
        staffed = bool(name) and not re.search(r"未配置|欠員|退避|不在", name + note)
        out.append(dict(post=post, officer=name, kana="" if kana == "nan" else kana,
                        staffed=staffed, note=note))
    return out


def same_person(a, b):
    na = re.sub(r"\s", "", unicodedata.normalize("NFKC", a or ""))
    nb = re.sub(r"\s", "", unicodedata.normalize("NFKC", b or ""))
    return bool(na) and na == nb
