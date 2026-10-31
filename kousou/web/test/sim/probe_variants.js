// node probe_variants.js <batch> <port> <ページ番号,...> — 前処理の違い（白黒化なし／白黒化のみ／白黒化＋罫線消し）で読み比べる
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
(async () => {
  const [dir, port, pagesArg] = process.argv.slice(2);
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto(`http://127.0.0.1:${port}/kousou/index.html`);
  await p.setInputFiles("#fileIn", path.join(dir, "batch.pdf"));
  await p.waitForFunction(() => /読込完了/.test(document.querySelector("#status").textContent), null, { timeout: 120000 });
  const res = await p.evaluate(async (want) => {
    const { S } = window.__kousou, out = [];
    for (const n of want) {
      const pg = S.pages[n - 1], page = await S.scans[pg.scan].pdf.getPage(pg.idx + 1);
      const vp = page.getViewport({ scale: 2000 / page.getViewport({ scale: 1 }).width });
      const cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height;
      const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      for (const [label, opts] of [["白黒化なし", { bin: "none" }], ["白黒化のみ", { lines: false }], ["白黒化＋罫線消し", {}]]) {
        const t = performance.now(), r = await KousouOCR.recognize(cv, null, opts);
        out.push({ n, label, conf: r.confidence, sec: ((performance.now() - t) / 1000).toFixed(1), text: r.text });
      }
    }
    return out;
  }, pagesArg.split(",").map(Number));
  for (const r of res) console.log(`=== p${r.n} ${r.label} 信頼${r.conf} ${r.sec}s\n` + r.text.split("\n").filter(l => /申込|公館|番号|氏名|療養|続柄|病名|日分|錠|令和|20\d\d年/.test(l)).slice(0, 12).join("\n"));
  await b.close();
})();
