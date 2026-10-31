"""スキャン風に劣化させて1つのPDFにする：向き（0/90/180/270）・傾き（±3度）・解像度（100〜200dpi）・ぼけ・点ノイズ・JPEG圧縮・白黒/カラー。
  python degrade.py 出力.pdf seed 画像1.png 画像2.png ...（BLANK は白紙）"""
import io
import random
import sys

import pymupdf
from PIL import Image, ImageFilter

out, seed, files = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
rnd = random.Random(seed)
doc = pymupdf.open()
meta = []
for f in files:
    im = Image.new("RGB", (1588, 2246), "white") if f == "BLANK" else Image.open(f).convert("RGB")
    dpi = rnd.choices([100, 150, 200, 300], [0.1, 0.2, 0.4, 0.3])[0]   # 事務所の複合機は200〜300dpiが多い。粗いものも混ぜる
    im = im.resize((int(8.27 * dpi), int(11.69 * dpi)))
    rot = rnd.choices([0, 90, 180, 270], [0.6, 0.15, 0.15, 0.1])[0]
    meta.append({"dpi": dpi, "rot": rot})
    im = im.rotate(rot + rnd.uniform(-3, 3), expand=True, fillcolor=(255, 255, 255))
    if rnd.random() < 0.5:
        im = im.filter(ImageFilter.GaussianBlur(rnd.uniform(0.3, 1.0)))
    if rnd.random() < 0.5:
        im = im.convert("L").convert("RGB")
    px = im.load()
    for _ in range(int(im.width * im.height * rnd.uniform(0, 0.001))):
        px[rnd.randrange(im.width), rnd.randrange(im.height)] = (0, 0, 0)
    b = io.BytesIO(); im.save(b, "JPEG", quality=rnd.randint(35, 80))
    pg = doc.new_page(width=im.width * 72 / dpi, height=im.height * 72 / dpi)
    pg.insert_image(pg.rect, stream=b.getvalue())
doc.save(out)
import json
json.dump(meta, open(out.replace(".pdf", "_scan.json"), "w"))
print(out, len(files), "pages")
