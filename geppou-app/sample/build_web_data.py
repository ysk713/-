"""ブラウザ版（geppou/）が使う data.js と国旗画像を、Python版のマスタから作り直す。

    python3 geppou-app/sample/build_web_data.py [flag-icons の flags/4x3 ディレクトリ]

公館マスタ（posts.py）・疾病分類（icd.py）・出来事キーワード（parsing.py）を変えたら実行する。
国旗は flag-icons（MIT）の SVG のうち、マスタに出てくる国の分だけを geppou/lib/flags/ に置く。
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
from geppou import icd, posts  # noqa: E402
from geppou.parsing import EVENT_KEYWORDS  # noqa: E402

WEB = os.path.join(HERE, "..", "..", "geppou")


def main():
    d = dict(
        regions=posts.REGIONS,
        posts=[dict(name=n, region=r, iso3=i, iso2=posts.ISO2.get(i), lat=la, lon=lo, aliases=a) for n, r, i, la, lo, a in posts.POSTS],
        extra=[dict(name=n, region=r, iso3=i, iso2=posts.ISO2.get(i), lat=la, lon=lo) for n, r, i, la, lo in posts.EXTRA_PLACES],
        rules=[[c, k] for c, k in icd.CLASSIFICATION_RULES], z=icd.Z_CATEGORY, other=icd.OTHER,
        short=icd.SHORT, colors=icd.COLORS, events=EVENT_KEYWORDS,
    )
    with open(os.path.join(WEB, "data.js"), "w", encoding="utf-8") as f:
        f.write("// 公館マスタ・疾病分類ルール（geppou-app/sample/build_web_data.py で posts.py, icd.py から生成）\n")
        f.write("window.GEPPOU_DATA = " + json.dumps(d, ensure_ascii=False, indent=1) + ";\n")
    print("wrote data.js")
    if len(sys.argv) > 1:
        src = sys.argv[1]
        dst = os.path.join(WEB, "lib", "flags")
        os.makedirs(dst, exist_ok=True)
        codes = sorted({v["iso2"] for v in posts.INFO.values() if v["iso2"]})
        for c in codes:
            shutil.copy(os.path.join(src, f"{c}.svg"), os.path.join(dst, f"{c}.svg"))
        lic = os.path.join(src, "..", "..", "LICENSE")
        if os.path.exists(lic):
            shutil.copy(lic, os.path.join(dst, "LICENSE"))
        print(f"copied {len(codes)} flags")


if __name__ == "__main__":
    main()
