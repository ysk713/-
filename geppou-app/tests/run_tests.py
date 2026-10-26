"""ブラウザ版（geppou/）の自動テスト。

    python3 geppou-app/tests/run_tests.py          # すべて実行
    python3 geppou-app/tests/run_tests.py 集計     # 名前に「集計」を含むテストだけ

答えの分かっている見本の月報（fixtures.py、すべて架空）を実際のブラウザ（Chromium）で取り込み、
読み取り・集計・未提出・異動・AI用テキスト・PDF・バックアップの結果が答えと一致するかを確かめる。
あわせて、アプリが外部（インターネット）へ一切通信していないことも確かめる。
修正のたびに実行し、すべて ✓ になってから公開する。

必要なもの: Python の playwright（Chromium 入り）, pypdf, reportlab, openpyxl, python-docx, Pillow, IPAゴシック
"""
import base64
import functools
import http.server
import io
import os
import re
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import fixtures  # noqa: E402

TESTS = []


def test(name):
    def deco(fn):
        TESTS.append((name, fn))
        return fn
    return deco


def eq(actual, expected, what=""):
    if actual != expected:
        raise AssertionError(f"{what}: {expected!r} のはずが {actual!r}")


def nfkc(pairs):
    # アプリは全角の記号・英数字を半角にそろえて読む（［かぜ］→[かぜ]）
    return [(unicodedata.normalize("NFKC", n), c) for n, c in pairs]


def ok(cond, what):
    if not cond:
        raise AssertionError(what)


# ----------------------------------------------------------------------- 準備

def start_server():
    handler = functools.partial(QuietHandler, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class App:
    """1つのブラウザ（保存領域つき）でアプリを開く。外部への通信はすべて止めて記録する"""

    def __init__(self, browser, base, query=""):
        self.base = base
        self.external = []
        self.errors = []
        self.ctx = browser.new_context(viewport={"width": 1300, "height": 900}, service_workers="block", accept_downloads=True)
        self.ctx.route("**/*", self._route)
        self.page = self.ctx.new_page()
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.open(query)

    def _route(self, route):
        u = urlparse(route.request.url)
        if u.scheme in ("http", "https") and u.netloc != urlparse(self.base).netloc:
            self.external.append(route.request.url)
            route.abort()
        else:
            route.continue_()

    def open(self, query=""):
        self.page.goto(f"{self.base}/geppou/{query}")
        self.page.wait_for_function("typeof state !== 'undefined' && !!document.querySelector('#tabs button')")
        if self.page.evaluate("document.querySelector('#notice') && document.querySelector('#notice').open"):
            self.page.check("#noticeOk")
            self.page.click("#noticeBtn")
        self.page.wait_for_timeout(300)

    def js(self, expr, arg=None):
        return self.page.evaluate(expr, arg)

    def tab(self, name):
        self.page.click(f'#tabs button[data-page="{name}"]')
        self.page.wait_for_timeout(400)

    def close(self):
        self.ctx.close()


# ----------------------------------------------------------------------- 個々の読み取り（関数単位）

@test("公館名の正規化（表記ゆれ）")
def t_canonical(app):
    for raw, want in [("在ケニア日本国大使館", "ケニア"), ("在ケニア大使館", "ケニア"), ("ケニア", "ケニア"),
                      ("在フィリピン日本国大使館", "フィリピン"), ("在タイ大使館", "タイ")]:
        eq(app.js("(s) => canonical(s)", raw), want, raw)
    eq(app.js("canonical('在存在しない国大使館')"), None, "存在しない公館")


@test("ファイル名・本文から対象月を読む")
def t_month(app):
    for name, want in [("ケニア_202607_月報.pdf", "2026-07"), ("2026年8月_ウガンダ.docx", "2026-08"),
                       ("令和8年7月 ケニア.docx", "2026-07"), ("R8.7 ケニア.pdf", "2026-07"),
                       ("2026-08/ケニア.pdf", "2026-08"), ("ケニア.pdf", None), ("ケニア_202613.pdf", None)]:
        eq(app.js("(s) => monthFromName(s)", name), want, name)
    eq(app.js("detectMonth('受診者数等調査票\\n（2026年7月分）', 'x.pdf')"), "2026-07", "本文の年月")
    eq(app.js("detectMonth('令和8年9月', 'x.pdf')"), "2026-09", "本文の令和")


@test("甲表（受診者数）の読み取り")
def t_kou(app):
    r = app.js("(t) => parseKou(t)", fixtures.pages_of("ケニア_202607_月報.pdf")[0])
    eq(r["embassy"], "在ケニア日本国大使館", "公館")
    eq(r["officer"], "架空 一郎", "医務官")
    eq(r["counts"], [10, 5, 3, 18], "受診者数")


@test("乙表（病名と件数）の読み取りと疾病分類")
def t_otsu(app):
    r = app.js("(t) => parseOtsu([t])", fixtures.pages_of("ケニア_202607_月報.pdf")[1])
    eq([(d["name"], d["count"]) for d in r], nfkc(fixtures.REPORTS["ケニア_202607_月報.pdf"][4]), "病名と件数")
    cats = app.js("['デング熱','胃腸炎','健康診断','湿疹'].map(classify)")
    ok(all(cats), f"分類できない病名がある: {cats}")
    eq(len(set(cats)), 4, "4つの病名が別々の分類になること")


@test("丙表から感染症の流行・終息を読む")
def t_hei(app):
    r = app.js("heiDiseases('雨季入りに伴いデング熱が急増し、病床がひっ迫している。')")
    eq([(d["name"], d["trend"]) for d in r], [("デング熱", "流行・増加")], "急増")
    r = app.js("heiDiseases('コレラの新規報告は減少傾向にある。')")
    eq([(d["name"], d["trend"]) for d in r], [("コレラ", "減少・終息")], "減少")
    r = app.js("heiDiseases('鳥インフルエンザの症例が報告された。')")
    eq([d["name"] for d in r], ["鳥インフルエンザ"], "鳥インフルエンザをインフルエンザと二重に数えない")
    r = app.js("heiDiseases('館員が蕁麻疹で受診した。')")
    eq(r, [], "蕁麻疹は感染症（麻疹）にしない")


@test("丙表から巡回健診・緊急移送を読む")
def t_junkai_cases(app):
    j = app.js("detectJunkai('8月18日～21日 南スーダンへ巡回健診を実施し、館員12名を診察した。', 'ウガンダ')")
    eq([(x["from"], x["dest"], x["period"]) for x in j], [("ウガンダ", "南スーダン", "8/18〜8/21")], "巡回健診")
    c = app.js("detectCases('邦人旅行者1名が交通外傷で入院し、南アフリカの病院へ緊急移送した。手術を受け回復した。', 'ケニア')")
    evac = [x for x in c if x["type"] == "evac"]
    eq(len(evac), 1, "緊急移送の件数")
    eq((evac[0]["who"], evac[0]["dest"], evac[0]["outcome"]), ("邦人旅行者", "南アフリカ共和国", "回復・退院"), "移送の内容（転帰は次の文から）")
    eq(app.js("detectCases('邦人の移送は不要と判断した。', 'ケニア').filter(x => x.type === 'evac').length"), 0, "「移送は不要」は移送にしない")


# ----------------------------------------------------------------------- 取り込み → 集計（画面を通して）

def import_fixtures(app, folder):
    app.tab("import")
    app.page.check('input[name="mmode"][value="auto"]')
    files = [os.path.join(folder, f) for f in sorted(os.listdir(folder))]
    app.page.set_input_files("#files", files)
    app.page.wait_for_selector("[data-rsave]")
    app.page.click('[data-rsave="0"]')
    app.page.wait_for_function("Object.keys(state.rosters).length === 1")
    app.page.click("#start")
    app.page.wait_for_selector("#saveDrafts", timeout=60000)
    drafts = app.js("drafts.map(d => ({f: d.filename, w: d.warnings, post: d.post, month: d.month, format: d.format}))")
    app.page.click("#saveDrafts")
    app.page.wait_for_function("Object.keys(state.reports).length >= 6")
    return drafts


@test("取り込み：読み取り中に他のタブを開いても止まらない／要確認以外をすべて保存／同じ月報は上書きかスキップを確認")
def t_import_bg(browser, base):
    app = App(browser, base)
    try:
        folder = fixtures.build(tempfile.mkdtemp(prefix="geppou_bg_"))
        app.tab("import")
        app.page.check('input[name="mmode"][value="auto"]')
        app.page.set_input_files("#files", [os.path.join(folder, f) for f in sorted(os.listdir(folder)) if not f.endswith(".xlsx")])
        app.page.click("#start")
        app.page.wait_for_function("importBusy")
        ok(app.js("document.querySelector('#tabs button[data-page=import]').classList.contains('busy')"), "読み取り中の印がタブに出ない")
        for name in ["dashboard", "stats", "map", "import", "summary"]:
            app.tab(name)
        app.page.wait_for_function("!importBusy", timeout=60000)
        eq(app.js("drafts.length"), 6, "他のタブを開いた後の読み取り件数")
        ok(app.js("!document.querySelector('#tabs button[data-page=import]').classList.contains('busy')"), "読み取り後も印が消えない")
        ok("読み取りが終わりました" in app.js("document.body.innerText"), "終わったお知らせが出ない")
        app.tab("import")
        ok(app.page.locator("#saveDrafts").count() == 1, "取り込みタブに戻っても確認の表が出ない")
        ok("6件を読み取りました" in app.js("document.querySelector('#progress').textContent"), "取り込みタブに結果の件数が出ない")
        # 「要確認以外をすべて保存」：警告のない5件だけ保存し、要確認のタイは表に残る
        ok("5件" in app.page.inner_text("#saveOkDrafts"), "ボタンの件数")
        app.page.click("#saveOkDrafts")
        app.page.wait_for_function("Object.keys(state.reports).length === 5")
        eq(app.js("drafts.map(d => d.filename)"), ["タイ_202607_月報.pdf"], "表に残った要確認の行")
        ok(app.page.locator("#saveDrafts").count() == 1 and app.page.locator("#saveOkDrafts").count() == 0, "残った行の確認の表")
        app.page.click("#saveDrafts")
        app.page.wait_for_function("Object.keys(state.reports).length === 6 && drafts.length === 0")
        # 同じファイルをもう一度：一覧には重ねて入らず、保存のときに上書き／スキップを聞く
        files = [os.path.join(folder, f) for f in sorted(os.listdir(folder)) if f.startswith("ケニア")]
        app.page.set_input_files("#files", files)
        app.page.set_input_files("#files", files)
        ok("重ねて追加しませんでした" in app.js("document.body.innerText"), "同じファイルを重ねて追加したお知らせがない")
        eq(app.js("pending.length"), 2, "一覧のファイル数")
        app.js("state.reports['2026-07|ケニア'].hei = '保存済みの内容'")
        app.page.click("#start")
        app.page.wait_for_selector("#saveDrafts", timeout=60000)
        app.page.click("#saveDrafts")
        app.page.wait_for_selector("dialog.dupdlg[open]")
        ok("2件" in app.page.inner_text("dialog.dupdlg"), "確認の件数")
        app.page.click('dialog.dupdlg [data-ans="skip"]')
        app.page.wait_for_function("drafts.length === 0")
        eq(app.js("state.reports['2026-07|ケニア'].hei"), "保存済みの内容", "スキップしたのに上書きされた")
        app.page.set_input_files("#files", files[:1])
        app.page.click("#start")
        app.page.wait_for_selector("#saveDrafts", timeout=60000)
        app.page.click("#saveDrafts")
        app.page.click('dialog.dupdlg [data-ans="overwrite"]')
        app.page.wait_for_function("drafts.length === 0")
        ok("コレラ" in app.js("state.reports['2026-07|ケニア'].hei"), "上書きされていない")
        eq(app.js("Object.keys(state.reports).length"), 6, "上書き後の件数")
        eq(app.errors, [], "画面のエラー")
    finally:
        app.close()


@test("取り込み：1件ずつ読み取る・消去／選んだものだけ読み取る・保存")
def t_pick(browser, base):
    app = App(browser, base)
    try:
        folder = fixtures.build(tempfile.mkdtemp(prefix="geppou_pick_"))
        names = ["ケニア_202607_月報.pdf", "ケニア_202608_月報.pdf", "ウガンダ_202607_月報.pdf", "タイ_202607_月報.pdf"]
        app.tab("import")
        app.page.check('input[name="mmode"][value="auto"]')
        app.page.set_input_files("#files", [os.path.join(folder, n) for n in names])
        eq(app.page.locator("[data-pread]").count(), 4, "1件ずつの「読み取る」ボタン")
        # 一覧から1件消去 → 3件
        app.page.click('[data-rm="3"]')
        eq(app.js("pending.map(p => p.file.name)"), names[:3], "消去した後の一覧")
        # 1件のチェックを外す → 「選択した 2件を読み取る」
        app.page.uncheck('[data-psel="2"]')
        eq(app.page.inner_text("#start"), "選択した 2件を読み取る", "読み取りボタンの表示")
        app.page.click("#start")
        app.page.wait_for_selector("#saveDrafts", timeout=60000)
        eq(sorted(app.js("drafts.map(d => d.filename)")), sorted(names[:2]), "選んだ2件だけ読み取る")
        eq(app.js("pending.map(p => p.file.name)"), [names[2]], "選ばなかったファイルは一覧に残る")
        # 残った1件をその行の「読み取る」で → 表は3件に増える
        app.page.click('[data-pread="0"]')
        app.page.wait_for_function("!importBusy && drafts.length === 3", timeout=60000)
        eq(app.js("pending.length"), 0, "読み取った後の一覧")
        # 確認の表：1行消去 → 2件、1行だけ保存 → 1件保存・1件残る、選んで保存
        i = app.js("drafts.findIndex(d => d.filename === 'ケニア_202608_月報.pdf')")
        app.page.click(f'[data-ddel="{i}"]')
        eq(app.js("drafts.length"), 2, "表から消去した後の件数")
        i = app.js("drafts.findIndex(d => d.filename === 'ウガンダ_202607_月報.pdf')")
        app.page.fill(f'tr[data-i="{i}"] [data-f="officer"]', "直した 名前")
        app.page.click(f'[data-dsave="{i}"]')
        app.page.wait_for_function("Object.keys(state.reports).length === 1 && drafts.length === 1")
        eq(app.js("state.reports['2026-07|ウガンダ'].officer"), "直した 名前", "表で直した内容で保存")
        eq(app.js("drafts.map(d => d.filename)"), ["ケニア_202607_月報.pdf"], "1件保存した後の表")
        app.page.click("#dselAll")
        ok(app.page.is_disabled("#saveSelDrafts"), "何も選んでいないのに保存ボタンが押せる")
        app.page.check(".dsel")
        app.page.click("#saveDrafts")
        app.page.wait_for_function("Object.keys(state.reports).length === 2 && drafts.length === 0")
        eq(app.errors, [], "画面のエラー")
    finally:
        app.close()


@test("配置表：PDFも読める（配置表の欄へのドロップ・月報と一緒に入れても振り分け）")
def t_roster_pdf(browser, base):
    app = App(browser, base)
    try:
        d = tempfile.mkdtemp(prefix="geppou_roster_")
        named, plain = os.path.join(d, "医務官配置表_202608.pdf"), os.path.join(d, "202608_一覧.pdf")
        fixtures.make_roster_pdf(named)
        fixtures.make_roster_pdf(plain)
        app.tab("import")
        want = [["ケニア", "見本 花子", "みほん はなこ", True], ["ウガンダ", "架空 一郎", "かくう いちろう", True], ["フィリピン", "検証 六子", "けんしょう むつこ", True],
                ["タイ", "試作 七美", "しさく ななみ", True], ["スーダン", "", "", False]]
        rows = "rosterDrafts.map(r => [r.month, r.rows.map(x => [x.post, x.officer, x.kana, x.staffed])])"
        # 1) 配置表の欄にドラッグ＆ドロップ
        app.page.evaluate("""async (b64) => {
            const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const dt = new DataTransfer(); dt.items.add(new File([u8], '医務官配置表_202608.pdf', {type: 'application/pdf'}));
            document.querySelector('#rosterDrop').dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true})); }""",
            base64.b64encode(open(named, "rb").read()).decode())
        app.page.wait_for_function("rosterDrafts.length === 1")
        eq(app.js(rows), [["2026-08", want]], "ドロップした PDF の配置表")
        eq(app.js("rosterDrafts[0].monthFrom"), "ファイル名", "適用月の読み取り元")
        app.js("rosterDrafts = []")
        # 2) 月報の欄に入れた PDF：名前に「配置」があれば配置表、なくても中身で振り分ける
        app.page.check('input[name="mmode"][value="auto"]')
        app.page.set_input_files("#files", [named])
        app.page.wait_for_function("rosterDrafts.length === 1")
        eq(app.js("pending.length"), 0, "名前に「配置」がある PDF が月報の一覧に入った")
        app.js("rosterDrafts = []")
        app.page.set_input_files("#files", [plain])
        app.page.click("#start")
        app.page.wait_for_function("!importBusy && rosterDrafts.length === 1", timeout=60000)
        eq(app.js("drafts.length"), 0, "中身が配置表の PDF を月報として読んだ")
        eq(app.js(rows), [["2026-08", want]], "中身で振り分けた配置表")
        app.page.click('[data-rsave="0"]')
        app.page.wait_for_function("Object.keys(state.rosters).length === 1")
        eq(app.errors, [], "画面のエラー")
    finally:
        app.close()


@test("取り込み：6件すべて読めて、警告は合計不一致の1件だけ")
def t_import(app):
    drafts = {d["f"]: d for d in app.drafts}
    eq(len(drafts), 6, "読み取った件数")
    for f, d in drafts.items():
        if f.startswith("タイ"):
            ok(any("合計が一致しません" in w for w in d["w"]), f"{f}: 合計不一致の警告が出ない {d['w']}")
        else:
            eq(d["w"], [], f"{f} の警告")
    eq(drafts["フィリピン_202608_月報.pdf"]["post"], "フィリピン", "パスワード付きPDF（imukanmd）が開ける")
    eq(drafts["2026年8月_ウガンダ.docx"]["month"], "2026-08", "Wordの対象月")
    eq(app.js("Object.keys(state.reports).sort()"),
       ["2026-07|ウガンダ", "2026-07|ケニア", "2026-07|タイ", "2026-08|ウガンダ", "2026-08|ケニア", "2026-08|フィリピン"], "保存された月報")


@test("集計：受診者数・病名の件数が見本と一致")
def t_totals(app):
    for fname, (_, officer, period, counts, dis, _) in fixtures.REPORTS.items():
        y, m = period.replace("月", "").split("年")
        post = app.js("(e) => canonical(e)", fixtures.REPORTS[fname][0])
        r = app.js("(k) => state.reports[k]", f"{y}-{int(m):02d}|{post}")
        eq([r["staff"], r["family"], r["other"], r["total"]], list(counts), f"{fname} の受診者数")
        eq(r["officer"], officer, f"{fname} の医務官")
        eq(sorted((d["name"], d["count"]) for d in r["diseases"]), sorted(nfkc(dis)), f"{fname} の乙表")
    eq(app.js("reportsOf('2026-08').reduce((s, r) => s + r.total, 0)"), 20 + 11 + 15, "8月の受診者数の合計")
    eq(app.js("diseasesOf('2026-08').filter(d => d.name === 'デング熱').reduce((s, d) => s + d.count, 0)"), 5, "8月のデング熱")


@test("未提出公館：配置表と突合してタイだけ")
def t_missing(app):
    eq(app.js("missingPosts('2026-08').map(r => r.post)"), ["タイ"], "8月の未提出")


@test("医務官の異動：ケニア → ウガンダ を検出")
def t_transfer(app):
    t = app.js("transfers().filter(x => x.month === '2026-08').map(x => [x.post, x.before, x.after, x.from])")
    ok(["ウガンダ", "試験 次郎", "架空 一郎", "ケニア"] in t, f"ウガンダの異動がない: {t}")
    ok(["ケニア", "架空 一郎", "見本 花子", None] in t, f"ケニアの交代がない: {t}")


@test("巡回健診・感染症・緊急移送が保存される")
def t_events(app):
    eq(app.js("state.junkai['2026-08'].map(j => [j.from, j.dest])"), [["ウガンダ", "南スーダン"]], "8月の巡回健診")
    ob = app.js("outbreaksOf('2026-08').map(o => [o.post, o.name, o.trend]).sort()")
    eq(ob, [["ケニア", "コレラ", "減少・終息"], ["フィリピン", "デング熱", "流行・増加"]], "8月の感染症")
    eq(app.js("casesOf('2026-07', 'evac').map(c => [c.post, c.dest])"), [["ケニア", "南アフリカ共和国"]], "7月の緊急移送")


@test("再読み込みしてもデータが残る（ブラウザ内に保存）")
def t_persist(app):
    app.open()
    eq(app.js("Object.keys(state.reports).length"), 6, "再読み込み後の月報の件数")
    eq(app.js("Object.keys(state.rosters)"), ["2026-08"], "再読み込み後の配置表")


@test("すべてのタブがエラーなく表示できる")
def t_tabs(app):
    app.js("refreshMonths('2026-08')")
    for name in app.js("[...document.querySelectorAll('#tabs button[data-page]')].map(b => b.dataset.page)"):
        before = len(app.errors)
        app.tab(name)
        eq(app.errors[before:], [], f"「{name}」タブのエラー")
        ok(len(app.js("document.querySelector('main').innerText")) > 20, f"「{name}」タブが空")


# ----------------------------------------------------------------------- AI用テキスト・出力

@test("AI用テキスト：注意書き・管理番号が付き、氏名が入らない")
def t_ai(app):
    t = app.js("aiText('2026-08', new Set(['submit','visits','cats','top','events','hei','cases','quality']))")
    s = app.js("async (t) => { const n = (state.aiLog || []).length; const r = await stampAiText(t, 'テスト', {}); return [r.t, r.id, state.aiLog.length - n, state.aiLog[0].fp]; }", t)
    text, aid, added, fp = s
    ok(re.fullmatch(r"AI-\d{8}-[A-HJ-NP-Z2-9]{4}", aid), f"管理番号の形式: {aid}")
    ok(text.startswith("【取扱注意】この集計は外務省AI（MOFA GaiXer）・政府AI（源内）専用です。"), "冒頭の注意書き")
    ok(f"管理番号：{aid}" in text, "本文中の管理番号")
    ok("回答の最初に、次の注意文をそのまま表示" in text, "AIへの注意文の指示")
    eq(added, 1, "記録（aiLog）に1件追加")
    eq(app.js("(t) => textFingerprint(t.replace(/^管理番号：.*$/m, '管理番号：消された'))", text), fp, "番号を消しても指紋で照合できる")
    names = {o for _, o, *_ in fixtures.REPORTS.values()} | {n for _, n, _ in fixtures.ROSTER if n}
    for nm in names:
        ok(nm not in text and nm.replace(" ", "") not in text, f"氏名「{nm}」が入っている")
    ok("南アフリカ" not in app.js("(t) => privacyIssues(t).join()", text), "点検が誤検出していない")
    ok(app.js("privacyIssues('35歳の男性が受診').length") >= 2, "年齢・性別を点検で見つける")
    eq(app.js("aiUrls()"), {"gaixer": "https://mofa-ai.gaixer.com/general", "gennai": "https://d3j5pbzknc8vap.cloudfront.net/"}, "AIの送り先（既定）")


@test("PDFレポート：パスワード imukanmd で暗号化され、開ける")
def t_pdf(app):
    from pypdf import PdfReader
    b64 = app.js("""async () => {
        const blob = await buildReportPdf('2026-08', new Set(REPORT_SECTIONS.map(s => s[0])));
        const u8 = new Uint8Array(await blob.arrayBuffer()); let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        return btoa(s); }""")
    r = PdfReader(io.BytesIO(base64.b64decode(b64)))
    ok(r.is_encrypted, "暗号化されていない")
    ok(r.decrypt("wrong-password") == 0, "違うパスワードで開けてしまう")
    ok(r.decrypt(fixtures.PASSWORD) != 0, "imukanmd で開けない")
    ok(len(r.pages) >= 3, f"ページ数が少ない: {len(r.pages)}")


@test("バックアップ：暗号化して書き出し、元どおりに戻せる")
def t_backup(app):
    same, enc = app.js("""async () => {
        const txt = await encryptBackup(state);
        const back = await decryptBackup(txt);
        return [JSON.stringify(back) === JSON.stringify(state), txt]; }""")
    ok(same, "復号した内容が元と違う")
    ok("架空" not in enc and "ケニア" not in enc, "バックアップの中身が平文で読める")
    msg = app.js("decryptBackup(JSON.stringify({format:'geppou-backup-encrypted', salt:'AAAA', iv:'AAAA', data:'AAAA'})).then(() => '', e => e.message)")
    ok("復号できません" in msg, "壊れたバックアップでエラーにならない")


# ----------------------------------------------------------------------- デモ・通信

@test("デモ表示：全タブがエラーなく表示でき、実データに書き込まない")
def t_demo(browser, base):
    app = App(browser, base, "?demo=1")
    try:
        app.page.wait_for_function("demoMode && Object.keys(state.reports).length > 50", timeout=30000)
        for name in app.js("[...document.querySelectorAll('#tabs button[data-page]')].map(b => b.dataset.page)"):
            before = len(app.errors)
            app.tab(name)
            eq(app.errors[before:], [], f"デモ「{name}」タブのエラー")
        eq(app.js("idb.get('state').then(s => s ? Object.keys(s.reports).length : 0)"), 0, "デモのデータが保存領域に書かれている")
        eq(app.external, [], "デモ表示中の外部通信")
    finally:
        app.close()


@test("地図：国・首都・都市のカードを開いても外部に接続しない（Wikipedia の自動読み込み・旅行リンクなし）")
def t_place_card(app):
    app.tab("map")
    app.page.wait_for_function("!!document.getElementById('wmap') && !!document.getElementById('wmap').data")
    before = len(app.external)
    html = app.js("""(() => { const c = PLACES.capitals.find(r => r[0] === 'ナイロビ') || PLACES.capitals[0];
        openPlaceCard({kind: 'capital', name: c[0], iso: c[4], pop: c[3], en: c[5]});
        openPlaceCard({kind: 'country', name: 'ブータン', iso: 'BTN'});
        return document.querySelector('#postcard').innerHTML; })()""")
    app.page.wait_for_timeout(800)
    eq(app.external[before:], [], "カードを開いたときの外部通信")
    for word in ["google.com/travel", "booking.com", "expedia", "wikisum"]:
        ok(word not in html, f"カードに「{word}」が残っている")
    ok("ja.wikipedia.org/wiki/" in html, "Wikipedia へのリンク（押したときだけ開く）がない")
    app.js("openPostCard(['ケニア'])")
    html = app.js("document.querySelector('#postcard').innerHTML")
    ok("google.com/travel" not in html and "booking.com" not in html, "公館カードに旅行リンクが残っている")
    eq(app.js("document.querySelectorAll('canvas.sattex, .mapctl [data-skin], #tabs [data-page=whm]').length"), 0, "衛星写真・医療情報マップが残っている")


@test("外部への通信：取り込みから出力まで一度もない")
def t_network(app):
    eq(app.external, [], "外部への通信")


# ----------------------------------------------------------------------- 実行

def main():
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    srv = start_server()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    folder = fixtures.build(tempfile.mkdtemp(prefix="geppou_test_"))
    failed = 0
    t0 = time.time()
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception:
            browser = p.chromium.launch(executable_path="/opt/pw-browsers/chromium")
        app = App(browser, base)
        try:
            app.drafts = import_fixtures(app, folder)
        except Exception:
            print("✗ 見本の月報を取り込めませんでした")
            traceback.print_exc()
            return 1
        for name, fn in TESTS:
            if only and only not in name:
                continue
            try:
                if fn.__code__.co_argcount == 2:
                    fn(browser, base)
                else:
                    fn(app)
                print(f"✓ {name}")
            except Exception as e:
                failed += 1
                print(f"✗ {name}\n    {e if isinstance(e, AssertionError) else traceback.format_exc()}")
        if app.errors:
            failed += 1
            print("✗ 画面のエラー:\n    " + "\n    ".join(app.errors))
        app.close()
        browser.close()
    srv.shutdown()
    n = sum(1 for name, _ in TESTS if only in name)
    print(f"\n{n - failed if failed <= n else 0}/{n} 件 成功（{time.time() - t0:.0f}秒）" + ("" if not failed else f"　失敗 {failed}件"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
