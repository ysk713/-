"""80人の在外医務官が「月報くん」を使ったときのシミュレーション（すべて架空のデータ）。

80人分の利用者像（自分の公館だけ／地域の取りまとめ／全公館の取りまとめ、PC の画面・処理の速さ・ブラウザ・時間帯・
回線・ファイルの形式と名前の付け方）を作り、それぞれ別のブラウザ（保存領域も別）で実際にアプリを操作する。
起きたことを記録して、問題点を洗い出す：
  - エラー（画面のエラー・処理の失敗）、外部への通信
  - 読み取りの正しさ（ファイルから分かる公館・月と、アプリが読んだ公館・月が合うか）、要確認の数
  - かかった時間（開く・読む・保存・各タブ・PDF）、画面が固まった時間（長い処理）
  - 画面の崩れ（横にはみ出す・タブが入りきらない）
  - 開き直したときにデータが残っているか、使った保存容量

    python3 geppou-app/sim/sim80.py                 # 80人すべて（数十分）
    python3 geppou-app/sim/sim80.py --only 1-10     # 一部だけ
    python3 geppou-app/sim/sim80.py --workers 4

結果は geppou-app/sim/results/ に JSON と Markdown で書き出す（架空のデータだけ。実際の月報は使わない）。
"""
import argparse
import json
import os
import random
import shutil
import sys
import tempfile
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(HERE, "..", "tests"))
sys.path.insert(0, os.path.join(HERE, "..", "sample"))
sys.path.insert(0, os.path.join(HERE, ".."))

from geppou import posts as POSTS  # noqa: E402

RESULTS = os.path.join(HERE, "results")
SEED = 80
END = "2026-09"

# ---------------------------------------------------------------- 利用者像

def months_back(end, n):
    y, m = map(int, end.split("-"))
    out = []
    for _ in range(n):
        out.append(f"{y}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out[::-1]


def post_table():
    rows = [p for p in POSTS.POSTS]
    return [(r[0], r[1], (r[5] if len(r) > 5 else []) or [r[0]]) for r in rows]


# 公館の地域 → だいたいの時間帯（PCの時計）
TZ = {"アジア・大洋州": ["Asia/Bangkok", "Asia/Manila", "Asia/Kolkata", "Australia/Sydney", "Pacific/Fiji"],
      "アフリカ": ["Africa/Nairobi", "Africa/Lagos", "Africa/Johannesburg", "Africa/Dakar"],
      "ヨーロッパ": ["Europe/London", "Europe/Paris", "Europe/Moscow", "Asia/Tashkent"],
      "中東": ["Asia/Riyadh", "Asia/Dubai", "Asia/Tehran"],
      "北米": ["America/New_York", "America/Los_Angeles", "America/Chicago"],
      "中南米": ["America/Sao_Paulo", "America/Lima", "America/Mexico_City", "America/Santiago"]}
SCREENS = [  # (幅, 高さ, 拡大率, 説明)
    (1366, 768, 1, "ノートPC 1366×768"), (1280, 720, 1, "小さめのノートPC 1280×720"), (1920, 1080, 1, "フルHD"),
    (1536, 864, 1.25, "フルHD・表示125%"), (1280, 800, 1.5, "表示150%"), (1024, 768, 1, "古い画面 1024×768"),
    (2560, 1440, 1, "大きい画面"), (820, 1180, 2, "タブレット縦"),
]
FORMATS = ["zip", "real", "enc", "docx"]
# ファイル名の付け方（医務官ごとに癖がある）
NAMING = ["std", "jp", "reiwa", "english", "fullwidth", "folder_only", "dots"]


def make_personas():
    rnd = random.Random(SEED)
    table = post_table()
    by_region = {}
    for name, region, alias in table:
        by_region.setdefault(region, []).append((name, alias))
    own_posts = rnd.sample(table, 80)
    personas = []
    for i in range(80):
        name, region, alias = own_posts[i]
        if i < 60:
            role, n_months = "own", rnd.choice([3, 6, 12, 12, 24])
            posts = [name]
        elif i < 74:
            role, n_months = "regional", rnd.choice([1, 3, 3, 6])
            pool = [p for p, _ in by_region[region] if p != name]
            posts = [name] + rnd.sample(pool, min(len(pool), rnd.randint(8, 18)))
        else:
            role, n_months = "all", [1, 1, 2, 3, 6, 12][i - 74]
            posts = [p for p, _, _ in table]
        w, h, dpr, sdesc = SCREENS[rnd.randrange(len(SCREENS))] if i % 9 else SCREENS[i // 9 % len(SCREENS)]
        p = {
            "id": i + 1, "role": role, "home": name, "region": region, "posts": posts,
            "months": months_back(END, n_months),
            "screen": [w, h, dpr, sdesc],
            "tz": rnd.choice(TZ.get(region, ["Asia/Tokyo"])),
            "edge": rnd.random() < 0.15,
            "slow_cpu": rnd.random() < 0.2,
            "offline": rnd.random() < 0.2,
            "format": rnd.choice(FORMATS),
            "mixed_formats": rnd.random() < 0.3,
            "naming": rnd.choice(NAMING),
            "reimport_dup": rnd.random() < 0.25,      # 同じファイルをもう一度入れてしまう
            "officer_change": rnd.random() < 0.15,    # 期間の途中で医務官が交代
            "bad_password": rnd.random() < 0.08,      # 別のパスワードのPDFが混じる
            "image_only": rnd.random() < 0.08,        # 文字のないスキャンPDFが混じる
            "make_pdf": role != "own" or rnd.random() < 0.7,
            "pdf_span": 0 if role == "own" else 1,
            "seed": rnd.randrange(1 << 30),
        }
        personas.append(p)
    return personas


# ---------------------------------------------------------------- 架空の月報ファイル

def officer_name(pid, post_idx, changed=False):
    sn = ["架空", "見本", "例示", "模擬", "試案", "仮名", "素案", "原案", "検証", "試行", "演習", "例題", "想定", "仮説", "試算"]
    gv = ["一郎", "花子", "春香", "夏樹", "拓真", "美咲", "隼人", "誠", "葵", "陸", "結衣", "大和", "湊", "紬", "蓮", "凛"]
    k = post_idx * 7 + (999 if changed else 0)
    return f"{sn[k % len(sn)]} {gv[(k // len(sn)) % len(gv)]}"


def embassy(post):
    return f"在{post.replace('総領事館', '')}日本国総領事館" if post.endswith("総領事館") else f"在{post}日本国大使館"


def fname(post, alias, ym, naming, ext):
    y, m = ym.split("-")
    s = post.replace("総領事館", "")
    en = next((a for a in alias if a.isascii()), s)
    return {
        "std": f"{s}_{y}{m}_月報{ext}",
        "jp": f"{y}年{int(m)}月_{s}{ext}",
        "reiwa": f"令和{int(y) - 2018}年{int(m)}月 医務官月報（{s}）{ext}",
        "english": f"{en}_{y}{m}{ext}",
        "fullwidth": f"{s}_{y}{m}{ext}".translate(str.maketrans("0123456789", "０１２３４５６７８９")),
        "folder_only": f"月報{ext}",          # 月はフォルダ名にだけある
        "dots": f"{s} {y}.{m}{ext}",
    }[naming]


def build_files(p, out):
    from make_sample import kou_text, otsu_text, make_zip, make_real_pdf
    import fixtures
    rnd = random.Random(p["seed"])
    table = {n: a for n, _, a in post_table()}
    files, expect = [], []
    for pi, post in enumerate(p["posts"]):
        for mi, ym in enumerate(p["months"]):
            changed = p["officer_change"] and post == p["home"] and mi >= len(p["months"]) // 2
            off = officer_name(p["id"] * 131 + pi, pi, changed)
            emb = embassy(post)
            counts = (rnd.randint(2, 30), rnd.randint(0, 12), rnd.randint(0, 6))
            hei = "1. 医療事情\n特記事項なし。"
            if rnd.random() < 0.1:
                hei = "1. 邦人保護\n邦人旅行者1名が交通外傷で入院し、近隣国の病院へ緊急移送した。"
            elif rnd.random() < 0.2:
                hei = "1. 感染症\n市内でデング熱の報告が増加している。館員に防蚊対策を周知した。"
            pages = [kou_text(emb, off, ym, counts), otsu_text(emb, ym, rnd, sum(counts)), f"報告事項等\n{hei}"]
            fmt = rnd.choice(FORMATS) if p["mixed_formats"] else p["format"]
            ext = ".docx" if fmt == "docx" else ".pdf"
            sub = out
            if p["naming"] == "folder_only" or p["role"] != "own":
                y, m = ym.split("-")
                sub = os.path.join(out, f"{y}年{int(m)}月", post.replace("総領事館", "")) if p["naming"] == "folder_only" else os.path.join(out, f"{y}{m}")
                os.makedirs(sub, exist_ok=True)
            path = os.path.join(sub, fname(post, table.get(post, [post]), ym, p["naming"], ext))
            if fmt == "zip":
                make_zip(pages, path)
            elif fmt == "docx":
                fixtures.make_docx(pages, path)
            else:
                make_real_pdf(pages, path)
                if fmt == "enc":
                    fixtures.encrypt_pdf(path, fixtures.PASSWORD)
            files.append(path)
            expect.append({"post": post, "month": ym, "officer": off, "total": sum(counts), "file": os.path.relpath(path, out)})
    extra = []
    if p["bad_password"]:
        path = os.path.join(out, "別のパスワード_月報.pdf")
        make_real_pdf([kou_text(embassy(p["home"]), "架空 太郎", p["months"][-1], (1, 1, 1))], path)
        fixtures.encrypt_pdf(path, "otherpass")
        extra.append(path)
    if p["image_only"]:
        path = os.path.join(out, f"{p['home'].replace('総領事館', '')}_スキャン.pdf")
        fixtures.make_image_pdf([f"受診者数等調査票\n{embassy(p['home'])}"], path)
        extra.append(path)
    return files, expect, extra


# ---------------------------------------------------------------- 1人分を動かす

def run_persona(p, base_url):
    from playwright.sync_api import sync_playwright
    import run_tests as R
    t0 = time.time()
    work = tempfile.mkdtemp(prefix=f"sim{p['id']:02d}_")
    rec = {"id": p["id"], "persona": p, "steps": {}, "errors": [], "console": [], "dialogs": [], "external": [],
           "issues": [], "ok": False}

    def issue(kind, msg, sev="中"):
        rec["issues"].append({"kind": kind, "sev": sev, "msg": msg})

    try:
        files, expect, extra = build_files(p, work)
        rec["n_files"] = len(files) + len(extra)
        w, h, dpr, _ = p["screen"]
        with sync_playwright() as pw:
            b = pw.chromium.launch(executable_path="/opt/pw-browsers/chromium")
            ua = None
            if p["edge"]:
                ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")
            ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=dpr, timezone_id=p["tz"],
                                locale="ja-JP", service_workers="allow" if p["offline"] else "block", accept_downloads=True, user_agent=ua,
                                has_touch=w < 900)
            base = urlparse_netloc(base_url)

            def route(r):
                u = r.request.url
                if u.startswith("http") and base not in u:
                    rec["external"].append(u)
                    r.abort()
                else:
                    r.continue_()
            ctx.route("**/*", route)
            ctx.add_init_script("""window._long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window._long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}""")
            page = ctx.new_page()
            page.set_default_timeout(120000)
            page.on("pageerror", lambda e: rec["errors"].append(str(e)[:300]))
            page.on("console", lambda m: m.type == "error" and rec["console"].append(m.text[:300]))
            page.on("dialog", lambda d: (rec["dialogs"].append(d.message[:200]), d.accept()))
            if p["slow_cpu"]:
                cdp = ctx.new_cdp_session(page)
                cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})

            def step(name, fn):
                s = time.time()
                page.evaluate("window._long = []")
                try:
                    out = fn()
                    rec["steps"][name] = {"sec": round(time.time() - s, 2), "long_max": max(page.evaluate("window._long") or [0]),
                                          "long_sum": sum(page.evaluate("window._long") or [])}
                    return out
                except Exception as e:
                    rec["steps"][name] = {"sec": round(time.time() - s, 2), "fail": str(e).split("\n")[0][:300]}
                    issue("失敗", f"{name}：{str(e).splitlines()[0][:200]}", "高")
                    return None

            def overflow(where):
                o = page.evaluate("""() => { const d = document.documentElement; const t = document.querySelector('#tabs');
                    const tabsHidden = t ? [...t.querySelectorAll('button')].filter(b => b.getBoundingClientRect().right > innerWidth + 1).map(b => b.textContent.trim()) : [];
                    const wide = [...document.querySelectorAll('main *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 2 && !e.closest('.tabs') && getComputedStyle(e).position !== 'fixed' && !(e.parentElement && e.parentElement.getBoundingClientRect().right > innerWidth + 2); }).slice(0, 3).map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + [...e.classList].join('.')));
                    return { page: d.scrollWidth > innerWidth + 1, tabsHidden, wide }; }""")
                if o["page"]:
                    issue("表示", f"{where}：画面が横にはみ出す（{', '.join(o['wide'])}）")
                return o

            def open_app():
                page.goto(f"{base_url}/geppou/")
                page.wait_for_function("window.appReady === true", timeout=120000)
                if page.evaluate("document.querySelector('#notice') && document.querySelector('#notice').open"):
                    page.check("#noticeOk")
                    page.click("#noticeBtn")
            step("開く", open_app)
            if p["offline"]:
                # 一度開いてアプリがPCに保存されてから、回線が切れる（現地の停電・回線断）
                def sw_ready():
                    page.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller", timeout=60000)
                    page.wait_for_timeout(3000)
                if step("アプリをPCに保存", sw_ready) is None and "fail" not in rec["steps"]["アプリをPCに保存"]:
                    pass
                page.reload(); page.wait_for_function("window.appReady === true", timeout=120000)
                ctx.set_offline(True)
            rec["edge_bar"] = page.evaluate("!document.querySelector('#browserbar').hidden")
            o = overflow("取り込み")
            rec["tabs_hidden"] = o["tabsHidden"]

            def do_import(paths):
                page.click('#tabs button[data-page="import"]')
                page.check('input[name="mmode"][value="auto"]')
                page.set_input_files("#files", paths)
                page.click("#start")
                page.wait_for_function("!importBusy && drafts.length > 0", timeout=60000 + 2000 * len(paths))
                d = page.evaluate("drafts.map(d => ({f: d.filename, path: d.path || '', post: d.post, month: d.month, w: (d.warnings || []).length, officer: d.officer, total: d.total}))")
                skipped = page.evaluate("pending.filter(p => p.skipped).length")
                return d, skipped
            res = step("読み取り", lambda: do_import(files + extra))
            drafts, skipped = res or ([], 0)
            rec["drafts"] = len(drafts)
            rec["skipped"] = skipped
            rec["warn_rows"] = sum(1 for d in drafts if d["w"])
            # 読み取りの正しさ：期待した (公館, 月) がそろっているか
            got = {(d["post"], d["month"]) for d in drafts}
            miss = [e for e in expect if (e["post"], e["month"]) not in got]
            rec["misread"] = len(miss)
            if miss:
                issue("読み取り", f"{len(miss)}/{len(expect)}件の公館・月が正しく読めない（例：{miss[0]['file']} → 期待 {miss[0]['post']} {miss[0]['month']}）", "高")
            wrong_total = [e for e in expect for d in drafts if d["post"] == e["post"] and d["month"] == e["month"] and d["total"] != e["total"]]
            if wrong_total:
                issue("読み取り", f"受診者数の合計が違う：{len(wrong_total)}件", "高")
            if rec["warn_rows"] > len(expect) * 0.2:
                issue("確認の手間", f"要確認が {rec['warn_rows']}/{len(drafts)} 行（2割超）")

            def do_save():
                page.click("#saveDrafts")
                page.wait_for_function("!saveBusy && Object.keys(state.reports).length > 0", timeout=60000 + 500 * len(drafts))
                page.wait_for_timeout(500)
                return page.evaluate("Object.keys(state.reports).length")
            rec["saved"] = step("保存", do_save) or 0
            if p["reimport_dup"] and files:
                dup = files[: min(5, len(files))]
                step("同じファイルを再取り込み", lambda: do_import(dup))
                dup_badges = page.evaluate("document.querySelectorAll('.badge.dup').length")
                if not dup_badges:
                    issue("重複", "同じ月報をもう一度入れても「保存済み」と分からない", "中")
                page.evaluate("drafts.length = 0")
            # 各タブ
            for t in ["dashboard", "stats", "map", "summary", "junkai", "evac", "hogo", "transfer", "trend", "report", "ai", "settings"]:
                def visit(t=t):
                    page.click(f'#tabs button[data-page="{t}"]')
                    page.wait_for_timeout(600)
                step(f"タブ:{t}", visit)
                overflow(f"タブ「{t}」")
            # PDFレポート（このタブの中で作る）
            if p["make_pdf"]:
                m = p["months"][-1]
                def pdf():
                    return page.evaluate("""async ([m, span]) => { const b = await buildReportPdf(m, new Set(REPORT_SECTIONS.map(s => s[0]).filter(k => k !== 'feedback')), () => {}, { span, regions: [], posts: [], stats: STAT_ITEMS.map(s => s[0]), aiNotes: [], statNotes: [], sumLines: 5 }); return b.size; }""", [m, p["pdf_span"] if p["role"] == "own" else 1])
                size = step("PDF作成", pdf)
                rec["pdf_mb"] = round((size or 0) / 1048576, 2)
                if size and size > 10 * 1048576:
                    issue("PDF", f"PDF が 10MB を超える（{rec['pdf_mb']}MB）", "高")
            rec["ai_chars"] = step("AI用テキスト", lambda: page.evaluate("aiText(state.month || curMonth(), new Set(ALL_SECS)).length"))
            # バックアップ（フォルダが選べない環境ではダウンロード）
            def backup():
                with page.expect_download(timeout=60000) as dl:
                    page.evaluate("downloadBackup()")
                return os.path.getsize(dl.value.path())
            bk = step("バックアップ", backup)
            rec["backup_mb"] = round((bk or 0) / 1048576, 2)
            # 開き直してもデータが残るか
            def reopen():
                page.reload()
                page.wait_for_function("window.appReady === true", timeout=120000)
                return page.evaluate("Object.keys(state.reports).length")
            again = step("開き直す", reopen)
            if again is not None and again != rec["saved"]:
                issue("保存", f"開き直すと月報の数が変わる（{rec['saved']} → {again}）", "高")
            rec["storage_mb"] = round(page.evaluate("navigator.storage.estimate().then(e => e.usage)") / 1048576, 1)
            b.close()
        for name, s in rec["steps"].items():
            lim = {"開く": 8, "読み取り": max(30, rec["n_files"] * 0.2), "保存": max(15, rec["n_files"] * 0.1), "PDF作成": 90}.get(name.split(":")[0], 6)
            if "fail" not in s and s["sec"] > lim:
                issue("遅い", f"{name} に {s['sec']}秒", "中")
            if s.get("long_max", 0) > 1500:
                issue("固まる", f"{name} で画面が {s['long_max']/1000:.1f}秒 固まる", "中")
        if rec["errors"]:
            issue("エラー", f"画面のエラー {len(rec['errors'])}件：{rec['errors'][0][:160]}", "高")
        if rec["external"]:
            issue("外部通信", f"外部への通信 {len(rec['external'])}件：{rec['external'][0][:120]}", "高")
        if p["edge"] and not rec.get("edge_bar"):
            issue("案内", "Edge で開いても Chrome への案内が出ない", "低")
        if rec.get("tabs_hidden"):
            issue("表示", f"タブが画面に入りきらない（{'・'.join(rec['tabs_hidden'])}）", "低")
        rec["ok"] = True
    except Exception:
        rec["crash"] = traceback.format_exc()[-1500:]
        issue("中断", "シミュレーションが途中で止まった：" + rec["crash"].strip().splitlines()[-1][:200], "高")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    rec["wall_sec"] = round(time.time() - t0, 1)
    return rec


def urlparse_netloc(u):
    from urllib.parse import urlparse
    return urlparse(u).netloc


# ---------------------------------------------------------------- まとめ

ROLE = {"own": "自分の公館", "regional": "地域の取りまとめ", "all": "全公館の取りまとめ"}


def summarize(recs, path_md):
    from collections import Counter, defaultdict
    L = ["# 月報くん 80人シミュレーション 結果", "",
         f"- 実行：{time.strftime('%Y-%m-%d %H:%M')}　人数：{len(recs)}　（すべて架空の公館データ・架空の医務官名）", ""]
    roles = Counter(r["persona"]["role"] for r in recs)
    L.append("- 利用者の内訳：" + "、".join(f"{ROLE[k]} {v}人" for k, v in roles.items()))
    L.append(f"- 読み込んだファイル：合計 {sum(r.get('n_files', 0) for r in recs)} 件")
    L.append("")
    by = defaultdict(list)
    for r in recs:
        for i in r["issues"]:
            by[(i["sev"], i["kind"], i["msg"].split("：")[0] if i["kind"] in ("表示", "遅い", "固まる", "失敗") else i["msg"][:60])].append(r["id"])
    order = {"高": 0, "中": 1, "低": 2}
    L += ["## 見つかった問題（重い順・同じ種類はまとめる）", "", "| 重さ | 種類 | 内容 | 人数 | 該当者 |", "|---|---|---|---|---|"]
    for (sev, kind, msg), ids in sorted(by.items(), key=lambda x: (order[x[0][0]], -len(x[1]))):
        L.append(f"| {sev} | {kind} | {msg} | {len(ids)} | {', '.join(f'#{i}' for i in ids[:12])}{' …' if len(ids) > 12 else ''} |")
    L += ["", "## 1人ずつ", "", "| # | 使い方 | 公館数×月 | 画面 | 遅いPC | 時間帯 | 形式 | 名前 | ファイル | 要確認 | 読めず | 読み取り秒 | 保存秒 | PDF秒 | 容量MB | 問題 |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in recs:
        p, s = r["persona"], r["steps"]
        sec = lambda k: s.get(k, {}).get("sec", "")
        L.append(f"| {r['id']} | {ROLE[p['role']]} | {len(p['posts'])}×{len(p['months'])} | {p['screen'][3]} | {'○' if p['slow_cpu'] else ''} | {p['tz']} | "
                 f"{'混在' if p['mixed_formats'] else p['format']} | {p['naming']} | {r.get('n_files', '')} | {r.get('warn_rows', '')} | {r.get('misread', '')} | "
                 f"{sec('読み取り')} | {sec('保存')} | {sec('PDF作成')} | {r.get('storage_mb', '')} | {len(r['issues'])} |")
    open(path_md, "w").write("\n".join(L) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    personas = make_personas()
    if a.only:
        lo, _, hi = a.only.partition("-")
        personas = [p for p in personas if int(lo) <= p["id"] <= int(hi or lo)]
    import run_tests as R
    srv = R.start_server()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    os.makedirs(RESULTS, exist_ok=True)
    recs = []
    with ProcessPoolExecutor(a.workers) as ex:
        futs = {ex.submit(run_persona, p, base): p for p in personas}
        for f in as_completed(futs):
            r = f.result()
            recs.append(r)
            print(f"#{r['id']:02d} {ROLE[r['persona']['role']]} files={r.get('n_files')} issues={len(r['issues'])} {r['wall_sec']}s", flush=True)
    recs.sort(key=lambda r: r["id"])
    stamp = time.strftime("%Y%m%d_%H%M")
    json.dump(recs, open(os.path.join(RESULTS, f"sim80_{stamp}.json"), "w"), ensure_ascii=False, indent=1)
    summarize(recs, os.path.join(RESULTS, f"sim80_{stamp}.md"))
    print("結果：", os.path.join(RESULTS, f"sim80_{stamp}.md"))
    srv.shutdown()


if __name__ == "__main__":
    main()
