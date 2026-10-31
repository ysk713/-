// node gen_batch.js <出力フォルダ> <人数> <seed> — 架空の人物の三点セットを画像にし、degrade.py でスキャン風にしてPDFにする
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const F = require("./forms.js");
(async () => {
  const [out, n = "6", seed = "1"] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const ppl = F.people(+n, +seed), r = F.rng(+seed * 7 + 3);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  let pages = [];
  for (let i = 0; i < ppl.length; i++) for (const [type, html] of [["申込書", F.applicationHtml], ["診断書", F.diagnosisHtml], ["指示書", F.instructionHtml]]) {
    const file = path.join(out, `p${i}_${type}.png`);
    await p.setContent(html(ppl[i])); await p.screenshot({ path: file });
    pages.push({ file, person: i, type });
  }
  await b.close();
  // スキャンの乱れ：隣のページとの入れ替え・1人の診断書の欠落・白紙・同じページの重複
  const missing = Math.floor(r() * ppl.length);
  pages = pages.filter(x => !(x.person === missing && x.type === "診断書"));
  for (let k = 0; k < Math.ceil(pages.length / 6); k++) { const i = Math.floor(r() * (pages.length - 1)); [pages[i], pages[i + 1]] = [pages[i + 1], pages[i]]; }
  pages.splice(Math.floor(r() * pages.length), 0, { file: null, person: -1, type: "白紙" });
  fs.writeFileSync(path.join(out, "truth.json"), JSON.stringify({ people: ppl, pages: pages.map(x => ({ person: x.person, type: x.type })), missing }, null, 1));
  execFileSync("python3", [path.join(__dirname, "degrade.py"), path.join(out, "batch.pdf"), String(seed), ...pages.map(x => x.file || "BLANK")], { stdio: "inherit" });
})();
