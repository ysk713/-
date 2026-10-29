"""web/src と vendor のライブラリ、判定ルール・薬品マスタを1つのHTMLにまとめる。
  python web/build.py  →  kousou/index.html（これ1つをダブルクリックで開けば動く。インターネット不要）"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "python" / "kousou"
OUT = ROOT.parent / "index.html"


def js(path: str) -> str:
    # HTML中の </script> で途切れないようにする（JSの文字列・正規表現として意味は変わらない）
    return (ROOT / path).read_text(encoding="utf-8").replace("</script", "<\\/script")


def main():
    html = (ROOT / "src" / "index.html").read_text(encoding="utf-8")
    html = re.sub(r"/\*INLINE:([^*]+)\*/", lambda m: js(m.group(1)), html)
    for key, name in (("rules", "rules.json"), ("master", "drug_master.json")):
        data = json.loads((DATA / name).read_text(encoding="utf-8"))
        html = html.replace(f"/*JSON:{key}*/null", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"{OUT}  {OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
