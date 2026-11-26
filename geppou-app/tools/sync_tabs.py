"""上のタブの絵（app.js の TAB_ART）を index.html にも書き込む。

    python3 geppou-app/tools/sync_tabs.py

アプリを開いた直後（大きなライブラリを読み込んでいる間）も、タブが文字ではなく絵で出るように、
JS が付けるのと同じ中身（色のタイルの絵・吹き出しの名前・読み上げの名前）を最初から HTML に入れておく。
TAB_ART・TAB_SHORT・タブの名前を変えたら実行する（自動テストで食い違いを調べる）。
"""
import html
import os
import re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "geppou")
app = open(os.path.join(ROOT, "app.js"), encoding="utf-8").read()
idx_path = os.path.join(ROOT, "index.html")
idx = open(idx_path, encoding="utf-8").read()

art_src = app[app.index("const TAB_ART = {"):]
art_src = art_src[:art_src.index("\n};")]
ART = {m.group(1): (m.group(2), m.group(3), m.group(4)) for m in re.finditer(r'^\s*(\w+): \["(#[0-9a-fA-F]+)", "(#[0-9a-fA-F]+)", \'(.*)\'\],?\s*$', art_src, re.M)}
short_src = re.search(r"const TAB_SHORT = \{(.*?)\};", app).group(1)
SHORT = dict(re.findall(r'(\w+): "([^"]*)"', short_src))


def tart(k):
    a = ART[k]
    return (f'<span class="tart" style="--t1:{a[0]};--t2:{a[1]}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#fff" '
            f'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{a[2]}</svg></span>')


def repl(m):
    attrs, label = m.group(1), m.group(2)
    k = re.search(r'data-page="(\w+)"', attrs).group(1)
    full = html.unescape(re.sub(r"<[^>]+>", "", label)).strip()
    tip = re.search(r'data-tip="([^"]*)"', attrs)
    if tip:
        full = html.unescape(tip.group(1))
    if k not in ART or "tab-sub" in attrs:
        return m.group(0)
    attrs = re.sub(r'\s(data-tip|aria-label)="[^"]*"', "", attrs)
    e = html.escape(full, quote=True)
    return f'<button{attrs} data-tip="{e}" aria-label="{e}">{tart(k)}<span class="tlab">{html.escape(SHORT.get(k, full))}</span></button>'


nav = re.search(r'(<nav class="tabs" id="tabs">)(.*?)(</nav>)', idx, re.S)
body = re.sub(r"<button([^>]*)>(.*?)</button>", repl, nav.group(2), flags=re.S)
idx = idx[:nav.start(2)] + body + idx[nav.end(2):]
open(idx_path, "w", encoding="utf-8").write(idx)
print("index.html のタブを更新しました：", ", ".join(k for k in ART))
