"""ブラウザ版（geppou/）をオフラインで使うためのサービスワーカー sw.js を作り直す。

    python3 geppou-app/sample/build_sw.py

geppou/ の中のファイル（アプリ本体・ライブラリ・地図・国旗・デモ）を一覧にして sw.js に書き込む。
版の名前はファイル内容のハッシュなので、どれかを変えて実行すると利用者のブラウザで自動的に入れ替わる。
geppou/ のファイルを追加・変更したら、公開の前に実行する。
"""
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "..", "geppou")
SKIP = {"sw.js", "README.md"}

files = []
for root, _, names in os.walk(WEB):
    for n in names:
        rel = os.path.relpath(os.path.join(root, n), WEB).replace(os.sep, "/")
        if n in SKIP or n.startswith(".") or n == "LICENSE":
            continue
        files.append(rel)
files.sort()
h = hashlib.sha256()
for f in files:
    h.update(f.encode())
    with open(os.path.join(WEB, f), "rb") as fp:
        h.update(fp.read())
tpl = open(os.path.join(HERE, "sw_template.js"), encoding="utf-8").read()
h.update(tpl.encode())
version = h.hexdigest()[:12]

out = tpl.replace("__VERSION__", version).replace("__FILES__", json.dumps(["./"] + files, ensure_ascii=False, indent=1))
with open(os.path.join(WEB, "sw.js"), "w", encoding="utf-8") as fp:
    fp.write(out)
print(f"wrote sw.js  version={version}  files={len(files)}")
