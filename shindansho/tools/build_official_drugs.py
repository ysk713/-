"""厚生労働省「医薬品マスター」（診療報酬情報提供サービスの y_YYYYMMDD.csv）から drugs-official.js を作る。

使い方（リポジトリのルートで）：
    python3 shindansho/tools/build_official_drugs.py y_20260317.csv

内用薬（剤形区分 1）のすべてと、外用薬のうち貼り薬（テープ・パップ・パッチ）を取り出し、
薬品名・単位・規制区分（麻薬／毒薬／覚醒剤原料／向精神薬）・一般名処方の記載をアプリで使う形にする。
新しい医薬品マスターが出たら、このスクリプトをもう一度実行して drugs-official.js を差し替える。
"""
import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

# 医薬品マスターの列（0始まり）
NAME, UNIT, REG, FORM, ABOLISHED, GENERIC = 4, 9, 13, 27, 30, 37
PATCH = re.compile(r"テープ|パップ|パッチ|貼付")


def main(src: str) -> None:
    rows = list(csv.reader(open(src, encoding="cp932")))
    date = re.search(r"(\d{8})", Path(src).name)
    out = []
    for r in rows:
        if len(r) <= GENERIC or r[ABOLISHED] not in ("99999999", ""):
            continue
        name = r[NAME].strip()
        if r[FORM] == "1" or (r[FORM] == "6" and PATCH.search(unicodedata.normalize("NFKC", name))):
            generic = r[GENERIC].strip().replace("【般】", "")
            # 1行＝「薬品名\t単位\t規制区分\t一般名」。規制区分 1=麻薬 2=毒薬 3=覚醒剤原料 5=向精神薬
            out.append("\t".join([name, unicodedata.normalize("NFKC", r[UNIT]).strip(), r[REG], generic]))
    out.sort()
    text = "\n".join(out)
    dest = Path(__file__).resolve().parent.parent / "drugs-official.js"
    dest.write_text(
        "// 厚生労働省「医薬品マスター」（診療報酬情報提供サービス）から作成した内用薬・貼り薬の一覧。\n"
        f"// 元データ：{Path(src).name}（{len(out)}品目）。作り方：python3 shindansho/tools/build_official_drugs.py <医薬品マスターのCSV>\n"
        "// 1行＝「薬品名\\t単位\\t規制区分（1 麻薬・2 毒薬・3 覚醒剤原料・5 向精神薬・0 なし）\\t一般名処方の記載」\n"
        f"window.OFFICIAL_DRUGS_DATE = {json.dumps(date.group(1) if date else '')};\n"
        f"window.OFFICIAL_DRUGS = {json.dumps(text, ensure_ascii=False)};\n",
        encoding="utf-8",
    )
    print(f"{dest}: {len(out)}品目, {dest.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main(sys.argv[1])
