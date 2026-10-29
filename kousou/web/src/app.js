/* 購送書類審査（ブラウザ単体版）。外部通信なし。判定ロジックは rules.js。 */
(function () {
  "use strict";
  const { Reviewer, ERROR, CHECK, MINOR, INFO, SEV_ORDER, norm } = window.KousouRules;
  const TYPES = ["申込書", "診断書", "指示書", "委任状", "その他", "白紙"];
  const DOC_ORDER = { "申込書": 0, "診断書": 1, "指示書": 2, "委任状": 3, "その他": 4 };
  const KEY_TYPES = { "1": "申込書", "2": "診断書", "3": "指示書", "4": "委任状", "5": "その他", "0": "白紙" };
  const BLANK_RATIO = 0.005, INK_TH = 160;
  const SEV_CLASS = { [ERROR]: "s-err", [CHECK]: "s-chk", [MINOR]: "s-min", [INFO]: "s-inf" };
  const FORMS = ["錠剤", "カプセル", "顆粒", "散剤", "貼付剤", "液剤", "軟膏・クリーム", "スプレー・吸入", "坐剤", "注射", "冷所保存品", "その他"];

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
  };
  const S = {
    rules: LS.get("kousou.rules", null) || window.DEFAULT_RULES,
    master: LS.get("kousou.master", null) || window.DEFAULT_MASTER.drugs,
    scans: [],     // {name, bytes, pdf}
    pages: [],     // {key, scan, idx, ink, blank, type, start, thumb}
    data: {},      // 案件キー（先頭ページのkey）→ 入力内容
    cur: null, sel: 0, step: "split",
  };
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  $("#outDate").value = today().replace(/-/g, "");
  $("#useHistory").checked = LS.get("kousou.useHistory", false);

  // ---------------------------------------------------------------- pdf.js（ワーカーはページ内に埋め込み）
  // file:// で開くとworkerSrc指定ではpdf.jsが同一オリジンと見なさないため、ワーカーを直接渡す
  try { pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([$("#pdfWorkerSrc").textContent], { type: "text/javascript" }))); }
  catch (e) { console.warn("pdf.js worker を起動できないため、メインスレッドで処理します", e); }

  async function loadFiles(files) {
    for (const f of files) {
      if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      const si = S.scans.length;
      S.scans.push({ name: f.name, bytes, pdf });
      for (let i = 1; i <= pdf.numPages; i++) {
        status(`${f.name}：${i}/${pdf.numPages}ページを処理中…`, i / pdf.numPages);
        const page = await pdf.getPage(i);
        const small = await render(page, 0.7);
        const ink = inkRatio(small);
        const thumb = (await render(page, 170 / page.getViewport({ scale: 1 }).width)).toDataURL("image/jpeg", 0.7);
        S.pages.push({ key: `s${si}p${i - 1}`, scan: si, idx: i - 1, ink, blank: ink < BLANK_RATIO, type: ink < BLANK_RATIO ? "白紙" : "その他", start: false, thumb });
      }
    }
    status(`読込完了：${S.pages.length}ページ（白紙 ${S.pages.filter(p => p.blank).length}ページ）`, 1);
    autoAssign();
  }
  async function render(page, scale) {
    const vp = page.getViewport({ scale });
    const cv = document.createElement("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return cv;
  }
  function inkRatio(cv) {  // 外周3%を除いた暗い画素の割合
    const mx = Math.floor(cv.width * 0.03), my = Math.floor(cv.height * 0.03);
    const w = cv.width - 2 * mx, h = cv.height - 2 * my;
    const d = cv.getContext("2d").getImageData(mx, my, w, h).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < INK_TH) dark++;
    return dark / (w * h);
  }
  function status(msg, p) { $("#status").textContent = msg; $("#prog").style.width = ((p || 0) * 100).toFixed(0) + "%"; }

  // ---------------------------------------------------------------- ① 分割
  function autoAssign() {
    const n = Math.max(1, +$("#setSize").value || 3), seq = ["申込書", "診断書", "指示書", "委任状", "その他"];
    let k = 0;
    for (const p of S.pages) {
      if (p.blank) { p.type = "白紙"; p.start = false; continue; }
      p.type = seq[Math.min(k % n, seq.length - 1)]; p.start = k % n === 0; k++;
    }
    renderThumbs();
  }
  function groups() {  // 白紙を除き、start のページで区切る
    const G = [];
    for (const p of S.pages) {
      if (p.type === "白紙") continue;
      if (!G.length || p.start) G.push({ key: p.key, pages: [] });
      G[G.length - 1].pages.push(p);
    }
    return G;
  }
  function renderThumbs() {
    $("#splitTools").hidden = !S.pages.length;
    const G = groups(), gi = {}; G.forEach((g, i) => g.pages.forEach(p => gi[p.key] = i + 1));
    $("#pageCount").textContent = `${S.pages.length}ページ → ${G.length}人`;
    $("#thumbs").innerHTML = S.pages.map((p, i) => `
      <div class="th t-${p.type} ${p.blank || p.type === "白紙" ? "blank" : ""} ${p.start && p.type !== "白紙" ? "start" : ""} ${i === S.sel ? "sel" : ""}" data-i="${i}">
        ${p.start && gi[p.key] ? `<span class="grp">${gi[p.key]}人目</span>` : ""}
        <img src="${p.thumb}" alt="">
        <div class="meta"><span>${esc(S.scans[p.scan].name)} p.${p.idx + 1}</span><span>インク${(p.ink * 100).toFixed(1)}%</span></div>
        <select data-type="${i}">${TYPES.map(t => `<option ${t === p.type ? "selected" : ""}>${t}</option>`).join("")}</select>
        <label class="chk"><input type="checkbox" data-start="${i}" ${p.start ? "checked" : ""}> ここから新しい患者</label>
      </div>`).join("");
  }
  $("#thumbs").addEventListener("click", e => { const t = e.target.closest(".th"); if (t && !e.target.closest("select,input,label")) { S.sel = +t.dataset.i; renderThumbs(); } });
  $("#thumbs").addEventListener("change", e => {
    if (e.target.dataset.type) { const p = S.pages[+e.target.dataset.type]; p.type = e.target.value; if (p.type === "申込書") p.start = true; }
    if (e.target.dataset.start) S.pages[+e.target.dataset.start].start = e.target.checked;
    renderThumbs();
  });
  document.addEventListener("keydown", e => {
    if (S.step !== "split" || !S.pages.length || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const p = S.pages[S.sel];
    if (KEY_TYPES[e.key]) { p.type = KEY_TYPES[e.key]; if (p.type === "申込書") p.start = true; S.sel = Math.min(S.sel + 1, S.pages.length - 1); }
    else if (e.key === "s" || e.key === "S") p.start = !p.start;
    else if (e.key === "ArrowRight") S.sel = Math.min(S.sel + 1, S.pages.length - 1);
    else if (e.key === "ArrowLeft") S.sel = Math.max(S.sel - 1, 0);
    else return;
    e.preventDefault(); renderThumbs();
    document.querySelector(".th.sel")?.scrollIntoView({ block: "nearest" });
  });
  $("#autoAssign").onclick = autoAssign;
  $("#fileIn").onchange = e => { loadFiles([...e.target.files]); e.target.value = ""; };
  const drop = $("#drop");
  ["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => loadFiles([...e.dataTransfer.files]));

  // ---------------------------------------------------------------- 案件データ
  function blankCase() {
    return {
      app: { apply_date: "", applicant_name: "", patient_name: "", patient_relation: "本人", staff_code: "", mission_name: "", mission_code: "",
             consent_item_count: 11, consent_wording_current: "はい", consent_marks: Array(11).fill(false), consent_confirmed: false,
             consent9_old_wording: false, old_form_features: "", written_by_other: "いいえ", proxy_letter_present: false, proxy_letter_signed: "", proxy_name: "" },
      diag: { issue_date: "", patient_name: "", staff_code: "", name_code_swapped: false, disease: "", has_dosage: true, doctor_name: "", doctor_mission: "",
              signature: "", seal: "", original_sent_later: false },
      inst: { issue_date: "", patient_name: "", doctor_name: "", doctor_mission: "", signature: "", seal: "", no_generic_checked: false },
      drugs: [], memo: "",
    };
  }
  const blankDrug = () => ({ name: "", strength: "", unit: "mg", form: "錠剤", diag: "", inst: "", adj: "", days: "", qty: "", generic: false, indeterminate: false });
  const caseData = key => (S.data[key] ||= blankCase());

  function toCase(g) {  // 入力内容 → rules.js の案件形式
    const d = caseData(g.key), types = g.pages.map(p => p.type);
    const has = t => types.includes(t), warn = [];
    if (types[0] !== "申込書") warn.push("申込書から始まっていません（前の案件とのページ境界のまたぎの可能性）。");
    ["診断書", "指示書"].forEach(t => { const n = types.filter(x => x === t).length; if (n > 1) warn.push(`${t}が${n}枚あります（2部綴じ・重複スキャンの可能性）。`); });
    if (has("申込書") && !d.app.consent_confirmed) warn.push("申込書の同意チェック欄（11項目のレ点）が未確認です。");
    const n = d.app.consent_marks.length;
    return {
      id: g.key, group_warnings: warn,
      extraction: {
        application: Object.assign({}, d.app, { present: has("申込書"), proxy_letter_present: d.app.proxy_letter_present || has("委任状"),
          consent_item_count: +d.app.consent_item_count,
          consent_unchecked_items: d.app.consent_confirmed ? d.app.consent_marks.map((v, i) => v ? null : i + 1).filter(Boolean).slice(0, n) : [],
          patient_name: d.app.patient_name || d.app.applicant_name }),
        diagnosis: Object.assign({}, d.diag, { present: has("診断書") }),
        instruction: Object.assign({}, d.inst, { present: has("指示書") }),
        drugs: d.drugs.map(x => ({
          name_as_written: x.name, generic_name: "", corrected_name: "", name_exists: true,
          strength_value: x.strength === "" ? null : x.strength, strength_unit: x.unit, strength_exists: "不明",
          dosage_form: x.form === "冷所保存品" ? "その他" : x.form, cold_storage: x.form === "冷所保存品",
          in_diagnosis: x.diag !== "" || x.inst === "", in_instruction: x.inst !== "" || x.diag === "",
          diag_daily_units: x.diag === "" ? null : x.diag, inst_daily_units: x.inst === "" ? null : x.inst,
          adjustable_max_units: x.adj === "" ? null : x.adj, quantity_indeterminate: x.indeterminate,
          days: x.days === "" ? null : x.days, quantity: x.qty === "" ? null : x.qty, generic_prescription: x.generic,
          is_psychotropic: "不明", is_new_drug: "不明", is_female_hormone_cycle: false, approved_max_daily: null, approved_max_unit: "", indication: "不明" })),
        reading_uncertainties: [],
      },
    };
  }
  const patientName = c => { const a = c.extraction.application; return a.patient_name || c.extraction.diagnosis.patient_name || a.applicant_name || ""; };

  function reviewAll() {
    const G = groups(), rv = new Reviewer(S.rules, S.master, today());
    const cases = G.map(toCase);
    const hist = $("#useHistory").checked ? LS.get("kousou.history", []) : [];
    const cross = rv.batchChecks(cases, hist);
    cases.forEach((c, i) => { c.group = G[i]; c.findings = rv.review(c).concat(cross[c.id]).sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]); });
    return { cases, rv };
  }
  const statusOf = c => c.findings.some(f => f.sev === ERROR) ? ERROR : c.findings.some(f => f.sev === CHECK || f.sev === MINOR) ? CHECK : "クリーン";
  function badges(F) {
    const n = s => F.filter(f => f.sev === s).length;
    return [[ERROR, "s-err"], [CHECK, "s-chk"], [MINOR, "s-min"]].map(([s, c]) => n(s) ? `<span class="badge ${c}">${n(s)}</span>` : "").join("") || `<span class="badge s-ok">✓</span>`;
  }

  // ---------------------------------------------------------------- ② 入力・審査
  function renderReview() {
    const { cases } = reviewAll();
    if (!cases.length) { $("#clist").innerHTML = `<p class="hint">先に①でスキャンPDFを読み込んでください。</p>`; $("#form").innerHTML = ""; $("#viewer").innerHTML = ""; return; }
    if (!cases.some(c => c.id === S.cur)) S.cur = cases[0].id;
    renderList(cases);
    const c = cases.find(x => x.id === S.cur);
    renderViewer(c.group);
    renderForm(c);
  }
  function renderList(cases) {
    $("#clist").innerHTML = cases.map((c, i) => `<button data-case="${c.id}" class="${c.id === S.cur ? "active" : ""}">${i + 1}. ${esc(patientName(c) || "（氏名未入力）")}${badges(c.findings)}</button>`).join("");
  }
  $("#clist").onclick = e => { const b = e.target.closest("button"); if (b) { S.cur = b.dataset.case; renderReview(); } };

  const bigCache = {};
  async function renderViewer(g) {
    const v = $("#viewer"), token = g.key; v.dataset.token = token;
    v.innerHTML = g.pages.map(p => `<div class="cap">${p.type}（${esc(S.scans[p.scan].name)} p.${p.idx + 1}）</div><img data-k="${p.key}" src="${bigCache[p.key] || p.thumb}" alt="">`).join("");
    for (const p of [...g.pages].sort((a, b) => (DOC_ORDER[a.type] ?? 9) - (DOC_ORDER[b.type] ?? 9))) {
      if (!bigCache[p.key]) {
        const page = await S.scans[p.scan].pdf.getPage(p.idx + 1);
        const cv = await render(page, 1400 / page.getViewport({ scale: 1 }).width);
        bigCache[p.key] = cv.toDataURL("image/jpeg", 0.85);
      }
      if (v.dataset.token !== token) return;
      const img = v.querySelector(`img[data-k="${p.key}"]`); if (img) img.src = bigCache[p.key];
    }
  }

  function fld(label, path, type = "text", opts) {
    const d = caseData(S.cur), v = path.split(".").reduce((a, k) => a?.[k], d);
    let inp;
    if (type === "select") inp = `<select data-p="${path}">${opts.map(o => `<option ${String(o) === String(v) ? "selected" : ""}>${o}</option>`).join("")}</select>`;
    else if (type === "check") inp = `<label class="chk"><input type="checkbox" data-p="${path}" ${v ? "checked" : ""}> ${opts || ""}</label>`;
    else if (type === "textarea") inp = `<textarea rows="2" data-p="${path}">${esc(v)}</textarea>`;
    else inp = `<input type="${type}" data-p="${path}" value="${esc(v)}">`;
    return `<label>${label}</label><div>${inp}</div>`;
  }
  const TRI = ["", "はい", "いいえ", "不明"], SIGN = ["", "自筆署名", "記名", "なし", "判読不能"], SEAL = ["", "はい", "いいえ", "不明"];
  function renderForm(c) {
    const d = caseData(S.cur), items = S.rules.consent_items;
    while (d.app.consent_marks.length < items.length) d.app.consent_marks.push(false);
    $("#form").innerHTML = `
      <fieldset id="resultBox"><legend>判定結果 ${badges(c.findings)}</legend><div id="findings">${renderFindings(c.findings)}</div></fieldset>
      <fieldset><legend>申込書（様式A）</legend><div class="grid">
        ${fld("申込日", "app.apply_date", "date")}${fld("申込者氏名", "app.applicant_name")}${fld("療養者氏名", "app.patient_name")}
        ${fld("続柄", "app.patient_relation", "select", ["本人", "配偶者", "子", "その他"])}${fld("職員コード", "app.staff_code")}
        ${fld("所属公館名", "app.mission_name")}${fld("公館コード", "app.mission_code")}
        ${fld("同意チェック項目数", "app.consent_item_count", "select", [11, 9, 0])}${fld("文言が現行版", "app.consent_wording_current", "select", TRI)}
        ${fld("旧版の特徴", "app.old_form_features")}</div>
        <div style="margin-top:6px"><label class="chk"><input type="checkbox" data-p="app.consent_confirmed" ${d.app.consent_confirmed ? "checked" : ""}> <b>同意チェック欄を確認した</b>（下のレ点を原本どおりに）</label>
        <button type="button" id="allConsent">全項目レ点あり</button>
        ${items.map((t, i) => `<label class="chk"><input type="checkbox" data-p="app.consent_marks.${i}" ${d.app.consent_marks[i] ? "checked" : ""}> (${i + 1}) ${esc(t)}</label>`).join("")}
        <label class="chk"><input type="checkbox" data-p="app.consent9_old_wording" ${d.app.consent9_old_wording ? "checked" : ""}> (9)が旧文言（「領収書」なし）</label></div>
        <div class="grid" style="margin-top:6px">
        ${fld("本人以外の記入", "app.written_by_other", "select", TRI)}${fld("委任状", "app.proxy_letter_present", "check", "添付あり（委任状ページがあれば自動）")}
        ${fld("委任者の自筆署名", "app.proxy_letter_signed", "select", TRI)}${fld("受任者氏名", "app.proxy_name")}</div></fieldset>
      <fieldset><legend>診断書</legend><div class="grid">
        ${fld("発行日", "diag.issue_date", "date")}${fld("療養者氏名", "diag.patient_name")}${fld("職員コード", "diag.staff_code")}
        ${fld("氏名・コード欄", "diag.name_code_swapped", "check", "取り違えあり")}${fld("病名", "diag.disease", "textarea")}
        ${fld("用法・用量", "diag.has_dosage", "check", "記載あり（1日量・回数まで）")}${fld("医師氏名", "diag.doctor_name")}${fld("医師の所属公館", "diag.doctor_mission")}
        ${fld("医師氏名欄", "diag.signature", "select", SIGN)}${fld("押印", "diag.seal", "select", SEAL)}
        ${fld("原本", "diag.original_sent_later", "check", "「原本は後日送付」の付箋あり")}</div></fieldset>
      <fieldset><legend>指示書（様式B）</legend><div class="grid">
        ${fld("発行日", "inst.issue_date", "date")}${fld("医師氏名", "inst.doctor_name")}
        ${fld("医師氏名欄", "inst.signature", "select", SIGN)}${fld("押印", "inst.seal", "select", SEAL)}
        ${fld("後発品", "inst.no_generic_checked", "check", "「後発医薬品への変更不可」にチェックあり")}</div></fieldset>
      <fieldset><legend>処方薬剤（1日量は錠数・包数・枚数）</legend><div class="drugs"><table>
        <tr><th>薬品名（書かれたとおり）</th><th>含有量</th><th>単位</th><th>剤形</th><th>1日量<br>診断書</th><th>1日量<br>指示書</th><th>調節可<br>上限</th><th>日数</th><th>数量</th><th>一般名<br>処方</th><th>半錠等<br>未確定</th><th>マスタ</th><th></th></tr>
        ${d.drugs.map((x, i) => { const m = new KousouRules.Master(S.master).find(x.name); return `<tr>
          <td><input type="text" data-p="drugs.${i}.name" value="${esc(x.name)}" style="min-width:140px"></td>
          <td><input type="text" data-p="drugs.${i}.strength" value="${esc(x.strength)}" style="width:52px"></td>
          <td><select data-p="drugs.${i}.unit">${["mg", "μg", "g", "錠", "包", "枚"].map(u => `<option ${u === x.unit ? "selected" : ""}>${u}</option>`).join("")}</select></td>
          <td><select data-p="drugs.${i}.form">${FORMS.map(u => `<option ${u === x.form ? "selected" : ""}>${u}</option>`).join("")}</select></td>
          ${["diag", "inst", "adj", "days", "qty"].map(k => `<td><input type="text" data-p="drugs.${i}.${k}" value="${esc(x[k])}" style="width:44px"></td>`).join("")}
          <td><input type="checkbox" data-p="drugs.${i}.generic" ${x.generic ? "checked" : ""}></td>
          <td><input type="checkbox" data-p="drugs.${i}.indeterminate" ${x.indeterminate ? "checked" : ""}></td>
          <td class="hint">${m ? esc(m.names[0]) + (m.psych ? "<br>向精神薬" : "") : "未登録"}</td>
          <td><button data-del="${i}">×</button></td></tr>`; }).join("")}
      </table></div><button id="addDrug" style="margin-top:6px">＋薬剤</button>
      <div class="hint">「1〜2錠で調節可」は上限（2）を「調節可上限」に。マスタ未登録の薬は「薬品マスタ」に追加すると規格・上限・適応も自動判定されます。</div></fieldset>
      <fieldset><legend>メモ</legend><textarea rows="2" data-p="memo">${esc(d.memo)}</textarea></fieldset>`;
  }
  function renderFindings(F) {
    if (!F.length) return `<div class="f"><span class="sev s-ok">OK</span><span>指摘事項はありません。</span></div>`;
    return F.map(f => `<div class="f"><span class="sev ${SEV_CLASS[f.sev]}">${f.sev}</span><span class="it">${esc(f.item)}</span><span>${esc(f.msg)}</span></div>`).join("");
  }
  function setPath(o, path, v) { const ks = path.split("."); let a = o; for (let i = 0; i < ks.length - 1; i++) a = a[ks[i]]; a[ks[ks.length - 1]] = v; }
  let tm;
  function onEdit(e) {
    const p = e.target.dataset.p; if (!p || !S.cur) return;
    setPath(caseData(S.cur), p, e.target.type === "checkbox" ? e.target.checked : e.target.value);
    clearTimeout(tm);
    tm = setTimeout(() => {  // 入力中のフォーカスを保つため、判定結果と一覧だけ更新
      const { cases } = reviewAll(); const c = cases.find(x => x.id === S.cur);
      renderList(cases); $("#findings").innerHTML = renderFindings(c.findings);
      $("#form legend").innerHTML = "判定結果 " + badges(c.findings);
      if (/^drugs\.\d+\.name$/.test(p)) {
        const i = +p.split(".")[1], m = new KousouRules.Master(S.master).find(e.target.value);
        const cell = e.target.closest("tr").children[11]; cell.innerHTML = m ? esc(m.names[0]) + (m.psych ? "<br>向精神薬" : "") : "未登録";
      }
    }, 250);
  }
  $("#form").addEventListener("input", onEdit);
  $("#form").addEventListener("change", e => { if (e.target.tagName === "SELECT" || e.target.type === "checkbox") onEdit(e); });
  $("#form").addEventListener("click", e => {
    const d = caseData(S.cur);
    if (e.target.id === "addDrug") { d.drugs.push(blankDrug()); renderReview(); }
    else if (e.target.dataset.del != null) { d.drugs.splice(+e.target.dataset.del, 1); renderReview(); }
    else if (e.target.id === "allConsent") { d.app.consent_marks = d.app.consent_marks.map(() => true); d.app.consent_confirmed = true; renderReview(); }
  });

  // ---------------------------------------------------------------- ③ 出力
  function outName(c) {
    const n = (patientName(c) || "氏名不明").normalize("NFKC").replace(/[\\/:*?"<>|\s　]+/g, "");
    return ($("#outDate").value.trim() || today().replace(/-/g, "")) + (n || "氏名不明");
  }
  function uniqueNames(cases) {
    const used = {};
    return cases.map(c => { let b = outName(c), n = b, k = 2; while (used[n]) n = `${b}_${k++}`; used[n] = 1; return n + ".pdf"; });
  }
  function markdown(cases, names) {
    const L = [`# 個人用医薬品購送 下判定結果（${S.scans.map(s => s.name).join("、")}）`, "",
      `作成日：${today()}　件数：${cases.length}件`, "",
      "> **これは自動の「下判定」です。** 最終判断は必ず人が行ってください。書類が無いと出た場合は、断定する前にスキャンの重複・欠落・ページ境界のまたぎを確認してください。", ""];
    const cnt = s => cases.filter(c => statusOf(c) === s).length;
    L.push(`- エラー相当あり：${cnt(ERROR)}件`, `- 要確認のみ：${cnt(CHECK)}件`, `- クリーン：${cnt("クリーン")}件`, "", "## 案件別", "");
    cases.forEach((c, i) => {
      const a = c.extraction.application;
      L.push(`### ${i + 1}. ${patientName(c) || "（氏名未入力）"}（${statusOf(c)}）`,
        `申込者：${a.applicant_name || "-"}／職員コード：${a.staff_code || "-"}／${a.mission_name || "-"}／申込日：${a.apply_date || "-"}／出力：\`${names[i]}\``, "");
      const shown = c.findings.filter(f => f.sev !== INFO), notes = c.findings.filter(f => f.sev === INFO);
      if (shown.length) shown.forEach(f => L.push(`- **${f.sev}** ${f.item}：${f.msg}`)); else L.push("- 指摘事項なし");
      notes.forEach(f => L.push(`- 参考 ${f.item}：${f.msg}`));
      const memo = caseData(c.id).memo; if (memo) L.push(`- メモ：${memo}`);
      L.push("");
    });
    const clean = cases.filter(c => statusOf(c) === "クリーン").map(patientName);
    L.push("## クリーン案件", "", clean.length ? clean.join("、") : "なし", "", "## 総括表（優先度順）", "", "| 優先度 | 案件 | 区分 | 内容 |", "|---|---|---|---|");
    const rows = cases.flatMap(c => c.findings.filter(f => f.sev !== INFO).map(f => [SEV_ORDER[f.sev], patientName(c), f])).sort((a, b) => a[0] - b[0]);
    rows.forEach(([o, n, f]) => L.push(`| ${["高", "中", "低"][o]} | ${n} | ${f.sev} | ${f.item}：${f.msg.replace(/\|/g, "／")} |`));
    if (!rows.length) L.push("| - | - | - | 指摘事項なし |");
    const blanks = S.pages.filter(p => p.type === "白紙");
    if (blanks.length) L.push("", "## 除外した白紙ページ", "", ...blanks.map(p => `- ${S.scans[p.scan].name} p.${p.idx + 1}（インク${(p.ink * 100).toFixed(2)}%）`));
    return L.join("\n") + "\n";
  }
  function csv(cases, names) {
    const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["No", "療養者", "申込者", "職員コード", "公館", "申込日", "判定", "エラー相当", "要確認", "指摘内容", "出力ファイル"]];
    cases.forEach((c, i) => {
      const a = c.extraction.application, F = c.findings.filter(f => f.sev !== INFO);
      rows.push([i + 1, patientName(c), a.applicant_name, a.staff_code, a.mission_name, a.apply_date, statusOf(c),
        F.filter(f => f.sev === ERROR).length, F.filter(f => f.sev === CHECK || f.sev === MINOR).length,
        F.map(f => `[${f.sev}] ${f.item}：${f.msg}`).join("\n"), names[i]]);
    });
    return "﻿" + rows.map(r => r.map(q).join(",")).join("\r\n");
  }
  function renderOutput() {
    const { cases } = reviewAll(), names = uniqueNames(cases);
    $("#outTable").innerHTML = `<tr><th>No</th><th>療養者</th><th>判定</th><th>指摘</th><th>出力ファイル</th><th></th></tr>` + cases.map((c, i) =>
      `<tr><td>${i + 1}</td><td>${esc(patientName(c) || "（未入力）")}</td><td>${statusOf(c)}</td><td>${badges(c.findings)}</td><td>${esc(names[i])}</td><td><button data-pdf="${i}">PDF</button></td></tr>`).join("");
    $("#mdPreview").textContent = cases.length ? markdown(cases, names) : "案件がありません。";
  }
  const pdfCache = {};
  async function srcDoc(si) { return pdfCache[si] ||= await PDFLib.PDFDocument.load(S.scans[si].bytes, { ignoreEncryption: true }); }
  async function mergedPdf(c) {
    const out = await PDFLib.PDFDocument.create();
    for (const p of [...c.group.pages].sort((a, b) => (DOC_ORDER[a.type] ?? 9) - (DOC_ORDER[b.type] ?? 9))) {
      const [pg] = await out.copyPages(await srcDoc(p.scan), [p.idx]); out.addPage(pg);
    }
    return out.save();
  }
  // 外側のダウンロード名はASCIIにする（環境によって日本語名が「download」に置き換わるため）。ZIP内のファイル名は日本語のまま。
  function download(name, data, type) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function recordHistory(cases, rv) {
    if (!$("#useHistory").checked) return;
    const batch = S.scans.map(s => s.name).join("+"), ids = new Set(cases.map(c => c.id));
    const old = LS.get("kousou.history", []).filter(h => !(h.batch === batch && ids.has(h.case_id)));
    LS.set("kousou.history", old.concat(rv.historyEntries(cases, batch)));
  }
  $("#v-output").addEventListener("click", async e => {
    const i = e.target.dataset.pdf; if (i == null) return;
    const { cases } = reviewAll(), names = uniqueNames(cases);
    download(names[i], await mergedPdf(cases[i]), "application/pdf");
  });
  $("#dlZip").onclick = async () => {
    const { cases, rv } = reviewAll(); if (!cases.length) return;
    const names = uniqueNames(cases), zip = new JSZip();   // 日本語ファイル名にはUTF-8フラグが付く
    $("#dlZip").disabled = true;
    try {
      for (let i = 0; i < cases.length; i++) zip.file(names[i], await mergedPdf(cases[i]));
      zip.file("判定結果.md", markdown(cases, names)); zip.file("判定一覧.csv", csv(cases, names));
      download(`${$("#outDate").value}_kousou.zip`, await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), "application/zip");
      recordHistory(cases, rv);
    } finally { $("#dlZip").disabled = false; }
  };
  $("#dlMd").onclick = () => { const { cases } = reviewAll(); download(`${$("#outDate").value}_hantei.md`, markdown(cases, uniqueNames(cases)), "text/markdown"); };
  $("#dlCsv").onclick = () => { const { cases } = reviewAll(); download(`${$("#outDate").value}_ichiran.csv`, csv(cases, uniqueNames(cases)), "text/csv"); };
  $("#outDate").oninput = renderOutput;
  $("#useHistory").onchange = e => { LS.set("kousou.useHistory", e.target.checked); renderOutput(); };
  $("#exportHist").onclick = () => download("kousou_history.json", JSON.stringify({ entries: LS.get("kousou.history", []) }, null, 1), "application/json");
  $("#importHistBtn").onclick = () => $("#importHist").click();
  $("#importHist").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()); LS.set("kousou.history", (j.entries || j)); alert(`履歴 ${(j.entries || j).length} 件を取り込みました。`); renderOutput(); }
    catch (err) { alert("読込エラー：" + err.message); } e.target.value = "";
  };

  // ---------------------------------------------------------------- 画面切替・作業保存
  function go(step) {
    S.step = step;
    document.querySelectorAll(".step").forEach(b => b.classList.toggle("active", b.dataset.step === step));
    ["split", "review", "output"].forEach(s => $("#v-" + s).hidden = s !== step);
    if (step === "review") renderReview();
    if (step === "output") renderOutput();
  }
  document.querySelectorAll(".step").forEach(b => b.onclick = () => go(b.dataset.step));
  $("#toReview").onclick = () => go("review");

  $("#saveWork").onclick = () => download(`kousou_work_${today()}.json`, JSON.stringify({
    version: 1, scans: S.scans.map(s => s.name),
    pages: S.pages.map(p => ({ key: p.key, scan: S.scans[p.scan].name, idx: p.idx, type: p.type, start: p.start })), data: S.data,
  }, null, 1), "application/json");
  $("#loadWorkBtn").onclick = () => { if (!S.pages.length) return alert("先に同じスキャンPDFを読み込んでから、作業ファイルを読み込んでください。"); $("#loadWork").click(); };
  $("#loadWork").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text()); let hit = 0;
      for (const sp of j.pages) {
        const p = S.pages.find(q => S.scans[q.scan].name === sp.scan && q.idx === sp.idx);
        if (p) { p.type = sp.type; p.start = sp.start; hit++; }
      }
      // 案件キーはページ位置に紐づくので、ファイル名＋ページで付け替える
      const keyMap = {}; j.pages.forEach(sp => { const p = S.pages.find(q => S.scans[q.scan].name === sp.scan && q.idx === sp.idx); if (p) keyMap[sp.key] = p.key; });
      for (const [k, v] of Object.entries(j.data || {})) if (keyMap[k]) S.data[keyMap[k]] = v;
      alert(`${hit}/${j.pages.length}ページの割当と入力内容を復元しました。`); renderThumbs(); go(S.step);
    } catch (err) { alert("読込エラー：" + err.message); }
    e.target.value = "";
  };

  // ---------------------------------------------------------------- 設定（薬品マスタ・判定ルール）
  let dlgKind = null;
  function openDlg(kind) {
    dlgKind = kind;
    $("#dlgTitle").textContent = kind === "master" ? "薬品マスタ" : "判定ルール";
    $("#dlgHint").textContent = kind === "master"
      ? "names[0]＝一般名、他は商品名・別名。strengths：実在規格、max_daily：1日最大量（unit基準、配合剤は錠数）、psych：向精神薬(true/false/null)、old_limit：9月までの投薬期間上限、new_drug_until：新薬14日制限が外れる日、hormone28：28日周期、ok_days：例外日数、indications：保険適応キーワード、not_indicated：適応外キーワード。このPCのブラウザに保存されます。"
      : "日付・例外公館・巡回公館・特別許可・確認済み処方・同意チェック文言など。このPCのブラウザに保存されます（患者名を含む設定はここに入れ、GitHubには置かない）。";
    $("#dlgText").value = JSON.stringify(kind === "master" ? { drugs: S.master } : S.rules, null, 1);
    $("#dlg").showModal();
  }
  $("#openMaster").onclick = () => openDlg("master");
  $("#openRules").onclick = () => openDlg("rules");
  $("#dlgClose").onclick = () => $("#dlg").close();
  $("#dlgReset").onclick = () => { $("#dlgText").value = JSON.stringify(dlgKind === "master" ? window.DEFAULT_MASTER : window.DEFAULT_RULES, null, 1); };
  $("#dlgSave").onclick = () => {
    try {
      const v = JSON.parse($("#dlgText").value);
      if (dlgKind === "master") { if (!Array.isArray(v.drugs)) throw new Error("drugs 配列が必要です"); S.master = v.drugs; LS.set("kousou.master", v.drugs); }
      else { if (!Array.isArray(v.consent_items)) throw new Error("consent_items が必要です"); S.rules = v; LS.set("kousou.rules", v); }
      $("#dlg").close(); go(S.step);
    } catch (err) { alert("保存できません：" + err.message); }
  };

  window.__kousou = { S, reviewAll, groups };  // 動作確認用
})();
