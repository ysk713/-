// node run_sim.js <batchフォルダ> <port> — Web版でOCR分割と項目の読み取りを行い、正解（truth.json）と比べて正答率を出す
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const nz = s => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
const digits = s => nz(s).replace(/^[Aa]/, "").replace(/\D/g, "").replace(/^0+/, "");
(async () => {
  const [dir, port] = process.argv.slice(2);
  const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8"));
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/kousou/index.html`);
  await p.setInputFiles("#fileIn", path.join(dir, "batch.pdf"));
  await p.waitForFunction(() => /読込完了/.test(document.querySelector("#status").textContent), null, { timeout: 120000 });
  const t0 = Date.now();
  await p.evaluate(() => window.__kousou.splitByName());
  const res = await p.evaluate(async () => {
    const { S, groups, ocrCase } = window.__kousou;
    const G = groups();
    for (const g of G) await ocrCase(g.key);
    return { pages: S.pages.map(x => ({ type: x.type, gid: x.gid, names: x.ocrNames || [], blank: x.blank, rot: (S.ocrMeta[x.key] || {}).rotation, conf: (S.ocrMeta[x.key] || {}).confidence })),
      groups: groups().map(g => ({ key: g.key, idx: g.pages.map(x => S.pages.indexOf(x)), data: S.data[g.key] })) };
  });
  const sec = (Date.now() - t0) / 1000;
  await b.close();

  // 書類の種類
  let typeOk = 0, typeN = 0;
  truth.pages.forEach((t, i) => { if (t.type === "白紙") return; typeN++; if (res.pages[i].type === t.type) typeOk++; });
  // 分割：同じ人の書類が同じ組、違う人は別の組（ページの組ごとに判定）
  let pairOk = 0, pairN = 0; const wrong = [];
  for (let i = 0; i < truth.pages.length; i++) for (let j = i + 1; j < truth.pages.length; j++) {
    const a = truth.pages[i], c = truth.pages[j]; if (a.person < 0 || c.person < 0) continue;
    const same = a.person === c.person, got = res.pages[i].gid && res.pages[i].gid === res.pages[j].gid;
    pairN++; if (same === !!got) pairOk++; else wrong.push(`p${i + 1}(${a.person}${a.type})-p${j + 1}(${c.person}${c.type}) ${same ? "別の組に" : "同じ組に"}`);
  }
  // 項目：組 → 多数決で正解の人
  const F = {}; const add = (k, ok, got, want) => { (F[k] ||= { ok: 0, n: 0, miss: [] }).n++; if (ok) F[k].ok++; else F[k].miss.push(`${got}≠${want}`); };
  for (const g of res.groups) {
    const persons = g.idx.map(i => truth.pages[i].person).filter(x => x >= 0);
    if (!persons.length) continue;
    const who = persons.sort((x, y) => persons.filter(v => v === y).length - persons.filter(v => v === x).length)[0], t = truth.people[who], d = g.data;
    const hasType = ty => g.idx.some(i => truth.pages[i].type === ty && truth.pages[i].person === who);
    if (hasType("申込書")) {
      add("申込日", d.app.apply_date === t.apply, d.app.apply_date, t.apply);
      add("職員番号(申込書)", digits(d.app.staff_code) === digits(t.staff), d.app.staff_code, t.staff);
      add("公館名", nz(d.app.mission_name) === nz(t.mission), d.app.mission_name, t.mission);
      add("申込者氏名", nz(d.app.applicant_name) === nz(t.applicant), d.app.applicant_name, t.applicant);
      add("療養者氏名(申込書)", nz(d.app.patient_name) === nz(t.name), d.app.patient_name, t.name);
      add("同意チェック⑨の旧文言の検出", !!d.app.consent9_old_wording === !!t.oldConsent9, !!d.app.consent9_old_wording, !!t.oldConsent9);
    }
    if (hasType("診断書")) {
      add("発行日(診断書)", d.diag.issue_date === t.issue, d.diag.issue_date, t.issue);
      add("職員コード(診断書)", digits(d.diag.staff_code) === digits(t.staff), d.diag.staff_code, t.staff);
      add("氏名(診断書)", nz(d.diag.patient_name) === nz(t.name), d.diag.patient_name, t.name);
      add("病名", nz(d.diag.disease) === nz(t.diseases.join("、")), d.diag.disease, t.diseases.join("、"));
      add("氏名・コード欄の取り違えの検出", !!d.diag.name_code_swapped === !!t.swap, !!d.diag.name_code_swapped, !!t.swap);
    }
    if (hasType("指示書")) {
      add("発行日(指示書)", d.inst.issue_date === t.issue, d.inst.issue_date, t.issue);
      add("氏名(指示書)", nz(d.inst.patient_name) === nz(t.name), d.inst.patient_name, t.name);
      const got = d.drugs.map(x => `${nz(x.name).replace(/[0-9.]+(mg|μg)$/, "")}|${x.strength}|${x.inst}|${x.days}`).sort().join(" "), want = t.drugs.map(x => `${x.name}|${x.strength}|${x.perDay}|${t.days}`).sort().join(" ");
      add("薬剤（名前・含有量・1日量・日数）", got === want, got, want);
    }
  }
  const pct = (a, n) => n ? Math.round(100 * a / n) + "%" : "-";
  const report = { batch: dir, sec: Math.round(sec), pages: truth.pages.length, persons: truth.people.length, groups: res.groups.length,
    書類の種類: pct(typeOk, typeN), 分割: pct(pairOk, pairN), 分割の誤り: wrong.slice(0, 8),
    項目: Object.fromEntries(Object.entries(F).map(([k, v]) => [k, `${pct(v.ok, v.n)} (${v.ok}/${v.n})` + (v.miss.length ? "  誤: " + v.miss.slice(0, 3).join(" / ") : "")])),
    ページ: res.pages.map((x, i) => `p${i + 1} 正:${truth.pages[i].person}${truth.pages[i].type} 読:${x.type}[${x.names.join("/")}] 回転${x.rot ?? "-"} 信頼${x.conf ?? "-"}`), errs };
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ report, res }, null, 1));
  console.log(JSON.stringify(report, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
