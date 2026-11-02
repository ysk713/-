// node gen_batch.js <出力フォルダ> <人数> <seed> — 架空の人物の三点セットを画像にし、degrade.py でスキャン風にしてPDFにする
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const F = require("./forms.js");
(async () => {
  const [out, n = "6", seed = "1", mode = ""] = process.argv.slice(2);
  const duplex = mode === "duplex";   // 両面スキャン：各書類の裏が入る（申込書の裏は利用の手引き、診断書・指示書の裏は白紙＋表の透け）
  fs.mkdirSync(out, { recursive: true });
  const ppl = F.people(+n, +seed), r = F.rng(+seed * 7 + 3);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  let sheets = [];
  for (let i = 0; i < ppl.length; i++) for (const [type, html] of [["申込書", F.applicationHtml], ["診断書", F.diagnosisHtml], ["指示書", F.instructionHtml]]) {
    const file = path.join(out, `p${i}_${type}.png`);
    await p.setContent(html(ppl[i])); await p.screenshot({ path: file });
    const sheet = [{ file, person: i, type }];
    if (duplex) {
      if (type === "申込書") { const g = path.join(out, `p${i}_裏面.png`); await p.setContent(F.guideHtml(ppl[i])); await p.screenshot({ path: g }); sheet.push({ file: g, person: i, type: "裏面" }); }
      else sheet.push({ file: "SHOW:" + file, person: -1, type: "白紙" });   // 白紙の裏（表の文字がうっすら透ける）
    }
    sheets.push(sheet);
  }
  await b.close();
  // スキャンの乱れ（用紙単位）：隣の用紙との入れ替え・1人の診断書の欠落・白紙・同じ用紙の重複は無し
  const missing = Math.floor(r() * ppl.length);
  sheets = sheets.filter(sh => !(sh[0].person === missing && sh[0].type === "診断書"));
  for (let k = 0; k < Math.ceil(sheets.length / 6); k++) { const i = Math.floor(r() * (sheets.length - 1)); [sheets[i], sheets[i + 1]] = [sheets[i + 1], sheets[i]]; }
  sheets.splice(Math.floor(r() * sheets.length), 0, [{ file: null, person: -1, type: "白紙" }]);
  const pages = sheets.flat();
  fs.writeFileSync(path.join(out, "truth.json"), JSON.stringify({ people: ppl, pages: pages.map(x => ({ person: x.person, type: x.type })), missing }, null, 1));
  execFileSync("python3", [path.join(__dirname, "degrade.py"), path.join(out, "batch.pdf"), String(seed), ...pages.map(x => x.file || "BLANK")], { stdio: "inherit" });
})();
