// node aggregate.js <runフォルダ> — run_sim.js の結果（束ごとの result.json）をまとめて、項目ごとの正答率と誤りの例を出す
const fs = require("fs"), path = require("path");
const dir = process.argv[2];
const T = {}; let batches = 0, persons = 0, pairs = [0, 0], types = [0, 0], sec = 0;
const ex = {};
for (const b of fs.readdirSync(dir).sort()) {
  const f = path.join(dir, b, "result.json"); if (!fs.existsSync(f)) continue;
  const { report } = JSON.parse(fs.readFileSync(f, "utf8"));
  batches++; persons += report.persons; sec += report.sec;
  const [po, pn] = (report.分割 || "").match(/\d+/) ? [parseInt(report.分割), 100] : [0, 0]; pairs[0] += po; pairs[1] += pn;
  types[0] += parseInt(report.書類の種類) || 0; types[1] += 100;
  for (const [k, v] of Object.entries(report.項目)) {
    const m = v.match(/\((\d+)\/(\d+)\)/); if (!m) continue;
    const t = T[k] ||= [0, 0]; t[0] += +m[1]; t[1] += +m[2];
    const e = v.split("誤: ")[1]; if (e && (ex[k] ||= []).length < 12) ex[k].push(`${b}: ${e}`);
  }
  if ((report.分割の誤り || []).length && (ex["分割"] ||= []).length < 12) ex["分割"].push(`${b}: ${report.分割の誤り.slice(0, 2).join(" / ")}`);
}
console.log(`束 ${batches}（${persons}人）、読み取り時間 計${Math.round(sec / 60)}分`);
console.log(`書類の種類 平均${(types[0] / Math.max(batches, 1)).toFixed(1)}%、分割 平均${(pairs[0] / Math.max(batches, 1)).toFixed(1)}%`);
for (const [k, [ok, n]] of Object.entries(T)) console.log(`${(100 * ok / n).toFixed(1).padStart(5)}%  ${k}（${ok}/${n}）`);
if (process.argv.includes("-v")) for (const [k, e] of Object.entries(ex)) { console.log(`\n■ ${k}`); e.forEach(x => console.log("  " + x.slice(0, 300))); }
