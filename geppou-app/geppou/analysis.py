"""集計・突合・異動検出・5行サマリー。"""
import os
import re

import pandas as pd

from . import db, icd, posts
from .parsing import EVENT_KEYWORDS, sentences, same_person


def prev_month(m):
    y, mo = map(int, m.split("-"))
    return f"{y - 1}-12" if mo == 1 else f"{y}-{mo - 1:02d}"


# ---------------------------------------------------------------- 未提出


def missing_posts(month):
    """配置表で医務官が配置されているのに、その月の月報がない公館。"""
    ro = db.roster(month)
    if ro.empty:
        return pd.DataFrame(columns=["region", "post", "officer", "note"])
    got = set(db.reports(month)["post"])
    miss = ro[(ro["staffed"] == 1) & (~ro["post"].isin(got))].copy()
    miss["region"] = miss["post"].map(posts.region_of)
    return miss[["region", "post", "officer", "note"]].sort_values(["region", "post"])


# ---------------------------------------------------------------- 医務官の異動


def officer_table():
    """月×公館の医務官名。月報ヘッダーを優先し、無ければ配置表で補う。"""
    rep = db.df("SELECT month, post, officer, 'report' AS src FROM reports WHERE officer IS NOT NULL AND officer<>''")
    ro = db.df("SELECT month, post, officer, 'roster' AS src FROM roster WHERE staffed=1")
    both = pd.concat([rep, ro])
    if both.empty:
        return both
    both["prio"] = (both["src"] == "report").astype(int)
    return both.sort_values("prio").drop_duplicates(["month", "post"], keep="last").drop(columns="prio")


def transfers():
    """医務官の交代と、別公館への異動（同一氏名が別公館に現れた場合）を検出する。

    戻り値: [dict(month, post, before, after, from_post)]
      from_post … after の人物が直前まで在籍していた公館（分かる場合）
    """
    t = officer_table()
    if t.empty:
        return []
    months = sorted(t["month"].unique())
    by_month = {m: dict(zip(g["post"], g["officer"])) for m, g in t.groupby("month")}
    out = []
    for i in range(1, len(months)):
        prev, cur = by_month[months[i - 1]], by_month[months[i]]
        for post, after in cur.items():
            before = prev.get(post)
            if before and not same_person(before, after):
                from_post = next((p for p, o in prev.items() if p != post and same_person(o, after)), None)
                out.append(dict(month=months[i], post=post, before=before, after=after, from_post=from_post))
        # 前月いた人が今月どこにもいない（離任・帰国）
        cur_names = list(cur.values())
        for post, before in prev.items():
            if post not in cur:
                continue
            if not any(same_person(before, n) for n in cur_names) and \
                    not any(o["post"] == post and o["month"] == months[i] for o in out):
                out.append(dict(month=months[i], post=post, before=before, after=cur[post], from_post=None))
    return out


# ---------------------------------------------------------------- 推移


def trend(region=None, post=None):
    r = db.reports()
    if region:
        r = r[r["region"] == region]
    if post:
        r = r[r["post"] == post]
    return r.groupby("month")[["staff", "family", "other", "total"]].sum().reset_index()


def mom(month):
    """公館別の前月比。"""
    cur = db.reports(month)[["region", "post", "total"]]
    prv = db.reports(prev_month(month))[["post", "total"]].rename(columns={"total": "prev"})
    x = cur.merge(prv, on="post", how="left")
    x["diff"] = x["total"] - x["prev"]
    return x


# ---------------------------------------------------------------- 5行サマリー


def _pick(sents, keywords, used):
    for s in sents:
        if s in used:
            continue
        if any(k in s for k in keywords):
            used.add(s)
            return s
    return None


def _clip(s, n=70):
    s = s.rstrip("。")
    return s if len(s) <= n else s[:n - 1] + "…"


def rule_summary(month, post):
    """月報データから5行サマリーを機械的に組み立てる。"""
    r = db.df("SELECT * FROM reports WHERE month=? AND post=?", (month, post))
    if r.empty:
        return ""
    r = r.iloc[0]
    prv = db.df("SELECT total FROM reports WHERE month=? AND post=?", (prev_month(month), post))
    lines = []
    # 1. 受診者数
    if pd.notna(r["total"]):
        s = f"受診者数 {int(r['total'])}名（職員{int(r['staff'] or 0)}・家族{int(r['family'] or 0)}・その他{int(r['other'] or 0)}）"
        if not prv.empty and pd.notna(prv["total"][0]):
            d = int(r["total"]) - int(prv["total"][0])
            s += f"、前月比{d:+d}"
        lines.append(s)
    else:
        lines.append("受診者数：未記載")
    # 2. 主な疾病
    d = db.df("SELECT name, SUM(count) c FROM diseases WHERE month=? AND post=? GROUP BY name ORDER BY c DESC",
              (month, post))
    d = d[d["name"].map(icd.classify) != icd.Z_CATEGORY]
    if not d.empty:
        lines.append("主な疾病：" + "、".join(f"{n}({c})" for n, c in d.head(3).itertuples(index=False)))
    else:
        lines.append("主な疾病：特記なし")
    sents = sentences(r["hei_text"])
    used = set()
    # 3. 感染症・医療事情
    s = _pick(sents, EVENT_KEYWORDS["感染症"] + ["流行", "医療機関", "病院", "薬"], used)
    lines.append("医療・感染症：" + (_clip(s) if s else "特記なし"))
    # 4. 邦人保護・緊急対応
    s = _pick(sents, EVENT_KEYWORDS["邦人保護"], used)
    lines.append("邦人保護・緊急対応：" + (_clip(s) if s else "特記なし"))
    # 5. 巡回・治安・気象・その他
    s = _pick(sents, ["巡回", "着任", "離任", "異動"] + EVENT_KEYWORDS["治安・社会"] + EVENT_KEYWORDS["気象・災害"], used)
    if not s:
        s = next((x for x in sents if x not in used), None)
    lines.append("その他：" + (_clip(s) if s else "特記なし"))
    return "\n".join(lines)


AI_SYSTEM = (
    "あなたは外務省在外公館の医務官月報を取りまとめる担当者です。"
    "与えられた1公館分の月報データ（受診者数・疾病件数・報告事項）だけを根拠に、"
    "日本語でちょうど5行のサマリーを書いてください。各行は60字以内、行頭に記号は付けない。"
    "1行目は受診者数と前月比、2行目は主な疾病、3行目は医療事情・感染症、"
    "4行目は邦人保護・緊急対応、5行目はその他特記事項（巡回健診・治安・気象・人事）。"
    "該当する記載がない行は「特記なし」と書き、月報にない情報を推測で足さないこと。"
    "出力は5行の本文のみ。"
)


def ai_available():
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def ai_summary(month, post, model="claude-opus-5-5"):
    """Claude API で5行サマリーを作る（ANTHROPIC_API_KEY を設定した場合のみ）。

    月報本文を外部APIに送信するため、利用は組織の情報管理規程に従うこと。
    """
    import anthropic
    r = db.df("SELECT * FROM reports WHERE month=? AND post=?", (month, post)).iloc[0]
    d = db.df("SELECT name, count FROM diseases WHERE month=? AND post=?", (month, post))
    prv = db.df("SELECT total FROM reports WHERE month=? AND post=?", (prev_month(month), post))
    body = (f"公館: {post}\n対象月: {month}\n医務官: {r['officer']}\n"
            f"受診者数: 職員{r['staff']} 家族{r['family']} その他{r['other']} 計{r['total']}\n"
            f"前月受診者数: {prv['total'][0] if not prv.empty else '不明'}\n"
            f"疾病件数: " + "、".join(f"{n}({c})" for n, c in d.itertuples(index=False)) + "\n"
            f"報告事項（丙表）:\n{r['hei_text']}")
    client = anthropic.Anthropic()
    resp = client.beta.messages.create(
        model=model,
        max_tokens=2000,
        output_config={"effort": "low"},
        system=AI_SYSTEM,
        messages=[{"role": "user", "content": body}],
        betas=["server-side-fallback-2026-07-01"],
        extra_body={"fallbacks": "default"},
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("AIがこの月報の要約を辞退しました。ルールベースのサマリーをご利用ください。")
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    lines = [re.sub(r"^[\s・\-\*\d.]+", "", ln).strip() for ln in text.splitlines() if ln.strip()]
    return "\n".join(lines[:5])
