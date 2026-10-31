// 100人の医務官が使ったと想定した模擬（医務官1人＝別のブラウザ＝別のPC）
//   正しい処方に出る「要確認」の割合（誤った指摘）、わざと入れた誤りの見逃し、印刷が1枚に収まるかを数える。
//   使い方（リポジトリのルートで）：npm install --no-save playwright のあと node shindansho/tests/sim100.cjs
//   Chromium の場所を指定する場合：CHROMIUM_PATH=/path/to/chromium node shindansho/tests/sim100.cjs
//   ※ 発行日は2026年1〜10月の乱数なので、実行日によっては「有効期限切れ」の指摘も数に入る
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const ROOT = path.resolve(__dirname, "..", "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const serve = () => new Promise((ok) => {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  server.listen(0, () => ok(server));
});

const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'shindansho-sim100.json');
let URL0;

// 再現できる乱数
let seed = 20261031;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

// 現場で書かれそうな病名の言い方（薬の適応キーワードとの照合の当たり外れを見る）
const DIAG_VARIANTS = {
  '高血圧': ['高血圧症', '本態性高血圧症', '高血圧', 'HT', '高血圧症（本態性）'],
  '2型糖尿病': ['2型糖尿病', '糖尿病', 'DM', 'II型糖尿病', 'Ⅱ型糖尿病'],
  '高コレステロール血症': ['脂質異常症', '高LDLコレステロール血症', '高脂血症', '家族性高コレステロール血症', 'LDL高値'],
  '逆流性食道炎': ['逆流性食道炎', 'GERD', '胃食道逆流症', '逆食'],
  '不眠症': ['不眠症', '不眠', '入眠障害', '睡眠障害'],
  'うつ病': ['うつ病', 'うつ状態', '抑うつ', '適応障害'],
  'アレルギー性鼻炎': ['アレルギー性鼻炎', '花粉症', '通年性アレルギー性鼻炎', 'AR'],
  '甲状腺機能低下症': ['甲状腺機能低下症', '橋本病', '慢性甲状腺炎'],
  '痛風': ['高尿酸血症', '痛風', 'HUA'],
  '前立腺肥大症': ['前立腺肥大症', 'BPH', '前立腺肥大'],
  '片頭痛': ['片頭痛', '偏頭痛', '頭痛'],
  '月経困難症': ['月経困難症', '機能性月経困難症', '子宮内膜症'],
};

(async () => {
  const server = await serve();
  URL0 = `http://localhost:${server.address().port}/shindansho/`;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const issues = [];   // 見つかった問題（種類ごとに数える）
  const note = (kind, detail) => issues.push({ kind, detail });
  const stats = { officers: 0, patients: 0, docs: 0, intended_ok: 0, flagged_ok: 0, injected: 0, caught: 0, prints: 0, overflow: 0, msgs: {} };
  const missed = [];
  const fpExamples = {};
  const storage = [];
  let jsErrors = [];

  for (let o = 0; o < 100; o++) {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());
    page.on('pageerror', (e) => jsErrors.push(`医務官${o + 1}: ${e.message}`));
    await page.goto(URL0);
    stats.officers++;
    // 医務官の設定（1/4 は設定をしないまま使う）
    const setup = await page.evaluate((o) => {
      const posts = window.POST_CODES;
      const [code, name] = posts[(o * 37) % posts.length];
      return { code, name };
    }, o);
    const configured = o % 4 !== 0;
    const nPatients = 1 + Math.floor(rnd() * 8);
    const plan = [];
    for (let p = 0; p < nPatients; p++) {
      const child = chance(0.15);
      const rel = child ? '子' : pick(['本人', '本人', '配偶者', '本人']);
      const year = child ? 2012 + Math.floor(rnd() * 12) : 1960 + Math.floor(rnd() * 40);
      const nDocs = 1 + Math.floor(rnd() * 3);
      // その患者の慢性疾患（1〜3）
      const keys = Object.keys(DIAG_VARIANTS);
      const ds = [...new Set([pick(keys), ...(chance(0.6) ? [pick(keys)] : []), ...(chance(0.3) ? [pick(keys)] : [])])];
      plan.push({ child, rel, birth: `${year}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`, ds, nDocs, staff: String(10000 + o * 10 + (rel === '本人' ? p : 0)) });
    }
    const res = await page.evaluate(async ({ plan, setup, configured, o, seedBase, DIAG_VARIANTS }) => {
      let s = seedBase; const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
      const pk = (a) => a[Math.floor(r() * a.length)];
      const out = { docs: [], prints: [] };
      if (configured) Object.assign(state.settings, { doctorName: `医務官${o + 1}`, doctorPost: `在${setup.name.replace(/^在/, '')}` });
      const master = window.DRUG_MASTER;
      for (const [pi, pt] of plan.entries()) {
        for (let k = 0; k < pt.nDocs; k++) {
          const d = newDoc();
          Object.assign(d.patient, { name: `患者${o + 1}-${pi + 1}`, kana: `かんじゃ${o + 1}の${pi + 1}`, birth: pt.birth, rel: pt.rel, staffCode: pt.staff,
            post: setup.name, postCode: r() < 0.9 ? setup.code : '' });
          d.doctor = { name: `医務官${o + 1}`, post: r() < 0.85 ? setup.name : '在タイ日本国大使館' }; // 15% は兼轄など
          d.issueDate = `2026-${String(1 + Math.floor(r() * 10)).padStart(2, '0')}-${String(1 + Math.floor(r() * 27)).padStart(2, '0')}`;
          const diagWords = pt.ds.map((x) => pk(DIAG_VARIANTS[x]));
          d.diagnoses = diagWords.join('\n');
          // 病名に合う薬を選ぶ（＝本来は指摘されるべきでない処方）
          const drugs = [];
          for (const dx of pt.ds) {
            const cands = master.filter((m) => (m.ind || []).some((i) => i.includes(dx) || dx.includes(i)) && !m.psych);
            if (!cands.length) continue;
            const n = 1 + Math.floor(r() * 2);
            for (let j = 0; j < n; j++) {
              const m = pk(cands);
              const st = m.strengths.length ? pk(m.strengths) : '';
              const usage = m.cycle28 ? '分1 夕食後' : pk(['分1 朝食後', '分1 夕食後', '分2 朝夕食後', '分1 就寝前', '分3 毎食後']);
              const times = timesOf(usage);
              let perDose = 1;
              if (m.max && st) while (perDose > 0.5 && perDose * st * times > m.max) perDose = perDose / 2;
              const days = m.cycle28 ? 84 : m.limit ? Math.min(m.limit, 30) : pk([30, 30, 60, 90]);
              drugs.push({ ...newDrugRow(days), name: r() < 0.15 && m.brand ? m.brand.split('／')[0] : m.name, strength: String(st), unit: m.unit === '錠' ? '' : m.unit, form: formOf(m), perDose, usage, times });
            }
          }
          if (!drugs.length) continue;
          d.drugs = drugs.slice(0, 10);
          // 15% にわざと誤りを入れる（見逃しがないか）
          let injected = null;
          if (r() < 0.15) {
            const t = pk(['overdose', 'wrongStrength', 'banned', 'noUsage', 'noDays', 'cycle']);
            const x = d.drugs[0];
            if (t === 'overdose') { x.perDose = 4; x.usage = '分3 毎食後'; x.times = 3; }
            if (t === 'wrongStrength') x.strength = '7';
            if (t === 'banned') d.drugs.push({ ...newDrugRow(30), name: 'オキシコンチン錠', strength: '5', unit: 'mg' });
            if (t === 'noUsage') x.usage = '';
            if (t === 'noDays') x.days = '';
            if (t === 'cycle') { d.drugs.push({ ...newDrugRow(100), name: 'ドロスピレノン・エチニルエストラジオール錠', unit: '', usage: '分1 夕食後', times: 1 }); }
            injected = t;
          }
          normalizeDoc(d);
          const checks = runChecks(d);
          state.doc = d; saveDoc(false);
          out.docs.push({ injected, child: pt.child, diag: diagWords, checks: checks.map((c) => ({ level: c.level, where: c.where, msg: c.msg })) });
        }
      }
      return out;
    }, { plan, setup, configured, o, seedBase: 1000 + o, DIAG_VARIANTS });

    // 印刷：全部の書類で、診断書・指示書がそれぞれA4 1枚に収まるか
    await page.emulateMedia({ media: 'print' });
    await page.setViewportSize({ width: 680, height: 1000 }); // A4 から左右余白 15mm を除いた幅（180mm ≒ 680px）
    const heights = await page.evaluate(() => state.cases.map((c) => {
      const box = document.getElementById('print');
      box.innerHTML = shindanHtml(normalizeDoc(JSON.parse(JSON.stringify(c)))) + shijiHtml(normalizeDoc(JSON.parse(JSON.stringify(c))));
      return [...box.querySelectorAll('.sheet')].map((s) => s.scrollHeight);
    }));
    const LIMIT = Math.round((297 - 38) * 96 / 25.4); // 上下余白を除いたA4の高さ（px）
    heights.forEach((hs, i) => { stats.prints++; hs.forEach((h, j) => { if (h > LIMIT) { stats.overflow++; note('印刷が1枚に収まらない', `医務官${o + 1} 書類${i + 1} ${j ? '指示書' : '診断書'} ${h}px > ${LIMIT}px`); } }); });
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize({ width: 1300, height: 1000 });

    for (const d of res.docs) {
      stats.docs++;
      for (const c of d.checks) {
        const k = `${c.level}｜${c.msg.replace(/[0-9０-９.]+/g, '#').replace(/（.*?）/g, '').slice(0, 40)}`;
        stats.msgs[k] = (stats.msgs[k] || 0) + 1;
      }
      const errs = d.checks.filter((c) => c.level === 'error');
      const real = d.checks.filter((c) => c.level !== 'minor' && c.where !== '入力' && c.where !== '署名');
      if (!d.injected) {
        stats.intended_ok++;
        if (real.length) {
          stats.flagged_ok++;
          for (const c of real) { const k = c.msg.slice(0, 30); (fpExamples[k] = fpExamples[k] || []).push(`${d.diag.join('、')} → ${c.where}`); }
        }
      } else {
        stats.injected++;
        const hit = d.checks.some((c) => c.level !== 'minor' && c.where.startsWith('処方'));
        if (hit) stats.caught++; else missed.push(`${d.injected}: ${JSON.stringify(d.checks.map((c) => c.msg.slice(0, 30)))}`);
      }
    }
    const size = await page.evaluate(() => (localStorage.getItem('shindansho.cases') || '').length);
    storage.push({ o: o + 1, docs: res.docs.length, chars: size });
    stats.patients += plan.length;
    await ctx.close();
  }

  const report = { stats, missed, fpTop: Object.entries(fpExamples).map(([k, v]) => [k, v.length, v.slice(0, 4)]).sort((a, b) => b[1] - a[1]).slice(0, 15),
    msgTop: Object.entries(stats.msgs).sort((a, b) => b[1] - a[1]).slice(0, 25), issues: Object.entries(issues.reduce((a, x) => ((a[x.kind] = a[x.kind] || []).push(x.detail), a), {})).map(([k, v]) => [k, v.length, v.slice(0, 5)]),
    jsErrors: jsErrors.slice(0, 10), storage: { maxChars: Math.max(...storage.map((s) => s.chars)), perDoc: Math.round(storage.reduce((a, s) => a + s.chars, 0) / storage.reduce((a, s) => a + s.docs, 0)) } };
  delete report.stats.msgs;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  const ind = report.msgTop.filter(([k]) => k.includes('保険適応の病名')).reduce((a, [, v]) => a + v, 0);
  console.log(`医務官 ${report.stats.officers}人・患者 ${report.stats.patients}人・書類 ${report.stats.docs}件`);
  console.log(`わざと入れた誤りの検出：${report.stats.caught}/${report.stats.injected}`);
  console.log(`保険適応の照合で出た指摘：${ind}件`);
  console.log(`印刷が1枚に収まらない書類：${report.stats.overflow}件（A4で測定）`);
  console.log(`画面のエラー：${report.jsErrors.length}件`);
  console.log(`詳しい結果：${OUT}`);
  await browser.close();
  server.close();
})();
