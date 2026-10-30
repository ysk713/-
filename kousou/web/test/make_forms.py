"""OCRテスト用：申込書・診断書・指示書を印刷様式に似せた画像だけのPDFにする（架空データ）。 python web/test/make_forms.py 出力.pdf"""
import sys
import pymupdf

PAGES = {
    "申込書": ["個人用医薬品購送申込書（様式A）", "申込日　令和8年10月20日", "所属公館名　在カクウ日本国大使館　公館コード 12345",
             "職員コード　A012345", "申込者氏名　架空 一郎", "□ 本申込書は申込者本人が記入、同意チェックを行いました"],
    "診断書": ["診　断　書", "氏　名　　：架空 一郎", "職員コード：012345", "所　属　　：在カクウ日本国大使館", "１．病名（慢性疾患）：",
             "（1）高血圧症", "２．服用薬・処方：", "（1）アムロジピン錠5mg 1回1錠 1日1回 朝食後", "令和8年10月10日　在カクウ日本国大使館",
             "医務官氏名：架空 医師　印"],
    "指示書": ["指　　示　　書", "令和8年10月10日　在カクウ日本国大使館", "健康管理医　架空 医師　印", "患者氏名　架空 一郎",
             "薬品名　含有量　用法・用量　１日分使用量", "（1）アムロジピン錠　5mg　1回1錠 1日1回 朝食後　1錠", "30　日分"],
}
doc = pymupdf.open()
for title, lines in PAGES.items():
    tmp = pymupdf.open(); tp = tmp.new_page()
    for k, line in enumerate(lines):
        tp.insert_text((60, 80 + k * 40), line, fontname="japan", fontsize=16 if k else 22)
    pix = tp.get_pixmap(dpi=200, colorspace=pymupdf.csGRAY)
    pg = doc.new_page(); pg.insert_image(pg.rect, stream=pix.tobytes("jpeg"))
doc.save(sys.argv[1])
