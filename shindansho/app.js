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
  settings: Object.assign({ doctorName: "", doctorPost: "", signRule: "2026-09-04", psychBan: "2026-10-01" }, load(KEY.settings, {})),
  customDrugs: load(KEY.drugs, []),
  doc: null,
  page: "edit",
};

// ======================================================================= マスタ

const nfkc = (s) => (s || "").normalize("NFKC");
const key = (s) => nfkc(s).replace(/[\s・／/（）()]/g, "").toLowerCase();

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

function postOptions() {
  const D = window.GEPPOU_DATA;
  if (!D) return [];
  return D.posts.map((p) => {
    const n = p.name;
    if (/総領事館$/.test(n)) return "在" + n.replace(/総領事館$/, "日本国総領事館");
    if (/(代表部|事務所)$/.test(n)) return n;
    return "在" + n + "日本国大使館";
  });
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
const USAGES = ["1日1回 朝食後", "1日1回 夕食後", "1日1回 就寝前", "1日2回 朝夕食後", "1日3回 毎食後", "1日1回 起床時", "疼痛時（頓用）", "その他"];

function newDrugRow() {
  return { name: "", strength: "", unit: "mg", form: "錠", perDose: 1, perDoseMax: "", times: 1, usage: USAGES[0], days: 30, noGeneric: false };
}
function newDoc() {
  return {
    id: "c" + Date.now().toString(36),
    patient: { name: "", kana: "", birth: "", sex: "", rel: "本人", staffCode: "", post: state.settings.doctorPost || "", postCode: "" },
    diagnoses: "",
    findings: "",
    drugs: [newDrugRow()],
    issueDate: today(),
    applyDate: "",
    doctor: { name: state.settings.doctorName || "", post: state.settings.doctorPost || "" },
    hospital: "",
    updatedAt: "",
  };
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
  const p = doc.patient;
  const s = state.settings;

  // 必須項目
  const req = [[p.name, "療養者氏名"], [p.birth, "生年月日"], [p.staffCode, "職員コード"], [p.post, "所属公館"],
    [doc.diagnoses.trim(), "病名"], [doc.issueDate, "発行日"], [doc.doctor.name, "医師氏名"]];
  for (const [v, label] of req) if (!v) add("error", "入力", `${label}が未入力です。`);

  // 職員コード
  if (p.staffCode) {
    const digits = nfkc(p.staffCode).replace(/^A/i, "");
    if (!/^\d+$/.test(digits)) add("error", "職員コード", "職員コードに数字以外の文字が含まれています（頭文字Aは可）。");
    else if (digits.length < 4 || digits.length > 8) add("check", "職員コード", `職員コードの桁数（${digits.length}桁）が通常と異なります。申込書と完全一致するか確認してください。`);
  }
  if (p.postCode && !/^\d+$/.test(nfkc(p.postCode))) add("check", "公館コード", "公館コードに数字以外の文字が含まれています。");

  // 公館名表記
  const posts = [p.post, doc.doctor.post].filter(Boolean);
  for (const n of posts) {
    if (/大使館/.test(n) && !/日本国大使館/.test(n)) add("minor", "公館名", `「${n}」：「日本国大使館」の表記揺れがないか確認してください。`);
    if (/総領事館/.test(n) && !/日本国総領事館/.test(n)) add("minor", "公館名", `「${n}」：「日本国総領事館」の表記揺れがないか確認してください。`);
    if (/在\s*日本国/.test(n) || /○|〇|＿/.test(n)) add("error", "公館名", `「${n}」：公館名に空欄（テンプレートの記入漏れ）があります。`);
  }
  if (p.post && doc.doctor.post && key(p.post) !== key(doc.doctor.post)) {
    add("check", "兼轄", `療養者の所属（${p.post}）と発行医の所属（${doc.doctor.post}）が異なります。兼轄・巡回の担当範囲か確認してください。`);
  }

  // 日付
  const issue = parseDate(doc.issueDate);
  if (issue && issue > parseDate(today())) add("check", "発行日", "発行日が未来の日付です。");
  if (doc.applyDate && issue) {
    const apply = parseDate(doc.applyDate);
    if (apply < issue) add("error", "日付", "申込予定日が発行日より前です（申込みは診断書・指示書に基づいて行う）。");
    else if (doc.applyDate > addMonths(doc.issueDate, 3)) add("error", "日付", "申込予定日が有効期限（発行日から3ヶ月）を過ぎています。");
  }
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
    if (!Number(r.perDose) || !Number(r.times)) add("error", where, "1回量・1日回数が未入力です（診断書・指示書に用法・用量が必要）。");
    if (r.perDoseMax) add("minor", where, `「${r.perDose}〜${r.perDoseMax}${countUnit(r)}で調節」は数量が確定しません。数量は上限側（${quantity(r)}${countUnit(r)}）で計算しています。`);
    if (window.EXCLUDED_FORMS.includes(r.form)) add("error", where, `剤形「${r.form}」は購送の対象外です（予防薬・液体・軟膏・座薬・ガス使用吸入薬）。`);
    if (r.usage === "疼痛時（頓用）") add("minor", where, "頓用は1日最大回数と総量を明記してください。");

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
      if (m.limit && days > m.limit) add("error", where, `${m.limit === 14 ? "新薬" : "向精神薬"}のため処方日数は${m.limit}日以内です（入力：${days}日）。`);
      if (m.psych) add("check", where, `向精神薬です。${wareki(s.psychBan)}以降は向精神薬の購送が全面禁止（基準日は要確認）。`);
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
    if (r.noGeneric && m && key(r.name) === key(m.name)) add("minor", where, "「後発医薬品への変更不可」なのに一般名で記載しています。");
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
  if (state.page === "edit") renderEdit(main);
  else if (state.page === "list") renderList(main);
  else renderSettings(main);
}

// ---------------------------------------------------------------- 作成

function field(label, path, value, attrs = "") {
  return `<label class="f"><span>${label}</span><input data-path="${path}" value="${esc(value)}" ${attrs}></label>`;
}
function selectField(label, path, value, options) {
  return `<label class="f"><span>${label}</span><select data-path="${path}">${options.map((o) => `<option${o === value ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;
}

function renderEdit(main) {
  const d = state.doc;
  const p = d.patient;
  main.innerHTML = `
  <div class="layout">
    <form id="form" class="formcol" autocomplete="off" onsubmit="return false">
      <section class="card">
        <h2>療養者</h2>
        <div class="fgrid">
          ${field("氏名", "patient.name", p.name)}
          ${field("ふりがな", "patient.kana", p.kana)}
          ${field("生年月日", "patient.birth", p.birth, 'type="date"')}
          ${selectField("性別", "patient.sex", p.sex, ["", "男", "女"])}
          ${selectField("続柄", "patient.rel", p.rel, RELATIONS)}
          ${field("職員コード（職員本人の番号）", "patient.staffCode", p.staffCode, 'inputmode="numeric"')}
          ${field("所属公館", "patient.post", p.post, 'list="posts" class="wide"')}
          ${field("公館コード", "patient.postCode", p.postCode, 'inputmode="numeric"')}
        </div>
        <p class="muted">家族の場合、職員コード欄は「${esc(staffCodeLabel({ staffCode: "12345", rel: "配偶者" }))}」のように続柄を自動で併記します。</p>
      </section>

      <section class="card">
        <h2>診断</h2>
        <label class="f"><span>病名（1行に1つ）</span><textarea data-path="diagnoses" rows="3">${esc(d.diagnoses)}</textarea></label>
        <label class="f"><span>経過・所見（任意）</span><textarea data-path="findings" rows="3">${esc(d.findings)}</textarea></label>
      </section>

      <section class="card">
        <div class="row between"><h2>処方</h2><button type="button" id="addDrug">＋ 薬を追加</button></div>
        <div id="drugs">${d.drugs.map(drugRowHtml).join("")}</div>
      </section>

      <section class="card">
        <h2>発行</h2>
        <div class="fgrid">
          ${field("発行日", "issueDate", d.issueDate, 'type="date"')}
          ${field("申込予定日（任意）", "applyDate", d.applyDate, 'type="date"')}
          ${field("医師氏名", "doctor.name", d.doctor.name)}
          ${field("発行医の所属公館（健康管理医）", "doctor.post", d.doctor.post, 'list="posts" class="wide"')}
          ${field("医療機関名（現地医療機関の場合）", "hospital", d.hospital, 'class="wide"')}
        </div>
        <p class="muted">有効期限：<b id="expiry">${d.issueDate ? wareki(addMonths(d.issueDate, 3)) + "まで（使用は1回限り）" : "—"}</b></p>
      </section>
      <datalist id="posts">${postOptions().map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
      <datalist id="druglist">${drugList().map((m) => `<option value="${esc(m.name)}">${esc([m.brand, m.cat].filter(Boolean).join("｜"))}</option>`).join("")}</datalist>
    </form>

    <aside class="sidecol">
      <section class="card sticky">
        <h2>チェック結果</h2>
        <div id="checks"></div>
        <div class="row">
          <button type="button" class="primary" data-print="both">診断書＋指示書を印刷</button>
        </div>
        <div class="row">
          <button type="button" data-print="shindan">診断書のみ</button>
          <button type="button" data-print="shiji">指示書のみ</button>
        </div>
        <div class="row">
          <button type="button" id="saveDoc">保存</button>
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
  $("#addDrug").onclick = () => { state.doc.drugs.push(newDrugRow()); render(); };
  main.querySelectorAll("[data-print]").forEach((b) => (b.onclick = () => printDocs(b.dataset.print)));
  $("#saveDoc").onclick = saveDoc;
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
      <label class="f"><span>1日回数</span><input type="number" min="0" data-path="drugs.${i}.times" value="${esc(r.times)}"></label>
      ${selectField("用法", `drugs.${i}.usage`, r.usage, USAGES)}
      <label class="f"><span>日数</span><input type="number" min="0" data-path="drugs.${i}.days" value="${esc(r.days)}"></label>
      <label class="f check"><input type="checkbox" data-path="drugs.${i}.noGeneric" ${r.noGeneric ? "checked" : ""}><span>後発品への変更不可</span></label>
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
  if (!path) return;
  const value = el.type === "checkbox" ? el.checked : el.value;
  setPath(state.doc, path, value);
  // 薬品名を選んだらマスタの単位・剤形・規格を補完する
  const mm = path.match(/^drugs\.(\d+)\.name$/);
  if (mm && e.type === "change") {
    const r = state.doc.drugs[Number(mm[1])];
    const m = findDrug(r.name);
    if (m) {
      r.unit = m.unit === "錠" ? "" : m.unit;
      r.form = formOf(m);
      if (m.strengths.length === 1 && !r.strength) r.strength = String(m.strengths[0]);
      if (m.cycle28 && r.days % 28) r.days = 28;
      if (m.limit && r.days > m.limit) r.days = m.limit;
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

function saveDoc() {
  const d = state.doc;
  d.updatedAt = new Date().toISOString();
  const i = state.cases.findIndex((c) => c.id === d.id);
  const copy = JSON.parse(JSON.stringify(d));
  if (i >= 0) state.cases[i] = copy; else state.cases.unshift(copy);
  if (save(KEY.cases, state.cases)) toast("保存しました"); else toast("保存できませんでした（ブラウザの保存領域を確認してください）");
}

// ---------------------------------------------------------------- 印刷

function printDocs(which) {
  const d = state.doc;
  const errors = runChecks(d).filter((r) => r.level === "error");
  if (errors.length && !confirm(`エラー相当の指摘が${errors.length}件あります。このまま印刷しますか？`)) return;
  const pages = [];
  if (which !== "shiji") pages.push(shindanHtml(d));
  if (which !== "shindan") pages.push(shijiHtml(d));
  $("#print").innerHTML = pages.join("");
  window.print();
}

function patientTable(d) {
  const p = d.patient;
  const a = age(p.birth, d.issueDate);
  return `
  <table class="pt">
    <tr><th>職員コード</th><td>${esc(staffCodeLabel(p))}</td><th>所属</th><td>${esc(p.post)}${p.postCode ? `（公館コード ${esc(p.postCode)}）` : ""}</td></tr>
    <tr><th>氏名</th><td>${p.kana ? `<small>${esc(p.kana)}</small><br>` : ""}${esc(p.name)}</td><th>続柄</th><td>${esc(p.rel)}</td></tr>
    <tr><th>生年月日</th><td>${wareki(p.birth)}${a !== null ? `（${a}歳）` : ""}</td><th>性別</th><td>${esc(p.sex)}</td></tr>
  </table>`;
}

function rxRows(d) {
  return d.drugs.filter((r) => r.name.trim()).map((r, i) => {
    const per = r.perDoseMax ? `${r.perDose}〜${r.perDoseMax}` : r.perDose;
    return `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(r.name)}　${esc(r.strength)}${esc(r.unit)}</td>
      <td>1回${esc(per)}${countUnit(r)}　${esc(r.usage)}</td>
      <td class="c">${esc(r.days)}日分</td>
      <td class="c">${quantity(r)}${countUnit(r)}</td>
      <td class="c">${r.noGeneric ? "✓" : ""}</td>
    </tr>`;
  }).join("");
}
const rxTable = (d) => `
  <table class="rx">
    <thead><tr><th>No.</th><th>医薬品名・規格</th><th>用法・用量</th><th>日数</th><th>総量</th><th>後発品<br>変更不可</th></tr></thead>
    <tbody>${rxRows(d)}</tbody>
  </table>`;

function signBlock(d, role) {
  return `
  <div class="sign">
    <p>${wareki(d.issueDate)}</p>
    ${d.hospital ? `<p>医療機関名　${esc(d.hospital)}</p>` : ""}
    <p>${role}　${esc(d.doctor.post)}</p>
    <p class="signline">医師氏名（自筆署名）<span class="blank"></span><span class="seal">印</span></p>
    ${d.doctor.name ? `<p class="small">（記名：${esc(d.doctor.name)}）</p>` : ""}
  </div>`;
}

function shindanHtml(d) {
  const diag = d.diagnoses.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return `
  <article class="sheet">
    <h1>診　断　書</h1>
    ${patientTable(d)}
    <table class="pt">
      <tr><th>病名</th><td>${diag.map((s, i) => `${diag.length > 1 ? `${i + 1}. ` : ""}${esc(s)}`).join("<br>")}</td></tr>
      ${d.findings ? `<tr><th>経過・所見</th><td>${esc(d.findings).replace(/\n/g, "<br>")}</td></tr>` : ""}
    </table>
    <h2>治療内容（処方）</h2>
    ${rxTable(d)}
    <p>上記のとおり診断し、上記医薬品による継続的な治療を要するものと認めます。</p>
    ${signBlock(d, "診断医")}
  </article>`;
}

function shijiHtml(d) {
  return `
  <article class="sheet">
    <p class="form-id">様式B</p>
    <h1>指　示　書</h1>
    ${patientTable(d)}
    <h2>処方内容</h2>
    ${rxTable(d)}
    <p class="small">有効期限：${wareki(addMonths(d.issueDate, 3))}まで（発行日から3ヶ月）。本指示書の使用は1回限りです。原本は本人が保管してください。</p>
    ${signBlock(d, "健康管理医")}
  </article>`;
}

// ---------------------------------------------------------------- 保存一覧

function renderList(main) {
  const rows = state.cases.map((c, i) => `
    <tr>
      <td>${esc(c.issueDate)}</td>
      <td>${esc(c.patient.name)}<br><span class="muted">${esc(staffCodeLabel(c.patient))}</span></td>
      <td>${esc(c.patient.post)}</td>
      <td>${esc(c.diagnoses.split(/\n+/).filter(Boolean).join("、"))}</td>
      <td>${c.drugs.filter((r) => r.name).map((r) => esc(r.name)).join("<br>")}</td>
      <td class="actions">
        <button data-open="${i}">開く</button>
        <button data-copy="${i}" title="同じ内容で発行日を今日にした新しい書類を作ります">前回から作成</button>
        <button class="danger" data-remove="${i}">削除</button>
      </td>
    </tr>`).join("");
  main.innerHTML = `
    <section class="card">
      <h2>保存した書類</h2>
      ${state.cases.length ? `<div class="table-wrap"><table><thead><tr><th>発行日</th><th>療養者</th><th>所属</th><th>病名</th><th>処方</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="muted">まだ保存した書類はありません。「作成」画面の「保存」で残せます。</p>`}
    </section>`;
  main.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.open) { state.doc = JSON.parse(JSON.stringify(state.cases[Number(b.dataset.open)])); state.page = "edit"; persistDraft(); render(); }
    if (b.dataset.copy) {
      const c = JSON.parse(JSON.stringify(state.cases[Number(b.dataset.copy)]));
      Object.assign(c, { id: "c" + Date.now().toString(36), issueDate: today(), applyDate: "", updatedAt: "" });
      state.doc = c; state.page = "edit"; persistDraft(); render(); toast("前回の内容をコピーしました。発行日を確認してください");
    }
    if (b.dataset.remove && confirm("この書類を削除しますか？")) { state.cases.splice(Number(b.dataset.remove), 1); save(KEY.cases, state.cases); render(); }
  };
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
        <label class="f"><span>向精神薬の購送禁止の開始日</span><input id="sPsych" type="date" value="${esc(s.psychBan)}"></label>
      </div>
      <datalist id="posts2">${postOptions().map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
      <div class="row"><button class="primary" id="sSave">保存</button></div>
    </section>

    <section class="card">
      <h2>薬剤マスタの追加・上書き</h2>
      <p class="muted">同じ薬品名を登録すると標準マスタを上書きします。新薬（薬価収載1年以内）は日数制限に14を入れてください。</p>
      <div class="fgrid">
        <label class="f"><span>薬品名</span><input id="mName" placeholder="例：〇〇錠"></label>
        <label class="f"><span>商品名</span><input id="mBrand"></label>
        <label class="f"><span>規格（／区切り）</span><input id="mStr" placeholder="5／10"></label>
        <label class="f"><span>単位</span><input id="mUnit" value="mg"></label>
        <label class="f"><span>1日上限</span><input id="mMax" inputmode="decimal"></label>
        <label class="f"><span>日数制限</span><select id="mLimit"><option value="">なし</option><option>14</option><option>30</option><option>90</option></select></label>
        <label class="f check"><input type="checkbox" id="mPsych"><span>向精神薬</span></label>
        <label class="f check"><input type="checkbox" id="mCycle"><span>28日周期</span></label>
        <label class="f wide"><span>適応病名（、区切り）</span><input id="mInd"></label>
      </div>
      <div class="row"><button id="mAdd">追加</button></div>
      ${state.customDrugs.length ? `<div class="table-wrap"><table><thead><tr><th>薬品名</th><th>規格</th><th>上限</th><th>制限</th><th>適応</th><th></th></tr></thead><tbody>
        ${state.customDrugs.map((m, i) => `<tr><td>${esc(m.name)}${m.brand ? `<br><span class="muted">${esc(m.brand)}</span>` : ""}</td><td>${m.strengths.join("／")}${esc(m.unit)}</td><td>${m.max}${esc(m.unit)}</td><td>${m.limit ? m.limit + "日" : ""}${m.psych ? " 向精神薬" : ""}${m.cycle28 ? " 28日周期" : ""}</td><td>${esc((m.ind || []).join("、"))}</td><td><button class="danger" data-mdel="${i}">削除</button></td></tr>`).join("")}
      </tbody></table></div>` : ""}
      <details><summary>標準マスタ（${window.DRUG_MASTER.length}品目）を見る</summary>
        <div class="table-wrap"><table><thead><tr><th>分類</th><th>薬品名</th><th>規格</th><th>上限/日</th><th>制限</th><th>適応</th><th>備考</th></tr></thead><tbody>
        ${window.DRUG_MASTER.map((m) => `<tr><td>${esc(m.cat || "")}</td><td>${esc(m.name)}<br><span class="muted">${esc(m.brand || "")}</span></td><td>${m.strengths.join("／")}${esc(m.unit)}</td><td>${m.max ? m.max + esc(m.unit) : "—"}</td><td>${m.limit ? m.limit + "日" : ""}${m.cycle28 ? "28日周期" : ""}</td><td>${esc(m.ind.join("、"))}</td><td>${esc(m.note || "")}</td></tr>`).join("")}
        </tbody></table></div>
      </details>
    </section>

    <section class="card">
      <h2>バックアップ</h2>
      <p class="muted">保存した書類・設定・追加マスタはこのブラウザにだけ保存されています。別のPCで使うときは書き出したファイルを読み込んでください。</p>
      <div class="row">
        <button id="bExport">書き出し（JSON）</button>
        <label class="btn">読み込み<input type="file" id="bImport" accept=".json,application/json" hidden></label>
        <button id="bSample">サンプルを入力</button>
      </div>
    </section>`;

  $("#sSave").onclick = () => {
    Object.assign(state.settings, { doctorName: $("#sDoctor").value.trim(), doctorPost: $("#sPost").value.trim(), signRule: $("#sSign").value || "2026-09-04", psychBan: $("#sPsych").value || "2026-10-01" });
    save(KEY.settings, state.settings); toast("設定を保存しました");
  };
  $("#mAdd").onclick = () => {
    const name = $("#mName").value.trim();
    const strengths = nfkc($("#mStr").value).split(/[\/,、\s]+/).map(Number).filter((v) => v > 0);
    const max = Number(nfkc($("#mMax").value));
    if (!name || !strengths.length || !max) { toast("薬品名・規格・1日上限を入力してください"); return; }
    const m = { name, brand: $("#mBrand").value.trim(), strengths, unit: $("#mUnit").value.trim() || "mg", max,
      limit: Number($("#mLimit").value) || null, psych: $("#mPsych").checked, cycle28: $("#mCycle").checked,
      ind: nfkc($("#mInd").value).split(/[、,]+/).map((s) => s.trim()).filter(Boolean) };
    state.customDrugs = state.customDrugs.filter((d) => key(d.name) !== key(name));
    state.customDrugs.push(m);
    save(KEY.drugs, state.customDrugs); render(); toast("マスタに追加しました");
  };
  main.querySelectorAll("[data-mdel]").forEach((b) => (b.onclick = () => { state.customDrugs.splice(Number(b.dataset.mdel), 1); save(KEY.drugs, state.customDrugs); render(); }));
  $("#bExport").onclick = () => {
    const blob = new Blob([JSON.stringify({ version: 1, cases: state.cases, settings: state.settings, customDrugs: state.customDrugs }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `shindansho-backup-${today()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("#bImport").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const ids = new Set(state.cases.map((c) => c.id));
      state.cases = [...state.cases, ...(j.cases || []).filter((c) => !ids.has(c.id))];
      if (j.settings) Object.assign(state.settings, j.settings);
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
  Object.assign(d.patient, { name: "外務 花子", kana: "がいむ はなこ", birth: "1985-04-12", sex: "女", rel: "配偶者", staffCode: "123456", post: "在タイ日本国大使館", postCode: "1234" });
  d.diagnoses = "高血圧症\n月経困難症";
  d.drugs = [
    { ...newDrugRow(), name: "アムロジピン錠", strength: "10", unit: "mg", perDose: 2, times: 1, days: 90 },
    { ...newDrugRow(), name: "ドロスピレノン・エチニルエストラジオール錠", strength: "", unit: "", perDose: 1, times: 1, days: 100 },
  ];
  d.doctor = { name: "医務 太郎", post: "在タイ日本国大使館" };
  return d;
}

// ======================================================================= 起動

document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => { state.page = b.dataset.page; render(); }));
state.doc = load(KEY.draft, null) || newDoc();
render();
