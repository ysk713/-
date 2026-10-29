"""APIを使わない結合テスト。合成スキャンPDFと模擬Readerで、分割・白紙除去・判定・命名・ZIPを確認する。
氏名・データはすべて架空。  実行: python -m pytest tests -q  （または python tests/test_pipeline.py）"""
import copy
import json
import sys
import tempfile
import zipfile
from datetime import date
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from kousou.pipeline import Pipeline  # noqa: E402
from kousou.rules import ERROR, CHECK, Reviewer  # noqa: E402

CONSENT_OK = {"present": True, "consent_item_count": 11, "consent_wording_current": "はい", "consent_unchecked_items": [],
              "consent9_old_wording": False, "old_form_features": "", "written_by_other": "いいえ", "proxy_letter_present": False,
              "proxy_letter_signed": "不明", "proxy_name": "", "patient_relation": "本人"}


def drug(name, st, unit, per_day, days, **kw):
    d = {"name_as_written": name, "generic_name": "", "corrected_name": "", "name_exists": True, "strength_value": st,
         "strength_unit": unit, "strength_exists": "はい", "dosage_form": "錠剤", "cold_storage": False, "in_diagnosis": True,
         "in_instruction": True, "diag_daily_units": per_day, "inst_daily_units": per_day, "adjustable_max_units": None,
         "quantity_indeterminate": False, "days": days, "quantity": per_day * days, "generic_prescription": False,
         "is_psychotropic": "いいえ", "is_new_drug": "いいえ", "is_female_hormone_cycle": False, "approved_max_daily": None,
         "approved_max_unit": "", "indication": "適応内", "indication_note": ""}
    d.update(kw)
    return d


def case(name, code, mission, apply, issue, disease, drugs, sign="自筆署名", seal="はい", **app_kw):
    app = dict(CONSENT_OK, apply_date=apply, applicant_name=name, patient_name=name, staff_code=code,
               mission_name=mission, mission_code="12345", **app_kw)
    doc = {"signature": sign, "seal": seal, "doctor_name": "架空医師", "doctor_mission": "在架空国大使館"}
    return {"application": app,
            "diagnosis": dict(doc, present=True, issue_date=issue, patient_name=name, staff_code=code, name_code_swapped=False,
                              disease=disease, has_dosage=True, original_sent_later=False),
            "instruction": dict(doc, present=True, issue_date=issue, patient_name=name, no_generic_checked=False),
            "drugs": drugs, "reading_uncertainties": []}


CASES = {
    "架空一郎": case("架空一郎", "A012345", "在架空国大使館", "2026-10-20", "2026-10-10", "高血圧症",
                    [drug("アムロジピン錠10mg", 10, "mg", 2, 30)]),                                   # ⑫ 20mg/日 超過
    "架空花子": case("架空花子", "0234567", "在架空国大使館", "2026-10-20", "2026-10-10", "雀卵斑",
                    [drug("シナール配合錠", None, "", 3, 30, indication="適応外")]),                    # ⑬ 適応外
    "架空次郎": case("架空次郎", "345678", "在キューバ日本国大使館", "2026-10-21", "2026-10-12", "不眠症",
                    [drug("マイスリー錠5mg", 5, "mg", 1, 30)], seal="いいえ"),                           # 向精神薬・キューバは押印不要
    "架空三郎": case("架空三郎", "a456789", "在架空国総領事館", "2026-10-22", "2026-10-15", "甲状腺機能低下症",
                    [drug("チラーヂンS錠12.5μg", 12.5, "μg", 1, 100)]),                                  # 規格なし・100日は指摘しない
    "架空四郎": case("架空四郎", "567890", "在架空国大使館", "2026-10-22", "2026-10-15", "脂質異常症",
                    [drug("リピトール錠10mg", 10, "mg", 4, 90)]),                                       # 40mg 確認済み → クリーン
}
ORDER = list(CASES)


class FakeReader:
    def classify_pages(self, imgs, nums):
        out = []
        for n in nums:
            name = ORDER[(n - 1) // 3]
            out.append({"page": n, "doc_type": ["申込書", "診断書", "指示書"][(n - 1) % 3], "is_first_page_of_doc": True,
                        "patient_name": name, "applicant_name": name, "staff_code": "", "date": "", "note": ""})
        return out

    def read_case(self, imgs, labels):
        return copy.deepcopy(CASES[self.current])


def make_scan(path: Path):
    doc = pymupdf.open()
    for name in ORDER:
        for t in ("申込書", "診断書", "指示書"):
            pg = doc.new_page()
            for k in range(30):
                pg.insert_text((50, 60 + k * 24), f"{t} {name} ダミー本文 ■■■■■■■■■■■■■■", fontname="japan", fontsize=14)
        if name == "架空次郎":
            doc.new_page()  # 白紙ページ
    doc.save(path)


def test_pipeline():
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        scan = td / "20261023101500.pdf"
        make_scan(scan)
        p = Pipeline(td / "out", history_path=td / "hist.json", out_date="20261029")
        fake = FakeReader()
        p._reader = fake
        orig = p.read

        def read(g):
            fake.current = g["pages"][0]["patient_name"]
            return orig(g)
        p.read = read
        res = p.run([scan])

        cases = {c["extraction"]["application"]["patient_name"]: c for c in res["cases"]}
        assert len(cases) == 5, cases.keys()
        assert len(res["blanks"]) == 1
        f = {k: [(x.sev, x.item) for x in c["findings"]] for k, c in cases.items()}
        assert (ERROR, "⑫用量上限") in f["架空一郎"]
        assert (ERROR, "⑬保険適応") in f["架空花子"]
        assert (ERROR, "⑦向精神薬") in f["架空次郎"]
        assert not any(i == "署名・押印" and s == ERROR for s, i in f["架空次郎"])     # キューバは押印なし可
        assert (ERROR, "⑩規格") in f["架空三郎"]
        assert not any("数量" in i for s, i in f["架空三郎"])                         # 100日分は指摘しない
        assert not any(s in (ERROR, CHECK) for s, i in f["架空四郎"]), f["架空四郎"]  # 確認済み処方はクリーン
        assert not any(i == "②職員コード" for s, i in f["架空三郎"])                 # a456789 = 456789

        out = td / "out"
        pdfs = sorted(x.name for x in (out / "pdf").glob("*.pdf"))
        assert "20261029架空一郎.pdf" in pdfs and len(pdfs) == 5
        assert pymupdf.open(out / "pdf" / "20261029架空次郎.pdf").page_count == 3   # 白紙は除外
        with zipfile.ZipFile(next(out.glob("*.zip"))) as z:
            assert all(i.flag_bits & 0x800 for i in z.infolist())
            assert "20261029架空花子.pdf" in z.namelist()
        assert "クリーン案件" in (out / "判定結果.md").read_text(encoding="utf-8")

        # 2回目：APIなし（work/ のJSONを再利用）で同じ結果になり、履歴との突き合わせも動く
        p2 = Pipeline(out, offline=True, history_path=td / "hist.json", out_date="20261029")
        res2 = p2.run([scan])
        assert len(res2["cases"]) == 5
        assert json.loads((td / "hist.json").read_text(encoding="utf-8"))["entries"]


def test_rules_dates_and_signature():
    rv = Reviewer(today=date(2026, 10, 29))
    c = case("架空五郎", "1", "在架空国大使館", "2026-10-05", "2026-01-10", "高血圧症", [drug("ノルバスク錠5mg", 5, "mg", 1, 30)], sign="記名")
    f = [(x.sev, x.item) for x in rv.review({"id": "t", "extraction": c})]
    assert (ERROR, "①有効期限") in f                 # 発行から3ヶ月超
    assert (ERROR, "署名・押印") not in f            # 9/4より前の発行：記名＋押印で旧基準OK
    c3 = case("架空七郎", "1", "在架空国大使館", "2026-10-20", "2026-10-10", "高血圧症", [drug("ノルバスク錠5mg", 5, "mg", 1, 30)], sign="記名")
    f3 = [(x.sev, x.item) for x in rv.review({"id": "t", "extraction": c3})]
    assert (ERROR, "署名・押印") in f3               # 10月申込・新書式期間：自筆署名なしはエラー
    c2 = case("架空六郎", "1", "在架空国大使館", "2026-09-20", "2026-09-10", "高血圧症", [drug("ノルバスク錠5mg", 5, "mg", 1, 30)], sign="記名")
    f2 = [(x.sev, x.item) for x in rv.review({"id": "t", "extraction": c2})]
    assert not any(i == "署名・押印" for s, i in f2)  # 9月の書類は書式要件を指摘しない


if __name__ == "__main__":
    test_pipeline()
    test_rules_dates_and_signature()
    print("OK")
