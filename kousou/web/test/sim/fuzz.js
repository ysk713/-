// node web/test/sim/fuzz.js [件数=10000] [seed=1] [-v] — OCRの読み取り結果を模した文字（架空の人物）を大量に作り、
// 項目の読み取り（日付・職員番号・病名・薬）・人ごとの振り分け・保険適応の判定を確かめる。OCRそのものは通さない（高速に何千回も試すため）。
// 混ぜる読み違いは、実際の束で見つかったもの（喘→較、蕁→募、膵→膝、mg→msg、「錠」なし＋かっこ、月日の間の「_」、病名の折り返し、
// 指示書の生年月日、家族で同じ処方・名前が読めない申込書 など）。
const path = require("path"), fs = require("fs");
const O = require("../../src/ocr.js"), { Reviewer, CHECK, ERROR } = require("../../src/rules.js");
const DATA = path.join(__dirname, "../../../python/kousou");
const rules = JSON.parse(fs.readFileSync(path.join(DATA, "rules.json"), "utf8"));
const MASTER = JSON.parse(fs.readFileSync(path.join(DATA, "drug_master.json"), "utf8")).drugs;
const N = +(process.argv[2] || 10000), SEED = +(process.argv[3] || 1), VERBOSE = process.argv.includes("-v");

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const r = rng(SEED), pick = a => a[Math.floor(r() * a.length)], chance = p => r() < p;

// ---- 語彙（アプリと同じく薬品マスタから）
const drugNames = [...new Set(MASTER.flatMap(d => d.names.map(n => n.replace(/(錠|カプセル)$/, ""))))].filter(n => n.length >= 3);
const disVocab = [...new Set(MASTER.flatMap(d => (d.indications || []).filter(k => k.length >= 3)))];
const { Master } = require("../../src/rules.js"), MF = new Master(MASTER);   // アプリと同じ引き方
O.setVocab({ drugs: drugNames, drugsMaster: drugNames, diseases: disVocab, strengths: n => ((MF.find(n) || {}).strengths || []), unitOf: n => ((MF.find(n) || {}).unit || "") });
const isDrug = n => drugNames.some(d => n.includes(d) || (n.length >= 4 && d.includes(n)));
const rv = new Reviewer(rules, MASTER, "2026-11-20");

// ---- 架空の人物
const SURN = [["架空", "カクウ"], ["見本", "ミホン"], ["試験", "シケン"], ["仮名", "カメイ"], ["例題", "レイダイ"], ["模擬", "モギ"], ["検証", "ケンショウ"], ["参考", "サンコウ"]];
const GIVEN = [["一郎", "イチロウ"], ["花子", "ハナコ"], ["永彩", "トウア"], ["颯彩", "ソウア"], ["太郎", "タロウ"], ["美咲", "ミサキ"], ["健太", "ケンタ"], ["優子", "ユウコ"], ["翔", "ショウ"], ["真理", "マリ"], ["梓", "アズサ"], ["次郎", "ジロウ"]];
// 病名として書かれる語（適応の語そのものか、よくある書き方）
const DIS_FORM = { "高血圧": "高血圧症", "高コレステロール": "高コレステロール血症", "脂質異常": "脂質異常症", "高脂血": "高脂血症", "甲状腺機能低下": "甲状腺機能低下症",
  "逆流性食道炎": "逆流性食道炎", "気管支喘息": "気管支喘息", "喘息": "気管支喘息", "アレルギー性鼻炎": "アレルギー性鼻炎", "蕁麻疹": "慢性蕁麻疹", "慢性膵炎": "慢性膵炎",
  "前立腺肥大症": "前立腺肥大症", "過活動膀胱": "過活動膀胱", "高尿酸": "高尿酸血症", "痛風": "痛風", "胃潰瘍": "胃潰瘍", "片頭痛": "片頭痛", "うつ": "うつ病", "不眠": "不眠症" };
const drugPool = MASTER.filter(d => d.unit !== "吸入" && d.unit !== "錠" && (d.strengths || []).length && (d.indications || []).some(k => DIS_FORM[k]));

function person(base) {
  const sn = base ? base.sn : pick(SURN);
  let gn = pick(GIVEN); while (base && (base.used ||= new Set([base.gn[0]])).has(gn[0])) gn = pick(GIVEN);
  if (base) base.used.add(gn[0]);
  const drugs = base && chance(0.5) ? base.drugs : [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(drugPool)))].map(d => ({ d, st: pick(d.strengths) }));
  const dis = [...new Set(drugs.map(x => DIS_FORM[(x.d.indications || []).find(k => DIS_FORM[k])]))];
  const issueDay = 1 + Math.floor(r() * 15), applyDay = issueDay + Math.floor(r() * 9);
  return { sn, gn, used: null, name: sn[0] + gn[0], kana: sn[1] + gn[1], code: base ? base.code : String(10000 + Math.floor(r() * 89999)), drugs, dis,
    issue: `2026-11-${String(issueDay).padStart(2, "0")}`, apply: `2026-11-${String(applyDay).padStart(2, "0")}`,
    birth: `${pick([1965, 1978, 1990, 2014, 2021, 2024])}-${1 + Math.floor(r() * 12)}-${1 + Math.floor(r() * 28)}`, rel: base ? pick(["配偶者", "子", "長男", "次男"]) : "本人",
    applicant: base ? base.applicant : sn[0] + gn[0] };
}

// ---- 読み違いを混ぜる
const CONF = [["喘", "較"], ["蕁", "募"], ["膵", "膝"], ["錠", "鐘"], ["症", "病"], ["見", "晃"], ["彩", "影"], ["颯", "遇"], ["永", "水"], ["澤", "滞"]];
const noisy = (s, p = 0.15) => { let t = s; for (const [a, b] of CONF) if (t.includes(a) && chance(p)) t = t.replace(a, b); return t; };
const wareki = (iso, gap = false) => { const [y, m, d] = iso.split("-").map(Number); return `令和${y - 2018}年${m}月${gap ? " _ " : ""}${d}日`; };
const junk = () => pick(["", "", "| ", "ーー", "・", "[ "]);

function drugLine(i, x, fmt) {
  const name = x.d.names[x.d.names.length > 1 && chance(0.3) ? 1 : 0].replace(/(錠|カプセル)$/, ""), u = chance(0.15) ? x.d.unit.replace("mg", pick(["msg", "meg"])) : x.d.unit;
  if (fmt === 0) return `(${i}) ${noisy(name)}錠${x.st}${u} 1回1錠 1日1回 朝食後`;
  if (fmt === 1) return `(${i}) ${noisy(name)} (${x.st}${u}) 1回1錠 x 1日1回 (就寝前)`;
  return `(${i}) ${noisy(name)}錠 ${x.st}${u}/T 1T 1X 朝食後 1T`;
}
function diseaseText(dis) {
  let s = dis.map(d => noisy(d, 0.25)).join("、");
  if (chance(0.15)) s = "再発・再燃を繰り返す" + s;
  if (s.length > 8 && chance(0.25)) { const k = 3 + Math.floor(r() * (s.length - 4)); s = s.slice(0, k) + "\n" + s.slice(k); }
  return s;
}
function texts(p, blankApplicant, unreadName) {
  const app = `${junk()}個人用医薬品購送申込書 外務大臣官房会計課福利厚生室長殿\n申込日付 | 2026年${+p.apply.slice(5, 7)}月${+p.apply.slice(8)}日\n公館コード | 755A 所属公館名 在カクウ日本国大使館\n職員番号 | ${p.code} 申込者氏名${blankApplicant ? "" : " " + noisy(p.applicant)}\n| ふりがな ${p.kana}\n療養者氏名 ${unreadName ? "ーー" : noisy(p.name)}\n申込者との続柄 ${p.rel}\n同意チェック ☑ 本申込書は申込者本人が記入`;
  const fmt = Math.floor(r() * 3);
  const diag = `(原本は本省送付、写しは患者保管)\n診断書\n${junk()}氏名 : ${noisy(p.name)}\n職員コード : ${chance(0.3) ? "A" : ""}${p.code}\n1. 病名 (慢性疾患) : ${diseaseText(p.dis)}\n2. 服用薬・処方 :\n${p.drugs.map((x, i) => drugLine(i + 1, x, fmt)).join("\n")}\n上記1. の病名にて上記2. を服用中である。\n${wareki(p.issue, chance(0.15))}\n在カクウ日本国大使館\n医師氏名 : 見本医師\n(自筆署名と押印)`;
  const [by, bm, bd] = p.birth.split("-");
  const inst = `様式B\n指示書\n${wareki(p.issue)}\n健康管理医 見本医師\n(自筆署名と押印)\n在カクウ日本国大使館\n患者氏名 | ${noisy(p.name)}\nフリガナ | ${p.kana}\n${junk()}生年月日 , 西暦${by}年${bm}月${bd}日\n上記の者に下記の医薬品の服用を指示します。\n記\n${p.drugs.map((x, i) => drugLine(i + 1, x, fmt)).join("\n")}\n100日分`;
  return { app, diag, inst };
}

// ---- 試行
const stat = {}, fails = {};
const tally = (k, ok, ex) => { const s = stat[k] ||= [0, 0]; s[1]++; if (ok) s[0]++; else if ((fails[k] ||= []).length < 5) fails[k].push(ex); };
const nf = s => String(s || "").normalize("NFKC");
const core = d => d.replace(/(症|病)$/, "");
const sameDis = (a, b) => { const x = core(a), y = core(b); return x === y || (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x))); };   // 「高脂血症」と「高脂血」は同じ病名として数える
let done = 0;
while (done < N) {
  // 1家族＝1〜4人（同じ姓・職員番号。半分の確率で同じ処方）
  const fam = [person(null)]; const size = chance(0.35) ? 2 + Math.floor(r() * 3) : 1;
  while (fam.length < size) fam.push(person(fam[0]));
  const pages = [];
  fam.forEach((p, i) => {
    const blankA = chance(0.05), unread = i > 0 && chance(0.2), t = texts(p, blankA, unread);
    // 項目
    const A = O.extract("申込書", t.app), D = O.extract("診断書", t.diag), I = O.extract("指示書", t.inst);
    tally("申込日", A["app.apply_date"] === p.apply, `${A["app.apply_date"]} ≠ ${p.apply}`);
    tally("職員番号(申込書)", (A["app.staff_code"] || "").replace(/^A/, "") === p.code, `${A["app.staff_code"]} ≠ ${p.code}`);
    tally("申込者氏名の空欄", !!A["app.applicant_blank"] === blankA, `blank=${blankA} got=${A["app.applicant_blank"]}`);
    tally("診断書の発行日", D["diag.issue_date"] === p.issue, `${D["diag.issue_date"]} ≠ ${p.issue} :: ${t.diag.split("\n").find(l => /令和/.test(l))}`);
    tally("指示書の発行日", I["inst.issue_date"] === p.issue, `${I["inst.issue_date"]} ≠ ${p.issue}`);
    const dz = O.diseases(t.diag);
    tally("病名", p.dis.every(d => dz.split("、").some(x => sameDis(x, d))), `「${dz}」 ≠ ${p.dis.join("、")} :: ${t.diag.match(/病名[^\n]*\n?[^\n]*/)[0].replace(/\n/g, "⏎")}`);
    const ds = O.extractDrugs(t.inst, isDrug);
    for (const x of p.drugs) {
      const hit = ds.find(d => MF.find(d.name) === x.d) || ds.find(d => x.d.names.some(n => nf(d.name).startsWith(n.replace(/(錠|カプセル)$/, "").slice(0, 5))));
      tally("薬の名前", !!hit, `${x.d.names[0]} :: ${t.inst.split("\n").find(l => l.includes(String(x.st)) && /^\(/.test(l))} → ${ds.map(d => d.name).join(",")}`);
      if (hit) tally("薬の含有量", +hit.strength === +x.st, `${hit.name} ${hit.strength} ≠ ${x.st}`);
    }
    // 保険適応の誤検出（正しい病名・薬なのに要確認が出ないか）
    const kase = { id: p.name, extraction: {
      application: { present: true, apply_date: p.apply, applicant_name: p.applicant, patient_name: p.name, patient_relation: p.rel, staff_code: p.code, mission_name: "在カクウ日本国大使館", mission_code: "755A", consent_item_count: 11, consent_wording_current: "はい", consent_unchecked_items: [], consent9_old_wording: false, written_by_other: "いいえ", proxy_letter_present: false },
      diagnosis: { present: true, issue_date: p.issue, patient_name: p.name, staff_code: p.code, disease: p.dis.join("、"), has_dosage: true, signature: "自筆署名", seal: "はい", doctor_name: "見本医師" },
      instruction: { present: true, issue_date: p.issue, patient_name: p.name, signature: "自筆署名", seal: "はい", doctor_name: "見本医師" },
      drugs: p.drugs.map(x => ({ name_as_written: x.d.names[0] + "錠" + x.st + x.d.unit, strength_value: x.st, strength_unit: x.d.unit, strength_exists: "はい", dosage_form: "錠剤", in_diagnosis: true, in_instruction: true, diag_daily_units: 1, inst_daily_units: 1, days: 100, quantity: 100, is_psychotropic: x.d.psych ? "はい" : "いいえ", indication: "適応内" })), reading_uncertainties: [] } };
    const f = rv.review(kase).filter(x => x.item === "⑬保険適応");
    tally("保険適応の誤検出なし", !f.length, f.map(x => x.msg.slice(0, 80)).join(" / "));
    // 振り分け用のページ
    const k = `${done}-${i}`;
    pages.push({ key: k + "a", type: "申込書", names: unread ? [] : [noisy(p.name)].concat(p.rel !== "本人" ? [noisy(p.applicant)] : []), kana: p.kana, code: p.code, person: i });
    pages.push({ key: k + "d", type: "診断書", names: [noisy(p.name, 0.4)], code: p.code, drugs: p.drugs.map(x => x.d.names[0]), person: i });
    pages.push({ key: k + "i", type: "指示書", names: [noisy(p.name, 0.4)], kana: chance(0.8) ? p.kana : "", person: i, drugs: p.drugs.map(x => x.d.names[0]) });
    done++;
  });
  const res = O.assignByName(pages), gid = res.gid || res;
  fam.forEach((p, i) => {
    const own = pages.filter(q => q.person === i), g0 = gid[own[0].key];
    const ok = own.every(q => gid[q.key] === g0) && pages.filter(q => q.person !== i).every(q => gid[q.key] !== g0);
    tally(fam.length > 1 ? "振り分け（家族）" : "振り分け（1人）", ok, `${fam.map(x => x.name + (x.drugs === fam[0].drugs && x !== fam[0] ? "(同処方)" : "")).join("・")} :: ${own.map(q => q.type + ":" + (q.names[0] || "-") + "→" + gid[q.key]).join(" ")}`);
  });
}

console.log(`試行 ${done} 件（seed ${SEED}）`);
for (const [k, [ok, n]] of Object.entries(stat)) console.log(`${(100 * ok / n).toFixed(2).padStart(6)}%  ${k}（${ok}/${n}）`);
if (VERBOSE) for (const [k, ex] of Object.entries(fails)) { console.log(`\n■ ${k}`); ex.forEach(e => console.log("  " + e)); }
