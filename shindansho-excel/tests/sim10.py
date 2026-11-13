"""Excel版 10人のアバター医師による模擬。

10人の架空の医師（専門・Excelの慣れ・用紙がばらばら）が、それぞれ2件ずつ診断書・指示書を作ったとして、
「入力」シートに値を入れ、LibreOffice で再計算・PDF化し、次を数える。
  - わざと入れた誤り（15%）を整合性チェックが見つけたか（見逃し）
  - 正しい書類に誤った警告が出ていないか（誤った指摘）
  - エラー表示（#VALUE! など）・ありえない1日量・印刷が1枚に収まらない書類
使い方（リポジトリのルートで）：python3 shindansho-excel/tests/sim10.py [人数] [種(日付など)]
結果の詳しい内容は /tmp/shindansho-excel-sim10.json に書く（コミットしない）。
"""
import datetime
import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import excel_test as T  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 10
SEED = sys.argv[2] if len(sys.argv) > 2 else datetime.date.today().isoformat()
rnd = random.Random(SEED)

SPECIALTIES = {
    "内科": [("高血圧症", "アムロジピン錠", ["2.5mg", "5mg"]), ("2型糖尿病", "メトホルミン塩酸塩錠", ["250mg", "500mg"]), ("脂質異常症", "ロスバスタチン錠", ["2.5mg", "5mg"]),
            ("高尿酸血症", "フェブキソスタット錠", ["10mg", "20mg"])],
    "精神科": [("うつ病", "エスシタロプラム錠", ["10mg"]), ("不眠症", "レンボレキサント錠", ["5mg"]), ("双極性障害", "炭酸リチウム錠", ["200mg"])],
    "小児科": [("気管支喘息", "モンテルカスト細粒", ["4mg"]), ("アレルギー性鼻炎", "レボセチリジン塩酸塩錠", ["5mg"])],
    "皮膚科": [("慢性蕁麻疹", "ビラスチン錠", ["20mg"]), ("尋常性ざ瘡", "ミノサイクリン塩酸塩錠", ["50mg"])],
    "整形外科": [("変形性膝関節症", "ロキソプロフェンNaテープ", ["100mg"]), ("骨粗鬆症", "エルデカルシトールカプセル", ["0.75μg"])],
    "循環器内科": [("心房細動", "エドキサバン錠", ["30mg", "60mg"]), ("心不全", "ビソプロロールフマル酸塩錠", ["2.5mg"])],
    "産婦人科": [("月経困難症", "ジエノゲスト錠", ["1mg"]), ("更年期障害", "テスト漢方エキス顆粒", ["2.5g"])],
    "耳鼻咽喉科": [("メニエール病", "ベタヒスチンメシル酸塩錠", ["6mg"]), ("慢性副鼻腔炎", "クラリスロマイシン錠", ["200mg"])],
}
USAGES = [("分1 朝食後", 1), ("分1 夕食後", 1), ("分2 朝夕食後", 2), ("分3 毎食後", 3), ("分1 就寝前", 1)]
POSTS = ["612A", "403A", "713A", "607C"]


def zen(s):  # 半角数字を全角に
    return str(s).translate(str.maketrans("0123456789.", "０１２３４５６７８９．"))


def make_doc(doc_no, skill, specialty, today):
    """1件分の入力と、期待する総合判定（✅ か ⚠）を返す。"""
    inp = dict(T.BASE)
    inp.update({"D3": "__DATE__" + today.isoformat(), "D11": rnd.choice(POSTS), "D12": rnd.choice(POSTS)})
    family = rnd.random() < 0.35
    if family:
        inp.update({"F8": rnd.choice(["配偶者", "子"]), "E9": "試験", "H9": "職員"})
        if inp["F8"] == "子":
            inp.update({"D7": f"{rnd.randint(2010, 2022)}/{rnd.randint(1, 12)}/{rnd.randint(1, 28)}"})
    pool = SPECIALTIES[specialty]
    picks = rnd.sample(pool, k=min(len(pool), rnd.randint(1, 3)))
    inp["D18"] = "\n".join(p[0] for p in picks)
    unit_of = lambda name: "包" if re.search("細粒|顆粒", name) else "枚" if "テープ" in name else "カプセル" if "カプセル" in name else "錠"
    form_of = lambda name: "顆粒" if re.search("細粒|顆粒", name) else "貼り薬（湿布薬）" if "テープ" in name else "カプセル" if "カプセル" in name else "錠剤"
    for i, (_, name, sts) in enumerate(picks):
        r = 24 + i
        usage, times = rnd.choice(USAGES)
        dose, days = 1, rnd.choice([14, 28, 30, 60, 90])
        row = {f"B{r}": name, f"C{r}": rnd.choice(sts), f"D{r}": usage, f"E{r}": dose, f"F{r}": unit_of(name), f"H{r}": form_of(name), f"I{r}": days}
        # Excel が苦手な人のつまずきやすい（でも正しい）入れ方
        if skill == "苦手":
            k = rnd.random()
            if k < 0.2: row[f"E{r}"] = zen(dose)
            elif k < 0.35: row[f"E{r}"] = f"{dose}{unit_of(name)}"
            elif k < 0.5: row[f"I{r}"] = f"{days}日"
            elif k < 0.6: row[f"B{r}"] = name + "\n"
            elif k < 0.7: row[f"D{r}"] = usage.replace(" ", "　").translate(str.maketrans("0123456789", "０１２３４５６７８９"))
            elif k < 0.8 and times == 2: row.update({f"E{r}": "", f"K{r}": 1, f"M{r}": "1/2"})
            elif k < 0.9: row[f"D{r}"] = usage.split(" ", 1)[1]   # 「分n」を省いて「朝夕食後」「就寝前」だけ書く
        inp.update(row)
    if skill == "苦手" and rnd.random() < 0.3:
        inp.update({"E6": "しけん", "H6": "たろう"})
    if skill == "苦手" and rnd.random() < 0.15:
        inp.update({"D7": rnd.choice(["1980年4月1日", "1980.4.1", "１９８０/４/１"])})
    expect, injected = "✅", None
    if rnd.random() < 0.15:
        injected = rnd.choice(["含有量なし", "液体", "日数0", "一覧にないコード", "未来の発行日", "生年が後", "11件目", "不均等の数違い"])
        if injected == "含有量なし": inp["C24"] = ""
        if injected == "液体": inp.update({"H24": "液体"})
        if injected == "日数0": inp["I24"] = 0
        if injected == "一覧にないコード": inp["D11"] = "999Z"
        if injected == "未来の発行日": inp.update({"D3": f"__DATE__{today.year + 1}-01-01"})
        if injected == "生年が後": inp.update({"D7": f"__DATE__{today.year + 5}-01-01"})
        if injected == "11件目": inp["B34"] = "テスト11件目錠"
        if injected == "不均等の数違い": inp.update({"D24": "分2 朝夕食後", "E24": "", "K24": 1, "M24": 1, "N24": 1})
        expect = "⚠"
    return {"title": f"医師{doc_no // 2 + 1:03d}（{specialty}・{skill}）の書類{doc_no % 2 + 1}", "input": inp,
            "expect": {"入力!A43": expect}, "injected": injected}


def main():
    today = datetime.date.today()
    docs = []
    for d in range(N):
        skill = rnd.choice(["苦手", "苦手", "普通", "得意"])
        specialty = rnd.choice(list(SPECIALTIES))
        for j in range(2):
            docs.append(make_doc(d * 2 + j, skill, specialty, today))
    results = T.run(docs)
    caught = missed = false_alarm = page_ng = err = absurd = 0
    details = []
    for doc, res in zip(docs, results):
        probs = res["problems"]
        if any(re.search(r"#(VALUE|NAME|REF|DIV|N/A|NUM)|Err:", p) for p in probs): err += 1
        if any("ページ" in p for p in probs): page_ng += 1
        if any(re.search(r"1日(\d{3,})", d) for d in res["detail"]): absurd += 1
        ok_expect = not any("入力!A43" in p for p in probs)
        if doc["injected"]:
            caught += ok_expect; missed += (not ok_expect)
        elif not ok_expect:
            false_alarm += 1
        if probs or (doc["injected"] and not ok_expect):
            details.append({"title": doc["title"], "injected": doc["injected"], "problems": probs, "detail": res["detail"]})
    inj = caught + missed
    print(f"アバター医師 {N}人・書類 {len(docs)}件（種：{SEED}）")
    print(f"わざと入れた誤りの検出：{caught}/{inj}")
    print(f"正しい書類への誤った警告：{false_alarm}件")
    print(f"エラー表示（#VALUE! など）：{err}件　ありえない1日量（3桁以上）：{absurd}件")
    print(f"印刷が1枚に収まらない書類（A4・Letter）：{page_ng}件")
    Path("/tmp/shindansho-excel-sim10.json").write_text(json.dumps(details, ensure_ascii=False, indent=1), encoding="utf-8")
    print("詳しい結果：/tmp/shindansho-excel-sim10.json")
    sys.exit(1 if (missed or false_alarm or err or page_ng or absurd) else 0)


if __name__ == "__main__":
    main()
