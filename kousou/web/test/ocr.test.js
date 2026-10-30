// node web/test/ocr.test.js — OCRの文字から項目を取り出す処理のテスト（架空データ。書式は診断書アプリの印刷様式に合わせた）
const assert = require("assert");
const O = require("../src/ocr.js");

assert.strictEqual(O.clean("令 和 8 年 1 0 月 2 0 日"), "令和8年10月20日");
assert.deepStrictEqual(O.findDates("発行日 令和8年10月10日 / 2026/10/20").map(d => d.iso), ["2026-10-10", "2026-10-20"]);

const app = `個人用医薬品購送申込書
申込日　令和 8 年 10 月 20 日
所属公館名　在カクウ日本国大使館　公館コード 12345
職員コード　A0 1 2 3 4 5
申込者氏名　架空 一郎
同意チェック ☑ 本申込書は申込者本人が記入`;
const a = O.extract("申込書", app);
assert.strictEqual(a["app.apply_date"], "2026-10-20");
assert.strictEqual(a["app.staff_code"], "A012345");
assert.strictEqual(a["app.mission_name"], "在カクウ日本国大使館");
assert.strictEqual(a["app.mission_code"], "12345");
assert.strictEqual(a["app.applicant_name"], "架空一郎");

const diag = `（原本は医薬品購送申込時に本省へ送付、写しは患者保管）
診 断 書
氏　名　　：架空 一郎
職員コード：012345
生年月日　　：1980年1月1日
所　属　　：在カクウ日本国大使館
１．病名（慢性疾患）：
（1）高血圧症
（2）脂質異常症
２．服用薬・処方：
（1）アムロジピン錠5mg 1回1錠 1日1回 朝食後
令和8年10月10日　在カクウ日本国大使館
医務官氏名：架空 医師 印`;
const d = O.extract("診断書", diag);
assert.strictEqual(d["diag.issue_date"], "2026-10-10");
assert.strictEqual(d["diag.staff_code"], "012345");
assert.strictEqual(d["diag.disease"], "高血圧症、脂質異常症");
assert.strictEqual(d["diag.patient_name"], "架空一郎");
assert.strictEqual(d["diag.doctor_name"], "架空医師");

const inst = `指 示 書
令和8年10月10日　在カクウ日本国大使館
健康管理医　架空 医師 印
患者氏名　架空 一郎
薬品名 含有量 用法・用量 １日分使用量
（1）　アムロジピン錠 5mg 1回1錠 1日1回 朝食後 1錠
（2）　ロスバスタチン錠 2.5mg 分1 夕食後 1錠
（3）　ファモチジン錠 20mg 1回1錠 1日2回 朝夕食後
30　日分　□ 後発医薬品への変更不可`;
const i = O.extract("指示書", inst);
assert.strictEqual(i["inst.issue_date"], "2026-10-10");
const known = ["アムロジピン錠", "ロスバスタチン錠", "ファモチジン錠"];
const drugs = O.extractDrugs(inst, n => known.some(k => n.includes(k.replace("錠", ""))));
assert.deepStrictEqual(drugs.map(x => [x.name, x.strength, x.unit, x.perDay, x.days]), [
  ["アムロジピン錠5mg", "5", "mg", "1", "30"], ["ロスバスタチン錠2.5mg", "2.5", "mg", "1", "30"], ["ファモチジン錠20mg", "20", "mg", "2", "30"]]);
// 薬でない語（患者氏名など）は採らない
assert.strictEqual(O.extractDrugs("架空錠剤のお知らせ 5mg", () => false).length, 0);
// 実際のOCR（Tesseract.js、日本語）の出力（架空の様式を画像にして読ませたもの）。誤読（念和・信和・空白）を含む
const REAL = ["個人用医薬品購送申込書 ( 様式 A )\n\n申込日念和8年10月20日\n\n所属公館名在カクウ日本国大使館公館コード12345\n職員コード A012345\n\n申込者氏名架空一郎\n\nロ本申込書は申込者本人が記入、同意チェックを行いました", "診断書\n\n氏名 : 架空一郎\n\n職員コード :012345\n\n所属 : 在カクウ日本国大使館\n\n1 . 病名 (慢性疾患 ) :\n\n(1 ) 高血圧症\n\n2 . 服用薬・処方\n\n(1 ) アムロジピン錠5 mg 1 回1 錠1日1 回朝食後\n念和8年10月10日在カクウ日本国大使館\n医務官氏名 : 架空医師印", "指示 _ 書\n\n信和8年10月10日在カクウ日本国大使館\n\n健康管理医架空医師印\n\n患者氏名架空一郎\n\n楽品名合有量用法・用量1日分使用量\n\n(1 ) アムロジピン錠5 mg 1 回1 錠1日1 回朝食後1 錠\n30日分"];
const ra = O.extract("申込書", REAL[0]), rd = O.extract("診断書", REAL[1]), ri = O.extract("指示書", REAL[2]);
assert.deepStrictEqual([ra["app.apply_date"], ra["app.staff_code"], ra["app.mission_name"], ra["app.applicant_name"], ra["app.mission_code"]],
  ["2026-10-20", "A012345", "在カクウ日本国大使館", "架空一郎", "12345"]);
assert.deepStrictEqual([rd["diag.issue_date"], rd["diag.staff_code"], rd["diag.disease"], rd["diag.patient_name"], rd["diag.doctor_name"]],
  ["2026-10-10", "012345", "高血圧症", "架空一郎", "架空医師"]);
assert.strictEqual(ri["inst.issue_date"], "2026-10-10");
const isD = n => /アムロジピン/.test(n);
assert.deepStrictEqual(O.extractDrugs(REAL[2], isD).map(x => [x.name, x.strength, x.perDay, x.days]), [["アムロジピン錠5mg", "5", "1", "30"]]);
assert.deepStrictEqual(O.extractDrugs(REAL[1], isD).map(x => [x.name, x.perDay]), [["アムロジピン錠5mg", "1"]]);
// 横向き・逆さ・ぼけたスキャンを自動回転して読んだ出力（含和・金和・職遇コード・AD12345 などの誤読を含む）
const BAD = ["個人用医薬品購送申込書 (様式 A)\n\n申込日含和8年10月20日\n\n所略公途名在カクウ日本国大使館公人鶴コード12343S\n職員コード AD12345\n\n申込者氏名架沈一計\n\nロ示申込書は申込者本人が記入、同意チェックを行いました", "診断書\n\n氏名 : 架空一朗\n\n職遇コード :0123435\n\n所性 : 在カクウ日本国大使館\n\n1 , 病名 (慢性疾患) :\n\n(1) 高血圧症\n\n2. 服用薬・処方・\n\n(1) アムロジピン錠5mg 1回1錠1日1回朝食後\n金和8年10月10日在カクウ日本国大使館\n医務官氏名 : 架空医師印", "指示書\n\n人金和8年10月10日在カクウ日本国大使館\n\n健康管理医架空医師\n\n患者氏名架空一朗\n\n薬品名含有旦用法・用量1日分使用最\n\n(1) アムロジピン錠5mg 1回1錠1日1回朝食後1名\n30日分"];
assert.strictEqual(O.extract("申込書", BAD[0])["app.apply_date"], "2026-10-20");
assert.strictEqual(O.extract("申込書", BAD[0])["app.staff_code"], "A012345");
assert.strictEqual(O.extract("診断書", BAD[1])["diag.issue_date"], "2026-10-10");
assert.strictEqual(O.extract("指示書", BAD[2])["inst.issue_date"], "2026-10-10");
assert.strictEqual(O.clean("生年月日 昭和55年1月1日"), "生年月日昭和55年1月1日");
assert.deepStrictEqual(O.findDates("生年月日 1980年1月1日 発行日 令和8年10月10日").map(d => d.iso), ["2026-10-10"]);
assert.ok(!O.clean("平和な日々").includes("令和"));   // 「年」が続かなければ置き換えない
console.log("ocr.test.js OK");

// ---- 氏名で人ごとに分ける
const { nameSim } = require("../src/rules.js");
assert.ok(nameSim("架空一郎", "架空一朗") >= 0.6);            // OCRの読み違いは同じ人
assert.ok(nameSim("架空一郎", "架空花子") < 0.6);             // 同じ姓の家族は別の人
assert.strictEqual(O.docTypeOf("指示 _ 書\n令和8年"), "指示書");
assert.strictEqual(O.docTypeOf("個人用医薬品購送申込書 (様式A)"), "申込書");
assert.deepStrictEqual(O.pageNames("指示書", "指示書\n患者氏名 架空一郎\n"), ["架空一郎"]);
assert.deepStrictEqual(O.pageNames("申込書", "申込者氏名 架空一郎\n療養者氏名 架空花子"), ["架空花子", "架空一郎"]);
// スキャン順が崩れていても氏名で振り分ける：A申込, B申込, A診断, B診断, A指示, (氏名なし)→直前の人, C指示（申込書なし）, B指示
const pg = (key, type, names) => ({ key, type, names });
const r = O.assignByName([pg("1", "申込書", ["架空一郎"]), pg("2", "申込書", ["架空花子"]), pg("3", "診断書", ["架空一朗"]),
  pg("4", "診断書", ["架空花子"]), pg("5", "指示書", ["架空一郎"]), pg("6", "その他", []), pg("7", "指示書", ["見本三郎"]), pg("8", "指示書", ["架空花子"])]);
assert.deepStrictEqual(r.gid, { 1: "1", 2: "2", 3: "1", 4: "2", 5: "1", 6: "1", 7: "7", 8: "2" });
assert.ok(r.warn["7"][0].includes("申込書が見つかりません"));
console.log("ocr.test.js（分割）OK");
