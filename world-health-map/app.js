/* 世界医療情報マップ: 地図の描画とパネル表示 */
"use strict";

const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json";
const REGIONS = [
  ["all", "世界全体"], ["asia", "アジア"], ["middle_east", "中東"], ["europe", "ヨーロッパ"],
  ["africa", "アフリカ"], ["north_america", "北米・中米"], ["south_america", "南米"], ["oceania", "オセアニア"],
];
const REGION_NAME = Object.fromEntries(REGIONS);
const HEAT = ["--heat-0", "--heat-1", "--heat-2", "--heat-3", "--heat-4"];

const state = {
  countries: [],      // data/countries.json
  byA2: new Map(),
  byTopoId: new Map(),
  index: null,        // data/news/index.json
  region: "all",
  selected: null,     // a2
  langFilter: "all",
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
  return c && state.index?.countries?.[c.a2]?.news || 0;
}

function render() {
  sphere.attr("d", path);
  graticule.attr("d", path);
  paths.attr("d", path);
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

  // 色の段階は記事数の分位で決める（データ量に合わせて自動調整）
  const counts = state.countries.map(countOf).filter((n) => n > 0).sort(d3.ascending);
  const thresholds = [0.2, 0.4, 0.6, 0.8].map((q) => d3.quantile(counts, q) || 0);
  const css = getComputedStyle(document.documentElement);
  const heat = (n) => (n > 0 ? css.getPropertyValue(HEAT[d3.bisectRight(thresholds, n - 0.5)]) : css.getPropertyValue("--land-empty"));
  $("#legend-scale").replaceChildren(...HEAT.map((v) => el("span", { style: `background:var(${v})` })));

  const tip = $("#tooltip");
  paths = svg.append("g").selectAll("path").data(features).join("path")
    .attr("class", (f) => "country" + (countryOf(f) ? "" : " no-data"))
    .attr("fill", (f) => heat(countOf(countryOf(f))))
    .on("mousemove", (ev, f) => {
      const c = countryOf(f);
      const info = c && state.index?.countries?.[c.a2];
      tip.replaceChildren(
        el("strong", {}, c ? c.ja : f.properties.name),
        c ? `記事 ${info?.news || 0} 件・動画 ${info?.videos || 0} 本` : "データなし",
        info?.tags?.length ? el("div", { class: "muted" }, info.tags.join("・")) : null,
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

function fromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
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
  document.querySelectorAll("#regions .chip").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.region === state.region)));
  highlight();
  $("#search").value = state.selected ? state.byA2.get(state.selected).ja : "";
  if (state.selected) {
    zoomToCountry(state.selected);
    showCountry(state.selected);
  } else {
    zoomToRegion(state.region);
    showOverview();
  }
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
    title.textContent = `${v.title}（${v.channel}${v.date ? "・" + fmtDate(v.date) : ""}）`;
    thumbs.querySelectorAll(".thumb").forEach((b) => b.removeAttribute("aria-current"));
    btn?.setAttribute("aria-current", "true");
  };
  videos.forEach((v, i) => {
    const btn = el("button", { class: "thumb", title: v.title },
      el("img", { src: `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`, alt: "", loading: "lazy" }),
      el("span", {}, v.title));
    btn.onclick = () => play(v, btn);
    thumbs.append(btn);
    if (i === 0) play(v, btn);
  });
  if (videos.length === 1) thumbs.remove();
  return node;
}

function newsList(items, { showCountries = false } = {}) {
  if (!items.length) return el("p", { class: "muted" }, "該当する記事はまだありません。");
  return el("ul", { class: "news" }, items.map((n) => el("li", {},
    el("a", { href: safeUrl(n.link), target: "_blank", rel: "noopener noreferrer" }, n.title),
    el("div", { class: "meta" },
      n.official ? el("span", { class: "tag official" }, "公的機関") : null,
      el("span", {}, n.source),
      n.date ? el("span", {}, fmtDate(n.date)) : null,
      ...(n.tags || []).map((t) => el("span", { class: "tag" }, t)),
      showCountries && n.countries?.length
        ? el("span", {}, n.countries.map((a2) => state.byA2.get(a2)?.ja).filter(Boolean).slice(0, 4).join("・"))
        : null),
    n.summary ? el("p", { class: "summary" }, n.summary) : null)));
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

function disclaimer() {
  return el("p", { class: "disclaimer" },
    "※ ニュースは各報道機関・公的機関のフィードから自動収集し、国名・病名は見出しから機械的に判定しています。",
    "誤分類や重複がありえます。渡航・診療の判断には必ず各公的機関の一次情報を確認してください。");
}

init().catch((e) => {
  console.error(e);
  $("#panel").replaceChildren(el("div", { class: "notice" },
    "読み込みに失敗しました。ローカルで開く場合は ", el("code", {}, "python3 -m http.server"),
    " でサーバーを起動してから http://localhost:8000/ を開いてください。", el("br"), String(e)));
});
