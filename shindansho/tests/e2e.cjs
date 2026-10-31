// 診断書・指示書 作成支援：ブラウザで主な動きを確かめる自動テスト
//   使い方（リポジトリのルートで）：
//     npm install --no-save playwright   ← 初回だけ（ブラウザ本体も必要：npx playwright install chromium）
//     node shindansho/tests/e2e.cjs
//   Chromium の場所を指定する場合：CHROMIUM_PATH=/path/to/chromium node shindansho/tests/e2e.cjs
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".xlsx": "application/octet-stream" };

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok) => server.listen(0, () => ok(server)));
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["OK ", name]); }
  catch (e) { results.push(["NG ", `${name}\n      ${e.message.split("\n")[0]}`]); }
}

(async () => {
  const server = await serve();
  const url = `http://localhost:${server.address().port}/shindansho/`;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1300, height: 1000 } });
  const page = await ctx.newPage();
  const dialogs = [];
  const errors = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  page.on("pageerror", (e) => errors.push(e.message));
  const set = async (sel, v) => { await page.fill(sel, String(v)); await page.dispatchEvent(sel, "input"); };
  const checks = () => page.$eval("#checks", (e) => e.innerText);
  const fresh = async () => { await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.reload(); dialogs.length = 0; };
  const sample = async () => { await page.click("[data-page=settings]"); await page.click("#bSample"); };

  await test("開くたびに免責事項を表示する", async () => {
    await page.goto(url); dialogs.length = 0; await page.reload();
    assert.ok(dialogs.some((m) => m.includes("療養費請求の可否")));
  });

  await test("定期・不均等の計算と表示", async () => {
    await fresh(); await sample();
    const t = await page.$eval("#calc0", (e) => e.innerText);
    assert.match(t, /分2 朝夕食後　1日1\.5錠（朝1錠・夕0\.5錠）　84日分/);
    assert.match(t, /総量 126錠/);
  });

  await test("「分」のない用法は時間帯から回数を推定する", async () => {
    await set('[data-path="drugs.1.usage"]', "朝夕食後");
    assert.match(await page.$eval("#calc1", (e) => e.innerText), /1回1錠（1日2錠）　84日分/);
    assert.match(await checks(), /1日2回として計算/);
  });

  await test("頓服は回数で出す", async () => {
    await page.selectOption('[data-usage-pick="1"]', "頓服（疼痛時）");
    await set('[data-path="drugs.1.days"]', 10);
    assert.match(await page.$eval("#calc1", (e) => e.innerText), /頓服（疼痛時）　1回1錠　10回分/);
  });

  await test("1日上限の超過はエラー", async () => {
    await page.uncheck('[data-path="drugs.0.uneven"]');
    await set('[data-path="drugs.0.strength"]', 10);
    await set('[data-path="drugs.0.perDose"]', 2);
    assert.match(await checks(), /承認上限 10mg\/日 を超えています/);
  });

  await test("麻薬は入力できず、向精神薬は注意つきで入力できる", async () => {
    await set('[data-path="drugs.1.name"]', "オキシコンチン"); await page.dispatchEvent('[data-path="drugs.1.name"]', "change"); await page.waitForTimeout(100);
    assert.equal(await page.inputValue('[data-path="drugs.1.name"]'), "");
    await set('[data-path="drugs.1.name"]', "デパス"); await page.dispatchEvent('[data-path="drugs.1.name"]', "change"); await page.waitForTimeout(100);
    assert.equal(await page.inputValue('[data-path="drugs.1.name"]'), "デパス");
    assert.ok(dialogs.some((m) => m.includes("本省の許可")));
    assert.match(await checks(), /本省の許可が必要/);
  });

  await test("小児は用量の確認を促す", async () => {
    await set('[data-path="patient.birth"]', "2020-05-01");
    assert.match(await checks(), /小児です/);
    await set('[data-path="patient.birth"]', "1985-04-12");
  });

  await test("未保存の変更を表示し、保存すると消える", async () => {
    assert.match(await page.textContent("#saveState"), /未保存の変更/);
    await page.click("#saveDoc");
    assert.doesNotMatch(await page.textContent("#saveState"), /未保存の変更/);
  });

  await test("印刷：診断書と指示書の2枚", async () => {
    await page.evaluate(() => { window.print = () => {}; });
    await page.click("#printBtn");
    assert.equal(await page.$$eval("#print .sheet", (e) => e.length), 2);
    assert.match(await page.$eval(".shindan .rx", (e) => e.innerText), /アムロジピン錠10mg/);
    assert.match(await page.$eval(".shiji", (e) => e.innerText), /ガイム ハナコ/); // フリガナはカタカナにそろえる
  });

  await test("保存一覧：ひらがな・薬品名で絞り込める", async () => {
    await page.click("[data-page=list]");
    for (const q of ["がいむ", "ガイム", "アムロジピン", "あむろじぴん"]) {
      await page.fill("#listQuery", q); await page.waitForTimeout(400);
      assert.equal(await page.$$eval("details.patient", (e) => e.length), 1, q);
    }
    await page.fill("#listQuery", "存在しない名前"); await page.waitForTimeout(400);
    assert.equal(await page.$$eval("details.patient", (e) => e.length), 0);
    await page.fill("#listQuery", ""); await page.waitForTimeout(400);
  });

  await test("日数を空にすると空のまま（30日に戻らない）でエラー", async () => {
    await page.click("[data-page=edit]");
    await set('[data-path="drugs.0.days"]', "");
    assert.equal(await page.evaluate(() => state.doc.drugs[0].days), "");
    assert.match(await checks(), /処方日数が未入力/);
    await set('[data-path="drugs.0.days"]', 30);
  });

  await test("錠数で上限を持つ配合錠の過量をエラーにする", async () => {
    const msgs = await page.evaluate(() => runChecks(normalizeDoc({ ...newDoc(), diagnoses: "月経困難症", drugs: [{ ...newDrugRow(28), name: "ヤーズ配合錠", unit: "", usage: "分3 毎食後", times: 3, perDose: 2 }] })).map((c) => c.msg).join("\n"));
    assert.match(msgs, /承認上限 1錠\/日 を超えています/);
  });

  await test("有効期限（3か月）を過ぎた書類はエラー", async () => {
    const msgs = await page.evaluate(() => runChecks(normalizeDoc({ ...newDoc(), issueDate: "2020-01-01" })).map((c) => c.msg).join("\n"));
    assert.match(msgs, /3か月を過ぎています/);
  });

  await test("病名の言い換え・略語を保険適応として認める", async () => {
    const r = await page.evaluate(() => [["BPH", ["前立腺肥大症"]], ["橋本病", ["甲状腺機能低下症"]], ["不眠", ["不眠症"]], ["DM", ["2型糖尿病"]], ["適応障害", ["うつ病"]]].map(([d, ind]) => indicationMatches(ind, d)));
    assert.deepEqual(r, [true, true, true, true, false]);
  });

  await test("2つのタブで保存しても、両方の書類が残る", async () => {
    const t2 = await ctx.newPage(); t2.on("dialog", (d) => d.accept());
    await t2.goto(url);
    await page.evaluate(() => { state.doc = newDoc(); state.doc.patient.name = "タブ1の人"; saveDoc(false); });
    await t2.evaluate(() => { state.doc = newDoc(); state.doc.patient.name = "タブ2の人"; saveDoc(false); });
    const names = await page.evaluate(() => JSON.parse(localStorage.getItem("shindansho.cases")).map((c) => c.patient.name));
    assert.ok(names.includes("タブ1の人") && names.includes("タブ2の人"), names.join(","));
    await t2.close();
  });

  await test("10剤＋長い補足でも、各書類がUS Letterの1枚に収まるよう縮める", async () => {
    const r = await page.evaluate(() => {
      const d = normalizeDoc({ ...newDoc(), diagnoses: "高血圧症\n脂質異常症\n2型糖尿病\n逆流性食道炎",
        drugs: Array.from({ length: 10 }, () => ({ ...newDrugRow(90), name: "サクビトリルバルサルタン錠", strength: "100", usage: "分2 朝夕食後（12時間毎）", times: 2, note: "血圧が110未満の日は夕の内服を休む。めまい時は中止して受診" })) });
      const box = document.getElementById("print");
      box.innerHTML = shindanHtml(d) + shijiHtml(d);
      fitSheets();
      box.classList.add("measure");
      const probe = document.createElement("div"); probe.style.height = "241mm"; box.appendChild(probe);
      const limit = probe.getBoundingClientRect().height; probe.remove();
      const hs = [...box.querySelectorAll(".sheet")].map((x) => x.getBoundingClientRect().height);
      box.classList.remove("measure");
      return { limit, hs };
    });
    for (const h of r.hs) assert.ok(h <= r.limit + 1, `${h} > ${r.limit}`);
  });

  await test("画面ロック：PINを設定すると開くたびにPINを聞く", async () => {
    await page.click("[data-page=settings]");
    await page.fill("#pinNew", "2468"); await page.click("#pinSave");
    await page.reload();
    assert.equal(await page.isVisible("#lock"), true);
    await page.fill("#lockPin", "1111"); await page.click("#lockGo");
    assert.match(await page.textContent("#lockMsg"), /PINが違います/);
    await page.fill("#lockPin", "2468"); await page.click("#lockGo");
    assert.equal(await page.isVisible("#lock"), false);
    await page.click("[data-page=settings]"); await page.click("#pinOff");
  });

  let xferPath;
  await test("移管データ：パスワード付きで書き出し、中身は読めない", async () => {
    await page.click("[data-page=list]");
    await page.click("[data-export]");
    await page.fill("#xPw", "Test-Pass-1234");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#xDownload")]);
    xferPath = await dl.path();
    const raw = fs.readFileSync(xferPath, "utf8");
    assert.ok(!/外務|花子|アムロジピン/.test(raw));
    await page.keyboard.press("Escape");
  });

  await test("移管データ：別のブラウザで読み込める（誤ったパスワードは拒否）", async () => {
    const other = await browser.newContext();
    const p2 = await other.newPage();
    p2.on("dialog", (d) => d.accept());
    await p2.goto(url); await p2.click("[data-page=list]");
    const [fc] = await Promise.all([p2.waitForEvent("filechooser"), p2.click("#importXfer")]);
    await fc.setFiles(xferPath);
    await p2.fill("#iPw", "wrong-password"); await p2.click("#iGo"); await p2.waitForTimeout(1500);
    assert.match(await p2.textContent("#iMsg"), /パスワードが違う/);
    await p2.fill("#iPw", "Test-Pass-1234"); await p2.click("#iGo"); await p2.waitForTimeout(1500);
    assert.equal(await p2.$$eval("details.patient", (e) => e.length), 1);
    assert.match(await p2.$eval(".badge.warn", (e) => e.textContent), /移管元/);
    await other.close();
  });

  await test("バックアップ：パスワード付きで書き出し、読み込める", async () => {
    await page.click("[data-page=settings]");
    await page.fill("#bPw", "Backup-Pass-99"); await page.click("#bPwSave");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#bExport")]);
    const file = await dl.path();
    assert.ok(!/外務|花子/.test(fs.readFileSync(file, "utf8")));
    await page.evaluate(() => localStorage.removeItem("shindansho.cases")); await page.reload();
    await page.click("[data-page=settings]");
    await page.setInputFiles("#bImport", file);
    await page.fill("#iPw", "Backup-Pass-99"); await page.click("#iGo"); await page.waitForTimeout(1500);
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem("shindansho.cases") || "[]").length) >= 1);
  });

  await test("Excel版をダウンロードできる", async () => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("a.btn")]);
    assert.ok(fs.statSync(await dl.path()).size > 10000);
  });

  await test("画面のエラーが出ていない", async () => { assert.deepEqual(errors, []); });

  await browser.close();
  server.close();
  for (const [r, n] of results) console.log(r + n);
  const ng = results.filter(([r]) => r.startsWith("NG")).length;
  console.log(ng ? `\n${ng}件 失敗` : `\nすべて成功（${results.length}件）`);
  process.exit(ng ? 1 : 0);
})();
