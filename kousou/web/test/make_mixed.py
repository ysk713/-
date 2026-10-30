"""氏名分割のテスト用：3人分（同じ姓の家族を含む）の書類をばらばらの順で並べ、1枚は横向きにした画像PDF（架空データ）。"""
import io
import sys

import pymupdf
from PIL import Image

def page(kind, name, date, extra=()):
    title = {"申込書": "個人用医薬品購送申込書（様式A）", "診断書": "診　断　書", "指示書": "指　　示　　書"}[kind]
    lines = [title]
    if kind == "申込書":
        lines += [f"申込日　{date}", "所属公館名　在カクウ日本国大使館", "職員コード　A012345", f"申込者氏名　{name}"]
    elif kind == "診断書":
        lines += [f"氏　名　　：{name}", "職員コード：012345", "１．病名（慢性疾患）：", "（1）高血圧症", f"{date}　在カクウ日本国大使館", "医務官氏名：見本 医師　印"]
    else:
        lines += [f"{date}　在カクウ日本国大使館", "健康管理医　見本 医師　印", f"患者氏名　{name}", "（1）アムロジピン錠　5mg　1回1錠 1日1回 朝食後　1錠", "30　日分"]
    t = pymupdf.open(); p = t.new_page()
    for k, l in enumerate(lines + list(extra)):
        p.insert_text((60, 80 + k * 40), l, fontname="japan", fontsize=22 if k == 0 else 16)
    return Image.open(io.BytesIO(p.get_pixmap(dpi=150, colorspace=pymupdf.csGRAY).tobytes("png")))

ORDER = [("申込書", "架空 一郎", 0), ("申込書", "架空 花子", 0), ("診断書", "架空 一郎", 0), ("指示書", "架空 一郎", 0),
         ("診断書", "架空 花子", 90), ("申込書", "見本 三郎", 0), ("指示書", "見本 三郎", 0), ("指示書", "架空 花子", 0)]
doc = pymupdf.open()
for kind, name, rot in ORDER:
    im = page(kind, name, "令和8年10月20日" if kind == "申込書" else "令和8年10月10日").rotate(rot, expand=True, fillcolor=255)
    b = io.BytesIO(); im.save(b, "JPEG", quality=70)
    pg = doc.new_page(width=im.width * 0.48, height=im.height * 0.48); pg.insert_image(pg.rect, stream=b.getvalue())
doc.save(sys.argv[1])
