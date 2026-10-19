"""医務官月報 取りまとめアプリ（Streamlit）

起動:  streamlit run app.py
データは data/geppou.db（SQLite）に保存され、外部には送信されない
（AIサマリーを明示的に使った場合のみ、その公館分の月報本文を Claude API に送信する）。
"""
import datetime as dt

import pandas as pd
import plotly.express as px
import streamlit as st

from geppou import analysis, db, icd, maps, posts, report
from geppou.parsing import parse_report, parse_roster

st.set_page_config(page_title="医務官月報 取りまとめ", page_icon="🌏", layout="wide")
db.load_overrides()

PAGES = ["📥 取り込み", "📊 月次ダッシュボード", "🗺️ 世界地図", "📝 公館別5行サマリー", "🚑 巡回健診",
         "👤 医務官の異動", "📈 月ごとの推移", "📄 Wordレポート", "⚙️ 設定"]
page = st.sidebar.radio("メニュー", PAGES)

months = db.months()


def month_picker(key="month"):
    if not months:
        st.info("まだデータがありません。「📥 取り込み」から月報PDFを読み込んでください。")
        st.stop()
    return st.sidebar.selectbox("対象月", months[::-1], key=key, format_func=fmt_month)


def fmt_month(m):
    y, mo = m.split("-")
    return f"{y}年{int(mo)}月"


def default_month():
    t = dt.date.today().replace(day=1) - dt.timedelta(days=1)
    return f"{t.year}-{t.month:02d}"


# ====================================================================== 取り込み
if page == PAGES[0]:
    st.title("📥 月報の取り込み")
    tab1, tab2 = st.tabs(["月報PDF", "医務官配置表"])

    with tab1:
        st.caption("甲表・乙表・丙表を含む月報PDF（ZIP形式のPDF／通常のPDFどちらも可）を複数まとめて選択できます。")
        files = st.file_uploader("月報PDF", type=["pdf"], accept_multiple_files=True)
        override = st.text_input("対象月（空欄ならPDF本文・ファイル名から自動判定）", placeholder="例: 2026-07")
        if files and st.button("読み取る", type="primary"):
            drafts = []
            prog = st.progress(0.0)
            for i, f in enumerate(files):
                try:
                    r = parse_report(f.getvalue(), f.name)
                except Exception as e:  # 壊れたファイル等
                    r = dict(filename=f.name, format="?", month=None, post=None, officer=None, staff=None,
                             family=None, other=None, total=None, diseases=[], hei_text="", events=[],
                             junkai=[], warnings=[f"読み込み失敗: {e}"], images={})
                if override.strip():
                    r["month"] = override.strip()
                r["month"] = r["month"] or default_month()
                drafts.append(r)
                prog.progress((i + 1) / len(files))
            st.session_state["drafts"] = drafts

        drafts = st.session_state.get("drafts", [])
        if drafts:
            st.subheader("読み取り結果の確認")
            st.caption("誤読があればセルを直接修正してから「保存」してください。⚠のある行は特に確認を。")
            table = pd.DataFrame([dict(
                確認="⚠" if d["warnings"] else "✓", ファイル=d["filename"], 対象月=d["month"], 公館=d["post"],
                医務官=d["officer"], 職員=d["staff"], 家族=d["family"], その他=d["other"], 計=d["total"],
                病名数=len(d["diseases"]), 注意=" / ".join(d["warnings"])) for d in drafts])
            edited = st.data_editor(
                table, hide_index=True, use_container_width=True, key="draft_editor",
                disabled=["確認", "ファイル", "病名数", "注意"],
                column_config={"公館": st.column_config.SelectboxColumn(options=posts.all_post_names()),
                               "職員": st.column_config.NumberColumn(min_value=0, step=1),
                               "家族": st.column_config.NumberColumn(min_value=0, step=1),
                               "その他": st.column_config.NumberColumn(min_value=0, step=1),
                               "計": st.column_config.NumberColumn(min_value=0, step=1)})

            for i, d in enumerate(drafts):
                with st.expander(f"{'⚠' if d['warnings'] else '✓'} {d['filename']} の詳細（乙表・丙表）"):
                    if d["images"]:
                        st.warning("OCRテキストのないページがあります。画像を見て上の表や下の欄を補ってください。")
                        for n, img in d["images"].items():
                            st.image(img, caption=f"p.{n}", width=700)
                    c1, c2 = st.columns([1, 1])
                    with c1:
                        st.markdown("**乙表（病名と件数）**")
                        dd = pd.DataFrame(d["diseases"] or [], columns=["name", "count", "category"])
                        d["_dis_edit"] = st.data_editor(
                            dd.rename(columns={"name": "病名", "count": "件数", "category": "分類"}),
                            num_rows="dynamic", hide_index=True, key=f"dis_{i}", disabled=["分類"],
                            use_container_width=True)
                    with c2:
                        st.markdown("**丙表（報告事項）**")
                        d["hei_text"] = st.text_area("本文", d["hei_text"], height=260, key=f"hei_{i}",
                                                     label_visibility="collapsed")
                        if d["events"]:
                            st.markdown("検出した出来事： " + "、".join(f"`{e['kind']}:{e['keyword']}`" for e in d["events"]))
                        if d["junkai"]:
                            st.markdown("巡回健診： " + "、".join(f"{j['from_post']}→{j['dest'] or '?'} {j['period']}"
                                                            for j in d["junkai"]))

            if st.button("保存する", type="primary"):
                saved, skipped = 0, []
                for d, row in zip(drafts, edited.to_dict("records")):
                    if not row["公館"]:
                        skipped.append(d["filename"])
                        continue
                    d.update(month=row["対象月"], post=row["公館"], officer=row["医務官"],
                             staff=row["職員"], family=row["家族"], other=row["その他"], total=row["計"],
                             region=posts.region_of(row["公館"]))
                    if d.get("_dis_edit") is not None:
                        de = d["_dis_edit"].dropna(subset=["病名"])
                        d["diseases"] = [dict(name=n, count=int(c or 0)) for n, c in zip(de["病名"], de["件数"])]
                    # 丙表を直した場合に備えて出来事・巡回を検出し直す
                    from geppou.parsing import detect_events, detect_junkai
                    d["events"] = [dict(kind=k, keyword=kw, snippet=s) for k, kw, s in detect_events(d["hei_text"])]
                    d["junkai"] = detect_junkai(d["hei_text"], d["post"])
                    db.save_report(d)
                    db.update_summary(d["month"], d["post"], analysis.rule_summary(d["month"], d["post"]))
                    saved += 1
                st.success(f"{saved}件を保存しました。")
                if skipped:
                    st.error("公館が未選択のため保存しなかったファイル: " + "、".join(skipped))
                st.session_state.pop("drafts", None)

    with tab2:
        st.caption("医務官配置表（xlsx）を登録すると、未提出公館のチェックと医務官名の補完・異動検出に使います。"
                   "「公館」を含む列と「氏名」列があれば読み取れます。")
        rm = st.text_input("この配置表を適用する月", value=default_month(), key="roster_month")
        rf = st.file_uploader("医務官配置表", type=["xlsx", "xlsm"])
        if rf:
            try:
                rows = parse_roster(rf.getvalue())
                rdf = pd.DataFrame(rows)
                unknown = [r["post"] for r in rows if r["post"] not in posts.INFO]
                st.dataframe(rdf, hide_index=True, use_container_width=True)
                st.write(f"{len(rows)}公館（うち配置あり {int(rdf['staffed'].sum())}）")
                if unknown:
                    st.warning("公館マスタにない名前: " + "、".join(unknown) + "（geppou/posts.py に追記すると地図に出ます）")
                if st.button("配置表を保存", type="primary"):
                    db.save_roster(rm, rows)
                    st.success(f"{fmt_month(rm)}の配置表として保存しました。")
            except Exception as e:
                st.error(f"配置表を読み取れませんでした: {e}")

# ====================================================================== ダッシュボード
elif page == PAGES[1]:
    month = month_picker()
    st.title(f"📊 {fmt_month(month)} ダッシュボード")
    rep, dis, ev = db.reports(month), db.diseases(month), db.events(month)
    miss = analysis.missing_posts(month)
    prv = db.reports(analysis.prev_month(month))
    c = st.columns(4)
    tot = int(rep["total"].fillna(0).sum())
    c[0].metric("提出公館", len(rep), (len(rep) - len(prv)) if not prv.empty else None)
    c[1].metric("受診者数（延べ）", tot, (tot - int(prv["total"].fillna(0).sum())) if not prv.empty else None)
    c[2].metric("未提出公館", len(miss) if not db.roster(month).empty else "配置表未登録")
    c[3].metric("感染症の報告", ev[ev["kind"] == "感染症"]["post"].nunique() if not ev.empty else 0, help="公館数")

    l, r = st.columns(2)
    with l:
        g = rep.melt(id_vars=["region"], value_vars=["staff", "family", "other"], var_name="区分", value_name="人数")
        g["区分"] = g["区分"].map({"staff": "職員", "family": "家族", "other": "その他"})
        g = g.groupby(["region", "区分"], as_index=False)["人数"].sum()
        st.plotly_chart(px.bar(g, y="region", x="人数", color="区分", orientation="h", title="地域別 受診者数",
                               category_orders={"region": posts.REGIONS, "区分": ["職員", "家族", "その他"]},
                               labels={"region": ""}), use_container_width=True)
    with r:
        if not dis.empty:
            d = dis[dis["category"] != icd.Z_CATEGORY].groupby(["region", "category"], as_index=False)["count"].sum()
            d["分類"] = d["category"].map(icd.SHORT)
            st.plotly_chart(px.bar(d, y="region", x="count", color="分類", orientation="h",
                                   title="地域別 疾病分類（検診・予防接種を除く）",
                                   color_discrete_map={icd.SHORT[k]: v for k, v in icd.COLORS.items()},
                                   category_orders={"region": posts.REGIONS}, labels={"region": "", "count": "件数"}),
                            use_container_width=True)

    st.subheader("公館別 受診者数")
    mm = analysis.mom(month)
    tbl = rep[["region", "post", "officer", "staff", "family", "other", "total"]].merge(
        mm[["post", "prev", "diff"]], on="post", how="left")
    if not miss.empty:
        tbl = pd.concat([tbl, miss[["region", "post", "officer"]].assign(note="未提出")])
    tbl = tbl.rename(columns={"region": "地域", "post": "公館", "officer": "医務官", "staff": "職員", "family": "家族",
                              "other": "その他", "total": "計", "prev": "前月", "diff": "前月比", "note": "備考"})
    st.dataframe(tbl, hide_index=True, use_container_width=True)

    l, r = st.columns(2)
    with l:
        st.subheader("未提出公館")
        if db.roster(month).empty:
            st.info("配置表が未登録のため判定できません（取り込み→医務官配置表）。")
        elif miss.empty:
            st.success("配置公館はすべて提出済みです。")
        else:
            st.dataframe(miss.rename(columns={"region": "地域", "post": "公館", "officer": "医務官（配置表）",
                                              "note": "備考"}), hide_index=True, use_container_width=True)
    with r:
        st.subheader("診断名トップ10")
        if not dis.empty:
            top = dis[dis["category"] != icd.Z_CATEGORY].groupby("name").agg(
                件数=("count", "sum"), 公館数=("post", "nunique")).sort_values("件数", ascending=False).head(10)
            st.dataframe(top, use_container_width=True)

# ====================================================================== 世界地図
elif page == PAGES[2]:
    month = month_picker()
    st.title(f"🗺️ 世界地図（{fmt_month(month)}）")
    c = st.columns(5)
    sd = c[0].checkbox("疾病の流行状況", True)
    sv = c[1].checkbox("受診者数", True)
    se = c[2].checkbox("感染症・災害等", True)
    sj = c[3].checkbox("巡回健診", True)
    stf = c[4].checkbox("医務官の異動", True)
    tr = [t for t in analysis.transfers() if t["month"] == month]
    fig = maps.world_map(db.reports(month), db.diseases(month), db.events(month), db.junkai(month), tr,
                         sd, sv, se, sj, stf, title="", height=680)
    st.plotly_chart(fig, use_container_width=True)
    st.caption("国の色＝その国で最も多い疾病分類（健診・予防接種は除外）。実患8件未満の国は同じ色を薄く表示。"
               "記号にマウスを重ねると丙表の該当記述が出ます。")

    st.subheader("疾病分類別に見る")
    dis = db.diseases(month)
    if not dis.empty:
        cats = [c for c in icd.CATEGORIES if c != icd.Z_CATEGORY and c in set(dis["category"])]
        cat = st.selectbox("分類", cats, format_func=lambda c: icd.SHORT.get(c, c))
        d = dis[dis["category"] == cat].copy()
        d["iso3"] = d["post"].map(lambda p: posts.INFO.get(p, {}).get("iso3"))
        g = d.groupby("iso3").agg(件数=("count", "sum"), 公館=("post", lambda x: "・".join(sorted(set(x)))),
                                  内訳=("name", lambda x: "、".join(dict.fromkeys(x)))).reset_index()
        f2 = maps.value_map([(r.iso3, r.件数, f"<b>{r.公館}</b><br>{r.件数}件<br>{r.内訳}")
                             for r in g.itertuples()])
        st.plotly_chart(f2, use_container_width=True)

    ev = db.events(month)
    if not ev.empty:
        st.subheader("丙表から検出した出来事")
        st.dataframe(ev.rename(columns={"post": "公館", "kind": "種別", "keyword": "キーワード", "snippet": "記述"})
                     .drop(columns="month"), hide_index=True, use_container_width=True)

# ====================================================================== 5行サマリー
elif page == PAGES[3]:
    month = month_picker()
    st.title(f"📝 公館別 5行サマリー（{fmt_month(month)}）")
    rep = db.reports(month)
    ai = analysis.ai_available()
    c1, c2 = st.columns([3, 2])
    region = c1.selectbox("地域", ["すべて"] + posts.REGIONS)
    if c2.button("全公館をルールで再生成"):
        for p in rep["post"]:
            db.update_summary(month, p, analysis.rule_summary(month, p))
        st.rerun()
    if ai:
        st.caption("AIで生成：その公館の月報本文を Claude API に送信して要約します（組織の情報管理規程に従ってご利用ください）。")
    else:
        st.caption("サマリーは月報データから機械的に作成しています。各欄は自由に書き換えて保存できます。"
                   "（環境変数 ANTHROPIC_API_KEY を設定すると AI による要約も選べます）")
    if region != "すべて":
        rep = rep[rep["region"] == region]
    for r in rep.itertuples():
        with st.container(border=True):
            st.markdown(f"**{r.post}**　{r.region}　医務官：{r.officer or '―'}　受診者数：{report._n(r.total)}")
            text = st.text_area("5行サマリー", r.summary or analysis.rule_summary(month, r.post), height=150,
                                key=f"s_{r.post}", label_visibility="collapsed")
            b = st.columns([1, 1, 1, 5])
            if b[0].button("保存", key=f"sv_{r.post}"):
                db.update_summary(month, r.post, "\n".join(text.splitlines()[:5]))
                st.toast(f"{r.post} を保存しました")
            if b[1].button("ルールで再生成", key=f"rg_{r.post}"):
                db.update_summary(month, r.post, analysis.rule_summary(month, r.post))
                st.session_state.pop(f"s_{r.post}", None)
                st.rerun()
            if ai and b[2].button("AIで生成", key=f"ai_{r.post}"):
                try:
                    with st.spinner("要約中…"):
                        db.update_summary(month, r.post, analysis.ai_summary(month, r.post))
                    st.session_state.pop(f"s_{r.post}", None)
                    st.rerun()
                except Exception as e:
                    st.error(f"AI要約に失敗しました: {e}")
            with st.expander("丙表の原文"):
                st.text(r.hei_text or "（なし）")

# ====================================================================== 巡回健診
elif page == PAGES[4]:
    month = month_picker()
    st.title(f"🚑 巡回健診（{fmt_month(month)}）")
    st.caption("丙表の「巡回」を含む記述から自動抽出しています。行先・期間の誤りは表で直して保存してください（行の追加も可）。")
    jk = db.junkai(month)
    places = sorted(posts.INFO)
    ed = st.data_editor(
        jk[["from_post", "dest", "period", "note"]].rename(
            columns={"from_post": "実施公館", "dest": "巡回先", "period": "期間", "note": "記載"}),
        num_rows="dynamic", hide_index=True, use_container_width=True,
        column_config={"実施公館": st.column_config.SelectboxColumn(options=places),
                       "巡回先": st.column_config.SelectboxColumn(options=places)})
    if st.button("巡回健診を保存", type="primary"):
        rows = [dict(from_post=r["実施公館"], dest=r["巡回先"] or "", period=r["期間"] or "", note=r["記載"] or "")
                for r in ed.to_dict("records") if r["実施公館"]]
        db.replace_junkai(month, rows)
        st.success("保存しました")
        st.rerun()
    st.plotly_chart(maps.world_map(None, None, junkai=jk, show_disease=False, show_visits=False,
                                   show_events=False, show_transfers=False, title="巡回健診の移動", height=560),
                    use_container_width=True)
    st.subheader("これまでの巡回健診")
    allj = db.junkai()
    if not allj.empty:
        st.dataframe(allj.groupby(["from_post", "dest"]).agg(回数=("month", "count"),
                                                             直近=("month", "max")).reset_index()
                     .rename(columns={"from_post": "実施公館", "dest": "巡回先"}), hide_index=True)

# ====================================================================== 医務官の異動
elif page == PAGES[5]:
    st.title("👤 医務官の異動")
    st.caption("月報ヘッダーの医務官名（無い月は配置表）を月ごとに比べ、交代を検出します。"
               "同じ氏名が別公館に現れた場合は前任地からの異動として地図に矢印を引きます。")
    tr = analysis.transfers()
    if tr:
        t = pd.DataFrame(tr).rename(columns={"month": "月", "post": "公館", "before": "前任", "after": "後任",
                                             "from_post": "後任の前任地"})
        t["月"] = t["月"].map(fmt_month)
        st.dataframe(t, hide_index=True, use_container_width=True)
        st.plotly_chart(maps.world_map(None, None, transfers=tr, show_disease=False, show_visits=False,
                                       show_events=False, show_junkai=False, title="医務官の異動", height=560),
                        use_container_width=True)
    else:
        st.info("2か月以上のデータが揃うと交代を検出します。")
    st.subheader("公館×月 医務官一覧")
    ot = analysis.officer_table()
    if not ot.empty:
        pv = ot.pivot_table(index="post", columns="month", values="officer", aggfunc="first")
        pv.columns = [fmt_month(c) for c in pv.columns]
        st.dataframe(pv, use_container_width=True)

# ====================================================================== 推移
elif page == PAGES[6]:
    st.title("📈 月ごとの推移")
    allr = db.reports()
    if allr.empty:
        st.info("データがありません")
        st.stop()
    c1, c2 = st.columns(2)
    region = c1.selectbox("地域", ["すべて"] + posts.REGIONS)
    plist = sorted(allr[allr["region"] == region]["post"].unique()) if region != "すべて" else sorted(allr["post"].unique())
    post = c2.selectbox("公館", ["すべて"] + plist)
    tr = analysis.trend(None if region == "すべて" else region, None if post == "すべて" else post)
    tr["月"] = tr["month"].map(fmt_month)
    st.plotly_chart(px.line(tr.melt(id_vars=["月"], value_vars=["staff", "family", "other", "total"])
                            .replace({"staff": "職員", "family": "家族", "other": "その他", "total": "計"}),
                            x="月", y="value", color="variable", markers=True, title="受診者数の推移",
                            labels={"value": "人数", "variable": ""}), use_container_width=True)
    if region == "すべて" and post == "すべて":
        g = allr.groupby(["month", "region"], as_index=False)["total"].sum()
        g["月"] = g["month"].map(fmt_month)
        st.plotly_chart(px.line(g, x="月", y="total", color="region", markers=True, title="地域別 受診者数",
                                labels={"total": "人数", "region": ""}), use_container_width=True)
    d = db.diseases()
    if not d.empty:
        if region != "すべて":
            d = d[d["region"] == region]
        if post != "すべて":
            d = d[d["post"] == post]
        d = d[d["category"] != icd.Z_CATEGORY].groupby(["month", "category"], as_index=False)["count"].sum()
        d["月"], d["分類"] = d["month"].map(fmt_month), d["category"].map(icd.SHORT)
        st.plotly_chart(px.bar(d, x="月", y="count", color="分類", title="疾病分類の推移（検診・予防接種を除く）",
                               color_discrete_map={icd.SHORT[k]: v for k, v in icd.COLORS.items()},
                               labels={"count": "件数"}), use_container_width=True)
    st.subheader("公館×月 受診者数")
    pv = allr.pivot_table(index=["region", "post"], columns="month", values="total", aggfunc="sum")
    pv.columns = [fmt_month(c) for c in pv.columns]
    st.dataframe(pv, use_container_width=True)

# ====================================================================== Word
elif page == PAGES[7]:
    month = month_picker()
    st.title(f"📄 統合Wordレポート（{fmt_month(month)}）")
    st.markdown("表紙・目次・全体概況・世界地図・受診者数統計・疾病分類統計・巡回健診/異動・公館別5行サマリーを含むWordを作成します。")
    inc_map = st.checkbox("世界地図を含める", True)
    if st.button("レポートを作成", type="primary"):
        with st.spinner("作成中…"):
            st.session_state["docx"] = report.build(month, include_map=inc_map)
    if st.session_state.get("docx"):
        st.download_button("ダウンロード（.docx）", st.session_state["docx"],
                           file_name=f"医務官月報統合レポート_{month.replace('-', '')}.docx",
                           mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document")

# ====================================================================== 設定
elif page == PAGES[8]:
    st.title("⚙️ 設定・データ管理")
    st.subheader("疾病分類の手動設定")
    st.caption("キーワードで分類できなかった病名に分類を割り当てます。次回以降も同じ病名に適用されます。")
    d = db.df("SELECT name, SUM(count) AS 件数 FROM diseases GROUP BY name")
    if not d.empty:
        d["分類"] = d["name"].map(icd.classify)
        only_other = st.checkbox("「分類不能」だけ表示", True)
        if only_other:
            d = d[d["分類"] == icd.OTHER]
        ed = st.data_editor(d.rename(columns={"name": "病名"}), hide_index=True, use_container_width=True,
                            disabled=["病名", "件数"],
                            column_config={"分類": st.column_config.SelectboxColumn(options=icd.CATEGORIES)})
        if st.button("分類を保存"):
            for row in ed.to_dict("records"):
                if row["分類"] != icd.classify(row["病名"]):
                    db.set_override(row["病名"], row["分類"])
            st.success("保存しました")
            st.rerun()
    st.subheader("登録済みデータ")
    if months:
        st.dataframe(db.df("SELECT month AS 月, COUNT(*) AS 公館数, SUM(total) AS 受診者数 FROM reports GROUP BY month"),
                     hide_index=True)
        dm = st.selectbox("削除する月", months, format_func=fmt_month)
        if st.button(f"{fmt_month(dm)} のデータをすべて削除", type="secondary"):
            db.delete_month(dm)
            st.success("削除しました")
            st.rerun()
    st.caption(f"データベース: {db.DB_PATH}")
