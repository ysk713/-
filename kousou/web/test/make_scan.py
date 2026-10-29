"""E2Eテスト用の合成スキャンPDF（架空5人×3枚＋白紙1枚）。 python web/test/make_scan.py 出力先.pdf"""
import sys
import pymupdf

NAMES = ["架空一郎", "架空花子", "架空次郎", "架空三郎", "架空四郎"]
doc = pymupdf.open()
for n in NAMES:
    for t in ("申込書", "診断書", "指示書"):
        tmp = pymupdf.open()
        tp = tmp.new_page()
        for k in range(30):
            tp.insert_text((50, 60 + k * 24), f"{t} {n} ダミー本文 ■■■■■■■■■■■■■■", fontname="japan", fontsize=14)
        pix = tp.get_pixmap(dpi=100, colorspace=pymupdf.csGRAY)  # 実際のスキャンと同じく画像だけのページにする
        pg = doc.new_page()
        pg.insert_image(pg.rect, stream=pix.tobytes("jpeg"))
    if n == "架空次郎":
        blank = doc.new_page()
        blank.insert_image(blank.rect, stream=pymupdf.open().new_page().get_pixmap(dpi=100).tobytes("jpeg"))
doc.save(sys.argv[1])
