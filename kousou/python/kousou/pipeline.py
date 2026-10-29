"""処理フロー全体：白紙除去 → ページ分類 → 患者ごと分割 → 読み取り → 判定 → 結合・出力。
AIの結果は work/ 以下にJSONで保存し、再実行時は再利用する（人がJSONを直して再判定できる）。"""
from __future__ import annotations

import csv
import json
import re
from datetime import date
from pathlib import Path

import pymupdf

from . import pdfops
from .rules import CHECK, ERROR, INFO, MINOR, SEV_ORDER, Finding, Master, Reviewer, history_entries, load_json, norm

DOC_ORDER = {"申込書": 0, "診断書": 1, "指示書": 2, "委任状": 3, "その他": 4}
CLASSIFY_CHUNK = 10


class Pipeline:
    def __init__(self, out_dir: Path, offline: bool = False, history_path: Path | None = None,
                 out_date: str | None = None, model: str | None = None):
        self.out = Path(out_dir)
        self.work = self.out / "work"
        (self.work / "cases").mkdir(parents=True, exist_ok=True)
        self.offline = offline
        self.history_path = history_path
        self.out_date = out_date or date.today().strftime("%Y%m%d")
        self.model = model
        self._reader = None

    @property
    def reader(self):
        if self.offline:
            raise RuntimeError("--offline 指定中ですが、AIによる読み取りが必要なページがあります（work/ のJSONが不足）。")
        if self._reader is None:
            from .ai import MODEL, Reader
            self._reader = Reader(self.model or MODEL)
        return self._reader

    # ------------------------------------------------------------------ 1-2 白紙除去・ページ分類
    def pages(self, scans: list[Path]) -> list[dict]:
        cache = self.work / "pages.json"
        if cache.exists():
            return load_json(cache)
        pages = []
        for f in scans:
            doc = pymupdf.open(f)
            blanks = set(pdfops.find_blank_pages(doc))
            for i in range(doc.page_count):
                pages.append({"file": str(f), "page": i, "blank": i in blanks,
                              "ink": round(pdfops.ink_ratio(doc[i]) * 100, 3)})
        todo = [p for p in pages if not p["blank"]]
        for k in range(0, len(todo), CLASSIFY_CHUNK):
            chunk = todo[k:k + CLASSIFY_CHUNK]
            imgs, nums = [], []
            for n, p in enumerate(chunk, k + 1):
                imgs.append(pdfops.page_jpeg(pymupdf.open(p["file"])[p["page"]], long_edge=1400))
                nums.append(n)
            print(f"  ページ分類 {k + 1}〜{k + len(chunk)} / {len(todo)}")
            res = {r["page"]: r for r in self.reader.classify_pages(imgs, nums)}
            for n, p in enumerate(chunk, k + 1):
                p.update({key: v for key, v in res.get(n, {"doc_type": "その他", "note": "分類結果なし"}).items() if key != "page"})
        _dump(cache, pages)
        return pages

    # ------------------------------------------------------------------ 3 患者ごとに分割
    def groups(self, pages: list[dict]) -> list[dict]:
        cache = self.work / "groups.json"
        if cache.exists():
            return load_json(cache)
        groups: list[dict] = []
        cur = None
        for p in pages:
            if p["blank"] or p.get("doc_type") == "白紙":
                continue
            t, first = p.get("doc_type", "その他"), p.get("is_first_page_of_doc", True)
            have = {q["doc_type"] for q in cur["pages"]} if cur else set()
            new = cur is None or (t == "申込書" and first and "申込書" in have) \
                or (t == "申込書" and first and have & {"診断書", "指示書"}) \
                or (t == "診断書" and first and {"診断書", "指示書"} <= have)
            if new:
                cur = {"id": f"g{len(groups) + 1:02d}", "pages": [], "warnings": []}
                groups.append(cur)
            cur["pages"].append({k: p.get(k) for k in ("file", "page", "doc_type", "patient_name", "applicant_name", "staff_code", "date")})
        for g in groups:
            types = [q["doc_type"] for q in g["pages"]]
            names = {norm(q["patient_name"]) for q in g["pages"] if q.get("patient_name") and q["doc_type"] in ("診断書", "指示書")}
            if len(names) > 1:
                g["warnings"].append("診断書・指示書の療養者氏名が複数あります（分割の誤り、または旧姓併記の可能性）。groups.json を確認してください。")
            if types and types[0] != "申込書":
                g["warnings"].append("申込書から始まっていません（前の案件とのページ境界のまたぎの可能性）。")
            for t in ("申込書", "診断書", "指示書"):
                if types.count(t) > 1 and t != "申込書":
                    g["warnings"].append(f"{t}が{types.count(t)}枚あります（2部綴じ・重複スキャンの可能性）。")
        _dump(cache, groups)
        return groups

    # ------------------------------------------------------------------ 4 読み取り
    def read(self, g: dict) -> dict:
        cache = self.work / "cases" / f"{g['id']}.json"
        if cache.exists():
            return load_json(cache)
        imgs, labels = [], []
        for q in sorted(g["pages"], key=lambda q: DOC_ORDER.get(q["doc_type"], 9)):
            imgs.append(pdfops.page_jpeg(pymupdf.open(q["file"])[q["page"]]))
            labels.append(f"【{q['doc_type']}（{Path(q['file']).name} p.{q['page'] + 1}）】")
        print(f"  読み取り {g['id']}（{len(imgs)}ページ）")
        x = self.reader.read_case(imgs, labels)
        _dump(cache, x)
        return x

    # ------------------------------------------------------------------ 全体
    def run(self, scans: list[Path], rules: dict | None = None, master: Master | None = None) -> dict:
        batch = "+".join(Path(s).stem for s in scans)
        print("1/4 白紙除去・ページ分類")
        pages = self.pages(scans)
        print("2/4 患者ごとに分割")
        groups = self.groups(pages)
        print("3/4 読み取り")
        cases = [{"id": g["id"], "pages": g["pages"], "group_warnings": g.get("warnings", []), "extraction": self.read(g)} for g in groups]

        print("4/4 判定・出力")
        rv = Reviewer(rules, master)
        history = load_json(self.history_path)["entries"] if self.history_path and self.history_path.exists() else []
        cross = rv.batch_checks(cases, history)
        for c in cases:
            c["findings"] = sorted(rv.review(c) + cross[c["id"]], key=lambda f: SEV_ORDER[f.sev])

        pdf_dir = self.out / "pdf"
        pdf_dir.mkdir(exist_ok=True)
        for old in pdf_dir.glob("*.pdf"):
            old.unlink()
        outputs = []
        for c in cases:
            name = _patient(c)
            path = pdfops.unique_path(pdf_dir, self.out_date + pdfops.safe_name(name))
            out = pymupdf.open()
            for q in sorted(c["pages"], key=lambda q: DOC_ORDER.get(q["doc_type"], 9)):
                out.insert_pdf(pymupdf.open(q["file"]), from_page=q["page"], to_page=q["page"])
            out.save(path, garbage=3, deflate=True)
            c["output"] = path.name
            outputs.append(path)

        blanks = [f"{Path(p['file']).name} p.{p['page'] + 1}（インク{p['ink']}%）" for p in pages if p["blank"]]
        md = render_markdown(cases, batch, blanks)
        (self.out / "判定結果.md").write_text(md, encoding="utf-8")
        write_csv(cases, self.out / "判定一覧.csv")
        _dump(self.out / "results.json", [{**{k: c[k] for k in ("id", "output")}, "findings": [f.__dict__ for f in c["findings"]]} for c in cases])
        pdfops.make_zip(outputs + [self.out / "判定結果.md", self.out / "判定一覧.csv"], self.out / f"{self.out_date}_購送下判定.zip")

        if self.history_path:
            old = load_json(self.history_path)["entries"] if self.history_path.exists() else []
            ids = {c["id"] for c in cases}
            new = [h for h in old if not (h.get("batch") == batch and h.get("case_id") in ids)] + history_entries(cases, rv.m, batch)
            _dump(self.history_path, {"entries": new})
        return {"cases": cases, "blanks": blanks}


# ---------------------------------------------------------------------- 出力
def _patient(c: dict) -> str:
    x = c["extraction"]
    return (x["application"].get("patient_name") or x["diagnosis"].get("patient_name")
            or x["instruction"].get("patient_name") or x["application"].get("applicant_name") or "氏名不明")


def _status(c: dict) -> str:
    sevs = {f.sev for f in c["findings"]}
    return ERROR if ERROR in sevs else CHECK if (CHECK in sevs or MINOR in sevs) else "クリーン"


def render_markdown(cases: list[dict], batch: str, blanks: list[str]) -> str:
    L = [f"# 個人用医薬品購送 下判定結果（{batch}）", "",
         f"作成日：{date.today():%Y-%m-%d}　件数：{len(cases)}件", "",
         "> **これは自動の「下判定」です。** 最終判断は必ず人が行ってください。書類が無い・読めないと出た場合は、",
         "> 断定する前にスキャンの重複・欠落・ページ境界のまたぎを確認してください。[AI判断]の項目は薬品マスタ未登録の薬剤について添付文書で確認してください。", ""]
    cnt = {s: sum(_status(c) == s for c in cases) for s in (ERROR, CHECK, "クリーン")}
    L += [f"- エラー相当あり：{cnt[ERROR]}件", f"- 要確認のみ：{cnt[CHECK]}件", f"- クリーン：{cnt['クリーン']}件", "", "## 案件別", ""]
    for n, c in enumerate(cases, 1):
        x = c["extraction"]
        app = x["application"]
        L.append(f"### {n}. {_patient(c)}（{_status(c)}）")
        L.append(f"申込者：{app.get('applicant_name') or '-'}／職員コード：{app.get('staff_code') or x['diagnosis'].get('staff_code') or '-'}／"
                 f"{app.get('mission_name') or '-'}／申込日：{app.get('apply_date') or '-'}／出力：`{c['output']}`")
        L.append("")
        shown = [f for f in c["findings"] if f.sev != INFO]
        L += [f"- **{f.sev}** {f.item}：{f.msg}" for f in shown] or ["- 指摘事項なし"]
        notes = [f for f in c["findings"] if f.sev == INFO]
        if notes:
            L += [f"- 参考 {f.item}：{f.msg}" for f in notes]
        L.append("")
    clean = [_patient(c) for c in cases if _status(c) == "クリーン"]
    L += ["## クリーン案件", "", "、".join(clean) if clean else "なし", "", "## 総括表（優先度順）", "",
          "| 優先度 | 案件 | 区分 | 内容 |", "|---|---|---|---|"]
    rows = [(SEV_ORDER[f.sev], _patient(c), f) for c in cases for f in c["findings"] if f.sev != INFO]
    for o, name, f in sorted(rows, key=lambda r: r[0]):
        L.append(f"| {['高', '中', '低'][o]} | {name} | {f.sev} | {f.item}：{f.msg.replace('|', '／')} |")
    if not rows:
        L.append("| - | - | - | 指摘事項なし |")
    if blanks:
        L += ["", "## 除去した白紙ページ", "", *[f"- {b}" for b in blanks]]
    return "\n".join(L) + "\n"


def write_csv(cases: list[dict], path: Path) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["No", "療養者", "申込者", "職員コード", "公館", "申込日", "判定", "エラー相当", "要確認", "指摘内容", "出力ファイル"])
        for n, c in enumerate(cases, 1):
            app = c["extraction"]["application"]
            F = [f for f in c["findings"] if f.sev != INFO]
            w.writerow([n, _patient(c), app.get("applicant_name"), app.get("staff_code"), app.get("mission_name"), app.get("apply_date"),
                        _status(c), sum(f.sev == ERROR for f in F), sum(f.sev in (CHECK, MINOR) for f in F),
                        "\n".join(f"[{f.sev}] {f.item}：{f.msg}" for f in F), c["output"]])


def _dump(path: Path, obj) -> None:
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
