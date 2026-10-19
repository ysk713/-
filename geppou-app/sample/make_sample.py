"""動作確認用のダミー月報を生成する（氏名・数値はすべて架空）。

    python sample/make_sample.py      -> sample/files/ に PDF と配置表xlsx を出力
"""
import io
import json
import os
import random
import zipfile

OUT = os.path.join(os.path.dirname(__file__), "files")

# (公館正式表記, 医務官 6月, 7月, 8月)
POSTS = [
    ("在ケニア日本国大使館", "架空 一郎", "架空 一郎", "見本 花子"),
    ("在ウガンダ日本国大使館", "試験 次郎", "試験 次郎", "架空 一郎"),   # 8月: ケニアから異動
    ("在ルワンダ日本国大使館", "例示 三郎", "例示 三郎", "例示 三郎"),
    ("在セネガル日本国大使館", "仮名 四郎", "仮名 四郎", "仮名 四郎"),
    ("在コンゴ民主共和国日本国大使館", "模擬 五郎", "模擬 五郎", "模擬 五郎"),
    ("在フィリピン日本国大使館", "検証 六子", "検証 六子", "検証 六子"),
    ("在タイ日本国大使館", "試作 七美", "試作 七美", "試作 七美"),
    ("在広州日本国総領事館", "雛形 八郎", "雛形 八郎", "雛形 八郎"),
    ("在インド日本国大使館", "原案 九子", "原案 九子", "原案 九子"),
    ("在イタリア日本国大使館", "草稿 十郎", "草稿 十郎", "草稿 十郎"),
    ("在ロシア日本国大使館", "素案 一美", "素案 一美", "素案 一美"),
    ("在トルコ日本国大使館", "下書 二郎", "下書 二郎", "下書 二郎"),
    ("在サウジアラビア日本国大使館", "例題 三子", "例題 三子", "例題 三子"),
    ("在ペルー日本国大使館", "試行 四美", "試行 四美", "試行 四美"),
    ("在ブラジル日本国大使館", "演習 五子", "演習 五子", "演習 五子"),
]
# 配置表には載っているが、月報を出さない公館（未提出チェック用）
ROSTER_ONLY = [("在ナイジェリア日本国大使館", "未着 六郎"), ("在メキシコ日本国大使館", "未着 七子")]

DISEASES = [
    ("Ａ００－Ｂ９９", "感染症及び寄生虫症", ["腸管感染症", "デング熱", "マラリア", "帯状疱疹"]),
    ("Ｊ００－Ｊ９９", "呼吸器系の疾患", ["急性鼻咽頭炎［かぜ］", "急性咽頭炎", "気管支喘息", "アレルギー性鼻炎"]),
    ("Ｋ００－Ｋ９３", "消化器系の疾患", ["胃腸炎", "胃食道逆流症", "便秘", "口内炎"]),
    ("Ｌ００－Ｌ９９", "皮膚及び皮下組織の疾患", ["湿疹", "蕁麻疹", "接触皮膚炎"]),
    ("Ｍ００－Ｍ９９", "筋骨格系及び結合組織の疾患", ["背部痛", "肩の傷害"]),
    ("Ｆ００－Ｆ９９", "精神及び行動の障害", ["不眠症", "適応障害"]),
    ("Ｓ００－Ｔ９８", "損傷、中毒及びその他の外因の影響", ["捻挫及びストレイン", "表在損傷", "犬咬傷"]),
    ("Ｚ００－Ｚ９９", "健康状態に影響を及ぼす要因", ["健康診断", "予防接種の必要性"]),
]

HEI = {
    "ケニア": {
        "2026-06": "1. 医療事情\n首都の私立病院は概ね平常どおり。\n2. 巡回健診\n6月10日～13日、ルワンダとの連絡調整を実施。",
        "2026-07": "1. 医療事情\n市内でコレラ症例の報告が続いている。飲料水の注意喚起を館員に周知。\n"
                   "2. 邦人保護\n邦人旅行者1名が交通外傷で入院、現地病院と連携し対応。\n3. その他\n8月に離任予定。",
        "2026-08": "1. 着任\n8月1日に新任医務官が着任。\n2. 医療事情\nコレラの新規報告は減少傾向。",
    },
    "ウガンダ": {
        "2026-08": "1. 着任\n8月5日、前任地ケニアより着任。\n2. 巡回健診\n8月18日～21日 南スーダンへ巡回健診を実施、館員12名を診察。",
    },
    "ルワンダ": {
        "2026-07": "1. 巡回健診\n7月14日～17日、ブルンジへ巡回健診を実施し、在留邦人8名の健康相談を行った。",
        "2026-08": "1. 医療事情\nマールブルグ病の新規症例なし、警戒は継続。",
    },
    "セネガル": {
        "2026-06": "1. 巡回健診\n6月22日～25日 モーリタニアへ巡回健診。",
        "2026-07": "1. 気象\n記録的な熱波が続き、熱中症の注意喚起を行った。",
        "2026-08": "1. 巡回健診\n8月3日～6日 ガンビアへ巡回健診を実施。\n2. 医療事情\nマラリア患者が雨季に入り増加。",
    },
    "コンゴ民主共和国": {
        "2026-06": "1. 感染症\n東部でエボラ出血熱の流行が継続。キンシャサでの症例は確認されていない。",
        "2026-07": "1. 感染症\nエボラ出血熱の累計症例が増加。エムポックスの報告もあり、館員へ注意喚起。\n2. 治安\n東部で戦闘が継続。",
        "2026-08": "1. 感染症\nエボラ出血熱は終息に向かいつつあるとWHOが発表。",
    },
    "フィリピン": {
        "2026-07": "1. 感染症\n雨季入りに伴いデング熱が急増、マニラ首都圏で病床ひっ迫。\n2. 気象\n台風の影響で洪水が発生。",
        "2026-08": "1. 感染症\nデング熱は引き続き高水準。\n2. 邦人保護\n邦人1名をデング熱で入院加療、緊急移送は不要。",
    },
    "タイ": {
        "2026-06": "1. 医療事情\nPM2.5は改善。\n2. 巡回健診\n6月16日～19日 ラオスへ巡回健診を実施。",
        "2026-08": "1. 巡回健診\n8月25日～28日 ミャンマーへ巡回健診。\n2. 感染症\nデング熱の報告が増加。",
    },
    "広州総領事館": {"2026-07": "1. 感染症\n広東省でチクングニア熱の流行が拡大、蚊対策を周知。"},
    "インド": {"2026-07": "1. 気象\nモンスーンによる豪雨。\n2. 大気汚染は小康状態。"},
    "イタリア": {"2026-07": "1. 気象\n熱波により40度超の日が続き、熱中症で館員家族1名が受診。"},
    "ロシア": {"2026-06": "1. 医療事情\n特記事項なし。"},
    "トルコ": {"2026-08": "1. 気象・災害\n西部で森林火災が発生。\n2. 地震の余震が続く。"},
    "サウジアラビア": {"2026-07": "1. 気象\n猛暑が続き、日中の屋外活動を控えるよう周知。"},
    "ペルー": {"2026-06": "1. 感染症\nインフルエンザが流行期に入った。", "2026-08": "1. 巡回健診\n8月11日～13日 ボリビアへ巡回健診。"},
    "ブラジル": {"2026-07": "1. 感染症\nオロプーシェ熱の報告が北部で増加。"},
}


def short(emb):
    s = emb.replace("在", "").replace("日本国", "").replace("大使館", "")
    return s.replace("総領事館", "総領事館") if "総領事館" in s else s


def kou_text(emb, officer, ym, counts):
    y, m = ym.split("-")
    s, f, o = counts
    return (f"{emb}　{officer}　医務官\n受診者数等調査票\n（{y}年{int(m)}月分）\n"
            f"職員　家族　その他　計\n受診者数　{s}　{f}　{o}　{s + f + o}\n"
            f"その他内訳：在留邦人 {o} 旅行者 0 現地職員(日本人) 0 専門調査員 0 派遣員 0 その他 0\n")


def otsu_text(emb, ym, rnd, total):
    y, m = ym.split("-")
    lines = [f"疾病分類件数表", f"{emb}", f"（{y}年{int(m)}月分）"]
    left = total
    for i, (code, cat, names) in enumerate(DISEASES, 1):
        picks = rnd.sample(names, k=min(len(names), rnd.randint(1, 3)))
        parts = []
        for n in picks:
            c = max(1, min(left, rnd.randint(1, 6)))
            left = max(0, left - c)
            parts.append(f"{n}({c})")
        cnt = sum(int(p.split("(")[1].rstrip(")")) for p in parts)
        lines.append(f"{i} {code} {cat} {cnt} " + " ".join(parts))
    lines.append("報告者　医務官")
    return "\n".join(lines)


def make_zip(pages, path, blank_page=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        man = {"pages": []}
        for i, t in enumerate(pages, 1):
            z.writestr(f"{i}.txt", "" if i == blank_page else t)
            z.writestr(f"{i}.jpeg", _fake_jpeg(t))
            man["pages"].append({"page_number": i, "has_visual_content": i == blank_page})
        z.writestr("manifest.json", json.dumps(man))
    with open(path, "wb") as f:
        f.write(buf.getvalue())


def _fake_jpeg(text):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (900, 1270), "white")
    d = ImageDraw.Draw(img)
    font = None
    for p in ["/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", "C:/Windows/Fonts/msgothic.ttc"]:
        if os.path.exists(p):
            font = ImageFont.truetype(p, 20)
            break
    y = 40
    for line in text.split("\n"):
        d.text((40, y), line[:40], fill="black", font=font)
        y += 30
    b = io.BytesIO()
    img.save(b, format="JPEG", quality=60)
    return b.getvalue()


def make_real_pdf(pages, path):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    pdfmetrics.registerFont(TTFont("IPAG", "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"))
    c = canvas.Canvas(path, pagesize=A4)
    for t in pages:
        c.setFont("IPAG", 11)
        y = 800
        for line in t.split("\n"):
            c.drawString(40, y, line)
            y -= 18
        c.showPage()
    c.save()


def make_roster(path):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "医務官配置表"
    ws.append(["医務官配置表（ダミー）"])
    ws.append(["No", "地域", "駐在公館名", "氏名", "ふりがな", "備考"])
    for i, (emb, *_, aug) in enumerate(POSTS, 1):
        ws.append([i, "", emb.replace("日本国", ""), aug, "", ""])
    for emb, nm in ROSTER_ONLY:
        ws.append([len(ws["A"]), "", emb.replace("日本国", ""), nm, "", ""])
    ws.append([99, "", "在スーダン大使館", "", "", "退避中"])
    wb.save(path)


def main():
    os.makedirs(OUT, exist_ok=True)
    rnd = random.Random(42)
    for mi, ym in enumerate(["2026-06", "2026-07", "2026-08"]):
        for pi, (emb, *officers) in enumerate(POSTS):
            if ym == "2026-08" and pi == 13:  # 8月はペルーを「出し忘れ」にしない…代わりにブラジルを未提出に
                pass
            if ym == "2026-08" and emb.startswith("在ブラジル"):
                continue
            off = officers[mi]
            counts = (rnd.randint(3, 30), rnd.randint(0, 20), rnd.randint(0, 15))
            key = short(emb)
            hei = HEI.get(key, {}).get(ym, "1. 医療事情\n特記事項なし。")
            pages = [kou_text(emb, off, ym, counts), otsu_text(emb, ym, rnd, sum(counts)),
                     f"報告事項等\n{hei}"]
            fname = f"{key}_{ym.replace('-', '')}_月報.pdf"
            path = os.path.join(OUT, fname)
            if key == "ペルー" and ym == "2026-07":
                make_real_pdf(pages, path)            # 形式B: 本物のPDF
            elif key == "ロシア" and ym == "2026-07":
                make_zip(pages, path, blank_page=3)  # OCR空ページあり
            else:
                make_zip(pages, path)
    make_roster(os.path.join(OUT, "医務官配置表_202608.xlsx"))
    print("written to", OUT)


if __name__ == "__main__":
    main()
