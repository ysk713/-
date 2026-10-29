// node web/test/master.test.js — 診断書アプリの薬剤マスタ取り込みと法規制判定のテスト（架空データ）
const assert = require("assert");
const path = require("path"), fs = require("fs");
const { Reviewer, ERROR, CHECK } = require("../src/rules.js");
const KM = require("../src/master.js");

global.window = {};
require(path.join(__dirname, "../../../shindansho/drugs.js"));
const DATA = path.join(__dirname, "../../python/kousou");
const rules = JSON.parse(fs.readFileSync(path.join(DATA, "rules.json"), "utf8"));
const kousou = JSON.parse(fs.readFileSync(path.join(DATA, "drug_master.json"), "utf8")).drugs;
const built = KM.build(kousou, window.DRUG_MASTER, []);
const legal = KM.legalFrom(window.BANNED_DRUGS);
console.log(`購送審査 ${built.counts.kousou} + 診断書アプリ ${built.counts.shindansho} = ${built.drugs.length}品目（重複で除外 ${built.skipped.length}）`);
assert.ok(built.drugs.length > 200);

// 変換
assert.strictEqual(KM.stem("ゾルピデム酒石酸塩錠"), "ゾルピデム");
assert.strictEqual(KM.stem("アムロジピン錠"), "アムロジピン");
assert.deepStrictEqual(KM.notIndicated("肝斑は保険適応外"), ["肝斑"]);
assert.deepStrictEqual(KM.notIndicated("最長120日連続投与。避妊目的は保険適応外"), ["避妊"]);
// 購送審査側が優先される（エスゾピクロンは向精神薬でない、ブロチゾラム上限0.25は購送審査の値）
const m = new (require("../src/rules.js").Master)(built.drugs);
assert.strictEqual(m.find("ルネスタ錠2mg").psych, false);
assert.strictEqual(m.find("レンドルミン錠0.25mg").source, "購送審査");
assert.strictEqual(m.find("アダラートCR錠20mg").source, "診断書アプリ");
assert.strictEqual(m.find("エンレスト錠200mg").max_daily, 400);                       // バルサルタン（160）と取り違えない
assert.strictEqual(m.find("サクビトリルバルサルタン錠100mg").names[0], "サクビトリルバルサルタン錠");
// 画面での上書きが最優先
const over = KM.overlay(built.drugs, [{ names: ["アムロジピン"], unit: "mg", strengths: [5], max_daily: 5 }]);
assert.strictEqual(new (require("../src/rules.js").Master)(over).find("アムロジピン錠5mg").max_daily, 5);

// 判定
const rv = new Reviewer(rules, built.drugs, "2026-10-29", legal);
const drug = (name, st, unit, perDay, days) => ({ name_as_written: name, generic_name: "", corrected_name: "", name_exists: true,
  strength_value: st, strength_unit: unit, strength_exists: "不明", dosage_form: "錠剤", cold_storage: false, in_diagnosis: true, in_instruction: true,
  diag_daily_units: perDay, inst_daily_units: perDay, adjustable_max_units: null, quantity_indeterminate: false, days, quantity: perDay * days,
  generic_prescription: false, is_psychotropic: "不明", is_new_drug: "不明", is_female_hormone_cycle: false, approved_max_daily: null, approved_max_unit: "", indication: "不明" });
const kase = (disease, drugs) => ({ id: "x", extraction: {
  application: { present: true, apply_date: "2026-10-20", applicant_name: "架空", patient_name: "架空", staff_code: "1", mission_name: "在架空国大使館",
    mission_code: "", consent_item_count: 11, consent_wording_current: "はい", consent_unchecked_items: [], proxy_letter_present: false },
  diagnosis: { present: true, issue_date: "2026-10-10", staff_code: "1", disease, has_dosage: true, signature: "自筆署名", seal: "はい" },
  instruction: { present: true, issue_date: "2026-10-10", signature: "自筆署名", seal: "はい" }, drugs } });
const items = c => rv.review(c).map(f => f.sev + "|" + f.item + "|" + f.msg);
const has = (c, re) => assert.ok(items(c).some(x => re.test(x)), items(c).join("\n"));
const hasNot = (c, re) => assert.ok(!items(c).some(x => re.test(x)), items(c).join("\n"));

has(kase("高血圧症", [drug("アダラートCR錠40mg", 40, "mg", 3, 30)]), /エラー相当\|⑫用量上限/);        // 診断書アプリ由来の上限80mg
hasNot(kase("高血圧症", [drug("アダラートCR錠40mg", 40, "mg", 1, 30)]), /薬品マスタ|⑫/);             // 登録済み・上限内
has(kase("不安神経症", [drug("レキソタン錠2mg", 2, "mg", 3, 30)]), /エラー相当\|⑦向精神薬/);        // マスタ未登録でも規制薬リストで検出
has(kase("癌性疼痛", [drug("オキシコンチン錠5mg", 5, "mg", 2, 14)]), /エラー相当\|法規制\|.*麻薬/);
hasNot(kase("不眠症", [drug("ルネスタ錠2mg", 2, "mg", 1, 30)]), /向精神薬|法規制/);
has(kase("肝斑", [drug("トランサミン錠250mg", 250, "mg", 3, 30)]), /エラー相当\|⑬保険適応/);
console.log("master.test.js OK");
