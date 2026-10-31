// シミュレーション用：申込書（様式A）・診断書・指示書の見本（架空の人物）をHTMLで作る。
// 様式Aは実物の配置（表題・公館コード/申込日・職員番号/公館名・シメイ/氏名/続柄・注意事項・同意チェック11項目・色付きの枠）に似せる。
// 診断書・指示書は診断書アプリ（shindansho）の印刷様式に似せる。
const SURN = [["架空", "かくう"], ["見本", "みほん"], ["試験", "しけん"], ["仮名", "かめい"], ["例題", "れいだい"], ["模擬", "もぎ"], ["検証", "けんしょう"], ["参考", "さんこう"]];
const GIVEN = [["一郎", "いちろう"], ["花子", "はなこ"], ["春香", "はるか"], ["太郎", "たろう"], ["美咲", "みさき"], ["健太", "けんた"], ["優子", "ゆうこ"], ["翔", "しょう"], ["真理", "まり"], ["大輔", "だいすけ"]];
const MISSIONS = ["在カクウ日本国大使館", "在ミホン日本国総領事館", "在テスト日本国大使館", "在サンプル日本国大使館", "在モギ日本国総領事館"];
const DISEASES = ["高血圧症", "脂質異常症", "2型糖尿病", "甲状腺機能低下症", "逆流性食道炎", "高尿酸血症", "アレルギー性鼻炎", "不眠症"];
const DRUGS = [ // [薬品名, 含有量, 単位, 1回量, 1日回数, 用法]
  ["アムロジピン錠", 5, "mg", 1, 1, "朝食後"], ["オルメテック錠", 20, "mg", 1, 1, "朝食後"], ["ロスバスタチン錠", 2.5, "mg", 1, 1, "夕食後"],
  ["メトグルコ錠", 500, "mg", 1, 2, "朝夕食後"], ["チラーヂンS錠", 50, "μg", 1, 1, "朝食後"], ["タケキャブ錠", 10, "mg", 1, 1, "朝食後"],
  ["フェブリク錠", 20, "mg", 1, 1, "朝食後"], ["ビラノア錠", 20, "mg", 1, 1, "就寝前"], ["デエビゴ錠", 5, "mg", 1, 1, "就寝前"],
  ["ファモチジン錠", 20, "mg", 1, 2, "朝夕食後"], ["リピトール錠", 10, "mg", 1, 1, "夕食後"], ["ジャヌビア錠", 50, "mg", 1, 1, "朝食後"],
];
const CONSENT = ["本申込書は申込者本人が記入、同意チェックを行いました", "本制度について裏面の利用の手引きを読み理解しました", "控除予定月までに異動・帰朝発令の予定はありません",
  "医薬品は申込者欄記載の所属公館宛てに送付されると理解しました", "処方内容（後発品への変更可否、医薬品名、処方量、錠数、枚数）に疑義はありません", "指示書の原本は本人が保管します",
  "医薬品代について理解し控除に同意します", "医薬品代が控除できなかった場合は未払い金精算後まで申込みできないと理解しました",
  "領収書は代金控除翌月に送付され、異動に伴う医薬品・領収書の転送は申込者が対応することに同意します", "今回申込む医薬品は予防薬・液体・軟膏・座薬・ガス使用吸入薬ではありません",
  "医薬品到着見込み時期は目安であり場合によって更に時間を要すると理解しました"];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const wareki = iso => { const [y, m, d] = iso.split("-").map(Number); return `令和${y - 2018}年${m}月${d}日`; };
const seireki = iso => { const [y, m, d] = iso.split("-").map(Number); return `${y}年${m}月${d}日`; };

// 架空の人物（申込者＝本人、ときどき家族＝同じ姓）
function people(n, seed) {
  const r = rng(seed), out = [], used = new Set();
  while (out.length < n) {
    const family = out.length && r() < 0.25;   // 直前の人の家族（同じ姓・同じ職員番号）
    const base = family ? out[out.length - 1] : null;
    const sn = base ? base.surname : pick(r, SURN), gn = pick(r, GIVEN);
    const name = `${sn[0]} ${gn[0]}`; if (used.has(name)) continue; used.add(name);
    const issueDay = 1 + Math.floor(r() * 20), applyDay = issueDay + 1 + Math.floor(r() * 8);
    const nd = 1 + Math.floor(r() * 3), drugs = [];
    while (drugs.length < nd) { const d = pick(r, DRUGS); if (!drugs.includes(d)) drugs.push(d); }
    out.push({
      surname: sn, name, kana: `${sn[1]} ${gn[1]}`, applicant: base ? base.applicant : name, relation: base ? pick(r, ["配偶者", "子"]) : "本人",
      staff: base ? base.staff : String(10000 + Math.floor(r() * 89999)), missionCode: base ? base.missionCode : `${600 + Math.floor(r() * 99)}A`,
      mission: base ? base.mission : pick(r, MISSIONS),
      issue: `2026-10-${String(issueDay).padStart(2, "0")}`, apply: `2026-10-${String(Math.min(applyDay, 31)).padStart(2, "0")}`,
      diseases: [pick(r, DISEASES)].concat(r() < 0.4 ? [pick(r, DISEASES)] : []).filter((v, i, a) => a.indexOf(v) === i),
      drugs: drugs.map(([n2, st, u, once, times, usage]) => ({ name: n2, strength: st, unit: u, perDay: once * times, usage: `1回${once}錠 1日${times}回 ${usage}` })),
      days: pick(r, [30, 60, 90]), doctor: "見本 医務官", font: pick(r, ["IPAGothic", "IPAPGothic", "WenQuanYi Zen Hei"]),
      oldConsent9: r() < 0.2,   // 同意チェック⑨が旧版の文言（第二弾で見つかった不備）
      swap: r() < 0.1,          // 診断書の氏名欄と職員コード欄の取り違え
    });
  }
  return out;
}

const CSS = (font) => `
  *{box-sizing:border-box} body{margin:0;background:#fff} .pg{width:794px;height:1123px;padding:34px 40px;font-family:IPAGothic;font-size:12px;color:#111;position:relative}
  .v{font-family:"${font}";font-size:15px} table{border-collapse:collapse;width:100%} td,th{border:1px solid #333;padding:4px 6px;text-align:left;font-weight:normal}
  h1{font-size:22px;letter-spacing:.3em;text-align:center;margin:10px 0 16px} .small{font-size:10px;line-height:1.35}`;

function applicationHtml(p) {
  return `<html><head><style>${CSS(p.font)}
    .title{background:#f6b26b;border:2px solid #c55;font-size:19px;font-weight:bold;padding:6px 12px;display:inline-block}
    .red{border:2px solid #d33;background:#fde9e7;padding:4px 6px;margin:6px 0} .lab{background:#fce5cd;width:18%}
    .note{background:#fff2cc;border:1px solid #c90;padding:6px;margin-top:8px} .cons td{padding:2px 6px;font-size:10.5px}</style></head><body><div class="pg">
    <div style="display:flex;justify-content:space-between;align-items:flex-start"><span class="title">個人用医薬品購送申込書</span><span>外務大臣官房会計課福利厚生室長　殿</span></div>
    <p class="small">今般、健康管理医または医師の「指示書」及び「診断書」のとおり服用医薬品の購送を申し込みます。</p>
    <div class="red small">赤枠内は必ず申込者本人が記入してください。代筆の場合は委任状を添付してください。</div>
    <table><tr><td class="lab">公館コード</td><td class="v">${p.missionCode}</td><td class="lab">申込日</td><td class="v">${seireki(p.apply)}</td></tr>
      <tr><td class="lab">職員番号</td><td class="v">${p.staff}</td><td class="lab">公館名</td><td class="v">${p.mission}</td></tr>
      <tr><td class="lab">申込者氏名</td><td class="v" colspan="3">${p.applicant}</td></tr></table>
    <table style="margin-top:8px"><tr><td class="lab">シメイ</td><td class="v">${p.kana}</td></tr><tr><td class="lab">療養者氏名</td><td class="v">${p.name}</td></tr>
      <tr><td class="lab">申込者との続柄</td><td class="v">${p.relation}</td></tr></table>
    <div class="note"><b>申込みの注意事項</b><div class="small">
      1. 対象者　外務省在外職員及び同居の被扶養者（継続服薬が必要な者に限る）<br>2. 申込方法　本申込書に診断書（原本）及び指示書（写し）を添えて申し込むこと<br>
      3. 有効期限　診断書・指示書の有効期限は発行日から3ヶ月、使用は1回限り<br>4. 処方日数　新薬は14日分まで。向精神薬は購送できません<br>
      5. 剤形　錠剤・顆粒・粉末・貼り薬に限る。液体・軟膏・スプレー・冷所品は不可<br>6. 送付　医薬品は申込者欄記載の所属公館宛てに送付します<br>
      7. 控除　医薬品代は俸給から控除します。領収書は控除翌月に送付します</div></div>
    <p style="margin:10px 0 4px"><b>同意チェック</b>（すべての項目を確認し、レ点を記入）</p>
    <table class="cons">${CONSENT.map((c, i) => `<tr><td style="width:28px;text-align:center">☑</td><td>${i + 1}. ${i === 8 && p.oldConsent9 ? c.replace("医薬品・領収書の転送", "医薬品の転送") : c}</td></tr>`).join("")}</table>
    <p class="small" style="position:absolute;bottom:30px;right:40px">様式A（令和7年7月改定）</p></div></body></html>`;
}
function diagnosisHtml(p) {
  return `<html><head><style>${CSS(p.font)}</style></head><body><div class="pg">
    <p class="small">（原本は医薬品購送申込時に本省へ送付、写しは患者保管）</p><h1>診　断　書</h1>
    <table style="width:60%"><tr><td style="border:none">氏　名　　：</td><td style="border:none" class="v">${p.swap ? "A" + p.staff : p.name}</td></tr>
      <tr><td style="border:none">職員コード：</td><td style="border:none" class="v">${p.swap ? p.name : p.relation === "本人" ? "A" + p.staff : p.staff + "（" + p.relation + "）"}</td></tr></table>
    <p class="small">（館員家族の場合は職員コードに続柄を記入、例：xxxx（妻））</p>
    <table style="width:60%"><tr><td style="border:none">生年月日　　：</td><td style="border:none" class="v">昭和55年4月1日</td></tr><tr><td style="border:none">所　属　　：</td><td style="border:none" class="v">${p.mission}</td></tr></table>
    <table style="margin-top:10px"><tr><th>１．病名（慢性疾患）：</th></tr><tr><td class="v" style="height:70px">${p.diseases.map((d, i) => `（${i + 1}）${d}`).join("<br>")}</td></tr></table>
    <table style="margin-top:10px"><tr><th>２．服用薬・処方：</th></tr></table>
    <div class="v" style="padding:8px">${p.drugs.map((d, i) => `（${i + 1}）${d.name}${d.strength}${d.unit}　${d.usage}`).join("<br>")}</div>
    <p>上記にて上記２．を服用中であるが、服用にて症状は安定している。今後も上記医薬品の継続投与が必要であるが、成分等含め相当品が任地にて入手が困難であるので、本邦に購送依頼することが必要である。</p>
    <div style="display:flex;justify-content:space-between;margin-top:30px" class="v"><span>${wareki(p.issue)}</span><span>${p.mission}</span></div>
    <div style="margin-top:20px">医務官氏名：<span class="v">${p.doctor}</span>　　印（署名押印）</div>
    <div class="small" style="margin-top:30px;border-top:1px solid #333;padding-top:6px">【注意事項　患者・医師共通】　※必読※<br>診断書の有効期限は発行日から3ヶ月です。指示書と併せて提出してください。</div></div></body></html>`;
}
function instructionHtml(p) {
  return `<html><head><style>${CSS(p.font)}</style></head><body><div class="pg"><h1>指　　示　　書</h1>
    <div style="display:flex;justify-content:space-between" class="v"><span>${wareki(p.issue)}</span><span>${p.mission}</span></div>
    <div style="margin:14px 0">健康管理医　<span class="v">${p.doctor}</span>　印（署名押印）</div>
    <table style="width:70%"><tr><th colspan="2">患者</th></tr><tr><th>患者氏名</th><td class="v">${p.name}</td></tr><tr><th>フリガナ</th><td class="v">${p.kana}</td></tr><tr><th>生年月日</th><td class="v">昭和55年4月1日</td></tr></table>
    <p>上記の者に下記の医薬品の服用を指示します。</p><p style="text-align:center">記</p>
    <table><tr><th>薬品名</th><th>含有量</th><th>用法・用量</th><th>１日分使用量</th></tr>
      ${[0, 1, 2, 3].map(i => { const d = p.drugs[i]; return d ? `<tr class="v"><td>（${i + 1}）　${d.name}</td><td>${d.strength}${d.unit}</td><td>${d.usage}</td><td>${d.perDay}錠</td></tr>` : `<tr><td>（${i + 1}）</td><td></td><td></td><td></td></tr>`; }).join("")}</table>
    <div style="display:flex;justify-content:space-between;margin-top:10px"><span class="v">${p.days}　日分</span><span>□ 後発医薬品への変更不可</span></div>
    <div class="small" style="margin-top:30px;border-top:1px solid #333;padding-top:6px">【注意事項　患者・医師共通】　※必読※<br>指示書の原本は患者が保管し、療養費請求時に提出してください。</div></div></body></html>`;
}

module.exports = { people, applicationHtml, diagnosisHtml, instructionHtml, rng };
