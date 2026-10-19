/* 世界医療情報マップ: 地図の描画とパネル表示 */
"use strict";

const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json";
const REGIONS = [
  ["all", "世界全体"], ["asia", "アジア"], ["middle_east", "中東"], ["europe", "ヨーロッパ"],
  ["africa", "アフリカ"], ["north_america", "北米・中米"], ["south_america", "南米"], ["oceania", "オセアニア"],
];
const REGION_NAME = Object.fromEntries(REGIONS);
const HEAT = ["--heat-0", "--heat-1", "--heat-2", "--heat-3", "--heat-4"];
const DZ = ["--dz-0", "--dz-1", "--dz-2", "--dz-3", "--dz-4"];
// 収集スクリプト（scripts/collect.py の DISEASES）と同じ病名。URL の # に使う英字の名前を付ける
const DISEASES = [
  ["covid", "COVID-19"], ["flu", "インフルエンザ"], ["avian-flu", "鳥インフルエンザ"], ["dengue", "デング熱"],
  ["malaria", "マラリア"], ["cholera", "コレラ"], ["measles", "麻しん"], ["mpox", "エムポックス"], ["ebola", "エボラ"],
  ["marburg", "マールブルグ"], ["tb", "結核"], ["hiv", "HIV/エイズ"], ["polio", "ポリオ"], ["yellow-fever", "黄熱"],
  ["rabies", "狂犬病"], ["chikungunya", "チクングニア"], ["zika", "ジカ熱"], ["mers", "MERS"], ["plague", "ペスト"],
  ["diphtheria", "ジフテリア"], ["pertussis", "百日せき"], ["meningitis", "髄膜炎"], ["lassa", "ラッサ熱"],
  ["nipah", "ニパウイルス"], ["oropouche", "オロプーシェ"], ["hfmd", "手足口病"], ["food-poisoning", "食中毒"],
  ["heatstroke", "熱中症"], ["air-pollution", "大気汚染"],
];
const DISEASE_BY_KEY = new Map(DISEASES);
const DISEASE_KEY = new Map(DISEASES.map(([k, v]) => [v, k]));

const state = {
  countries: [],      // data/countries.json
  byA2: new Map(),
  byTopoId: new Map(),
  index: null,        // data/news/index.json
  region: "all",
  selected: null,     // a2
  langFilter: "all",
  disease: null,      // 病気の分布を表示中ならその病名
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
  return isNaN(d) ? "" : d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });
};
const fmtDateTime = (iso) => new Date(iso).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });

/* ---------- データ読み込み ---------- */
async function loadJSON(url) {
  // 収集データは毎日差し替わるので、GitHub Pages や途中のキャッシュに古い版（未作成時の404を含む）を返させない
  if (url.startsWith("data/")) url += `?t=${Date.now()}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function init() {
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
  $("#updated").textContent = index
    ? `最終更新: ${fmtDateTime(index.generated_at)}`
    : "まだ収集データがありません";

  const dl = $("#country-list");
  for (const c of [...countries].sort((a, b) => a.ja.localeCompare(b.ja, "ja"))) {
    dl.append(el("option", { value: c.ja }, c.en));
  }
  drawMap(world);
  initTranslation();
  fillDiseaseSelect();
  bindSearch();
  window.addEventListener("hashchange", fromHash);
  fromHash();
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
  sel.replaceChildren(el("option", { value: "" }, "病気の分布を見る…"),
    ...diseaseTotals().map(([k, t]) => el("option", { value: DISEASE_KEY.get(k) }, `${k}（${t.countries}か国）`)));
  sel.value = state.disease ? DISEASE_KEY.get(state.disease) : "";
  sel.onchange = () => { location.hash = sel.value ? "d-" + sel.value : ""; };
  // 最初の画面は集計前に描いているので、「話題の病気」を入れて描き直す
  if (!state.selected && !state.disease) showOverview();
}

function render() {
  sphere.attr("d", path);
  graticule.attr("d", path);
  paths.attr("d", path);
}

/* ---------- 3D 地球儀（NASA の衛星写真。WebGL が使えるときはこちらを使う） ---------- */
const IMG = "img/";
const G3_HEAT = ["#fde8d7", "#fbb98b", "#f4844f", "#e0502b", "#b8261a"];
const G3_DZ = ["#efe7ff", "#cdb8ff", "#a88bff", "#8a5cff", "#6d28d9"];
const G3_HOME = 2.4; // 全体表示のときのカメラの高さ（地球の半径を1とした倍率）
let G3 = null;

function webglOK() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

/* 地図は「衛星写真（3D）」と「簡略地図（線画）」を切り替えられる。選んだほうはブラウザに覚えておく */
const MODE_KEY = "whm-map-mode";
const mapMode = { world: null, canSat: false, g3: null, current: null };

function drawMap(world) {
  mapMode.world = world;
  mapMode.canSat = !!window.Globe && webglOK();
  let saved = null;
  try { saved = localStorage.getItem(MODE_KEY); } catch { /* 保存できない環境 */ }
  document.querySelectorAll("#map-mode button").forEach((b) => {
    b.onclick = () => setMapMode(b.dataset.mode);
    if (b.dataset.mode === "satellite" && !mapMode.canSat) {
      b.disabled = true;
      b.title = "この端末・ブラウザでは3D表示を使えません";
    }
  });
  setMapMode(saved === "simple" || !mapMode.canSat ? "simple" : "satellite", true);
}

function setMapMode(mode, initial = false) {
  if (mode === "satellite" && !mapMode.canSat) mode = "simple";
  if (mode === mapMode.current) return;
  stopSpin();
  if (mode === "satellite") {
    $("#map").hidden = true;
    $("#tooltip").hidden = true;
    $("#globe").hidden = false;
    if (mapMode.g3) {
      G3 = mapMode.g3;
      G3.g.resumeAnimation();
    } else {
      try {
        drawGlobe3D(mapMode.world);
        mapMode.g3 = G3;
      } catch (e) {
        console.error(e);
        G3 = null;
        mapMode.canSat = false;
        return setMapMode("simple", initial);
      }
    }
    bindZoom3D();
  } else {
    if (G3) G3.g.pauseAnimation();
    G3 = null;
    $("#globe").hidden = true;
    $("#map").hidden = false;
    if (!svg) drawMapSvg(mapMode.world);
    bindZoomSvg();
  }
  mapMode.current = mode;
  $("#credit").hidden = mode !== "satellite";
  document.querySelectorAll("#map-mode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  if (initial) return; // 最初の表示位置は fromHash() が決める
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* 保存できない環境 */ }
  recolor();
  highlight();
  if (state.selected) zoomToCountry(state.selected);
  else if (state.disease) focusDisease();
  else zoomToRegion(state.region);
}

function bindZoom3D() {
  const g = G3.g;
  const pov = (dAlt) => { const v = g.pointOfView(); g.pointOfView({ ...v, altitude: Math.min(4, Math.max(0.35, v.altitude * dAlt)) }, 400); };
  $("#zoom-in").onclick = () => { stopSpin(); pov(0.7); };
  $("#zoom-out").onclick = () => { stopSpin(); pov(1 / 0.7); };
  $("#zoom-reset").onclick = () => { const v = g.pointOfView(); g.pointOfView({ ...v, altitude: G3_HOME }, 600); };
}

function bindZoomSvg() {
  $("#zoom-in").onclick = () => animateTo(null, zoomK * 1.6);
  $("#zoom-out").onclick = () => animateTo(null, zoomK / 1.6);
  $("#zoom-reset").onclick = () => animateTo(null, 1);
}

const withAlpha = (hex, a) => { const c = d3.color(hex); c.opacity = a; return c.formatRgb(); };

function g3Cap(f) {
  const c = countryOf(f);
  if (c && c.a2 === state.selected) return "rgba(64, 196, 255, 0.85)";
  if (f === G3.hover && c) return "rgba(255, 196, 92, 0.85)";
  if (state.region !== "all" && !state.disease && c?.region !== state.region) return "rgba(0, 0, 0, 0.35)";
  const i = G3.level.get(f);
  // 記事のない国は透明にして衛星写真を見せる
  return i == null ? "rgba(255, 255, 255, 0.02)" : withAlpha((state.disease ? G3_DZ : G3_HEAT)[i], 0.62);
}

function g3Label(f) {
  const c = countryOf(f);
  const info = c && state.index?.countries?.[c.a2];
  return el("div", { class: "tooltip g3-tip" },
    el("strong", {}, c ? c.ja : f.properties.name),
    !c ? "データなし"
      : state.disease ? `${state.disease}の記事 ${countOf(c)} 件`
      : `記事 ${info?.news || 0} 件・動画 ${info?.videos || 0} 本`,
    !state.disease && info?.tags?.length ? el("div", { class: "muted" }, info.tags.join("・")) : null).outerHTML;
}

function g3Refresh() {
  const g = G3.g;
  g.polygonCapColor(g3Cap)
    .polygonAltitude((f) => (countryOf(f)?.a2 === state.selected ? 0.03 : f === G3.hover ? 0.018 : 0.006));
}

function drawGlobe3D(world) {
  const features = topojson.feature(world, world.objects.countries).features;
  const wrap = $(".map-wrap");
  const host = $("#globe");
  host.hidden = false;
  $("#map").hidden = true;
  $("#tooltip").hidden = true;
  const g = Globe({ animateIn: false })(host)
    .globeImageUrl(IMG + "earth-blue-marble.jpg")
    .bumpImageUrl(IMG + "earth-topology.png")
    .backgroundImageUrl(IMG + "night-sky.jpg")
    .showAtmosphere(true).atmosphereColor("#8cc8ff").atmosphereAltitude(0.17)
    .polygonsData(features)
    .polygonSideColor(() => "rgba(0, 0, 0, 0.2)")
    .polygonStrokeColor(() => "rgba(255, 255, 255, 0.35)")
    .polygonLabel(g3Label)
    .polygonsTransitionDuration(250)
    .onPolygonHover((f) => { G3.hover = f; host.style.cursor = f && countryOf(f) ? "pointer" : "grab"; g3Refresh(); })
    .onPolygonClick((f) => { const c = countryOf(f); if (c) location.hash = c.a2; });
  G3 = { g, features, level: new Map(), hover: null };
  const fit = () => { const r = wrap.getBoundingClientRect(); g.width(r.width).height(r.height); };
  fit();
  new ResizeObserver(fit).observe(wrap);
  g.pointOfView({ lat: 15, lng: 120, altitude: G3_HOME });
  const ctl = g.controls();
  ctl.autoRotateSpeed = 0.35;
  ctl.minDistance = 120; // 近づきすぎて写真がぼやけないように
  host.addEventListener("pointerdown", stopSpin);
  host.addEventListener("wheel", stopSpin, { passive: true });

  recolor();
  startSpin();
}

function g3Fly(center, altitude) {
  stopSpin();
  G3.g.pointOfView({ lng: center[0], lat: center[1], altitude }, 1000);
}

function drawMapSvg(world) {
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
        el("strong", {}, c ? c.ja : f.properties.name),
        !c ? "データなし"
          : state.disease ? `${state.disease}の記事 ${countOf(c)} 件`
          : `記事 ${info?.news || 0} 件・動画 ${info?.videos || 0} 本`,
        !state.disease && info?.tags?.length ? el("div", { class: "muted" }, info.tags.join("・")) : null,
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

  startSpin();
}

// 色の段階は記事数の分位で決める（データ量に合わせて自動調整）。病気の表示中は別の色で塗る
function recolor() {
  const scale = state.disease ? DZ : HEAT;
  const counts = state.countries.map(countOf).filter((n) => n > 0).sort(d3.ascending);
  const thresholds = [0.2, 0.4, 0.6, 0.8].map((q) => d3.quantile(counts, q) || 0);
  if (G3) {
    const ramp = state.disease ? G3_DZ : G3_HEAT;
    G3.level.clear();
    for (const f of G3.features) {
      const n = countOf(countryOf(f));
      if (n > 0) G3.level.set(f, d3.bisectRight(thresholds, n - 0.5));
    }
    g3Refresh();
    $("#legend-title").textContent = state.disease ? `「${state.disease}」の報道件数` : "直近の記事数";
    $("#legend-scale").replaceChildren(...ramp.map((v) => el("span", { style: `background:${v}` })));
    return;
  }
  paths.attr("fill", (f) => {
    const n = countOf(countryOf(f));
    return n > 0 ? `var(${scale[d3.bisectRight(thresholds, n - 0.5)]})` : "var(--land-empty)";
  });
  $("#legend-title").textContent = state.disease ? `「${state.disease}」の報道件数` : "直近の記事数";
  $("#legend-scale").replaceChildren(...scale.map((v) => el("span", { style: `background:var(${v})` })));
}

function setZoom(k) {
  zoomK = Math.max(MIN_K, Math.min(MAX_K, k));
  projection.scale(baseScale * zoomK);
  render();
}

// 何も選んでいないときは地球儀をゆっくり自転させる（操作すると止まる）
function startSpin() {
  if (G3) { G3.g.controls().autoRotate = true; return; }
  stopSpin();
  spinTimer = d3.timer(() => {
    const [lon, lat] = projection.rotate();
    projection.rotate([lon + 0.08, lat]);
    render();
  });
}
function stopSpin() {
  if (G3) { G3.g.controls().autoRotate = false; return; }
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

function countryFeatures(a2) {
  return G3 ? G3.features.filter((f) => countryOf(f)?.a2 === a2) : paths.filter((f) => countryOf(f)?.a2 === a2).data();
}

function zoomToCountry(a2) {
  const feats = countryFeatures(a2);
  if (!feats.length) return;
  const fc = { type: "FeatureCollection", features: feats };
  // 国の広さ（立体角）から倍率を決める。ロシアなど大きな国は拡大しすぎない
  const radius = Math.sqrt(d3.geoArea(fc) / Math.PI);
  if (G3) return g3Fly(d3.geoCentroid(fc), Math.min(2.2, Math.max(1, 0.6 + radius * 4)));
  animateTo(d3.geoCentroid(fc), Math.min(4, Math.max(1.2, 0.35 / radius)));
}

// 病気の分布を開いたら、報道の最も多い国が正面に来るよう回す（全体が見える倍率のまま）
function focusDisease() {
  const top = state.countries.map((c) => ({ c, n: countOf(c) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n)[0];
  const feats = top ? countryFeatures(top.c.a2) : [];
  if (feats.length && G3) return g3Fly(d3.geoCentroid({ type: "FeatureCollection", features: feats }), G3_HOME);
  if (feats.length) animateTo(d3.geoCentroid({ type: "FeatureCollection", features: feats }), 1);
  else zoomToRegion("all");
}

function zoomToRegion(region) {
  if (G3) {
    if (region === "all") {
      const v = G3.g.pointOfView();
      G3.g.pointOfView({ ...v, altitude: G3_HOME }, 800);
      startSpin();
      return;
    }
    const feats = G3.features.filter((f) => {
      const c = countryOf(f);
      return c?.region === region && c.a2 !== "AQ" && d3.geoArea(f) > 0.0005;
    });
    if (feats.length) g3Fly(d3.geoCentroid({ type: "FeatureCollection", features: feats }), 1.7);
    return;
  }
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
  if (G3) return g3Refresh();
  paths
    .classed("selected", (f) => countryOf(f)?.a2 === state.selected)
    .classed("dim", (f) => state.region !== "all" && countryOf(f)?.region !== state.region);
}

/* ---------- 操作 ---------- */
function buildRegionChips() {
  $("#regions").replaceChildren(...REGIONS.map(([id, name]) =>
    el("button", { class: "chip", role: "tab", "data-region": id, "aria-selected": String(id === "all"),
      onclick: () => { location.hash = id === "all" ? "" : "region=" + id; } }, name)));
}

function bindSearch() {
  const input = $("#search");
  const go = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    const c = state.countries.find((x) => x.ja === input.value.trim())
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
  $("#search").value = state.selected ? state.byA2.get(state.selected).ja : "";
  $("#disease").value = state.disease ? DISEASE_KEY.get(state.disease) : "";
}

/* ---------- 見出しの日本語訳（パソコン版 Chrome の内蔵翻訳。無料・端末内で処理） ---------- */
const tr = { ready: false, translators: new Map(), detector: null, done: new Map(), queue: Promise.resolve() };
const hasKana = (t) => /[\u3040-\u30ff]/.test(t);

async function initTranslation() {
  const btn = $("#translate-btn");
  // 使えない理由を画面に出す（何も表示されないと、壊れているのか分からないため）
  const note = (text) => { btn.hidden = false; btn.disabled = true; btn.textContent = text; btn.title = TRANSLATE_HELP; };
  if (!("Translator" in self)) return note("見出しの翻訳：このブラウザは未対応");
  const status = await Translator.availability({ sourceLanguage: "en", targetLanguage: "ja" }).catch(() => "unavailable");
  if (status === "unavailable") return note("見出しの翻訳：この端末では使えません");
  if (status === "available") {
    return enableTranslation().catch((e) => { console.error(e); note("見出しの翻訳を開始できませんでした"); });
  }
  // 初回は翻訳モデルのダウンロードが必要。ブラウザの決まりでボタン操作から始める
  btn.hidden = false;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "翻訳モデルを準備中…";
    try {
      await enableTranslation((p) => { btn.textContent = `翻訳モデルを準備中… ${Math.round(p * 100)}%`; });
      btn.hidden = true;
    } catch (e) {
      console.error(e);
      note("翻訳を使えませんでした（もう一度読み込んでください）");
    }
  };
}
const TRANSLATE_HELP = "パソコン版 Google Chrome（バージョン138以降）で見ると、見出しを無料で日本語に訳せます。スマホ・Safari・Firefox では原文のままです。";

async function enableTranslation(onProgress) {
  const monitor = onProgress ? (m) => m.addEventListener("downloadprogress", (e) => onProgress(e.loaded)) : undefined;
  tr.translators.set("en", await Translator.create({ sourceLanguage: "en", targetLanguage: "ja", monitor }));
  // 動画タイトルなど言語が分からない見出し用（使えなければ英語とみなす）
  if ("LanguageDetector" in self) tr.detector = await LanguageDetector.create().catch(() => null);
  tr.ready = true;
  if (state.selected) showCountry(state.selected); else showOverview();
}

async function translatorFor(lang) {
  if (!tr.translators.has(lang)) {
    // 英語以外は、モデルが既に端末にある言語だけ使う（新規ダウンロードはボタン操作が必要なため）
    const ok = await Translator.availability({ sourceLanguage: lang, targetLanguage: "ja" }).catch(() => "unavailable");
    tr.translators.set(lang, ok === "available" ? Translator.create({ sourceLanguage: lang, targetLanguage: "ja" }) : null);
  }
  return tr.translators.get(lang);
}

async function toJapanese(text, lang) {
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

// node に見出しを表示し、日本語以外なら訳して差し替える。訳せたら原文を onOriginal で添える
function setHeadline(node, item, onOriginal) {
  if (item.title_ja) { node.textContent = item.title_ja; onOriginal?.(item.title); return; }
  node.textContent = item.title;
  if (!tr.ready || item.lang === "ja" || hasKana(item.title)) return;
  // 一度に大量に訳すと重くなるので順番に処理する
  tr.queue = tr.queue.then(() => toJapanese(item.title, item.lang)).then((ja) => {
    if (ja && node.isConnected) { node.textContent = ja; onOriginal?.(item.title); }
  });
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
    const name = el("span");
    setHeadline(name, v);
    title.replaceChildren(name, `（${v.channel}${v.date ? "・" + fmtDate(v.date) : ""}）`);
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
  if (!items.length) return el("p", { class: "muted" }, "該当する記事はまだありません。");
  return el("ul", { class: "news" }, items.map((n) => {
    const link = el("a", { href: safeUrl(n.link), target: "_blank", rel: "noopener noreferrer" });
    // 訳した見出しには原文も小さく添える（固有名詞の確認用）
    setHeadline(link, n, (orig) => link.after(el("div", { class: "original" }, orig)));
    return el("li", {},
    link,
    el("div", { class: "meta" },
      n.official ? el("span", { class: "tag official" }, "公的機関") : null,
      el("span", {}, n.source),
      n.date ? el("span", {}, fmtDate(n.date)) : null,
      ...(n.tags || []).map((t) => el("span", { class: "tag" }, t)),
      showCountries && n.countries?.length
        ? el("span", {}, n.countries.map((a2) => state.byA2.get(a2)?.ja).filter(Boolean).slice(0, 4).join("・"))
        : null),
    n.summary ? el("p", { class: "summary" }, n.summary) : null);
  }));
}

function langFilterBar(onchange) {
  const opts = [["all", "すべて"], ["ja", "日本語"], ["en", "英語"], ["official", "公的機関のみ"]];
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
  const q = encodeURIComponent(`${c.ja} 医療 感染症`);
  const links = [
    ["WHO 国別ページ", `https://www.who.int/countries/${c.a3.toLowerCase()}`],
    ["外務省 世界の医療事情", "https://www.mofa.go.jp/mofaj/toko/medi/index.html"],
    ["外務省 海外安全HP", "https://www.anzen.mofa.go.jp/"],
    ["FORTH（厚労省検疫所）", "https://www.forth.go.jp/"],
    ["CDC Travelers' Health", "https://wwwnc.cdc.gov/travel/destinations/list"],
    ["Googleニュースで検索", `https://news.google.com/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`],
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
        el("h2", {}, c.ja),
        el("div", { class: "muted" }, `${c.en}・${REGION_NAME[c.region] || ""}`)),
      el("button", { class: "close", "aria-label": "閉じる", onclick: () => { location.hash = ""; } }, "×")),
    info?.tags?.length ? el("div", { class: "tags" }, info.tags.map((t) => el("span", { class: "tag" }, t))) : null,
    el("p", { class: "muted" }, "読み込み中…"),
  );
  panel.scrollTop = 0;

  let data = { news: [], videos: [] };
  try { data = await loadJSON(`data/news/${a2}.json`); } catch { /* 未収集 */ }
  if (state.selected !== a2) return; // 読み込み中に別の国が選ばれた
  panel.lastElementChild.remove();

  const ytSearch = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${c.ja} 医療 OR ${c.en} health`)}`;
  panel.append(
    el("h3", {}, "動画", el("span", { class: "count" }, `${data.videos.length} 本`)),
    videoBlock(data.videos) || el("div", { class: "empty-video" },
      "この国の動画はまだ収集されていません（毎朝順番に収集しています）。",
      el("br"), el("a", { href: ytSearch, target: "_blank", rel: "noopener noreferrer" }, "YouTube で探す →")),
  );
  // 国の動画がないときは世界の注目動画で代わりに映像を見られるようにする
  const gv = state.index?.global?.videos || [];
  if (!data.videos.length && gv.length) {
    panel.append(el("h3", {}, "世界の注目動画"), videoBlock(gv));
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
      el("h3", {}, `${state.disease}の記事`, el("span", { class: "count" }, `${dzNews.length} 件`),
        el("a", { class: "back", href: "#d-" + DISEASE_KEY.get(state.disease) }, "← 分布に戻る")),
      newsList(dzNews));
  }
  panel.append(
    el("h3", {}, "医療・感染症ニュース", el("span", { class: "count" }, `直近 ${data.news.length} 件`)),
    listWrap,
    el("h3", {}, "公式情報・関連リンク"),
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
  const regionTitle = REGION_NAME[state.region] || "世界全体";

  panel.replaceChildren(
    el("h2", {}, regionTitle),
    el("p", { class: "muted" }, "地図上の国をクリックすると、その国の医療・感染症ニュースと動画を表示します。"),
  );
  if (!idx) {
    panel.append(el("div", { class: "notice" },
      "収集データがまだありません。", el("code", {}, "python3 scripts/collect.py"),
      " を実行するか、GitHub Actions の毎日の収集が動くのを待ってください。"));
    panel.append(disclaimer());
    return;
  }

  const gnews = idx.global.news.filter((n) => state.region === "all"
    || n.countries?.some((a2) => state.byA2.get(a2)?.region === state.region));
  const gvideos = idx.global.videos;

  panel.append(
    el("h3", {}, "注目の動画"),
    videoBlock(gvideos) || el("p", { class: "muted" }, "動画はまだありません。"),
    el("h3", {}, "話題の病気", el("span", { class: "count" }, "押すと分布を表示")),
    diseaseChips(),
    el("h3", {}, "記事の多い国", el("span", { class: "count" }, "直近の記事数")),
    ranking.length
      ? el("ol", { class: "rank" }, ranking.map(({ c, n }) => el("li", {},
          el("button", { onclick: () => { location.hash = c.a2; } }, c.ja),
          el("span", { class: "muted" }, `${n} 件` + (idx.countries[c.a2].tags.length ? `・${idx.countries[c.a2].tags.slice(0, 2).join("・")}` : "")))))
      : el("p", { class: "muted" }, "データがありません。"),
  );
  const listWrap = el("div");
  const renderNews = () => listWrap.replaceChildren(langFilterBar(renderNews), newsList(applyLang(gnews).slice(0, 30), { showCountries: true }));
  renderNews();
  panel.append(
    el("h3", {}, "最新の世界の医療ニュース", el("span", { class: "count" }, `${gnews.length} 件`)),
    listWrap,
    el("h3", {}, "収集元の状態"),
    el("ul", { class: "muted" }, idx.sources.map((s) => el("li", {}, `${s.ok ? "✓" : "✗"} ${s.name}（${s.count}件）`))),
    disclaimer(),
  );
}

function diseaseChips() {
  const top = diseaseTotals().slice(0, 12);
  if (!top.length) return el("p", { class: "muted" }, "病名の入った記事はまだありません。");
  return el("div", { class: "chips dz-chips" }, top.map(([k, t]) =>
    el("a", { class: "chip dz", href: "#d-" + DISEASE_KEY.get(k) }, `${k} `, el("span", { class: "n" }, `${t.countries}か国`))));
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
      el("div", {}, el("h2", {}, `${name}の分布`),
        el("div", { class: "muted" }, `報道のある国 ${rows.length} か国・記事 ${total} 件`)),
      el("button", { class: "close", "aria-label": "分布表示をやめる", onclick: () => { location.hash = ""; } }, "×")),
    el("p", { class: "notice" },
      "直近14日のニュース見出しに病名が出た国を、記事数で色分けしています。症例数や公式の流行地図ではありません。",
      "流行状況の判断には WHO や各国保健当局の発表を確認してください。"),
    byRegion.size ? el("div", { class: "tags" }, [...byRegion].sort((a, b) => b[1] - a[1])
      .map(([r, n]) => el("span", { class: "tag" }, `${REGION_NAME[r] || r} ${n}`))) : null,
    el("h3", {}, "報道の多い国", el("span", { class: "count" }, "押すとその国の記事")),
    rows.length
      ? el("ol", { class: "rank" }, rows.slice(0, 30).map(({ c, n }) => el("li", {},
          el("button", { onclick: () => { location.hash = c.a2; } }, c.ja),
          el("span", { class: "muted" }, `${n} 件・${REGION_NAME[c.region] || ""}`))))
      : el("p", { class: "muted" }, "直近の報道はありません。"),
    gnews.length ? el("h3", {}, "最新の関連ニュース", el("span", { class: "count" }, `${gnews.length} 件`)) : null,
    gnews.length ? newsList(gnews.slice(0, 15), { showCountries: true }) : null,
    el("h3", {}, "公式情報"),
    el("div", { class: "links" },
      el("a", { href: "https://www.who.int/emergencies/disease-outbreak-news", target: "_blank", rel: "noopener noreferrer" }, "WHO 感染症アウトブレイク情報"),
      el("a", { href: "https://www.forth.go.jp/", target: "_blank", rel: "noopener noreferrer" }, "FORTH（厚労省検疫所）"),
      el("a", { href: `https://news.google.com/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`, target: "_blank", rel: "noopener noreferrer" }, "Googleニュースで検索")),
    disclaimer(),
  );
  panel.scrollTop = 0;
}

function disclaimer() {
  return el("p", { class: "disclaimer" },
    "※ ニュースは各報道機関・公的機関のフィードから自動収集し、国名・病名は見出しから機械的に判定しています。",
    "誤分類や重複がありえます。渡航・診療の判断には必ず各公的機関の一次情報を確認してください。",
    "このサイトは個人が作成した非公式のツールで、WHO・外務省などの機関とは関係ありません。");
}

init().catch((e) => {
  console.error(e);
  $("#panel").replaceChildren(el("div", { class: "notice" },
    "読み込みに失敗しました。ローカルで開く場合は ", el("code", {}, "python3 -m http.server"),
    " でサーバーを起動してから http://localhost:8000/ を開いてください。", el("br"), String(e)));
});
