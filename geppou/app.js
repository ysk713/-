/* 医務官月報 取りまとめ（ブラウザ版）
 * PDFの読み取り・集計・地図・Word出力をすべてブラウザ内で行う。
 * データはこのブラウザの IndexedDB にだけ保存される（「設定」からJSONで書き出し・読み込み可）。
 * 読み取りロジックは geppou-app/geppou/parsing.py を移植したもの。
 */
"use strict";

const D = window.GEPPOU_DATA;
pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

// ======================================================================= 公館マスタ

const INFO = {};
const ALIASES = {};
const nfkc = (s) => (s || "").normalize("NFKC");
const norm = (s) => nfkc(s).replace(/[\s・\-_'’]/g, "").toLowerCase();
for (const p of D.posts) {
  INFO[p.name] = { region: p.region, iso3: p.iso3, lat: p.lat, lon: p.lon, isPost: true };
  for (const a of [p.name, ...p.aliases]) ALIASES[norm(a)] = p.name;
}
for (const p of D.extra) {
  INFO[p.name] = { region: p.region, iso3: p.iso3, lat: p.lat, lon: p.lon, isPost: false };
  if (!ALIASES[norm(p.name)]) ALIASES[norm(p.name)] = p.name;
}
const ALIAS_SORTED = Object.entries(ALIASES).sort((a, b) => b[0].length - a[0].length);
const POST_NAMES = D.posts.map((p) => p.name);
const ALL_PLACES = Object.keys(INFO).sort((a, b) => a.localeCompare(b, "ja"));
const REGIONS = D.regions;

function canonical(raw) {
  if (!raw) return null;
  let s = nfkc(raw).trim().replace(/^在/, "").replace("日本国", "").replace("日本", "");
  const cons = s.includes("総領事館");
  s = s.replace(/(大使館|総領事館|領事事務所|政府代表部|代表部)$/, "");
  if (cons && ALIASES[norm(s + "総領事館")]) return ALIASES[norm(s + "総領事館")];
  return ALIASES[norm(s)] || null;
}

const KATA = /[゠-ヿ]/;
function findInText(text) {
  let t = nfkc(text).toLowerCase().replace(/[\s・]+/g, "|").replace("トリニダード|トバゴ", "トリニダードトバゴ");
  const used = new Array(t.length).fill(false);
  const hits = [];
  for (const [alias, name] of ALIAS_SORTED) {
    if (alias.length < 2) continue;
    const kata = [...alias].every((c) => KATA.test(c));
    const ascii = /^[\x00-\x7f]+$/.test(alias);
    let start = 0;
    for (;;) {
      const i = t.indexOf(alias, start);
      if (i < 0) break;
      const j = i + alias.length;
      const before = i > 0 ? t[i - 1] : "";
      const after = j < t.length ? t[j] : "";
      let ok = !used.slice(i, j).some(Boolean);
      // 「タイミング」「サマリー」のようなカタカナ語の一部には一致させない
      if (kata && ((before && KATA.test(before)) || (after && KATA.test(after)))) ok = false;
      if (ascii && (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after))) ok = false;
      if (ok) { for (let k = i; k < j; k++) used[k] = true; hits.push([i, name]); }
      start = i + 1;
    }
  }
  const out = [];
  for (const [, n] of hits.sort((a, b) => a[0] - b[0])) if (!out.includes(n)) out.push(n);
  return out;
}

const regionOf = (name) => (INFO[name] ? INFO[name].region : "未分類");
const coord = (name) => (INFO[name] ? [INFO[name].lat, INFO[name].lon] : null);

// ======================================================================= 疾病分類

const Z = D.z, OTHER = D.other;
const CATEGORIES = [...D.rules.map((r) => r[0]), OTHER];
const shortCat = (c) => D.short[c] || c;
function classify(name) {
  if (state.overrides[name]) return state.overrides[name];
  for (const [cat, kws] of D.rules) if (kws.some((k) => name.includes(k))) return cat;
  return OTHER;
}

// ======================================================================= 保存（IndexedDB）

let state = { reports: {}, rosters: {}, junkai: {}, overrides: {} };

const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("geppou", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const r = db.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async set(key, val) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
};

async function loadState() {
  try {
    const s = await idb.get("state");
    if (s) state = Object.assign({ reports: {}, rosters: {}, junkai: {}, overrides: {} }, s);
  } catch (e) {
    toast("ブラウザの保存領域が使えません。データは再読み込みで消えます。");
  }
}
async function saveState() {
  try { await idb.set("state", state); } catch (e) { toast("保存に失敗しました: " + e.message); }
}

// ======================================================================= データ参照

const months = () => [...new Set([...Object.values(state.reports).map((r) => r.month), ...Object.keys(state.rosters)])].sort();
const reportsOf = (m) => Object.values(state.reports).filter((r) => !m || r.month === m)
  .sort((a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region) || a.post.localeCompare(b.post, "ja"));
const getReport = (m, p) => state.reports[`${m}|${p}`];

function diseasesOf(m) {
  const out = [];
  for (const r of reportsOf(m))
    for (const d of r.diseases || []) out.push({ month: r.month, post: r.post, region: r.region, name: d.name, count: d.count, category: classify(d.name) });
  return out;
}
function eventsOf(m) {
  const out = [];
  for (const r of reportsOf(m)) for (const e of r.events || []) out.push({ ...e, post: r.post, month: r.month });
  return out;
}
const junkaiOf = (m) => (m ? state.junkai[m] || [] : Object.entries(state.junkai).flatMap(([mm, js]) => js.map((j) => ({ ...j, month: mm }))));

function rosterFor(m) {
  const ms = Object.keys(state.rosters).sort();
  if (!ms.length) return null;
  const le = ms.filter((x) => x <= m);
  return state.rosters[le.length ? le[le.length - 1] : ms[0]];
}

function prevMonth(m) {
  let [y, mo] = m.split("-").map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}
const fmtMonth = (m) => { const [y, mo] = m.split("-"); return `${y}年${Number(mo)}月`; };
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const n = (v) => (v === null || v === undefined || v === "" || Number.isNaN(v) ? "―" : String(v));
const samePerson = (a, b) => !!a && nfkc(a).replace(/\s/g, "") === nfkc(b || "").replace(/\s/g, "");

// ======================================================================= PDF 読み込み

async function readPages(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4) {
    const z = await JSZip.loadAsync(buf);
    if (z.file("word/document.xml")) return ["word", await readDocx(z)];
    return ["zip", await readZip(z)];
  }
  if (/\.doc$/i.test(file.name)) throw new Error("古い形式の .doc は読めません。Wordで「.docx」形式で保存し直してください");
  return ["pdf", await readPdf(buf)];
}

const pageNum = (name) => Number(name.replace(/\D/g, "") || 0);

async function readDocx(z) {
  // Word の本文と表をテキスト化する。表は1行＝1行、セルは空白区切り（PDFのOCRテキストと同じ形にそろえる）
  const xml = await z.file("word/document.xml").async("string");
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const text = (node) => {
    let out = "";
    for (const c of node.childNodes) {
      const tag = c.localName;
      if (tag === "t") out += c.textContent;
      else if (tag === "tab") out += " ";
      else if (tag === "br") out += c.getAttribute("w:type") === "page" ? "\f" : "\n";
      else if (tag === "p") out += text(c) + "\n";
      else if (tag === "tbl") out += text(c);
      else if (tag === "tr") out += [...c.childNodes].filter((x) => x.localName === "tc").map((tc) => text(tc).replace(/\n+/g, " ").trim()).join(" ") + "\n";
      else if (tag === "lastRenderedPageBreak") continue;
      else if (c.childNodes && c.childNodes.length) out += text(c);
    }
    return out;
  };
  const body = dom.getElementsByTagNameNS("*", "body")[0];
  const full = body ? text(body) : "";
  // 改ページのほか、乙表・丙表の見出しの手前でもページを分ける
  const chunks = full.split("\f").flatMap((pg) => pg.split(/(?=疾病分類件数表)|(?=報告事項)/));
  const pages = chunks.filter((t) => t.trim()).map((t, i) => ({ num: i + 1, text: t, needs: false, image: null }));
  if (!pages.length) {
    // 文字のないWord（スキャン画像の貼り付けなど）: 目視確認用に画像を出す
    const media = Object.keys(z.files).filter((f) => /^word\/media\/.+\.(jpe?g|png)$/i.test(f));
    for (let i = 0; i < media.length; i++) {
      const ext = media[i].toLowerCase().endsWith("png") ? "png" : "jpeg";
      pages.push({ num: i + 1, text: "", needs: true, image: `data:image/${ext};base64,` + (await z.file(media[i]).async("base64")) });
    }
    if (!pages.length) pages.push({ num: 1, text: "", needs: true, image: null });
  }
  return pages;
}

async function readZip(z) {
  // 中身が ZIP の「PDF」（N.jpeg / N.txt / manifest.json）
  const visual = new Set();
  if (z.file("manifest.json")) {
    try {
      const m = JSON.parse(await z.file("manifest.json").async("string"));
      for (const p of m.pages || []) if (p.has_visual_content) visual.add(Number(p.page_number));
    } catch (e) { /* manifest が壊れていても本文は読む */ }
  }
  const pages = {};
  for (const name of Object.keys(z.files)) {
    const k = pageNum(name);
    if (name.endsWith(".txt")) (pages[k] ||= {}).text = await z.file(name).async("string");
    else if (/\.(jpe?g|png)$/i.test(name)) (pages[k] ||= {}).imageFile = name;
  }
  const out = [];
  for (const k of Object.keys(pages).map(Number).sort((a, b) => a - b)) {
    const p = pages[k];
    const text = p.text || "";
    const needs = !text.trim() || visual.has(k);
    let image = null;
    if (needs && p.imageFile) image = "data:image/jpeg;base64," + (await z.file(p.imageFile).async("base64"));
    out.push({ num: k, text, needs, image });
  }
  return out;
}

async function readPdf(buf) {
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = "", lastY = null;
    for (const it of tc.items) {
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) text += "\n";
      else if (text && !text.endsWith("\n")) text += " ";
      text += it.str;
      lastY = y;
    }
    const needs = !text.trim();
    let image = null;
    if (needs) {
      // テキスト層のないスキャンPDF: 目視確認用に画像化
      const vp = page.getViewport({ scale: 1.4 });
      const c = document.createElement("canvas");
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      image = c.toDataURL("image/jpeg", 0.8);
    }
    out.push({ num: i, text, needs, image });
  }
  return out;
}

// ======================================================================= 解析

function detectMonth(text, filename) {
  const t = nfkc(text);
  let m = t.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*分/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  m = t.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月/);
  if (m) return `${Number(m[1]) + 2018}-${m[2].padStart(2, "0")}`;
  m = nfkc(filename).match(/(20\d{2})[-_年]?(0[1-9]|1[0-2])(?!\d)/);
  if (m) return `${m[1]}-${m[2]}`;
  return null;
}

function classifyPages(pages) {
  const kou = [], otsu = [], hei = [];
  let inHei = false;
  for (const p of pages) {
    const t = p.text;
    if (t.includes("疾病分類件数表") || /[ＡA][0０][0０].{0,3}[ＢB][9９][9９]/.test(t)) {
      const i = t.indexOf("報告事項");
      if (i >= 0) { otsu.push(t.slice(0, i)); hei.push(t.slice(i + 4)); inHei = true; }
      else otsu.push(t);
      continue;
    }
    if (t.includes("報告事項")) { inHei = true; hei.push(t.slice(t.indexOf("報告事項") + 4)); continue; }
    if (t.includes("受診者数") && !inHei) { kou.push(t); continue; }
    if (inHei) hei.push(t);
    else if (!kou.length) kou.push(t);
    else hei.push(t);
  }
  return [kou, otsu, hei];
}

function parseKou(text) {
  const t = nfkc(text);
  const lines = t.split("\n");
  let embassy = null, officer = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/在\S{1,25}?(?:日本国)?(?:大使館|総領事館|政府代表部|領事事務所)/);
    if (!m) continue;
    embassy = m[0];
    const rest = lines[i].slice(m.index + m[0].length).replace(/医務官\s*$/, "").trim();
    if (rest) officer = rest;
    else {
      for (const cand of lines.slice(i + 1, i + 3).map((s) => s.trim())) {
        if (cand && !/受診者数|調査票|駐在公館|年|月/.test(cand)) { officer = cand.replace(/医務官\s*$/, "").trim(); break; }
      }
    }
    break;
  }
  if (officer) officer = officer.replace(/^(医務官|報告者)[:：]?/, "").trim() || null;
  let counts = null;
  const m = t.match(/受診者数[^\d\n]*(\d+)\D+?(\d+)\D+?(\d+)\D+?(\d+)/);
  if (m) counts = m.slice(1, 5).map(Number);
  else {
    for (const ln of lines) {
      const nums = ln.match(/\d+/g);
      if (nums && nums.length === 4 && /^[\d\s]+$/.test(ln.trim())) { counts = nums.map(Number); break; }
    }
  }
  return { embassy, officer, counts };
}

const NOISE = [/^[\d\s]+$/, /^\(.*年.*月分\)$/, /^報告者/, /^\d{4}\s*\d{1,2}$/, /毎月分を翌月/, /甲表は延べ件数/, /^疾病分類件数表$/, /^在.+(大使館|総領事館)/];
function parseOtsu(pageTexts) {
  const pairs = [];
  for (const page of pageTexts) {
    const kept = nfkc(page).split("\n").map((s) => s.trim()).filter((s) => s && !NOISE.some((re) => re.test(s)));
    const joined = kept.join(" ");
    // OCRで表の列順が崩れても拾えるよう、内訳欄の「病名(件数)」だけを抜き出す
    for (const m of joined.matchAll(/([^()\d][^()]*?)\((\d+)\)/g)) {
      const toks = m[1].split(/\s+/).filter(Boolean);
      let cut = 0;
      toks.forEach((tok, i) => {
        if (/^\d+$/.test(tok) || /^[A-Z]\d{2}([-~][A-Z]?\d{2})?$/.test(tok) || /[A-Z]\d{2}.*[A-Z]\d{2}/.test(tok) || tok.includes("感染症及び寄生虫症")) cut = i + 1;
      });
      const name = toks.slice(cut).join("").replace(/^[、,，;；:：]+|[、,，;；:：]+$/g, "");
      const c = Number(m[2]);
      if (name.length >= 2 && c <= 500) pairs.push({ name, count: c });
    }
  }
  return pairs;
}

function sentences(text) {
  const t = nfkc(text).replace(/[ \t]+/g, " ");
  const out = [];
  for (let s of t.split(/(?<=。)|\n/)) {
    s = (s || "").trim().replace(/^(?:[・●○■□◆◇\-*]|[(（]?\d{1,2}[)）.．、](?!\d))\s*/, "");
    if (s.length >= 8) out.push(s); // 「巡回健診」のような見出しだけの行は除く
  }
  return out;
}

function detectEvents(heiText) {
  const out = [], seen = new Set();
  for (const s of sentences(heiText))
    for (const [kind, kws] of Object.entries(D.events))
      for (const kw of kws)
        if (s.includes(kw) && !seen.has(kind + kw)) { seen.add(kind + kw); out.push({ kind, keyword: kw, snippet: s.slice(0, 160) }); }
  return out;
}

// 丙表に出てくる病名の辞書: [表示名, 本文中の表記パターン]
const HEI_DISEASES = [
  ["デング熱", ["デング"]], ["マラリア", ["マラリア"]], ["コレラ", ["コレラ"]], ["エボラ出血熱", ["エボラ"]],
  ["マールブルグ病", ["マールブルグ", "マールブルク"]], ["エムポックス", ["エムポックス", "サル痘", "mpox", "Mpox"]],
  ["麻疹", ["麻疹", "はしか", "麻しん"]], ["風疹", ["風疹", "風しん"]], ["黄熱", ["黄熱"]], ["チクングニア熱", ["チクングニア"]],
  ["ジカウイルス感染症", ["ジカ熱", "ジカウイルス"]], ["鳥インフルエンザ", ["鳥インフルエンザ", "H5N1"]],
  ["新型コロナウイルス感染症", ["新型コロナ", "COVID", "コロナウイルス"]], ["インフルエンザ", ["インフルエンザ"]],
  ["RSウイルス感染症", ["RSウイルス"]], ["狂犬病", ["狂犬病"]], ["ペスト", ["ペスト"]], ["腸チフス", ["腸チフス", "チフス"]],
  ["赤痢", ["赤痢"]], ["A型肝炎", ["A型肝炎"]], ["E型肝炎", ["E型肝炎"]], ["ポリオ", ["ポリオ", "急性弛緩性麻痺"]],
  ["髄膜炎", ["髄膜炎"]], ["ラッサ熱", ["ラッサ熱"]], ["クリミア・コンゴ出血熱", ["クリミア・コンゴ", "クリミアコンゴ"]],
  ["リフトバレー熱", ["リフトバレー"]], ["結核", ["結核"]], ["百日咳", ["百日咳"]], ["ジフテリア", ["ジフテリア"]],
  ["手足口病", ["手足口病"]], ["オロプーシェ熱", ["オロプーシェ"]], ["日本脳炎", ["日本脳炎"]], ["レプトスピラ症", ["レプトスピラ"]],
  ["ハンタウイルス感染症", ["ハンタウイルス"]], ["MERS", ["MERS", "中東呼吸器症候群"]], ["炭疽", ["炭疽"]], ["猩紅熱", ["猩紅熱"]],
  ["マイコプラズマ肺炎", ["マイコプラズマ"]], ["水痘", ["水痘", "水ぼうそう"]], ["流行性耳下腺炎", ["耳下腺炎", "おたふく"]],
  ["ノロウイルス", ["ノロウイルス"]], ["ロタウイルス", ["ロタウイルス"]], ["食中毒", ["食中毒"]], ["熱中症", ["熱中症"]],
  ["ウエストナイル熱", ["ウエストナイル", "西ナイル"]], ["ニパウイルス感染症", ["ニパ"]], ["ブルセラ症", ["ブルセラ"]],
  ["住血吸虫症", ["住血吸虫"]], ["リーシュマニア症", ["リーシュマニア"]], ["シャーガス病", ["シャーガス"]], ["疥癬", ["疥癬"]],
  ["胃腸炎・下痢症", ["胃腸炎", "下痢症", "感染性腸炎"]], ["呼吸器感染症", ["呼吸器感染症", "気道感染"]],
];
const RISING = /流行|増加|急増|拡大|多発|発生|アウトブレイク|蔓延|まん延|感染者|患者が|症例|報告が続|警戒|注意喚起/;
const FALLING = /減少|終息|収束|落ち着|沈静|新規.{0,6}(なし|ない)|確認されていない/;

// 丙表から病名を拾う -> [{name, trend: "流行・増加"|"減少・終息"|"言及", sentence}]
const HEI_PATTERNS = HEI_DISEASES.flatMap(([name, pats]) => pats.map((p) => [p, name])).sort((a, b) => b[0].length - a[0].length);
function heiDiseases(heiText) {
  const found = {};
  const rank = { "流行・増加": 3, "言及": 2, "減少・終息": 1 };
  for (const s of sentences(heiText)) {
    // 長い表記から先に照合し、重なる箇所は数えない（「鳥インフルエンザ」を「インフルエンザ」と二重に拾わない）
    const used = new Array(s.length).fill(false);
    const names = new Set();
    for (const [pat, name] of HEI_PATTERNS) {
      let i = s.indexOf(pat);
      while (i >= 0) {
        if (!used.slice(i, i + pat.length).some(Boolean)) { for (let k = i; k < i + pat.length; k++) used[k] = true; names.add(name); }
        i = s.indexOf(pat, i + 1);
      }
    }
    const trend = FALLING.test(s) ? "減少・終息" : RISING.test(s) ? "流行・増加" : "言及";
    for (const name of names) {
      const cur = found[name];
      if (!cur || rank[trend] > rank[cur.trend]) found[name] = { name, trend, sentence: s.slice(0, 160) };
    }
  }
  return Object.values(found);
}
function outbreaksOf(m) {
  const out = [];
  for (const r of reportsOf(m)) for (const d of heiDiseases(r.hei)) out.push({ ...d, post: r.post, region: r.region, month: r.month });
  return out;
}
const TREND_MARK = { "流行・増加": "↑", "減少・終息": "↓", "言及": "" };

const PERIOD = /(\d{1,2})月\s*(\d{1,2})日(?:\s*\([^)]\))?\s*(?:[~〜～\-－ー]|から)\s*(?:(\d{1,2})月\s*)?(\d{1,2})日/;
function detectJunkai(heiText, own) {
  const out = [];
  for (const s of sentences(heiText)) {
    if (!s.includes("巡回")) continue;
    const places = findInText(s).filter((p) => p !== own);
    const m = s.match(PERIOD);
    const period = m ? `${m[1]}/${m[2]}〜${m[3] || m[1]}/${m[4]}` : "";
    const incoming = /(による|が来訪|を受け|来館)/.test(s);
    if (!places.length && period) out.push({ from: own, dest: "", period, note: s.slice(0, 160), src: own });
    for (const p of places) {
      if (incoming && INFO[p] && INFO[p].isPost) out.push({ from: p, dest: own, period, note: s.slice(0, 160), src: own });
      else out.push({ from: own, dest: p, period, note: s.slice(0, 160), src: own });
    }
  }
  return out;
}

async function parseReport(file) {
  const [fmt, pages] = await readPages(file);
  const full = pages.map((p) => p.text).join("\n");
  const [kou, otsu, hei] = classifyPages(pages);
  const k = parseKou(kou.length ? kou.join("\n") : full);
  let post = k.embassy ? canonical(k.embassy) : null;
  if (!post) {
    const stem = file.name.replace(/\.(pdf|docx?)$/i, "");
    post = findInText(stem)[0] || findInText(stem.replace(/[\d_\-]/g, " "))[0] || null;
  }
  const warnings = [];
  if (!post) warnings.push("公館名を特定できません");
  if (!k.officer) warnings.push("医務官名を読み取れません");
  if (!k.counts) warnings.push("受診者数を読み取れません");
  else if (k.counts[0] + k.counts[1] + k.counts[2] !== k.counts[3]) warnings.push("受診者数の合計が一致しません");
  const vis = pages.filter((p) => p.needs).map((p) => p.num);
  if (vis.length) warnings.push(`OCRテキストなし（要目視）: p.${vis.join(", ")}`);
  const diseases = parseOtsu(otsu);
  if (otsu.length && !diseases.length) warnings.push("乙表の病名を抽出できません");
  const hei_ = hei.join("\n").trim();
  return {
    filename: file.name, format: fmt, month: detectMonth(full, file.name), post, officer: k.officer,
    staff: k.counts ? k.counts[0] : null, family: k.counts ? k.counts[1] : null,
    other: k.counts ? k.counts[2] : null, total: k.counts ? k.counts[3] : null,
    diseases, hei: hei_, warnings, images: pages.filter((p) => p.needs && p.image).map((p) => [p.num, p.image]),
  };
}

async function parseRoster(file) {
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
  const sname = wb.SheetNames.find((s) => s.includes("配置")) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sname], { header: 1, defval: "" });
  const h = rows.slice(0, 15).findIndex((r) => r.join(" ").includes("公館"));
  if (h < 0) throw new Error("「公館」を含む見出し行が見つかりません");
  const cols = rows[h].map((c) => String(c).trim());
  const pick = (keys, exclude = []) => cols.findIndex((c) => keys.some((k) => c.includes(k)) && !exclude.some((e) => c.includes(e)));
  const cPost = pick(["駐在公館", "公館"]);
  const cName = pick(["氏名", "医務官"], ["ふりがな", "フリガナ", "公館"]);
  const cKana = pick(["ふりがな", "フリガナ", "よみ"]);
  const cNote = pick(["備考", "状況"]);
  const out = [];
  for (const r of rows.slice(h + 1)) {
    const raw = String(r[cPost] || "").trim();
    if (!raw) continue;
    const post = canonical(raw) || findInText(raw)[0] || raw;
    const officer = cName >= 0 ? String(r[cName] || "").trim() : "";
    const note = cNote >= 0 ? String(r[cNote] || "").trim() : "";
    out.push({ post, officer, kana: cKana >= 0 ? String(r[cKana] || "").trim() : "", note,
      staffed: !!officer && !/未配置|欠員|退避|不在/.test(officer + note) });
  }
  return out;
}

// ======================================================================= 分析

function missingPosts(m) {
  const ro = rosterFor(m);
  if (!ro) return null;
  const got = new Set(reportsOf(m).map((r) => r.post));
  return ro.filter((r) => r.staffed && !got.has(r.post)).map((r) => ({ ...r, region: regionOf(r.post) }))
    .sort((a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region));
}

function officerTable() {
  // 月×公館の医務官名。月報ヘッダーを優先し、無い月は配置表で補う
  const t = {};
  for (const [m, rows] of Object.entries(state.rosters)) for (const r of rows) if (r.staffed) (t[m] ||= {})[r.post] = r.officer;
  for (const r of Object.values(state.reports)) if (r.officer) (t[r.month] ||= {})[r.post] = r.officer;
  return t;
}

function transfers() {
  const t = officerTable();
  const ms = Object.keys(t).sort();
  const out = [];
  for (let i = 1; i < ms.length; i++) {
    const prev = t[ms[i - 1]], cur = t[ms[i]];
    for (const [post, after] of Object.entries(cur)) {
      const before = prev[post];
      if (before && !samePerson(before, after)) {
        const from = Object.entries(prev).find(([p, o]) => p !== post && samePerson(o, after));
        out.push({ month: ms[i], post, before, after, from: from ? from[0] : null });
      }
    }
  }
  return out;
}

function ruleSummary(m, post) {
  const r = getReport(m, post);
  if (!r) return "";
  const pr = getReport(prevMonth(m), post);
  const lines = [];
  if (r.total !== null && r.total !== undefined && r.total !== "") {
    let s = `受診者数 ${r.total}名（職員${r.staff || 0}・家族${r.family || 0}・その他${r.other || 0}）`;
    if (pr && pr.total !== null && pr.total !== undefined) { const d = r.total - pr.total; s += `、前月比${d >= 0 ? "+" : ""}${d}`; }
    lines.push(s);
  } else lines.push("受診者数：未記載");
  const agg = {};
  for (const d of r.diseases || []) if (classify(d.name) !== Z) agg[d.name] = (agg[d.name] || 0) + d.count;
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 3);
  lines.push("主な疾病：" + (top.length ? top.map(([k, v]) => `${k}(${v})`).join("、") : "特記なし"));
  const sents = sentences(r.hei), used = new Set();
  const pickS = (kws) => { const s = sents.find((x) => !used.has(x) && kws.some((k) => x.includes(k))); if (s) used.add(s); return s; };
  const clip = (s) => { s = s.replace(/。$/, ""); return s.length <= 70 ? s : s.slice(0, 69) + "…"; };
  let s = pickS([...D.events["感染症"], "流行", "医療機関", "病院", "薬"]);
  lines.push("医療・感染症：" + (s ? clip(s) : "特記なし"));
  s = pickS(D.events["邦人保護"]);
  lines.push("邦人保護・緊急対応：" + (s ? clip(s) : "特記なし"));
  s = pickS(["巡回", "着任", "離任", "異動", ...D.events["治安・社会"], ...D.events["気象・災害"]]) || sents.find((x) => !used.has(x));
  lines.push("その他：" + (s ? clip(s) : "特記なし"));
  return lines.join("\n");
}

function overviewBullets(m) {
  const rep = reportsOf(m), pr = reportsOf(prevMonth(m)), dis = diseasesOf(m), ev = eventsOf(m), jk = junkaiOf(m);
  const out = [];
  let s = `提出${rep.length}公館の受診者数は延べ${sum(rep, (r) => r.total)}名`;
  if (pr.length) s += `（前月${sum(pr, (r) => r.total)}名、提出${pr.length}公館）`;
  out.push(s + "。");
  const cat = {};
  for (const d of dis) if (d.category !== Z) cat[d.category] = (cat[d.category] || 0) + d.count;
  const tc = Object.entries(cat).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (tc.length) out.push("疾病分類（検診・予防接種を除く）は " + tc.map(([c, v]) => `${shortCat(c)} ${v}件`).join("、") + " の順に多い。");
  const ob = {};
  for (const o of outbreaksOf(m).filter((o) => o.trend === "流行・増加")) (ob[o.name] ||= new Set()).add(o.post);
  if (Object.keys(ob).length) out.push("丙表で流行・増加が報告された病気：" + Object.entries(ob).sort((a, b) => b[1].size - a[1].size)
    .map(([k, ps]) => `${k}（${[...ps].join("・")}）`).join("／") + "。");
  for (const kind of ["気象・災害", "治安・社会"]) {
    const g = {};
    for (const e of ev.filter((e) => e.kind === kind)) (g[e.keyword] ||= new Set()).add(e.post);
    if (Object.keys(g).length) out.push(`${kind}：` + Object.entries(g).map(([k, ps]) => `${k}（${[...ps].join("・")}）`).join("／") + "。");
  }
  if (jk.length) out.push(`巡回健診の報告 ${jk.length}件：` + jk.map((j) => `${j.from}→${j.dest || "（行先不明）"}`).join("、") + "。");
  const tr = transfers().filter((t) => t.month === m);
  if (tr.length) out.push("医務官の交代：" + tr.map((t) => `${t.post}（${t.before}→${t.after}）`).join("、") + "。");
  const miss = missingPosts(m);
  if (miss && miss.length) out.push(`月報未提出 ${miss.length}公館：` + miss.map((x) => x.post).join("、") + "。");
  return out;
}

// ======================================================================= 地図（Plotly の通常の座標系で描く。geo機能は外部CDNから地図を取りに行くため使わない）

let GEO = null;
const COUNTRY_XY = {};
async function loadGeo() {
  if (GEO) return;
  GEO = await (await fetch("countries.geo.json")).json();
  for (const f of GEO.features) {
    if (f.id === "ATA" || f.id === "-99") continue;
    const g = f.geometry;
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    const xs = [], ys = [];
    for (const poly of polys) { for (const c of poly[0]) { xs.push(c[0]); ys.push(c[1]); } xs.push(null); ys.push(null); }
    COUNTRY_XY[f.id] = [xs, ys];
  }
}

const MIN_FULL = 8;
function blend(hex, w = 0.45) {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * w + 255 * (1 - w)));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
const EVENT_STYLE = { "感染症": ["cross", "#B00020"], "気象・災害": ["square", "#E67E22"], "治安・社会": ["triangle-up", "#5D4037"], "邦人保護": ["diamond", "#1565C0"] };

function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

function baseTraces() {
  const xs = [], ys = [];
  for (const [x, y] of Object.values(COUNTRY_XY)) { xs.push(...x); ys.push(...y); }
  return [{ x: xs, y: ys, type: "scatter", mode: "lines", fill: "toself", fillcolor: css("--border") || "#dde3ea",
    line: { color: css("--surface") || "#fff", width: 0.5 }, hoverinfo: "skip", showlegend: false }];
}
function countryTrace(iso, color, name, hover, legend) {
  const xy = COUNTRY_XY[iso];
  if (!xy) return null;
  return { x: xy[0], y: xy[1], type: "scatter", mode: "lines", fill: "toself", fillcolor: color, name, legendgroup: name,
    showlegend: legend, line: { color: css("--surface") || "#fff", width: 0.5 }, hoveron: "fills", text: hover, hoverinfo: "text" };
}
function mapLayout(height = 560, forExport = false) {
  return {
    height, margin: { l: 0, r: 0, t: 10, b: 0 }, hovermode: "closest", dragmode: "pan",
    xaxis: { visible: false, range: [-170, 190], fixedrange: false },
    yaxis: { visible: false, range: [-58, 85], scaleanchor: "x", scaleratio: 1.15 },
    legend: { orientation: "h", y: -0.02, x: 0, font: { size: 11 } },
    paper_bgcolor: forExport ? "#ffffff" : "rgba(0,0,0,0)", plot_bgcolor: forExport ? "#ffffff" : "rgba(0,0,0,0)",
    font: { color: forExport ? "#1c2430" : css("--text") },
  };
}

function countryDominant(dis) {
  const by = {};
  for (const d of dis) {
    if (d.category === Z) continue;
    const iso = INFO[d.post] && INFO[d.post].iso3;
    if (!iso) continue;
    const o = (by[iso] ||= { cats: {}, posts: new Set() });
    o.cats[d.category] = (o.cats[d.category] || 0) + d.count;
    o.posts.add(d.post);
  }
  return Object.entries(by).map(([iso, o]) => {
    const cats = Object.entries(o.cats).sort((a, b) => b[1] - a[1]);
    const total = cats.reduce((a, c) => a + c[1], 0);
    return { iso, category: cats[0][0], total, posts: [...o.posts].join("・"),
      detail: cats.slice(0, 5).map(([c, v]) => `${shortCat(c)}: ${v}`).join("<br>") };
  }).filter((x) => x.total > 0);
}

function worldTraces(m, opt) {
  const traces = baseTraces();
  if (opt.disease) {
    const shown = new Set();
    for (const r of countryDominant(diseasesOf(m))) {
      const weak = r.total < MIN_FULL;
      const col = weak ? blend(D.colors[r.category] || "#999") : D.colors[r.category] || "#999";
      const label = shortCat(r.category) + (weak ? "（少数）" : "");
      const t = countryTrace(r.iso, col, label, `<b>${r.posts}</b><br>最多: ${label}<br>実患 ${r.total}件<br>${r.detail}`, !shown.has(label));
      if (t) { traces.push(t); shown.add(label); }
    }
  }
  if (opt.visits) {
    const rs = reportsOf(m).filter((r) => r.total !== null && coord(r.post));
    traces.push({ x: rs.map((r) => coord(r.post)[1]), y: rs.map((r) => coord(r.post)[0]), type: "scatter", mode: "markers",
      name: "受診者数（○の大きさ）", marker: { size: rs.map((r) => Math.max(5, 3 * Math.sqrt(r.total))), color: "rgba(0,0,0,0)", line: { color: css("--text") || "#263238", width: 1.3 } },
      text: rs.map((r) => `<b>${r.post}</b><br>医務官: ${r.officer || "―"}<br>受診者数: ${r.total}名`), hoverinfo: "text" });
  }
  if (opt.junkai) {
    let first = true;
    for (const j of junkaiOf(m)) {
      const a = coord(j.from), b = coord(j.dest);
      if (!a || !b) continue;
      traces.push({ x: [a[1], b[1]], y: [a[0], b[0]], type: "scatter", mode: "lines", line: { width: 2.4, color: "#00897B" },
        name: "巡回健診", legendgroup: "jk", showlegend: first, hoverinfo: "skip" });
      traces.push({ x: [b[1]], y: [b[0]], type: "scatter", mode: "markers", legendgroup: "jk", showlegend: false,
        marker: { size: 9, color: "#00897B", line: { color: "#fff", width: 1 } }, text: `<b>巡回健診</b><br>${j.from} → ${j.dest}<br>${j.period || ""}`, hoverinfo: "text" });
      first = false;
    }
  }
  if (opt.transfers) {
    let first = true;
    for (const t of transfers().filter((t) => t.month === m || opt.allTransfers)) {
      const a = coord(t.from), b = coord(t.post);
      if (!a || !b) continue;
      traces.push({ x: [a[1], b[1]], y: [a[0], b[0]], type: "scatter", mode: "lines", line: { width: 2, color: "#6A1B9A", dash: "dash" },
        name: "医務官の異動", legendgroup: "tr", showlegend: first, hoverinfo: "skip" });
      traces.push({ x: [b[1]], y: [b[0]], type: "scatter", mode: "markers", legendgroup: "tr", showlegend: false,
        marker: { symbol: "star", size: 13, color: "#6A1B9A" }, text: `<b>異動 ${fmtMonth(t.month)}</b><br>${t.after}：${t.from} → ${t.post}`, hoverinfo: "text" });
      first = false;
    }
  }
  if (opt.outbreak) traces.push(...outbreakTraces(outbreaksOf(m).filter((o) => o.trend !== "減少・終息")));
  if (opt.events) {
    const ev = eventsOf(m).filter((e) => e.kind !== "感染症");
    Object.entries(EVENT_STYLE).forEach(([kind, [sym, col]], k) => {
      const g = {};
      for (const e of ev.filter((e) => e.kind === kind)) (g[e.post] ||= []).push(e);
      const ps = Object.keys(g).filter(coord);
      if (!ps.length) return;
      traces.push({ type: "scatter", mode: "markers", name: kind,
        x: ps.map((p) => coord(p)[1] + 2.4 * Math.cos(k * 1.57)), y: ps.map((p) => coord(p)[0] + 1.8 * Math.sin(k * 1.57)),
        marker: { symbol: sym, size: 11, color: col, line: { color: "#fff", width: 1 } },
        text: ps.map((p) => `<b>${p}：${[...new Set(g[p].map((e) => e.keyword))].join("・")}</b><br>` + g[p].slice(0, 3).map((e) => wrap(e.snippet)).join("<br>")),
        hoverinfo: "text" });
    });
  }
  return traces;
}
// 丙表の病名を公館ごとにまとめ、地図上に「デング熱↑」のような文字ラベル付きで置く
function outbreakTraces(list, { labels = true } = {}) {
  const g = {};
  for (const o of list) if (coord(o.post)) (g[o.post] ||= []).push(o);
  const ps = Object.keys(g);
  if (!ps.length) return [];
  const rising = (p) => g[p].some((o) => o.trend === "流行・増加");
  return [{
    type: "scatter", mode: labels ? "markers+text" : "markers", name: "丙表の流行情報（↑流行・増加）",
    x: ps.map((p) => coord(p)[1]), y: ps.map((p) => coord(p)[0]),
    marker: { symbol: "cross", size: 12, color: ps.map((p) => (rising(p) ? "#B00020" : "#1565C0")), line: { color: "#fff", width: 1 } },
    text: ps.map((p) => g[p].slice(0, 3).map((o) => o.name + TREND_MARK[o.trend]).join("・") + (g[p].length > 3 ? "…" : "")),
    textposition: "top center", textfont: { size: 11, color: "#7a0016" },
    hovertext: ps.map((p) => `<b>${p}</b><br>` + g[p].map((o) => `${o.name}（${o.trend}）：${wrap(o.sentence)}`).join("<br>")),
    hoverinfo: "text",
  }];
}

function wrap(s, w = 40) { let o = ""; for (let i = 0; i < s.length; i += w) o += (i ? "<br>" : "") + s.slice(i, i + w); return o; }

// ======================================================================= 画面共通

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const main = $("#main");
let page = "import";
let drafts = [];

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3000);
}

function curMonth() { return $("#month").value; }

function refreshMonths(select) {
  const ms = months();
  const cur = select || curMonth();
  $("#month").innerHTML = ms.length ? [...ms].reverse().map((m) => `<option value="${m}">${fmtMonth(m)}</option>`).join("") : `<option value="">（データなし）</option>`;
  if (cur && ms.includes(cur)) $("#month").value = cur;
}

function plot(el, traces, layout, config = {}) {
  const base = { paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: css("--text"), family: "inherit" },
    margin: { l: 90, r: 20, t: 40, b: 40 } };
  Plotly.newPlot(el, traces, Object.assign(base, layout), Object.assign({ responsive: true, displaylogo: false }, config));
}

function needData() {
  if (!months().length) {
    main.innerHTML = `<div class="card"><p>まだデータがありません。「取り込み」から月報PDFを読み込むか、「設定」でサンプルデータを読み込んでください。</p></div>`;
    return true;
  }
  return false;
}

function render() {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  Plotly.purge && document.querySelectorAll(".js-plotly-plot").forEach((el) => Plotly.purge(el));
  ({ import: pageImport, dashboard: pageDashboard, map: pageMap, summary: pageSummary, junkai: pageJunkai,
    transfer: pageTransfer, trend: pageTrend, word: pageWord, settings: pageSettings })[page]();
}

// ======================================================================= 取り込み

let importMonth = "";
let pending = [];

function pageImport() {
  const [iy, im] = importMonth ? importMonth.split("-").map(Number) : [0, 0];
  const thisYear = new Date().getFullYear();
  main.innerHTML = `
    <h2>月報の取り込み</h2>
    <div class="card">
      <h3 style="margin-top:0">① 対象月を選ぶ</h3>
      <div class="row">
        <select id="iy"><option value="">年</option>${[thisYear - 2, thisYear - 1, thisYear, thisYear + 1].map((y) => `<option${y === iy ? " selected" : ""}>${y}</option>`).join("")}</select>
        <select id="im"><option value="">月</option>${Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}"${m === im ? " selected" : ""}>${m}月</option>`).join("")}</select>
        <span id="imsg" class="muted"></span>
      </div>
      <h3>② 月報ファイルを追加（PDF・Word）</h3>
      <div class="drop" id="drop"></div>
      <input type="file" id="files" accept=".pdf,.docx,.doc" multiple hidden>
      <div id="pending"></div>
      <h3>③ 読み取る</h3>
      <div class="row"><button class="primary" id="start">読み取り開始</button><span id="progress" class="muted"></span></div>
    </div>
    <div id="drafts"></div>
    <h2>医務官配置表</h2>
    <div class="card">
      <p class="muted">配置表（xlsx）を登録すると、未提出公館のチェック・医務官名の補完・異動検出に使います。「公館」を含む列と「氏名」列があれば読み取れます。</p>
      <div class="row">
        <label>適用する月 <input id="rmonth" size="10" value="${curMonth() || defaultMonth()}"></label>
        <input type="file" id="roster" accept=".xlsx,.xlsm">
      </div>
      <div id="rosterPreview"></div>
    </div>`;
  const drop = $("#drop"), input = $("#files");
  const ready = () => !!importMonth;
  const update = () => {
    drop.classList.toggle("disabled", !ready());
    drop.innerHTML = ready()
      ? `ここに月報ファイルをドラッグ＆ドロップ（複数可）<br><span class="muted">またはクリックして選択／PDF（ZIP形式・通常）・Word（.docx）</span>`
      : `先に ① で対象月を選んでください`;
    $("#imsg").textContent = ready() ? `${fmtMonth(importMonth)}分として読み取ります` : "";
    $("#pending").innerHTML = pending.length ? `<ul class="flist">${pending.map((f, i) => `<li>${esc(f.name)} <button data-rm="${i}" title="外す">×</button></li>`).join("")}</ul>
      <div class="row"><span class="muted">${pending.length}件</span><button id="clearPending">すべて外す</button></div>` : "";
    document.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { pending.splice(Number(b.dataset.rm), 1); update(); }));
    if ($("#clearPending")) $("#clearPending").onclick = () => { pending = []; update(); };
    $("#start").disabled = !(ready() && pending.length);
  };
  const add = (files) => {
    if (!ready()) { toast("先に対象月を選んでください"); return; }
    const ok = files.filter((f) => /\.(pdf|docx?)$/i.test(f.name));
    if (ok.length < files.length) toast("PDF・Word以外のファイルは外しました");
    for (const f of ok) if (!pending.some((p) => p.name === f.name && p.size === f.size)) pending.push(f);
    update();
  };
  const setMonth = () => {
    const y = $("#iy").value, m = $("#im").value;
    importMonth = y && m ? `${y}-${String(m).padStart(2, "0")}` : "";
    update();
  };
  $("#iy").onchange = setMonth;
  $("#im").onchange = setMonth;
  drop.onclick = () => (ready() ? input.click() : toast("先に対象月を選んでください"));
  drop.ondragover = (e) => { e.preventDefault(); if (ready()) drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); add([...e.dataTransfer.files]); };
  input.onchange = () => { add([...input.files]); input.value = ""; };
  $("#start").onclick = () => readFiles();
  $("#roster").onchange = readRosterFile;
  update();
  renderDrafts();
}

function defaultMonth() {
  const d = new Date(); d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function readFiles() {
  const files = pending.slice();
  if (!importMonth || !files.length) return;
  $("#start").disabled = true;
  drafts = [];
  for (let i = 0; i < files.length; i++) {
    $("#progress").textContent = `読み取り中… ${i + 1} / ${files.length}　${files[i].name}`;
    let r;
    try { r = await parseReport(files[i]); }
    catch (e) {
      r = { filename: files[i].name, month: null, post: null, officer: null, staff: null, family: null, other: null, total: null,
        diseases: [], hei: "", warnings: ["読み込み失敗: " + e.message], images: [] };
    }
    // 対象月は ① で選んだ月に統一する。本文の年月と違えば知らせる
    if (r.month && r.month !== importMonth) r.warnings.push(`本文は${fmtMonth(r.month)}分の記載（${fmtMonth(importMonth)}として取り込みます）`);
    r.month = importMonth;
    drafts.push(r);
  }
  pending = [];
  $("#pending").innerHTML = "";
  $("#progress").textContent = `${files.length}件を読み取りました。下の表で確認して「保存する」を押してください。`;
  renderDrafts();
  $("#drafts").scrollIntoView({ behavior: "smooth" });
}

function renderDrafts() {
  const el = $("#drafts");
  if (!drafts.length) { el.innerHTML = ""; return; }
  const opts = (sel) => `<option value=""></option>` + POST_NAMES.map((p) => `<option${p === sel ? " selected" : ""}>${esc(p)}</option>`).join("");
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">読み取り結果の確認</h3>
      <p class="muted">誤読があれば直接修正してください。<span class="badge warn">要確認</span> の行は特に確認を。</p>
      <div class="table-wrap"><table>
        <thead><tr><th></th><th>ファイル</th><th>対象月</th><th>公館</th><th>医務官</th><th class="num">職員</th><th class="num">家族</th><th class="num">その他</th><th class="num">計</th><th>注意</th></tr></thead>
        <tbody>${drafts.map((d, i) => `
          <tr data-i="${i}">
            <td>${d.warnings.length ? '<span class="badge warn">要確認</span>' : '<span class="badge">OK</span>'}</td>
            <td>${esc(d.filename)}</td>
            <td><input data-f="month" value="${esc(d.month)}" size="8"></td>
            <td><select data-f="post">${opts(d.post)}</select></td>
            <td><input data-f="officer" value="${esc(d.officer || "")}" size="10"></td>
            ${["staff", "family", "other", "total"].map((f) => `<td class="num"><input type="number" min="0" data-f="${f}" value="${d[f] ?? ""}"></td>`).join("")}
            <td class="muted">${esc(d.warnings.join(" / "))}</td>
          </tr>`).join("")}
        </tbody></table></div>
      ${drafts.map((d, i) => `
        <details data-i="${i}">
          <summary>${d.warnings.length ? "⚠ " : ""}${esc(d.filename)} の詳細（乙表 ${d.diseases.length}件・丙表）</summary>
          ${d.images.length ? `<div class="warnbox">OCRテキストのないページがあります。画像を見て上の表や下の欄を補ってください。</div>` + d.images.map(([n, src]) => `<img class="pageimg" src="${src}" alt="p.${n}">`).join("") : ""}
          <div class="grid2">
            <label>乙表（1行に「病名(件数)」）<textarea data-f="diseases" rows="10">${esc(d.diseases.map((x) => `${x.name}(${x.count})`).join("\n"))}</textarea></label>
            <label>丙表（報告事項）<textarea data-f="hei" rows="10">${esc(d.hei)}</textarea></label>
          </div>
        </details>`).join("")}
      <div class="row"><button class="primary" id="saveDrafts">保存する</button><button id="clearDrafts">取り消し</button></div>
    </div>`;
  $("#saveDrafts").onclick = saveDrafts;
  $("#clearDrafts").onclick = () => { drafts = []; renderDrafts(); };
}

async function saveDrafts() {
  const skipped = [];
  let saved = 0, lastMonth = null;
  document.querySelectorAll("#drafts tr[data-i]").forEach((tr) => {
    const d = drafts[tr.dataset.i];
    tr.querySelectorAll("[data-f]").forEach((inp) => {
      const f = inp.dataset.f;
      d[f] = ["staff", "family", "other", "total"].includes(f) ? (inp.value === "" ? null : Number(inp.value)) : inp.value.trim();
    });
  });
  document.querySelectorAll("#drafts details[data-i]").forEach((det) => {
    const d = drafts[det.dataset.i];
    d.hei = $("[data-f=hei]", det).value;
    d.diseases = $("[data-f=diseases]", det).value.split("\n").map((l) => nfkc(l).trim().match(/^(.+?)\s*[(,\s]\s*(\d+)\)?$/))
      .filter(Boolean).map((m) => ({ name: m[1].trim(), count: Number(m[2]) }));
  });
  for (const d of drafts) {
    if (!d.post) { skipped.push(d.filename); continue; }
    const rec = {
      month: d.month, post: d.post, region: regionOf(d.post), officer: d.officer || "", staff: d.staff, family: d.family,
      other: d.other, total: d.total, filename: d.filename, hei: d.hei, diseases: d.diseases, events: detectEvents(d.hei), summary: "",
    };
    state.reports[`${d.month}|${d.post}`] = rec;
    // 巡回健診はこの公館の丙表由来のものだけ差し替える
    const js = (state.junkai[d.month] || []).filter((j) => j.src !== d.post);
    state.junkai[d.month] = js.concat(detectJunkai(d.hei, d.post));
    saved++; lastMonth = d.month;
  }
  for (const d of drafts) if (d.post && state.reports[`${d.month}|${d.post}`]) state.reports[`${d.month}|${d.post}`].summary = ruleSummary(d.month, d.post);
  await saveState();
  drafts = [];
  refreshMonths(lastMonth);
  render();
  toast(`${saved}件を保存しました` + (skipped.length ? `（公館未選択のため未保存: ${skipped.join("、")}）` : ""));
}

async function readRosterFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  const box = $("#rosterPreview");
  try {
    const rows = await parseRoster(f);
    const unknown = rows.filter((r) => !INFO[r.post]).map((r) => r.post);
    box.innerHTML = `<p>${rows.length}公館（うち配置あり ${rows.filter((r) => r.staffed).length}）</p>
      ${unknown.length ? `<div class="warnbox">公館マスタにない名前: ${esc(unknown.join("、"))}（地図には表示されません）</div>` : ""}
      <div class="table-wrap" style="max-height:300px"><table><thead><tr><th>公館</th><th>医務官</th><th>備考</th><th>配置</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.post)}</td><td>${esc(r.officer)}</td><td>${esc(r.note)}</td><td>${r.staffed ? "○" : "―"}</td></tr>`).join("")}
      </tbody></table></div><div class="row"><button class="primary" id="saveRoster">配置表を保存</button></div>`;
    $("#saveRoster").onclick = async () => {
      const m = $("#rmonth").value.trim();
      state.rosters[m] = rows;
      await saveState();
      refreshMonths(curMonth() || m);
      toast(`${fmtMonth(m)}の配置表として保存しました`);
    };
  } catch (err) {
    box.innerHTML = `<div class="warnbox">配置表を読み取れませんでした: ${esc(err.message)}</div>`;
  }
}

// ======================================================================= ダッシュボード

function pageDashboard() {
  if (needData()) return;
  const m = curMonth(), rep = reportsOf(m), pr = reportsOf(prevMonth(m)), dis = diseasesOf(m), miss = missingPosts(m), ev = eventsOf(m);
  const tot = sum(rep, (r) => r.total), ptot = sum(pr, (r) => r.total);
  const delta = (a, b) => (pr.length ? `<div class="delta ${a - b >= 0 ? "up" : "down"}">前月比 ${a - b >= 0 ? "+" : ""}${a - b}</div>` : "");
  main.innerHTML = `
    <h2>${fmtMonth(m)} ダッシュボード</h2>
    <div class="kpis">
      <div class="kpi"><div class="label">提出公館</div><div class="value">${rep.length}</div>${delta(rep.length, pr.length)}</div>
      <div class="kpi"><div class="label">受診者数（延べ）</div><div class="value">${tot}</div>${delta(tot, ptot)}</div>
      <div class="kpi"><div class="label">未提出公館</div><div class="value">${miss ? miss.length : "―"}</div>${miss ? "" : '<div class="delta muted">配置表未登録</div>'}</div>
      <div class="kpi"><div class="label">感染症の報告（公館数）</div><div class="value">${new Set(ev.filter((e) => e.kind === "感染症").map((e) => e.post)).size}</div></div>
    </div>
    <div class="grid2"><div class="card"><div id="p1" class="plot"></div></div><div class="card"><div id="p2" class="plot"></div></div></div>
    <div class="card"><h3 style="margin-top:0">公館別 受診者数</h3><div class="table-wrap">${visitTable(m)}</div></div>
    <div class="grid2">
      <div class="card"><h3 style="margin-top:0">未提出公館</h3>${
        !miss ? '<p class="muted">配置表が未登録のため判定できません（取り込み→医務官配置表）。</p>'
        : !miss.length ? '<div class="okbox">配置公館はすべて提出済みです。</div>'
        : `<table><thead><tr><th>地域</th><th>公館</th><th>医務官（配置表）</th><th>備考</th></tr></thead><tbody>${miss.map((x) => `<tr><td>${esc(x.region)}</td><td>${esc(x.post)}</td><td>${esc(x.officer)}</td><td>${esc(x.note)}</td></tr>`).join("")}</tbody></table>`}
      </div>
      <div class="card"><h3 style="margin-top:0">診断名トップ10（検診・予防接種を除く）</h3>${topTable(dis)}</div>
    </div>`;
  const regs = REGIONS.filter((r) => rep.some((x) => x.region === r));
  plot("p1", [["staff", "職員", "#4472C4"], ["family", "家族", "#ED7D31"], ["other", "その他", "#A5A5A5"]].map(([f, name, color]) => ({
    type: "bar", orientation: "h", name, marker: { color }, y: regs, x: regs.map((g) => sum(rep.filter((r) => r.region === g), (r) => r[f])),
  })), { title: "地域別 受診者数", barmode: "stack", yaxis: { autorange: "reversed" }, height: 360 });
  const cats = CATEGORIES.filter((c) => c !== Z && dis.some((d) => d.category === c));
  plot("p2", cats.map((c) => ({
    type: "bar", orientation: "h", name: shortCat(c), marker: { color: D.colors[c] }, y: regs,
    x: regs.map((g) => sum(dis.filter((d) => d.region === g && d.category === c), (d) => d.count)),
  })), { title: "地域別 疾病分類（検診・予防接種を除く）", barmode: "stack", yaxis: { autorange: "reversed" }, height: 360 });
}

function visitTable(m) {
  const rep = reportsOf(m), miss = missingPosts(m) || [];
  let html = `<table><thead><tr><th>地域</th><th>公館</th><th>医務官</th><th class="num">職員</th><th class="num">家族</th><th class="num">その他</th><th class="num">計</th><th class="num">前月比</th></tr></thead><tbody>`;
  for (const g of [...REGIONS, "未分類"]) {
    const rs = rep.filter((r) => r.region === g), ms = miss.filter((x) => x.region === g);
    if (!rs.length && !ms.length) continue;
    for (const r of rs) {
      const p = getReport(prevMonth(m), r.post);
      const d = p && p.total !== null && r.total !== null ? r.total - p.total : null;
      html += `<tr><td>${esc(g)}</td><td>${esc(r.post)}</td><td>${esc(r.officer)}</td><td class="num">${n(r.staff)}</td><td class="num">${n(r.family)}</td><td class="num">${n(r.other)}</td><td class="num">${n(r.total)}</td><td class="num">${d === null ? "" : (d >= 0 ? "+" : "") + d}</td></tr>`;
    }
    for (const x of ms) html += `<tr class="missing"><td>${esc(g)}</td><td>${esc(x.post)}</td><td>${esc(x.officer)}</td><td colspan="5">未提出</td></tr>`;
    html += `<tr class="sub"><td></td><td>${esc(g)} 小計</td><td></td>${["staff", "family", "other", "total"].map((f) => `<td class="num">${sum(rs, (r) => r[f])}</td>`).join("")}<td></td></tr>`;
  }
  html += `<tr class="sub"><td></td><td>総計</td><td></td>${["staff", "family", "other", "total"].map((f) => `<td class="num">${sum(rep, (r) => r[f])}</td>`).join("")}<td></td></tr></tbody></table>`;
  return html;
}

function topDiseases(dis, k = 10) {
  const g = {};
  for (const d of dis) if (d.category !== Z) { const o = (g[d.name] ||= { c: 0, posts: new Set() }); o.c += d.count; o.posts.add(d.post); }
  return Object.entries(g).sort((a, b) => b[1].c - a[1].c).slice(0, k).map(([name, o]) => ({ name, count: o.c, posts: o.posts.size }));
}
function topTable(dis) {
  const t = topDiseases(dis);
  if (!t.length) return '<p class="muted">乙表データなし</p>';
  return `<table><thead><tr><th>#</th><th>診断名</th><th>分類</th><th class="num">件数</th><th class="num">公館数</th></tr></thead><tbody>${
    t.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}</td><td>${esc(shortCat(classify(x.name)))}</td><td class="num">${x.count}</td><td class="num">${x.posts}</td></tr>`).join("")}</tbody></table>`;
}

// ======================================================================= 世界地図

const mapOpt = { disease: true, visits: true, outbreak: true, events: true, junkai: true, transfers: true };
async function pageMap() {
  if (needData()) return;
  const m = curMonth();
  await loadGeo();
  const labels = { disease: "疾病分類（乙表）", visits: "受診者数", outbreak: "丙表の流行情報", events: "災害・治安等", junkai: "巡回健診", transfers: "医務官の異動" };
  const dis = diseasesOf(m);
  const cats = CATEGORIES.filter((c) => c !== Z && dis.some((d) => d.category === c));
  main.innerHTML = `
    <h2>世界地図（${fmtMonth(m)}）</h2>
    <div class="card">
      <div class="row">${Object.entries(labels).map(([k, v]) => `<label><input type="checkbox" data-k="${k}"${mapOpt[k] ? " checked" : ""}> ${v}</label>`).join("")}</div>
      <div id="wmap" class="plot map"></div>
      <p class="muted">国の色＝その国で最も多い疾病分類（健診・予防接種は除外）。実患${MIN_FULL}件未満の国は同じ色を薄く表示。✚の横の文字は丙表に出てくる病名（↑＝流行・増加の記述あり）。記号にマウスを重ねる（スマホはタップ）と丙表の記述が出ます。ドラッグで移動、ホイールで拡大できます。</p>
    </div>
    <div class="card">
      <h3 style="margin-top:0">丙表から読み取った流行中の病気</h3>
      <p class="muted">各公館の報告事項（丙表）の文章から病名を拾い、「流行・増加」「減少・終息」「言及のみ」に分けて表示します。</p>
      <div class="row">
        <select id="obname"></select>
        <label><input type="checkbox" id="obdown"> 減少・終息の記述も表示</label>
        <label><input type="checkbox" id="oball"> 全期間を合算</label>
      </div>
      <div id="obmap" class="plot map"></div>
      <div id="obtable" class="table-wrap"></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">疾病分類別に見る</h3>
      ${cats.length ? `<select id="cat">${cats.map((c) => `<option value="${esc(c)}">${esc(shortCat(c))}</option>`).join("")}</select><div id="cmap" class="plot map"></div>` : '<p class="muted">乙表データなし</p>'}
    </div>
    <div class="card">
      <h3 style="margin-top:0">病名で見る</h3>
      <p class="muted">一覧から病名を選ぶか、右の欄に入力して Enter を押すと、乙表でその病名を報告した国を件数の濃さで塗り、丙表（報告事項）で触れている公館に ✚ を付けます。</p>
      <div class="row">
        <select id="dsel"></select>
        <input id="dq" placeholder="自由入力（例: デング）" size="20">
        <label><input type="checkbox" id="dpart" checked> 部分一致（「デング」でデング熱なども含む）</label>
        <label><input type="checkbox" id="dall"> 全期間を合算</label>
      </div>
      <div id="dmap" class="plot map"></div>
      <div id="dtable" class="table-wrap"></div>
    </div>
    <div class="card"><h3 style="margin-top:0">丙表から検出した出来事</h3>${eventTable(m)}</div>`;
  const draw = () => Plotly.react("wmap", worldTraces(m, mapOpt), mapLayout(560), { responsive: true, displaylogo: false, scrollZoom: true });
  setupOutbreakMap(m);
  setupDiseaseNameMap(m);
  draw();
  document.querySelectorAll("[data-k]").forEach((c) => (c.onchange = () => { mapOpt[c.dataset.k] = c.checked; draw(); }));
  if (cats.length) {
    const drawCat = () => {
      const c = $("#cat").value, by = {};
      for (const d of dis.filter((d) => d.category === c)) {
        const iso = INFO[d.post] && INFO[d.post].iso3;
        if (!iso) continue;
        const o = (by[iso] ||= { v: 0, posts: new Set(), names: new Set() });
        o.v += d.count; o.posts.add(d.post); o.names.add(d.name);
      }
      const vmax = Math.max(1, ...Object.values(by).map((o) => o.v));
      const traces = baseTraces();
      for (const [iso, o] of Object.entries(by)) {
        const t = countryTrace(iso, blend("#C00000", 0.2 + 0.8 * o.v / vmax), "", `<b>${[...o.posts].join("・")}</b><br>${o.v}件<br>${[...o.names].join("、")}`, false);
        if (t) traces.push(t);
      }
      Plotly.react("cmap", traces, mapLayout(480), { responsive: true, displaylogo: false, scrollZoom: true });
    };
    $("#cat").onchange = drawCat;
    drawCat();
  }
}

let outbreakName = "";
function setupOutbreakMap(m) {
  const fill = () => {
    const list = outbreaksOf($("#oball").checked ? null : m);
    const g = {};
    for (const o of list) { const x = (g[o.name] ||= { up: new Set(), all: new Set() }); x.all.add(o.post); if (o.trend === "流行・増加") x.up.add(o.post); }
    const names = Object.entries(g).sort((a, b) => b[1].up.size - a[1].up.size || b[1].all.size - a[1].all.size);
    $("#obname").innerHTML = `<option value="">すべての病気（${names.length}種類）</option>` +
      names.map(([k, x]) => `<option value="${esc(k)}"${k === outbreakName ? " selected" : ""}>${esc(k)}（流行・増加 ${x.up.size}／言及 ${x.all.size}公館）</option>`).join("");
  };
  const draw = () => {
    outbreakName = $("#obname").value;
    const all = $("#oball").checked, down = $("#obdown").checked;
    let list = outbreaksOf(all ? null : m).filter((o) => (!outbreakName || o.name === outbreakName) && (down || o.trend !== "減少・終息"));
    const traces = baseTraces();
    // 流行・増加の記述がある国を薄く塗って目立たせる
    const isos = new Set(list.filter((o) => o.trend === "流行・増加").map((o) => INFO[o.post] && INFO[o.post].iso3).filter(Boolean));
    for (const iso of isos) { const t = countryTrace(iso, "#f4b6b6", "流行・増加の報告がある国", "", false); if (t) traces.push(t); }
    if (isos.size) traces.push({ type: "scatter", mode: "markers", name: "流行・増加の報告がある国", x: [null], y: [null], marker: { symbol: "square", size: 12, color: "#f4b6b6" } });
    traces.push(...outbreakTraces(list));
    if (down) {
      const dn = list.filter((o) => o.trend === "減少・終息" && coord(o.post));
      if (dn.length) traces.push({ type: "scatter", mode: "markers", name: "減少・終息", x: dn.map((o) => coord(o.post)[1] + 1.5), y: dn.map((o) => coord(o.post)[0] - 1.5),
        marker: { symbol: "triangle-down", size: 10, color: "#2e7d32" }, text: dn.map((o) => `<b>${o.post}</b><br>${o.name}（減少・終息）：${wrap(o.sentence)}`), hoverinfo: "text" });
    }
    Plotly.react("obmap", traces, mapLayout(480), { responsive: true, displaylogo: false, scrollZoom: true });
    const order = { "流行・増加": 0, "言及": 1, "減少・終息": 2 };
    list.sort((a, b) => order[a.trend] - order[b.trend] || a.name.localeCompare(b.name, "ja"));
    $("#obtable").innerHTML = list.length ? `<table><thead><tr><th>病名</th><th>状況</th><th>公館</th><th>地域</th>${all ? "<th>月</th>" : ""}<th>丙表の記述</th></tr></thead><tbody>${
      list.map((o) => `<tr><td>${esc(o.name)}</td><td>${o.trend === "流行・増加" ? '<span class="badge warn">流行・増加</span>' : esc(o.trend)}</td><td>${esc(o.post)}</td><td>${esc(o.region)}</td>${all ? `<td>${fmtMonth(o.month)}</td>` : ""}<td>${esc(o.sentence)}</td></tr>`).join("")}</tbody></table>`
      : '<p class="muted">丙表に病名の記述は見つかりませんでした。</p>';
  };
  fill();
  $("#obname").onchange = draw;
  $("#obdown").onchange = draw;
  $("#oball").onchange = () => { fill(); draw(); };
  draw();
}

let diseaseQuery = "";
function setupDiseaseNameMap(m) {
  const fill = () => {
    // 候補: 乙表の病名（件数順）＋丙表で使う感染症キーワード
    const all = $("#dall").checked;
    const cnt = {};
    for (const d of diseasesOf(all ? null : m)) cnt[d.name] = (cnt[d.name] || 0) + d.count;
    const names = Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, `${v}件`]);
    // 丙表に出てくる病名（乙表にないもの）も候補に加える
    const hei = {};
    for (const o of outbreaksOf(all ? null : m)) hei[o.name] = (hei[o.name] || 0) + 1;
    for (const [k, v] of Object.entries(hei).sort((a, b) => b[1] - a[1])) if (!cnt[k]) names.push([k, `丙表 ${v}公館`]);
    $("#dsel").innerHTML = `<option value="">病名を選ぶ（${names.length}件）</option>` +
      names.map(([k, label]) => `<option value="${esc(k)}"${k === diseaseQuery ? " selected" : ""}>${esc(k)}（${esc(label)}）</option>`).join("");
    if (!diseaseQuery && names.length) { diseaseQuery = names[0][0]; $("#dsel").value = diseaseQuery; }
    $("#dq").value = diseaseQuery;
  };
  const draw = () => {
    diseaseQuery = $("#dq").value.trim();
    const q = nfkc(diseaseQuery), part = $("#dpart").checked, all = $("#dall").checked;
    const traces = baseTraces();
    if (!q) { Plotly.react("dmap", traces, mapLayout(480), { responsive: true, displaylogo: false }); $("#dtable").innerHTML = ""; return; }
    const hit = (name) => (part ? nfkc(name).includes(q) : nfkc(name) === q);
    const rows = {};
    const row = (r) => (rows[r.post] ||= { post: r.post, region: r.region, count: 0, names: {}, mentions: [] });
    for (const d of diseasesOf(all ? null : m)) if (hit(d.name)) { const o = row(d); o.count += d.count; o.names[d.name] = (o.names[d.name] || 0) + d.count; }
    for (const r of reportsOf(all ? null : m))
      for (const s of sentences(r.hei)) if (nfkc(s).includes(q)) row(r).mentions.push((all ? `[${fmtMonth(r.month)}] ` : "") + s);
    const list = Object.values(rows);
    // 国単位で合算して塗る（総領事館は所在国にまとめる）
    const byIso = {};
    for (const o of list) {
      const iso = INFO[o.post] && INFO[o.post].iso3;
      if (!iso || !o.count) continue;
      const c = (byIso[iso] ||= { v: 0, posts: [] });
      c.v += o.count; c.posts.push(`${o.post}: ${Object.entries(o.names).map(([k, v]) => `${k}(${v})`).join("、")}`);
    }
    const vmax = Math.max(1, ...Object.values(byIso).map((c) => c.v));
    for (const [iso, c] of Object.entries(byIso)) {
      const t = countryTrace(iso, blend("#C00000", 0.25 + 0.75 * c.v / vmax), "乙表の件数", `<b>${c.v}件</b><br>${c.posts.join("<br>")}`, false);
      if (t) traces.push(t);
    }
    const men = list.filter((o) => o.mentions.length && coord(o.post));
    if (men.length) traces.push({ type: "scatter", mode: "markers", name: "丙表で言及", x: men.map((o) => coord(o.post)[1]), y: men.map((o) => coord(o.post)[0]),
      marker: { symbol: "cross", size: 13, color: "#1565C0", line: { color: "#fff", width: 1 } },
      text: men.map((o) => `<b>${o.post}</b><br>` + o.mentions.slice(0, 3).map((s) => wrap(s)).join("<br>")), hoverinfo: "text" });
    if (Object.keys(byIso).length) traces.push({ type: "scatter", mode: "markers", name: "乙表で報告（濃いほど多い）", x: [null], y: [null], marker: { symbol: "square", size: 12, color: "#C00000" } });
    Plotly.react("dmap", traces, mapLayout(480), { responsive: true, displaylogo: false, scrollZoom: true });
    list.sort((a, b) => b.count - a.count || b.mentions.length - a.mentions.length);
    $("#dtable").innerHTML = list.length ? `<table><thead><tr><th>公館</th><th>地域</th><th class="num">乙表の件数</th><th>病名の内訳</th><th>丙表の記述</th></tr></thead><tbody>${
      list.map((o) => `<tr><td>${esc(o.post)}</td><td>${esc(o.region)}</td><td class="num">${o.count || ""}</td><td>${esc(Object.entries(o.names).map(([k, v]) => `${k}(${v})`).join("、"))}</td><td>${o.mentions.slice(0, 3).map(esc).join("<br>")}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">「${esc(diseaseQuery)}」の報告はありません。</p>`;
  };
  fill();
  $("#dsel").onchange = () => { $("#dq").value = $("#dsel").value; draw(); };
  $("#dq").onchange = draw;
  $("#dq").onkeydown = (e) => { if (e.key === "Enter") draw(); };
  $("#dpart").onchange = draw;
  $("#dall").onchange = () => { fill(); draw(); };
  draw();
}

function eventTable(m) {
  const ev = eventsOf(m);
  if (!ev.length) return '<p class="muted">なし</p>';
  return `<div class="table-wrap"><table><thead><tr><th>公館</th><th>種別</th><th>キーワード</th><th>記述</th></tr></thead><tbody>${
    ev.map((e) => `<tr><td>${esc(e.post)}</td><td>${esc(e.kind)}</td><td>${esc(e.keyword)}</td><td>${esc(e.snippet)}</td></tr>`).join("")}</tbody></table></div>`;
}

// ======================================================================= 5行サマリー

function pageSummary() {
  if (needData()) return;
  const m = curMonth();
  main.innerHTML = `
    <h2>公館別 5行サマリー（${fmtMonth(m)}）</h2>
    <div class="row">
      <label>地域 <select id="sreg"><option value="">すべて</option>${REGIONS.map((r) => `<option>${r}</option>`).join("")}</select></label>
      <button id="regenAll">全公館を自動作成し直す</button>
    </div>
    <p class="muted">受診者数／主な疾病／医療・感染症／邦人保護・緊急対応／その他 の5行を月報データから自動で作成します。自由に書き換えて保存できます。</p>
    <div id="slist"></div>`;
  const draw = () => {
    const g = $("#sreg").value;
    $("#slist").innerHTML = reportsOf(m).filter((r) => !g || r.region === g).map((r) => `
      <div class="card sumcard" data-post="${esc(r.post)}">
        <h4>${esc(r.post)} <span class="muted">${esc(r.region)}　医務官：${esc(r.officer || "―")}　受診者数：${n(r.total)}</span></h4>
        <textarea rows="5">${esc(r.summary || ruleSummary(m, r.post))}</textarea>
        <div class="row"><button class="primary" data-act="save">保存</button><button data-act="regen">自動作成し直す</button></div>
        <details><summary>丙表の原文</summary><pre style="white-space:pre-wrap">${esc(r.hei || "（なし）")}</pre></details>
      </div>`).join("");
    document.querySelectorAll(".sumcard").forEach((card) => {
      const post = card.dataset.post, ta = $("textarea", card);
      $("[data-act=save]", card).onclick = async () => {
        getReport(m, post).summary = ta.value.split("\n").slice(0, 5).join("\n");
        await saveState(); toast(`${post} を保存しました`);
      };
      $("[data-act=regen]", card).onclick = async () => {
        ta.value = getReport(m, post).summary = ruleSummary(m, post);
        await saveState();
      };
    });
  };
  $("#sreg").onchange = draw;
  $("#regenAll").onclick = async () => {
    if (!confirm("手で直したサマリーも上書きされます。よろしいですか？")) return;
    for (const r of reportsOf(m)) r.summary = ruleSummary(m, r.post);
    await saveState(); draw();
  };
  draw();
}

// ======================================================================= 巡回健診

async function pageJunkai() {
  if (needData()) return;
  const m = curMonth();
  await loadGeo();
  const opts = (sel) => `<option value=""></option>` + ALL_PLACES.map((p) => `<option${p === sel ? " selected" : ""}>${esc(p)}</option>`).join("");
  const rows = junkaiOf(m);
  main.innerHTML = `
    <h2>巡回健診（${fmtMonth(m)}）</h2>
    <div class="card">
      <p class="muted">丙表の「巡回」を含む記述から自動抽出しています。行先・期間の誤りは直して保存してください。</p>
      <div class="table-wrap"><table id="jt"><thead><tr><th>実施公館</th><th>巡回先</th><th>期間</th><th>記載</th><th></th></tr></thead><tbody>
      ${rows.map((j) => `<tr data-src="${esc(j.src || "")}"><td><select data-f="from">${opts(j.from)}</select></td><td><select data-f="dest">${opts(j.dest)}</select></td>
        <td><input data-f="period" value="${esc(j.period)}" size="10"></td><td><input data-f="note" value="${esc(j.note)}" style="width:100%"></td><td><button data-del>削除</button></td></tr>`).join("")}
      </tbody></table></div>
      <div class="row"><button id="addJ">行を追加</button><button class="primary" id="saveJ">保存</button></div>
      <div id="jmap" class="plot map"></div>
    </div>
    <div class="card"><h3 style="margin-top:0">これまでの巡回健診</h3>${junkaiHistory()}</div>`;
  const bindDel = () => document.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => b.closest("tr").remove()));
  bindDel();
  $("#addJ").onclick = () => {
    $("#jt tbody").insertAdjacentHTML("beforeend", `<tr data-src=""><td><select data-f="from">${opts("")}</select></td><td><select data-f="dest">${opts("")}</select></td><td><input data-f="period" size="10"></td><td><input data-f="note" style="width:100%"></td><td><button data-del>削除</button></td></tr>`);
    bindDel();
  };
  $("#saveJ").onclick = async () => {
    state.junkai[m] = [...document.querySelectorAll("#jt tbody tr")].map((tr) => {
      const o = { src: tr.dataset.src || "" };
      tr.querySelectorAll("[data-f]").forEach((i) => (o[i.dataset.f] = i.value.trim()));
      return o;
    }).filter((j) => j.from);
    await saveState(); toast("保存しました"); render();
  };
  Plotly.newPlot("jmap", worldTraces(m, { junkai: true }), mapLayout(480), { responsive: true, displaylogo: false, scrollZoom: true });
}

function junkaiHistory() {
  const g = {};
  for (const j of junkaiOf()) { const k = `${j.from}→${j.dest || "?"}`; const o = (g[k] ||= { c: 0, last: "" }); o.c++; if (j.month > o.last) o.last = j.month; }
  if (!Object.keys(g).length) return '<p class="muted">なし</p>';
  return `<table><thead><tr><th>実施公館→巡回先</th><th class="num">回数</th><th>直近</th></tr></thead><tbody>${
    Object.entries(g).map(([k, o]) => `<tr><td>${esc(k)}</td><td class="num">${o.c}</td><td>${fmtMonth(o.last)}</td></tr>`).join("")}</tbody></table>`;
}

// ======================================================================= 医務官の異動

async function pageTransfer() {
  if (needData()) return;
  await loadGeo();
  const tr = transfers(), ot = officerTable(), ms = Object.keys(ot).sort();
  const posts = [...new Set(Object.values(ot).flatMap((o) => Object.keys(o)))].sort((a, b) => a.localeCompare(b, "ja"));
  main.innerHTML = `
    <h2>医務官の異動</h2>
    <div class="card">
      <p class="muted">月報ヘッダーの医務官名（無い月は配置表）を月ごとに比べて交代を検出します。同じ氏名が別公館に現れた場合は前任地からの異動として矢印を引きます。</p>
      ${tr.length ? `<table><thead><tr><th>月</th><th>公館</th><th>前任</th><th>後任</th><th>後任の前任地</th></tr></thead><tbody>${
        tr.map((t) => `<tr><td>${fmtMonth(t.month)}</td><td>${esc(t.post)}</td><td>${esc(t.before)}</td><td>${esc(t.after)}</td><td>${esc(t.from || "")}</td></tr>`).join("")}</tbody></table>
        <div id="tmap" class="plot map"></div>` : '<p class="muted">2か月以上のデータが揃うと交代を検出します。</p>'}
    </div>
    <div class="card"><h3 style="margin-top:0">公館×月 医務官一覧</h3><div class="table-wrap"><table><thead><tr><th>公館</th>${ms.map((m) => `<th>${fmtMonth(m)}</th>`).join("")}</tr></thead><tbody>${
      posts.map((p) => `<tr><td>${esc(p)}</td>${ms.map((m) => `<td>${esc((ot[m] || {})[p] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;
  if (tr.length) Plotly.newPlot("tmap", worldTraces(null, { transfers: true, allTransfers: true }), mapLayout(480), { responsive: true, displaylogo: false, scrollZoom: true });
}

// ======================================================================= 推移

function pageTrend() {
  if (needData()) return;
  const all = reportsOf();
  main.innerHTML = `
    <h2>月ごとの推移</h2>
    <div class="row">
      <label>地域 <select id="treg"><option value="">すべて</option>${REGIONS.map((r) => `<option>${r}</option>`).join("")}</select></label>
      <label>公館 <select id="tpost"></select></label>
    </div>
    <div class="card"><div id="t1" class="plot"></div></div>
    <div class="card"><div id="t2" class="plot"></div></div>
    <div class="card"><h3 style="margin-top:0">公館×月 受診者数</h3><div class="table-wrap" id="tpiv"></div></div>`;
  const fillPosts = () => {
    const g = $("#treg").value;
    const ps = [...new Set(all.filter((r) => !g || r.region === g).map((r) => r.post))].sort((a, b) => a.localeCompare(b, "ja"));
    $("#tpost").innerHTML = `<option value="">すべて</option>` + ps.map((p) => `<option>${esc(p)}</option>`).join("");
  };
  const draw = () => {
    const g = $("#treg").value, p = $("#tpost").value;
    const rs = all.filter((r) => (!g || r.region === g) && (!p || r.post === p));
    const ms = [...new Set(all.map((r) => r.month))].sort();
    const xs = ms.map(fmtMonth);
    const traces = [["staff", "職員"], ["family", "家族"], ["other", "その他"], ["total", "計"]].map(([f, name]) => ({
      type: "scatter", mode: "lines+markers", name, x: xs, y: ms.map((m) => sum(rs.filter((r) => r.month === m), (r) => r[f])),
      line: f === "total" ? { width: 3 } : {} }));
    if (!g && !p) for (const reg of REGIONS) traces.push({ type: "scatter", mode: "lines+markers", name: reg, visible: "legendonly", x: xs,
      y: ms.map((m) => sum(rs.filter((r) => r.month === m && r.region === reg), (r) => r.total)) });
    plot("t1", traces, { title: "受診者数の推移（凡例クリックで地域別も表示）", height: 380, margin: { l: 50, r: 20, t: 40, b: 40 } });
    const dis = diseasesOf().filter((d) => (!g || d.region === g) && (!p || d.post === p) && d.category !== Z);
    const cats = CATEGORIES.filter((c) => dis.some((d) => d.category === c));
    plot("t2", cats.map((c) => ({ type: "bar", name: shortCat(c), marker: { color: D.colors[c] }, x: xs,
      y: ms.map((m) => sum(dis.filter((d) => d.month === m && d.category === c), (d) => d.count)) })),
      { title: "疾病分類の推移（検診・予防接種を除く）", barmode: "stack", height: 380, margin: { l: 50, r: 20, t: 40, b: 40 } });
    const ps = [...new Set(rs.map((r) => r.post))];
    $("#tpiv").innerHTML = `<table><thead><tr><th>地域</th><th>公館</th>${xs.map((x) => `<th class="num">${x}</th>`).join("")}</tr></thead><tbody>${
      ps.map((pp) => `<tr><td>${esc(regionOf(pp))}</td><td>${esc(pp)}</td>${ms.map((m) => { const r = getReport(m, pp); return `<td class="num">${r ? n(r.total) : ""}</td>`; }).join("")}</tr>`).join("")}</tbody></table>`;
  };
  $("#treg").onchange = () => { fillPosts(); draw(); };
  $("#tpost").onchange = draw;
  fillPosts(); draw();
}

// ======================================================================= Word レポート

function pageWord() {
  if (needData()) return;
  const m = curMonth();
  main.innerHTML = `
    <h2>統合Wordレポート（${fmtMonth(m)}）</h2>
    <div class="card">
      <p>表紙・目次・全体概況・世界地図・受診者数統計・疾病分類統計・巡回健診／医務官の異動・公館別5行サマリーを含む Word ファイルを作成します。</p>
      <div class="row"><label><input type="checkbox" id="wmapOn" checked> 世界地図を含める</label></div>
      <div class="row"><button class="primary" id="mk">作成してダウンロード</button><span id="wst" class="muted"></span></div>
    </div>`;
  $("#mk").onclick = async () => {
    $("#mk").disabled = true; $("#wst").textContent = "作成中…";
    try {
      const blob = await buildDocx(m, $("#wmapOn").checked);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `医務官月報統合レポート_${m.replace("-", "")}.docx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      $("#wst").textContent = "ダウンロードしました";
    } catch (e) {
      $("#wst").textContent = "作成に失敗しました: " + e.message;
    } finally { $("#mk").disabled = false; }
  };
}

async function figPng(traces, layout, width, height) {
  const div = document.createElement("div");
  div.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px`;
  document.body.appendChild(div);
  const lay = Object.assign({ width, height, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff", font: { color: "#1c2430", size: 13 } }, layout);
  await Plotly.newPlot(div, traces, lay, { staticPlot: true });
  const url = await Plotly.toImage(div, { format: "png", width, height, scale: 2 });
  Plotly.purge(div); div.remove();
  const bin = atob(url.split(",")[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function buildDocx(m, includeMap) {
  const X = window.docx;
  const FONT = { ascii: "游ゴシック", eastAsia: "游ゴシック", hAnsi: "游ゴシック" };
  const rep = reportsOf(m), dis = diseasesOf(m), miss = missingPosts(m) || [], tr = transfers().filter((t) => t.month === m), jk = junkaiOf(m);
  const [y, mo] = m.split("-");
  const P = (text, o = {}) => new X.Paragraph({ alignment: o.align, bullet: o.bullet ? { level: 0 } : undefined, spacing: { after: o.after ?? 80 },
    children: [new X.TextRun({ text, bold: o.bold, size: o.size, color: o.color, font: FONT })] });
  const H = (text, level) => new X.Paragraph({ heading: [X.HeadingLevel.HEADING_1, X.HeadingLevel.HEADING_2, X.HeadingLevel.HEADING_3][level - 1],
    spacing: { before: 240, after: 120 }, children: [new X.TextRun({ text, font: FONT, color: "1F3864", bold: true, size: [32, 26, 23][level - 1] })] });
  const cell = (t, o = {}) => new X.TableCell({ shading: o.fill ? { fill: o.fill, type: X.ShadingType.CLEAR, color: "auto" } : undefined,
    width: o.w ? { size: o.w, type: X.WidthType.DXA } : undefined,
    children: [new X.Paragraph({ alignment: o.num ? X.AlignmentType.RIGHT : undefined, children: [new X.TextRun({ text: String(t ?? ""), size: 18, bold: o.bold, font: FONT })] })] });
  const table = (head, rows, widths, boldRows = new Set()) => new X.Table({
    width: { size: 100, type: X.WidthType.PERCENTAGE },
    columnWidths: widths,
    rows: [new X.TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, { bold: true, fill: "D9E2F3", w: widths && widths[i] })) }),
      ...rows.map((r, ri) => new X.TableRow({ children: r.map((v, i) => cell(v, { bold: boldRows.has(ri), fill: boldRows.has(ri) ? "F2F2F2" : undefined, w: widths && widths[i], num: typeof v === "number" })) }))],
  });
  const img = (data, wPx, hPx) => new X.Paragraph({ alignment: X.AlignmentType.CENTER, children: [new X.ImageRun({ data, transformation: { width: wPx, height: hPx } })] });

  const ch = [];
  for (let i = 0; i < 6; i++) ch.push(P(""));
  ch.push(P("医務官月報 統合レポート", { size: 52, bold: true, align: X.AlignmentType.CENTER, color: "1F3864" }));
  ch.push(P(`${y}年${Number(mo)}月分`, { size: 36, align: X.AlignmentType.CENTER }));
  ch.push(P(`提出 ${rep.length}公館　／　未提出 ${miss.length}公館`, { size: 26, align: X.AlignmentType.CENTER }));
  ch.push(new X.Paragraph({ children: [new X.PageBreak()] }));

  const secs = ["1. 全体概況", ...(includeMap ? ["2. 世界地図"] : []), "3. 受診者数統計（甲表）", "4. 疾病分類統計（乙表）", "5. 巡回健診・医務官の異動", "6. 公館別 5行サマリー"];
  ch.push(H("目次", 1));
  secs.forEach((s) => ch.push(P(s)));

  ch.push(H("1. 全体概況", 1));
  overviewBullets(m).forEach((b) => ch.push(P(b, { bullet: true })));

  if (includeMap) {
    await loadGeo();
    ch.push(H("2. 世界地図", 1));
    const png = await figPng(worldTraces(m, { disease: true, visits: true, outbreak: true, events: true, junkai: true, transfers: true }),
      Object.assign(mapLayout(620, true), { legend: { orientation: "h", y: -0.02, x: 0, font: { size: 12 } } }), 1200, 680);
    ch.push(img(png, 640, 363));
    ch.push(P(`※国の塗り分けは最多疾病分類（実患${MIN_FULL}件未満の国は薄色）。○は受診者数、✚と病名は丙表で報告された病気（↑＝流行・増加）、その他の記号は災害・治安等。`, { size: 16, color: "555555" }));
  }

  ch.push(H("3. 受診者数統計（甲表）", 1));
  const regs = REGIONS.filter((r) => rep.some((x) => x.region === r));
  if (rep.length) {
    ch.push(img(await figPng([["staff", "職員", "#4472C4"], ["family", "家族", "#ED7D31"], ["other", "その他", "#A5A5A5"]].map(([f, name, color]) => ({
      type: "bar", orientation: "h", name, marker: { color }, y: regs, x: regs.map((g) => sum(rep.filter((r) => r.region === g), (r) => r[f])) })),
      { title: "地域別 受診者数", barmode: "stack", yaxis: { autorange: "reversed" }, margin: { l: 110, r: 20, t: 50, b: 40 } }, 1000, 460), 600, 276));
  }
  const ms = months().filter((x) => Object.values(state.reports).some((r) => r.month === x));
  if (ms.length >= 2) {
    const all = reportsOf();
    const traces = REGIONS.map((g) => ({ type: "scatter", mode: "lines+markers", name: g, x: ms.map(fmtMonth), y: ms.map((mm) => sum(all.filter((r) => r.month === mm && r.region === g), (r) => r.total)) }));
    traces.push({ type: "scatter", mode: "lines+markers", name: "合計", line: { color: "#000", width: 3 }, x: ms.map(fmtMonth), y: ms.map((mm) => sum(all.filter((r) => r.month === mm), (r) => r.total)) });
    ch.push(img(await figPng(traces, { title: "受診者数の月次推移（地域別）", margin: { l: 60, r: 20, t: 50, b: 40 } }, 1000, 440), 600, 264));
  }
  const rows = [], bold = new Set();
  for (const g of [...REGIONS, "未分類"]) {
    const rs = rep.filter((r) => r.region === g), mm = miss.filter((x) => x.region === g);
    if (!rs.length && !mm.length) continue;
    for (const r of rs) {
      const p = getReport(prevMonth(m), r.post);
      const d = p && p.total !== null && r.total !== null ? r.total - p.total : null;
      rows.push([g, r.post, r.officer, n(r.staff), n(r.family), n(r.other), n(r.total), d === null ? "" : (d >= 0 ? "+" : "") + d]);
    }
    for (const x of mm) rows.push([g, x.post, x.officer, "―", "―", "―", "―（未提出）", ""]);
    bold.add(rows.length);
    rows.push(["", `${g} 小計`, "", ...["staff", "family", "other", "total"].map((f) => String(sum(rs, (r) => r[f]))), ""]);
  }
  bold.add(rows.length);
  rows.push(["", "総計", "", ...["staff", "family", "other", "total"].map((f) => String(sum(rep, (r) => r[f]))), ""]);
  ch.push(table(["地域", "公館", "医務官", "職員", "家族", "その他", "計", "前月比"], rows, [1500, 1900, 1600, 750, 750, 750, 1100, 850], bold));

  ch.push(H("4. 疾病分類統計（乙表）", 1));
  if (dis.length) {
    const cats = CATEGORIES.filter((c) => c !== Z && dis.some((d) => d.category === c));
    ch.push(img(await figPng(cats.map((c) => ({ type: "bar", orientation: "h", name: shortCat(c), marker: { color: D.colors[c] }, y: regs,
      x: regs.map((g) => sum(dis.filter((d) => d.region === g && d.category === c), (d) => d.count)) })),
      { title: "地域別 疾病分類（検診・予防接種を除く）", barmode: "stack", yaxis: { autorange: "reversed" }, margin: { l: 110, r: 20, t: 50, b: 40 }, legend: { orientation: "h", y: -0.15 } }, 1000, 520), 600, 312));
    ch.push(H("分類別・地域別件数", 2));
    const allCats = CATEGORIES.filter((c) => dis.some((d) => d.category === c))
      .map((c) => [c, regs.map((g) => sum(dis.filter((d) => d.region === g && d.category === c), (d) => d.count))])
      .sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
    ch.push(table(["疾病分類", ...regs, "計"], allCats.map(([c, v]) => [shortCat(c), ...v.map(String), String(v.reduce((x, y) => x + y, 0))])));
    ch.push(H("診断名トップ10（検診・予防接種等を除く）", 2));
    ch.push(table(["順位", "診断名", "分類", "件数", "公館数"], topDiseases(dis).map((x, i) => [String(i + 1), x.name, shortCat(classify(x.name)), String(x.count), String(x.posts)]), [800, 3800, 2000, 1200, 1200]));
  } else ch.push(P("乙表データなし"));

  ch.push(H("5. 巡回健診・医務官の異動", 1));
  ch.push(H("巡回健診", 2));
  if (jk.length) ch.push(table(["実施公館", "巡回先", "期間", "記載"], jk.map((j) => [j.from, j.dest || "（不明）", j.period || "", (j.note || "").slice(0, 80)]), [1800, 1800, 1300, 4300]));
  else ch.push(P("今月の巡回健診の報告なし"));
  ch.push(H("医務官の異動・交代", 2));
  if (tr.length) ch.push(table(["公館", "前任", "後任", "後任の前任地"], tr.map((t) => [t.post, t.before, t.after, t.from || ""])));
  else ch.push(P("前月からの医務官の交代なし（月報ヘッダー・配置表による）"));

  ch.push(H("6. 公館別 5行サマリー", 1));
  for (const g of [...REGIONS, "未分類"]) {
    const rs = rep.filter((r) => r.region === g), mm = miss.filter((x) => x.region === g);
    if (!rs.length && !mm.length) continue;
    ch.push(H(g, 2));
    for (const r of rs) {
      ch.push(H(`${r.post}（医務官：${r.officer || "―"}）`, 3));
      (r.summary || ruleSummary(m, r.post)).split("\n").slice(0, 5).forEach((l) => ch.push(P(l, { bullet: true })));
    }
    for (const x of mm) {
      ch.push(H(`${x.post}（医務官：${x.officer || "―"}）`, 3));
      ch.push(P(`${Number(mo)}月分の月報提出なし`, { color: "C00000" }));
    }
  }

  const doc = new X.Document({
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children: ch }],
  });
  return X.Packer.toBlob(doc);
}

// ======================================================================= 設定

function pageSettings() {
  const names = {};
  for (const r of Object.values(state.reports)) for (const d of r.diseases || []) names[d.name] = (names[d.name] || 0) + d.count;
  const rows = Object.entries(names).filter(([nm]) => classify(nm) === OTHER || state.overrides[nm]).sort((a, b) => b[1] - a[1]);
  const byMonth = months().map((m) => [m, reportsOf(m)]);
  main.innerHTML = `
    <h2>設定・データ管理</h2>
    <div class="card">
      <h3 style="margin-top:0">疾病分類の手動設定</h3>
      <p class="muted">キーワードで分類できなかった病名に分類を割り当てます。次回以降も同じ病名に適用されます。</p>
      ${rows.length ? `<table><thead><tr><th>病名</th><th class="num">件数</th><th>分類</th></tr></thead><tbody>${
        rows.map(([nm, c]) => `<tr><td>${esc(nm)}</td><td class="num">${c}</td><td><select data-name="${esc(nm)}">${CATEGORIES.map((cat) => `<option value="${esc(cat)}"${classify(nm) === cat ? " selected" : ""}>${esc(shortCat(cat))}</option>`).join("")}</select></td></tr>`).join("")}
      </tbody></table><div class="row"><button class="primary" id="saveOv">分類を保存</button></div>` : '<p class="muted">分類できなかった病名はありません。</p>'}
    </div>
    <div class="card">
      <h3 style="margin-top:0">データのバックアップ</h3>
      <p class="muted">データはこのブラウザの中だけに保存されています。別のPCで使うときや念のための保存に、ファイルへ書き出してください。</p>
      <div class="row"><button id="exp">書き出し（.json）</button><label class="btn">読み込み<input type="file" id="imp" accept=".json" hidden></label><button id="sample">サンプルデータを読み込む</button></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">登録済みデータ</h3>
      ${byMonth.length ? `<table><thead><tr><th>月</th><th class="num">公館数</th><th class="num">受診者数</th><th></th></tr></thead><tbody>${
        byMonth.map(([m, rs]) => `<tr><td>${fmtMonth(m)}</td><td class="num">${rs.length}</td><td class="num">${sum(rs, (r) => r.total)}</td><td><button class="danger" data-delm="${m}">削除</button></td></tr>`).join("")}</tbody></table>` : '<p class="muted">なし</p>'}
      <div class="row"><button class="danger" id="wipe">すべてのデータを削除</button></div>
    </div>`;
  if ($("#saveOv")) $("#saveOv").onclick = async () => {
    document.querySelectorAll("[data-name]").forEach((s) => { state.overrides[s.dataset.name] = s.value; });
    await saveState(); toast("保存しました"); render();
  };
  $("#exp").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state)], { type: "application/json" }));
    a.download = `geppou_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $("#imp").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!s.reports) throw new Error("形式が違います");
      if (!confirm("現在のデータを置き換えます。よろしいですか？")) return;
      state = Object.assign({ reports: {}, rosters: {}, junkai: {}, overrides: {} }, s);
      await saveState(); refreshMonths(); toast("読み込みました"); render();
    } catch (err) { toast("読み込めませんでした: " + err.message); }
  };
  $("#sample").onclick = async () => {
    if (Object.keys(state.reports).length && !confirm("現在のデータをサンプルデータで置き換えます。よろしいですか？")) return;
    const s = await (await fetch("sample.json")).json();
    state = Object.assign({ reports: {}, rosters: {}, junkai: {}, overrides: {} }, s);
    await saveState(); refreshMonths(); toast("サンプルデータ（架空の3か月分）を読み込みました"); page = "dashboard"; render();
  };
  document.querySelectorAll("[data-delm]").forEach((b) => (b.onclick = async () => {
    const m = b.dataset.delm;
    if (!confirm(`${fmtMonth(m)} のデータを削除します。よろしいですか？`)) return;
    for (const k of Object.keys(state.reports)) if (k.startsWith(m + "|")) delete state.reports[k];
    delete state.rosters[m]; delete state.junkai[m];
    await saveState(); refreshMonths(); render();
  }));
  $("#wipe").onclick = async () => {
    if (!confirm("すべてのデータを削除します。元に戻せません。よろしいですか？")) return;
    state = { reports: {}, rosters: {}, junkai: {}, overrides: {} };
    await saveState(); refreshMonths(); render();
  };
}

// ======================================================================= 起動

$("#tabs").onclick = (e) => {
  const b = e.target.closest("button[data-page]");
  if (!b) return;
  page = b.dataset.page;
  render();
};
$("#month").onchange = () => render();

(async () => {
  await loadState();
  refreshMonths();
  if (months().length) page = "dashboard";
  render();
})();
