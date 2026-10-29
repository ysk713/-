// node web/test/yakka.test.js — 薬価基準リストでの照合（薬品名・規格・新薬14日）のテスト（架空データ）
const assert = require("assert");
const fs = require("fs"), path = require("path");
const { Yakka, familyKey, parseSpec } = require("../src/yakka.js");
const { Reviewer } = require("../src/rules.js");

assert.strictEqual(familyKey("アムロジピン錠5mg「サワイ」"), "アムロジピン");
assert.strictEqual(familyKey("ノルバスクOD錠5mg"), "ノルバスク");
assert.strictEqual(familyKey("アダラートCR錠20mg"), "アダラートcr");
assert.deepStrictEqual(parseSpec("0.25mg1錠"), { value: 0.25, unit: "mg" });
assert.strictEqual(parseSpec("1錠"), null);

const data = { fetched: "2026-11-05", first_seen: { "シンヤクマブ": "2026-08" }, items: [
  ["ニフェジピンCR錠10mg「架空」", "ニフェジピン", "10mg1錠", "内用", 2, ""],
  ["ニフェジピンCR錠20mg「架空」", "ニフェジピン", "20mg1錠", "内用", 2, ""],
  ["ミグシス錠5mg", "ロメリジン塩酸塩", "5mg1錠", "内用", 1, ""],
  ["シンヤク錠50mg", "シンヤクマブ", "50mg1錠", "内用", 1, ""],
  ["ノルバスク錠5mg", "アムロジピンベシル酸塩", "5mg1錠", "内用", 1, ""],
] };
const yk = new Yakka(data);
assert.ok(yk.find("ミグシス錠5mg") && yk.find("ロメリジン塩酸塩錠5mg"));
assert.strictEqual(yk.find("ミグシスト錠"), null);
assert.strictEqual(yk.newDrugUntil(yk.find("シンヤク錠50mg")), "2027-08-01");
assert.strictEqual(yk.newDrugUntil(yk.find("ミグシス錠")), null);

const DATA = path.join(__dirname, "../../python/kousou");
const rules = JSON.parse(fs.readFileSync(path.join(DATA, "rules.json"), "utf8"));
const master = JSON.parse(fs.readFileSync(path.join(DATA, "drug_master.json"), "utf8")).drugs;
const rv = new Reviewer(rules, master, "2026-10-29", [], yk);
const drug = (name, st, perDay, days) => ({ name_as_written: name, strength_value: st, strength_unit: "mg", dosage_form: "錠剤", in_diagnosis: true, in_instruction: true,
  diag_daily_units: perDay, inst_daily_units: perDay, adjustable_max_units: null, days, quantity: perDay * days, is_psychotropic: "不明", is_new_drug: "不明", indication: "不明" });
const kase = drugs => ({ id: "x", extraction: {
  application: { present: true, apply_date: "2026-10-20", applicant_name: "架空", staff_code: "1", consent_item_count: 11, consent_unchecked_items: [] },
  diagnosis: { present: true, issue_date: "2026-10-10", staff_code: "1", disease: "片頭痛", has_dosage: true, signature: "自筆署名", seal: "はい" },
  instruction: { present: true, issue_date: "2026-10-10", signature: "自筆署名", seal: "はい" }, drugs } });
const msgs = c => rv.review(c).map(f => `${f.sev}|${f.item}|${f.msg}`);
const has = (c, re) => assert.ok(msgs(c).some(x => re.test(x)), msgs(c).join("\n"));
const hasNot = (c, re) => assert.ok(!msgs(c).some(x => re.test(x)), msgs(c).join("\n"));

has(kase([drug("ミグシス錠5mg", 5, 2, 30)]), /要確認\|薬品マスタ\|.*薬価基準には収載：ロメリジン塩酸塩/);
has(kase([drug("ミグシスト錠5mg", 5, 2, 30)]), /要確認\|⑩薬品名\|.*見当たりません/);
has(kase([drug("ミグシス錠10mg", 10, 1, 30)]), /エラー相当\|⑩規格\|.*収載：5mg/);
has(kase([drug("シンヤク錠50mg", 50, 1, 30)]), /エラー相当\|⑦日数制限\|.*2027-08-01まで/);
hasNot(kase([drug("シンヤク錠50mg", 50, 1, 14)]), /⑦日数制限/);
hasNot(kase([drug("ノルバスク錠5mg", 5, 1, 30)]), /⑩|薬品マスタ|⑦日数/);       // マスタ登録済み・既存成分
// 薬価データが無いとき（取り込み前）は従来どおり
const rv0 = new Reviewer(rules, master, "2026-10-29", [], new Yakka(null));
assert.ok(rv0.review(kase([drug("ミグシスト錠5mg", 5, 2, 30)])).some(f => f.item === "薬品マスタ"));
console.log("yakka.test.js OK");
