"""claude.ai 版（src/checker.html）から GitHub Pages 用の index.html を作る。

claude.ai 版はページの骨組み（<html><head>…）を claude.ai 側が付けるため、
ここで骨組みを付け、外部への通信を禁止する Content-Security-Policy を入れる。
Google Fonts の読み込みは外す（通信しないため。表示は游ゴシック等になる）。

使い方: python3 sekai-check/build.py
"""
import re
from pathlib import Path

HERE = Path(__file__).parent
src = (HERE / "src" / "checker.html").read_text(encoding="utf-8")

src = re.sub(r'<link rel="(?:preconnect|stylesheet)"[^>]*>\n?', "", src)
src = re.sub(r'<meta name="claude:viewport-fit-sides"[^>]*>\n?', "", src)
title = re.search(r"<title>.*?</title>", src).group(0)
style = re.search(r"<style>.*?</style>", src, re.S).group(0)
body = src.replace(title, "", 1).replace(style, "", 1).strip()

CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
       "img-src data: blob:; connect-src blob: data:; font-src data:")

html = f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<!-- 外部への通信を一切禁止する（読み込んだ原稿・入力内容はこのPCの外に出ない） -->
<meta http-equiv="Content-Security-Policy" content="{CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
{title}
{style}
</head>
<body>
{body}
</body>
</html>
"""
(HERE / "index.html").write_text(html, encoding="utf-8")
print("sekai-check/index.html を作成しました")
