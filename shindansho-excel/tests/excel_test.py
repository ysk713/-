"""Excel版（shindansho-shijisho.xlsx）の使用テスト。

「入力」シートに値を入れ、LibreOffice で再計算（Excel で開いたのと同じように数式を計算）して、
「診断書」「指示書」シートの表示・整合性チェック・印刷のページ数（A4 と US Letter で各1枚か）を確かめる。

使い方（リポジトリのルートで）：
    python3 shindansho-excel/tests/excel_test.py                 # 決まったテスト（回帰テスト）
    python3 shindansho-excel/tests/excel_test.py --cases x.json  # 自分で作った入力例の結果を表示（毎日の試用で使う）
    オプション --png <フォルダ> で、印刷イメージ（PNG）も書き出す。

x.json の形：[{"title": "…", "input": {"E5": "試験", "B24": "…", ...}, "expect": {"指示書!E13": "1錠", ...}}]
expect の値は「その文字を含む」で判定する。先頭が "=" なら完全一致、"!" なら「含まない」。
必要なもの：LibreOffice（soffice）、pdfinfo、Python の openpyxl。
"""
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import openpyxl

SRC = Path(__file__).resolve().parent.parent / "shindansho-shijisho.xlsx"
PRINT_SHEETS = ["診断書", "指示書"]
PAPERS = {"A4": 9, "Letter": 1}
ERR = re.compile(r"^(#(VALUE|NAME|REF|DIV/0|N/A|NUM|NULL)[!?]?|Err:\d+)")

BASE = {  # 架空の患者・医師
    "E5": "試験", "H5": "太郎", "E6": "シケン", "H6": "タロウ", "D7": 1980, "F7": 4, "H7": 1,
    "D8": "12345", "F8": "本人", "E9": "試験", "H9": "太郎",
    "D11": "607C　東南アジア諸国連合日本政府代表部", "D12": "607C　東南アジア諸国連合日本政府代表部",
    "E15": "医務", "H15": "花子", "D18": "高血圧症",
}


def drug(row, name, strength, usage, dose, unit, form, days, nogeneric=False):
    d = {f"B{row}": name, f"C{row}": strength, f"D{row}": usage, f"E{row}": dose, f"F{row}": unit, f"H{row}": form, f"I{row}": days}
    if nogeneric:
        d[f"J{row}"] = "不可"
    return d


def today_issue():
    import datetime
    t = datetime.date.today()
    return {"D13": t.year, "F13": t.month, "H13": t.day}


def regression_cases():
    base = {**BASE, **today_issue()}
    ten = {}
    for i in range(10):
        ten.update(drug(24 + i, f"テスト薬{i + 1}号錠", "10mg", "分3 毎食後", 1, "錠", "錠剤", 30))
    return [
        {"title": "基本：分1・分2、後発品変更不可、日数がそろっている", "input": {**base,
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30),
            **drug(25, "メトホルミン錠", "250mg", "分2 朝夕食後", 2, "錠", "錠剤", 30, True)},
         "expect": {"入力!G24": "=1錠", "入力!G25": "=4錠", "指示書!A23": "30", "指示書!E23": "（2）",
                    "診断書!A16": "【後発品変更不可】", "入力!A43": "✅", "指示書!C7": "シケン　タロウ"}},
        {"title": "日数が薬ごとに違う", "input": {**base,
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30),
            **drug(25, "ロキソプロフェン錠", "60mg", "分3 毎食後", 1, "錠", "錠剤", 14)},
         "expect": {"指示書!A23": "日数は薬品ごとに記載", "指示書!E13": "30日分", "指示書!E14": "14日分"}},
        {"title": "頓服は回数", "input": {**base,
            **drug(24, "ロキソプロフェン錠", "60mg", "頓服 疼痛時", 1, "錠", "錠剤", 10)},
         "expect": {"入力!S24": "10回分", "診断書!A15": "10回分", "入力!G24": "="}},
        {"title": "用量の自由記載", "input": {**base,
            **drug(24, "アセトアミノフェン錠", "200mg", "頓服 発熱時", "1回1〜2錠（症状に応じて）", "錠", "錠剤", 10)},
         "expect": {"入力!R24": "1回1〜2錠（症状に応じて）", "指示書!C13": "1回1〜2錠"}},
        {"title": "家族（配偶者）は職員コードに続柄を併記", "input": {**base, "F8": "配偶者", "E5": "試験", "H5": "花美",
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"診断書!C5": "=12345（配偶者）"}},
        {"title": "購送できない剤形（液体）を整合性チェックで知らせる", "input": {**base,
            **drug(24, "カルボシステインシロップ", "5%", "分3 毎食後", 10, "mL", "液体", 14)},
         "expect": {"入力!E40": "!OK", "入力!A43": "⚠"}},
        {"title": "発行日が3か月より前なら期限切れ", "input": {**BASE, "D13": 2024, "F13": 1, "H13": 1,
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"入力!E37": "期限切れ"}},
        {"title": "10剤でも各1枚に収まる", "input": {**base, "D18": "高血圧症\n2型糖尿病\n脂質異常症\n高尿酸血症\n逆流性食道炎", **ten},
         "expect": {"指示書!A22": "テスト薬10号錠", "診断書!A24": "テスト薬10号錠",
                    # 病名を複数行で入れても、結びの文では「、」でつなぐ
                    "診断書!A26": "高血圧症、2型糖尿病、脂質異常症、高尿酸血症、逆流性食道炎にて", "診断書!A11": "逆流性食道炎"}},
        {"title": "全角数字・「1錠」・「30日」でも計算する", "input": {**base,
            **drug(24, "アムロジピン錠", "5mg", "分１ 朝食後", "１", "錠", "錠剤", "30日"),
            **drug(25, "ロスバスタチン錠", "2.5mg", "分1 夕食後", "1錠", "錠", "錠剤", "３０")},
         "expect": {"入力!G24": "=1錠", "入力!G25": "=1錠", "診断書!A15": "1回1錠（1日1錠）　30日分", "診断書!A16": "!日日分",
                    "指示書!A23": "30", "指示書!E13": "=1錠"}},
        {"title": "「1日2回」は1日の回数（日分）として扱う", "input": {**base,
            **drug(24, "テスト吸入薬", "100μg", "1日2回", 1, "その他", "吸入薬（ガス不使用・喘息用）", 30)},
         "expect": {"入力!S24": "=30日分", "入力!G24": "=2", "入力!E40": "=OK"}},
        {"title": "公館コードを選ぶと右に公館名が出る", "input": {**base,
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"入力!G11": "=東南アジア諸国連合日本政府代表部", "入力!G12": "=東南アジア諸国連合日本政府代表部"}},
        {"title": "配合剤（含有量に「配合」）は診断書で重ねない・生年が2桁や月日なしは①で知らせる", "input": {**base, "D7": "80", "F7": "", "H7": "",
            **drug(24, "テスト配合錠", "配合", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"診断書!A15": "テスト配合錠　分1", "入力!E39": "=OK", "入力!E36": "生年月日（西暦4桁"}},
        {"title": "コピー貼り付けの改行・空白を印刷で取り除く、全角の職員コードは半角で印刷", "input": {**base, "D8": "１２３４５",
            **drug(24, "アムロジピン錠\n", " 5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"診断書!A15": "=（1）アムロジピン錠5mg　分1 朝食後　1回1錠（1日1錠）　30日分", "指示書!A13": "!\n", "指示書!B13": "=5mg", "診断書!C5": "=12345"}},
        {"title": "単位・剤形の空欄、日数「1ヶ月」は整合性チェック④で知らせる", "input": {**base,
            **drug(24, "セレコキシブ錠", "100mg", "分2 朝夕食後", 1, "", "", "1ヶ月")},
         "expect": {"入力!E39": "単位／剤形／日数（数字で", "入力!A43": "⚠"}},
        {"title": "発行日が今日より後なら整合性チェック②で知らせる", "input": {**BASE, "D13": 2099, "F13": 1, "H13": 1,
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"入力!E37": "今日より後の日付", "入力!A43": "⚠"}},
        {"title": "実在しない日付（2月30日）・抜けた項目だけを①に出す", "input": {**base, "F7": 2, "H7": 30, "D11": "",
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"入力!E36": "=未入力・誤りあり：生年月日（西暦4桁・実在する月日）／患者所属"}},
        {"title": "単位がmLなら剤形が錠剤でも液体として⑤で知らせる", "input": {**base,
            **drug(24, "カルボシステインシロップ", "5%", "分3 毎食後", 5, "mL", "錠剤", 14)},
         "expect": {"入力!E40": "単位がmLの薬は液体", "入力!A43": "⚠"}},
        {"title": "用量「1T」（錠の略）も数値として計算", "input": {**base,
            **drug(24, "レンボレキサント錠", "5mg", "1日1回 寝る前", "1T", "錠", "錠剤", 30)},
         "expect": {"入力!G24": "=1錠", "診断書!A15": "1回1錠（1日1錠）"}},
        {"title": "不均等（朝・夕）の欄：1日量を計算し「1日3錠（朝2錠・夕1錠）」と印刷", "input": {**base,
            **drug(24, "メトホルミン錠", "250mg", "分2 朝夕食後", "", "錠", "錠剤", 30), "K24": 2, "M24": "１"},
         "expect": {"入力!G24": "=3錠", "診断書!A15": "1日3錠（朝2錠・夕1錠）　30日分", "指示書!C13": "朝2錠・夕1錠", "指示書!E13": "=3錠", "入力!E39": "=OK"}},
        {"title": "用量「1-2」「1〜2」には単位を付ける", "input": {**base,
            **drug(24, "トラマドール塩酸塩OD錠", "25mg", "頓服（疼痛時）", "1-2", "錠", "錠剤", 10),
            **drug(25, "アセトアミノフェン錠", "200mg", "頓服（発熱時）", "1〜2", "錠", "錠剤", 10)},
         "expect": {"診断書!A15": "1回1-2錠", "指示書!C13": "1回1-2錠", "診断書!A16": "1回1〜2錠"}},
        {"title": "薬品名に規格まで書いたときは、診断書で含有量を重ねない", "input": {**base,
            **drug(24, "ロキソプロフェンNaテープ100mg", "100mg", "1日1回", 1, "枚", "貼り薬（湿布薬）", 28)},
         "expect": {"診断書!A15": "!100mg100mg", "指示書!B13": "=100mg"}},
        {"title": "一覧にない公館コードは①で知らせる", "input": {**base, "D11": "999Z",
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"入力!E36": "患者所属（一覧にない公館コード）", "入力!A43": "⚠"}},
        {"title": "日数0・用量と不均等の両方・不均等の数と分nの違いは④で知らせる", "input": {**base,
            **drug(24, "ロスバスタチン錠", "2.5mg", "分1 夕食後", 1, "錠", "錠剤", 0)},
         "expect": {"入力!E39": "入力漏れ・不整合あり"}},
        {"title": "用量と不均等の両方に入れると④で知らせる", "input": {**base,
            **drug(24, "グリメピリド錠", "1mg", "分2 朝夕食前", 1, "錠", "錠剤", 30), "K24": 2, "M24": 1},
         "expect": {"入力!E39": "どちらか一方"}},
        {"title": "分2なのに不均等を3か所入れると④で知らせる", "input": {**base,
            **drug(24, "クエチアピン錠", "25mg", "分2 朝夕食後", "", "錠", "錠剤", 30), "K24": 1, "M24": 1, "N24": 4},
         "expect": {"入力!E39": "入力漏れ・不整合あり"}},
        {"title": "用量「半錠」は0.5錠として計算", "input": {**base,
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", "半錠", "錠", "錠剤", 30)},
         "expect": {"入力!G24": "=0.5錠", "診断書!A15": "1回0.5錠（1日0.5錠）"}},
        {"title": "生年月日・発行日を年の欄に日付ごと貼り付けても使える", "input": {**base, "D7": "__DATE__1980-04-01", "F7": "", "H7": "",
            "D13": "__DATE__" + __import__("datetime").date.today().isoformat(), "F13": "", "H13": "",
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"診断書!C7": "=1980年4月1日", "指示書!C8": "=西暦1980年4月1日", "入力!E36": "=OK", "入力!E37": "OK（有効期限", "診断書!A31": "年"}},
        {"title": "用法の全角数字・全角スペース（分２　朝夕食後）も1日の回数として扱う", "input": {**base,
            **drug(24, "メトホルミン錠", "250mg", "分２　朝夕食後", 1, "錠", "錠剤", 30)},
         "expect": {"入力!G24": "=2錠", "入力!S24": "=30日分"}},
        {"title": "病名の空行・最後の改行は結びの文でつながない", "input": {**base, "D18": "高血圧症\n\n2型糖尿病\n",
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"診断書!A26": "高血圧症、2型糖尿病にて", "入力!E36": "=OK"}},
        {"title": "表の下（34行目）に11件目を書くと③で知らせる", "input": {**base,
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30), "B34": "テスト薬11号錠"},
         "expect": {"入力!E38": "11件目以降は印刷されません", "入力!A43": "⚠"}},
        {"title": "本人なら職員氏名は空でよい", "input": {**base, "F8": "本人", "E9": "", "H9": "",
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"入力!E36": "=OK"}},
        {"title": "家族なら職員氏名が要る", "input": {**base, "F8": "配偶者", "E9": "", "H9": "",
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"入力!E36": "職員氏名（家族のとき）"}},
        {"title": "フリガナ：半角カナは全角で印刷、ひらがなは①で知らせる", "input": {**base, "E6": "しけん", "H6": "ﾀﾛｳ",
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"指示書!C7": "=しけん　タロウ", "入力!E36": "フリガナ（カタカナで）"}},
        {"title": "単位「その他」は印刷しない", "input": {**base,
            **drug(24, "テスト吸入粉末剤", "200μg", "1日2回", 1, "その他", "吸入薬（ガス不使用・喘息用）", 30)},
         "expect": {"診断書!A15": "1回1（1日2）", "指示書!C13": "!その他", "指示書!E13": "=2"}},
        {"title": "病名が6行以上なら、診断書の病名欄は「、」でつなぐ", "input": {**base, "D18": "高血圧症\n2型糖尿病\n脂質異常症\n高尿酸血症\n逆流性食道炎\n骨粗鬆症\n気管支喘息",
            **drug(24, "アムロジピン錠", "5mg", "分1 朝食後", 1, "錠", "錠剤", 30)},
         "expect": {"診断書!A11": "=高血圧症、2型糖尿病、脂質異常症、高尿酸血症、逆流性食道炎、骨粗鬆症、気管支喘息"}},
        {"title": "カプセルの剤形", "input": {**base,
            **drug(24, "ソリフェナシン", "5mg", "分1 朝食後", 1, "カプセル", "カプセル", 30)},
         "expect": {"入力!E40": "=OK", "入力!A43": "✅"}},
    ]


def check_template():
    """テンプレートそのものの確認（入力規則・書式）。問題の一覧を返す。"""
    wb = openpyxl.load_workbook(SRC)
    ws = wb["入力"]
    problems = []
    forms = [dv.formula1 for dv in ws.data_validations.dataValidation if "H24" in str(dv.sqref)]
    if not forms or "カプセル" not in forms[0]:
        problems.append("剤形の一覧（H24:H33）に「カプセル」がない")
    if "印刷しません" not in str(ws["A16"].value):
        problems.append("医務官氏名は印刷しない旨の注意書き（A16）がない")
    if not ws["D18"].alignment.wrap_text:
        problems.append("病名の入力欄（D18）が折り返さない（横に伸びる）")
    return problems


def fill(case, path):
    wb = openpyxl.load_workbook(SRC)
    ws = wb["入力"]
    for cell, value in case["input"].items():
        # "__DATE__2026-11-08" は日付として入れる（セルに日付を貼り付けた場合の再現）
        if isinstance(value, str) and value.startswith("__DATE__"):
            import datetime
            value = datetime.datetime.strptime(value[8:], "%Y-%m-%d")
        ws[cell] = value
    wb.save(path)


def soffice(args, cwd):
    subprocess.run(["soffice", "--headless", "--calc", *args], cwd=cwd, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)


def pdf_for_paper(calc_xlsx, paper, outdir):
    """診断書・指示書だけを残し、用紙を指定して PDF にする。ページ数と PDF のパスを返す。"""
    # 計算済みの値だけで開き（数式は使わない）、診断書・指示書以外のシートを消す（隠すだけでは PDF に出ることがある）
    wb = openpyxl.load_workbook(calc_xlsx, data_only=True)
    for ws in list(wb.worksheets):
        if ws.title in PRINT_SHEETS:
            ws.page_setup.paperSize = PAPERS[paper]
        else:
            wb.remove(ws)
    wb.active = 0
    name = Path(calc_xlsx).stem + f"_{paper}.xlsx"
    p = Path(outdir) / name
    wb.save(p)
    return p


def run(cases, png_dir=None):
    work = Path(tempfile.mkdtemp(prefix="excel-test-"))
    try:
        files = []
        for i, c in enumerate(cases):
            f = work / f"case{i:02d}.xlsx"
            fill(c, f)
            files.append(f.name)
        (work / "calc").mkdir()
        soffice(["--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", "calc", *files], work)
        # 印刷のページ数（A4・Letter）
        (work / "paper").mkdir()
        papers = []
        for i, _ in enumerate(cases):
            for paper in PAPERS:
                papers.append(pdf_for_paper(work / "calc" / files[i], paper, work / "paper").name)
        (work / "pdf").mkdir()
        soffice(["--convert-to", "pdf", "--outdir", "../pdf", *papers], work / "paper")

        results = []
        for i, c in enumerate(cases):
            wb = openpyxl.load_workbook(work / "calc" / files[i], data_only=True)
            problems, shown = [], {}
            for sheet in ["入力", *PRINT_SHEETS]:
                for row in wb[sheet].iter_rows():
                    for cell in row:
                        if isinstance(cell.value, str) and ERR.match(cell.value):
                            problems.append(f"{sheet}!{cell.coordinate} が {cell.value}")
            for ref, want in (c.get("expect") or {}).items():
                sheet, cell = ref.split("!")
                got = wb[sheet][cell].value
                got = "" if got is None else str(got)
                shown[ref] = got
                ok = (got == want[1:]) if want.startswith("=") else (want[1:] not in got) if want.startswith("!") else (want in got)
                if not ok:
                    problems.append(f"{ref}：期待「{want}」／実際「{got}」")
            pages = {}
            for paper in PAPERS:
                pdf = work / "pdf" / (Path(files[i]).stem + f"_{paper}.pdf")
                info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
                n = int(re.search(r"Pages:\s+(\d+)", info).group(1))
                pages[paper] = n
                if n != len(PRINT_SHEETS):
                    problems.append(f"{paper} で {n} ページ（診断書・指示書で2ページのはず）")
                if png_dir:
                    Path(png_dir).mkdir(parents=True, exist_ok=True)
                    subprocess.run(["pdftoppm", "-png", "-r", "60", str(pdf), str(Path(png_dir) / f"case{i:02d}_{paper}")], check=True)
            summary = {"診断書": [str(wb["診断書"][r].value) for r in ("A15", "A16", "A26")]}
            detail = []
            for r in range(24, 34):
                if wb["入力"][f"B{r}"].value:
                    n = r - 23
                    ins = wb["指示書"]
                    detail.append(f"診断書：{wb['診断書'][f'A{14 + n}'].value}")
                    detail.append(f"指示書：{ins[f'A{12 + n}'].value}｜{ins[f'B{12 + n}'].value or ''}｜{ins[f'C{12 + n}'].value or ''}｜{ins[f'E{12 + n}'].value or ''}")
            detail.append(f"指示書の日数欄：{wb['指示書']['A23'].value}　{wb['指示書']['E23'].value or ''}")
            detail.append(f"診断書の結び：{wb['診断書']['A26'].value}")
            for r in range(36, 41):
                v = str(wb["入力"][f"E{r}"].value)
                if not v.startswith("OK"):
                    detail.append(f"整合性チェック{r - 35}：{v}")
            results.append({"title": c["title"], "problems": problems, "pages": pages, "shown": shown, "detail": detail,
                            "check": wb["入力"]["A43"].value, "診断書": summary["診断書"]})
        return results
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    args = sys.argv[1:]
    png = args[args.index("--png") + 1] if "--png" in args else None
    if "--cases" in args:
        cases = json.load(open(args[args.index("--cases") + 1], encoding="utf-8"))
        for c in cases:
            c["input"] = {**BASE, **today_issue(), **c["input"]}
    else:
        cases = regression_cases()
    results = run(cases, png)
    ng = 0
    tp = check_template()
    print(("NG" if tp else "OK") + " テンプレート（入力規則・病名欄の折り返し）")
    for p in tp:
        print("      " + p)
    ng += bool(tp)
    for r in results:
        mark = "NG" if r["problems"] else "OK"
        ng += bool(r["problems"])
        print(f"{mark} {r['title']}（A4 {r['pages']['A4']}ページ・Letter {r['pages']['Letter']}ページ）")
        for p in r["problems"]:
            print("      " + p)
        if "--cases" in args:
            print("      整合性チェック：" + str(r["check"]))
            for d in r["detail"]:
                print("      " + d)
            for k, v in r["shown"].items():
                print(f"      {k}：{v}")
    print(f"\n{ng}件 失敗" if ng else f"\nすべて成功（{len(results) + 1}件）")
    sys.exit(1 if ng else 0)


if __name__ == "__main__":
    main()
