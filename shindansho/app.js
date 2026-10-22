/* 診断書・指示書 作成支援（ブラウザ版）
 * 個人用医薬品購送で使う診断書・指示書（様式B）を入力フォームから作成し、
 * 在外療養費書類レビューのチェック項目で入力時点の不備を洗い出す。
 * 入力内容はこのブラウザの localStorage にだけ保存される（「設定」からJSONで書き出し・読み込み可）。
 */
"use strict";

// ======================================================================= 保存

const KEY = { cases: "shindansho.cases", settings: "shindansho.settings", drugs: "shindansho.customDrugs", draft: "shindansho.draft" };
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

const state = {
  cases: load(KEY.cases, []),
  settings: Object.assign({ doctorName: "", doctorPost: "", signRule: "2026-09-04" }, load(KEY.settings, {})),
  customDrugs: load(KEY.drugs, []),
  doc: null,
  page: "edit",
};

// ======================================================================= マスタ

const nfkc = (s) => (s || "").normalize("NFKC");
const key = (s) => nfkc(s).replace(/[\s・／/（）()]/g, "").toLowerCase();

// 法律で規制されている薬（向精神薬・麻薬・覚醒剤原料など）は購送できない
function findBanned(name) {
  const k = key(name);
  if (!k) return null;
  const hit = window.BANNED_DRUGS.find((b) => b.stems.some((st) => k.includes(key(st))) && !(b.except || []).some((ex) => k.includes(key(ex))));
  return hit ? hit.law : null;
}

function drugList() {
  const custom = new Map(state.customDrugs.map((d) => [key(d.name), d]));
  const base = window.DRUG_MASTER.filter((d) => !custom.has(key(d.name)));
  return [...base, ...state.customDrugs];
}
function findDrug(name) {
  const k = key(name);
  if (!k) return null;
  const list = drugList();
  return list.find((d) => key(d.name) === k)
    || list.find((d) => (d.brand || "").split("／").some((b) => b && key(b) && (k.includes(key(b)) || key(b).includes(k))))
    || list.find((d) => k.includes(key(d.name).replace(/(錠|od錠|カプセル)$/, "")))
    || null;
}

// マスタの剤形（未指定なら薬品名の語尾から推定する）
function formOf(m) {
  if (m.form) return m.form;
  if (/カプセル$/.test(m.name)) return "カプセル";
  if (/OD錠$/.test(m.name)) return "OD錠";
  if (/(顆粒|散)$/.test(m.name)) return "散・顆粒";
  return "錠";
}

// ---- 在外公館コード（posts.js）
// 申込書の公館リストは「在タイ大使館」、診断書・指示書は「在タイ日本国大使館」の書き方なので、「日本国」の有無は区別しない
const postKey = (s) => nfkc(s).replace(/[\s　]/g, "").replace(/日本国/g, "").replace(/^在/, "");
const POSTS_BY_KEY = new Map();
const POSTS_BY_CODE = new Map();
for (const [code, name] of window.POST_CODES || []) {
  if (!POSTS_BY_KEY.has(postKey(name))) POSTS_BY_KEY.set(postKey(name), { code, name });
  if (!POSTS_BY_CODE.has(code)) POSTS_BY_CODE.set(code, name);
}
// 「タイ」「在タイ日本国大使館」「タイ大使館」などから公館を探す
function findPost(name) {
  const k = postKey(name);
  if (!k) return null;
  return POSTS_BY_KEY.get(k) || POSTS_BY_KEY.get(k + "大使館") || null;
}
const normCode = (c) => nfkc(c).trim().toUpperCase();
// 診断書・指示書の書き方（大使館・総領事館に「日本国」を入れる）
const displayPost = (name) => name.replace(/^在(.+?)(大使館|総領事館)$/, "在$1日本国$2");

function postOptions() {
  return (window.POST_CODES || []).map(([code, name]) => [displayPost(name), code]);
}

// ======================================================================= 日付

const pad = (n) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parseDate = (s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00") : null);
function wareki(s) {
  const d = parseDate(s);
  if (!d) return "　　年　　月　　日";
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (d >= new Date("2019-05-01T00:00:00")) return `令和${y - 2018 === 1 ? "元" : y - 2018}年${m}月${day}日`;
  if (d >= new Date("1989-01-08T00:00:00")) return `平成${y - 1988 === 1 ? "元" : y - 1988}年${m}月${day}日`;
  return `昭和${y - 1925}年${m}月${day}日`;
}
function addMonths(s, n) {
  const d = parseDate(s);
  if (!d) return "";
  const t = new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
  if (t.getDate() !== d.getDate()) t.setDate(0); // 月末の繰り下がりを防ぐ
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
function age(birth, at) {
  const b = parseDate(birth), a = parseDate(at) || new Date();
  if (!b) return null;
  let n = a.getFullYear() - b.getFullYear();
  if (a.getMonth() < b.getMonth() || (a.getMonth() === b.getMonth() && a.getDate() < b.getDate())) n--;
  return n;
}

// ======================================================================= 案件

const RELATIONS = ["本人", "配偶者", "夫", "妻", "子", "父", "母", "その他"];
// 用法・用量の選択肢（Excel版の「用法用量マスタ」と同じ）。先頭の「nX」が1日の回数
const USAGES = ["1X朝食後", "1X昼食後", "1X夕食後", "1X朝食前", "1X夕食前", "1X起床時", "1X就寝前（寝る前）", "2X朝夕食後", "2X朝夕食前", "2X朝・昼食後",
  "2X朝夕食後（12時間毎）", "3X毎食後", "3X毎食前", "3X毎食間", "3X朝昼夕食後", "4X6時間毎", "4X毎食後・就寝前", "頓服（症状出現時）", "頓服（疼痛時）",
  "頓服（不眠時）", "週1回", "週2回", "2週に1回", "1ヶ月に1回", "隔日1回", "1日おき", "透析後", "朝1回"];
const timesOf = (usage) => { const m = nfkc(usage).match(/^(\d+)X/i); return m ? Number(m[1]) : 1; };
// 以前の版の用法（「1日2回 朝夕食後」など）をExcel版の書き方に直す
const OLD_USAGES = { "1日1回 朝食後": "1X朝食後", "1日1回 夕食後": "1X夕食後", "1日1回 就寝前": "1X就寝前（寝る前）", "1日2回 朝夕食後": "2X朝夕食後",
  "1日3回 毎食後": "3X毎食後", "1日1回 起床時": "1X起床時", "疼痛時（頓用）": "頓服（疼痛時）" };

function newDrugRow(days = 30) {
  return { name: "", strength: "", unit: "mg", form: "錠", perDose: 1, perDoseMax: "", times: 1, usage: USAGES[0], days };
}
function newDoc() {
  return {
    id: newId(),
    patient: { name: "", kana: "", birth: "", sex: "", rel: "本人", staffCode: "", post: state.settings.doctorPost || "", postCode: "" },
    diagnoses: "",
    otherRx: "",
    drugs: [newDrugRow()],
    days: 30,
    noGeneric: false,
    print: { shindan: true, shiji: true },
    issueDate: today(),
    doctor: { name: state.settings.doctorName || "", post: state.settings.doctorPost || "" },
    updatedAt: "",
  };
}

// 以前の版で保存した書類を今の形にそろえる（日数・後発品変更不可は書類で1つ＝指示書の様式どおり）
function normalizeDoc(d) {
  if (d.days === undefined) d.days = Number(d.drugs[0] && d.drugs[0].days) || 30;
  if (d.noGeneric === undefined) d.noGeneric = d.drugs.some((r) => r.noGeneric);
  if (!d.print) d.print = { shindan: true, shiji: true };
  // 申込書の機能は廃止（以前の版で保存した書類から取り除く）
  delete d.app; delete d.applyDate; delete d.print.moushikomi;
  if (d.otherRx === undefined) d.otherRx = "";
  if (d.patient.post && !d.patient.postCode) d.patient.postCode = (findPost(d.patient.post) || {}).code || "";
  for (const r of d.drugs) {
    r.days = d.days;
    delete r.noGeneric;
    if (OLD_USAGES[r.usage]) r.usage = OLD_USAGES[r.usage];
    r.times = timesOf(r.usage);
  }
  // 印刷はExcel版と同じく診断書・指示書とも注意事項込みの1枚（裏面の選択は廃止）
  delete d.print.back;
  return d;
}

const dailyUnits = (r) => (Number(r.perDoseMax) || Number(r.perDose) || 0) * (Number(r.times) || 0);
const quantity = (r) => Math.ceil(dailyUnits(r) * (Number(r.days) || 0) - 1e-9);
const countUnit = (r) => (r.form === "カプセル" ? "カプセル" : r.form === "貼付剤" ? "枚" : r.form === "散・顆粒" ? "包" : "錠");
const staffCodeLabel = (p) => (p.staffCode ? p.staffCode + (p.rel && p.rel !== "本人" ? `（${p.rel}）` : "") : "");

// ======================================================================= チェック

// level: error = エラー相当, check = 要確認, minor = 要確認（軽微）
function runChecks(doc) {
  const out = [];
  const add = (level, where, msg) => out.push({ level, where, msg });
  normalizeDoc(doc);
  const p = doc.patient;
  const s = state.settings;

  // 必須項目
  const req = [[p.name, "療養者氏名"], [p.rel, "続柄"], [p.birth, "生年月日"], [p.staffCode, "職員コード"], [p.post, "所属公館"],
    [doc.diagnoses.trim(), "病名"], [doc.issueDate, "発行日"], [doc.doctor.name, "医師氏名"]];
  for (const [v, label] of req) if (!v) add("error", "入力", `${label}が未入力です。`);

  // 職員コード
  if (p.staffCode) {
    const digits = nfkc(p.staffCode).replace(/^A/i, "");
    if (!/^\d+$/.test(digits)) add("error", "職員コード", "職員コードに数字以外の文字が含まれています（頭文字Aは可）。");
    else if (digits.length < 4 || digits.length > 8) add("check", "職員コード", `職員コードの桁数（${digits.length}桁）が通常と異なります。申込書と完全一致するか確認してください。`);
  }
  if (p.postCode) {
    const code = normCode(p.postCode);
    const byCode = POSTS_BY_CODE.get(code);
    const byName = findPost(p.post);
    if (!/^\d{3}[A-Z]$/.test(code)) add("check", "公館コード", `公館コード「${p.postCode}」の形式が通常（数字3桁＋英字1字、例：612A）と異なります。`);
    else if (!byCode) add("check", "公館コード", `公館コード「${code}」は在外公館リストにありません。`);
    else if (byName && byName.code !== code) add("error", "公館コード", `公館コード「${code}」は${byCode}のコードです。所属公館（${p.post}）のコードは「${byName.code}」です。`);
  } else if (p.post) {
    add("check", "公館コード", "公館コードが未入力です（所属公館がリストにないと自動入力されません）。");
  }
  if (p.post && !findPost(p.post)) add("minor", "公館名", `「${p.post}」は在外公館リストにありません。表記を確認してください。`);

  // 公館名表記
  const posts = [p.post, doc.doctor.post].filter(Boolean);
  for (const n of posts) {
    if (/在\s*日本国/.test(n) || /○|〇|＿/.test(n)) add("error", "公館名", `「${n}」：公館名に空欄（テンプレートの記入漏れ）があります。`);
  }
  if (p.post && doc.doctor.post && postKey(p.post) === postKey(doc.doctor.post) && nfkc(p.post) !== nfkc(doc.doctor.post)) {
    add("minor", "公館名", `療養者の所属（${p.post}）と発行医の所属（${doc.doctor.post}）で公館名の表記が異なります。`);
  }
  if (p.post && doc.doctor.post && postKey(p.post) !== postKey(doc.doctor.post)) {
    add("check", "兼轄", `療養者の所属（${p.post}）と発行医の所属（${doc.doctor.post}）が異なります。兼轄・巡回の担当範囲か確認してください。`);
  }

  // 日付
  const issue = parseDate(doc.issueDate);
  if (issue && issue > parseDate(today())) add("check", "発行日", "発行日が未来の日付です。");
  if (issue && doc.issueDate >= s.signRule) {
    add("minor", "署名", `発行日が${wareki(s.signRule)}以降のため、診断書・指示書とも「自筆署名」と「押印」の両方が必要です（印刷後に記入）。`);
  }

  // 処方
  const drugs = doc.drugs.filter((r) => r.name.trim());
  if (!drugs.length) add("error", "処方", "処方薬が入力されていません。");
  const diagText = nfkc(doc.diagnoses);
  const seen = new Map();
  drugs.forEach((r, i) => {
    const where = `処方${i + 1}：${r.name}`;
    const m = findDrug(r.name);
    const st = Number(r.strength);
    const days = Number(r.days) || 0;

    if (!r.strength && !(m && m.unit === "錠")) add("error", where, "規格（含有量）が未入力です。");
    if (!days) add("error", where, "処方日数が未入力です。");
    if (!Number(r.perDose) || !r.usage) add("error", where, "1回量・用法が未入力です（診断書・指示書に用法・用量が必要）。");
    if (r.perDoseMax) add("minor", where, `「${r.perDose}〜${r.perDoseMax}${countUnit(r)}で調節」は数量が確定しません。数量は上限側（${quantity(r)}${countUnit(r)}）で計算しています。`);
    const banned = findBanned(r.name);
    if (banned) add("error", where, `${banned}のため購送できません。処方欄から削除してください（記録が必要なら「購送対象外の薬」欄へ）。`);
    if (window.EXCLUDED_FORMS.includes(r.form)) add("error", where, `剤形「${r.form}」は購送の対象外です。「購送対象外の薬（自由記載）」欄に移してください。`);
    if (/^頓服/.test(r.usage)) add("minor", where, "頓服は1日最大回数と総量を明記してください。");

    if (!m) {
      add("check", where, "薬剤マスタにありません。薬品名の実在・規格・1日上限・投薬期間制限・保険適応を個別に確認してください（「設定」でマスタに追加できます）。");
    } else {
      if (r.strength && m.strengths.length && !m.strengths.includes(st)) {
        add("error", where, `${m.name}に${r.strength}${m.unit}の規格はマスタ上ありません（${m.strengths.join("／")}${m.unit}）。規格が実在するか確認してください。`);
      }
      // ⑫ 1日用量の上限
      if (m.max && st && dailyUnits(r)) {
        const daily = m.unit === "錠" ? dailyUnits(r) : Math.round(st * dailyUnits(r) * 1000) / 1000;
        if (daily > m.max) add("error", where, `1日量 ${daily}${m.unit} が承認上限 ${m.max}${m.unit}/日 を超えています${m.note ? `（${m.note}）` : ""}。`);
        else if (m.note && daily === m.max) add("minor", where, `上限量です。適応による上限の違いに注意：${m.note}`);
      }
      // ⑦ 投薬期間制限
      if (m.limit && days > m.limit) add("error", where, `${m.limit === 14 ? "新薬" : "投薬期間制限"}のため処方日数は${m.limit}日以内です（入力：${days}日）。`);
      // 28日周期
      if (m.cycle28 && days % 28 !== 0) add("check", where, `28日周期の製剤です。処方日数を28の倍数（28・56・84日）にしてください（入力：${days}日）。`);
      // ⑬ 保険適応
      if (m.ind && m.ind.length && diagText && !m.ind.some((k) => diagText.includes(k))) {
        add("check", where, `病名に保険適応の病名が見当たりません（適応：${m.ind.join("、")}）。適応外であれば薬剤部へ確認してください。`);
      }
      if (m.note && /保険適応外/.test(m.note)) add("minor", where, m.note);
      const k = key(m.name);
      if (seen.has(k)) add("check", where, `処方${seen.get(k) + 1}と同じ成分です。重複していないか確認してください。`);
      seen.set(k, i);
    }
    if (days > 90) add("minor", where, `${days}日分は有効期限（3ヶ月）を超える処方です。`);
    if (doc.noGeneric && m && key(r.name) === key(m.name)) add("minor", where, "「後発医薬品への変更不可」なのに一般名で記載しています。");
  });

  return out;
}

// ======================================================================= 画面

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

function render() {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.page === state.page));
  const main = $("#main");
  state.rendering = true;
  try {
    if (state.page === "edit") renderEdit(main);
    else if (state.page === "list") renderList(main);
    else renderSettings(main);
  } finally {
    state.rendering = false;
  }
}

// ---------------------------------------------------------------- 作成

function field(label, path, value, attrs = "") {
  return `<label class="f"><span>${label}</span><input data-path="${path}" value="${esc(value)}" ${attrs}></label>`;
}
function selectField(label, path, value, options) {
  return `<label class="f"><span>${label}</span><select data-path="${path}">${options.map((o) => `<option${o === value ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;
}

function renderEdit(main) {
  const d = normalizeDoc(state.doc);
  const p = d.patient;
  const lastB = state.settings.lastBackup ? new Date(state.settings.lastBackup).toLocaleDateString("ja-JP") : "";
  main.innerHTML = `
  ${backupDue() ? `<div class="warnbox row between" id="backupBanner"><span>${lastB ? `最後のバックアップは${lastB}です。` : "まだバックアップしていません。"}保存データはこのブラウザの中だけにあるので、PCにも残しておきましょう。</span><button type="button" class="primary" data-backup>今すぐバックアップ</button></div>` : ""}
  <div class="layout">
    <form id="form" class="formcol" autocomplete="off" onsubmit="return false">
      <section class="card">
        <h2>療養者</h2>
        <div class="fgrid">
          ${field("氏名", "patient.name", p.name)}
          ${field("フリガナ", "patient.kana", p.kana)}
          ${field("生年月日", "patient.birth", p.birth, 'type="date"')}
          ${selectField("性別", "patient.sex", p.sex, ["", "男", "女"])}
          ${selectField("続柄", "patient.rel", p.rel, ["", ...RELATIONS])}
          ${field("職員コード（職員本人の番号）", "patient.staffCode", p.staffCode, 'inputmode="numeric"')}
          ${field("所属公館", "patient.post", p.post, 'list="posts" class="wide"')}
          ${field("公館コード（自動入力）", "patient.postCode", p.postCode, 'list="postcodes" placeholder="例：612A"')}
        </div>
        <p class="muted">家族の場合、職員コード欄は「${esc(staffCodeLabel({ staffCode: "12345", rel: "配偶者" }))}」のように続柄を自動で併記します。</p>
      </section>

      <section class="card">
        <h2>診断</h2>
        <label class="f"><span>病名（慢性疾患・1行に1つ）</span><textarea data-path="diagnoses" rows="3">${esc(d.diagnoses)}</textarea></label>
        <label class="f"><span>購送対象外の薬（自由記載・任意）　診断書にだけ記載し、指示書には載りません</span><textarea data-path="otherRx" rows="3" placeholder="例：ヘパリン類似物質油性クリーム 0.3% 1日2回 塗布／向精神薬・軟膏・液剤・坐剤・ガス使用吸入薬・予防薬など">${esc(d.otherRx || "")}</textarea></label>
      </section>

      <section class="card">
        <div class="row between"><h2>処方</h2><button type="button" id="addDrug">＋ 薬を追加</button></div>
        <div class="fgrid">
          <label class="f"><span>処方日数（全薬共通）</span><input type="number" min="0" data-path="days" value="${esc(d.days)}"></label>
          <label class="f check"><input type="checkbox" data-path="noGeneric" ${d.noGeneric ? "checked" : ""}><span>後発医薬品への変更不可</span></label>
        </div>
        <div id="drugs">${d.drugs.map(drugRowHtml).join("")}</div>
      </section>

      <section class="card">
        <h2>発行</h2>
        <div class="fgrid">
          ${field("発行日", "issueDate", d.issueDate, 'type="date"')}
          ${field("医師氏名", "doctor.name", d.doctor.name)}
          ${field("発行医の所属公館（健康管理医）", "doctor.post", d.doctor.post, 'list="posts" class="wide"')}
        </div>
        <p class="muted">有効期限：<b id="expiry">${d.issueDate ? wareki(addMonths(d.issueDate, 3)) + "まで（使用は1回限り）" : "—"}</b></p>
      </section>
      <datalist id="usages">${USAGES.map((u) => `<option value="${esc(u)}">`).join("")}</datalist>
      <datalist id="posts">${postOptions().map(([n, c]) => `<option value="${esc(n)}">${esc(c)}</option>`).join("")}</datalist>
      <datalist id="postcodes">${postOptions().map(([n, c]) => `<option value="${esc(c)}">${esc(n)}</option>`).join("")}</datalist>
      <datalist id="druglist">${drugList().map((m) => `<option value="${esc(m.name)}">${esc([m.brand, m.cat].filter(Boolean).join("｜"))}</option>`).join("")}</datalist>
    </form>

    <aside class="sidecol">
      <section class="card sticky">
        <h2>チェック結果</h2>
        <p class="disclaimer">チェックは入力の補助です。病名と処方の組み合わせは医務官ご自身の責任で確認してください。療養費請求の可否を保証するものではありません。</p>
        <div id="checks"></div>
        <h3>印刷する書類</h3>
        <div class="printopts">
          <label class="f check"><input type="checkbox" data-print-opt="shindan" ${d.print.shindan ? "checked" : ""}><span>診断書</span></label>
          <label class="f check"><input type="checkbox" data-print-opt="shiji" ${d.print.shiji ? "checked" : ""}><span>指示書（様式B）</span></label>
        </div>
        <div class="row"><button type="button" class="primary" id="printBtn">印刷</button></div>
        <h3>保存</h3>
        <p class="muted" id="saveState">${saveStateText(d)}</p>
        <div class="row">
          ${isSaved(d)
            ? `<button type="button" id="saveDoc" title="保存一覧の同じ書類を今の内容で置き換えます">上書き保存</button>
          <button type="button" id="saveAsDoc" title="元の書類は残したまま、今の内容を新しい書類として保存します">別の書類として保存</button>`
            : `<button type="button" id="saveDoc">保存</button>`}
        </div>
        <div class="row">
          <button type="button" id="newPerson" title="職員コード・所属公館・医師・発行日を引き継いで、別の人の書類を作ります">別の人を登録</button>
          <button type="button" id="newDoc">新規</button>
        </div>
        <p class="muted">印刷画面で「PDFに保存」を選ぶとPDFになります。署名・押印は印刷後に行ってください。</p>
      </section>
    </aside>
  </div>`;

  const form = $("#form");
  form.addEventListener("input", onInput);
  form.addEventListener("change", onInput);
  form.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { state.doc.drugs.splice(Number(del.dataset.del), 1); if (!state.doc.drugs.length) state.doc.drugs.push(newDrugRow()); render(); }
  });
  $("#addDrug").onclick = () => {
    if (state.doc.drugs.length >= MAX_DRUGS) { toast(`処方は${MAX_DRUGS}件までです（指示書の欄の数）`); return; }
    state.doc.drugs.push(newDrugRow(state.doc.days)); render();
  };
  main.querySelectorAll("[data-print-opt]").forEach((b) => (b.onchange = () => { state.doc.print[b.dataset.printOpt] = b.checked; persistDraft(); updateChecks(); }));
  $("#printBtn").onclick = printDocs;
  $("#saveDoc").onclick = () => saveDoc(false);
  if ($("#saveAsDoc")) $("#saveAsDoc").onclick = () => saveDoc(true);
  $("#newPerson").onclick = newPerson;
  main.querySelectorAll("[data-backup]").forEach((b) => (b.onclick = downloadBackup));
  $("#newDoc").onclick = () => { if (confirm("入力中の内容を消して新規作成しますか？（保存済みのものは残ります）")) { state.doc = newDoc(); persistDraft(); render(); } };
  updateChecks();
}

function drugRowHtml(r, i) {
  const m = findDrug(r.name);
  const strengths = m ? m.strengths : [];
  return `
  <div class="drug" data-i="${i}">
    <div class="drug-head">
      <span class="num">${i + 1}</span>
      <input class="dname" data-path="drugs.${i}.name" value="${esc(r.name)}" list="druglist" placeholder="薬品名（例：アムロジピン錠）">
      <button type="button" class="icon" data-del="${i}" title="この薬を削除">✕</button>
    </div>
    <div class="fgrid small">
      <label class="f"><span>規格</span><span class="unit-in"><input data-path="drugs.${i}.strength" value="${esc(r.strength)}" list="st${i}" inputmode="decimal"><input data-path="drugs.${i}.unit" value="${esc(r.unit)}" class="u"></span>
        <datalist id="st${i}">${strengths.map((v) => `<option value="${v}">`).join("")}</datalist></label>
      ${selectField("剤形", `drugs.${i}.form`, r.form, window.DRUG_FORMS)}
      <label class="f"><span>1回量</span><span class="unit-in"><input type="number" min="0" step="0.5" data-path="drugs.${i}.perDose" value="${esc(r.perDose)}">〜<input type="number" min="0" step="0.5" data-path="drugs.${i}.perDoseMax" value="${esc(r.perDoseMax)}" placeholder="上限"></span></label>
      <label class="f"><span>用法（選択または入力）</span><input data-path="drugs.${i}.usage" value="${esc(r.usage)}" list="usages"></label>
    </div>
    <p class="muted calc" id="calc${i}">${calcText(r)}</p>
  </div>`;
}

function calcText(r) {
  const m = findDrug(r.name);
  const st = Number(r.strength);
  const parts = [];
  if (m) parts.push(`マスタ：${m.name}${m.brand ? `（${m.brand}）` : ""}${m.max ? `・上限 ${m.max}${m.unit}/日` : ""}${m.limit ? `・${m.limit}日制限` : ""}`);
  if (dailyUnits(r)) {
    const daily = st && r.unit !== "錠" ? `${Math.round(st * dailyUnits(r) * 1000) / 1000}${r.unit}/日・` : "";
    parts.push(`${daily}総量 ${quantity(r)}${countUnit(r)}`);
  }
  return parts.join("　") || "&nbsp;";
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = value;
}

function onInput(e) {
  const el = e.target;
  const path = el.dataset.path;
  if (!path || state.rendering) return; // 再描画で入力欄が消えるときの blur による change は無視する
  const value = el.type === "checkbox" ? el.checked : el.value;
  setPath(state.doc, path, value);
  // 所属公館 ⇄ 公館コードを相互に自動入力する
  if (path === "patient.post") {
    const hit = findPost(value);
    if (hit) { state.doc.patient.postCode = hit.code; const c = document.querySelector('[data-path="patient.postCode"]'); if (c) c.value = hit.code; }
  }
  if (path === "patient.postCode" && e.type === "change") {
    const code = normCode(value);
    state.doc.patient.postCode = code; el.value = code;
    const name = POSTS_BY_CODE.get(code);
    const cur = findPost(state.doc.patient.post);
    if (name && (!cur || cur.code !== code)) {
      state.doc.patient.post = displayPost(name);
      const c = document.querySelector('[data-path="patient.post"]'); if (c) c.value = state.doc.patient.post;
    }
  }
  const um = path.match(/^drugs\.(\d+)\.usage$/);
  if (um) state.doc.drugs[Number(um[1])].times = timesOf(value);
  if (path === "days") {
    state.doc.drugs.forEach((r, i) => { r.days = value; const c = $("#calc" + i); if (c) c.innerHTML = calcText(r); });
  }
  // 薬品名を選んだらマスタの単位・剤形・規格を補完する
  const mm = path.match(/^drugs\.(\d+)\.name$/);
  if (mm && e.type === "change") {
    const r = state.doc.drugs[Number(mm[1])];
    const banned = findBanned(r.name);
    if (banned) {
      const msg = `「${r.name}」は${banned}のため購送できません。処方欄には入力できません。\n記録が必要な場合は「購送対象外の薬（自由記載）」欄に書いてください。`;
      r.name = "";
      persistDraft();
      render();
      setTimeout(() => alert(msg)); // 入力欄を置き換えてから出す（先に出すとフォーカスが外れて change が二重に走る）
      return;
    }
    const m = findDrug(r.name);
    if (m) {
      r.unit = m.unit === "錠" ? "" : m.unit;
      r.form = formOf(m);
      if (m.strengths.length === 1 && !r.strength) r.strength = String(m.strengths[0]);
      persistDraft();
      render();
      return;
    }
  }
  const di = path.match(/^drugs\.(\d+)\./);
  if (di) { const c = $("#calc" + di[1]); if (c) c.innerHTML = calcText(state.doc.drugs[Number(di[1])]); }
  if (path === "issueDate") $("#expiry").textContent = state.doc.issueDate ? wareki(addMonths(state.doc.issueDate, 3)) + "まで（使用は1回限り）" : "—";
  persistDraft();
  updateChecks();
}

const LEVEL = { error: ["エラー相当", "bad"], check: ["要確認", "warn"], minor: ["要確認（軽微）", "minor"] };
function updateChecks() {
  const box = $("#checks");
  if (!box) return;
  const res = runChecks(state.doc);
  const order = { error: 0, check: 1, minor: 2 };
  res.sort((a, b) => order[a.level] - order[b.level]);
  const n = (l) => res.filter((r) => r.level === l).length;
  box.innerHTML = `
    <div class="counts"><span class="pill bad">エラー相当 ${n("error")}</span><span class="pill warn">要確認 ${n("check")}</span><span class="pill minor">軽微 ${n("minor")}</span></div>
    ${res.length ? `<ul class="checks">${res.map((r) => `<li class="${LEVEL[r.level][1]}"><b>${LEVEL[r.level][0]}</b>　<span class="where">${esc(r.where)}</span><br>${esc(r.msg)}</li>`).join("")}</ul>`
      : `<div class="okbox">指摘はありません。</div>`}`;
}

function persistDraft() { save(KEY.draft, state.doc); }

const newId = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const isSaved = (d) => state.cases.some((c) => c.id === d.id);
function saveStateText(d) {
  const c = state.cases.find((x) => x.id === d.id);
  const n = d.patient.name ? state.cases.filter((x) => patientKey(x.patient) === patientKey(d.patient)).length : 0;
  const mine = n ? `この患者の保存書類：${n}件。` : "";
  return (c ? `保存一覧の書類を編集中（最終保存：${new Date(c.updatedAt).toLocaleString("ja-JP")}）。` : "まだ保存していない書類です。") + mine;
}

// asNew = true なら元の書類を残し、新しい書類として保存する（別名で保存）
function saveDoc(asNew) {
  const d = state.doc;
  if (asNew) d.id = newId();
  d.updatedAt = new Date().toISOString();
  const i = state.cases.findIndex((c) => c.id === d.id);
  const copy = JSON.parse(JSON.stringify(d));
  if (i >= 0) state.cases[i] = copy; else state.cases.unshift(copy);
  if (!save(KEY.cases, state.cases)) { toast("保存できませんでした（ブラウザの保存領域を確認してください）"); return; }
  persistDraft();
  render();
  const msg = asNew ? "別の書類として保存しました" : i >= 0 ? "上書き保存しました" : "保存しました";
  autoBackup().then((ok) => toast(ok ? `${msg}（バックアップフォルダにも書き出しました）` : msg));
}

// 別の人（同じ職員の家族など）の書類を作る。職員・所属・医師・発行日は引き継ぎ、本人の情報と病名・処方は空欄にする
function newPerson() {
  const d = state.doc;
  if (!confirm("別の人の書類を作ります。\n職員コード・所属公館・医師・発行日は引き継ぎ、氏名・生年月日などの本人の情報と病名・処方は空欄にします。\n（今の書類は、保存していなければ保存一覧には残りません）")) return;
  const n = newDoc();
  Object.assign(n.patient, { staffCode: d.patient.staffCode, post: d.patient.post, postCode: d.patient.postCode, rel: "" });
  Object.assign(n, { issueDate: d.issueDate, doctor: { ...d.doctor }, days: d.days, print: { ...d.print } });
  state.doc = n;
  persistDraft();
  render();
  toast("別の人の書類を作りました。氏名・続柄から入力してください");
  const f = document.querySelector('[data-path="patient.name"]');
  if (f) f.focus();
}

// ---------------------------------------------------------------- バックアップ
// 手動：JSONファイルをダウンロードする。
// 自動：Chrome / Edge では保存先フォルダを一度選ぶと、「保存」のたびにそのフォルダへ書き出す（File System Access API）。
// フォルダの指定は IndexedDB に残す（localStorage には保存できないため）。

const BACKUP_REMIND_DAYS = 7;
const canPickFolder = () => typeof window.showDirectoryPicker === "function";
const backupName = () => `shindansho-backup-${today()}.json`;
const backupJson = () => JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), cases: state.cases, settings: state.settings, customDrugs: state.customDrugs }, null, 1);

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("shindansho", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("kv", mode);
      const r = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(r && r.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const getBackupDir = () => idb("readonly", (st) => st.get("backupDir")).catch(() => null);
const setBackupDir = (h) => idb("readwrite", (st) => (h ? st.put(h, "backupDir") : st.delete("backupDir")));

function markBackedUp(where) {
  state.settings.lastBackup = new Date().toISOString();
  state.settings.lastBackupWhere = where;
  save(KEY.settings, state.settings);
  const b = $("#backupBanner");
  if (b) b.remove();
}

function downloadBackup() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([backupJson()], { type: "application/json" }));
  a.download = backupName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  markBackedUp("ダウンロード");
  toast("バックアップをダウンロードしました");
}

// 自動バックアップ先に書き出す。フォルダ未指定・権限なしなら false
async function autoBackup() {
  const dir = await getBackupDir();
  if (!dir) return false;
  try {
    let perm = await dir.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") perm = await dir.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") return false;
    const fh = await dir.getFileHandle(backupName(), { create: true });
    const w = await fh.createWritable();
    await w.write(backupJson());
    await w.close();
    markBackedUp(`フォルダ「${dir.name}」`);
    return true;
  } catch {
    toast("自動バックアップに失敗しました（「設定」で保存先フォルダを選び直してください）");
    return false;
  }
}

function backupDue() {
  if (!state.cases.length) return false;
  const last = Date.parse(state.settings.lastBackup || "");
  return !last || Date.now() - last > BACKUP_REMIND_DAYS * 864e5;
}

// ---------------------------------------------------------------- 印刷
// 診断書・指示書はExcel版（excel/shindansho-shijisho.xlsx の「診断書」「指示書」シート）と同じ並び・文言・配色で、
// 注意事項まで含めてそれぞれA4 1枚に収める。

const NOTES_SHINDAN = [
  "１．個人用医薬品購送依頼りん請の都度、本「診断書」も添付が必要。",
  "２．必ず署名押印をすること。",
  "３．本「診断書」は、福利厚生室にて保管の必要がある。",
  "４．本「診断書」の有効期限は３ヶ月で、使用回数は１回限り。",
  "５．向精神薬・睡眠薬は３０日、新薬は１４日の処方日数制限がある。",
];
const NOTES_SHINDAN_LAST = "６．本診断書原本は、医薬品購送申込時に本省へ送付すること。";
const NOTES_SHIJI = [
  "１．「診断書」を基に発給すること（指示書には病名を書かない）。",
  "２．購送できる医薬品は、錠剤、顆粒、粉末、貼り薬（湿布薬）、喘息用吸入薬（ガス不使用のものに限る）に限る。",
  "３．液体、軟膏、スプレー式、坐薬、冷所品等は購送不可（吸入薬はガス不使用のものに限り購送可）。",
  "４．必ず署名押印をすること。",
  "５．本「指示書」の有効期限は３ヶ月で、使用回数は１回限り。",
  "６．向精神薬・睡眠薬は３０日、新薬は１４日の処方日数制限がある。",
  "７．後発医薬品への変更の差し支えがあると判断した場合には、「後発医薬品への変更不可」に「☑」を記載すること。",
  "８．申込者は申し込み前に必ずオープンシェア福利厚生室HP個人用医薬品利用案内を読み、診断書指示書の内容を自身で確認・理解のうえ申込者自身の手によって９．のとおり手続きを行うこと。",
  "９．個人用医薬品購送申込書（様式Ａ）に本指示書（様式Ｂ）の「写」及び診断書【指示書に病名記載がないため、病名と服用薬の整合性を確認する必要があることから、診断書が必要】を添付し、封入の上、共済公信にて購送依頼をすること（メールでの申請は一切不可）。",
];
const NOTES_SHIJI_LAST = "１０．本指示書原本は、在外療養費請求時に本省へ送付すること（それまでは申込者が保管）。";
const MAX_DRUGS = 10; // Excel版の指示書と同じく10行まで

const zen = (v) => String(v).replace(/[0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const rxOf = (d) => d.drugs.filter((r) => r.name.trim());
const strengthText = (r) => (r.strength ? `${r.strength}${r.unit}` : "");
// 1日分使用量（Excel版と同じく「用法の回数×1回量」＋単位。調節可は範囲で出す）
const dailyText = (r) => {
  const lo = (Number(r.perDose) || 0) * (Number(r.times) || 0);
  return r.perDoseMax ? `${lo}〜${dailyUnits(r)}${countUnit(r)}` : `${lo}${countUnit(r)}`;
};
function seirekiDate(s, blank = "　　　　年　　月　　日") {
  const d = parseDate(s);
  return d ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` : blank;
}
// 公館名は在外公館リストの書き方（例：在タイ大使館）で出す
const officialPost = (name) => (findPost(name) || {}).name || name || "";

function printDocs() {
  const d = normalizeDoc(state.doc);
  const o = d.print;
  if (!o.shindan && !o.shiji) { toast("印刷する書類を選んでください"); return; }
  const banned = d.drugs.filter((r) => findBanned(r.name)).map((r) => r.name);
  if (banned.length) { alert(`購送できない薬が処方欄にあります（${banned.join("、")}）。削除してから印刷してください。`); return; }
  const errors = runChecks(d).filter((r) => r.level === "error");
  if (errors.length && !confirm(`エラー相当の指摘が${errors.length}件あります。このまま印刷しますか？`)) return;
  const pages = [];
  if (o.shindan) pages.push(shindanHtml(d));
  if (o.shiji) pages.push(shijiHtml(d));
  $("#print").innerHTML = pages.join("");
  window.print();
}

function shindanHtml(d) {
  const p = d.patient;
  const diag = d.diagnoses.split(/\n+/).map((s) => s.trim()).filter(Boolean).join("、");
  const rx = rxOf(d);
  const refs = rx.map((_, i) => `（${zen(i + 1)}）`).join("");
  const lines = rx.map((r, i) => `（${i + 1}）${esc(r.name)}${esc(strengthText(r))}　${esc(dailyText(r))}　${esc(r.usage)}`);
  const docPost = officialPost(d.doctor.post);
  return `
  <article class="sheet shindan">
    <p class="s-note">（原本は医薬品購送申込時に本省へ送付、写しは患者保管）</p>
    <h1>診　断　書</h1>
    <table class="kv">
      <tr><th>氏　名　　：</th><td>${esc(p.name)}</td></tr>
      <tr><th>職員コード：</th><td>${esc(staffCodeLabel(p))}</td></tr>
    </table>
    <p class="s-hint">（館員家族の場合は職員コードに続柄を記入、例：xxxx（妻））</p>
    <table class="kv">
      <tr><th>生年月日　　：</th><td>${esc(seirekiDate(p.birth, ""))}</td></tr>
      <tr><th>所　属　　：</th><td>${esc(officialPost(p.post))}</td></tr>
    </table>
    <table class="box">
      <tr><th>１．病名（慢性疾患）：</th></tr>
      <tr><td class="diag">${esc(diag)}</td></tr>
    </table>
    <table class="box">
      <tr><th>２．服用薬・処方：</th></tr>
    </table>
    <div class="rx">${lines.map((l) => `<p>${l}</p>`).join("")}
      ${d.otherRx.trim() ? `<p class="other">（購送対象外）${esc(d.otherRx).replace(/\n/g, "　")}</p>` : ""}</div>
    <p class="body">${esc(diag)}にて上記２．${refs}を服用中であるが、服用にて症状は安定している。今後も上記医薬品の継続投与が必要であるが、成分等含め相当品が任地にて入手が困難であるので、本邦に購送依頼することが必要である。</p>
    <div class="date-row"><span>${esc(seirekiDate(d.issueDate))}</span><span>${esc(docPost || "在　　　　　　　　　　　　　館")}</span></div>
    <div class="sign-row"><span>医務官氏名：<span class="blank"></span>印</span><span class="u">（署名押印）</span></div>
    <div class="notes">
      <p class="n-title">【注意事項　患者・医師共通】　※必読※</p>
      ${NOTES_SHINDAN.map((n) => `<p>${esc(n)}</p>`).join("")}
      <p class="n-last">${esc(NOTES_SHINDAN_LAST)}</p>
    </div>
  </article>`;
}

function shijiHtml(d) {
  const p = d.patient;
  const rx = rxOf(d);
  const docPost = officialPost(d.doctor.post);
  const rows = Array.from({ length: MAX_DRUGS }, (_, i) => {
    const r = rx[i];
    return r
      ? `<tr><td>（${i + 1}）　${esc(r.name)}</td><td>${esc(strengthText(r))}</td><td>${esc(r.usage)}</td><td>${esc(dailyText(r))}</td></tr>`
      : `<tr><td>（${i + 1}）</td><td></td><td></td><td></td></tr>`;
  }).join("");
  return `
  <article class="sheet shiji">
    <h1>指　　示　　書</h1>
    <div class="date-row"><span>${esc(seirekiDate(d.issueDate))}</span><span>${esc(docPost || "在　　　　　　　　　　　　　　　　　大使館")}</span></div>
    <div class="sign-row"><span>健康管理医<span class="blank"></span>印</span><span class="u">（署名押印）</span></div>
    <table class="pt">
      <tr><th colspan="2" class="hd">${esc(docPost)}</th></tr>
      <tr><th>患者氏名</th><td>${esc(p.name)}</td></tr>
      <tr><th>フリガナ</th><td>${esc(p.kana)}</td></tr>
      <tr><th>生年月日</th><td>${p.birth ? `西暦${esc(seirekiDate(p.birth))}` : "西暦　　年　　月　　日"}</td></tr>
    </table>
    <p>上記の者に下記の医薬品の服用を指示します。</p>
    <p class="c">記</p>
    <table class="rx">
      <colgroup><col style="width:34%"><col style="width:16%"><col style="width:26%"><col style="width:24%"></colgroup>
      <tr><th>薬品名</th><th>含有量</th><th>用法・用量</th><th>１日分使用量</th></tr>
      ${rows}
    </table>
    <div class="days-row"><span class="u">${esc(d.days)}　日分</span><span class="ng">${d.noGeneric ? "☑" : "□"} 後発医薬品への変更不可</span></div>
    <div class="notes">
      <p class="n-title">【注意事項　患者・医師共通】　※必読※</p>
      ${NOTES_SHIJI.map((n) => `<p>${esc(n)}</p>`).join("")}
      <p class="n-last">${esc(NOTES_SHIJI_LAST)}</p>
    </div>
  </article>`;
}

// ---------------------------------------------------------------- 保存一覧

// 保存した書類を患者ごとにまとめる（氏名・生年月日・職員コードが同じなら同じ患者）
const patientKey = (pt) => [key(pt.name), pt.birth || "", nfkc(pt.staffCode).replace(/^A/i, "")].join("|");
function patientGroups() {
  const groups = new Map();
  state.cases.forEach((c, i) => {
    const k = patientKey(c.patient);
    if (!groups.has(k)) groups.set(k, { key: k, items: [] });
    groups.get(k).items.push({ c, i });
  });
  const list = [...groups.values()];
  for (const g of list) {
    g.items.sort((x, y) => (y.c.issueDate || "").localeCompare(x.c.issueDate || "") || (y.c.updatedAt || "").localeCompare(x.c.updatedAt || ""));
    g.latest = g.items[0].c;
  }
  // 最近発行した書類のある患者から並べる
  return list.sort((x, y) => (y.latest.issueDate || "").localeCompare(x.latest.issueDate || ""));
}

function renderList(main) {
  const q = key(state.listQuery || "");
  const groups = patientGroups().filter((g) => !q || [g.latest.patient.name, g.latest.patient.kana, g.latest.patient.staffCode, g.latest.patient.post]
    .some((v) => key(v).includes(q)));
  const openAll = !!q || groups.length <= 3;
  const card = (g) => {
    const pt = g.latest.patient;
    const rows = g.items.map(({ c, i }) => `
      <tr>
        <td>${esc(seirekiDate(c.issueDate, "—"))}${c.transferredFrom ? `<br><span class="badge warn" title="${esc(new Date(c.transferredFrom.at).toLocaleString("ja-JP"))}に読み込み">移管元：${esc(officialPost(c.transferredFrom.post) || "不明")}</span>` : ""}</td>
        <td>${esc(c.diagnoses.split(/\n+/).filter(Boolean).join("、"))}</td>
        <td>${c.drugs.filter((r) => r.name).map((r) => `${esc(r.name)} ${esc(strengthText(r))}`).join("<br>")}</td>
        <td>${esc(c.days)}日分</td>
        <td class="actions">
          <button data-open="${i}">開く</button>
          <button data-copy="${i}" title="同じ内容で発行日を今日にした新しい書類を作ります">この内容で新規作成</button>
          <button class="danger" data-remove="${i}">削除</button>
        </td>
      </tr>`).join("");
    return `
    <details class="card patient" ${openAll ? "open" : ""}>
      <summary>
        <span class="p-name">${esc(pt.name || "（氏名未入力）")}</span>
        <span class="muted">${esc(pt.kana)}${pt.rel ? `　${esc(pt.rel)}` : ""}${pt.birth ? `　${esc(seirekiDate(pt.birth))}生` : ""}</span>
        <span class="muted">職員コード ${esc(pt.staffCode || "—")}　${esc(officialPost(pt.post))}</span>
        <span class="badge">${g.items.length}件・最新 ${esc(seirekiDate(g.latest.issueDate, "—"))}</span>
      </summary>
      <div class="row p-tools"><button type="button" data-export="${esc(g.key)}" title="異動先の公館へ送るため、パスワード付きのファイルに書き出します">移管用に書き出す</button></div>
      <div class="table-wrap"><table class="p-docs">
        <colgroup><col style="width:14%"><col style="width:20%"><col style="width:30%"><col style="width:8%"><col style="width:28%"></colgroup>
        <thead><tr><th>発行日</th><th>病名</th><th>処方</th><th>日数</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`;
  };
  main.innerHTML = `
    <section class="card">
      <div class="row between"><h2>保存一覧（患者ごと）</h2><span class="row"><span class="muted">患者 ${patientGroups().length}人・書類 ${state.cases.length}件</span><button type="button" id="importXfer" title="前任地の公館から送られた移管データ（パスワード付き）を読み込みます">移管データを読み込む</button></span></div>
      ${state.cases.length ? `<input id="listQuery" type="search" placeholder="氏名・フリガナ・職員コード・公館で絞り込み" value="${esc(state.listQuery || "")}" style="width:100%">` : ""}
    </section>
    ${state.cases.length
      ? groups.map(card).join("") || `<p class="muted">該当する患者はいません。</p>`
      : `<p class="muted">まだ保存した書類はありません。「作成」画面の「保存」で残せます。同じ患者（氏名・生年月日・職員コードが同じ）の書類はここで1人分にまとまります。</p>`}`;
  const qi = $("#listQuery");
  if (qi) qi.oninput = () => {
    state.listQuery = qi.value;
    const pos = qi.selectionStart;
    render();
    const n = $("#listQuery"); n.focus(); n.setSelectionRange(pos, pos);
  };
  main.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "importXfer") pickTransferFile();
    if (b.dataset.export) exportTransfer(b.dataset.export);
    if (b.dataset.open) { state.doc = JSON.parse(JSON.stringify(state.cases[Number(b.dataset.open)])); state.page = "edit"; persistDraft(); render(); }
    if (b.dataset.copy) {
      const c = JSON.parse(JSON.stringify(state.cases[Number(b.dataset.copy)]));
      Object.assign(c, { id: newId(), issueDate: today(), updatedAt: "" });
      state.doc = c; state.page = "edit"; persistDraft(); render(); toast("前回の内容をコピーしました。発行日を確認してください");
    }
    if (b.dataset.remove && confirm("この書類を削除しますか？")) { state.cases.splice(Number(b.dataset.remove), 1); save(KEY.cases, state.cases); autoBackup(); render(); }
  };
}

// ---------------------------------------------------------------- 移管（患者の異動先の公館へ引き継ぐ）
// 患者の書類をパスワードで暗号化した1つのファイルに書き出し、異動先の公館のアプリで読み込む。
// 暗号化はブラウザ内（Web Crypto）で行う：PBKDF2-SHA256 で鍵を作り AES-GCM 256bit で暗号化。
// ファイルの外側（暗号化していない部分）には個人情報を入れない。

const XFER_FORMAT = "shindansho-transfer";
const XFER_ITER = 600000;
const APP_URL = "https://ysk713.github.io/-/shindansho/";

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptTransfer(payload, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await deriveKey(password, salt, XFER_ITER);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(JSON.stringify(payload)));
  return { format: XFER_FORMAT, version: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: XFER_ITER }, cipher: "AES-GCM",
    salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

async function decryptTransfer(file, password) {
  const k = await deriveKey(password, fromB64(file.salt), file.kdf.iterations);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(file.iv) }, k, fromB64(file.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// 読み間違えやすい文字（0/O、1/l/I など）を除いて12文字
function makePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint32Array(12));
  return [...r].map((n) => chars[n % chars.length]).join("").replace(/(.{4})(?!$)/g, "$1-");
}

function openDialog(html) {
  const dlg = $("#dlg");
  dlg.innerHTML = html;
  dlg.showModal();
  return dlg;
}

// 書き出し：選んだ患者（既定は同じ職員コードの家族全員）の書類すべて
function exportTransfer(groupKey) {
  const groups = patientGroups();
  const g0 = groups.find((g) => g.key === groupKey);
  const code = nfkc(g0.latest.patient.staffCode).replace(/^A/i, "");
  const family = groups.filter((g) => g.key === groupKey || (code && nfkc(g.latest.patient.staffCode).replace(/^A/i, "") === code));
  const pw = makePassword();
  const dlg = openDialog(`
    <form method="dialog" class="xfer">
      <h2>移管データの書き出し</h2>
      <p class="muted">異動先の公館で読み込めるよう、選んだ患者の書類をパスワード付きの1つのファイルにまとめます。</p>
      <h3>書き出す患者</h3>
      ${family.map((g) => `<label class="f check"><input type="checkbox" name="pt" value="${esc(g.key)}" checked>
        <span>${esc(g.latest.patient.name || "（氏名未入力）")}（${esc(g.latest.patient.rel || "続柄未入力")}）　書類${g.items.length}件</span></label>`).join("")}
      ${family.length > 1 ? `<p class="muted">同じ職員コードの家族も選んであります。不要な人はチェックを外してください。</p>` : ""}
      <h3>パスワード</h3>
      <div class="row"><input id="xPw" type="text" value="${esc(pw)}" autocomplete="off" spellcheck="false" class="pw"><button type="button" id="xGen">作り直す</button><button type="button" id="xCopy">コピー</button></div>
      <p class="muted">自分で決める場合は8文字以上にしてください。<b>パスワードはファイルとは別の手段（電話、別のメールなど）で相手に伝えてください。</b></p>
      <p class="warnbox" id="xMsg" hidden></p>
      <div class="row">
        <button type="button" class="primary" id="xDownload">書き出す（ダウンロード）</button>
        <button type="button" id="xShare" hidden>メールなどで送る</button>
        <button type="button" id="xMail">メールの下書きを開く</button>
        <button value="cancel">閉じる</button>
      </div>
      <p class="muted">「メールの下書きを開く」では添付はされません。ダウンロードしたファイルを下書きに添付してください。</p>
    </form>`);
  $("#xGen").onclick = () => { $("#xPw").value = makePassword(); };
  $("#xCopy").onclick = async () => { try { await navigator.clipboard.writeText($("#xPw").value); toast("パスワードをコピーしました"); } catch { $("#xPw").select(); } };
  const msg = (t) => { const m = $("#xMsg"); m.textContent = t; m.hidden = !t; };

  async function build() {
    const keys = [...dlg.querySelectorAll('input[name="pt"]:checked')].map((x) => x.value);
    const password = $("#xPw").value.trim();
    if (!keys.length) { msg("書き出す患者を選んでください。"); return null; }
    if (password.length < 8) { msg("パスワードは8文字以上にしてください。"); return null; }
    msg("");
    const cases = groups.filter((g) => keys.includes(g.key)).flatMap((g) => g.items.map(({ c }) => c));
    const last = cases.reduce((x, y) => ((y.issueDate || "") > (x.issueDate || "") ? y : x), cases[0]);
    const from = { post: state.settings.doctorPost || last.doctor.post || last.patient.post || "", doctor: state.settings.doctorName || last.doctor.name || "" };
    const payload = { kind: "transfer", exportedAt: new Date().toISOString(), from, cases };
    const file = await encryptTransfer(payload, password);
    const name = `shindansho-ikan-${today()}-${Math.random().toString(36).slice(2, 6)}.json`;
    return { file: new File([JSON.stringify(file)], name, { type: "application/json" }), count: cases.length, people: keys.length };
  }
  $("#xDownload").onclick = async () => {
    const r = await build();
    if (!r) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(r.file); a.download = r.file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    msg(`${r.people}人・書類${r.count}件を「${r.file.name}」に書き出しました。メールに添付して送り、パスワードは別の手段で伝えてください。`);
  };
  if (navigator.canShare && navigator.canShare({ files: [new File(["x"], "x.json", { type: "application/json" })] })) {
    $("#xShare").hidden = false;
    $("#xShare").onclick = async () => {
      const r = await build();
      if (!r) return;
      try {
        await navigator.share({ files: [r.file], title: "診断書・指示書 移管データ", text: mailBody() });
      } catch (e) { if (e.name !== "AbortError") msg("この端末では送信できませんでした。「書き出す」でダウンロードしてから添付してください。"); }
    };
  }
  $("#xMail").onclick = () => {
    location.href = `mailto:?subject=${encodeURIComponent("診断書・指示書 移管データの送付")}&body=${encodeURIComponent(mailBody())}`;
  };
}

// メール本文には個人情報を書かない
const mailBody = () => `診断書・指示書作成支援アプリの移管データ（パスワード付き）を送付します。

1. 添付ファイルを保存してください。
2. ${APP_URL} を開き、「保存一覧」→「移管データを読み込む」で添付ファイルを選んでください。
3. パスワードは別途お知らせします。

※ 添付ファイルは暗号化されています。パスワードはこのメールには記載していません。`;

// 読み込み：パスワードを聞いて復号し、保存一覧に加える（同じ書類が既にあれば加えない）
function importTransfer(file) {
  const dlg = openDialog(`
    <form method="dialog" class="xfer">
      <h2>移管データの読み込み</h2>
      <p class="muted">送り元から別に伝えられたパスワードを入力してください。</p>
      <div class="row"><input id="iPw" type="password" autocomplete="off" class="pw" placeholder="パスワード"><button type="button" class="primary" id="iGo">読み込む</button><button value="cancel">閉じる</button></div>
      <p class="warnbox" id="iMsg" hidden></p>
    </form>`);
  const go = async () => {
    const m = $("#iMsg");
    m.hidden = false; m.textContent = "確認しています…";
    let payload;
    try { payload = await decryptTransfer(file, $("#iPw").value.trim()); }
    catch { m.textContent = "パスワードが違うか、ファイルが壊れています。"; return; }
    const ids = new Set(state.cases.map((c) => c.id));
    const from = payload.from || {};
    const added = (payload.cases || []).filter((c) => !ids.has(c.id)).map((c) => normalizeDoc({ ...c, transferredFrom: { post: from.post || "", doctor: from.doctor || "", at: new Date().toISOString() } }));
    state.cases = [...added, ...state.cases];
    save(KEY.cases, state.cases);
    autoBackup();
    const names = [...new Set(added.map((c) => c.patient.name))];
    dlg.close();
    state.listQuery = names.length === 1 ? names[0] : "";
    state.page = "list";
    render();
    toast(added.length ? `${names.join("、")}さんの書類${added.length}件を読み込みました` : "すべて読み込み済みの書類でした（追加はありません）");
  };
  $("#iGo").onclick = go;
  $("#iPw").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } };
  $("#iPw").focus();
}

function pickTransferFile() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = ".json,application/json";
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (j.format === XFER_FORMAT) { importTransfer(j); return; }
      if (j.format !== XFER_FORMAT) { toast("移管データのファイルではありません（バックアップは「設定」→「読み込み」から）"); return; }
      importTransfer(j);
    } catch { toast("ファイルを読めませんでした"); }
  };
  inp.click();
}

// ---------------------------------------------------------------- 設定

function renderSettings(main) {
  const s = state.settings;
  main.innerHTML = `
    <section class="card">
      <h2>医師情報（新規作成時の初期値）</h2>
      <div class="fgrid">
        <label class="f"><span>医師氏名</span><input id="sDoctor" value="${esc(s.doctorName)}"></label>
        <label class="f"><span>所属公館</span><input id="sPost" value="${esc(s.doctorPost)}" list="posts2" class="wide"></label>
        <label class="f"><span>自筆署名＋押印が必要になる発行日</span><input id="sSign" type="date" value="${esc(s.signRule)}"></label>
      </div>
      <datalist id="posts2">${postOptions().map(([n, c]) => `<option value="${esc(n)}">${esc(c)}</option>`).join("")}</datalist>
      <div class="row"><button class="primary" id="sSave">保存</button></div>
    </section>

    <section class="card">
      <h2>薬剤マスタの追加・上書き</h2>
      <p class="muted">同じ薬品名を登録すると標準マスタを上書きします。新薬（薬価収載1年以内）は日数制限に14を入れてください。向精神薬・麻薬など法律で規制されている薬は登録できません。</p>
      <div class="fgrid">
        <label class="f"><span>薬品名</span><input id="mName" placeholder="例：〇〇錠"></label>
        <label class="f"><span>商品名</span><input id="mBrand"></label>
        <label class="f"><span>規格（／区切り）</span><input id="mStr" placeholder="5／10"></label>
        <label class="f"><span>単位</span><input id="mUnit" value="mg"></label>
        <label class="f"><span>1日上限</span><input id="mMax" inputmode="decimal"></label>
        <label class="f"><span>日数制限</span><select id="mLimit"><option value="">なし</option><option>14</option></select></label>
        <label class="f check"><input type="checkbox" id="mCycle"><span>28日周期</span></label>
        <label class="f wide"><span>適応病名（、区切り）</span><input id="mInd"></label>
      </div>
      <div class="row"><button id="mAdd">追加</button></div>
      ${state.customDrugs.length ? `<div class="table-wrap"><table><thead><tr><th>薬品名</th><th>規格</th><th>上限</th><th>制限</th><th>適応</th><th></th></tr></thead><tbody>
        ${state.customDrugs.map((m, i) => `<tr><td>${esc(m.name)}${m.brand ? `<br><span class="muted">${esc(m.brand)}</span>` : ""}</td><td>${m.strengths.join("／")}${esc(m.unit)}</td><td>${m.max}${esc(m.unit)}</td><td>${m.limit ? m.limit + "日" : ""}${m.cycle28 ? " 28日周期" : ""}</td><td>${esc((m.ind || []).join("、"))}</td><td><button class="danger" data-mdel="${i}">削除</button></td></tr>`).join("")}
      </tbody></table></div>` : ""}
      <details><summary>標準マスタ（${window.DRUG_MASTER.length}品目）を見る</summary>
        <div class="table-wrap"><table><thead><tr><th>分類</th><th>薬品名</th><th>規格</th><th>上限/日</th><th>制限</th><th>適応</th><th>備考</th></tr></thead><tbody>
        ${window.DRUG_MASTER.map((m) => `<tr><td>${esc(m.cat || "")}</td><td>${esc(m.name)}<br><span class="muted">${esc(m.brand || "")}</span></td><td>${m.strengths.join("／")}${esc(m.unit)}</td><td>${m.max ? m.max + esc(m.unit) : "—"}</td><td>${m.limit ? m.limit + "日" : ""}${m.cycle28 ? "28日周期" : ""}</td><td>${esc(m.ind.join("、"))}</td><td>${esc(m.note || "")}</td></tr>`).join("")}
        </tbody></table></div>
      </details>
    </section>

    <section class="card">
      <h2>バックアップ</h2>
      <p class="muted">保存した書類・設定・追加マスタはこのブラウザにだけ保存されています。バックアップファイル（JSON）をPCに残しておけば、ブラウザのデータが消えても、別のPCでも「読み込み」で元に戻せます。</p>
      <p>最後のバックアップ：<b>${s.lastBackup ? `${new Date(s.lastBackup).toLocaleString("ja-JP")}（${esc(s.lastBackupWhere || "")}）` : "まだありません"}</b></p>
      <h3>自動バックアップ（Chrome・Edge）</h3>
      ${canPickFolder() ? `
      <p class="muted">PCのフォルダを一度選ぶと、「保存」や削除のたびに <code>shindansho-backup-日付.json</code> をそのフォルダへ自動で書き出します（同じ日は上書き）。ブラウザを開き直した後の最初の保存では、フォルダへのアクセス許可を求められます。</p>
      <div class="row"><span id="bDirName" class="muted">保存先：確認中…</span><button id="bPickDir">保存先フォルダを選ぶ</button><button id="bClearDir" hidden>自動バックアップをやめる</button></div>`
      : `<p class="muted">このブラウザはフォルダへの自動書き出しに対応していません（Chrome・Edgeで対応）。下の「バックアップをダウンロード」を使ってください。${BACKUP_REMIND_DAYS}日以上バックアップしていないと、作成画面にお知らせを出します。</p>`}
      <h3>手動</h3>
      <div class="row">
        <button id="bExport">バックアップをダウンロード</button>
        <label class="btn">読み込み<input type="file" id="bImport" accept=".json,application/json" hidden></label>
        <button id="bSample">サンプルを入力</button>
      </div>
    </section>`;

  $("#sSave").onclick = () => {
    Object.assign(state.settings, { doctorName: $("#sDoctor").value.trim(), doctorPost: $("#sPost").value.trim(), signRule: $("#sSign").value || "2026-09-04" });
    save(KEY.settings, state.settings); toast("設定を保存しました");
  };
  $("#mAdd").onclick = () => {
    const name = $("#mName").value.trim();
    const strengths = nfkc($("#mStr").value).split(/[\/,、\s]+/).map(Number).filter((v) => v > 0);
    const max = Number(nfkc($("#mMax").value));
    if (!name || !strengths.length || !max) { toast("薬品名・規格・1日上限を入力してください"); return; }
    const banned = findBanned(name) || findBanned($("#mBrand").value);
    if (banned) { alert(`${banned}のため購送できないので、マスタに登録できません。`); return; }
    const m = { name, brand: $("#mBrand").value.trim(), strengths, unit: $("#mUnit").value.trim() || "mg", max,
      limit: Number($("#mLimit").value) || null, cycle28: $("#mCycle").checked,
      ind: nfkc($("#mInd").value).split(/[、,]+/).map((s) => s.trim()).filter(Boolean) };
    state.customDrugs = state.customDrugs.filter((d) => key(d.name) !== key(name));
    state.customDrugs.push(m);
    save(KEY.drugs, state.customDrugs); render(); toast("マスタに追加しました");
  };
  main.querySelectorAll("[data-mdel]").forEach((b) => (b.onclick = () => { state.customDrugs.splice(Number(b.dataset.mdel), 1); save(KEY.drugs, state.customDrugs); render(); }));
  $("#bExport").onclick = downloadBackup;
  if (canPickFolder()) {
    getBackupDir().then((dir) => {
      $("#bDirName").textContent = dir ? `保存先：${dir.name}` : "保存先：未設定";
      $("#bClearDir").hidden = !dir;
    });
    $("#bPickDir").onclick = async () => {
      try {
        const dir = await window.showDirectoryPicker({ id: "shindansho-backup", mode: "readwrite" });
        await setBackupDir(dir);
        if (await autoBackup()) toast(`フォルダ「${dir.name}」にバックアップしました。以後は保存のたびに書き出します`);
        render();
      } catch { /* 選択を取り消した */ }
    };
    $("#bClearDir").onclick = async () => { await setBackupDir(null); toast("自動バックアップをやめました"); render(); };
  }
  $("#bImport").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const ids = new Set(state.cases.map((c) => c.id));
      state.cases = [...state.cases, ...(j.cases || []).filter((c) => !ids.has(c.id))];
      if (j.settings) Object.assign(state.settings, j.settings, { lastBackup: state.settings.lastBackup, lastBackupWhere: state.settings.lastBackupWhere });
      if (j.customDrugs) state.customDrugs = j.customDrugs;
      save(KEY.cases, state.cases); save(KEY.settings, state.settings); save(KEY.drugs, state.customDrugs);
      render(); toast("読み込みました");
    } catch { toast("読み込めませんでした（JSONの形式を確認してください）"); }
  };
  $("#bSample").onclick = () => {
    state.doc = sampleDoc(); state.page = "edit"; persistDraft(); render(); toast("架空のサンプルを入力しました");
  };
}

function sampleDoc() {
  const d = newDoc();
  Object.assign(d.patient, { name: "外務 花子", kana: "がいむ はなこ", birth: "1985-04-12", sex: "女", rel: "配偶者", staffCode: "123456", post: "在タイ日本国大使館", postCode: "612A" });
  d.diagnoses = "高血圧症\n月経困難症";
  d.otherRx = "ヘパリン類似物質油性クリーム0.3%　1日2回 塗布（外用薬）";
  d.days = 84;
  d.drugs = [
    { ...newDrugRow(84), name: "アムロジピン錠", strength: "5", unit: "mg", perDose: 1, times: 1 },
    { ...newDrugRow(84), name: "ドロスピレノン・エチニルエストラジオール錠", strength: "", unit: "", perDose: 1, times: 1 },
  ];
  d.doctor = { name: "医務 太郎", post: "在タイ日本国大使館" };
  return d;
}

// ======================================================================= 起動

document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => { state.page = b.dataset.page; render(); }));
$("#topBackup").onclick = downloadBackup;
state.doc = normalizeDoc(load(KEY.draft, null) || newDoc());
persistDraft();
if (state.cases.some((c) => c.app || c.applyDate !== undefined)) { state.cases.forEach(normalizeDoc); save(KEY.cases, state.cases); }
// 免責事項（開くたびに確認を出し、ページ下部にも常に表示）
const DISCLAIMER = "本アプリ（Excel版を含む）は診断書・指示書の作成を補助するものです。チェック結果や薬剤マスタは参考情報であり、病名と処方の組み合わせ（保険適応・用量・日数など）は医務官ご自身の責任で確認してください。療養費請求の可否や、その責任を保証するものではありません。";
$("#disclaimer").textContent = DISCLAIMER;
alert(`ご利用にあたって\n\n${DISCLAIMER}`);
render();
