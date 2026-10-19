"""世界地図（plotly）。地図データは assets/countries.geo.json を同梱しているのでオフラインでも描ける。"""
import json
import math
import os
from functools import lru_cache

import pandas as pd
import plotly.graph_objects as go
from plotly.colors import sample_colorscale

from . import icd, posts

GEOJSON = os.path.join(os.path.dirname(__file__), "..", "assets", "countries.geo.json")
MIN_TOTAL_FOR_FULL_COLOR = 8  # これ未満の国は同じ分類色を薄く塗る（代表性が低いため）

EVENT_STYLE = {  # 種別: (マーカー, 色)
    "感染症": ("cross", "#B00020"),
    "気象・災害": ("square", "#E67E22"),
    "治安・社会": ("triangle-up", "#5D4037"),
    "邦人保護": ("diamond", "#1565C0"),
}


@lru_cache(maxsize=1)
def geojson():
    with open(GEOJSON, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def all_iso3():
    return [f["id"] for f in geojson()["features"] if f["id"] not in ("ATA", "-99")]


def blend_with_white(hex_color, weight=0.45):
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    mix = lambda c: round(c * weight + 255 * (1 - weight))
    return f"#{mix(r):02x}{mix(g):02x}{mix(b):02x}"


def coord(name):
    i = posts.INFO.get(name)
    return (i["lat"], i["lon"]) if i else None


def _rings(feature):
    g = feature["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    return [poly[0] for poly in polys]


def _xy(rings):
    xs, ys = [], []
    for ring in rings:
        xs += [c[0] for c in ring] + [None]
        ys += [c[1] for c in ring] + [None]
    return xs, ys


@lru_cache(maxsize=1)
def _country_xy():
    return {f["id"]: _xy(_rings(f)) for f in geojson()["features"] if f["id"] not in ("ATA", "-99")}


def _base(fig):
    xs, ys = [], []
    for x, y in _country_xy().values():
        xs += x
        ys += y
    fig.add_trace(go.Scatter(x=xs, y=ys, fill="toself", fillcolor="#ECEFF1", mode="lines",
                             line=dict(color="white", width=0.5), hoverinfo="skip", showlegend=False))


def fill_country(fig, iso3, color, name, hover, legend=False, group=None):
    """国ポリゴンを1色で塗る（plotly の geo 機能は CDN から地図を取りに行くため使わない）。"""
    xy = _country_xy().get(iso3)
    if not xy:
        return
    fig.add_trace(go.Scatter(x=xy[0], y=xy[1], fill="toself", fillcolor=color, mode="lines",
                             line=dict(color="white", width=0.5), name=name, legendgroup=group or name,
                             showlegend=legend, hoveron="fills", text=hover, hoverinfo="text"))


def _layout(fig, title, height=620):
    fig.update_xaxes(visible=False, range=[-170, 190], constrain="domain")
    fig.update_yaxes(visible=False, range=[-58, 85], scaleanchor="x", scaleratio=1.15)
    fig.update_layout(title=dict(text=title, x=0.01), height=height, margin=dict(l=0, r=0, t=40 if title else 10, b=0),
                      legend=dict(orientation="h", yanchor="top", y=-0.02, x=0, font=dict(size=11)),
                      paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)", hovermode="closest",
                      dragmode="pan")
    return fig


def country_dominant(dis):
    """疾病テーブル -> 国(ISO3)ごとの最多分類（Z分類を除く）。"""
    if dis.empty:
        return pd.DataFrame(columns=["iso3", "category", "total", "detail"])
    d = dis[dis["category"] != icd.Z_CATEGORY].copy()
    d["iso3"] = d["post"].map(lambda p: posts.INFO.get(p, {}).get("iso3"))
    rows = []
    for iso, g in d.groupby("iso3"):
        cats = g.groupby("category")["count"].sum().sort_values(ascending=False)
        total = int(cats.sum())
        if total == 0:
            continue
        detail = "<br>".join(f"{icd.SHORT.get(c, c)}: {n}" for c, n in cats.head(5).items())
        rows.append(dict(iso3=iso, category=cats.index[0], total=total, detail=detail,
                         posts="・".join(sorted(g["post"].unique()))))
    return pd.DataFrame(rows)


def world_map(reports, dis, events=None, junkai=None, transfers=None,
              show_disease=True, show_visits=True, show_events=True, show_junkai=True,
              show_transfers=True, title="世界地図", height=620):
    fig = go.Figure()
    _base(fig)

    if show_disease and dis is not None and not dis.empty:
        shown = set()
        for row in country_dominant(dis).itertuples():
            weak = row.total < MIN_TOTAL_FOR_FULL_COLOR
            col = icd.COLORS.get(row.category, "#999")
            col = blend_with_white(col) if weak else col
            label = icd.SHORT.get(row.category, row.category) + ("（少数）" if weak else "")
            fill_country(fig, row.iso3, col, label,
                         f"<b>{row.posts}</b><br>最多: {label}<br>実患 {row.total}件<br>{row.detail}",
                         legend=label not in shown)
            shown.add(label)

    if show_visits and reports is not None and not reports.empty:
        r = reports.dropna(subset=["total"]).copy()
        r["lat"] = r["post"].map(lambda p: (coord(p) or (None, None))[0])
        r["lon"] = r["post"].map(lambda p: (coord(p) or (None, None))[1])
        r = r.dropna(subset=["lat"])
        fig.add_trace(go.Scatter(
            x=r["lon"], y=r["lat"], mode="markers", name="受診者数（○の大きさ）",
            marker=dict(size=[max(5, 3 * math.sqrt(t)) for t in r["total"]], color="rgba(0,0,0,0)",
                        line=dict(color="#263238", width=1.3)),
            text=[f"<b>{p}</b><br>医務官: {o or '―'}<br>受診者数: {int(t)}名"
                  for p, o, t in zip(r["post"], r["officer"], r["total"])],
            hoverinfo="text"))

    if show_junkai and junkai is not None and not junkai.empty:
        first = True
        for j in junkai.itertuples():
            a, b = coord(j.from_post), coord(j.dest)
            if not a or not b:
                continue
            fig.add_trace(go.Scatter(
                x=[a[1], b[1]], y=[a[0], b[0]], mode="lines", line=dict(width=2.2, color="#00897B"),
                name="巡回健診", legendgroup="junkai", showlegend=first, hoverinfo="skip"))
            fig.add_trace(go.Scatter(
                x=[b[1]], y=[b[0]], mode="markers", legendgroup="junkai", showlegend=False,
                marker=dict(symbol="circle", size=9, color="#00897B", line=dict(color="white", width=1)),
                text=f"<b>巡回健診</b><br>{j.from_post} → {j.dest}<br>{j.period or ''}", hoverinfo="text"))
            first = False

    if show_transfers and transfers:
        first = True
        for t in transfers:
            if not t.get("from_post"):
                continue
            a, b = coord(t["from_post"]), coord(t["post"])
            if not a or not b:
                continue
            fig.add_trace(go.Scatter(
                x=[a[1], b[1]], y=[a[0], b[0]], mode="lines",
                line=dict(width=2, color="#6A1B9A", dash="dash"),
                name="医務官の異動", legendgroup="tr", showlegend=first, hoverinfo="skip"))
            fig.add_trace(go.Scatter(
                x=[b[1]], y=[b[0]], mode="markers", legendgroup="tr", showlegend=False,
                marker=dict(symbol="star", size=13, color="#6A1B9A"),
                text=f"<b>異動 {t['month']}</b><br>{t['after']}：{t['from_post']} → {t['post']}", hoverinfo="text"))
            first = False

    if show_events and events is not None and not events.empty:
        for k, (sym, col) in EVENT_STYLE.items():
            e = events[events["kind"] == k]
            if e.empty:
                continue
            g = e.groupby("post").agg(kw=("keyword", lambda x: "・".join(dict.fromkeys(x))),
                                      sn=("snippet", lambda x: "<br>".join(list(x)[:3]))).reset_index()
            off = list(EVENT_STYLE).index(k)
            lat = [coord(p)[0] + 1.8 * math.sin(off * 1.57) if coord(p) else None for p in g["post"]]
            lon = [coord(p)[1] + 2.4 * math.cos(off * 1.57) if coord(p) else None for p in g["post"]]
            fig.add_trace(go.Scatter(
                x=lon, y=lat, mode="markers", name=k,
                marker=dict(symbol=sym, size=11, color=col, line=dict(color="white", width=1)),
                text=[f"<b>{p}：{kw}</b><br>{_wrap(sn)}" for p, kw, sn in zip(g["post"], g["kw"], g["sn"])],
                hoverinfo="text"))
    return _layout(fig, title, height)


def _wrap(s, n=40):
    out = []
    for line in s.split("<br>"):
        out.append("<br>".join(line[i:i + n] for i in range(0, len(line), n)))
    return "<br>".join(out)


def value_map(values, title="", height=480, scale="Reds"):
    """国ごとの数値マップ。values: [(iso3, 値, ホバー文)]"""
    fig = go.Figure()
    _base(fig)
    vmax = max([v for _, v, _ in values] or [1])
    for iso, v, hover in values:
        col = sample_colorscale(scale, [0.15 + 0.85 * v / vmax])[0]
        fill_country(fig, iso, col, "", hover)
    fig.add_trace(go.Scatter(x=[None], y=[None], mode="markers", showlegend=False, hoverinfo="skip",
                             marker=dict(colorscale=scale, cmin=0, cmax=vmax, color=[0], showscale=True,
                                         colorbar=dict(title="件数", thickness=12))))
    return _layout(fig, title, height)
