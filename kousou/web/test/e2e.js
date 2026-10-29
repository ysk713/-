// node web/test/e2e.js <scan.pdf> <download_dir>  — index.html をヘッドレスChromiumで操作する
const { chromium } = require("playwright");
const path = require("path"), fs = require("fs");
(async () => {
  const [scan, outDir] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const problems = [], requests = [];
  page.on("console", m => { if (m.type() === "error" || /Content Security Policy|Refused/.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  page.on("request", r => { if (!/^(file|data|blob):/.test(r.url())) requests.push(r.url()); });
  await page.goto("file://" + path.resolve(__dirname, "../../index.html"));
  await page.setInputFiles("#fileIn", scan);
  await page.waitForFunction(() => /読込完了/.test(document.querySelector("#status").textContent), null, { timeout: 60000 });
  const info = await page.evaluate(() => ({ count: document.querySelector("#pageCount").textContent,
    blanks: window.__kousou.S.pages.filter(p => p.blank).length }));
  await page.screenshot({ path: path.join(outDir, "1_split.png") });

  await page.click("#toReview");
  await page.waitForTimeout(500);
  if (!(await page.locator("#clist button").count())) { console.log("NO CASES", problems, await page.locator("#clist").innerText()); process.exit(1); }
  // UIから1件目を実際に入力する
  await page.click(`#clist button >> nth=0`);
  const set = async (p, v) => { const el = page.locator(`[data-p="${p}"]`).first(); await el.fill(v); };
  await set("app.apply_date", "2026-10-20"); await set("app.applicant_name", "架空一郎"); await set("app.staff_code", "A012345");
  await set("app.mission_name", "在架空国大使館"); await page.click("#allConsent");
  await set("diag.issue_date", "2026-10-10"); await set("diag.staff_code", "012345"); await set("diag.disease", "高血圧症");
  await set("diag.doctor_name", "架空医師"); await page.selectOption('[data-p="diag.signature"]', "自筆署名"); await page.selectOption('[data-p="diag.seal"]', "はい");
  await set("inst.issue_date", "2026-10-10"); await set("inst.doctor_name", "架空医師");
  await page.selectOption('[data-p="inst.signature"]', "自筆署名"); await page.selectOption('[data-p="inst.seal"]', "はい");
  await page.click("#addDrug");
  await set("drugs.0.name", "アムロジピン錠10mg"); await set("drugs.0.strength", "10");
  await set("drugs.0.diag", "2"); await set("drugs.0.inst", "2"); await set("drugs.0.days", "30"); await set("drugs.0.qty", "60");
  await page.waitForTimeout(500);
  const f1 = await page.locator("#findings").innerText();
  await page.screenshot({ path: path.join(outDir, "2_review.png") });

  // 残りの人は氏名だけ入れる
  for (let i = 1; i < 5; i++) {
    await page.click(`#clist button >> nth=${i}`);
    await set("app.applicant_name", ["架空花子", "架空次郎", "架空三郎", "架空四郎"][i - 1]);
    await page.waitForTimeout(300);
  }
  await page.click('[data-step="output"]');
  await page.fill("#outDate", "20261029");
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, "3_output.png"), fullPage: false });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dlZip")]);
  const zipPath = path.join(outDir, dl.suggestedFilename());
  await dl.saveAs(zipPath);
  console.log(JSON.stringify({ info, f1, zip: zipPath, problems, requests }, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
