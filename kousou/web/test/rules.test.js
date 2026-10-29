// node web/test/rules.test.js  — 判定ロジックのテスト（架空データ）
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { Reviewer, ERROR, CHECK } = require("../src/rules.js");

const DATA = path.join(__dirname, "../../python/kousou");
const rules = JSON.parse(fs.readFileSync(path.join(DATA, "rules.json"), "utf8"));
const master = JSON.parse(fs.readFileSync(path.join(DATA, "drug_master.json"), "utf8")).drugs;
const rv = new Reviewer(rules, master, "2026-10-29");

const drug = (name, st, unit, perDay, days, kw = {}) => Object.assign({
  name_as_written: name, generic_name: "", corrected_name: "", name_exists: true, strength_value: st, strength_unit: unit,
  strength_exists: "はい", dosage_form: "錠剤", cold_storage: false, in_diagnosis: true, in_instruction: true,
  diag_daily_units: perDay, inst_daily_units: perDay, adjustable_max_units: null, quantity_indeterminate: false,
  days, quantity: perDay * days, generic_prescription: false, is_psychotropic: "いいえ", is_new_drug: "いいえ",
  is_female_hormone_cycle: false, approved_max_daily: null, approved_max_unit: "", indication: "適応内" }, kw);

function kase(name, code, mission, apply, issue, disease, drugs, { sign = "自筆署名", seal = "はい", app = {} } = {}) {
  const doc = { signature: sign, seal, doctor_name: "架空医師", doctor_mission: "在架空国大使館" };
  return { id: name, extraction: {
    application: Object.assign({ present: true, apply_date: apply, applicant_name: name, patient_name: name, patient_relation: "本人",
      staff_code: code, mission_name: mission, mission_code: "12345", consent_item_count: 11, consent_wording_current: "はい",
      consent_unchecked_items: [], consent9_old_wording: false, old_form_features: "", written_by_other: "いいえ",
      proxy_letter_present: false, proxy_letter_signed: "不明", proxy_name: "" }, app),
    diagnosis: Object.assign({ present: true, issue_date: issue, patient_name: name, staff_code: code, name_code_swapped: false,
      disease, has_dosage: true, original_sent_later: false }, doc),
    instruction: Object.assign({ present: true, issue_date: issue, patient_name: name, no_generic_checked: false }, doc),
    drugs, reading_uncertainties: [] } };
}
const items = c => rv.review(c).map(f => f.sev + "|" + f.item);
const has = (c, sev, item) => assert.ok(items(c).includes(sev + "|" + item), `${c.id}: ${sev} ${item} が無い → ${items(c)}`);
const hasNot = (c, pred, label) => assert.ok(!rv.review(c).some(pred), `${c.id}: ${label} → ${items(c)}`);

has(kase("一郎", "A012345", "在架空国大使館", "2026-10-20", "2026-10-10", "高血圧症", [drug("アムロジピン錠10mg", 10, "mg", 2, 30)]), ERROR, "⑫用量上限");
has(kase("花子", "0234567", "在架空国大使館", "2026-10-20", "2026-10-10", "雀卵斑", [drug("シナール配合錠", null, "", 3, 30)]), ERROR, "⑬保険適応");
const jiro = kase("次郎", "345678", "在キューバ日本国大使館", "2026-10-21", "2026-10-12", "不眠症", [drug("マイスリー錠5mg", 5, "mg", 1, 30)], { seal: "いいえ" });
has(jiro, ERROR, "⑦向精神薬");
hasNot(jiro, f => f.item === "署名・押印" && f.sev === ERROR, "キューバは押印なし可");
const saburo = kase("三郎", "a456789", "在架空国総領事館", "2026-10-22", "2026-10-15", "甲状腺機能低下症", [drug("チラーヂンS錠12.5μg", 12.5, "μg", 1, 100)]);
has(saburo, ERROR, "⑩規格");
hasNot(saburo, f => f.item.includes("数量") || f.item === "②職員コード", "100日分・a付きコードは指摘しない");
hasNot(kase("四郎", "567890", "在架空国大使館", "2026-10-22", "2026-10-15", "脂質異常症", [drug("リピトール錠10mg", 10, "mg", 4, 90)]),
  f => f.sev === ERROR || f.sev === CHECK, "確認済み処方はクリーン");
has(kase("五郎", "1", "在架空国大使館", "2026-10-05", "2026-01-10", "高血圧症", [drug("ノルバスク錠5mg", 5, "mg", 1, 30)], { sign: "記名" }), ERROR, "①有効期限");
has(kase("七郎", "1", "在架空国大使館", "2026-10-20", "2026-10-10", "高血圧症", [drug("ノルバスク錠5mg", 5, "mg", 1, 30)], { sign: "記名" }), ERROR, "署名・押印");
hasNot(kase("六郎", "1", "在架空国大使館", "2026-09-20", "2026-09-10", "高血圧症", [drug("ノルバスク錠5mg", 5, "mg", 1, 30)], { sign: "記名" }),
  f => f.item === "署名・押印", "9月の書類は書式要件を指摘しない");
has(kase("八郎", "1", "在架空国大使館", "2026-10-20", "2026-10-10", "高血圧症", [drug("ノルバスク錠5mg", 5, "mg", 1, 30)],
  { app: { proxy_letter_present: true, proxy_letter_signed: "はい" } }), ERROR, "⑪委任状");
has(kase("九子", "1", "在架空国大使館", "2026-10-20", "2026-10-10", "月経困難症", [drug("ヤーズ配合錠", null, "", 1, 100)]), CHECK, "28日周期");
hasNot(kase("十子", "1", "在架空国大使館", "2026-10-20", "2026-10-10", "子宮内膜症", [drug("ディナゲスト錠1mg", 1, "mg", 2, 100)]),
  f => f.item === "28日周期", "ジエノゲスト100日は指摘しない");

hasNot(kase("十一郎", "1", "在架空国大使館", "2026-10-20", "2026-10-10", "不眠症", [drug("ルネスタ錠2mg", 2, "mg", 1, 30)]),
  f => f.item === "⑦向精神薬", "エスゾピクロンは向精神薬指定なし・購送可");
// バッチ横断：原本流用・前回比較
const a = kase("同一", "111", "在架空国大使館", "2026-10-20", "2026-10-10", "高血圧症", [drug("ノルバスク錠5mg", 5, "mg", 1, 30)]);
const b = JSON.parse(JSON.stringify(a)); b.id = "同一2"; b.extraction.application.apply_date = "2026-10-25";
const x = rv.batchChecks([a, b], []);
assert.ok(x[a.id].some(f => f.item === "⑥原本流用"), "原本流用");
const hist = rv.historyEntries([a], "前回");
const c = JSON.parse(JSON.stringify(a)); c.id = "今回"; c.extraction.application.apply_date = "2026-11-20"; c.extraction.diagnosis.issue_date = "2026-11-10";
c.extraction.instruction.issue_date = "2026-11-10"; c.extraction.drugs[0].strength_value = 10;
assert.ok(rv.batchChecks([c], hist)[c.id].some(f => f.item === "前回比較" && f.sev === CHECK), "用量変更");

console.log("rules.test.js OK");
