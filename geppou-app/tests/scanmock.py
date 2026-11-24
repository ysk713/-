"""スキャンした月報（甲表1ページ＋乙表2ページ・画像だけのPDF）の模擬データを作る。OCRのテスト用。
すべて架空の数値・架空の医務官名。病名は疾病分類表の正式な名前（geppou/stdnames.py）から選ぶ。
傾き・ぼけ・ごみの点・白黒化・字の太さの変化を加えて、実際のスキャンに近づける。
"""
import sys, json, random, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from geppou.stdnames import STD_NAMES
from PIL import Image, ImageDraw, ImageFont, ImageFilter
FONT = "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"
F = lambda s: ImageFont.truetype(FONT, s)
POSTS = [("在ニューヨーク総領事館", "ニューヨーク総領事館", "NY"), ("在マイアミ総領事館", "マイアミ総領事館", "Miami"), ("在ケニア日本国大使館", "ケニア", "ケニア"),
         ("在タイ日本国大使館", "タイ", "タイ"), ("在ブラジル日本国大使館", "ブラジル", "ブラジル"), ("在インド日本国大使館", "インド", "インド"),
         ("在ロサンゼルス総領事館", "ロサンゼルス総領事館", "LA"), ("在ドイツ日本国大使館", "ドイツ", "ドイツ")]
SURN = ["架空", "見本", "例示", "模擬", "試案", "仮名", "素案", "原案"]; GIV = ["太郎", "花子", "一郎", "陽子", "健", "真理"]
ROWS = [("感染症及び寄生虫症", "A00-B99", "AB"), ("新生物", "C00-D48", "C"), ("血液及び造血器の疾患並びに免疫機構の障害", "D50-D89", "D"),
        ("内分泌，栄養及び代謝疾患", "E00-E90", "E"), ("精神及び行動の障害", "F00-F99", "F"), ("神経系の疾患", "G00-G99", "G"),
        ("眼及び付属器の疾患", "H00-H59", "H0"), ("耳及び乳様突起の疾患", "H60-H95", "H6"), ("循環器系の疾患", "I00-I99", "I"),
        ("呼吸器系の疾患", "J00-J99", "J"), ("消化器系の疾患", "K00-K93", "K"), ("皮膚及び皮下組織の疾患", "L00-L99", "L"),
        ("筋骨格系及び結合組織の疾患", "M00-M99", "M"), ("腎尿路生殖器系の疾患", "N00-N99", "N"), ("妊娠，分娩及び産じょく<褥>", "O00-O99", "O"),
        ("周産期に発生した病態", "P00-P96", "P"), ("先天奇形，変形及び染色体異常", "Q00-Q99", "Q"), ("症状，徴候及び異常臨床所見・異常検査所見で他に分類されないもの", "R00-R99", "R"),
        ("損傷，中毒及びその他の外因の影響", "S00-T98", "ST"), ("傷病及び死亡の外因", "V00-Y98", "VWXY"), ("健康状態に影響を及ぼす要因及び保健サービスの利用", "Z00-Z99", "Z")]
def pool(row):
    key = row[2]
    def ok(code):
        if key == "H0": return code.startswith("H") and int(code[1:]) < 60
        if key == "H6": return code.startswith("H") and int(code[1:]) >= 60
        if key == "C": return code.startswith("C") or (code.startswith("D") and int(code[1:]) < 50)
        if key == "D": return code.startswith("D") and int(code[1:]) >= 50
        return code[0] in key
    return [n for c, n in STD_NAMES if ok(c)]
def wrap(d, text, font, width):
    lines, cur = [], ""
    for ch in text:
        if d.textlength(cur + ch, font=font) > width: lines.append(cur); cur = ch
        else: cur += ch
    if cur: lines.append(cur)
    return lines
def degrade(img, rnd):
    img = img.rotate(rnd.uniform(-0.9, 0.9), resample=Image.BICUBIC, fillcolor=255, expand=False)
    img = img.filter(ImageFilter.GaussianBlur(rnd.uniform(0.3, 1.1)))
    if rnd.random() < 0.35: img = img.filter(ImageFilter.MinFilter(3))       # 太い字（濃いスキャン）
    elif rnd.random() < 0.25: img = img.filter(ImageFilter.MaxFilter(3))     # 細い字（薄いスキャン）
    d = ImageDraw.Draw(img); W, H = img.size
    for _ in range(rnd.randint(150, 900)):                                   # ごみの点
        x, y, r = rnd.randrange(W), rnd.randrange(H), rnd.choice([1, 1, 2, 3])
        d.ellipse((x, y, x + r, y + r), fill=0)
    th = rnd.randint(120, 175)
    return img.point(lambda v: 255 if v > th else 0).convert("1")
def page1(rnd, era, y, m, post, officer, counts, pageno):
    W, H = 2480, 3508; img = Image.new("L", (W, H), 255); d = ImageDraw.Draw(img)
    eraTxt = f"平成 {y-1988}年 {m} 月分" if era == "H" else f"令和 {y-2018}年 {m} 月分"
    d.text((460, 560), f"医務官月報（{eraTxt}）", font=F(76), fill=0); d.text((2000, 590), "（甲）", font=F(52), fill=0)
    d.text((280, 760), post[0], font=F(52), fill=0); d.text((1560, 760), officer, font=F(52), fill=0); d.text((1860, 745), "医務官", font=F(72), fill=0)
    d.rectangle((740, 910, 1600, 1030), outline=0, width=4); d.text((860, 935), "受診者数等調査票", font=F(66), fill=0)
    d.text((240, 1100), "駐在公館分", font=F(44), fill=0)
    x0, xs = 480, [480, 830, 1130, 1430, 1730, 2030]; ya, yb, yc = 1200, 1340, 1480
    for yy in (ya, yb, yc): d.line((x0, yy, xs[-1], yy), fill=0, width=4)
    for xx in xs: d.line((xx, ya, xx, yc), fill=0, width=4)
    for i, h in enumerate(["職　員", "家　族", "その他", "計"]): d.text((xs[i + 1] + 80, ya + 40), h, font=F(52), fill=0)
    d.text((xs[0] + 60, yb + 40), "受診者数", font=F(52), fill=0)
    for i, v in enumerate(counts): d.text((xs[i + 2] - 40 - len(str(v)) * 28, yb + 45), str(v), font=F(54), fill=0)
    d.text((240, 1560), "その他内訳", font=F(44), fill=0)
    xs2 = [300, 630, 890, 1220, 1620, 1890, 2160]
    for yy in (1660, 1840, 1940): d.line((300, yy, 2160, yy), fill=0, width=4)
    for xx in xs2: d.line((xx, 1660, xx, 1940), fill=0, width=4)
    other = counts[2]; parts = [0, 0, 0, 0, 0, 0]
    for _ in range(other): parts[rnd.randrange(6)] += 1
    for i, h in enumerate(["在留邦人", "旅行者", "現地職員", "専門調査員", "派遣員", "その他"]): d.text((xs2[i] + 20, 1700), h, font=F(46), fill=0)
    for i, v in enumerate(parts): d.text((xs2[i + 1] - 50, 1870), str(v), font=F(50), fill=0)
    d.text((280, 2060), "当該月に担当公館を巡回した場合は、次の表に記載する。", font=F(40), fill=0)
    d.text((280, 3200), "1　毎月分を翌月15日までに本省に提出する。", font=F(40), fill=0)
    d.text((1150, 3380), f"-{pageno}-", font=F(46), fill=0)
    return img
def otsu_page(rnd, era, y, m, post, officer, rows, start, pageno):
    W, H = 2480, 3508; img = Image.new("L", (W, H), 255); d = ImageDraw.Draw(img)
    eraTxt = f"平成 {y-1988} 年 {m} 月分" if era == "H" else f"令和 {y-2018} 年 {m} 月分"
    d.text((380, 360), f"疾病分類件数表（{eraTxt}）（乙）　全集計用", font=F(64), fill=0)
    d.text((280, 470), post[0], font=F(48), fill=0); d.text((1500, 470), f"報告者：　{officer}", font=F(48), fill=0)
    xs = [260, 380, 1040, 1260, 2240]; y0 = 570; yh = 690
    rh = (3300 - yh) // len(rows)
    ys = [y0, yh] + [yh + rh * (k + 1) for k in range(len(rows))]
    for yy in ys: d.line((xs[0], yy, xs[-1], yy), fill=0, width=6 if yy in (y0, ys[-1]) else 3)
    for k, xx in enumerate(xs): d.line((xx, y0, xx, ys[-1]), fill=0, width=6 if k in (0, 4) else 3)
    d.text((xs[1] + 120, y0 + 30), "大　　分　　類", font=F(48), fill=0); d.text((xs[2] + 40, y0 + 30), "件　数", font=F(48), fill=0)
    d.text((xs[3] + 20, y0 + 30), "内訳（病名により分類し、件数を付ける。）", font=F(44), fill=0)
    f = F(38)
    for k, (row, items) in enumerate(rows):
        top = ys[k + 1]
        d.text((xs[0] + 25, top + rh // 2 - 20), str(start + k), font=F(44), fill=0)
        for j, ln in enumerate(wrap(d, f"{row[0]}　({row[1]})", F(36), xs[2] - xs[1] - 40)[:3]): d.text((xs[1] + 30, top + 18 + j * 44), ln, font=F(36), fill=0)
        tot = sum(c for _, c in items)
        if tot: d.text((xs[3] - 30 - len(str(tot)) * 24, top + rh // 2 - 10), str(tot), font=F(46), fill=0)
        txt = "".join(f"{n}({c})　" for n, c in items).rstrip()
        for j, ln in enumerate(wrap(d, txt, f, xs[4] - xs[3] - 40)[: max(1, (rh - 20) // 44)]): d.text((xs[3] + 20, top + 15 + j * 44), ln, font=f, fill=0)
    d.text((1150, 3380), f"-{pageno}-", font=F(46), fill=0)
    return img


def make(path, seed, mild=False):
    """1件作って保存し、正解（対象月・公館・受診者数・病名）を返す。mild=True はごみ・傾きを控えめにする（テスト用）"""
    rnd = random.Random(seed)
    era = rnd.choice(["H", "H", "R"]); y = rnd.choice([2016, 2017, 2018]) if era == "H" else rnd.choice([2020, 2022, 2024, 2025])
    m = rnd.randint(1, 12); post = rnd.choice(POSTS); officer = f"{rnd.choice(SURN)} {rnd.choice(GIV)}"
    st, fa, ot = rnd.randint(0, 40), rnd.randint(0, 20), rnd.randint(0, 25)
    counts = [st, fa, ot, st + fa + ot]
    allrows = []
    for r in ROWS:
        items = []
        if r[2] not in ("P", "Q", "VWXY") and rnd.random() < 0.6:
            for n in rnd.sample(pool(r), min(len(pool(r)), rnd.choice([1, 1, 1, 2, 2, 3]))):
                items.append((n, rnd.choice([1, 1, 1, 1, 2, 2, 3, 4, 5])))
        allrows.append((r, items))
    base = rnd.randint(20, 200)
    dg = (lambda im, rr: im.rotate(rr.uniform(-0.4, 0.4), resample=Image.BICUBIC, fillcolor=255).point(lambda v: 255 if v > 150 else 0).convert("1")) if mild else degrade
    pages = [dg(page1(rnd, era, y, m, post, officer, counts, base), rnd),
             dg(otsu_page(rnd, era, y, m, post, officer, allrows[:12], 1, base + 1), rnd),
             dg(otsu_page(rnd, era, y, m, post, officer, allrows[12:], 13, base + 2), rnd)]
    pages[0].save(path, save_all=True, append_images=pages[1:], resolution=300)
    return {"month": f"{y}-{m:02d}", "post": post[1], "counts": counts, "file_tag": post[2],
            "diseases": [[n, c, k + 1] for k, (r, items) in enumerate(allrows) for n, c in items]}


if __name__ == "__main__":
    out, n, seed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 1
    os.makedirs(out, exist_ok=True)
    for i in range(n):
        tmp = os.path.join(out, f"tmp_{i}.pdf"); t = make(tmp, seed * 100000 + i)
        fn = os.path.join(out, f"{t['file_tag']}{t['month'].replace('-', '')}_{seed}_{i:04d}.pdf"); os.replace(tmp, fn)
        json.dump({**t, "file": os.path.basename(fn)}, open(fn + ".json", "w"), ensure_ascii=False)
