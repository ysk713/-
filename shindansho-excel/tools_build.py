"""テンプレートを直したあとに実行する：印刷用シートを作り直し、見本（架空のデータ入り）とテンプレート形式（.xltx）を作る。
    python3 shindansho-excel/tools_build.py
"""
import shutil
from pathlib import Path
import openpyxl
import tools_make_print_sheet as PS

D = Path(__file__).resolve().parent
SRC = D / "shindansho-shijisho.xlsx"
SAMPLE = {"D3": "2026/11/20", "E5": "試験", "H5": "花子", "E6": "シケン", "H6": "ハナコ", "D7": "1980/4/1", "E8": "A01234", "H8": "配偶者", "E9": "試験", "H9": "太郎",
          "D11": "タイ", "D12": "タイ", "E15": "見本", "H15": "医務官", "D18": "高血圧症\n2型糖尿病\n気管支喘息\n腰痛症", "D21": "朝食後", "E21": 1, "F21": "錠", "J21": 90,
          "B24": "アムロジピン錠", "C24": "5mg", "K24": "✓", "B25": "メトホルミン錠", "C25": "250mg", "D25": "朝夕食後", "M25": 2, "O25": 1,
          "B26": "ロスバスタチン錠", "C26": "2.5mg", "D26": "夕食後",
          "B27": "シムビコートタービュヘイラー30吸入", "C27": "配合", "D27": "1日2回 1回2吸入", "E27": 1, "F27": "本", "I27": "吸入薬（ガス不使用・喘息用）", "J27": 30,
          "B28": "ロキソプロフェン錠", "C28": "60mg", "D28": "疼痛時", "J28": 20, "L28": "1日3回まで",
          "B29": "ロキソプロフェンテープ", "C29": "100mg", "D29": "1日1回", "F29": "枚", "J29": 28}

wb = openpyxl.load_workbook(SRC)
PS.build(wb)
wb.save(SRC)

wb = openpyxl.load_workbook(SRC)
for k, v in SAMPLE.items():
    wb["入力"][k] = v
a1 = wb["入力"]["A1"].value
wb["入力"]["A1"] = ('="【見本・架空のデータ】"&' + a1[1:]) if str(a1).startswith("=") else "【見本・架空のデータ】" + a1
wb.calculation.fullCalcOnLoad = True
wb.properties.title = "購送書類アシスタント Excel版 見本（架空のデータ）"
wb.save(D / "shindansho-shijisho_mihon.xlsx")

wb = openpyxl.load_workbook(SRC)
wb.template = True          # 開くたびに新しいブックになる（原本を上書きしない）
wb.save(D / "shindansho-shijisho.xltx")
print("印刷用シート・見本・テンプレート形式（.xltx）を作り直しました")
