"""過去の医務官配置表を、アプリに「読み込んだ形」で入れる（geppou/rosters.enc.js を作る）。

    python3 geppou-app/tools/build_roster_pack.py <配置表のフォルダ>

- フォルダの中の配置表（Excel・PDF・Word）を、アプリの取り込みと同じ読み取りで読み、
  月ごと（月の途中の更新は日付ごと）の配置表にまとめる。
- 氏名を含むので、合言葉で暗号化してから書き出す（PBKDF2-SHA256 60万回 + AES-256-GCM）。
  合言葉は実行時に聞く（環境変数 ROSTER_PASS でも渡せる）。ファイルにもコードにも書かない。
- 書き出すのは暗号文と、配置表の月の一覧だけ。元の配置表のファイルはコミットしない。
- 利用者は最初に1回だけ、取り込みのタブで合言葉を入れる。そのあとは新しい配置表だけを取り込めばよい。
- 合言葉を変えたい・配置表を足したいときは、もう一度実行して作り直す。
"""
import base64
import getpass
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests"))
import run_tests as R  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "geppou", "rosters.enc.js")
EXT = (".xlsx", ".xlsm", ".xls", ".pdf", ".docx")


def main():
    if len(sys.argv) < 2 or not os.path.isdir(sys.argv[1]):
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    files = []
    for root, _, names in os.walk(src):
        for n in sorted(names):
            if n.lower().endswith(EXT) and not n.startswith((".", "~$")):
                p = os.path.join(root, n)
                files.append({"name": n, "path": os.path.relpath(p, src).replace(os.sep, "/"),
                              "b64": base64.b64encode(open(p, "rb").read()).decode()})
    if not files:
        sys.exit("配置表のファイルが見つかりません")
    pw = os.environ.get("ROSTER_PASS") or getpass.getpass("合言葉（画面には出ません）: ")
    if not os.environ.get("ROSTER_PASS") and getpass.getpass("もう一度: ") != pw:
        sys.exit("合言葉が一致しません")
    if len(pw) < 8:
        sys.exit("合言葉は8文字以上にしてください")

    srv = R.start_server()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium")
        app = R.App(b, base, "")
        pg = app.page
        pg.evaluate("goPage('import')")
        pg.wait_for_selector("#rosterPreview", state="attached")
        res = pg.evaluate("""async ([files, pw]) => {
          const items = files.map((f) => ({ file: new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name), path: f.path }));
          rosterDrafts = [];
          await addRosters(items);
          const rosters = {}, errors = [], dup = [], rekey = [];
          // 表の見出しの日付（「○月○日現在」）が古いままのファイルがあり、別のファイルと同じ日付になることがある。
          // そのときはファイル名の日付で分ける（ファイル名の日付のほうが新しい版を表す）
          const nameKey = (r) => { const d = nfkc(r.path || r.name).match(/(20\\d{2})[.\\-_年](\\d{1,2})[.\\-_月](\\d{1,2})/); if (!d) return null; const m = `${d[1]}-${d[2].padStart(2, '0')}`, dd = Number(d[3]); return dd > 1 ? `${m}-${String(dd).padStart(2, '0')}` : m; };
          const ok = rosterDrafts.filter((r) => { if (r.error) { errors.push(r.name + '：' + r.error); return false; } if (!/^20\\d{2}-\\d{2}$/.test(r.month || '')) { errors.push(r.name + '：月が読み取れません'); return false; } return true; });
          const cnt = {}; for (const r of ok) { const k = rosterDraftKey(r); cnt[k] = (cnt[k] || 0) + 1; }
          for (const r of ok) {
            let k = rosterDraftKey(r);
            if (cnt[k] > 1) { const nk = nameKey(r); if (nk && nk !== k) { rekey.push(k + ' → ' + nk); k = nk; } }
            if (rosters[k]) dup.push(k);
            rosters[k] = [...r.rows];
          }
          const keys = Object.keys(rosters).sort((a, b) => rosterKeySort(a).localeCompare(rosterKeySort(b)));
          const iter = 600000, salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
          const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pw).normalize('NFKC').trim()), 'PBKDF2', false, ['deriveKey']);
          const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
          const gz = new Uint8Array(await new Response(new Blob([JSON.stringify({ v: 1, rosters })]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
          const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz));
          const pack = { v: 1, kdf: 'PBKDF2-SHA256', iter, cipher: 'AES-256-GCM', z: 'gzip', keys, salt: b64(salt), iv: b64(iv), data: b64(data) };
          const sizes = keys.map((k) => k + ' ' + rosters[k].length + '公館');
          return { pack, errors, dup, sizes, rekey };
        }""", [files, pw])
        app.close()
        b.close()
    srv.shutdown()

    import json
    with open(OUT, "w", encoding="utf-8") as fp:
        fp.write("// 過去の医務官配置表（氏名を含むので合言葉で暗号化。PBKDF2-SHA256 + AES-256-GCM）。\n")
        fp.write("// geppou-app/tools/build_roster_pack.py で作る。合言葉はここにもアプリにも書かない。\n")
        fp.write("window.ROSTER_PACK = " + json.dumps(res["pack"], ensure_ascii=False) + ";\n")
    print(f"書き出しました：{os.path.normpath(OUT)}（配置表 {len(res['pack']['keys'])}件）")
    for s in res["sizes"]:
        print("  ", s)
    for e in res["errors"]:
        print("  読めず：", e)
    for d in res["rekey"]:
        print("  見出しの日付が重なったのでファイル名の日付に：", d)
    for d in res["dup"]:
        print("  同じ月が重複（後のものを使用）：", d)
    print("このあと python3 geppou-app/sample/build_sw.py を実行してから公開してください。")


if __name__ == "__main__":
    main()
