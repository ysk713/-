// node probe.js <batchフォルダ> <port> [ページ番号,...] — 各ページのOCR結果（向き・信頼度・文字）を書き出す（原因調査用）
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
(async () => {
  const [dir, port, only] = process.argv.slice(2);
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto(`http://127.0.0.1:${port}/kousou/index.html`);
  await p.setInputFiles("#fileIn", path.join(dir, "batch.pdf"));
  await p.waitForFunction(() => /読込完了/.test(document.querySelector("#status").textContent), null, { timeout: 120000 });
  const want = only ? only.split(",").map(Number) : null;
  const out = await p.evaluate(async (want) => {
    const { S } = window.__kousou, res = [];
    for (let i = 0; i < S.pages.length; i++) {
      if (want && !want.includes(i + 1)) continue;
      const pg = S.pages[i]; if (pg.blank) { res.push({ i: i + 1, blank: true }); continue; }
      const page = await S.scans[pg.scan].pdf.getPage(pg.idx + 1);
      const vp = page.getViewport({ scale: 2000 / page.getViewport({ scale: 1 }).width });
      const cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height;
      const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const t = performance.now(); const r = await KousouOCR.recognize(cv);
      res.push({ i: i + 1, rot: r.rotation, conf: r.confidence, sec: ((performance.now() - t) / 1000).toFixed(1), type: KousouOCR.docTypeOf(r.text), text: r.text });
    }
    return res;
  }, want);
  const scan = JSON.parse(fs.readFileSync(path.join(dir, "batch_scan.json"), "utf8") || "[]");
  const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8"));
  for (const r of out) { const t = truth.pages[r.i - 1], s = scan[r.i - 1] || {};
    console.log(`=== p${r.i} 正:${t.person}${t.type} 実際の回転${s.rot}° ${s.dpi}dpi → 判定回転${r.rot}° 信頼${r.conf} ${r.sec}s 種類:${r.type}\n${(r.text || "").slice(0, 500)}`); }
  fs.writeFileSync(path.join(dir, "probe.json"), JSON.stringify(out, null, 1));
  await b.close();
})();
