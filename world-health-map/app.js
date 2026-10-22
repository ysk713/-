/* 世界医療情報マップ: 地図の描画とパネル表示 */
"use strict";

const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json";
const REGIONS = [
  ["all", "世界全体", "World"], ["asia", "アジア", "Asia"], ["middle_east", "中東", "Middle East"],
  ["europe", "ヨーロッパ", "Europe"], ["africa", "アフリカ", "Africa"], ["north_america", "北米・中米", "North & Central America"],
  ["south_america", "南米", "South America"], ["oceania", "オセアニア", "Oceania"],
];
const REGION_NAME = Object.fromEntries(REGIONS);
const REGION_EN = Object.fromEntries(REGIONS.map(([k, , en]) => [k, en]));
const HEAT = ["--heat-0", "--heat-1", "--heat-2", "--heat-3", "--heat-4"];
const DZ = ["--dz-0", "--dz-1", "--dz-2", "--dz-3", "--dz-4"];
// 収集スクリプト（scripts/collect.py の DISEASES）と同じ病名。URL の # に使う英字の名前を付ける
const DISEASES = [
  ["covid", "COVID-19", "COVID-19"], ["flu", "インフルエンザ", "Influenza"], ["avian-flu", "鳥インフルエンザ", "Avian influenza"],
  ["dengue", "デング熱", "Dengue"], ["malaria", "マラリア", "Malaria"], ["cholera", "コレラ", "Cholera"],
  ["measles", "麻しん", "Measles"], ["mpox", "エムポックス", "Mpox"], ["ebola", "エボラ", "Ebola"],
  ["marburg", "マールブルグ", "Marburg"], ["tb", "結核", "Tuberculosis"], ["hiv", "HIV/エイズ", "HIV/AIDS"],
  ["polio", "ポリオ", "Polio"], ["yellow-fever", "黄熱", "Yellow fever"], ["rabies", "狂犬病", "Rabies"],
  ["chikungunya", "チクングニア", "Chikungunya"], ["zika", "ジカ熱", "Zika"], ["mers", "MERS", "MERS"],
  ["plague", "ペスト", "Plague"], ["diphtheria", "ジフテリア", "Diphtheria"], ["pertussis", "百日せき", "Pertussis"],
  ["meningitis", "髄膜炎", "Meningitis"], ["lassa", "ラッサ熱", "Lassa fever"], ["nipah", "ニパウイルス", "Nipah virus"],
  ["oropouche", "オロプーシェ", "Oropouche"], ["hfmd", "手足口病", "Hand, foot and mouth disease"],
  ["food-poisoning", "食中毒", "Food poisoning"], ["heatstroke", "熱中症", "Heatstroke"], ["air-pollution", "大気汚染", "Air pollution"],
];
const DISEASE_BY_KEY = new Map(DISEASES.map(([k, v]) => [k, v]));
const DISEASE_KEY = new Map(DISEASES.map(([k, v]) => [v, k]));
const DISEASE_EN = new Map(DISEASES.map(([, v, en]) => [v, en]));

/* ---------- 表示言語（日本語 / English） ---------- */
const LANG_KEY = "whm-lang";
// 同じ箇所の日本語と英語を並べて書き、表示中の言語のほうを返す
const L = (ja, en) => (state.lang === "en" ? en : ja);
const cname = (c) => (c ? L(c.ja, c.en) : "");
const rname = (r) => L(REGION_NAME[r], REGION_EN[r]) || "";
const dname = (d) => L(d, DISEASE_EN.get(d) || d);
const per = (n, ja, en1, enN) => L(`${n} ${ja}`, `${n} ${n === 1 ? en1 : enN}`);

const state = {
  countries: [],      // data/countries.json
  byA2: new Map(),
  byTopoId: new Map(),
  index: null,        // data/news/index.json
  region: "all",
  selected: null,     // a2
  langFilter: "all",
  disease: null,      // 病気の分布を表示中ならその病名（データ上の日本語名）
  lang: "ja",
  dz: null,           // Map<a2, Map<病名, 記事数>>
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
};
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString(L("ja-JP", "en-US"), { month: L("numeric", "short"), day: "numeric", weekday: "short" });
};
const fmtDateTime = (iso) => new Date(iso).toLocaleString(L("ja-JP", "en-US"), { dateStyle: "medium", timeStyle: "short" });

/* ---------- データ読み込み ---------- */
async function loadJSON(url) {
  // 収集データは毎日差し替わるので、GitHub Pages や途中のキャッシュに古い版（未作成時の404を含む）を返させない
  if (url.startsWith("data/")) url += `?t=${Date.now()}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function init() {
  try { if (localStorage.getItem(LANG_KEY) === "en") state.lang = "en"; } catch { /* 保存できない環境 */ }
  document.querySelectorAll("#lang button").forEach((b) => { b.onclick = () => setLang(b.dataset.lang); });
  applyStaticText();
  buildRegionChips();
  const [world, countries, index] = await Promise.all([
    loadJSON(WORLD_URL),
    loadJSON("data/countries.json"),
    loadJSON("data/news/index.json").catch(() => null),
  ]);
  state.countries = countries;
  for (const c of countries) {
    state.byA2.set(c.a2, c);
    state.byTopoId.set(c.id, c);
  }
  state.index = index;
  showUpdated();
  fillCountryList();
  drawMap(world);
  initTranslation();
  fillDiseaseSelect();
  bindSearch();
  window.addEventListener("hashchange", () => {
    if (tour) endTour({ silent: true }); // ツアー中に国や地域を選んだらツアーを終えてそちらを表示する
    fromHash();
  });
  $("#tour-btn").onclick = () => (tour ? endTour() : toggleTourMenu());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#tour-menu").hidden) toggleTourMenu(false);
    else if (tour) endTour();
  });
  // メニューの外を押したら閉じる
  document.addEventListener("pointerdown", (e) => {
    if (!$("#tour-menu").hidden && !e.target.closest("#tour-menu, #tour-btn")) toggleTourMenu(false);
  });
  fromHash();
}

function showUpdated() {
  $("#updated").textContent = state.index
    ? L(`最終更新: ${fmtDateTime(state.index.generated_at)}`, `Updated ${fmtDateTime(state.index.generated_at)}`)
    : L("まだ収集データがありません", "No data collected yet");
}

function fillCountryList() {
  const list = [...state.countries].sort((a, b) => cname(a).localeCompare(cname(b), state.lang));
  $("#country-list").replaceChildren(...list.map((c) => el("option", { value: cname(c) }, L(c.en, c.ja))));
}

// HTML に直接書いた文言（data-en 属性に英語を持たせている）を表示言語に合わせる
function applyStaticText() {
  document.documentElement.lang = state.lang;
  document.title = L("世界医療情報マップ", "World Health News Map");
  for (const n of document.querySelectorAll("[data-en]")) {
    n.dataset.ja ??= n.textContent;
    n.textContent = L(n.dataset.ja, n.dataset.en);
  }
  for (const [attr, key] of [["placeholder", "enPlaceholder"], ["aria-label", "enLabel"], ["title", "enTitle"]]) {
    for (const n of document.querySelectorAll(`[data-${key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}]`)) {
      const jaKey = "ja" + key.slice(2);
      n.dataset[jaKey] ??= n.getAttribute(attr) || "";
      n.setAttribute(attr, L(n.dataset[jaKey], n.dataset[key]));
    }
  }
  document.querySelectorAll("#lang button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.lang === state.lang)));
}

function setLang(lang) {
  if (lang === state.lang) return;
  state.lang = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* 保存できない環境 */ }
  applyStaticText();
  tourButtonLabel();
  buildRegionChips();
  showUpdated();
  fillCountryList();
  recolor();
  syncControls();
  fillDiseaseSelect();
  initTranslation();
  if (tour) showTourCard();
  else if (state.selected) showCountry(state.selected);
  else if (state.disease) showDisease(state.disease);
  else showOverview();
}

/* ---------- 地図（地球儀） ---------- */
let svg, path, paths, projection, sphere, graticule, baseScale, spinTimer;
const MIN_K = 0.8, MAX_K = 10;
let zoomK = 1;

function countryOf(feature) {
  return state.byTopoId.get(feature.id ?? "name:" + feature.properties.name);
}
function countOf(c) {
  if (!c) return 0;
  if (state.disease) return state.dz?.get(c.a2)?.get(state.disease) || 0;
  return state.index?.countries?.[c.a2]?.news || 0;
}

/* ---------- 病気ごとの分布（ニュース見出しの病名タグから集計） ---------- */
// 全記事を持つ環境（アーティファクト版）はそれで数える。ここでは null を返し、索引の値を使う
async function allCountryNews() { return null; }

async function ensureDiseaseCounts() {
  if (state.dz) return state.dz;
  const dz = new Map();
  const idx = state.index?.countries || {};
  const all = Object.values(idx).some((v) => v.diseases) ? null : await allCountryNews();
  for (const c of state.countries) {
    const m = new Map();
    if (idx[c.a2]?.diseases) {
      for (const [k, n] of Object.entries(idx[c.a2].diseases)) m.set(k, n);
    } else if (all?.[c.a2]) {
      for (const n of all[c.a2].news || []) for (const t of n.tags || []) m.set(t, (m.get(t) || 0) + 1);
    } else {
      for (const t of idx[c.a2]?.tags || []) m.set(t, 1); // 古い索引には上位5件の病名しかない
    }
    dz.set(c.a2, m);
  }
  state.dz = dz;
  return dz;
}

// 病名ごとの「報道のある国の数」と記事数（多い順）
function diseaseTotals() {
  const tot = new Map();
  for (const [, m] of state.dz || []) {
    for (const [k, n] of m) {
      const t = tot.get(k) || { countries: 0, articles: 0 };
      t.countries += 1; t.articles += n;
      tot.set(k, t);
    }
  }
  return [...tot].filter(([k]) => DISEASE_KEY.has(k)).sort((a, b) => b[1].countries - a[1].countries || b[1].articles - a[1].articles);
}

async function fillDiseaseSelect() {
  await ensureDiseaseCounts();
  const sel = $("#disease");
  sel.replaceChildren(el("option", { value: "" }, L("病気の分布を見る…", "Disease map…")),
    ...diseaseTotals().map(([k, t]) => el("option", { value: DISEASE_KEY.get(k) },
      L(`${k}（${t.countries}か国）`, `${dname(k)} (${per(t.countries, "", "country", "countries").trim()})`))));
  sel.value = state.disease ? DISEASE_KEY.get(state.disease) : "";
  sel.onchange = () => { location.hash = sel.value ? "d-" + sel.value : ""; };
  // 最初の画面は集計前に描いているので、「話題の病気」を入れて描き直す
  if (!state.selected && !state.disease) showOverview();
}

function render() {
  sphere.attr("d", path);
  graticule.attr("d", path);
  paths.attr("d", path);
  if (tour) drawTour();
}

function drawMap(world) {
  const features = topojson.feature(world, world.objects.countries).features;
  svg = d3.select("#map");
  const { width, height } = svg.node().getBoundingClientRect();
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  // 正射図法で地球儀として描く。初期表示は日本を含むアジア側
  projection = d3.geoOrthographic().rotate([-120, -15]).fitExtent([[12, 12], [width - 12, height - 12]], { type: "Sphere" });
  baseScale = projection.scale();
  path = d3.geoPath(projection);

  sphere = svg.append("path").datum({ type: "Sphere" }).attr("class", "sphere");
  graticule = svg.append("path").datum(d3.geoGraticule10()).attr("class", "graticule");


  const tip = $("#tooltip");
  paths = svg.append("g").selectAll("path").data(features).join("path")
    .attr("class", (f) => "country" + (countryOf(f) ? "" : " no-data"))
    .on("mousemove", (ev, f) => {
      const c = countryOf(f);
      const info = c && state.index?.countries?.[c.a2];
      tip.replaceChildren(
        el("strong", {}, c ? cname(c) : f.properties.name),
        !c ? L("データなし", "No data")
          : state.disease ? L(`${state.disease}の記事 ${countOf(c)} 件`, `${dname(state.disease)}: ${per(countOf(c), "", "article", "articles").trim()}`)
          : L(`記事 ${info?.news || 0} 件・動画 ${info?.videos || 0} 本`,
              `${per(info?.news || 0, "", "article", "articles").trim()} · ${per(info?.videos || 0, "", "video", "videos").trim()}`),
        !state.disease && info?.tags?.length ? el("div", { class: "muted" }, info.tags.map(dname).join(L("・", ", "))) : null,
      );
      const box = svg.node().parentNode.getBoundingClientRect();
      tip.style.left = Math.min(ev.clientX - box.left + 14, box.width - 200) + "px";
      tip.style.top = ev.clientY - box.top + 14 + "px";
      tip.hidden = false;
    })
    .on("mouseleave", () => (tip.hidden = true))
    .on("click", (ev, f) => {
      const c = countryOf(f);
      if (c) location.hash = c.a2;
    });
  recolor();
  render();

  // ドラッグで回転（拡大しているほどゆっくり回る）
  svg.call(d3.drag()
    .filter((ev) => !ev.button && !(ev.touches && ev.touches.length > 1))
    .clickDistance(4)
    .on("start", () => { stopSpin(); svg.interrupt(); tip.hidden = true; svg.classed("dragging", true); })
    .on("drag", (ev) => {
      const k = 75 / projection.scale();
      const [lon, lat] = projection.rotate();
      projection.rotate([lon + ev.dx * k, Math.max(-85, Math.min(85, lat - ev.dy * k))]);
      render();
    })
    .on("end", () => svg.classed("dragging", false)));

  // ホイールで拡大縮小
  svg.on("wheel", (ev) => {
    ev.preventDefault();
    stopSpin();
    setZoom(zoomK * Math.pow(2, -ev.deltaY * (ev.deltaMode ? 0.05 : 0.002)));
  }, { passive: false });

  $("#zoom-in").onclick = () => animateTo(null, zoomK * 1.6);
  $("#zoom-out").onclick = () => animateTo(null, zoomK / 1.6);
  $("#zoom-reset").onclick = () => animateTo(null, 1);
  startSpin();
}

// 色の段階は記事数の分位で決める（データ量に合わせて自動調整）。病気の表示中は別の色で塗る
function recolor() {
  const scale = state.disease ? DZ : HEAT;
  const counts = state.countries.map(countOf).filter((n) => n > 0).sort(d3.ascending);
  const thresholds = [0.2, 0.4, 0.6, 0.8].map((q) => d3.quantile(counts, q) || 0);
  paths.attr("fill", (f) => {
    const n = countOf(countryOf(f));
    return n > 0 ? `var(${scale[d3.bisectRight(thresholds, n - 0.5)]})` : "var(--land-empty)";
  });
  $("#legend-title").textContent = state.disease
    ? L(`「${state.disease}」の報道件数`, `News mentioning ${dname(state.disease)}`)
    : L("直近の記事数", "Recent articles");
  $("#legend-scale").replaceChildren(...scale.map((v) => el("span", { style: `background:var(${v})` })));
}

function setZoom(k) {
  zoomK = Math.max(MIN_K, Math.min(MAX_K, k));
  projection.scale(baseScale * zoomK);
  render();
}

// 何も選んでいないときは地球儀をゆっくり自転させる（操作すると止まる）
function startSpin() {
  stopSpin();
  spinTimer = d3.timer(() => {
    const [lon, lat] = projection.rotate();
    projection.rotate([lon + 0.08, lat]);
    render();
  });
}
function stopSpin() {
  spinTimer?.stop();
  spinTimer = null;
}

// 指定した地点が正面に来るよう回転し、倍率 k まで拡大する
function animateTo(center, k, onEnd) {
  stopSpin();
  const r0 = projection.rotate();
  const r1 = center ? [-center[0], -center[1], 0] : r0;
  // 経度は近い方向へ回す
  r1[0] = r0[0] + ((((r1[0] - r0[0]) % 360) + 540) % 360) - 180;
  const iRot = d3.interpolate(r0, r1);
  const iK = d3.interpolate(zoomK, Math.max(MIN_K, Math.min(MAX_K, k)));
  svg.transition().duration(900).tween("globe", () => (t) => {
    projection.rotate(iRot(t));
    setZoom(iK(t));
  }).on("end", onEnd || null);
}

function zoomToCountry(a2) {
  const feats = paths.filter((f) => countryOf(f)?.a2 === a2).data();
  if (!feats.length) return;
  const fc = { type: "FeatureCollection", features: feats };
  // 国の広さ（立体角）から倍率を決める。ロシアなど大きな国は拡大しすぎない
  const radius = Math.sqrt(d3.geoArea(fc) / Math.PI);
  animateTo(d3.geoCentroid(fc), Math.min(4, Math.max(1.2, 0.35 / radius)));
}

// 病気の分布を開いたら、報道の最も多い国が正面に来るよう回す（全体が見える倍率のまま）
function focusDisease() {
  const top = state.countries.map((c) => ({ c, n: countOf(c) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n)[0];
  const feats = top ? paths.filter((f) => countryOf(f) === top.c).data() : [];
  if (feats.length) animateTo(d3.geoCentroid({ type: "FeatureCollection", features: feats }), 1);
  else zoomToRegion("all");
}

function zoomToRegion(region) {
  if (region === "all") {
    animateTo(null, 1, startSpin);
    return;
  }
  // 遠隔の海外領土で中心がずれないよう、南極と小さな地域は除く
  const feats = paths.filter((f) => {
    const c = countryOf(f);
    return c?.region === region && c.a2 !== "AQ" && d3.geoArea(f) > 0.0005;
  }).data();
  if (feats.length) animateTo(d3.geoCentroid({ type: "FeatureCollection", features: feats }), 1.7);
}

function highlight() {
  paths
    .classed("selected", (f) => countryOf(f)?.a2 === state.selected)
    .classed("dim", (f) => state.region !== "all" && countryOf(f)?.region !== state.region);
}

/* ---------- 操作 ---------- */
function buildRegionChips() {
  $("#regions").replaceChildren(...REGIONS.map(([id, name]) =>
    el("button", { class: "chip", role: "tab", "data-region": id, "aria-selected": String(id === state.region && !state.disease),
      onclick: () => { location.hash = id === "all" ? "" : "region=" + id; } }, rname(id))));
}

function bindSearch() {
  const input = $("#search");
  const go = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    const c = state.countries.find((x) => x.ja === input.value.trim() || x.en === input.value.trim())
      || state.countries.find((x) => [x.ja, x.en, x.a2, x.a3, ...x.aliases_ja, ...x.aliases_en].some((n) => n.toLowerCase() === q))
      || state.countries.find((x) => x.ja.includes(q) || x.en.toLowerCase().includes(q));
    if (c) { location.hash = c.a2; input.blur(); }
  };
  input.addEventListener("change", go);
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
}

async function fromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("d-") && DISEASE_BY_KEY.has(h.slice(2))) {
    await ensureDiseaseCounts();
    state.disease = DISEASE_BY_KEY.get(h.slice(2));
    state.selected = null;
    state.region = "all";
    syncControls();
    recolor();
    focusDisease();
    showDisease(state.disease);
    return;
  }
  // 国を開いたときは病気の表示を続け、それ以外（世界全体・地域）に戻ったら解除する
  if (!state.byA2.has(h) && state.disease) { state.disease = null; recolor(); }
  if (h.startsWith("region=")) {
    state.region = h.slice(7);
    state.selected = null;
  } else if (state.byA2.has(h)) {
    state.selected = h;
    state.region = "all";
  } else {
    state.selected = null;
    state.region = "all";
  }
  syncControls();
  if (state.selected) {
    zoomToCountry(state.selected);
    showCountry(state.selected);
  } else {
    zoomToRegion(state.region);
    showOverview();
  }
}

function syncControls() {
  document.querySelectorAll("#regions .chip").forEach((b) => b.setAttribute("aria-selected", String(!state.disease && b.dataset.region === state.region)));
  highlight();
  $("#search").value = state.selected ? cname(state.byA2.get(state.selected)) : "";
  $("#disease").value = state.disease ? DISEASE_KEY.get(state.disease) : "";
}

/* ---------- 見出しの日本語訳（パソコン版 Chrome の内蔵翻訳。無料・端末内で処理） ---------- */
let tr = { ready: false, translators: new Map(), detector: null, done: new Map(), queue: Promise.resolve() };
const hasKana = (t) => /[\u3040-\u30ff]/.test(t);
// 日本語表示では英語などの見出しを日本語に、英語表示では日本語の見出しを英語に訳す
const trSource = () => L("en", "ja");

async function initTranslation() {
  tr = { ready: false, translators: new Map(), detector: null, done: new Map(), queue: Promise.resolve(), lang: state.lang };
  const btn = $("#translate-btn");
  btn.disabled = false;
  btn.hidden = true;
  btn.title = "";
  btn.textContent = L("見出しを日本語に訳す", "Translate Japanese headlines");
  // 使えない理由を画面に出す（何も表示されないと、壊れているのか分からないため）
  const note = (text) => { btn.hidden = false; btn.disabled = true; btn.textContent = text; btn.title = L(TRANSLATE_HELP, TRANSLATE_HELP_EN); };
  if (!("Translator" in self)) return note(L("見出しの翻訳：このブラウザは未対応", "Translation: not supported in this browser"));
  const status = await Translator.availability({ sourceLanguage: trSource(), targetLanguage: state.lang }).catch(() => "unavailable");
  if (tr.lang !== state.lang) return; // 確認中に言語が切り替わった
  if (status === "unavailable") return note(L("見出しの翻訳：この端末では使えません", "Translation: not available on this device"));
  if (status === "available") {
    return enableTranslation().catch((e) => { console.error(e); note(L("見出しの翻訳を開始できませんでした", "Could not start translation")); });
  }
  // 初回は翻訳モデルのダウンロードが必要。ブラウザの決まりでボタン操作から始める
  btn.hidden = false;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = L("翻訳モデルを準備中…", "Preparing translation…");
    try {
      await enableTranslation((p) => { btn.textContent = `${L("翻訳モデルを準備中…", "Preparing translation…")} ${Math.round(p * 100)}%`; });
      btn.hidden = true;
    } catch (e) {
      console.error(e);
      note(L("翻訳を使えませんでした（もう一度読み込んでください）", "Translation failed (please reload)"));
    }
  };
}
const TRANSLATE_HELP = "パソコン版 Google Chrome（バージョン138以降）で見ると、見出しを無料で日本語に訳せます。スマホ・Safari・Firefox では原文のままです。";
const TRANSLATE_HELP_EN = "In desktop Google Chrome (version 138 or later), Japanese headlines can be translated for free. Other browsers show the original text.";

async function enableTranslation(onProgress) {
  const monitor = onProgress ? (m) => m.addEventListener("downloadprogress", (e) => onProgress(e.loaded)) : undefined;
  const src = trSource();
  tr.translators.set(src, await Translator.create({ sourceLanguage: src, targetLanguage: state.lang, monitor }));
  // 動画タイトルなど言語が分からない見出し用（使えなければ英語とみなす）
  if (state.lang === "ja" && "LanguageDetector" in self) tr.detector = await LanguageDetector.create().catch(() => null);
  tr.ready = true;
  if (tour) showTourCard();
  else if (state.selected) showCountry(state.selected);
  else if (state.disease) showDisease(state.disease);
  else showOverview();
}

async function translatorFor(lang) {
  if (lang === state.lang) return null;
  if (!tr.translators.has(lang)) {
    // 最初の言語以外は、モデルが既に端末にある言語だけ使う（新規ダウンロードはボタン操作が必要なため）
    const ok = await Translator.availability({ sourceLanguage: lang, targetLanguage: state.lang }).catch(() => "unavailable");
    tr.translators.set(lang, ok === "available" ? Translator.create({ sourceLanguage: lang, targetLanguage: state.lang }) : null);
  }
  return tr.translators.get(lang);
}

async function translateText(text, lang) {
  if (!tr.done.has(text)) {
    tr.done.set(text, (async () => {
      let src = lang;
      if (!src && tr.detector) src = (await tr.detector.detect(text))[0]?.detectedLanguage;
      const t = await translatorFor(src || "en");
      return t ? (await t).translate(text) : null;
    })().catch(() => null));
  }
  return tr.done.get(text);
}

// node に見出しを表示し、表示言語と違う言語なら訳して差し替える。訳せたら原文を onOriginal で添える
function setHeadline(node, item, onOriginal) {
  const isJa = item.lang === "ja" || hasKana(item.title);
  if (state.lang === "ja" && item.title_ja) { node.textContent = item.title_ja; onOriginal?.(item.title); return; }
  node.textContent = item.title;
  if (!tr.ready || (state.lang === "ja" ? isJa : !isJa)) return;
  const mine = tr;
  // 一度に大量に訳すと重くなるので順番に処理する
  tr.queue = tr.queue.then(() => translateText(item.title, isJa ? "ja" : item.lang)).then((out) => {
    if (out && node.isConnected && mine === tr) { node.textContent = out; onOriginal?.(item.title); }
  });
}

/* ---------- ワールドツアー（今日のハイライトを乗り物で巡る） ---------- */
// 種類: 世界一周（東京発着・飛行機）、地域めぐり（飛行機）、国内（日本は新幹線、中国は飛行機）
const TOUR_HOME = "JP";
const TOUR_STOPS = 7;          // 立ち寄る場所の数
const TOUR_STAY_MS = 9000;     // 1か所に滞在する時間（自動で次へ進む）
const TOUR_PER_REGION = 3;     // 世界一周で同じ地域ばかりにならないよう、1地域から選ぶ国の上限
const DOMESTIC = { JP: { startJa: "東京駅", startEn: "Tokyo Station" }, CN: { startJa: "北京", startEn: "Beijing" } };
// 乗り物の形（上から見た形・上向き・24×24）。飛行機は Material Icons "flight"（Apache License 2.0）、ほかはこのアプリで描いたもの
const VEHICLE_ICON = {
  plane: "M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z",
  train: "M12 1C9.8 1 8.5 4.2 8.5 7.6V21.2c0 .9.7 1.8 1.6 1.8h3.8c.9 0 1.6-.9 1.6-1.8V7.6C15.5 4.2 14.2 1 12 1zM10.2 8.2h3.6v3.4h-3.6z",
  car: "M8.5 2h7A2.5 2.5 0 0 1 18 4.5v15a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 19.5v-15A2.5 2.5 0 0 1 8.5 2zM8 6.5v3h8v-3zM8 16v2h8v-2z",
  ship: "M12 1l4.5 6.5V20a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2V7.5zM10.3 10h3.4v5h-3.4z",
};
// 乗り物の種類: 形・名前・絵文字・ルート線の描き方（air=破線、rail=線路、road=実線、sea=点線）
const VEHICLES = {
  plane: { icon: "plane", ja: "飛行機", en: "plane", emoji: "✈️", line: "air" },
  shinkansen: { icon: "train", ja: "新幹線", en: "Shinkansen", emoji: "🚄", line: "rail" },
  local: { icon: "train", ja: "電車", en: "train", emoji: "🚃", line: "rail" },
  rail: { icon: "train", ja: "高速鉄道", en: "high-speed rail", emoji: "🚄", line: "rail" },
  car: { icon: "car", ja: "車", en: "car", emoji: "🚗", line: "road" },
  jeep: { icon: "car", ja: "四輪駆動車", en: "4x4", emoji: "🚙", line: "road" },
  ferry: { icon: "ship", ja: "フェリー", en: "ferry", emoji: "⛴️", line: "sea" },
  ship: { icon: "ship", ja: "船", en: "boat", emoji: "🚢", line: "sea" },
};
// 新幹線の駅がある都道府県（国内ツアーで新幹線を使うかの目安）
const SHINKANSEN_PREFS = new Set(["01", "02", "03", "04", "05", "06", "07", "09", "10", "11", "13", "14", "15", "16", "17", "18",
  "20", "21", "22", "23", "25", "26", "27", "28", "33", "34", "35", "40", "41", "42", "43", "46"]);
const SHIKOKU = new Set(["36", "37", "38", "39"]);
// 島国（近い国どうしは船で渡る）
const ISLAND_NATIONS = new Set(["ID", "PH", "LK", "MV", "FJ", "PG", "SB", "VU", "WS", "TO", "KI", "MH", "FM", "PW", "NR", "TV", "CU", "JM",
  "HT", "DO", "BS", "TT", "BB", "GD", "LC", "VC", "AG", "DM", "KN", "CV", "ST", "KM", "MU", "SC", "MG", "IS", "GL", "NZ", "MT", "CY", "BH"]);

// 区間ごとに、距離と土地柄に合う乗り物を選ぶ
function chooseVehicle(kind, from, to) {
  const km = d3.geoDistance(from.center, to.center) * 6371;
  if (kind === "JP") {
    const a = from.place?.id, b = to.place?.id;
    if (a === "47" || b === "47" || km > 1000) return "plane";        // 沖縄・遠距離は飛行機
    if (SHIKOKU.has(a) !== SHIKOKU.has(b)) return "ferry";             // 四国との行き来は船
    if (km < 90) return "car";                                         // 近いところは車
    if (km >= 150 && SHINKANSEN_PREFS.has(a) && SHINKANSEN_PREFS.has(b)) return "shinkansen";
    return "local";
  }
  if (kind === "CN") {
    const ids = [from.place?.id, to.place?.id];
    if (ids.includes("HI")) return ids.includes("GD") || ids.includes("GX") ? "ferry" : "plane"; // 海南島
    if (ids.includes("XZ") || ids.includes("XJ") || km > 1500) return "plane";
    return "rail";
  }
  if (km > 2500) return "plane";
  if (ISLAND_NATIONS.has(from.a2) || ISLAND_NATIONS.has(to.a2)) return "ship";
  const c = state.byA2.get(to.a2);
  if (c?.region === "europe" || ["CN", "KR", "TW", "JP", "IN", "BD", "PK", "UZ"].includes(to.a2)) return "rail";
  if (c?.region === "africa" || c?.region === "south_america") return "jeep";
  if (c?.region === "oceania" && !["AU"].includes(to.a2)) return "ship";
  return "car";
}
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
let tour = null;

function tourButtonLabel() {
  const btn = $("#tour-btn");
  btn.textContent = tour ? L("✈ ツアーを終える", "✈ End tour") : L("✈ ワールドツアー", "✈ World tour");
  btn.setAttribute("aria-pressed", String(!!tour));
  btn.setAttribute("aria-expanded", String(!$("#tour-menu").hidden));
}

// ツアーの種類を選ぶメニュー
function toggleTourMenu(open = $("#tour-menu").hidden) {
  const menu = $("#tour-menu");
  if (open) {
    const item = (kind, label, sub) => el("button", { type: "button", role: "menuitem", onclick: () => { toggleTourMenu(false); startTour(kind); } },
      el("span", {}, label), sub ? el("span", { class: "muted" }, sub) : null);
    menu.replaceChildren(
      item("world", L("世界一周", "Around the world"), L("東京発着・7か国", "From Tokyo, 7 countries")),
      el("div", { class: "tour-menu-label" }, L("地域をめぐる", "By region")),
      ...REGIONS.filter(([id]) => id !== "all").map(([id]) => item(id, rname(id))),
      el("div", { class: "tour-menu-label" }, L("国内をめぐる", "Within a country")),
      item("JP", L("日本国内", "Within Japan"), L("新幹線・電車・車・船", "Shinkansen, train, car, ferry")),
      item("CN", L("中国国内", "Within China"), L("高速鉄道・飛行機・船", "Rail, plane, ferry")));
  }
  menu.hidden = !open;
  tourButtonLabel();
  if (open) menu.querySelector("button")?.focus();
}

// 国の記事データ（アーティファクト版は同梱データや GitHub から読む関数に置き換える）
async function countryData(a2) { return loadJSON(`data/news/${a2}.json`); }

// 海外領土で中心がずれないよう、国の中で最も広い陸地の中心を使う
function mainCenter(a2) {
  let best = null, bestArea = -1;
  for (const f of paths.filter((x) => countryOf(x)?.a2 === a2).data()) {
    const g = f.geometry;
    const polys = g.type === "MultiPolygon" ? g.coordinates.map((c) => ({ type: "Polygon", coordinates: c })) : [g];
    for (const poly of polys) {
      const a = d3.geoArea(poly);
      if (a > bestArea && a < 2 * Math.PI) { bestArea = a; best = poly; }
    }
  }
  return best ? d3.geoCentroid(best) : null;
}

const tourSince = (hours) => Date.parse(state.index?.generated_at || 0) - hours * 3600e3;
// 医療の話題に絞る: 病名タグか公的機関（WHO・CDC など）の記事だけを使う。事件・政治などで埋まらないように
const isHealth = (n) => n.tags?.length || n.official;

// 今日のハイライト（国）: 最新の収集から36時間以内に、病名か公的機関の記事がある国
async function pickCountries(region) {
  const idx = state.index?.countries || {};
  const since = tourSince(36);
  // 索引で病名の話題がある国を先に、次に記事の多い国を候補にする
  const cands = Object.entries(idx)
    .filter(([a2, v]) => v.news > 0 && a2 !== "AQ" && (region ? state.byA2.get(a2)?.region === region : a2 !== TOUR_HOME))
    .sort((a, b) => (b[1].tags?.length ? 1 : 0) - (a[1].tags?.length ? 1 : 0) || b[1].news - a[1].news)
    .slice(0, 40).map(([a2]) => a2);
  const rows = (await Promise.all(cands.map(async (a2) => {
    const data = await countryData(a2).catch(() => null);
    if (!data) return null;
    const fresh = (data.news || []).filter((n) => n.date && Date.parse(n.date) >= since && isHealth(n));
    const tags = new Set(fresh.flatMap((n) => n.tags || []));
    const score = fresh.length + 2 * fresh.filter((n) => n.official).length + 1.5 * tags.size;
    return { a2, data, fresh, tags: [...tags], score, center: mainCenter(a2) };
  }))).filter((r) => r && r.fresh.length && r.center).sort((a, b) => b.score - a.score);
  const perRegion = new Map();
  const picks = [];
  for (const r of rows) {
    const reg = state.byA2.get(r.a2)?.region;
    if (!region && (perRegion.get(reg) || 0) >= TOUR_PER_REGION) continue;
    perRegion.set(reg, (perRegion.get(reg) || 0) + 1);
    picks.push(r);
    if (picks.length === (region ? 6 : TOUR_STOPS)) break;
  }
  return picks;
}

// 国内のハイライト: 国内ニュースの見出しに出た都道府県・省ごとに記事を振り分ける
async function pickPlaces(a2) {
  const gaz = await loadJSON(`data/places/${a2}.json`);
  const since = tourSince(72);
  const pool = new Map();
  const add = (n, ok) => { if (ok && n.date && Date.parse(n.date) >= since && !pool.has(n.link)) pool.set(n.link, n); };
  // 国内ツアー用に集めた医療ニュースはそのまま、国の記事や世界のニュースは医療の話題だけ使う
  (await countryData(`domestic-${a2}`).catch(() => null))?.news?.forEach((n) => add(n, true));
  (await countryData(a2).catch(() => null))?.news?.forEach((n) => add(n, isHealth(n)));
  (state.index?.global?.news || []).forEach((n) => add(n, n.countries?.includes(a2) && isHealth(n)));
  const byAlias = new Map();
  for (const pl of gaz.places) for (const al of [...pl.aliases_ja, ...pl.aliases_en]) byAlias.set(al, pl);
  // 長い地名を先に試す（「東京都」の中の「京都」を京都府と取り違えない）
  const re = new RegExp([...byAlias.keys()].sort((x, y) => y.length - x.length)
    .map((al) => (/^[\x00-\x7f]+$/.test(al) ? `\\b${al.replace(/[.*+?^${}()|[\]\\']/g, "\\$&")}\\b` : al)).join("|"), "g");
  const hits = new Map();
  for (const n of pool.values()) {
    const seen = new Set();
    for (const m of `${n.title} ${n.title_ja || ""}`.matchAll(re)) {
      const pl = byAlias.get(m[0]);
      if (seen.has(pl.id)) continue;
      seen.add(pl.id);
      if (!hits.has(pl.id)) hits.set(pl.id, { place: pl, fresh: [] });
      hits.get(pl.id).fresh.push(n);
    }
  }
  const rows = [...hits.values()].map((h) => {
    h.fresh.sort((x, y) => (y.date || "").localeCompare(x.date || ""));
    const tags = new Set(h.fresh.flatMap((n) => n.tags || []));
    return { ...h, key: h.place.id, tags: [...tags], center: [h.place.lon, h.place.lat], score: h.fresh.length + 1.5 * tags.size };
  }).sort((x, y) => y.score - x.score).slice(0, TOUR_STOPS);
  const home = gaz.places.find((pl) => pl.id === gaz.home);
  return { home, rows };
}

// 出発地から、いちばん近い場所へ順に進む（簡単な最近傍法の経路）
function orderRoute(start, picks) {
  const left = picks.slice();
  const route = [];
  let here = start;
  while (left.length) {
    left.sort((a, b) => d3.geoDistance(here, a.center) - d3.geoDistance(here, b.center));
    const next = left.shift();
    route.push(next);
    here = next.center;
  }
  return route;
}

// 国全体が画面に収まる倍率（国内ツアー用）
function fitZoom(a2) {
  const feats = paths.filter((f) => countryOf(f)?.a2 === a2).data();
  const radius = Math.sqrt(d3.geoArea({ type: "FeatureCollection", features: feats }) / Math.PI) || 0.1;
  return Math.max(1.6, Math.min(MAX_K, 0.42 / radius));
}

const stopName = (s) => (s.place ? L(s.place.ja, s.place.en) : s.a2 ? cname(state.byA2.get(s.a2)) : "");

async function startTour(kind = "world") {
  stopSpin();
  svg.interrupt();
  // # を消してふだんの表示状態から始める（replaceState は hashchange を起こさない）
  history.replaceState(null, "", location.pathname + location.search);
  state.disease = null;
  state.selected = null;
  state.region = "all";
  recolor();
  syncControls();
  const btn = $("#tour-btn");
  btn.disabled = true;
  $("#panel").replaceChildren(el("p", { class: "muted" }, L("今日のハイライトを選んでいます…", "Picking today's highlights…")));
  const domestic = DOMESTIC[kind];
  let stops = null;
  let empty = L("今日は病名や公的機関の発表が出た新しいニュースがないため、ツアーはお休みです。",
    "No fresh news about diseases or public-health agencies today, so there is no tour.");
  try {
    if (domestic) {
      const { home, rows } = await pickPlaces(kind);
      empty = L("今日は地名の分かる国内の医療ニュースが見つからないため、ツアーはお休みです（国内ニュースは毎朝の収集で集めています）。",
        "No domestic health news with a place name today, so there is no tour (domestic news is collected every morning).");
      if (rows.length) {
        const start = [home.lon, home.lat];
        const route = orderRoute(start, rows.map((r) => ({ ...r, a2: kind })));
        stops = [{ a2: kind, place: { id: home.id, ja: domestic.startJa, en: domestic.startEn }, center: start, home: true },
          ...route, { ...route[route.length - 1], end: true }];
      }
    } else {
      const region = kind === "world" ? null : kind;
      const picks = await pickCountries(region);
      if (picks.length) {
        const tokyo = mainCenter(TOUR_HOME);
        const route = orderRoute(tokyo, picks);
        stops = region
          ? [{ ...route[0], home: true }, ...route, { ...route[route.length - 1], end: true }]
          : [{ a2: TOUR_HOME, center: tokyo, home: true }, ...route, { a2: TOUR_HOME, center: tokyo, home: true, end: true }];
      }
    }
  } catch (e) {
    console.error(e);
  }
  btn.disabled = false;
  if (!stops) {
    $("#panel").replaceChildren(el("p", { class: "notice" }, empty));
    return;
  }
  // 区間ごとの乗り物（legs[k] は stops[k] から stops[k+1] へ）
  const legs = stops.slice(1).map((to, k) => {
    const moves = d3.geoDistance(stops[k].center, to.center) > 1e-4;
    return { vehicle: chooseVehicle(kind, stops[k], to), from: stops[k].center, to: to.center, moves };
  });
  tour = {
    kind, domestic: !!domestic, stops, legs, vehicle: legs[0].vehicle,
    i: 0, paused: false, timer: null, deadline: 0, remaining: 0,
    pos: stops[0].center, heading: 0, flown: [], leg: null, legIndex: null,
    zoom: domestic ? fitZoom(kind) : null,
  };
  const layer = svg.append("g").attr("class", "tour-layer");
  // 区間ごとに、乗り物に合わせた線で予定ルートと通った跡を描く
  tour.route = layer.append("g").selectAll("path").data(legs).join("path")
    .attr("class", (l) => `tour-route ${VEHICLES[l.vehicle].line}`);
  tour.trail = layer.append("g").selectAll("path").data(legs).join("path")
    .attr("class", (l) => `tour-trail ${VEHICLES[l.vehicle].line}`);
  tour.dots = layer.append("g").attr("class", "tour-dots");
  tour.dots.selectAll("circle").data(stops.slice(1, -1)).join("circle").attr("r", 4);
  tour.vehicleNode = layer.append("g").attr("class", "tour-plane");
  tour.vehicleIcon = tour.vehicleNode.append("path").attr("d", VEHICLE_ICON[VEHICLES[tour.vehicle].icon]).attr("fill-rule", "evenodd");
  tourButtonLabel();
  // 出発地が正面に来るよう回してから出発の案内を出す
  const c0 = stops[0].center;
  animateTo([c0[0], c0[1] * (tour.domestic ? 1 : 0.7)], stopZoom(stops[0]));
  arrive(0);
}

function drawTour() {
  const line = (coords) => (coords && coords.length > 1 && d3.geoDistance(coords[0], coords[coords.length - 1]) > 1e-4
    ? path({ type: "LineString", coordinates: coords }) : null);
  tour.route.attr("d", (l) => line([l.from, l.to]));
  tour.trail.attr("d", (l, k) => line(tour.flown[k] || (k === tour.legIndex ? tour.leg : null)));
  const [lon, lat] = projection.rotate();
  const facing = (pt) => d3.geoDistance(pt, [-lon, -lat]) < Math.PI / 2 - 0.05;
  tour.dots.selectAll("circle")
    .attr("transform", (s) => { const [x, y] = projection(s.center); return `translate(${x},${y})`; })
    .attr("opacity", (s) => (facing(s.center) ? 1 : 0));
  const [x, y] = projection(tour.pos);
  const sc = tour.domestic ? 1.5 : Math.max(1, Math.min(1.6, zoomK));
  tour.vehicleNode.attr("opacity", facing(tour.pos) ? 1 : 0)
    .attr("transform", `translate(${x},${y}) rotate(${tour.heading}) scale(${sc}) translate(-12,-12)`);
}

function stopZoom(stop) {
  if (tour?.domestic) return tour.zoom;
  return stop.home ? 1.3 : 1.9;
}

function flyTo(next) {
  clearTimeout(tour.timer);
  const from = tour.stops[tour.i];
  const to = tour.stops[next];
  const interp = d3.geoInterpolate(from.center, to.center);
  const dist = d3.geoDistance(from.center, to.center);
  const k0 = zoomK;
  const k1 = stopZoom(to);
  const tilt = tour.domestic ? 1 : 0.7;
  if (!tour.domestic) { state.selected = null; highlight(); }
  // 直前の場所からの区間の乗り物（行程を飛ばして選んだときは距離で選び直す）
  const legIndex = next - 1;
  const vehicle = next === tour.i + 1 ? tour.legs[legIndex].vehicle : chooseVehicle(tour.kind, from, to);
  tour.vehicle = vehicle;
  tour.legIndex = next === tour.i + 1 ? legIndex : null;
  tour.vehicleIcon.attr("d", VEHICLE_ICON[VEHICLES[vehicle].icon]);
  tour.flying = next;
  showTourCard();
  const steps = 48;
  const land = () => {
    if (dist > 1e-4 && tour.legIndex != null) tour.flown[tour.legIndex] = d3.range(steps + 1).map((j) => interp(j / steps));
    tour.leg = null;
    tour.pos = to.center;
    tour.flying = null;
    arrive(next);
  };
  if (reduceMotion() || dist < 1e-4) {
    projection.rotate([-to.center[0], -to.center[1] * tilt]);
    setZoom(k1);
    return land();
  }
  // 遠いほど長く移動する。世界・地域のツアーでは途中で少し引いて地球の丸みを見せる
  const dip = tour.domestic ? 0 : 0.45;
  const slow = VEHICLES[vehicle].line === "sea" ? 1.3 : 1;   // 船は少しゆっくり
  const duration = slow * (tour.domestic ? Math.max(1800, Math.min(4000, dist * 12000)) : Math.max(1800, Math.min(5000, dist * 2400)));
  svg.transition("tour").duration(duration).ease(d3.easeCubicInOut)
    .tween("fly", () => (t) => {
      const p = interp(t);
      tour.pos = p;
      tour.leg = d3.range(Math.ceil(t * steps) + 1).map((j) => interp(Math.min(t, j / steps)));
      projection.rotate([-p[0], -p[1] * tilt]);
      const a = projection(p);
      const b = projection(interp(Math.min(1, t + 0.01)));
      if (b && a && (b[0] !== a[0] || b[1] !== a[1])) tour.heading = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 90;
      setZoom(Math.max(0.85, k0 + (k1 - k0) * t - dip * Math.sin(Math.PI * t)));
    })
    .on("end", land)
    .on("interrupt", () => { if (tour?.flying === next) land(); });
}

function arrive(i) {
  tour.i = i;
  const stop = tour.stops[i];
  if (!tour.domestic) state.selected = stop.home || stop.end ? null : stop.a2;
  highlight();
  render();
  if (!stop.end) schedule(stop.home ? 3500 : TOUR_STAY_MS);
  showTourCard();
}

// 自動で次へ進む（一時停止中は止め、残り時間を覚えておく）
function schedule(ms) {
  clearTimeout(tour.timer);
  tour.remaining = ms;
  tour.deadline = Date.now() + ms;
  if (!tour.paused) tour.timer = setTimeout(() => flyTo(tour.i + 1), ms);
}

function togglePause() {
  tour.paused = !tour.paused;
  if (tour.paused) {
    clearTimeout(tour.timer);
    tour.remaining = Math.max(0, tour.deadline - Date.now());
  } else if (tour.flying == null && !tour.stops[tour.i].end) {
    schedule(tour.remaining || 1000);
  }
  showTourCard();
}

function endTour({ silent = false, goto = null } = {}) {
  if (!tour) return;
  clearTimeout(tour.timer);
  tour.flying = null;
  svg.interrupt("tour");
  svg.select(".tour-layer").remove();
  tour = null;
  tourButtonLabel();
  if (silent) return;
  if (goto) { location.hash = goto; return; }
  state.selected = null;
  highlight();
  zoomToRegion("all");
  showOverview();
}

function tourIntro() {
  const total = tour.stops.length - 2;
  const when = fmtDateTime(state.index.generated_at);
  if (tour.domestic) {
    const country = cname(state.byA2.get(tour.kind));
    const v = VEHICLES[(tour.legs.find((l) => l.moves) || tour.legs[0]).vehicle];
    return [
      L(`${stopName(tour.stops[0])}から${v.ja}で出発します`, `Departing ${stopName(tour.stops[0])} by ${v.en}`),
      L(`最新の収集（${when}）までの3日間に、医療のニュースに名前が出た${country}の ${total} か所を巡ります。`,
        `Visiting ${total} places in ${country} named in health news in the 3 days up to the latest update (${when}).`),
    ];
  }
  if (tour.kind === "world") {
    return [L("東京を出発します", "Departing from Tokyo"),
      L(`最新の収集（${when}）までの36時間に、感染症などの病名や公的機関の発表がニュースになった ${total} か国を巡ります。`,
        `Visiting ${total} countries where a disease or a public-health agency made the news in the 36 hours up to the latest update (${when}).`)];
  }
  return [L(`${rname(tour.kind)}をめぐります`, `Touring ${rname(tour.kind)}`),
    L(`最新の収集（${when}）までの36時間に、病名や公的機関の発表がニュースになった ${total} か国を巡ります。最初は${stopName(tour.stops[1])}です。`,
      `Visiting ${total} countries where a disease or a public-health agency made the news in the 36 hours up to the latest update (${when}). First stop: ${stopName(tour.stops[1])}.`)];
}

function showTourCard() {
  // replaceChildren は null を "null" という文字にしてしまうので取り除く
  const panel = { replaceChildren: (...kids) => $("#panel").replaceChildren(...kids.filter((k) => k != null)) };
  const stop = tour.stops[tour.i];
  const total = tour.stops.length - 2;
  const flyingTo = tour.flying != null ? tour.stops[tour.flying] : null;
  const btn = (label, onclick, cls = "chip") => el("button", { type: "button", class: cls, onclick }, label);
  const controls = el("div", { class: "tour-controls" },
    btn(tour.paused ? L("▶ 再開", "▶ Resume") : L("⏸ 一時停止", "⏸ Pause"), togglePause),
    !stop.end && tour.flying == null ? btn(L("次へ →", "Next →"), () => flyTo(tour.i + 1)) : null,
    !stop.home && !stop.end ? btn(tour.domestic ? L("国のページを見る", "Open country page") : L("この国を詳しく見る", "Open this country"),
      () => endTour({ goto: stop.a2 })) : null,
    btn(L("ツアーを終える", "End tour"), () => endTour(), "chip quiet"));
  const itinerary = el("ol", { class: "tour-route-list" }, tour.stops.slice(1, -1).map((s, k) => {
    const n = k + 1;
    const leg = tour.legs[k];
    const v = VEHICLES[leg.vehicle];
    return el("li", { class: n === tour.i ? "now" : n < tour.i ? "done" : "" },
      el("span", { class: "tour-leg", title: leg.moves ? L(v.ja, v.en) : null, "aria-label": leg.moves ? L(v.ja, v.en) : null }, leg.moves ? v.emoji : "📍"),
      el("button", { type: "button", disabled: tour.flying != null || n === tour.i ? "" : null, onclick: () => flyTo(n) }, stopName(s)),
      s.tags?.length ? el("span", { class: "muted" }, s.tags.slice(0, 2).map(dname).join(L("・", ", "))) : null);
  }));
  const title = tour.domestic
    ? L(`🧭 今日の${cname(state.byA2.get(tour.kind))}国内ツアー`, `🧭 Today's ${cname(state.byA2.get(tour.kind))} tour`)
    : tour.kind === "world" ? L("✈ 今日のワールドツアー", "✈ Today's world tour")
    : L(`✈ 今日の${rname(tour.kind)}ツアー`, `✈ Today's ${rname(tour.kind)} tour`);
  const head = el("div", { class: "tour-head" },
    el("span", { class: "tour-title" }, title),
    !stop.home && !stop.end ? el("span", { class: "muted" }, `${tour.i} / ${total}`) : null);
  // 自動で次へ進むまでの残り時間を細いバーで見せる
  const bar = !stop.end && tour.flying == null
    ? el("div", { class: "tour-bar" + (tour.paused ? " paused" : "") }, el("span", { style: `animation-duration:${tour.remaining || TOUR_STAY_MS}ms` }))
    : null;
  const route = [el("h3", {}, L("行程", "Route")), itinerary];

  if (flyingTo) {
    const name = stopName(flyingTo);
    const v = VEHICLES[tour.vehicle];
    panel.replaceChildren(head, el("p", { class: "tour-flying" },
      `${v.emoji} `, L(`${v.ja}で${name}へ向かっています…`, `Heading to ${name} by ${v.en}…`)),
      controls, ...route);
    return;
  }
  if (stop.home && !stop.end) {
    const [h, sub] = tourIntro();
    panel.replaceChildren(head, el("h2", {}, h), el("p", { class: "muted" }, sub), bar, controls, ...route, disclaimer());
    return;
  }
  if (stop.end) {
    panel.replaceChildren(head,
      el("h2", {}, tour.kind === "world" ? L("東京に戻りました", "Back in Tokyo") : L("ツアーはここまでです", "End of the tour")),
      el("p", { class: "muted" }, L("今日のツアーは以上です。気になった場所は行程から選び直すか、地図で開いてください。",
        "That's today's tour. Pick a stop below to revisit it, or open it on the map.")),
      el("ol", { class: "tour-summary" }, tour.stops.slice(1, -1).map((s, k) => el("li", {},
        el("button", { type: "button", class: "linkish", onclick: () => flyTo(k + 1) }, stopName(s)),
        s.fresh[0] ? (() => { const t = el("span", { class: "muted" }); setHeadline(t, s.fresh[0]); return t; })() : null))),
      el("div", { class: "tour-controls" },
        btn(L("もう一度", "Tour again"), () => { const k = tour.kind; endTour({ silent: true }); startTour(k); }),
        btn(L("地図に戻る", "Back to map"), () => endTour())),
      disclaimer());
    return;
  }
  const video = stop.data?.videos?.[0];
  panel.replaceChildren(head,
    el("h2", {}, stopName(stop)),
    el("div", { class: "muted" }, tour.domestic ? cname(state.byA2.get(tour.kind)) : rname(state.byA2.get(stop.a2).region)),
    stop.tags.length ? el("div", { class: "tags" }, stop.tags.map((t) => el("span", { class: "tag" }, dname(t)))) : null,
    bar,
    el("h3", {}, L("今日のハイライト", "Today's highlights"), el("span", { class: "count" }, per(stop.fresh.length, "件", "article", "articles"))),
    newsList(stop.fresh.slice(0, 3)),
    video ? el("a", { class: "tour-video", href: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`, target: "_blank", rel: "noopener noreferrer" },
      L("▶ 動画: ", "▶ Video: "), (() => { const t = el("span"); setHeadline(t, video); return t; })()) : null,
    controls, ...route);
}

/* ---------- パネル ---------- */
function videoBlock(videos) {
  if (!videos?.length) return null;
  const node = $("#tpl-video").content.firstElementChild.cloneNode(true);
  const frame = node.querySelector("iframe");
  const title = node.querySelector(".video-title");
  const thumbs = node.querySelector(".thumbs");
  const play = (v, btn) => {
    frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?rel=0`;
    frame.title = L("動画", "Video");
    const name = el("span");
    setHeadline(name, v);
    title.replaceChildren(name, L(`（${v.channel}${v.date ? "・" + fmtDate(v.date) : ""}）`, ` (${v.channel}${v.date ? ", " + fmtDate(v.date) : ""})`));
    thumbs.querySelectorAll(".thumb").forEach((b) => b.removeAttribute("aria-current"));
    btn?.setAttribute("aria-current", "true");
  };
  videos.forEach((v, i) => {
    const label = el("span");
    const btn = el("button", { class: "thumb", title: v.title },
      el("img", { src: `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`, alt: "", loading: "lazy" }),
      label);
    setHeadline(label, v);
    btn.onclick = () => play(v, btn);
    thumbs.append(btn);
    if (i === 0) play(v, btn);
  });
  if (videos.length === 1) thumbs.remove();
  return node;
}

function newsList(items, { showCountries = false } = {}) {
  if (!items.length) return el("p", { class: "muted" }, L("該当する記事はまだありません。", "No articles yet."));
  return el("ul", { class: "news" }, items.map((n) => {
    const link = el("a", { href: safeUrl(n.link), target: "_blank", rel: "noopener noreferrer" });
    // 訳した見出しには原文も小さく添える（固有名詞の確認用）
    setHeadline(link, n, (orig) => link.after(el("div", { class: "original" }, orig)));
    return el("li", {},
    link,
    el("div", { class: "meta" },
      n.official ? el("span", { class: "tag official" }, L("公的機関", "Official")) : null,
      el("span", {}, n.source),
      n.date ? el("span", {}, fmtDate(n.date)) : null,
      ...(n.tags || []).map((t) => el("span", { class: "tag" }, dname(t))),
      showCountries && n.countries?.length
        ? el("span", {}, n.countries.map((a2) => cname(state.byA2.get(a2))).filter(Boolean).slice(0, 4).join(L("・", ", ")))
        : null),
    n.summary ? el("p", { class: "summary" }, n.summary) : null);
  }));
}

function langFilterBar(onchange) {
  const opts = [["all", L("すべて", "All")], ["ja", L("日本語", "Japanese")], ["en", L("英語", "English")], ["official", L("公的機関のみ", "Official only")]];
  const bar = el("div", { class: "filters chips" });
  for (const [id, label] of opts) {
    bar.append(el("button", { class: "chip", "aria-selected": String(state.langFilter === id),
      onclick: () => { state.langFilter = id; onchange(); } }, label));
  }
  return bar;
}
const applyLang = (items) => items.filter((n) =>
  state.langFilter === "all" || (state.langFilter === "official" ? n.official : n.lang === state.langFilter));

function usefulLinks(c) {
  const q = encodeURIComponent(L(`${c.ja} 医療 感染症`, `${c.en} health outbreak`));
  const links = [
    [L("WHO 国別ページ", "WHO country page"), `https://www.who.int/countries/${c.a3.toLowerCase()}`],
    [L("外務省 世界の医療事情", "MOFA Japan: medical info (Japanese)"), "https://www.mofa.go.jp/mofaj/toko/medi/index.html"],
    [L("外務省 海外安全HP", "MOFA Japan: overseas safety (Japanese)"), "https://www.anzen.mofa.go.jp/"],
    [L("FORTH（厚労省検疫所）", "FORTH (Japan quarantine, Japanese)"), "https://www.forth.go.jp/"],
    ["CDC Travelers' Health", "https://wwwnc.cdc.gov/travel/destinations/list"],
    [L("Googleニュースで検索", "Search Google News"), `https://news.google.com/search?q=${q}&${L("hl=ja&gl=JP&ceid=JP:ja", "hl=en-US&gl=US&ceid=US:en")}`],
  ];
  return el("div", { class: "links" }, links.map(([t, u]) => el("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, t)));
}

async function showCountry(a2) {
  const c = state.byA2.get(a2);
  const panel = $("#panel");
  const info = state.index?.countries?.[a2];
  panel.replaceChildren(
    el("div", { class: "panel-head" },
      el("div", {},
        el("h2", {}, cname(c)),
        el("div", { class: "muted" }, L(`${c.en}・${rname(c.region)}`, rname(c.region)))),
      el("button", { class: "close", "aria-label": L("閉じる", "Close"), onclick: () => { location.hash = ""; } }, "×")),
    info?.tags?.length ? el("div", { class: "tags" }, info.tags.map((t) => el("span", { class: "tag" }, dname(t)))) : null,
    el("p", { class: "muted" }, L("読み込み中…", "Loading…")),
  );
  panel.scrollTop = 0;

  let data = { news: [], videos: [] };
  try { data = await countryData(a2); } catch { /* 未収集 */ }
  if (state.selected !== a2) return; // 読み込み中に別の国が選ばれた
  panel.lastElementChild.remove();

  const ytSearch = `https://www.youtube.com/results?search_query=${encodeURIComponent(L(`${c.ja} 医療 OR ${c.en} health`, `${c.en} health`))}`;
  panel.append(
    el("h3", {}, L("動画", "Videos"), el("span", { class: "count" }, per(data.videos.length, "本", "video", "videos"))),
    videoBlock(data.videos) || el("div", { class: "empty-video" },
      L("この国の動画はまだ収集されていません（毎朝順番に収集しています）。", "No videos collected for this country yet (collected in rotation every morning)."),
      el("br"), el("a", { href: ytSearch, target: "_blank", rel: "noopener noreferrer" }, L("YouTube で探す →", "Search YouTube →"))),
  );
  // 国の動画がないときは世界の注目動画で代わりに映像を見られるようにする
  const gv = state.index?.global?.videos || [];
  if (!data.videos.length && gv.length) {
    panel.append(el("h3", {}, L("世界の注目動画", "Featured videos")), videoBlock(gv));
  }

  const listWrap = el("div");
  const renderNews = () => {
    const items = applyLang(data.news);
    listWrap.replaceChildren(langFilterBar(renderNews), newsList(items));
  };
  renderNews();
  if (state.disease) {
    const dzNews = data.news.filter((n) => n.tags?.includes(state.disease));
    panel.append(
      el("h3", {}, L(`${state.disease}の記事`, `${dname(state.disease)} news`), el("span", { class: "count" }, per(dzNews.length, "件", "article", "articles")),
        el("a", { class: "back", href: "#d-" + DISEASE_KEY.get(state.disease) }, L("← 分布に戻る", "← Back to map"))),
      newsList(dzNews));
  }
  panel.append(
    el("h3", {}, L("医療・感染症ニュース", "Health & outbreak news"), el("span", { class: "count" }, L(`直近 ${data.news.length} 件`, per(data.news.length, "", "recent article", "recent articles").trim()))),
    listWrap,
    el("h3", {}, L("公式情報・関連リンク", "Official sources & links")),
    usefulLinks(c),
    disclaimer(),
  );
}

function showOverview() {
  const panel = $("#panel");
  const idx = state.index;
  const inRegion = (c) => state.region === "all" || c.region === state.region;
  const ranking = state.countries.filter(inRegion)
    .map((c) => ({ c, n: countOf(c) })).filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n).slice(0, 15);
  const regionTitle = rname(state.region) || L("世界全体", "World");

  panel.replaceChildren(
    el("h2", {}, regionTitle),
    el("p", { class: "muted" }, L("地図上の国をクリックすると、その国の医療・感染症ニュースと動画を表示します。", "Click a country on the globe to see its health and outbreak news and videos.")),
  );
  if (!idx) {
    panel.append(el("div", { class: "notice" },
      L("収集データがまだありません。", "No data collected yet. "), el("code", {}, "python3 scripts/collect.py"),
      L(" を実行するか、GitHub Actions の毎日の収集が動くのを待ってください。", " runs every morning via GitHub Actions.")));
    panel.append(disclaimer());
    return;
  }

  const gnews = idx.global.news.filter((n) => state.region === "all"
    || n.countries?.some((a2) => state.byA2.get(a2)?.region === state.region));
  const gvideos = idx.global.videos;

  panel.append(
    el("h3", {}, L("注目の動画", "Featured videos")),
    videoBlock(gvideos) || el("p", { class: "muted" }, L("動画はまだありません。", "No videos yet.")),
    el("h3", {}, L("話題の病気", "Diseases in the news"), el("span", { class: "count" }, L("押すと分布を表示", "Tap to see where"))),
    diseaseChips(),
    el("h3", {}, L("記事の多い国", "Countries with the most news"), el("span", { class: "count" }, L("直近の記事数", "recent articles"))),
    ranking.length
      ? el("ol", { class: "rank" }, ranking.map(({ c, n }) => el("li", {},
          el("button", { onclick: () => { location.hash = c.a2; } }, cname(c)),
          el("span", { class: "muted" }, per(n, "件", "article", "articles") + (idx.countries[c.a2].tags.length ? L("・", " · ") + idx.countries[c.a2].tags.slice(0, 2).map(dname).join(L("・", ", ")) : "")))))
      : el("p", { class: "muted" }, L("データがありません。", "No data.")),
  );
  const listWrap = el("div");
  const renderNews = () => listWrap.replaceChildren(langFilterBar(renderNews), newsList(applyLang(gnews).slice(0, 30), { showCountries: true }));
  renderNews();
  panel.append(
    el("h3", {}, L("最新の世界の医療ニュース", "Latest global health news"), el("span", { class: "count" }, per(gnews.length, "件", "article", "articles"))),
    listWrap,
    el("h3", {}, L("収集元の状態", "Sources")),
    el("ul", { class: "muted" }, idx.sources.map((s) => el("li", {}, `${s.ok ? "✓" : "✗"} ${L(s.name, s.name_en || SOURCE_EN[s.name] || s.name)}${L(`（${s.count}件）`, ` (${s.count})`)}`))),
    disclaimer(),
  );
}

function diseaseChips() {
  const top = diseaseTotals().slice(0, 12);
  if (!top.length) return el("p", { class: "muted" }, L("病名の入った記事はまだありません。", "No disease mentions yet."));
  return el("div", { class: "chips dz-chips" }, top.map(([k, t]) =>
    el("a", { class: "chip dz", href: "#d-" + DISEASE_KEY.get(k) }, `${dname(k)} `, el("span", { class: "n" }, L(`${t.countries}か国`, `${t.countries}`)))));
}

async function showDisease(name) {
  const panel = $("#panel");
  const rows = state.countries.map((c) => ({ c, n: countOf(c) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const total = rows.reduce((s, x) => s + x.n, 0);
  const byRegion = d3.rollup(rows, (v) => v.length, (x) => x.c.region);
  const gnews = (state.index?.global?.news || []).filter((n) => n.tags?.includes(name));
  const q = encodeURIComponent(name);
  panel.replaceChildren(
    el("div", { class: "panel-head" },
      el("div", {}, el("h2", {}, L(`${name}の分布`, `${dname(name)}: where it's in the news`)),
        el("div", { class: "muted" }, L(`報道のある国 ${rows.length} か国・記事 ${total} 件`,
          `${per(rows.length, "", "country", "countries").trim()} · ${per(total, "", "article", "articles").trim()}`))),
      el("button", { class: "close", "aria-label": L("分布表示をやめる", "Close disease map"), onclick: () => { location.hash = ""; } }, "×")),
    el("p", { class: "notice" },
      L("直近14日のニュース見出しに病名が出た国を、記事数で色分けしています。症例数や公式の流行地図ではありません。",
        "Countries are shaded by how many news headlines in the last 14 days mention this disease. This is not case data or an official outbreak map. "),
      L("流行状況の判断には WHO や各国保健当局の発表を確認してください。", "Check WHO and national health authorities for the actual situation.")),
    byRegion.size ? el("div", { class: "tags" }, [...byRegion].sort((a, b) => b[1] - a[1])
      .map(([r, n]) => el("span", { class: "tag" }, `${rname(r) || r} ${n}`))) : null,
    el("h3", {}, L("報道の多い国", "Most reported in"), el("span", { class: "count" }, L("押すとその国の記事", "tap for that country's news"))),
    rows.length
      ? el("ol", { class: "rank" }, rows.slice(0, 30).map(({ c, n }) => el("li", {},
          el("button", { onclick: () => { location.hash = c.a2; } }, cname(c)),
          el("span", { class: "muted" }, `${per(n, "件", "article", "articles")}${L("・", " · ")}${rname(c.region)}`))))
      : el("p", { class: "muted" }, L("直近の報道はありません。", "No recent news.")),
    gnews.length ? el("h3", {}, L("最新の関連ニュース", "Latest related news"), el("span", { class: "count" }, per(gnews.length, "件", "article", "articles"))) : null,
    gnews.length ? newsList(gnews.slice(0, 15), { showCountries: true }) : null,
    el("h3", {}, L("公式情報", "Official sources")),
    el("div", { class: "links" },
      el("a", { href: "https://www.who.int/emergencies/disease-outbreak-news", target: "_blank", rel: "noopener noreferrer" }, L("WHO 感染症アウトブレイク情報", "WHO Disease Outbreak News")),
      el("a", { href: "https://www.forth.go.jp/", target: "_blank", rel: "noopener noreferrer" }, L("FORTH（厚労省検疫所）", "FORTH (Japan quarantine, Japanese)")),
      el("a", { href: `https://news.google.com/search?q=${L(q, encodeURIComponent(dname(name)))}&${L("hl=ja&gl=JP&ceid=JP:ja", "hl=en-US&gl=US&ceid=US:en")}`, target: "_blank", rel: "noopener noreferrer" }, L("Googleニュースで検索", "Search Google News"))),
    disclaimer(),
  );
  panel.scrollTop = 0;
}

// 英語名を持たない古い索引のための収集元名
const SOURCE_EN = {
  "WHO ニュース": "WHO news", "WHO 感染症アウトブレイク情報 (DON)": "WHO Disease Outbreak News",
  "CDC 渡航者向け健康情報": "CDC Travelers' Health notices", "ECDC ニュース": "ECDC news",
  "Googleニュース (感染症・国際)": "Google News (Japanese: outbreaks)",
};

function disclaimer() {
  return el("p", { class: "disclaimer" }, L(
    "※ ニュースは各報道機関・公的機関のフィードから自動収集し、国名・病名は見出しから機械的に判定しています。"
    + "誤分類や重複がありえます。渡航・診療の判断には必ず各公的機関の一次情報を確認してください。"
    + "このサイトは個人が作成した非公式のツールで、WHO・外務省などの機関とは関係ありません。",
    "* News is collected automatically from media and public-agency feeds, and countries and diseases are detected from headlines by keyword, "
    + "so misclassification and duplicates can occur. Always check official sources before making travel or medical decisions. "
    + "This is an unofficial tool made by an individual and is not affiliated with WHO, the Ministry of Foreign Affairs of Japan or any other organization."));
}

init().catch((e) => {
  console.error(e);
  $("#panel").replaceChildren(el("div", { class: "notice" },
    "読み込みに失敗しました。ローカルで開く場合は ", el("code", {}, "python3 -m http.server"),
    " でサーバーを起動してから http://localhost:8000/ を開いてください。", el("br"), String(e)));
});
