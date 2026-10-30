// node web/test/ocr_e2e.js <forms.pdf> <port> — Web版（http）でOCRを実際に動かして、空欄が埋まるか確認する
const { chromium } = require("playwright");
(async () => {
  const [pdf, port] = process.argv.slice(2);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  const problems = [], external = [];
  p.on("console", m => { if (m.type() === "error" || /Content Security Policy|Refused/.test(m.text())) problems.push(m.text().slice(0, 200)); });
  p.on("pageerror", e => problems.push("pageerror: " + e.message));
  p.on("request", r => { if (!r.url().startsWith(`http://127.0.0.1:${port}/`) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
  await p.goto(`http://127.0.0.1:${port}/kousou/index.html`);
  await p.setInputFiles("#fileIn", pdf);
  await p.waitForFunction(() => /読込完了/.test(document.querySelector("#status").textContent));
  await p.click("#toReview"); await p.waitForTimeout(300);
  const t0 = Date.now();
  await p.click("#ocrRun");
  await p.waitForFunction(() => /読み取り済み|読み取り完了|できませんでした/.test((document.querySelector("#ocrStatus") || {}).textContent || ""), null, { timeout: 300000 });
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  const r = await p.evaluate(() => { const S = window.__kousou.S, d = S.data[S.cur];
    return { status: document.querySelector("#ocrStatus").textContent, app: d.app.apply_date + " " + d.app.staff_code + " " + d.app.mission_name + " " + d.app.applicant_name,
      diag: d.diag.issue_date + " " + d.diag.staff_code + " " + d.diag.disease + " " + d.diag.doctor_name, inst: d.inst.issue_date,
      drugs: d.drugs.map(x => [x.name, x.strength, x.unit, x.diag, x.inst, x.days].join("|")), filled: Object.keys(d.ocrFilled || {}).length,
      yellow: document.querySelectorAll("#form .ocr-filled").length, dateShown: document.querySelector('[data-p="app.apply_date"]').value,
      findings: document.querySelector("#findings").innerText.split("\n").filter(x => /日付/.test(x)).join(" / ") }; });
  await p.screenshot({ path: pdf.replace(/\.pdf$/, "_ocr.png") });
  console.log(JSON.stringify({ sec, ...r, problems, external }, null, 1));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
