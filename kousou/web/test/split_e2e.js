// node web/test/split_e2e.js <mixed.pdf> <port> — OCRで氏名を読んで人ごとに分けられるか（Web版で実際にOCR）
const { chromium } = require("playwright");
(async () => {
  const [pdf, port] = process.argv.slice(2);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  const problems = [], external = [];
  p.on("pageerror", e => problems.push(e.message));
  p.on("request", r => { if (!r.url().startsWith(`http://127.0.0.1:${port}/`) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
  await p.goto(`http://127.0.0.1:${port}/kousou/index.html`);
  await p.setInputFiles("#fileIn", pdf);
  await p.waitForFunction(() => /読込完了/.test(document.querySelector("#status").textContent));
  const t0 = Date.now();
  await p.click("#splitOcr");
  await p.waitForFunction(() => /人に分けました|できませんでした/.test(document.querySelector("#status").textContent), null, { timeout: 600000 });
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  const r = await p.evaluate(() => {
    const { S, groups } = window.__kousou;
    return { status: document.querySelector("#status").textContent, count: document.querySelector("#pageCount").textContent,
      pages: S.pages.map(x => `p${x.idx + 1} ${x.type} [${(x.ocrNames || []).join("/")}]`),
      groups: groups().map(g => g.pages.map(x => x.idx + 1).join(",")) };
  });
  await p.screenshot({ path: pdf.replace(/\.pdf$/, "_split.png") });
  // ②で氏名の不一致チェックと警告
  await p.click("#toReview"); await p.waitForTimeout(400);
  const warn = [];
  for (let i = 0; i < r.groups.length; i++) { await p.click(`#clist button >> nth=${i}`); await p.waitForTimeout(300); warn.push((await p.locator("#findings").innerText()).split("\n").filter(x => /申込書が見つかりません|氏名が一致/.test(x)).join(" ")); }
  console.log(JSON.stringify({ sec, ...r, warn, problems, external }, null, 1));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
