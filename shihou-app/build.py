# index.html・style.css・data.js・app.js を1つのHTMLにまとめ、端末に保存してオフラインで開ける shihou-note.html を作る
from pathlib import Path
d = Path(__file__).parent
html = (d / "index.html").read_text(encoding="utf-8")
css = (d / "style.css").read_text(encoding="utf-8")
html = html.replace('<link rel="stylesheet" href="style.css">', "<style>\n" + css + "</style>")
for name in ("data.js", "app.js"):
    js = (d / name).read_text(encoding="utf-8").replace("</script", "<\\/script")
    html = html.replace(f'<script src="{name}"></script>', "<script>\n" + js + "</script>")
(d / "shihou-note.html").write_text(html, encoding="utf-8")
print("shihou-note.html", len(html.encode()), "bytes")
