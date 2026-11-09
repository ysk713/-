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
assert.strictEqual(d["diag.doctor_name"], undefined);   // 医師名は自筆署名なので自動では入れない

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
assert.deepStrictEqual([rd["diag.issue_date"], rd["diag.staff_code"], rd["diag.disease"], rd["diag.patient_name"]],
  ["2026-10-10", "012345", "高血圧症", "架空一郎"]);
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
assert.ok(!r.warn["7"] || !r.warn["7"].some(w => w.includes("申込書が見つかりません")));   // 申込書が無いことは判定（書類構成）で知らせる
console.log("ocr.test.js（分割）OK");
// 氏名が読めないページは職員番号・薬の組み合わせで人を決める
const r2 = O.assignByName([
  { key: "a", type: "申込書", names: ["架空一郎"], code: "12345", drugs: [] },
  { key: "b", type: "申込書", names: ["見本花子"], code: "67890", drugs: [] },
  { key: "c", type: "診断書", names: [], code: "A012345", drugs: ["アムロジピン"] },     // 職員番号で一郎へ（直前は花子）
  { key: "d", type: "指示書", names: ["見本花子"], code: "", drugs: ["ビラノア"] },
  { key: "e", type: "指示書", names: [], code: "", drugs: ["アムロジピン"] },           // 薬の組み合わせで一郎へ
]);
assert.deepStrictEqual(r2.gid, { a: "a", b: "b", c: "a", d: "b", e: "a" });
console.log("ocr.test.js（職員番号・薬で分割）OK");
// 同意チェック⑨：旧文言は「医薬品の転送」がはっきり読めたときだけ（「領収書」が読めなかっただけでは旧文言としない）
const c9 = s => O.consentInfo("同意チェック\n9. 領収書は代金控除翌月に送付され、異動に伴う" + s + "は申込者")["app.consent9_old_wording"];
assert.deepStrictEqual([c9("医薬品・領収書の転送"), c9("医薬品・領取吾の転送"), c9("医薬品の転送"), c9("医某品の転送")], [false, false, true, true]);
console.log("ocr.test.js（同意チェック⑨）OK");
// 両面スキャン：裏面（申込書の利用の手引き・注意事項だけのページ）は直前の表の人へ。1人3枚とは限らない
assert.strictEqual(O.docTypeOf("個人用医薬品購送の利用の手引き\n1. 本制度の対象者は…\n2. 申込方法は…\n3. 控除について…"), "裏面");
assert.strictEqual(O.docTypeOf("【注意事項 患者・医師共通】※必読※\n指示書の原本は患者が保管し、療養費請求時に提出してください。"), "裏面");
assert.notStrictEqual(O.docTypeOf("診 断 書\n氏 名 ：架空一郎\n１．病名（慢性疾患）：\n令和8年10月10日\n医務官氏名：見本"), "裏面");
const r3 = O.assignByName([
  { key: "1", type: "申込書", names: ["架空一郎"] }, { key: "1u", type: "裏面", names: [] },
  { key: "2", type: "診断書", names: ["架空一郎"] }, { key: "2u", type: "その他", names: ["見本花子"] },   // 裏の雑音の氏名には引っぱられない
  { key: "3", type: "申込書", names: ["見本花子"] }, { key: "3u", type: "裏面", names: [] },
  { key: "4", type: "指示書", names: ["架空一郎"] }, { key: "5", type: "診断書", names: ["見本花子"] }, { key: "5u", type: "裏面", names: [] },
]);
assert.deepStrictEqual(r3.gid, { 1: "1", "1u": "1", 2: "1", "2u": "1", 3: "3", "3u": "3", 4: "1", 5: "3", "5u": "3" });
console.log("ocr.test.js（両面スキャン）OK");
// 実際の書類の読み取りで見つかった崩れ方（架空の値で再現）
assert.deepStrictEqual(O.extractDrugs("(1) ゾルミトリプタン OD 錠2. 5mg/ 錠1回1錠、頭痛時頓用\nー4回分", n => /ゾルミトリプタン/.test(n)).map(x => [x.name, x.strength, x.perDay, x.days, x.prn]),
  [["ゾルミトリプタンOD錠2.5mg", "2.5", "1", "4", true]]);
assert.deepStrictEqual(O.extractDrugs("(1) フェロミア錠5 Onmg/T 1 x タ食後2\n1100 _ 日分", n => /フェロミア/.test(n)).map(x => [x.strength, x.perDay, x.days]), [["50", "2", "100"]]);
assert.strictEqual(O.staffCode("職員コード : 12345\n1. 病名 (慢性疾患) : 片頭痛"), "12345");
assert.strictEqual(O.docTypeOf("様式 B\n【注意事項患者・医師共通】\n※必読※\n1.「診断書」を基に発給すること (指示書には病名を書かない)。\n2. 購送できる医薬品は、錠剤"), "裏面");
assert.deepStrictEqual(O.pageNames("申込書", "職員番号 12345申込者氏名見本太郎\nふりがな みほんはなこ\n林氏名見本花子\n申込者との続柄 妻"), ["見本花子", "見本太郎"]);
assert.strictEqual(O.missionName("所属公館名 (自重入力在カクウ犬使館 ."), "在カクウ大使館");
assert.strictEqual(O.extract("申込書", "申込日付 ドー2年10月16昌 |\n職員番号 12345")["app.apply_date"], new Date().getFullYear() + "-10-16");
console.log("ocr.test.js（実際の書類の崩れ方）OK");
// 2部綴じ・異体字（齋藤／斉藤）・職員コードの読み違い：同じ人の2枚目の診断書を次の人に入れない
const r4 = O.assignByName([{ key: "a", type: "申込書", names: ["斉藤花還子"], code: "A90123" }, { key: "b", type: "指示書", names: ["斉藤花子"] },
  { key: "c", type: "診断書", names: ["許藤花結子"], code: "A90723" }, { key: "c2", type: "診断書", names: ["齋藤花子"], code: "A90723" },
  { key: "d", type: "申込書", names: ["大森架空"], code: "90574" }, { key: "e", type: "申込書", names: ["黒川見本"], code: "90864" }]);
assert.strictEqual(r4.gid.c2, "a");
console.log("ocr.test.js（2部綴じ・異体字）OK");

// 家族の書類（療養者と申込者が違う）・改姓：職員番号が完全に一致すれば同じ申込み
const r5 = O.assignByName([{ key: "a", type: "申込書", names: ["架空一郎"], code: "91562" }, { key: "b", type: "診断書", names: ["架空花子"], code: "91562" },
  { key: "c", type: "指示書", names: ["架空花子"] }, { key: "d", type: "申込書", names: [], code: "9878" }, { key: "e", type: "診断書", names: ["見本さくら"], code: "09878" },
  { key: "f", type: "指示書", names: ["見本さくら"] }, { key: "g", type: "申込書", names: ["山川陽子"], code: "91630" },
  { key: "h", type: "診断書", names: ["海野陽子"], code: "91630" }, { key: "i", type: "指示書", names: ["海野陽子"] }]);
assert.deepStrictEqual(["b", "c", "e", "f", "h", "i"].map(k => r5.gid[k]), ["a", "a", "d", "d", "g", "g"]);
// 同じ人が申込書を2回分：2回目の書類は2回目の申込書へ
const r6 = O.assignByName([{ key: "a", type: "申込書", names: ["試験一子"], code: "91430" }, { key: "b", type: "指示書", names: ["試験一子"] },
  { key: "c", type: "診断書", names: ["試験一子"], code: "91430" }, { key: "d", type: "申込書", names: ["試験一子"], code: "91430" },
  { key: "e", type: "指示書", names: ["試験一子"] }, { key: "f", type: "診断書", names: ["試験一子"], code: "91430" }]);
assert.deepStrictEqual(["b", "c", "e", "f"].map(k => r6.gid[k]), ["a", "a", "d", "d"]);
console.log("ocr.test.js（家族・改姓・同じ人の2回分）OK");

// 2026-11-04 の束から（架空の氏名・数値に置き換え）
assert.strictEqual(O.clean("(1) デエビゴ5mg/T 1x 就寝前21T"), "(1) デエビゴ5mg/T 1x 就寝前2T");
assert.strictEqual(O.clean("(5) ピタバスタチン Ca錠2mg/T"), "(5) ピタバスタチンCa錠2mg/T");
assert.strictEqual(O.clean("(4) バイアスピリン錠 . 100mg/T"), "(4) バイアスピリン錠100mg/T");
assert.strictEqual(O.clean("アムロジピン0O0D錠5mg"), "アムロジピンOD錠5mg");
assert.strictEqual(O.clean("エソメプラゾール CP 20mg"), "エソメプラゾールカプセル20mg");
assert.strictEqual(O.clean("アムロジピン2、5mg"), "アムロジピン2.5mg");
assert.strictEqual(O.clean("クレストール _。2.5mg"), "クレストール2.5mg");
assert.strictEqual(O.consensusName(["架空太朗", "架空太郎", "架空太郎"]), "架空太郎");   // 同じ読みが2つの書類にあれば、そちらを採る
// 病名が行をまたぐ（「高コレ」＋改行＋「ステロール血症」）
assert.ok(O.extract("診断書", "診断書\n1. 病名 (慢性疾患) : 高血圧症、高尿酸血症、高コレ\nステロール血症\n2. 服用薬・処方 :")["diag.disease"].includes("高コレステロール血症"));
// 2枚分を1ページに縮小した申込書：右側の文章が氏名の後ろに付く
assert.strictEqual(O.extract("申込書", "個人用医薬品購送申込書\n職員番号12345 申込者氏名 架空花子いて受領することによって")["app.applicant_name"], "架空花子");
console.log("ocr.test.js（2026-11-04の束）OK");

// 2026-11-06 の束から（架空の氏名に置き換え）
assert.strictEqual(O.kanaOf("申込書", "| ふりがな | かくう はなこ |\n氏名 架空花子"), "カクウハナコ");
assert.strictEqual(O.kanaOf("指示書", "患者氏名 架空花子\nフリガナ | カクウ ハナコ ーー"), "カクウハナコ");
// 同じ申込者（職員）が家族3人分の申込書を続けて出し、そのあと一人ずつ指示書・診断書：療養者のふりがなで組み合わせる
const r7 = O.assignByName([
  { key: "a1", type: "申込書", names: ["試験一郎"], code: "90412", kana: "シケンハナコ" }, { key: "a2", type: "申込書", names: ["試験一郎"], code: "90412", kana: "シケンタロウ" },
  { key: "a3", type: "申込書", names: ["試験一郎"], code: "90412", kana: "シケンジロウ" },
  { key: "i1", type: "指示書", names: ["試験花子"], kana: "シケンハナコ" }, { key: "d1", type: "診断書", names: ["試験花子"], code: "A90412" },
  { key: "i2", type: "指示書", names: ["試験大郎"], kana: "シケンタロウ" }, { key: "d2", type: "診断書", names: ["試験太郎"], code: "A90412" },
  { key: "i3", type: "指示書", names: ["試験次郎"], kana: "シケンジロウ" }, { key: "d3", type: "診断書", names: ["試験次郎"], code: "A90412" }]);
assert.deepStrictEqual(["i1", "d1", "i2", "d2", "i3", "d3"].map(k => r7.gid[k]), ["a1", "a1", "a2", "a2", "a3", "a3"]);
// 指示書の氏名が崩れても、フリガナが近ければ同じ人
const r8 = O.assignByName([{ key: "a", type: "申込書", names: ["見本敬"], code: "90220", kana: "ミホンケイスケ" }, { key: "i", type: "指示書", names: ["療波孝一"], kana: "ミホロケイスケ" },
  { key: "d", type: "診断書", names: ["見本敬"], code: "92020" }, { key: "b", type: "申込書", names: ["別人花子"], code: "91111", kana: "ベツジンハナコ" }]);
assert.strictEqual(r8.gid.i, "a");
assert.strictEqual(O.clean("(3) コルヒチン0., 5mg/T"), "(3) コルヒチン0.5mg/T");
console.log("ocr.test.js（2026-11-06の束）OK");

// 9月末〜10月初めの束から（架空の値）
assert.strictEqual(O.clean("メチコバール鐘 (5004g)"), "メチコバール錠 (500μg)");
assert.strictEqual(O.clean("(1) アレンドロン酸35mg錠35mg/ 錠"), "(1) アレンドロン酸錠35mg35mg/ 錠");
console.log("ocr.test.js（9月末の束）OK");
assert.deepStrictEqual(O.extractDrugs("(1) ツムラ加味道奥散エキス粒 (医療用) 1回1包 x1日3回", () => false).map(d => d.name), ["ツムラ 加味逍遙散"]);
assert.strictEqual(O.extract("診断書", "診断書\n1. 病名 (慢性疾患): 虚弱体質、肩凝り\n2. 服用薬")["diag.disease"], "虚弱体質、肩凝り");
console.log("ocr.test.js（11/9の束）OK");
assert.strictEqual(O.extract("診断書", "診断書\n1. 病名 (慢性疾患) : 慢性疹痛症候群\n2. 服用薬")["diag.disease"], "慢性疼痛症候群");
console.log("ocr.test.js（11/9午後の束）OK");
