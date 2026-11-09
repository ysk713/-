"""src/ から GitHub Pages 用の index.html を作る。

SheetJS（Excelの読み書き）と src/core.js を HTML に埋め込み、
外部への通信を禁止する Content-Security-Policy を付ける。

使い方: python3 kinkyu-isou/build.py
"""
from pathlib import Path

HERE = Path(__file__).parent
app = (HERE / "src" / "app.html").read_text(encoding="utf-8")
core = (HERE / "src" / "core.js").read_text(encoding="utf-8")
xlsx = (HERE.parent / "geppou" / "lib" / "xlsx.full.min.js").read_text(encoding="utf-8")

title_end = app.index("</title>") + len("</title>")
title, rest = app[:title_end], app[title_end:]
style_end = rest.index("</style>") + len("</style>")
style, body = rest[:style_end], rest[style_end:]

CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
       "img-src data: blob:; connect-src blob: data:; font-src data:; base-uri 'none'; form-action 'none'")

html = f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<!-- 外部への通信を一切禁止する（読み込んだ登録フォームの内容はこのPCの外に出ない） -->
<meta http-equiv="Content-Security-Policy" content="{CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
{title}
{style}
<script>/* SheetJS Community Edition 0.18.5 (Apache-2.0) */
{xlsx.replace("</script", "<\\/script")}
</script>
<script>
{core}
</script>
</head>
<body>
{body.strip()}
</body>
</html>
"""
(HERE / "index.html").write_text(html, encoding="utf-8")
print("kinkyu-isou/index.html を作成しました")
