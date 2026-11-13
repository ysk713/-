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
    // 向精神薬を入れる前は、処方欄や入力候補で「向精神薬」と明示しない
    assert.doesNotMatch(await page.$eval("#drugs", (e) => e.closest("section").innerText), /向精神薬/);
    assert.doesNotMatch(await page.$eval("#druglist", (e) => e.innerHTML), /向精神薬/);
    await set('[data-path="drugs.1.name"]', "オキシコンチン"); await page.dispatchEvent('[data-path="drugs.1.name"]', "change"); await page.waitForTimeout(100);
    assert.equal(await page.inputValue('[data-path="drugs.1.name"]'), "");
    await set('[data-path="drugs.1.name"]', "デパス"); await page.dispatchEvent('[data-path="drugs.1.name"]', "change"); await page.waitForTimeout(100);
    assert.equal(await page.inputValue('[data-path="drugs.1.name"]'), "デパス");
    assert.ok(dialogs.some((m) => m.includes("本省の許可")));
    assert.match(await checks(), /本省の許可が必要/);
    assert.match(await page.$eval("#calc1", (e) => e.innerText), /購送には本省の許可が必要/);
  });

  await test("家族のときは館員本人の氏名の欄を出し、空なら知らせる（印刷には載せない）", async () => {
    assert.equal(await page.isVisible("#staffNameField"), true);
    assert.equal(await page.inputValue('[data-path="patient.staffName"]'), "外務 一郎");
    await set('[data-path="patient.staffName"]', "");
    assert.match(await checks(), /館員本人の氏名/);
    await set('[data-path="patient.staffName"]', "外務 一郎");
    await page.selectOption('[data-path="patient.rel"]', "本人");
    assert.equal(await page.isVisible("#staffNameField"), false);
    await page.selectOption('[data-path="patient.rel"]', "配偶者");
    await page.evaluate(() => { window.print = () => {}; }); await page.click("#printBtn");
    assert.doesNotMatch(await page.$eval("#print", (e) => e.innerText), /外務 一郎/);
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
    // 人が操作する間隔（1秒）をあける。ブラウザがタブの間で保存内容を伝えるのに少し時間がかかるため、数ミリ秒差の保存は対象外
    await t2.waitForTimeout(1000);
    await t2.evaluate(() => { state.doc = newDoc(); state.doc.patient.name = "タブ2の人"; saveDoc(false); });
    await page.waitForTimeout(500);
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

  await test("規格に単位ごと書いても（5mg）、数字と単位に分けて印刷・上限チェックする", async () => {
    await page.click("[data-page=edit]");
    await page.evaluate(() => { state.doc = newDoc(); state.doc.diagnoses = "高血圧症"; render(); });
    await set('[data-path="drugs.0.name"]', "ノルバスク"); await page.dispatchEvent('[data-path="drugs.0.name"]', "change");
    await set('[data-path="drugs.0.strength"]', "10mg"); await page.dispatchEvent('[data-path="drugs.0.strength"]', "change");
    assert.equal(await page.inputValue('[data-path="drugs.0.strength"]'), "10");
    assert.equal(await page.inputValue('[data-path="drugs.0.unit"]'), "mg");
    await set('[data-path="drugs.0.perDose"]', 2);
    assert.match(await checks(), /承認上限 10mg\/日 を超えています/);
    assert.doesNotMatch(await page.$eval("#calc0", (e) => e.innerText), /mgmg/);
  });

  await test("「痛い時」「眠れないとき」は頓服（回数）として扱う", async () => {
    const r = await page.evaluate(() => ["痛い時", "眠れないとき", "熱が出た時に", "分1 起床時", "朝食後"].map(isCountUsage));
    assert.deepEqual(r, [true, true, true, false, false]);
  });

  await test("点鼻・点眼・シロップ・軟膏・坐剤などは名前から購送できないと知らせる", async () => {
    const r = await page.evaluate(() => ["ナゾネックス点鼻液", "ヒアレイン点眼液", "ムコダインシロップ", "リンデロン軟膏", "ボルタレン坐剤", "インスリン注射", "アムロジピン錠", "モーラステープ", "レルベアエリプタ"].map((n) => notPurchasableByName(n)));
    assert.deepEqual(r.map(Boolean), [true, true, true, true, true, true, false, false, false]);
  });

  await test("補足の「朝2錠、夕1錠」を知らせ、ボタンで不均等に入れられる", async () => {
    await page.click("[data-page=edit]");
    await page.evaluate(() => { state.doc = newDoc(); state.doc.diagnoses = "2型糖尿病"; render(); });
    await set('[data-path="drugs.0.name"]', "メトホルミン"); await page.dispatchEvent('[data-path="drugs.0.name"]', "change");
    await set('[data-path="drugs.0.strength"]', 500);
    await page.selectOption('[data-usage-pick="0"]', "分2 朝夕食後");
    await set('[data-path="drugs.0.note"]', "朝2錠、夕1錠"); await page.dispatchEvent('[data-path="drugs.0.note"]', "change");
    assert.match(await checks(), /補足に時間帯ごとの量/);
    await page.click("[data-note-uneven]");
    const r = await page.evaluate(() => ({ uneven: state.doc.drugs[0].uneven, doses: state.doc.drugs[0].doses, note: state.doc.drugs[0].note, order: orderText(state.doc.drugs[0]) }));
    assert.equal(r.uneven, true);
    assert.deepEqual(r.doses, { 朝: 2, 夕: 1 });
    assert.equal(r.note, "");
    assert.match(r.order, /1日3錠（朝2錠・夕1錠）/);
    assert.doesNotMatch(await checks(), /補足に時間帯ごとの量/);
  });

  await test("医師名が未設定なら、作成画面の上で「設定」に案内する", async () => {
    await page.evaluate(() => { state.settings.doctorName = ""; render(); });
    assert.equal(await page.isVisible("#openSettings"), true);
    await page.click("#openSettings");
    assert.equal(await page.isVisible("#sDoctor"), true);
    await page.fill("#sDoctor", "試験 医務官"); await page.click("#sSave");
    await page.click("[data-page=edit]");
    assert.equal(await page.isVisible("#openSettings"), false);
  });

  await test("頓服は用法（発熱時・痛い時）も保険適応の手がかりにする", async () => {
    const msgs = await page.evaluate(() => runChecks(normalizeDoc({ ...newDoc(), diagnoses: "気管支喘息",
      drugs: [{ ...newDrugRow(10), name: "カロナール", strength: "200", usage: "発熱時" }, { ...newDrugRow(10), name: "ロキソニン", strength: "60", usage: "痛い時" }] })).map((c) => c.msg).join("\n"));
    assert.doesNotMatch(msgs, /保険適応の病名が見当たりません/);
  });

  await test("μgで書いた規格をマスタの単位（mg）に換算して比べる（メコバラミン500μg）", async () => {
    const msgs = await page.evaluate(() => runChecks(normalizeDoc({ ...newDoc(), diagnoses: "末梢性神経障害",
      drugs: [{ ...newDrugRow(30), name: "メチコバール", strength: "500μg", usage: "分3 毎食後", times: 3 }] })).map((c) => c.msg).join("\n"));
    assert.doesNotMatch(msgs, /規格はマスタ上ありません|承認上限/);
    const over = await page.evaluate(() => runChecks(normalizeDoc({ ...newDoc(), diagnoses: "末梢性神経障害",
      drugs: [{ ...newDrugRow(30), name: "メチコバール", strength: "500", unit: "μg", usage: "分3 毎食後", times: 3, perDose: 2 }] })).map((c) => c.msg).join("\n"));
    assert.match(over, /承認上限 1\.5mg\/日 を超えています/);
  });

  await test("移管で受け取った書類から新規作成すると、医師と所属公館を今の公館にする", async () => {
    const r = await page.evaluate(() => {
      Object.assign(state.settings, { doctorName: "今 医務官", doctorPost: "在ケニア日本国大使館" });
      const d = normalizeDoc({ ...newDoc(), id: "moved1", transferredFrom: { post: "在ブラジル日本国大使館" }, doctor: { name: "前任 医務官", post: "在ブラジル日本国大使館" } });
      d.patient = { ...d.patient, name: "移管 太郎", birth: "1970-01-01", rel: "本人", staffCode: "1", post: "在ブラジル日本国大使館", postCode: "" };
      commitCases((list) => { list.unshift(d); return list; });
      state.page = "list"; state.listQuery = "移管 太郎"; render();
      return true;
    });
    assert.ok(r);
    await page.click("details.patient [data-copy]");
    const c = await page.evaluate(() => ({ doctor: state.doc.doctor, post: state.doc.patient.post, code: state.doc.patient.postCode, moved: !!state.doc.transferredFrom }));
    assert.deepEqual(c.doctor, { name: "今 医務官", post: "在ケニア日本国大使館" });
    assert.equal(c.post, "在ケニア日本国大使館");
    assert.ok(c.code);
    assert.equal(c.moved, false);
    await page.evaluate(() => { state.listQuery = ""; });
  });

  await test("内服の抗がん剤（タモキシフェンなど）がマスタにあり、確認を促す", async () => {
    const r = await page.evaluate(() => {
      const d = normalizeDoc({ ...newDoc(), diagnoses: "乳がん術後", drugs: [{ ...newDrugRow(90), name: "ノルバデックス", strength: "20", usage: "分1 朝食後" }] });
      return { master: (findDrug("タモキシフェン錠") || {}).name, msgs: runChecks(d).map((c) => c.msg).join("\n") };
    });
    assert.equal(r.master, "タモキシフェン錠");
    assert.doesNotMatch(r.msgs, /薬剤マスタにありません|保険適応の病名が見当たりません/);
    assert.match(r.msgs, /抗がん剤・ホルモン療法薬です/);
  });

  await test("追加の薬剤マスタ（抗菌薬・パーキンソン病・配合錠・漢方など）を照合でき、メトトレキサートの毎日の用法を止める", async () => {
    const r = await page.evaluate(() => ({
      n: window.DRUG_MASTER.length,
      names: ["フロモックス", "ビ・シフロール", "ミカムロAP", "エクメットHD", "ツムラ19番", "ホクナリンテープ"].map((x) => (findDrug(x) || {}).name || null),
      daily: runChecks(normalizeDoc({ ...newDoc(), diagnoses: "関節リウマチ", drugs: [{ ...newDrugRow(28), name: "リウマトレックス", strength: "2", usage: "分2 朝夕食後", times: 2 }] })).map((c) => c.msg).join("\n"),
      weekly: runChecks(normalizeDoc({ ...newDoc(), diagnoses: "関節リウマチ", drugs: [{ ...newDrugRow(4), name: "リウマトレックス", strength: "2", usage: "週1回", perDose: 3 }] })).map((c) => c.msg).join("\n"),
    }));
    assert.ok(r.n >= 550, String(r.n));
    assert.ok(r.names.every(Boolean), JSON.stringify(r.names));
    assert.match(r.daily, /週に1〜2日だけ飲む薬です/);
    assert.doesNotMatch(r.weekly, /週に1〜2日だけ飲む薬です/);
  });

  await test("厚生労働省の医薬品マスターで商品名・規制区分・液剤を判定する", async () => {
    const r = await page.evaluate(() => {
      const msgs = (name, extra = {}) => runChecks(normalizeDoc({ ...newDoc(), diagnoses: "高血圧症", drugs: [{ ...newDrugRow(30), name, strength: "5", usage: "分1 朝食後", times: 1, ...extra }] })).map((c) => c.msg).join("\n");
      return {
        n: officialList().length,
        brand: (findDrug("ノルバスク錠５ｍｇ") || {}).name,
        generic: (findDrug("アムロジピンＯＤ錠５ｍｇ「トーワ」") || {}).name,
        narcotic: msgs("オキシコンチンＴＲ錠５ｍｇ"),
        psych: msgs("デパス錠０．５ｍｇ"),
        notPsych: msgs("ルネスタ錠２ｍｇ"),
        liquid: msgs("ムコダインシロップ５％"),
        unknown: msgs("アムロジピソ錠"),
      };
    });
    assert.ok(r.n > 10000, String(r.n));
    assert.equal(r.brand, "アムロジピン錠");
    assert.equal(r.generic, "アムロジピン錠");
    assert.match(r.narcotic, /麻薬/);
    assert.match(r.psych, /本省の許可/);
    assert.doesNotMatch(r.notPsych, /本省の許可/);
    assert.match(r.liquid, /液体/);
    assert.match(r.unknown, /医薬品マスター（.*）にもない名前です/);
  });

  await test("貼り薬を同じ成分の飲み薬と取り違えない・枚数の上限・週1回の糖尿病薬", async () => {
    const r = await page.evaluate(() => {
      const msgs = (diag, row) => runChecks(normalizeDoc({ ...newDoc(), diagnoses: diag, drugs: [{ ...newDrugRow(30), ...row }] })).map((c) => c.msg).join("\n");
      return {
        tape: (findDrug("ロキソニンテープ100mg") || {}).name,
        tab: (findDrug("ロキソニン錠60mg") || {}).name,
        tapeMsgs: msgs("腰痛症", { name: "ロキソニンテープ100mg", strength: "100", unit: "mg", form: "貼付剤", usage: "分1", times: 1, perDose: 1 }),
        loqoa: msgs("変形性関節症", { name: "ロコアテープ", form: "貼付剤", usage: "分1", times: 1, perDose: 3 }),
        zafatek: msgs("2型糖尿病", { name: "ザファテック錠100mg", strength: "100", usage: "分1 朝食後", times: 1, perDose: 1 }),
      };
    });
    assert.equal(r.tape, "ロキソプロフェンナトリウムテープ");
    assert.equal(r.tab, "ロキソプロフェンナトリウム錠");
    assert.doesNotMatch(r.tapeMsgs, /規格はマスタ上ありません|承認上限/);
    assert.match(r.loqoa, /承認上限 2枚\/日/);
    assert.match(r.zafatek, /週1回飲む薬です/);
  });

  await test("小児：ドライシロップは粉の薬として通し、細粒・DSを錠剤の規格で照合しない。ADHDの言い換え", async () => {
    const r = await page.evaluate(() => {
      const msgs = (diag, row, birth = "2018-04-01") => runChecks(normalizeDoc({ ...newDoc(), patient: { ...newDoc().patient, birth }, diagnoses: diag, drugs: [{ ...newDrugRow(30), ...row }] })).map((c) => c.msg).join("\n");
      return {
        ds: msgs("アレルギー性鼻炎", { name: "アレグラドライシロップ5%", strength: "30", unit: "mg", form: "散・顆粒", usage: "分2 朝夕食後", times: 2, perDose: 1 }),
        syrup: msgs("アレルギー性鼻炎", { name: "ザイザルシロップ0.05%", usage: "分2 朝夕食後", times: 2, perDose: 5 }),
        granule: msgs("気管支喘息", { name: "キプレス細粒4mg", strength: "4", unit: "mg", form: "散・顆粒", usage: "分1 就寝前", times: 1, perDose: 1 }),
        tab: msgs("気管支喘息", { name: "キプレス錠", strength: "4", unit: "mg", usage: "分1 就寝前", times: 1, perDose: 1 }),
        adhd: indicationMatches(["注意欠陥・多動性障害", "ADHD"], "注意欠如・多動症"),
      };
    });
    assert.doesNotMatch(r.ds, /シロップ（液体）/);
    assert.match(r.syrup, /液体/);
    assert.doesNotMatch(r.granule, /規格はマスタ上ありません/);
    assert.match(r.granule, /散・顆粒（細粒・ドライシロップ）は、マスタの規格/);
    assert.match(r.tab, /規格はマスタ上ありません/);
    assert.equal(r.adhd, true);
    // 画面から入れても、細粒は「散・顆粒」になり、規格のエラーが出ない
    await page.click('#tabs button[data-page="edit"]');
    await set('[data-path="drugs.0.name"]', "キプレス細粒４ｍｇ"); await page.dispatchEvent('[data-path="drugs.0.name"]', "change"); await page.waitForTimeout(100);
    assert.equal(await page.inputValue('[data-path="drugs.0.form"]'), "散・顆粒");
    assert.doesNotMatch(await checks(), /キプレス細粒４ｍｇ.*規格はマスタ上ありません/);
  });

  await test("精神科：徐放錠を普通の錠剤の規格で照合しない・漢方の名前の頭だけでも照合する", async () => {
    const r = await page.evaluate(() => {
      const msgs = (row) => runChecks(normalizeDoc({ ...newDoc(), diagnoses: "パニック障害", drugs: [{ ...newDrugRow(30), usage: "分1 夕食後", times: 1, perDose: 1, ...row }] })).map((c) => c.msg).join("\n");
      return {
        cr: msgs({ name: "パキシルCR錠12.5mg", strength: "12.5", unit: "mg" }),
        ir: msgs({ name: "パキシル錠", strength: "12.5", unit: "mg" }),
        yokukan: (findDrug("抑肝散") || {}).name,
        depakeneR: (findDrug("デパケンR錠200mg") || {}).name,
      };
    });
    assert.doesNotMatch(r.cr, /規格はマスタ上ありません/);
    assert.match(r.ir, /規格はマスタ上ありません/);
    assert.equal(r.yokukan, "抑肝散エキス顆粒");
    assert.equal(r.depakeneR, "バルプロ酸ナトリウム徐放錠");
  });

  await test("小児の体重あたりの目安・兼轄の公館の登録・徐放錠とミニリンメルトのマスタ", async () => {
    const r = await page.evaluate(() => {
      const msgs = (patient, row) => runChecks(normalizeDoc({ ...newDoc(), patient: { ...newDoc().patient, ...patient }, diagnoses: "発熱", drugs: [{ ...newDrugRow(5), ...row }] })).map((c) => c.msg).join("\n");
      const kid = { name: "カロナール細粒20%", strength: "300", unit: "mg", form: "散・顆粒", usage: "分4", times: 4, perDose: 1 };
      const before = state.settings.kenkatsu;
      const k1 = msgs({ post: "在ブルキナファソ大使館" }, { name: "アムロジピン錠", strength: "5", unit: "mg", usage: "分1 朝食後", times: 1, perDose: 1 });
      state.settings.kenkatsu = "在ブルキナファソ大使館";
      const k2 = msgs({ post: "在ブルキナファソ日本国大使館" }, { name: "アムロジピン錠", strength: "5", unit: "mg", usage: "分1 朝食後", times: 1, perDose: 1 });
      state.settings.kenkatsu = before;
      return {
        over: msgs({ birth: "2020-01-01", weight: "18" }, kid),
        noWeight: msgs({ birth: "2020-01-01", weight: "" }, kid),
        adult: msgs({ birth: "1980-01-01", weight: "18" }, kid),
        k1, k2,
        names: ["パキシルCR錠12.5mg", "ミニリンメルトOD錠120μg", "アダラートL錠10mg", "アダラートCR錠20mg"].map((n) => (findDrug(n) || {}).name),
      };
    });
    assert.match(r.over, /体重18kgでは、小児の1日量の目安（60mg\/kg\/日＝1080mg）を超えています/);
    assert.match(r.noWeight, /「体重」を入れると/);
    assert.doesNotMatch(r.adult, /体重18kgでは/);
    assert.match(r.k1, /所属.*が異なります/);
    assert.doesNotMatch(r.k2, /所属.*が異なります/);
    assert.deepEqual(r.names, ["パロキセチン徐放錠", "デスモプレシン酢酸塩水和物口腔内崩壊錠", "ニフェジピン徐放錠（12時間持続）", "ニフェジピンCR錠"]);
    assert.equal(await page.isVisible('[data-path="patient.weight"]'), true);
    assert.match(await page.$eval("#main", (e) => e.innerText), /医務官氏名は診断書・指示書には印刷しません/);
  });

  await test("皮膚科：液体・注射のエラーを重ねない、所属公館「タイ」をリストの書き方にそろえる", async () => {
    const r = await page.evaluate(() => {
      const msgs = (row) => runChecks(normalizeDoc({ ...newDoc(), diagnoses: "蕁麻疹", drugs: [{ ...newDrugRow(14), usage: "分1 就寝前", times: 1, perDose: 1, ...row }] })).map((c) => c.msg);
      return { syrup: msgs({ name: "ザイザルシロップ0.05%" }), inj: msgs({ name: "デュピクセント皮下注300mgペン", usage: "2週に1回" }) };
    });
    assert.equal(r.syrup.filter((m) => /液体/.test(m)).length, 1, r.syrup.join("\n"));
    assert.ok(r.inj.some((m) => /注射薬/.test(m)));
    assert.ok(!r.inj.some((m) => /にもない名前です/.test(m)), r.inj.join("\n"));
    await page.click('#tabs button[data-page="edit"]');
    await set('[data-path="patient.post"]', "タイ"); await page.dispatchEvent('[data-path="patient.post"]', "change"); await page.waitForTimeout(100);
    assert.equal(await page.inputValue('[data-path="patient.post"]'), "在タイ日本国大使館");
    assert.equal(await page.inputValue('[data-path="patient.postCode"]'), "612A");
  });

  await test("整形外科：慢性腰痛と慢性疼痛、頓服の補足に回数があれば注意しない、診断書で規格を重ねない", async () => {
    const r = await page.evaluate(() => {
      const msgs = (diag, row) => runChecks(normalizeDoc({ ...newDoc(), diagnoses: diag, drugs: [{ ...newDrugRow(28), ...row }] })).map((c) => c.msg).join("\n");
      return {
        tram: msgs("慢性腰痛症", { name: "トラムセット配合錠", usage: "分4", times: 4, perDose: 2 }),
        prn: msgs("坐骨神経痛", { name: "ロキソニン錠60mg", strength: "60", unit: "mg", usage: "頓服 疼痛時", times: 1, perDose: 1, days: 20, note: "1日3回まで" }),
        prn2: msgs("坐骨神経痛", { name: "ロキソニン錠60mg", strength: "60", unit: "mg", usage: "頓服 疼痛時", times: 1, perDose: 1, days: 20 }),
        dup: nameHasStrength({ name: "セレコックス錠100mg", strength: "100", unit: "mg" }),
        noDup: nameHasStrength({ name: "セロクエル25mg錠", strength: "5", unit: "mg" }),
      };
    });
    assert.doesNotMatch(r.tram, /保険適応の病名が見当たりません/);
    assert.doesNotMatch(r.prn, /最大回数を指示/);
    assert.match(r.prn2, /最大回数を指示/);
    assert.equal(r.dup, true);
    assert.equal(r.noDup, false);
  });

  await test("産婦人科：「2日に1回」は回数で数える、レルミナは子宮内膜症も適応", async () => {
    const r = await page.evaluate(() => {
      const msgs = (diag, row) => runChecks(normalizeDoc({ ...newDoc(), diagnoses: diag, drugs: [{ ...newDrugRow(45), ...row }] })).map((c) => c.msg).join("\n");
      return {
        count: isCountUsage("2日に1回"), every3: isCountUsage("3日ごとに貼り替え"), daily: isCountUsage("分1 朝食後"),
        patch: msgs("更年期障害", { name: "エストラーナテープ0.72mg", strength: "0.72", unit: "mg", form: "貼付剤", usage: "2日に1回", times: 1, perDose: 1 }),
        relu: msgs("子宮内膜症", { name: "レルミナ錠40mg", strength: "40", unit: "mg", usage: "分1 朝食前", times: 1, perDose: 1 }),
      };
    });
    assert.equal(r.count, true); assert.equal(r.every3, true); assert.equal(r.daily, false);
    assert.doesNotMatch(r.patch, /1日の回数が分かりません/);
    assert.doesNotMatch(r.relu, /保険適応の病名が見当たりません/);
  });

  await test("眼科：麦粒腫などの眼の感染症を抗菌薬の適応と認める、点眼薬・眼軟膏は止める", async () => {
    const r = await page.evaluate(() => {
      const msgs = (diag, row) => runChecks(normalizeDoc({ ...newDoc(), diagnoses: diag, drugs: [{ ...newDrugRow(5), ...row }] })).map((c) => c.msg).join("\n");
      return {
        sty: msgs("麦粒腫", { name: "セフゾンカプセル100mg", strength: "100", unit: "mg", form: "カプセル", usage: "分3 毎食後", times: 3, perDose: 1 }),
        drop: msgs("緑内障", { name: "キサラタン点眼液0.005%", usage: "1日1回 就寝前", times: 1, perDose: 1 }),
        oint: msgs("帯状疱疹", { name: "ゾビラックス眼軟膏3%", usage: "1日5回", times: 5, perDose: 1 }),
      };
    });
    assert.doesNotMatch(r.sty, /保険適応の病名が見当たりません/);
    assert.match(r.drop, /点眼薬/);
    assert.match(r.oint, /塗り薬/);
    assert.equal(await page.evaluate(() => findDrug("ゾビラックス眼軟膏3%")), null);
  });

  await test("耳鼻咽喉科：名前に「細粒」とあればカプセルにしない、兼轄の公館は国名だけでも、設定の医師名を作成中の書類に入れる", async () => {
    await fresh();
    await page.click('#tabs button[data-page="edit"]');
    await set('[data-path="drugs.0.name"]', "サワシリン細粒10%"); await page.dispatchEvent('[data-path="drugs.0.name"]', "change"); await page.waitForTimeout(100);
    assert.equal(await page.inputValue('[data-path="drugs.0.form"]'), "散・顆粒");
    assert.doesNotMatch(await checks(), /アモキシシリンカプセルに.*規格はマスタ上ありません/);
    const r = await page.evaluate(() => ({
      cap: formFromName("サワシリンカプセル250"), tab: formFromName("アレグラ錠60mg"), ds: formFromName("クラリスドライシロップ10%小児用"), none: formFromName("きぷれす"),
    }));
    assert.deepEqual(r, { cap: "カプセル", tab: "錠", ds: "散・顆粒", none: null });
    await page.click("[data-page=settings]");
    await page.fill("#sDoctor", "試験 鼓"); await page.fill("#sPost", "フィジー"); await page.fill("#sKenkatsu", "トンガ\nキリバス"); await page.click("#sSave");
    await page.click('#tabs button[data-page="edit"]'); await page.waitForTimeout(100);
    const doc = await page.evaluate(() => state.doc.doctor);
    assert.equal(doc.name, "試験 鼓"); assert.equal(doc.post, "在フィジー日本国大使館");
    await set('[data-path="patient.post"]', "トンガ"); await page.dispatchEvent('[data-path="patient.post"]', "change"); await page.waitForTimeout(100);
    assert.doesNotMatch(await checks(), /所属.*が異なります/);
    await set('[data-path="patient.post"]', "サモア"); await page.dispatchEvent('[data-path="patient.post"]', "change"); await page.waitForTimeout(100);
    assert.match(await checks(), /所属.*が異なります/);
  });

  await test("救急科：エピペンは注射薬、メプチンエアー・インヘラーはガスを使う吸入薬として止める（飲み薬のマスタに結びつけない）、フリガナはカタカナにそろえる", async () => {
    await fresh();
    const r = await page.evaluate(() => {
      const msgs = (row) => runChecks(normalizeDoc({ ...newDoc(), diagnoses: "気管支喘息", drugs: [{ ...newDrugRow(5), usage: "発作時", times: 1, perDose: 1, ...row }] })).map((c) => c.msg).join("\n");
      return {
        epi: notPurchasableByName("エピペン注射液0.3mg"), mdi: notPurchasableByName("メプチンエアー10μg吸入100回"), inh: notPurchasableByName("サルタノールインヘラー100μg"),
        dpi: notPurchasableByName("シムビコートタービュヘイラー30吸入"), disk: notPurchasableByName("アドエア250ディスカス"),
        meptin: findDrug("メプチンエアー10μg吸入100回"), msg: msgs({ name: "メプチンエアー10μg吸入100回" }),
      };
    });
    assert.equal(r.epi, "注射薬"); assert.equal(r.mdi, "ガスを使う吸入薬"); assert.equal(r.inh, "ガスを使う吸入薬");
    assert.equal(r.dpi, null); assert.equal(r.disk, null);
    assert.equal(r.meptin, null);
    assert.match(r.msg, /ガスを使う吸入薬/);
    await page.click('#tabs button[data-page="edit"]');
    await set('[data-path="patient.kana"]', "しけん ﾊｼﾙ"); await page.dispatchEvent('[data-path="patient.kana"]', "change");
    assert.equal(await page.inputValue('[data-path="patient.kana"]'), "シケン ハシル");
  });

  await test("発行日は作成画面の一番上（最初のカード）にある", async () => {
    await fresh();
    await page.click('#tabs button[data-page="edit"]');
    const first = await page.$eval("#form section.card", (e) => e.innerText);
    assert.match(first, /発行（最初に入力）/);
    assert.match(first, /★発行日/);
    assert.equal(await page.$eval('#form section.card [data-path="issueDate"]', (e) => e.type), "date");
  });

  await test("画面のエラーが出ていない", async () => { assert.deepEqual(errors, []); });

  await browser.close();
  server.close();
  for (const [r, n] of results) console.log(r + n);
  const ng = results.filter(([r]) => r.startsWith("NG")).length;
  console.log(ng ? `\n${ng}件 失敗` : `\nすべて成功（${results.length}件）`);
  process.exit(ng ? 1 : 0);
})();
