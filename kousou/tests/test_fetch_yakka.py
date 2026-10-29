"""fetch_yakka.py のテスト（厚労省の形式をまねた架空のExcelとページで確認）。 python kousou/tests/test_fetch_yakka.py"""
import json
import sys
import tempfile
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import fetch_yakka as fy  # noqa: E402

HEAD = ["区分", "薬価基準収載医薬品コード", "成分名", "規格", "", "品名", "メーカー名",
        "診療報酬において加算等の算定対象となる後発医薬品", "先発医薬品", "同一剤形・規格の後発医薬品がある先発医薬品", "薬価", "経過措置による使用期限", "備考"]


def book(path, kind, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append([f"薬価基準収載品目リスト（{kind}）"])
    ws.append([])
    ws.append(HEAD)
    for r in rows:
        ws.append(r)
    wb.save(path)


def rows(kind, n, extra=()):
    out = [[kind, f"2171022F{i:04d}", "アムロジピンベシル酸塩", f"{[2.5, 5, 10][i % 3]}mg1錠", "", f"アムロジピン錠{[2.5, 5, 10][i % 3]}mg「社{i}」",
            f"社{i}", "後発品", "", "", 10.1, "", ""] for i in range(n)]
    return out + [list(e) for e in extra]


def test_all():
    page = '''<h3>内用薬</h3><a href="/topics/2026/04/xls/tp20260401-01_01.xlsx">内用薬（Excel：2MB）</a>
              <td>外用薬</td><td><a href="xls/tp20260401-01_03.xlsx">Excel</a></td>
              <a href="xls/tp20260401-01_02.xlsx">注射薬（Excel）</a>'''
    links = fy.find_excel_links(page, "https://www.mhlw.go.jp/topics/2026/04/tp20260401-01.html")
    assert links == {"内用薬": "https://www.mhlw.go.jp/topics/2026/04/xls/tp20260401-01_01.xlsx",
                     "外用薬": "https://www.mhlw.go.jp/topics/2026/04/xls/tp20260401-01_03.xlsx"}, links
    assert fy.candidate_pages(fy.date(2026, 10, 29))[0] == "https://www.mhlw.go.jp/topics/2026/04/tp20260401-01.html"

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        nai, gai = td / "naiyou.xlsx", td / "gaiyou.xlsx"
        book(nai, "内用薬", rows("内用薬", 1200, [("内用薬", "2149044F1020", "アムロジピンベシル酸塩", "5mg1錠", "", "ノルバスク錠5mg", "ヴィアトリス", "", "先発品", "○", 15.2, "", "")]))
        book(gai, "外用薬", [["外用薬", "2649735S1020", "ロキソプロフェンナトリウム水和物", "10cm×14cm1枚", "", "ロキソニンテープ100mg", "第一三共", "", "先発品", "", 30.0, "", ""]])
        out = td / "data"
        assert fy.main(["--xlsx", str(nai), str(gai), "--out", str(out), "--today", "2026-10-29"]) == 0
        y = json.loads((out / "yakka.json").read_text(encoding="utf-8"))
        names = {r[0]: r for r in y["items"]}
        assert names["ノルバスク錠5mg"][1:5] == ["アムロジピンベシル酸塩", "5mg1錠", "内用", 1], names["ノルバスク錠5mg"]
        assert names["ロキソニンテープ100mg"][3] == "外用"
        assert y["first_seen"] == {}                       # 初回は全成分「以前から収載」
        # 翌月：新しい成分が現れたら、その月を記録する（→14日制限の判定に使う）
        book(nai, "内用薬", rows("内用薬", 1200, [("内用薬", "3999999F1020", "シンヤクマブ", "50mg1錠", "", "シンヤク錠50mg", "架空製薬", "", "先発品", "", 999.0, "", "")]))
        assert fy.main(["--xlsx", str(nai), "--out", str(out), "--today", "2026-11-05"]) == 0
        y = json.loads((out / "yakka.json").read_text(encoding="utf-8"))
        assert y["first_seen"] == {"シンヤクマブ": "2026-11"}, y["first_seen"]
        # 件数が少なすぎる（形式が変わった等）ときは失敗にして、既存データを残す
        book(nai, "内用薬", rows("内用薬", 10))
        assert fy.main(["--xlsx", str(nai), "--out", str(out), "--today", "2026-12-05"]) == 1
        assert json.loads((out / "yakka.json").read_text(encoding="utf-8"))["fetched"] == "2026-11-05"
        assert "取り込み失敗" in (out / "yakka_report.md").read_text(encoding="utf-8")
    print("test_fetch_yakka OK")


if __name__ == "__main__":
    test_all()
