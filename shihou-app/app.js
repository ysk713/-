// 司法試験 合格ノート
// 学習記録はこの端末のブラウザ（localStorage）にだけ保存し、外部には送らない。
(function () {
  "use strict";

  const DATA = window.SHIHOU_DATA;
  const SUBJECTS = ["憲法", "民法", "刑法"];
  const RONBUN_SUBJECTS = ["憲法", "行政法", "民法", "商法", "民事訴訟法", "刑法", "刑事訴訟法"];
  const KEY = "shihou-note-v1";
  // 正解が続くほど次の復習までの日数を延ばす（間違えたら 0 に戻る）
  const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
  // 収録問題＋自分で取り込んだ過去問。取り込みや読み込みのたびに作り直す
  let ALL = [], byId = {};
  function refreshPool() {
    ALL = DATA.tanto.concat((store.custom || []).filter((q) => q && q.id && q.q && SUBJECTS.includes(q.s)));
    byId = Object.fromEntries(ALL.map((q) => [q.id, q]));
  }
  const ronbunById = Object.fromEntries(DATA.ronbun.map((p) => [p.id, p]));

  // ───────── 保存 ─────────
  function blank() {
    return { v: 1, q: {}, log: {}, ronbun: {}, drafts: {}, hanrei: {}, custom: [], settings: { examDate: defaultExamDate(), goal: 30 } };
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return Object.assign(blank(), JSON.parse(raw));
    } catch (e) { /* 保存できない環境でもそのまま動かす */ }
    return blank();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* 同上 */ }
  }
  let store = load();
  refreshPool();

  // ───────── 日付 ─────────
  function ymd(d) {
    const z = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  }
  function today() { return ymd(new Date()); }
  function addDays(s, n) { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return ymd(d); }
  function diffDays(a, b) { return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5); }
  function defaultExamDate() {
    // 司法試験は例年7月中旬。正式な日程は法務省の発表で確認して設定し直す
    const now = new Date();
    const y = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
    return `${y}-07-15`;
  }
  function jpDate(s) { const [y, m, d] = s.split("-").map(Number); return `${y}年${m}月${d}日`; }

  // ───────── 記録 ─────────
  function logDay(field, n) {
    const t = today();
    const day = store.log[t] || (store.log[t] = { t: 0, c: 0, r: 0 });
    day[field] = (day[field] || 0) + n;
  }
  function record(id, correct) {
    const st = store.q[id] || (store.q[id] = { n: 0, c: 0, box: 0, due: today(), last: null });
    st.n += 1;
    if (correct) st.c += 1;
    st.box = correct ? Math.min(st.box + 1, INTERVALS.length - 1) : 0;
    st.due = addDays(today(), INTERVALS[st.box]);
    st.last = correct;
    st.ts = Date.now();
    logDay("t", 1);
    if (correct) logDay("c", 1);
    save();
  }
  function dueIds() {
    const t = today();
    return ALL.filter((q) => store.q[q.id] && store.q[q.id].due <= t).map((q) => q.id);
  }
  function streak() {
    let n = 0, d = today();
    const active = (s) => store.log[s] && (store.log[s].t > 0 || store.log[s].r > 0);
    if (!active(d)) d = addDays(d, -1); // 今日まだ解いていなくても昨日までの連続は数える
    while (active(d)) { n++; d = addDays(d, -1); }
    return n;
  }
  function subjectStats(s) {
    const qs = ALL.filter((q) => q.s === s);
    let done = 0, n = 0, c = 0;
    qs.forEach((q) => { const st = store.q[q.id]; if (st) { done++; n += st.n; c += st.c; } });
    return { total: qs.length, done, n, c, rate: n ? c / n : null };
  }

  // ───────── 表示の補助 ─────────
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
  const main = () => $("#main");
  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast"; el.textContent = msg; el.setAttribute("role", "status");
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // ───────── 画面切替 ─────────
  const VIEWS = { home: viewHome, tanto: viewTantoSetup, review: viewReview, ronbun: viewRonbunList, hanrei: viewHanrei, kakomon: viewKakomon, record: viewRecord };
  let session = null;  // 短答の出題中セッション
  let timerId = null;  // 論文タイマー
  let keyHandler = null;

  function go(name, arg) {
    clearInterval(timerId); timerId = null;
    keyHandler = null;
    if (name !== "session") session = session && name === "result" ? session : null;
    const tab = { session: "tanto", result: "tanto", problem: "ronbun", card: "hanrei" }[name] || name;
    document.querySelectorAll("nav.tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.v === tab ? "page" : "false"));
    ({ ...VIEWS, session: viewSession, result: viewResult, problem: viewProblem, card: viewCard }[name] || viewHome)(arg);
    updateBadge();
    window.scrollTo(0, 0);
  }
  function updateBadge() {
    const n = dueIds().length;
    const b = $("#due-badge");
    b.textContent = n; b.hidden = n === 0;
  }

  // ───────── ホーム ─────────
  function viewHome() {
    const t = today();
    const left = diffDays(t, store.settings.examDate);
    const day = store.log[t] || { t: 0, c: 0, r: 0 };
    const goal = store.settings.goal || 30;
    const due = dueIds().length;
    const answered = Object.keys(store.q).length;

    const subjRows = SUBJECTS.map((s) => {
      const st = subjectStats(s);
      return `<div class="subj-row"><span>${s}</span>
        <div class="bar" title="正答率"><i style="width:${st.rate == null ? 0 : Math.round(st.rate * 100)}%"></i></div>
        <span class="r">${pct(st.rate)}　${st.done}/${st.total}肢</span></div>`;
    }).join("");

    main().innerHTML = `
      <section class="panel">
        <div class="hero">
          <div class="days">${left >= 0 ? left : "—"}<small>日</small></div>
          <div class="muted small">${left >= 0 ? "試験初日まで" : "試験日を過ぎています。次の試験日を設定してください"}<br>
            <span class="num">${jpDate(store.settings.examDate)}</span>（設定値）</div>
        </div>
        <div class="row">
          <label class="field">試験初日<input type="date" id="exam-date" value="${store.settings.examDate}"></label>
          <label class="field">1日の目標（肢）<input type="number" id="goal" min="5" max="500" step="5" value="${goal}" style="width:6em"></label>
        </div>
        <p class="small muted">司法試験は例年7月中旬に実施されます。日程は法務省の公式発表で確認して設定してください。</p>
      </section>

      <div class="stats">
        <div><span class="label">今日</span><b>${day.t}<span class="small muted"> / ${goal}肢</span></b>
          <div class="bar"><i style="width:${Math.min(100, Math.round((day.t / goal) * 100))}%"></i></div></div>
        <div><span class="label">連続学習</span><b>${streak()}<span class="small muted"> 日</span></b></div>
        <div><span class="label">復習待ち</span><b>${due}<span class="small muted"> 肢</span></b></div>
      </div>

      <div class="row">
        <button class="btn primary" id="go-review" ${due ? "" : "disabled"}>復習する（${due}肢）</button>
        <button class="btn" id="go-quick">短答をランダム10肢</button>
        <a class="btn" href="#ronbun" style="text-decoration:none">論文の答案構成</a>
      </div>

      <section class="panel">
        <div class="row spread"><h2>短答 科目別の正答率</h2><span class="small muted">解いた肢 ${answered} / ${ALL.length}</span></div>
        <div class="subj-rows">${subjRows}</div>
        <p class="small muted">短答式は憲法50点・民法75点・刑法50点の計175点。各科目で満点の40%未満があると、合計点にかかわらず不合格です。</p>
      </section>

      <section class="panel">
        <div class="row spread"><h2>学習した日</h2><span class="small muted">直近12週</span></div>
        <div class="heat" aria-label="直近12週の学習量">${heatmap()}</div>
      </section>
    `;
    $("#exam-date").addEventListener("change", (e) => { if (e.target.value) { store.settings.examDate = e.target.value; save(); viewHome(); } });
    $("#goal").addEventListener("change", (e) => { const v = Math.max(5, Number(e.target.value) || 30); store.settings.goal = v; save(); viewHome(); });
    $("#go-review").addEventListener("click", () => startSession(shuffle(dueIds()), { mode: "normal", label: "復習" }));
    $("#go-quick").addEventListener("click", () => startSession(shuffle(ALL.map((q) => q.id)).slice(0, 10), { mode: "normal", label: "ランダム10肢" }));
  }
  function heatmap() {
    const t = today();
    const end = new Date(t + "T00:00:00");
    // 列＝週（日曜始まり）、最後の列が今週
    const start = addDays(t, -(7 * 11 + end.getDay()));
    let html = "";
    for (let i = 0; i < 7 * 12; i++) {
      const d = addDays(start, i);
      if (d > t) { html += `<i style="visibility:hidden"></i>`; continue; }
      const v = store.log[d] ? store.log[d].t + store.log[d].r * 10 : 0;
      const l = v === 0 ? 0 : v < 10 ? 1 : v < 30 ? 2 : 3;
      html += `<i data-l="${l}" class="${d === t ? "today" : ""}" title="${d}：${store.log[d] ? store.log[d].t : 0}肢${store.log[d] && store.log[d].r ? "・論文" + store.log[d].r + "問" : ""}"></i>`;
    }
    return html;
  }

  // ───────── 短答：出題設定 ─────────
  const setup = { subjects: new Set(SUBJECTS), field: "", filter: "all", count: 20, mode: "normal", minutes: 20 };
  function viewTantoSetup() {
    const fields = [...new Set(ALL.filter((q) => setup.subjects.has(q.s)).map((q) => q.s + "｜" + q.f))];
    if (setup.field && !fields.includes(setup.field)) setup.field = "";
    main().innerHTML = `
      <section class="block">
        <h2>短答 肢別演習</h2>
        <p class="muted small">1つの記述（肢）ごとに正しいか誤りかを判断します。間違えた肢は翌日以降に復習に回ります。</p>
      </section>
      <section class="panel">
        <span class="label">科目</span>
        <div class="chips" id="subj">${SUBJECTS.map((s) => `<button class="chip" data-s="${s}" aria-pressed="${setup.subjects.has(s)}">${s}<span class="muted small"> ${ALL.filter((q) => q.s === s).length}</span></button>`).join("")}</div>
        <div class="grid2">
          <label class="field">分野
            <select id="field"><option value="">すべての分野</option>${fields.map((f) => `<option value="${esc(f)}" ${f === setup.field ? "selected" : ""}>${esc(f.replace("｜", "：")) }</option>`).join("")}</select></label>
          <label class="field">出題する肢
            <select id="filter">
              <option value="all">すべて</option><option value="new">まだ解いていない肢</option>
              <option value="wrong">前回間違えた肢</option><option value="weak">正答率が60%未満の肢</option>
              <option value="orig">収録問題（オリジナル）だけ</option><option value="past">取り込んだ過去問だけ</option>
            </select></label>
          <label class="field">問題数
            <select id="count"><option>10</option><option>20</option><option>30</option><option value="0">全部</option></select></label>
          <label class="field">形式
            <select id="mode"><option value="normal">1肢ずつ解説を見る</option><option value="exam">本番形式（最後にまとめて採点）</option></select></label>
          <label class="field" id="min-wrap" ${setup.mode === "exam" ? "" : "hidden"}>制限時間（分）
            <input type="number" id="minutes" min="1" max="180" value="${setup.minutes}"></label>
        </div>
        <div class="row spread">
          <span class="small muted" id="avail"></span>
          <button class="btn primary" id="start">始める</button>
        </div>
      </section>
      <p class="notice">収録問題は出題傾向を踏まえたオリジナル問題で、過去問ではありません。法令は2026年10月時点の内容によります。過去問は「過去問」タブから取り込めます。</p>
    `;
    $("#filter").value = setup.filter; $("#count").value = String(setup.count); $("#mode").value = setup.mode;
    const pool = () => {
      let qs = ALL.filter((q) => setup.subjects.has(q.s) && (!setup.field || q.s + "｜" + q.f === setup.field));
      if (setup.filter === "new") qs = qs.filter((q) => !store.q[q.id]);
      if (setup.filter === "wrong") qs = qs.filter((q) => store.q[q.id] && store.q[q.id].last === false);
      if (setup.filter === "orig") qs = qs.filter((q) => !q.past);
      if (setup.filter === "past") qs = qs.filter((q) => q.past);
      if (setup.filter === "weak") qs = qs.filter((q) => store.q[q.id] && store.q[q.id].c / store.q[q.id].n < 0.6);
      return qs.map((q) => q.id);
    };
    const refresh = () => {
      const n = pool().length;
      $("#avail").textContent = `条件に合う肢：${n}`;
      $("#start").disabled = n === 0;
    };
    refresh();
    $("#subj").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      const s = b.dataset.s;
      if (setup.subjects.has(s)) { if (setup.subjects.size > 1) setup.subjects.delete(s); } else setup.subjects.add(s);
      viewTantoSetup();
    });
    $("#field").addEventListener("change", (e) => { setup.field = e.target.value; refresh(); });
    $("#filter").addEventListener("change", (e) => { setup.filter = e.target.value; refresh(); });
    $("#count").addEventListener("change", (e) => { setup.count = Number(e.target.value); });
    $("#mode").addEventListener("change", (e) => { setup.mode = e.target.value; $("#min-wrap").hidden = setup.mode !== "exam"; });
    $("#minutes").addEventListener("change", (e) => { setup.minutes = Math.max(1, Number(e.target.value) || 20); });
    $("#start").addEventListener("click", () => {
      let ids = shuffle(pool());
      if (setup.count) ids = ids.slice(0, setup.count);
      startSession(ids, { mode: setup.mode, minutes: setup.minutes, label: setup.mode === "exam" ? "本番形式" : "肢別演習" });
    });
  }

  // ───────── 短答：出題中 ─────────
  function startSession(ids, opt) {
    if (!ids.length) return;
    session = { ids, i: 0, answers: {}, mode: opt.mode, label: opt.label, revealed: false,
      deadline: opt.mode === "exam" ? Date.now() + opt.minutes * 60000 : null, started: Date.now() };
    go("session");
  }
  function viewSession() {
    if (!session) return go("tanto");
    const s = session;
    const q = byId[s.ids[s.i]];
    const picked = s.answers[q.id];
    const exam = s.mode === "exam";
    const show = !exam && picked !== undefined;
    const correct = picked === q.a;
    main().innerHTML = `
      <div class="qhead">
        <span class="small"><b>${esc(s.label)}</b>　<span class="num">${s.i + 1} / ${s.ids.length}</span></span>
        <span class="row">${exam ? `<span class="timer num small" id="clock" style="font-size:1rem"></span>` : ""}
          <button class="btn small" id="quit">${exam ? "採点する" : "終了"}</button></span>
      </div>
      <div class="progress"><i style="width:${((s.i + (picked !== undefined ? 1 : 0)) / s.ids.length) * 100}%"></i></div>
      <article class="qcard">
        <div class="tag"><b>${q.s}</b>${esc(q.f)}</div>
        <p class="qtext">${esc(q.q)}</p>
        <div class="answer">
          <button class="btn ${picked === true ? "picked" : ""}" data-a="1" ${show ? "disabled" : ""}>○<small>正しい</small></button>
          <button class="btn ${picked === false ? "picked" : ""}" data-a="0" ${show ? "disabled" : ""}>×<small>誤り</small></button>
        </div>
        ${show ? `<div class="verdict ${correct ? "ok" : "ng"}">
          <span class="v">${correct ? "正解" : "不正解"}　正答は ${q.a ? "○（正しい）" : "×（誤り）"}</span>
          <p>${esc(q.e)}</p>${q.m ? `<p class="hook"><span class="label">覚え方</span>${esc(q.m)}</p>` : ""}<span><span class="ref">${esc(q.r)}</span></span></div>` : ""}
      </article>
      <div class="row spread">
        <button class="btn" id="prev" ${s.i === 0 ? "disabled" : ""} ${exam ? "" : "hidden"}>前へ</button>
        <span class="keys"><kbd>O</kbd> ○　<kbd>X</kbd> ×　<kbd>Enter</kbd> 次へ</span>
        <button class="btn primary" id="next" ${!exam && picked === undefined ? "disabled" : ""}>${s.i === s.ids.length - 1 ? (exam ? "採点する" : "結果を見る") : "次へ"}</button>
      </div>
    `;
    const answer = (val) => {
      if (show) return;
      if (exam) { s.answers[q.id] = val; viewSession(); return; }
      s.answers[q.id] = val;
      record(q.id, val === q.a);
      viewSession(); updateBadge();
    };
    const next = () => {
      if (!exam && picked === undefined) return;
      if (s.i < s.ids.length - 1) { s.i++; viewSession(); window.scrollTo(0, 0); } else finish();
    };
    main().querySelectorAll(".answer .btn").forEach((b) => b.addEventListener("click", () => answer(b.dataset.a === "1")));
    $("#next").addEventListener("click", next);
    $("#prev").addEventListener("click", () => { if (s.i > 0) { s.i--; viewSession(); } });
    $("#quit").addEventListener("click", finish);
    keyHandler = (e) => {
      if (e.target.closest("input,textarea,select")) return;
      const k = e.key.toLowerCase();
      if (k === "o" || k === "1") answer(true);
      else if (k === "x" || k === "2") answer(false);
      else if (k === "enter" || k === "arrowright") { e.preventDefault(); next(); }
    };
    if (exam) {
      const tick = () => {
        const ms = s.deadline - Date.now();
        const el = $("#clock"); if (!el) return;
        if (ms <= 0) { finish(); return; }
        const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000);
        el.textContent = `残り ${m}:${String(sec).padStart(2, "0")}`;
      };
      clearInterval(timerId); tick(); timerId = setInterval(tick, 500);
    }
  }
  function finish() {
    const s = session;
    if (s.mode === "exam") {
      // 本番形式は採点の時点でまとめて記録する（未解答は記録しない）
      s.ids.forEach((id) => { if (s.answers[id] !== undefined) record(id, s.answers[id] === byId[id].a); });
    }
    go("result");
  }

  // ───────── 短答：結果 ─────────
  function viewResult() {
    const s = session;
    if (!s) return go("tanto");
    const done = s.ids.filter((id) => s.answers[id] !== undefined);
    const ok = done.filter((id) => s.answers[id] === byId[id].a);
    const wrong = s.ids.filter((id) => s.answers[id] !== byId[id].a);
    const mins = Math.max(1, Math.round((Date.now() - s.started) / 60000));
    const items = s.ids.map((id) => {
      const q = byId[id], a = s.answers[id];
      const mark = a === undefined ? `<span class="muted">—</span>` : a === q.a ? `<span class="mark-ok">○</span>` : `<span class="mark-ng">×</span>`;
      return `<details class="item"><summary>${mark}<span><span class="small muted">${q.s}・${esc(q.f)}</span><br>${esc(q.q)}</span></summary>
        <div class="body"><span>正答：<b>${q.a ? "○ 正しい" : "× 誤り"}</b>${a === undefined ? "（未解答）" : `　あなたの解答：${a ? "○" : "×"}`}</span>
        <p>${esc(q.e)}</p><span><span class="ref">${esc(q.r)}</span></span></div></details>`;
    }).join("");
    main().innerHTML = `
      <section class="panel">
        <span class="label">${esc(s.label)}の結果</span>
        <div class="row" style="align-items:baseline">
          <span class="score">${ok.length}<span class="small muted"> / ${s.ids.length}</span></span>
          <span class="muted">正答率 ${pct(s.ids.length ? ok.length / s.ids.length : null)}　約${mins}分</span>
        </div>
        <div class="row">
          <button class="btn primary" id="retry" ${wrong.length ? "" : "disabled"}>間違えた・未解答の${wrong.length}肢をもう一度</button>
          <button class="btn" id="again">出題設定に戻る</button>
        </div>
      </section>
      <section class="panel"><h2>解答と解説</h2><div>${items}</div></section>
    `;
    $("#retry").addEventListener("click", () => startSession(shuffle(wrong.slice()), { mode: "normal", label: "やり直し" }));
    $("#again").addEventListener("click", () => go("tanto"));
  }

  // ───────── 復習 ─────────
  function viewReview() {
    const due = dueIds();
    const upcoming = Object.entries(store.q).filter(([, st]) => st.due > today()).sort((a, b) => (a[1].due < b[1].due ? -1 : 1));
    const nextDue = upcoming[0] ? upcoming[0][1].due : null;
    const bySubj = SUBJECTS.map((s) => `${s} ${due.filter((id) => byId[id].s === s).length}`).join("　");
    main().innerHTML = `
      <section class="block">
        <h2>今日の復習</h2>
        <p class="muted small">正解するたびに次の復習までの間隔が 1日 → 3日 → 7日 → 14日 → 30日 → 60日 と延び、間違えると翌日からやり直しになります。</p>
      </section>
      <section class="panel">
        <div class="row" style="align-items:baseline"><span class="score">${due.length}</span><span class="muted">肢　${bySubj}</span></div>
        ${due.length ? `<div class="row"><button class="btn primary" id="start">復習を始める</button></div>`
          : `<p class="muted">今日の復習はありません。${nextDue ? `次の復習は ${jpDate(nextDue)} です。` : "短答を解くと、ここに復習が貯まります。"}</p>
             <div class="row"><a class="btn" href="#tanto" style="text-decoration:none">新しい肢を解く</a></div>`}
      </section>
      ${upcoming.length ? `<section class="panel"><h2>これからの復習予定</h2><div class="tablewrap"><table>
        <thead><tr><th>日付</th><th class="n">肢数</th></tr></thead><tbody>
        ${Object.entries(upcoming.reduce((m, [, st]) => ((m[st.due] = (m[st.due] || 0) + 1), m), {})).slice(0, 8)
          .map(([d, n]) => `<tr><td class="num">${jpDate(d)}</td><td class="n">${n}</td></tr>`).join("")}
        </tbody></table></div></section>` : ""}
    `;
    if (due.length) $("#start").addEventListener("click", () => startSession(shuffle(due), { mode: "normal", label: "復習" }));
  }

  // ───────── 論文：一覧 ─────────
  function lastScore(id) {
    const h = store.ronbun[id];
    return h && h.length ? h[h.length - 1] : null;
  }
  function viewRonbunList() {
    const rows = RONBUN_SUBJECTS.map((s) => DATA.ronbun.filter((p) => p.s === s).map((p) => {
      const last = lastScore(p.id);
      const pill = last ? `<span class="pill ${last.rate >= 0.75 ? "good" : last.rate >= 0.5 ? "mid" : "low"}">論点 ${Math.round(last.rate * 100)}%</span>` : `<span class="pill">未着手</span>`;
      return `<a href="#" data-id="${p.id}"><span class="s">${p.s}</span><span class="t">${esc(p.title)}</span>${pill}</a>`;
    }).join("")).join("");
    main().innerHTML = `
      <section class="block">
        <h2>論文 答案構成トレーニング</h2>
        <p class="muted small">時間を計って答案構成（論点の抽出と流れのメモ）を書き、そのあとで論点チェックリストと照らして自己採点します。本番は各科目2時間（選択科目は3時間）ですが、日々の練習は構成30分を目安にしています。</p>
      </section>
      <section class="panel"><div class="plist" id="plist">${rows}</div></section>
      <p class="notice">事例はすべて架空のオリジナル問題です。論点リストは答案で触れたい項目の目安で、唯一の正解ではありません。</p>
    `;
    $("#plist").addEventListener("click", (e) => { const a = e.target.closest("a[data-id]"); if (!a) return; e.preventDefault(); go("problem", a.dataset.id); });
  }

  // ───────── 論文：1問 ─────────
  function viewProblem(id) {
    const p = ronbunById[id];
    if (!p) return go("ronbun");
    const hist = store.ronbun[id] || [];
    let remain = p.min * 60, running = false, revealed = false;
    main().innerHTML = `
      <div class="row spread"><button class="btn small" id="back">← 一覧へ</button><span class="small muted">${p.s}</span></div>
      <section class="panel">
        <h2>${esc(p.title)}</h2>
        <p class="facts">${esc(p.facts)}</p>
        <p class="ask">${esc(p.ask)}</p>
      </section>
      <section class="panel">
        <div class="row spread">
          <span class="timer num" id="clock"></span>
          <span class="row">
            <label class="field" style="grid-auto-flow:column;align-items:center">分 <input type="number" id="min" min="5" max="180" value="${p.min}" style="width:5em"></label>
            <button class="btn primary" id="tstart">開始</button><button class="btn" id="treset">リセット</button>
          </span>
        </div>
        <label class="field" for="memo">答案構成メモ（自動で下書き保存）</label>
        <textarea id="memo" rows="10" placeholder="例）1 処分性 → 肯定&#10;2 原告適格&#10;　(1) 規範：9条1項「法律上の利益」…&#10;　(2) あてはめ：…">${esc(store.drafts[id] || "")}</textarea>
        <div class="row"><button class="btn accent" id="reveal">論点を確認して自己採点する</button></div>
      </section>
      <section class="panel" id="check" hidden>
        <h2>論点チェックリスト</h2>
        <p class="small muted">構成メモで触れられた論点にチェックを付けてください。</p>
        <div class="checklist">${p.points.map((pt, i) => `<label><input type="checkbox" id="pt-${i}" data-i="${i}"><span>${esc(pt.t)}<span class="d">${esc(pt.d)}</span></span></label>`).join("")}</div>
        <p class="small"><b>ポイント</b>　${esc(p.tips)}</p>
        <div class="row spread"><span class="num" id="rate"></span><button class="btn primary" id="savechk">記録する</button></div>
      </section>
      ${hist.length ? `<section class="panel"><h2>これまでの記録</h2><div class="tablewrap"><table>
        <thead><tr><th>日付</th><th class="n">論点</th><th class="n">時間</th></tr></thead><tbody>
        ${hist.slice().reverse().map((h) => `<tr><td class="num">${jpDate(h.date)}</td><td class="n">${h.hit}/${h.of}（${Math.round(h.rate * 100)}%）</td><td class="n">${Math.round(h.sec / 60)}分</td></tr>`).join("")}
        </tbody></table></div></section>` : ""}
    `;
    const clock = $("#clock");
    const draw = () => {
      const over = remain < 0, a = Math.abs(remain);
      clock.textContent = `${over ? "+" : ""}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
      clock.classList.toggle("over", over);
    };
    const total = () => Number($("#min").value || p.min) * 60;
    draw();
    $("#min").addEventListener("change", () => { if (!running) { remain = total(); draw(); } });
    $("#tstart").addEventListener("click", (e) => {
      running = !running;
      e.target.textContent = running ? "一時停止" : "再開";
      clearInterval(timerId);
      if (running) timerId = setInterval(() => { remain--; draw(); }, 1000);
    });
    $("#treset").addEventListener("click", () => { running = false; clearInterval(timerId); remain = total(); $("#tstart").textContent = "開始"; draw(); });
    $("#memo").addEventListener("input", (e) => { store.drafts[id] = e.target.value; save(); });
    $("#back").addEventListener("click", () => go("ronbun"));
    const rate = () => {
      const hit = main().querySelectorAll(".checklist input:checked").length;
      $("#rate").textContent = `${hit} / ${p.points.length}（${Math.round((hit / p.points.length) * 100)}%）`;
      return hit;
    };
    $("#reveal").addEventListener("click", () => {
      revealed = true; running = false; clearInterval(timerId); $("#tstart").textContent = "再開";
      $("#check").hidden = false; rate(); $("#check").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    main().querySelectorAll(".checklist input").forEach((c) => c.addEventListener("change", rate));
    $("#savechk").addEventListener("click", () => {
      if (!revealed) return;
      const hit = rate();
      (store.ronbun[id] || (store.ronbun[id] = [])).push({ date: today(), hit, of: p.points.length, rate: hit / p.points.length, sec: Math.max(0, total() - remain) });
      logDay("r", 1); save();
      toast("記録しました");
      go("problem", id);
    });
  }

  // ───────── 判例カード ─────────
  const HANREI_SUBJECTS = ["憲法", "行政法", "民法", "商法", "民事訴訟法", "刑法", "刑事訴訟法"];
  const hview = { s: "", q: "", only: "all", mode: "list" };
  let deck = null; // カードで覚えるときの束
  function hanreiPool() {
    const q = hview.q.trim();
    return (DATA.hanrei || []).filter((h) =>
      (!hview.s || h.s === hview.s) &&
      (hview.only === "all" || (hview.only === "yet" ? !(store.hanrei[h.id] && store.hanrei[h.id].known) : store.hanrei[h.id] && store.hanrei[h.id].known)) &&
      (!q || [h.name, h.cite, h.topic, h.facts, h.holding].join(" ").includes(q)));
  }
  function viewHanrei() {
    const all = DATA.hanrei || [];
    const known = all.filter((h) => store.hanrei[h.id] && store.hanrei[h.id].known).length;
    const subs = HANREI_SUBJECTS.filter((s) => all.some((h) => h.s === s));
    main().innerHTML = `
      <section class="block">
        <div class="row spread"><h2>重要判例カード</h2><span class="small muted num">覚えた ${known} / ${all.length}</span></div>
        <p class="muted small">論文・短答で使う判例の判旨を確認します。「カードで覚える」では事案だけを見て判旨を思い出してから、めくって確認します。</p>
      </section>
      <section class="panel">
        <div class="chips" id="hs"><button class="chip" data-s="" aria-pressed="${!hview.s}">すべて</button>${subs.map((s) => `<button class="chip" data-s="${s}" aria-pressed="${hview.s === s}">${s}<span class="muted small"> ${all.filter((h) => h.s === s).length}</span></button>`).join("")}</div>
        <div class="grid2">
          <label class="field">キーワード<input type="search" id="hq" value="${esc(hview.q)}" placeholder="事件名・論点・日付など" style="border:1px solid var(--rule);border-radius:var(--r);padding:7px 10px;background:var(--surface)"></label>
          <label class="field">表示する判例
            <select id="honly"><option value="all">すべて</option><option value="yet">まだ覚えていない</option><option value="known">覚えた</option></select></label>
        </div>
        <div class="row spread"><span class="small muted" id="hcount"></span><button class="btn primary" id="hdeck">カードで覚える</button></div>
      </section>
      <section class="panel"><div id="hlist"></div></section>
    `;
    $("#honly").value = hview.only;
    const draw = () => {
      const list = hanreiPool();
      $("#hcount").textContent = `該当 ${list.length}件`;
      $("#hdeck").disabled = !list.length;
      $("#hlist").innerHTML = list.length ? list.map((h) => {
        const k = store.hanrei[h.id] && store.hanrei[h.id].known;
        return `<details class="item"><summary><span class="${k ? "mark-ok" : "muted"}">${k ? "✓" : "・"}</span><span><span class="small muted">${h.s}・${esc(h.topic)}</span><br><b>${esc(h.name)}</b>　<span class="small muted num">${esc(h.cite)}</span></span></summary>
          <div class="body"><p><span class="label">事案</span><br>${esc(h.facts)}</p><p><span class="label">判旨</span><br>${esc(h.holding)}</p>
          ${h.fun ? `<p class="hook"><span class="label">ひとこと</span>${esc(h.fun)}</p>` : ""}<span><span class="ref">${esc(h.point)}</span></span>
          <div class="row"><button class="btn small" data-known="${h.id}">${k ? "覚えたを外す" : "覚えた"}</button></div></div></details>`;
      }).join("") : `<p class="muted small">条件に合う判例はありません。</p>`;
    };
    draw();
    $("#hs").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; hview.s = b.dataset.s; viewHanrei(); });
    $("#hq").addEventListener("input", (e) => { hview.q = e.target.value; draw(); });
    $("#honly").addEventListener("change", (e) => { hview.only = e.target.value; draw(); });
    $("#hlist").addEventListener("click", (e) => {
      const b = e.target.closest("[data-known]"); if (!b) return;
      const st = store.hanrei[b.dataset.known] || (store.hanrei[b.dataset.known] = { known: false, n: 0 });
      st.known = !st.known; save();
      const open = b.closest("details"); draw();
      const again = $("#hlist").querySelector(`[data-known="${b.dataset.known}"]`);
      if (open && again) again.closest("details").open = true;
    });
    $("#hdeck").addEventListener("click", () => { deck = { ids: shuffle(hanreiPool().map((h) => h.id)), i: 0, flip: false, ok: 0 }; go("card"); });
  }
  function viewCard() {
    if (!deck || !deck.ids.length) return go("hanrei");
    if (deck.i >= deck.ids.length) {
      keyHandler = null;
      main().innerHTML = `<section class="panel"><span class="label">カードの結果</span>
        <div class="row" style="align-items:baseline"><span class="score">${deck.ok}<span class="small muted"> / ${deck.ids.length}</span></span><span class="muted">枚を覚えた</span></div>
        <div class="row"><button class="btn primary" id="hback">判例の一覧へ</button></div></section>`;
      $("#hback").addEventListener("click", () => go("hanrei"));
      return;
    }
    const h = DATA.hanrei.find((x) => x.id === deck.ids[deck.i]);
    main().innerHTML = `
      <div class="qhead"><span class="small"><b>判例カード</b>　<span class="num">${deck.i + 1} / ${deck.ids.length}</span></span><button class="btn small" id="hquit">終了</button></div>
      <div class="progress"><i style="width:${(deck.i / deck.ids.length) * 100}%"></i></div>
      <article class="qcard">
        <div class="tag"><b>${h.s}</b>${esc(h.topic)}</div>
        <div><h2>${esc(h.name)}</h2><span class="small muted num">${esc(h.cite)}</span></div>
        <p class="qtext" style="font-size:1rem">${esc(h.facts)}</p>
        ${deck.flip ? `<div class="verdict ok"><span class="v" style="color:var(--ink)">判旨</span><p>${esc(h.holding)}</p>${h.fun ? `<p class="hook"><span class="label">ひとこと</span>${esc(h.fun)}</p>` : ""}<span><span class="ref">${esc(h.point)}</span></span></div>
          <div class="answer"><button class="btn" id="hno">もう一度<small>まだ覚えていない</small></button><button class="btn" id="hyes">覚えた<small>次から外す</small></button></div>`
        : `<button class="btn primary" id="hflip">判旨を見る</button>`}
      </article>
      <span class="keys"><kbd>Space</kbd> めくる　<kbd>O</kbd> 覚えた　<kbd>X</kbd> もう一度</span>
    `;
    const mark = (known) => {
      const st = store.hanrei[h.id] || (store.hanrei[h.id] = { known: false, n: 0 });
      st.known = known; st.n += 1; save();
      if (known) deck.ok++; else deck.ids.push(h.id); // 覚えていないカードは束の最後に戻す
      deck.i++; deck.flip = false; viewCard();
    };
    $("#hquit").addEventListener("click", () => go("hanrei"));
    if (deck.flip) { $("#hyes").addEventListener("click", () => mark(true)); $("#hno").addEventListener("click", () => mark(false)); }
    else $("#hflip").addEventListener("click", () => { deck.flip = true; viewCard(); });
    keyHandler = (e) => {
      if (e.target.closest("input,textarea,select")) return;
      const k = e.key.toLowerCase();
      if (!deck.flip && (k === " " || k === "enter")) { e.preventDefault(); deck.flip = true; viewCard(); }
      else if (deck.flip && k === "o") mark(true);
      else if (deck.flip && k === "x") mark(false);
    };
  }

  // ───────── 過去問 ─────────
  // 論文：年度・科目ごとに出た論点の索引（問題文は載せない）
  // 短答：法務省の公開問題から自分で写した肢を取り込み、短答の演習・復習に混ぜる
  const ERA = (y) => (y >= 2019 ? `令和${y === 2019 ? "元" : y - 2018}年` : `平成${y - 1988}年`);
  const kview = { s: "", y: "" };
  function hanreiLink(name) {
    const h = (DATA.hanrei || []).find((x) => x.name === name || x.name.includes(name) || name.includes(x.name));
    return h ? `<a href="#" class="chip" style="text-decoration:none" data-hq="${esc(h.name)}">${esc(name)}</a>` : `<span class="chip" style="cursor:default">${esc(name)}</span>`;
  }
  function viewKakomon() {
    const idx = DATA.kakomon || [];
    const years = [...new Set(idx.map((k) => k.y))].sort((a, b) => b - a);
    const subs = RONBUN_SUBJECTS.filter((s) => idx.some((k) => k.s === s));
    const list = idx.filter((k) => (!kview.s || k.s === kview.s) && (!kview.y || k.y === Number(kview.y)))
      .sort((a, b) => b.y - a.y || RONBUN_SUBJECTS.indexOf(a.s) - RONBUN_SUBJECTS.indexOf(b.s));
    const mine = (store.custom || []);
    const sets = Object.values(mine.reduce((m, q) => { const k = q.set; (m[k] || (m[k] = { set: k, n: 0, s: q.s })).n++; return m; }, {}));
    main().innerHTML = `
      <section class="block">
        <h2>過去問</h2>
        <p class="muted small">司法試験の試験問題・短答の正解・論文の出題趣旨・採点実感は、法務省のホームページ（資格・採用情報 → 司法試験）で無料公開されています。ここでは論文の論点索引と、短答の過去問を自分で取り込んで解く機能を使えます。</p>
      </section>

      <section class="panel">
        <div class="row spread"><h2>論文 出題論点の索引</h2><span class="small muted">${idx.length}件</span></div>
        ${idx.length ? `<div class="grid2">
          <label class="field">科目<select id="ks"><option value="">すべて</option>${subs.map((s) => `<option ${s === kview.s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          <label class="field">年度<select id="ky"><option value="">すべて</option>${years.map((y) => `<option value="${y}" ${String(y) === kview.y ? "selected" : ""}>${ERA(y)}（${y}）</option>`).join("")}</select></label>
        </div>
        <div id="klist">${list.map((k) => `<details class="item"><summary><span class="muted">・</span><span><b>${ERA(k.y)}</b>　${k.s}${k.unsure ? ` <span class="pill mid">要確認</span>` : ""}<br><span class="small muted">${esc(k.topics[0] || "")}</span></span></summary>
          <div class="body"><ul style="margin:0;padding-left:1.2em">${k.topics.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
          ${k.cases && k.cases.length ? `<span class="label">関連する判例</span><div class="chips">${k.cases.map(hanreiLink).join("")}</div>` : ""}
          ${k.src && k.src.length ? `<span class="small muted">参照：${k.src.map((u) => esc(u.replace(/^https?:\/\//, "").split("/")[0])).join("、")}</span>` : ""}
          </div></details>`).join("") || `<p class="muted small">条件に合う年度はありません。</p>`}</div>
        <p class="small muted">論点は法務省の採点実感や予備校等の解説をもとにした要約です。「要確認」は出典が少ないもの（令和8年は出題趣旨・採点実感の公表前）です。答案を書く練習は、法務省の問題文と出題趣旨・採点実感で行ってください。</p>`
        : `<p class="muted small">索引はまだありません。</p>`}
      </section>

      <section class="panel">
        <div class="row spread"><h2>短答 過去問の取り込み</h2><span class="small muted num">取り込み済み ${mine.length}肢</span></div>
        <p class="small muted">法務省の短答式問題（PDF）から、肢ごとに文章と正誤を貼り付けてください。取り込んだ肢は短答の演習・復習に入ります。保存先はこの端末だけで、外には送られません。</p>
        <details><summary class="small" style="cursor:pointer">書き方の例</summary>
<pre style="white-space:pre-wrap;font-size:.82rem;background:var(--paper);padding:10px;border-radius:var(--r);margin:8px 0 0">#令和7年 憲法 第1問
ア 〔記述をここに貼る〕 ○
イ 〔記述をここに貼る〕 ×
→ 解説やメモ（任意。直前の肢に付きます）

#令和7年 憲法 第2問
1 〔記述〕 ×</pre>
          <p class="small muted">「#」の行に年度・科目・問題番号を書くと、その下の肢に付きます。各行の最後に ○ か ×（正・誤でも可）を書きます。</p></details>
        <label class="field" for="imp-past">貼り付け</label>
        <textarea id="imp-past" rows="8" placeholder="#令和7年 民法 第1問&#10;ア ……。 ○&#10;イ ……。 ×">${esc(store.drafts["__past"] || "")}</textarea>
        <div class="row"><label class="field" style="grid-auto-flow:column;align-items:center">科目が書かれていない行の科目
          <select id="imp-subj">${SUBJECTS.map((s) => `<option>${s}</option>`).join("")}</select></label>
          <button class="btn" id="imp-check">確認する</button></div>
        <div id="imp-preview"></div>
        ${sets.length ? `<span class="label">取り込んだ問題</span>
          <div class="tablewrap"><table><thead><tr><th>問題</th><th class="n">肢</th><th></th></tr></thead><tbody>
          ${sets.map((x) => `<tr><td>${esc(x.set)}</td><td class="n">${x.n}</td><td class="n"><button class="btn small" data-delset="${esc(x.set)}">削除</button></td></tr>`).join("")}
          </tbody></table></div>
          <div class="row"><button class="btn primary" id="past-go">過去問だけを解く（${mine.length}肢）</button></div>` : ""}
      </section>
    `;
    if (idx.length) {
      $("#ks").addEventListener("change", (e) => { kview.s = e.target.value; viewKakomon(); });
      $("#ky").addEventListener("change", (e) => { kview.y = e.target.value; viewKakomon(); });
      $("#klist").addEventListener("click", (e) => {
        const a = e.target.closest("[data-hq]"); if (!a) return;
        e.preventDefault(); hview.q = a.dataset.hq; hview.s = ""; hview.only = "all"; go("hanrei");
      });
    }
    $("#imp-past").addEventListener("input", (e) => { store.drafts["__past"] = e.target.value; save(); });
    $("#imp-check").addEventListener("click", () => {
      const items = parsePast($("#imp-past").value, $("#imp-subj").value);
      const have = new Set(mine.map((q) => q.id));
      const fresh = items.filter((q) => !have.has(q.id));
      const bad = items.bad || [];
      $("#imp-preview").innerHTML = `<div class="confirm" style="border-color:var(--rule);background:var(--paper)">
        <b>${items.length}肢を読み取りました${items.length - fresh.length ? `（うち${items.length - fresh.length}肢は取り込み済み）` : ""}</b>
        ${items.slice(0, 5).map((q) => `<span class="small"><span class="${q.a ? "mark-ok" : "mark-ng"}">${q.a ? "○" : "×"}</span> ${esc(q.r)}：${esc(q.q.slice(0, 40))}${q.q.length > 40 ? "…" : ""}</span>`).join("")}
        ${items.length > 5 ? `<span class="small muted">ほか${items.length - 5}肢</span>` : ""}
        ${bad.length ? `<span class="small" style="color:var(--ng)">正誤（○・×）が見つからず読み取れなかった行：${bad.length}行（例：${esc(bad[0].slice(0, 30))}…）</span>` : ""}
        <div class="row"><button class="btn primary" id="imp-do" ${fresh.length ? "" : "disabled"}>${fresh.length}肢を取り込む</button></div></div>`;
      if (fresh.length) $("#imp-do").addEventListener("click", () => {
        store.custom = (store.custom || []).concat(fresh); store.drafts["__past"] = ""; save(); refreshPool();
        toast(`${fresh.length}肢を取り込みました`); go("kakomon");
      });
    });
    main().querySelectorAll("[data-delset]").forEach((b) => b.addEventListener("click", () => {
      const set = b.dataset.delset;
      b.outerHTML = `<button class="btn small danger" data-delyes="${esc(set)}">本当に削除</button>`;
      main().querySelector(`[data-delyes="${CSS.escape(set)}"]`).addEventListener("click", () => {
        store.custom = store.custom.filter((q) => q.set !== set); save(); refreshPool(); toast("削除しました"); go("kakomon");
      });
    }));
    if (sets.length) $("#past-go").addEventListener("click", () => startSession(shuffle(mine.map((q) => q.id)), { mode: "normal", label: "短答 過去問" }));
  }
  function parsePast(text, defSubj) {
    const out = []; out.bad = [];
    let ctx = { era: "", s: defSubj, no: "" };
    const zen = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    for (const raw of text.split(/\r?\n/)) {
      const line = zen(raw.trim());
      if (!line) continue;
      if (/^[#＃]/.test(line)) {
        const era = line.match(/(令和|平成)\s*(元|\d+)\s*年/);
        const subj = line.match(/憲法|民法|刑法/);
        const no = line.match(/第?\s*(\d+)\s*問/);
        ctx = { era: era ? `${era[1]}${era[2]}年` : "", s: subj ? subj[0] : defSubj, no: no ? no[1] : "" };
        continue;
      }
      if (/^(→|解説[:：])/.test(line)) {
        if (out.length) out[out.length - 1].e = (out[out.length - 1].e === "（解説なし）" ? "" : out[out.length - 1].e + "\n") + line.replace(/^(→|解説[:：])\s*/, "");
        continue;
      }
      const m = line.match(/^(?:([ア-オ]|[1-5]|[a-e])[\s．.、)）:：]+)?(.+?)[\s　]*[（(]?(○|〇|×|✕|✖|正|誤)[)）]?$/);
      if (!m || m[2].length < 4) { out.bad.push(line); continue; }
      const a = /[○〇正]/.test(m[3]);
      const set = [ctx.era, ctx.s, ctx.no ? `第${ctx.no}問` : ""].filter(Boolean).join(" ");
      const label = `${set}${m[1] ? " " + m[1] : ""}`;
      let h = 0; for (const c of ctx.s + m[2]) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      out.push({ id: "u-" + h.toString(36), s: ctx.s, f: "過去問" + (ctx.era ? " " + ctx.era : ""), q: m[2], a,
        e: "（解説なし）", r: label || "短答 過去問", set: set || `${ctx.s}（年度なし）`, past: true });
    }
    return out;
  }

  // ───────── 記録 ─────────
  function viewRecord() {
    const fieldRows = [];
    SUBJECTS.forEach((s) => {
      const fields = [...new Set(ALL.filter((q) => q.s === s).map((q) => q.f))];
      fields.forEach((f) => {
        const qs = ALL.filter((q) => q.s === s && q.f === f);
        let done = 0, n = 0, c = 0;
        qs.forEach((q) => { const st = store.q[q.id]; if (st) { done++; n += st.n; c += st.c; } });
        fieldRows.push({ s, f, total: qs.length, done, rate: n ? c / n : null });
      });
    });
    const weak = Object.entries(store.q).filter(([id]) => byId[id])
      .map(([id, st]) => ({ id, st, r: st.c / st.n })).filter((x) => x.r < 1)
      .sort((a, b) => a.r - b.r || b.st.n - a.st.n).slice(0, 10);
    const days = Object.keys(store.log).length;
    const totalT = Object.values(store.log).reduce((a, d) => a + (d.t || 0), 0);
    const totalR = Object.values(store.log).reduce((a, d) => a + (d.r || 0), 0);

    main().innerHTML = `
      <div class="stats">
        <div><span class="label">学習した日</span><b>${days}<span class="small muted"> 日</span></b></div>
        <div><span class="label">解いた肢（延べ）</span><b>${totalT}</b></div>
        <div><span class="label">論文の構成</span><b>${totalR}<span class="small muted"> 問</span></b></div>
      </div>
      <section class="panel">
        <h2>分野別の正答率</h2>
        <div class="tablewrap"><table>
          <thead><tr><th>科目</th><th>分野</th><th class="n">解いた肢</th><th class="n">正答率</th></tr></thead>
          <tbody>${fieldRows.map((r) => `<tr><td>${r.s}</td><td>${esc(r.f)}</td><td class="n">${r.done}/${r.total}</td>
            <td class="n" style="color:${r.rate == null ? "var(--muted)" : r.rate < 0.6 ? "var(--ng)" : "inherit"}">${pct(r.rate)}</td></tr>`).join("")}</tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>間違えやすい肢</h2>
        ${weak.length ? `<div>${weak.map(({ id, st }) => { const q = byId[id]; return `<details class="item"><summary><span class="mark-ng num small">${st.c}/${st.n}</span><span><span class="small muted">${q.s}・${esc(q.f)}</span><br>${esc(q.q)}</span></summary>
          <div class="body"><span>正答：<b>${q.a ? "○ 正しい" : "× 誤り"}</b></span><p>${esc(q.e)}</p><span><span class="ref">${esc(q.r)}</span></span></div></details>`; }).join("")}</div>
          <div class="row"><button class="btn" id="weak-go">この${weak.length}肢を解き直す</button></div>`
          : `<p class="muted small">まだ間違えた肢はありません。</p>`}
      </section>
      <section class="panel">
        <h2>バックアップ</h2>
        <p class="small muted">記録はこのブラウザの中にだけ保存されています。別の端末に移すときや、ブラウザのデータを消す前に書き出してください。</p>
        <div class="row">
          <button class="btn" id="exp">書き出す</button>
          <button class="btn" id="imp-open">読み込む</button>
          <button class="btn danger" id="reset">記録をすべて消す</button>
        </div>
        <div id="io"></div>
      </section>
    `;
    if (weak.length) $("#weak-go").addEventListener("click", () => startSession(shuffle(weak.map((w) => w.id)), { mode: "normal", label: "苦手な肢" }));
    const io = $("#io");
    $("#exp").addEventListener("click", () => {
      const json = JSON.stringify(store);
      io.innerHTML = `<div style="display:grid;gap:8px"><textarea id="exp-text" rows="5" readonly>${esc(json)}</textarea>
        <div class="row"><button class="btn small" id="copy">コピー</button><button class="btn small" id="dl">ファイルに保存</button></div></div>`;
      $("#copy").addEventListener("click", () => {
        navigator.clipboard.writeText(json).then(() => toast("コピーしました"), () => { $("#exp-text").select(); toast("選択しました。コピーしてください"); });
      });
      $("#dl").addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        a.download = `shihou-note-${today()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
      });
    });
    $("#imp-open").addEventListener("click", () => {
      io.innerHTML = `<div style="display:grid;gap:8px"><label class="field" for="imp-text">書き出したデータを貼り付けるか、ファイルを選んでください。今の記録は置き換わります。</label>
        <textarea id="imp-text" rows="5"></textarea>
        <div class="row"><input type="file" id="imp-file" accept="application/json,.json"><button class="btn small primary" id="imp">読み込む</button></div></div>`;
      $("#imp-file").addEventListener("change", (e) => {
        const f = e.target.files[0]; if (!f) return;
        const r = new FileReader(); r.onload = () => { $("#imp-text").value = r.result; }; r.readAsText(f);
      });
      $("#imp").addEventListener("click", () => {
        try {
          const d = JSON.parse($("#imp-text").value);
          if (!d || typeof d.q !== "object" || typeof d.log !== "object") throw new Error();
          store = Object.assign(blank(), d); save(); refreshPool(); toast("読み込みました"); go("record");
        } catch (e) { toast("読み込めませんでした。書き出したデータをそのまま貼り付けてください"); }
      });
    });
    $("#reset").addEventListener("click", () => {
      io.innerHTML = `<div class="confirm"><b>短答・論文・判例の記録と下書きをすべて消します（取り込んだ過去問は残ります）。元に戻せません。</b>
        <div class="row"><button class="btn danger" id="reset-yes">消す</button><button class="btn" id="reset-no">やめる</button></div></div>`;
      $("#reset-yes").addEventListener("click", () => { const st = store.settings, cu = store.custom; store = blank(); store.settings = st; store.custom = cu; save(); refreshPool(); toast("消しました"); go("record"); });
      $("#reset-no").addEventListener("click", () => { io.innerHTML = ""; });
    });
  }

  // ───────── 起動 ─────────
  document.addEventListener("keydown", (e) => { if (keyHandler) keyHandler(e); });
  window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS[v]) go(v); });
  document.querySelectorAll("nav.tabs a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    go(a.dataset.v);
    try { history.replaceState(null, "", "#" + a.dataset.v); } catch (err) { /* 表示には影響しない */ }
  }));
  const first = (location.hash || "").slice(1);
  go(VIEWS[first] ? first : "home");
})();
