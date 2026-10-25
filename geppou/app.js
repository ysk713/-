/* 医務官月報 取りまとめ（ブラウザ版）
 * PDFの読み取り・集計・地図・PDFレポート出力をすべてブラウザ内で行う。
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
  INFO[p.name] = { region: p.region, iso3: p.iso3, iso2: p.iso2, lat: p.lat, lon: p.lon, isPost: true };
  for (const a of [p.name, ...p.aliases]) ALIASES[norm(a)] = p.name;
}
for (const p of D.extra) {
  INFO[p.name] = { region: p.region, iso3: p.iso3, iso2: p.iso2, lat: p.lat, lon: p.lon, isPost: false };
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

// 国旗（lib/flags/ に同梱した flag-icons の SVG）
const flagImg = (name, cls = "flag") => {
  const c = INFO[name] && INFO[name].iso2;
  return c ? `<img class="${cls}" src="lib/flags/${c}.svg" alt="" loading="lazy">` : "";
};
const regionOf = (name) => (INFO[name] ? INFO[name].region : "未分類");
const coord = (name) => (INFO[name] ? [INFO[name].lat, INFO[name].lon] : null);

// ======================================================================= 疾病分類

const Z = D.z, OTHER = D.other;
const CATEGORIES = [...D.rules.map((r) => r[0]), OTHER];
const shortCat = (c) => D.short[c] || c;
function classify(name) {
  if (state.overrides[name]) return state.overrides[name];
  // いちばん長く一致したキーワードの分類を採る（「蕁麻疹」が「麻疹」で感染症にならないように）
  let best = OTHER, len = 0;
  for (const [cat, kws] of D.rules) for (const k of kws) if (k.length > len && name.includes(k)) { best = cat; len = k.length; }
  return best;
}

// ======================================================================= 病名のまとめ方
// 表記ゆれ・近い病名を1つの病名グループにまとめる。[グループ名, 病名に含まれる表記]。
// 長い表記から先に照合する（「鳥インフルエンザ」と「インフルエンザ」、「潰瘍性大腸炎」と「腸炎」など）。
// 設定画面で個別に付け替えた結果（state.groups）が優先される。
const DISEASE_GROUPS = [
  ["かぜ（急性上気道炎）", ["かぜ", "カゼ", "風邪", "感冒", "上気道炎", "上気道感染", "鼻咽頭炎", "咽頭炎", "喉頭炎", "咽喉頭炎", "扁桃炎", "鼻かぜ"]],
  ["インフルエンザ", ["インフルエンザ"]], ["鳥インフルエンザ", ["鳥インフルエンザ", "H5N1"]],
  ["新型コロナウイルス感染症", ["新型コロナ", "COVID", "コロナウイルス"]],
  ["気管支炎", ["気管支炎"]], ["肺炎", ["肺炎"]], ["気管支喘息", ["喘息"]],
  ["アレルギー性鼻炎・花粉症", ["アレルギー性鼻炎", "花粉症", "鼻炎"]], ["副鼻腔炎", ["副鼻腔炎", "蓄膿"]],
  ["デング熱", ["デング"]], ["マラリア", ["マラリア"]], ["チクングニア熱", ["チクングニア"]], ["ジカウイルス感染症", ["ジカ"]],
  ["コレラ", ["コレラ"]], ["腸チフス", ["チフス"]], ["赤痢", ["赤痢"]], ["A型肝炎", ["A型肝炎"]],
  ["胃腸炎・下痢症", ["胃腸炎", "腸炎", "下痢", "腸管感染", "ノロウイルス", "ロタウイルス", "旅行者下痢"]],
  ["炎症性腸疾患", ["潰瘍性大腸炎", "クローン病"]], ["過敏性腸症候群", ["過敏性腸"]],
  ["胃炎・消化性潰瘍", ["胃炎", "十二指腸炎", "胃潰瘍", "十二指腸潰瘍", "消化性潰瘍", "機能性ディスペプシア"]],
  ["胃食道逆流症", ["逆流性食道炎", "胃食道逆流"]], ["便秘", ["便秘"]], ["痔", ["痔"]], ["口内炎", ["口内炎"]],
  ["歯科疾患", ["齲蝕", "う蝕", "虫歯", "むし歯", "歯肉炎", "歯周", "歯髄炎", "歯痛"]],
  ["湿疹・皮膚炎", ["湿疹", "皮膚炎"]], ["蕁麻疹", ["蕁麻疹", "じんま疹", "じん麻疹"]], ["ざ瘡", ["ざ瘡", "座瘡", "痤瘡", "にきび", "アクネ"]],
  ["白癬・皮膚真菌症", ["白癬", "水虫", "皮膚糸状菌", "カンジダ", "真菌症"]], ["帯状疱疹", ["帯状疱疹"]], ["水痘", ["水痘", "水ぼうそう"]],
  ["単純ヘルペス", ["ヘルペス"]], ["疥癬", ["疥癬"]], ["虫刺症", ["虫刺", "虫さされ", "昆虫咬"]],
  ["結膜炎", ["結膜炎"]], ["麦粒腫・霰粒腫", ["麦粒腫", "霰粒腫", "ものもらい"]], ["中耳炎・外耳炎", ["中耳炎", "外耳炎"]],
  ["頭痛・片頭痛", ["頭痛"]], ["めまい", ["めまい", "眩暈"]],
  ["腰痛・背部痛", ["腰痛", "背部痛", "背中の痛"]], ["頚肩部痛", ["頚部痛", "頸部痛", "肩こり", "肩の傷害", "肩関節"]],
  ["関節痛・関節炎", ["関節"]], ["捻挫・打撲", ["捻挫", "打撲", "挫傷", "ストレイン"]], ["骨折", ["骨折"]],
  ["創傷・咬傷", ["創傷", "切創", "裂創", "咬傷", "刺傷", "擦過傷", "表在損傷", "開放創"]], ["熱傷", ["熱傷", "やけど"]],
  ["熱中症", ["熱中症", "熱射病", "熱及び光線の作用"]],
  ["高血圧", ["高血圧"]], ["糖尿病", ["糖尿病"]], ["脂質異常症", ["脂質異常", "高脂血症", "コレステロール"]], ["痛風・高尿酸血症", ["痛風", "尿酸"]],
  ["不眠症・睡眠障害", ["不眠", "睡眠障害"]], ["うつ病・抑うつ", ["うつ"]], ["不安障害", ["不安"]], ["適応障害・ストレス反応", ["適応障害", "ストレス"]],
  ["膀胱炎・尿路感染症", ["膀胱炎", "尿路感染"]],
  ["予防接種", ["予防接種", "ワクチン"]], ["健康診断", ["健康診断", "健診", "検診"]],
];
const GROUP_PATTERNS = DISEASE_GROUPS.flatMap(([g, pats]) => pats.map((p) => [nfkc(p), g])).sort((a, b) => b[0].length - a[0].length);
const GROUP_NAMES = DISEASE_GROUPS.map((g) => g[0]);
function autoGroup(name) {
  const t = nfkc(name);
  for (const [p, g] of GROUP_PATTERNS) if (t.includes(p)) return g;
  return name;
}
const groupOf = (name) => state.groups[name] || autoGroup(name);
const isGrouped = (name) => !!state.groups[name] || autoGroup(name) !== name || GROUP_NAMES.includes(name);

// ======================================================================= UpToDate へのリンク
// 病名をクリックすると UpToDate の検索結果を新しいタブで開く（送るのは病名だけ。医務官は全員契約済み）。
// 英語の方が検索の精度が高いので、まとめた病名グループは英語の語で検索する。辞書にない病名はそのまま検索する
const UTD_EN = {
  "かぜ（急性上気道炎）": "common cold", "インフルエンザ": "influenza", "鳥インフルエンザ": "avian influenza",
  "新型コロナウイルス感染症": "COVID-19", "気管支炎": "acute bronchitis", "肺炎": "community-acquired pneumonia", "気管支喘息": "asthma",
  "アレルギー性鼻炎・花粉症": "allergic rhinitis", "副鼻腔炎": "acute sinusitis", "デング熱": "dengue", "マラリア": "malaria",
  "チクングニア熱": "chikungunya", "ジカウイルス感染症": "Zika virus infection", "コレラ": "cholera", "腸チフス": "enteric fever typhoid",
  "赤痢": "shigella", "A型肝炎": "hepatitis A", "E型肝炎": "hepatitis E", "胃腸炎・下痢症": "acute diarrhea in adults", "炎症性腸疾患": "inflammatory bowel disease",
  "過敏性腸症候群": "irritable bowel syndrome", "胃炎・消化性潰瘍": "peptic ulcer disease", "胃食道逆流症": "gastroesophageal reflux disease",
  "便秘": "constipation", "痔": "hemorrhoids", "口内炎": "aphthous ulcers", "歯科疾患": "dental infection",
  "湿疹・皮膚炎": "eczema dermatitis", "蕁麻疹": "urticaria", "ざ瘡": "acne vulgaris", "白癬・皮膚真菌症": "dermatophyte tinea infections",
  "帯状疱疹": "herpes zoster", "水痘": "varicella", "単純ヘルペス": "herpes simplex", "疥癬": "scabies", "虫刺症": "insect bites",
  "結膜炎": "conjunctivitis", "麦粒腫・霰粒腫": "hordeolum chalazion", "中耳炎・外耳炎": "otitis", "頭痛・片頭痛": "migraine headache",
  "めまい": "vertigo", "腰痛・背部痛": "low back pain", "頚肩部痛": "neck pain", "関節痛・関節炎": "arthralgia", "捻挫・打撲": "ankle sprain",
  "骨折": "fracture", "創傷・咬傷": "laceration wound management", "熱傷": "burn", "熱中症": "heat stroke", "高血圧": "hypertension",
  "糖尿病": "diabetes mellitus", "脂質異常症": "dyslipidemia", "痛風・高尿酸血症": "gout", "不眠症・睡眠障害": "insomnia",
  "うつ病・抑うつ": "depression", "不安障害": "anxiety disorder", "適応障害・ストレス反応": "adjustment disorder", "膀胱炎・尿路感染症": "cystitis urinary tract infection",
  "予防接種": "immunizations for travelers", "健康診断": "preventive care adults",
  "エボラ出血熱": "Ebola", "マールブルグ病": "Marburg virus", "エムポックス": "mpox", "麻疹": "measles", "風疹": "rubella", "黄熱": "yellow fever",
  "RSウイルス感染症": "respiratory syncytial virus", "狂犬病": "rabies", "ペスト": "plague", "ポリオ": "poliomyelitis", "髄膜炎": "meningitis",
  "ラッサ熱": "Lassa fever", "クリミア・コンゴ出血熱": "Crimean-Congo hemorrhagic fever", "リフトバレー熱": "Rift Valley fever", "結核": "tuberculosis",
  "百日咳": "pertussis", "ジフテリア": "diphtheria", "手足口病": "hand foot and mouth disease", "オロプーシェ熱": "Oropouche", "日本脳炎": "Japanese encephalitis",
  "レプトスピラ症": "leptospirosis", "ハンタウイルス感染症": "hantavirus", "MERS": "Middle East respiratory syndrome", "炭疽": "anthrax", "猩紅熱": "scarlet fever",
  "マイコプラズマ肺炎": "Mycoplasma pneumoniae", "流行性耳下腺炎": "mumps", "ノロウイルス": "norovirus", "ロタウイルス": "rotavirus", "食中毒": "food poisoning",
  "ウエストナイル熱": "West Nile virus", "ニパウイルス感染症": "Nipah virus", "ブルセラ症": "brucellosis", "住血吸虫症": "schistosomiasis",
  "リーシュマニア症": "leishmaniasis", "シャーガス病": "Chagas disease", "呼吸器感染症": "respiratory tract infection",
};
const utdUrl = (name) => "https://www.uptodate.com/contents/search?search=" + encodeURIComponent(UTD_EN[name] || UTD_EN[autoGroup(name)] || name);
// 病名をリンクにする（label を省くと病名そのものを表示）
const utd = (name, label) => `<a class="utd" href="${esc(utdUrl(name))}" target="_blank" rel="noopener noreferrer" title="UpToDateで「${esc(UTD_EN[name] || UTD_EN[autoGroup(name)] || name)}」を検索">${label ?? esc(name)}</a>`;

// ======================================================================= 保存（IndexedDB）

let state = { reports: {}, rosters: {}, junkai: {}, overrides: {}, groups: {}, cases: {} };

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
    if (s) state = Object.assign({ reports: {}, rosters: {}, junkai: {}, overrides: {}, groups: {}, cases: {} }, s);
  } catch (e) {
    toast("ブラウザの保存領域が使えません。データは再読み込みで消えます。");
  }
}
// デモ表示中は実データと混ざらないよう、保存（IndexedDB）には書き込まない
let demoMode = false;
async function saveState() {
  clearCaches();
  if (demoMode) return;
  savePref("lastChange", Date.now());
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

// 月報PDFのパスワード。パスワード付きのPDFはまずこれで開き、違うときは入力を求める（入力したものは続くファイルにも使う）
const IMPORT_PDF_PASSWORD = "imukanmd";
let lastPdfPassword = null;
async function openPdf(buf) {
  const task = pdfjsLib.getDocument({ data: buf, password: IMPORT_PDF_PASSWORD });
  let triedLast = false, cancelled = false;
  task.onPassword = (update, reason) => {
    if (lastPdfPassword && !triedLast) { triedLast = true; update(lastPdfPassword); return; }
    const pw = prompt(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? `このPDFは別のパスワードが付いています（${IMPORT_PDF_PASSWORD} では開けませんでした）。パスワードを入力してください` : "このPDFのパスワードを入力してください", "");
    if (pw === null) { cancelled = true; task.destroy(); return; }
    lastPdfPassword = pw;
    update(pw);
  };
  try {
    return await task.promise;
  } catch (e) {
    if (cancelled || (e && e.name === "PasswordException")) throw new Error("パスワード付きのPDFを開けませんでした（パスワードが違います）");
    throw e;
  }
}
async function readPdf(buf) {
  const doc = await openPdf(buf);
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

// ファイル名（とフォルダ名）から「何年何月分」を読み取る。見つからなければ null
//   例: ケニア_202607.pdf / 2026年7月_ケニア.docx / 2026-07 / 2026.7 / 令和8年7月 / R8.7 / 20260715
function monthFromName(path) {
  const parts = nfkc(path || "").split(/[\\/]/).reverse();  // ファイル名 → 親フォルダの順に探す
  const ok = (y, m) => (m >= 1 && m <= 12 && y >= 2000 && y <= 2099 ? `${y}-${String(m).padStart(2, "0")}` : null);
  for (const raw of parts) {
    const t = raw.replace(/\.(pdf|docx?|xlsx?|xlsm|json)$/i, "");
    let m, r;
    if ((m = t.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月/)) && (r = ok(+m[1], +m[2]))) return r;
    if ((m = t.match(/令和\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月/)) && (r = ok((m[1] === "元" ? 1 : +m[1]) + 2018, +m[2]))) return r;
    if ((m = t.match(/(?:^|[^A-Za-z])R\s*(\d{1,2})[.\-_年](\d{1,2})(?!\d)/i)) && (r = ok(+m[1] + 2018, +m[2]))) return r;
    if ((m = t.match(/(?<!\d)(20\d{2})[-_.\s](\d{1,2})(?!\d)/)) && (r = ok(+m[1], +m[2]))) return r;
    if ((m = t.match(/(?<!\d)(20\d{2})(0[1-9]|1[0-2])(?:[0-3]\d)?(?!\d)/)) && (r = ok(+m[1], +m[2]))) return r;
  }
  return null;
}
// 本文（甲表の見出しなど）から「何年何月分」を読み取る
function monthFromText(text) {
  const t = nfkc(text);
  let m = t.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*分/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  m = t.match(/令和\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月/);
  if (m) return `${(m[1] === "元" ? 1 : Number(m[1])) + 2018}-${m[2].padStart(2, "0")}`;
  return null;
}

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
  // 感染症ではないが病名の一部が重なるもの（長い方で先に照合して読み飛ばす）
  ["", ["蕁麻疹", "じんま疹", "じん麻疹"]],
];
const RISING = /流行|増加|急増|拡大|多発|発生|アウトブレイク|蔓延|まん延|感染者|患者が|症例|報告が続|警戒|注意喚起|高水準|高止まり|依然|続いている|相次/;
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
      if (!name) continue;
      const cur = found[name];
      if (!cur || rank[trend] > rank[cur.trend]) found[name] = { name, trend, sentence: s.slice(0, 160) };
    }
  }
  return Object.values(found);
}
function reportOutbreaks(r) {
  // 同じ病名グループの記述が複数あれば、流行・増加 ＞ 言及 ＞ 減少・終息 の順で1つにまとめる
  const best = {};
  const rank = { "流行・増加": 3, "言及": 2, "減少・終息": 1 };
  for (const d of heiDiseases(r.hei)) {
    const name = groupOf(d.name);
    if (!best[name] || rank[d.trend] > rank[best[name].trend]) best[name] = { ...d, name };
  }
  return Object.values(best).map((d) => ({ ...d, post: r.post, region: r.region, month: r.month }));
}
function outbreaksOf(m) {
  return reportsOf(m).flatMap(reportOutbreaks);
}

// 新着アラート: 前月と比べて「丙表に新しく出てきた病気」と「乙表で急に増えた病気」
// 前月の月報がある公館だけを比べる（初めて出した公館で全部が新着にならないように）
function groupCounts(r) {
  const c = {};
  for (const d of r.diseases || []) if (classify(d.name) !== Z) c[groupOf(d.name)] = (c[groupOf(d.name)] || 0) + d.count;
  return c;
}
function newAlerts(m) {
  const out = [];
  for (const r of reportsOf(m)) {
    const pr = getReport(prevMonth(m), r.post);
    if (!pr) continue;
    const before = new Set(reportOutbreaks(pr).filter((o) => o.trend !== "減少・終息").map((o) => o.name));
    for (const o of reportOutbreaks(r))
      if (o.trend !== "減少・終息" && !before.has(o.name))
        out.push({ post: r.post, region: r.region, kind: "丙表に新登場", name: o.name, detail: o.sentence });
    const cur = groupCounts(r), prv = groupCounts(pr);
    for (const [g, c] of Object.entries(cur)) {
      const p = prv[g] || 0;
      if (c >= 5 && c >= 2 * p && c - p >= 4) out.push({ post: r.post, region: r.region, kind: p ? "乙表で急増" : "乙表に新登場", name: g, detail: `${p}件 → ${c}件`, rise: c - p });
    }
  }
  // 丙表の新登場を先に、乙表は増え方の大きい順に
  return out.sort((a, b) => (a.kind === "丙表に新登場" ? 0 : 1) - (b.kind === "丙表に新登場" ? 0 : 1) || (b.rise || 0) - (a.rise || 0));
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

// ----------------------------------------------------------------------- 緊急移送・邦人対応の事例
// 丙表の文から事例を拾う。どちらも画面の表で直せる（直した月は state.cases に保存）
const EVAC_RE = /緊急移送|医療搬送|患者移送|航空搬送|エア・?アンビュランス|医療専用機|(移送|搬送)(した|された|し、|され、|を行|を実施)|へ(移送|搬送)/;
const EVAC_NOT = /(移送|搬送)(は|の必要は|の必要)?(不要|なし|行わ|しなかった)/;
const HOGO_RE = /邦人|旅行者|出張者|留学生|観光客/;
const WHO_RULES = [["館員家族", /(館員|職員)の?家族|配偶者|子女|家族/], ["館員", /館員|職員|医務官/], ["邦人旅行者", /旅行者|観光客/],
  ["邦人出張者", /出張者|出張中/], ["留学生", /留学生/], ["在留邦人", /在留邦人|邦人/]];
const COND_WORDS = ["くも膜下出血", "心筋梗塞", "狭心症", "脳梗塞", "脳出血", "脳卒中", "急性虫垂炎", "虫垂炎", "骨折", "交通事故", "頭部外傷", "外傷", "熱傷",
  "溺水", "減圧症", "高山病", "重症マラリア", "マラリア", "デング出血熱", "デング熱", "敗血症", "肺炎", "切迫早産", "妊娠", "出産", "うつ病", "精神症状",
  "自殺", "熱中症", "食中毒", "胃腸炎", "犬咬傷", "狂犬病", "蛇咬傷", "心停止", "急性腹症", "消化管出血", "腎不全", "コレラ", "腸チフス", "盗難", "強盗", "詐欺", "けが"];
const MEANS_RULES = [["エアアンビュランス", /エア・?アンビュランス|医療専用機|航空救急/], ["民間航空機（付き添い）", /民間機|商用便|定期便|民間航空|付き添/], ["ヘリコプター", /ヘリ/], ["救急車", /救急車/]];
const OUTCOME_RULES = [["死亡", /死亡|死去|逝去|亡くな/], ["回復・退院", /回復|退院|軽快|快方/], ["帰国", /帰国/], ["手術", /手術/], ["入院中", /入院|治療中|加療中/]];
const KIND_RULES = [["死亡", /死亡|死去|逝去|亡くな/], ["事件", /盗難|強盗|暴行|詐欺|拘束|逮捕|誘拐|銃撃|事件|ひったくり/], ["事故", /事故|交通外傷|転落|転倒|溺|負傷|けが|咬傷/],
  ["病気", /入院|受診|発症|感染|疾患|病|熱|炎|症|梗塞|出血/]];
const CASE_KINDS = ["病気", "事故", "事件", "死亡", "その他"];
const CASE_WHO = WHO_RULES.map((w) => w[0]);
const firstRule = (rules, s, dflt = "") => { const r = rules.find(([, re]) => re.test(s)); return r ? r[0] : dflt; };

function caseFromSentence(s, post, type, next = "") {
  const conds = [];
  for (const w of COND_WORDS) if (s.includes(w) && !conds.some((c) => c.includes(w))) conds.push(w);
  for (const d of heiDiseases(s)) { const g = groupOf(d.name); if (!conds.some((c) => c.includes(g) || g.includes(c) || groupOf(c) === g)) conds.push(g); }
  let dest = "";
  if (type === "evac") {
    if (/本邦|日本へ|日本に|帰国させ/.test(s)) dest = "日本";
    else dest = findInText(s).filter((p) => p !== post)[0] || "";
  }
  return {
    type, post, who: firstRule(WHO_RULES, s), cond: conds.slice(0, 3).join("・"), dest,
    // 転帰は次の文に書かれることが多い（「…へ緊急移送した。手術を受け回復した。」）
    means: type === "evac" ? firstRule(MEANS_RULES, s) : "", outcome: firstRule(OUTCOME_RULES, s) || firstRule(OUTCOME_RULES, next),
    kind: type === "hogo" ? firstRule(KIND_RULES, s, "その他") : "", note: s.slice(0, 200), src: post,
  };
}
function detectCases(heiText, post) {
  const out = [];
  const ss = sentences(heiText);
  ss.forEach((s, i) => {
    // 次の文が別の事例（移送・邦人の話）なら転帰の参考にしない
    const next = ss[i + 1] && !EVAC_RE.test(ss[i + 1]) && !HOGO_RE.test(ss[i + 1]) ? ss[i + 1] : "";
    if (EVAC_RE.test(s) && !EVAC_NOT.test(s)) out.push(caseFromSentence(s, post, "evac", next));
    if (HOGO_RE.test(s)) out.push(caseFromSentence(s, post, "hogo", next));
  });
  return out;
}
// 丙表から拾った事例のキャッシュ（データが変わったら clearCaches() で捨てる）
let CASE_CACHE = {};
function clearCaches() { CASE_CACHE = {}; }
// 画面で直した月は保存した一覧を、そうでなければ丙表から拾った一覧を返す
function casesOf(m, type) {
  const ms = m ? [m] : [...new Set(Object.values(state.reports).map((r) => r.month))].sort();
  const out = [];
  for (const mm of ms) {
    const list = (state.cases && state.cases[mm]) || (CASE_CACHE[mm] ||= reportsOf(mm).flatMap((r) => detectCases(r.hei, r.post)));
    for (const c of list) if (!type || c.type === type) out.push({ ...c, month: mm });
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
    filename: file.name, format: fmt, month: detectMonth(full, file.name), bodyMonth: monthFromText(full), post, officer: k.officer,
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
  // 「2026年8月1日現在」「令和8年8月」など、表の上の見出しに書かれた年月
  const headText = rows.slice(0, Math.max(1, h)).map((r) => r.join(" ")).join(" ");
  const sheetMonth = monthFromText(headText.replace(/(\d{1,2})\s*月(?!\s*分)/, "$1月分")) || monthFromName(headText);
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
  out.sheetMonth = sheetMonth;
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
  for (const d of r.diseases || []) if (classify(d.name) !== Z) agg[groupOf(d.name)] = (agg[groupOf(d.name)] || 0) + d.count;
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
  const al = newAlerts(m);
  if (al.length) out.push(`前月からの新着アラート ${al.length}件：` + al.slice(0, 8).map((a) => `${a.post}の${a.name}（${a.kind}${a.kind === "丙表に新登場" ? "" : "、" + a.detail}）`).join("、") + (al.length > 8 ? " ほか" : "") + "。");
  for (const kind of ["気象・災害", "治安・社会"]) {
    const g = {};
    for (const e of ev.filter((e) => e.kind === kind)) (g[e.keyword] ||= new Set()).add(e.post);
    if (Object.keys(g).length) out.push(`${kind}：` + Object.entries(g).map(([k, ps]) => `${k}（${[...ps].join("・")}）`).join("／") + "。");
  }
  const ev2 = casesOf(m, "evac"), hg = casesOf(m, "hogo");
  if (ev2.length) out.push(`緊急移送 ${ev2.length}件：` + ev2.map((c) => `${c.post}→${c.dest || "（行先不明）"}（${[c.who, c.cond].filter(Boolean).join("・")}）`).join("、") + "。");
  if (hg.length) out.push(`邦人対応 ${hg.length}件（` + CASE_KINDS.map((k) => [k, hg.filter((c) => c.kind === k).length]).filter(([, v]) => v).map(([k, v]) => `${k}${v}`).join("・") + "）。");
  if (jk.length) out.push(`巡回健診の報告 ${jk.length}件：` + jk.map((j) => `${j.from}→${j.dest || "（行先不明）"}`).join("、") + "。");
  const tr = transfers().filter((t) => t.month === m);
  if (tr.length) out.push("医務官の交代：" + tr.map((t) => `${t.post}（${t.before}→${t.after}）`).join("、") + "。");
  const miss = missingPosts(m);
  if (miss && miss.length) out.push(`月報未提出 ${miss.length}公館：` + miss.map((x) => x.post).join("、") + "。");
  return out;
}

// ======================================================================= 地図（Plotly の通常の座標系で描く。geo機能は外部CDNから地図を取りに行くため使わない）

let GEO = null;
async function loadGeo() {
  if (GEO) { await loadPlaces(); return; }
  [GEO] = await Promise.all([fetch("countries.geo.json").then((r) => r.json()), loadPlaces()]);
}
// ---- 地図の国名・首都・大きな都市（lib/places.json。Natural Earth、パブリックドメイン。geppou-app/sample/build_places.py で作成）
// countries: [日本語名, 経度, 緯度, 表示の優先度(小さいほど大きな国), 国コード]、capitals・cities: [日本語名, 経度, 緯度, 人口, 国コード]
let PLACES = null;
async function loadPlaces() {
  if (!PLACES) PLACES = await fetch("lib/places.json").then((r) => r.json()).catch(() => ({ countries: [], capitals: [], cities: [] }));
  return PLACES;
}
const wikiUrl = (name) => `https://ja.wikipedia.org/wiki/${encodeURIComponent(name)}`;
const countryJa = (iso) => { const c = PLACES && PLACES.countries.find((x) => x[4] === iso); return c ? c[0] : null; };
const popLabel = (n) => (n >= 1e4 ? `約${Math.round(n / 1e4).toLocaleString()}万人` : `約${n.toLocaleString()}人`);
const LABEL_DETAIL_ZOOM = 1.8;   // これ以上拡大したら、すべての国名・首都名・都市名を出す
const BIG_CAPITAL = 5e6;          // 地球全体を見ているときも名前を出す首都の人口
// 国名・首都（★）・人口50万人以上の都市（●）。細かいものは拡大したときだけ出す（meta: "detail"＝約1.8倍以上、"detail2"＝約4.5倍以上）
// filled：疾病分類で色を塗った国（国コード）。その上の名前は白、塗っていない国の上は濃い色にして読みやすくする
function placeTraces(filled = new Set()) {
  if (!PLACES) return [];
  const sat = view().style === "globe" && EARTH_SKINS[view().skin];
  const dark = css("--text") || "#263238";
  const inkOf = (iso) => (sat || filled.has(iso) ? "rgba(255,255,255,0.95)" : dark);
  const softOf = (iso) => (sat || filled.has(iso) ? "rgba(255,255,255,0.88)" : "rgba(70,85,100,0.92)");
  // 細かい名前（meta: "detail"）は最初は隠しておき、拡大したら updateLabelDetail() で出す
  const T = (rows, extra) => Object.assign({ x: rows.map((r) => r[1]), y: rows.map((r) => r[2]), type: "scatter", showlegend: false }, extra, extra.meta ? { visible: false } : {});
  const C = PLACES.countries, cap = PLACES.capitals, city = PLACES.cities;
  const cd = (kind) => (r) => ({ kind, name: r[0], iso: r[4], pop: r[3] });
  const capHover = (r) => `★ <b>${r[0]}</b>（首都）${countryJa(r[4]) ? "・" + countryJa(r[4]) : ""}<br>人口 ${popLabel(r[3])}<br><i>マウスを止めると Wikipedia の要約とリンク</i>`;
  const cityHover = (r) => `● <b>${r[0]}</b>${countryJa(r[4]) ? "・" + countryJa(r[4]) : ""}<br>人口 ${popLabel(r[3])}<br><i>マウスを止めると Wikipedia の要約とリンク</i>`;
  const major = C.filter((c) => c[3] <= 3), minor = C.filter((c) => c[3] > 3);
  const bigCap = cap.filter((r) => r[3] >= BIG_CAPITAL), smallCap = cap.filter((r) => r[3] < BIG_CAPITAL);
  return [
    T(major, { mode: "text", text: major.map((c) => c[0]), textfont: { size: 11, color: major.map((c) => softOf(c[4])) }, hoverinfo: "none", customdata: major.map((c) => ({ kind: "country", name: c[0], iso: c[4] })), name: "_国名" }),
    T(minor, { mode: "text", text: minor.map((c) => c[0]), textfont: { size: 10, color: minor.map((c) => softOf(c[4])) }, hoverinfo: "none", customdata: minor.map((c) => ({ kind: "country", name: c[0], iso: c[4] })), name: "_国名（小）", meta: "detail" }),
    // 都市（人口50万人以上）：●は300万人以上はいつも、それより小さい都市は拡大したとき。名前は100万人以上は拡大したとき、50万〜100万人はさらに拡大したとき
    ...[[city.filter((r) => r[3] >= 3e6), "_都市", undefined, 4.5], [city.filter((r) => r[3] < 3e6), "_都市（中）", "detail", 3.6]].map(([rows, name, meta, size]) =>
      T(rows, { mode: "markers", marker: { size, color: rows.map((r) => inkOf(r[4])), opacity: 0.85 }, text: rows.map(cityHover), hoverinfo: "text", customdata: rows.map(cd("city")), name, meta })),
    ...[[city.filter((r) => r[3] >= 1e6), "_都市名", "detail"], [city.filter((r) => r[3] < 1e6), "_都市名（小）", "detail2"]].map(([rows, name, meta]) =>
      T(rows, { mode: "text", text: rows.map((r) => r[0]), textposition: "top center", textfont: { size: 9, color: rows.map((r) => inkOf(r[4])) }, hoverinfo: "none", customdata: rows.map(cd("city")), name, meta })),
    // 首都の★：人口100万人以上はいつも、それより小さい首都は拡大したときだけ（地球全体では欧州などが★だらけになるため）
    ...[[cap.filter((r) => r[3] >= 1e6), "_首都", undefined], [cap.filter((r) => r[3] < 1e6), "_首都（小）", "detail"]].map(([rows, name, meta]) =>
      T(rows, { mode: "markers", marker: { symbol: "star", size: 8, color: rows.map((r) => inkOf(r[4])), line: { color: rows.map((r) => (sat || filled.has(r[4]) ? "#000" : "#fff")), width: 0.6 } },
        text: rows.map(capHover), hoverinfo: "text", customdata: rows.map(cd("capital")), name, meta })),
    T(bigCap, { mode: "text", text: bigCap.map((r) => r[0]), textposition: "bottom center", textfont: { size: 9.5, color: bigCap.map((r) => inkOf(r[4])) }, hoverinfo: "none", customdata: bigCap.map(cd("capital")), name: "_首都名" }),
    T(smallCap, { mode: "text", text: smallCap.map((r) => r[0]), textposition: "bottom center", textfont: { size: 9, color: smallCap.map((r) => inkOf(r[4])) }, hoverinfo: "none", customdata: smallCap.map(cd("capital")), name: "_首都名（小）", meta: "detail" }),
  ];
}
// 拡大率に応じて、細かい名前（meta: "detail"）を出したり消したりする
// 2段階：detail は約1.8倍以上、detail2（50万〜100万人の都市名）は約4.5倍以上（ツアーの到着時3.6倍では出さない）
const LABEL_DETAIL2_ZOOM = 4.5;
function updateLabelDetail(el) {
  if (!el.data || el._labelBusy) return;
  const idx = el.data.map((t, i) => (t.meta === "detail" || t.meta === "detail2" ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return;
  const globe = el._fullLayout && el._fullLayout.geo && el._fullLayout.geo.projection.type === "orthographic";
  const z = globe ? el._zoom || 1 : 1;
  const want = idx.map((i) => (el.data[i].meta === "detail" ? z >= LABEL_DETAIL_ZOOM : z >= LABEL_DETAIL2_ZOOM));
  if (idx.every((i, k) => (el.data[i].visible === true) === want[k])) { el._labelDetail = z >= LABEL_DETAIL_ZOOM; return; }
  el._labelDetail = z >= LABEL_DETAIL_ZOOM;
  el._labelBusy = true;
  Plotly.restyle(el, { visible: want }, idx).finally(() => (el._labelBusy = false));
}
// マウスを載せたものから、開くカードを決める（公館の印・国・首都・都市）
let cardKey = null;   // いま開いているカード（同じものに何度も載せても開き直さない）
function hoverTarget(pt) {
  if (!pt) return null;
  const cd = pt.customdata;
  if (cd && typeof cd === "object" && cd.kind) return { key: `${cd.kind}:${cd.name}`, open: () => openPlaceCard(cd) };
  if (typeof cd === "string" && INFO[cd]) return { key: `post:${cd}`, open: () => openPostCard([cd]) };
  const iso = pt.location;
  if (!iso) return null;
  const posts = postsInCountry(iso);
  return { key: `country:${iso}`, open: () => (posts.length ? openPostCard(posts) : openPlaceCard({ kind: "country", iso, name: countryJa(iso) || (GEO && ((GEO.features.find((f) => f.id === iso) || {}).properties || {}).name) || iso })) };
}
// Wikipedia（日本語版）の要約と写真（公開の API。送るのは地名だけ）。カードの中に表示する
const WIKI_CACHE = {};
async function wikiSummary(name) {
  if (!navigator.onLine) return null;
  if (!(name in WIKI_CACHE)) WIKI_CACHE[name] = fetch(`https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return WIKI_CACHE[name];
}
// 国・首都・都市をクリックしたときの小さなカード（Wikipedia へのリンク）。公館のある国なら公館カードを開く
function openPlaceCard(p) {
  if (p.kind === "country") {
    const posts = postsInCountry(p.iso);
    if (posts.length) { openPostCard(posts); return; }
  }
  let el = $("#postcard");
  if (!el) { openPostCard([]); el = $("#postcard"); }
  const country = p.kind === "country" ? p.name : countryJa(p.iso);
  const posts = p.iso ? postsInCountry(p.iso) : [];
  const a = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text} ↗</a>`;
  el.querySelector(".pchead b").textContent = p.kind === "country" ? "国" : p.kind === "capital" ? "首都" : "都市";
  el.querySelector(".pcbody").innerHTML = `<section class="pc">
    <h3>${p.kind === "capital" ? "★ " : p.kind === "city" ? "● " : ""}${esc(p.name)} ${country && p.kind !== "country" ? `<span class="muted">${esc(country)}</span>` : ""}</h3>
    ${p.pop ? `<p>人口 ${popLabel(p.pop)}<span class="muted">（Natural Earth の推計）</span></p>` : ""}
    ${p.kind === "country" ? '<p class="muted">この国の月報はありません（公館がない、または巡回先の国）。</p>' : ""}
    <div class="pcblock pclinks"><div class="muted">リンク（インターネットが必要です）</div>
      <div>${a(wikiUrl(p.name), `📖 Wikipedia「${esc(p.name)}」`)}</div>
      ${p.kind !== "country" && country ? `<div>${a(wikiUrl(country), `📖 Wikipedia「${esc(country)}」`)}</div>` : ""}</div>
    ${posts.length ? `<div class="pcblock"><button class="linklike" data-place-posts="${esc(posts.join("|"))}">この国の公館カードを開く（${esc(posts.join("・"))}）</button></div>` : ""}
  </section>`;
  el.hidden = false;
  placeCard(el);
  // Wikipedia の要約（冒頭の数行）と写真をカードに出す
  const box = document.createElement("div");
  box.className = "pcblock wikisum";
  box.innerHTML = navigator.onLine ? '<span class="muted">Wikipedia を読み込み中…</span>' : '<span class="muted">（インターネットにつながっていないため、Wikipedia の要約は表示できません）</span>';
  el.querySelector(".pc").appendChild(box);
  const want = p.name;
  wikiSummary(p.name).then((w) => {
    if (!box.isConnected || el.querySelector(".pc h3").textContent.indexOf(want) < 0) return;
    box.innerHTML = w && w.extract
      ? `${w.thumbnail ? `<img src="${esc(w.thumbnail.source)}" alt="" referrerpolicy="no-referrer">` : ""}<p>${esc(w.extract)}</p><div class="muted">出典：Wikipedia（日本語版）「${esc(w.title || p.name)}」（CC BY-SA）</div>`
      : navigator.onLine ? '<span class="muted">Wikipedia の要約は見つかりませんでした。上のリンクから開いてください。</span>' : box.innerHTML;
  });
  const pb = el.querySelector("[data-place-posts]");
  if (pb) pb.onclick = () => openPostCard(pb.dataset.placePosts.split("|"));
}

const MIN_FULL = 8;
function blend(hex, w = 0.45) {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * w + 255 * (1 - w)));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
const EVENT_STYLE = { "感染症": ["cross", "#B00020"], "気象・災害": ["square", "#E67E22"], "治安・社会": ["triangle-up", "#5D4037"], "邦人保護": ["diamond", "#1565C0"] };

function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

// 地図は Plotly の geo（地球儀＝orthographic／平面＝natural earth）で描く。
// 陸地・国境の下地は lib/topojson/ に同梱したデータを使い、外部CDNには取りに行かない。
// 各ページの地図部品は従来どおり x=経度, y=緯度 の scatter と countryTrace() で組み立て、
// 描画直前に toGeoTraces() で geo 用のトレースに変換する。
// 地図の上のツールバー（平行移動・拡大・選択・リセット）は出さない。地球儀は回転とホイール拡大だけにする
const MAP_CONFIG = { responsive: true, displaylogo: false, displayModeBar: false, scrollZoom: false, topojsonURL: "lib/topojson/" };
// 地球儀で選べる地域（六大州）。[経度, 緯度] は地球儀の中心にする位置（アジアは中東から日本まで見えるように）
const ROTATIONS = { asia: [85, 28], europe: [15, 50], africa: [20, 2], namerica: [-98, 38], samerica: [-60, -18], oceania: [150, -22] };
const ROT_LABELS = [["asia", "アジア"], ["europe", "ヨーロッパ"], ["africa", "アフリカ"], ["namerica", "北アメリカ"], ["samerica", "南アメリカ"], ["oceania", "オセアニア"]];
let mapView = null;
// 地図は平面が標準で、地球儀は選んだときだけ（以前の版で地球儀を覚えていた場合も一度だけ平面に戻す）
function view() {
  if (mapView) return mapView;
  const p = loadPrefs(), saved = Object.assign({}, p.mapView || {});
  if (!p.flatDefault) { saved.style = "flat"; savePref("flatDefault", 1); }
  return (mapView = Object.assign({ style: "flat", lon: 60, lat: 15 }, saved));
}

function baseTraces() { return []; }
function countryTrace(iso, color, name, hover, legend) {
  return { type: "choropleth", geojson: GEO, featureidkey: "id", locations: [iso], z: [1], zmin: 0, zmax: 1,
    colorscale: [[0, color], [1, color]], showscale: false, name, legendgroup: name, showlegend: false,
    marker: { line: { color: "#ffffff", width: 0.5 } }, text: [hover], hoverinfo: hover ? "text" : "skip", _legend: legend, _color: color };
}
function toGeoTraces(traces) {
  const out = [];
  // 同じ色・同じ凡例名の国はまとめて1つのトレースにする（トレース数が多いとドラッグやズームが重くなる）
  const merged = new Map();
  for (const t of traces) {
    if (!t) continue;
    if (t.type === "choropleth") {
      const key = `${t.name}|${t._color}`;
      const c = merged.get(key);
      if (c) {
        c.locations.push(...t.locations); c.z.push(...t.z); c.text.push(...t.text);
        if (t.hoverinfo !== "skip") c.hoverinfo = "text";
        continue;
      }
      const { _legend, _color, ...rest } = t;
      const nc = { ...rest, locations: [...t.locations], z: [...t.z], text: [...t.text] };
      merged.set(key, nc);
      out.push(nc);
      // 塗り分けの凡例は四角い印で出す
      if (_legend) out.push({ type: "scattergeo", mode: "markers", lon: [null], lat: [null], name: t.name, legendgroup: t.name, marker: { symbol: "square", size: 12, color: _color } });
    } else {
      const { x, y, fill, hoveron, ...g } = t;
      out.push({ ...g, type: "scattergeo", lon: x, lat: y });
    }
  }
  return out;
}
// ---- 地球儀の衛星写真（NASA Blue Marble／Earth at Night。lib/earth/、パブリックドメイン）
// Plotly の地球儀は画像を貼れないので、地図の下にキャンバスを置き、Plotly と同じ正射図法で写真を描き直す。
// 回転・拡大で投影が変わったら、動いている間は粗く、止まったら細かく描く
// 画像は 2048×1024（軽い）と 4096×2048（細かい）の2種類。細かいほうは必要になったとき（拡大したとき・高解像度の画面）だけ読み込む
const EARTH_SKINS = {
  blue: { src: "lib/earth/blue-marble.jpg", hi: "lib/earth/blue-marble-4k.jpg", gain: 1.12 },
  night: { src: "lib/earth/earth-night.jpg", hi: "lib/earth/earth-night-4k.jpg", gain: 1.9 },
};
const TEXTURES = {};
function loadTexture(skin, hi = false) {
  const key = skin + (hi ? ":hi" : "");
  return (TEXTURES[key] ||= new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const x = c.getContext("2d"); x.drawImage(img, 0, 0);
      res({ w: img.width, h: img.height, px: x.getImageData(0, 0, img.width, img.height).data });
    };
    img.onerror = rej;
    img.src = hi ? EARTH_SKINS[skin].hi : EARTH_SKINS[skin].src;
  }));
}
// 衛星写真のときは国の塗り分けを半透明にして、下の写真が透けるようにする
function skinTraces(data) {
  const v = view(), sat = v.style === "globe" && EARTH_SKINS[v.skin];
  for (const t of data) if (t.type === "choropleth") t.marker = Object.assign({}, t.marker, { opacity: sat ? (v.skin === "night" ? 0.4 : 0.5) : 1 });
  return data;
}
function bindSatellite(el) {
  if (el._sat) { cancelAnimationFrame(el._sat.raf); clearTimeout(el._sat.fine); }
  const v = view(), skin = v.style === "globe" ? v.skin : null;
  let cv = el.querySelector(":scope > canvas.sattex");
  if (!EARTH_SKINS[skin]) { if (cv) cv.remove(); el._sat = null; return; }
  if (!cv) { cv = document.createElement("canvas"); cv.className = "sattex"; el.insertBefore(cv, el.firstChild); }
  const st = (el._sat = { raf: 0, fine: 0, key: "", tex: null, skin, hi: false, hiLoading: false });
  loadTexture(skin).then((tex) => { if (el._sat === st && !st.hi) { st.tex = tex; st.key = ""; } }).catch(() => toast("衛星画像を読み込めませんでした"));
  // 画面に出る地球の細かさ（赤道1周ぶんの画面上の画素数）が軽い画像の横幅を超えたら、細かい画像に切り替える
  const needHi = (p) => 2 * Math.PI * p.scale() * Math.min(2, window.devicePixelRatio || 1) > 2048 * 1.1;
  const loop = () => {
    if (el._sat !== st) return;
    if (!document.body.contains(el)) { el._sat = null; return; }
    const g = el._fullLayout && el._fullLayout.geo && el._fullLayout.geo._subplot;
    if (g && g.projection && !st.hi && !st.hiLoading && needHi(g.projection)) {
      st.hiLoading = true;
      loadTexture(skin, true).then((tex) => { if (el._sat === st) { st.tex = tex; st.hi = true; st.key = ""; } }).catch(() => {});
    }
    if (st.tex && g && g.projection) {
      const p = g.projection, key = [p.rotate().map((x) => x.toFixed(2)), p.scale().toFixed(1), p.translate().map((x) => x.toFixed(1)), el.clientWidth, el.clientHeight].join("|");
      if (key !== st.key) {
        st.key = key;
        paintEarth(el, cv, p, st.tex, EARTH_SKINS[skin].gain, 0.5, false);  // 動いている間は半分の解像度
        clearTimeout(st.fine);
        // 止まったら画面の解像度で、画素の間をなめらかにつないで（双線形補間）描く
        st.fine = setTimeout(() => el._sat === st && paintEarth(el, cv, p, st.tex, EARTH_SKINS[skin].gain, Math.min(1.5, window.devicePixelRatio || 1), true), 140);
      }
    }
    st.raf = requestAnimationFrame(loop);
  };
  loop();
}
function paintEarth(el, cv, proj, tex, gain, res, smooth) {
  const W = el.clientWidth, H = el.clientHeight;
  const cw = Math.max(1, Math.round(W * res)), ch = Math.max(1, Math.round(H * res));
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  cv.style.width = W + "px"; cv.style.height = H + "px";
  clipToGeo(el, cv);
  const ctx = cv.getContext("2d"), img = ctx.createImageData(cw, ch), out = img.data;
  const [tx, ty] = proj.translate(), k = proj.scale(), r = proj.rotate(), rad = Math.PI / 180;
  const lon0 = -r[0] * rad, lat0 = -r[1] * rad, s0 = Math.sin(lat0), c0 = Math.cos(lat0);
  const { w: tw, h: th, px } = tex;
  // 地球の円が入る範囲だけ計算する
  const x0 = Math.max(0, Math.floor((tx - k) * res)), x1 = Math.min(cw, Math.ceil((tx + k) * res));
  const y0 = Math.max(0, Math.floor((ty - k) * res)), y1 = Math.min(ch, Math.ceil((ty + k) * res));
  for (let py = y0; py < y1; py++) {
    const y = (ty - (py + 0.5) / res) / k;  // 上が正
    for (let pxi = x0; pxi < x1; pxi++) {
      const x = ((pxi + 0.5) / res - tx) / k, rr = x * x + y * y;
      if (rr > 1) continue;
      const cc = Math.sqrt(1 - rr);  // 正射図法の逆変換（中心 lon0, lat0）
      const lat = Math.asin(cc * s0 + y * c0), lon = lon0 + Math.atan2(x, cc * c0 - y * s0);
      const u = ((lon / (2 * Math.PI) + 0.5) % 1 + 1) % 1, vv = 0.5 - lat / Math.PI;
      const shade = gain * (0.62 + 0.38 * cc);  // 縁を少し暗くして球らしく
      const o = (py * cw + pxi) * 4;
      if (smooth) {
        // 双線形補間：周りの4画素を距離で混ぜる（経度方向は端でつながる）
        const fx = u * tw - 0.5, fy = Math.max(0, Math.min(th - 1.001, vv * th - 0.5));
        const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
        const xa = ((ix % tw) + tw) % tw, xb = (xa + 1) % tw, ya = iy * tw, yb = Math.min(th - 1, iy + 1) * tw;
        const i00 = (ya + xa) * 4, i10 = (ya + xb) * 4, i01 = (yb + xa) * 4, i11 = (yb + xb) * 4;
        const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
        for (let c = 0; c < 3; c++) out[o + c] = Math.min(255, (px[i00 + c] * w00 + px[i10 + c] * w10 + px[i01 + c] * w01 + px[i11 + c] * w11) * shade);
      } else {
        const ti = ((Math.min(th - 1, (vv * th) | 0) * tw) + Math.min(tw - 1, (u * tw) | 0)) * 4;
        out[o] = Math.min(255, px[ti] * shade); out[o + 1] = Math.min(255, px[ti + 1] * shade); out[o + 2] = Math.min(255, px[ti + 2] * shade);
      }
      out[o + 3] = rr > 0.995 ? 255 * (1 - rr) / 0.005 : 255;  // 縁をなめらかに
    }
  }
  ctx.putImageData(img, 0, 0);
}

function mapLayout(height = 560, forExport = false, flat = null) {
  const v = view();
  const globe = flat === null ? v.style === "globe" : !flat;
  // 衛星写真（地球儀のみ）のときは陸・海の塗りを消して、下に描いた写真を見せる
  const sat = globe && !forExport && !!EARTH_SKINS[v.skin];
  const grid = { showgrid: globe, gridcolor: sat ? "rgba(255,255,255,.18)" : "rgba(120,140,160,.25)", gridwidth: 0.5 };
  return {
    // ドラッグは bindMapInteraction() で自前処理する（地球儀は回転、平面は東西に回すだけ）。Plotly の平行移動は使わない
    height, margin: { l: 0, r: 0, t: 10, b: 0 }, hovermode: "closest", dragmode: false,
    geo: {
      projection: { type: globe ? "orthographic" : "natural earth", rotation: { lon: globe ? v.lon : forExport ? 0 : v.flatLon || 0, lat: globe ? v.lat : 0 } },
      // 地球儀は中心＝回転の向きに固定する（ずれると地球儀が画面の中で横にずれて欠ける）
      ...(globe ? { center: { lon: v.lon, lat: v.lat } } : {}),
      showland: !sat, landcolor: forExport ? "#dde3ea" : css("--land") || "#dde3ea",
      showocean: !sat, oceancolor: forExport ? "#eef4f8" : css("--ocean") || "#e4eef5",
      showcountries: true, countrycolor: sat ? "rgba(255,255,255,.55)" : forExport ? "#ffffff" : css("--surface") || "#ffffff", countrywidth: sat ? 0.6 : 0.5,
      showcoastlines: false, showlakes: false, showframe: false, bgcolor: "rgba(0,0,0,0)",
      lonaxis: grid, lataxis: globe ? grid : { ...grid, range: [-58, 85] },
    },
    legend: { orientation: "h", y: -0.02, x: 0, font: { size: 11 } },
    paper_bgcolor: forExport ? "#ffffff" : "rgba(0,0,0,0)",
    font: { color: forExport ? "#1c2430" : css("--text") },
  };
}
// 地図ごとの動き（飛行機・新着アラートの点滅）。ページを切り替えたら止める
const ANIM = {};
function stopAnim(id) {
  const a = ANIM[id];
  if (a) { a.stop = true; cancelAnimationFrame(a.raf); if (a.layer) a.layer.remove(); delete ANIM[id]; }
}
function stopAllAnim() { Object.keys(ANIM).forEach(stopAnim); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 2地点を結ぶ大圏上の点（t=0〜1）
function gcPoint([lat1, lon1], [lat2, lon2], t) {
  const r = Math.PI / 180;
  const v = (la, lo) => [Math.cos(la * r) * Math.cos(lo * r), Math.cos(la * r) * Math.sin(lo * r), Math.sin(la * r)];
  const a = v(lat1, lon1), b = v(lat2, lon2);
  const d = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  if (d < 1e-6) return [lat1, lon1];
  const k1 = Math.sin((1 - t) * d) / Math.sin(d), k2 = Math.sin(t * d) / Math.sin(d);
  const p = [0, 1, 2].map((i) => k1 * a[i] + k2 * b[i]);
  return [Math.atan2(p[2], Math.hypot(p[0], p[1])) / r, Math.atan2(p[1], p[0]) / r];
}

// 線の上にマウスを載せたときの吹き出し：大圏に沿って見えない点を並べる（Plotly は線そのものには吹き出しを出さないため）
function lineHover(a, b, text, color, group) {
  const pts = Array.from({ length: 25 }, (_, i) => gcPoint(a, b, (i + 0.5) / 25));
  return { x: pts.map((q) => q[1]), y: pts.map((q) => q[0]), type: "scatter", mode: "markers", legendgroup: group, showlegend: false,
    marker: { size: 14, color: "rgba(0,0,0,0)" }, text: pts.map(() => text), hoverinfo: "text", hoverlabel: { bgcolor: color, font: { color: "#fff" } } };
}

let touring = false;
function drawMap(id, traces, height = 480, { highlight = false } = {}) {
  const el = typeof id === "string" ? document.getElementById(id) : id;
  if (!el) return Promise.resolve();
  stopAnim(el.id);
  const data = toGeoTraces(traces);
  // 巡回健診・異動の線の上を飛ぶ飛行機
  const routes = mapOpt.planes ? data.filter((t) => t.mode === "lines" && (t.legendgroup === "jk" || t.legendgroup === "tr" || t.legendgroup === "ev") && t.lon && t.lon.length === 2)
    .map((t) => ({ a: [t.lat[0], t.lon[0]], b: [t.lat[1], t.lon[1]], color: t.line.color })) : [];
  el._hlIdx = -1;
  if (highlight) {
    data.push({ type: "scattergeo", mode: "markers", name: "_hl", lon: [null], lat: [null], hoverinfo: "skip", showlegend: false,
      marker: { size: 54, color: "rgba(255,193,7,0.18)", line: { color: "#f59e0b", width: 3 } } });
    el._hlIdx = data.length - 1;
  }
  skinTraces(data);
  return Plotly.react(el, data, mapLayout(height), MAP_CONFIG).then(() => {
    bindSatellite(el);
    markPulse(el);
    el._labelDetail = undefined;
    updateLabelDetail(el);
    if (routes.length) animatePlanes(el, routes);
    if (el._bound) return;
    el._bound = true;
    bindMapInteraction(el);
    el.on("plotly_afterplot", () => { markPulse(el); widenGeoClip(el); keepTourZoom(el); fixGlobeScale(el); updateLabelDetail(el); });
    // 地球儀は画面の中で動かさない：中心が回転の向きからずれたら（Plotly 側の操作など）すぐ戻す
    el.on("plotly_relayout", (e) => {
      const fl = el._fullLayout && el._fullLayout.geo;
      if (!fl || fl.projection.type !== "orthographic") return;
      const rot = fl.projection.rotation, c = fl.center;
      if (Math.abs(((c.lon - rot.lon + 540) % 360) - 180) > 0.01 || Math.abs(c.lat - rot.lat) > 0.01)
        Plotly.relayout(el, { "geo.center.lon": rot.lon, "geo.center.lat": rot.lat });
    });
    // 地球儀をドラッグで回した向きを覚えておく（ツアー中の自動回転は除く）
    el.on("plotly_relayout", (e) => {
      if (touring) return;
      const lon = e["geo.projection.rotation.lon"], lat = e["geo.projection.rotation.lat"];
      if (lon === undefined && lat === undefined) return;
      const v = view();
      if (el._fullLayout.geo.projection.type !== "orthographic") { if (lon !== undefined) { v.flatLon = lon; savePref("mapView", v); } return; }
      // 自分でドラッグして回したら、地域のボタンの選択を外す
      if (!el._spinRelayout && v.rot) { delete v.rot; document.querySelectorAll(".mapctl [data-rot]").forEach((x) => x.classList.remove("on")); }
      if (lon !== undefined) v.lon = lon;
      if (lat !== undefined) v.lat = lat;
      savePref("mapView", v);
    });
    // マウスを載せた国・首都・都市・公館の印は、指の形のカーソルにし、少し止めたら（約0.35秒）そのカードを開く
    el.on("plotly_hover", (e) => {
      const pt = e.points && e.points[0];
      const target = hoverTarget(pt);
      el.classList.toggle("pc-hover", !!target);
      clearTimeout(el._hoverTimer);
      if (!target || el.classList.contains("grabbing") || el.classList.contains("dragging")) return;
      el._hoverTimer = setTimeout(() => {
        if (el.classList.contains("dragging") || cardKey === target.key) return;
        cardKey = target.key;
        target.open();
      }, 350);
    });
    el.on("plotly_unhover", () => { clearTimeout(el._hoverTimer); el.classList.remove("pc-hover"); });
    // 国や印をクリックすると公館カードを開く
    el.on("plotly_click", (e) => {
      if (suppressClick) return;
      const pt = e.points && e.points[0];
      if (!pt) return;
      // 国名・首都・都市の印は、Wikipedia へのリンクのカード（公館のある国は公館カード）
      if (pt.customdata && typeof pt.customdata === "object" && pt.customdata.kind) { openPlaceCard(pt.customdata); return; }
      const posts = typeof pt.customdata === "string" ? [pt.customdata] : pt.location ? postsInCountry(pt.location) : [];
      if (posts.length) openPostCard(posts);
      else if (pt.location) openPlaceCard({ kind: "country", iso: pt.location, name: countryJa(pt.location) || (GEO && ((GEO.features.find((f) => f.id === pt.location) || {}).properties || {}).name) || pt.location });
    });
  });
}

// 地図が描かれる枠（Plotly の clipPath）の外に飛行機がはみ出さないよう、重ねた層を同じ枠で切り抜く
// 地球儀を拡大したときに、Plotly が地球儀に掛けている四角い切り抜き（地球儀の幅だけ）を地図全体に広げる
// （広げないと、拡大したとき左右が縦にすっぱり切れて見える）。衛星写真・乗り物の重ね絵も同じ範囲になる
function widenGeoClip(el) {
  if (!el._fullLayout || !el._fullLayout.geo || el._fullLayout.geo.projection.type !== "orthographic") return;
  const r = el.querySelector('clipPath[id$="geo"] rect'), W = el._fullLayout.width, H = el._fullLayout.height;
  if (r && (+r.getAttribute("width") !== W || +r.getAttribute("height") !== H)) { r.setAttribute("x", 0); r.setAttribute("y", 0); r.setAttribute("width", W); r.setAttribute("height", H); }
  // 国の形などは地図の投影法（d3）の切り抜き範囲でも切られるので、そちらも広げる
  const g = el._fullLayout.geo && el._fullLayout.geo._subplot, p = g && g.projection;
  if (!p || !p.clipExtent) return;
  const ce = p.clipExtent();
  if (!ce || ce[0][0] !== 0 || ce[0][1] !== 0 || ce[1][0] !== W || ce[1][1] !== H) { p.clipExtent([[0, 0], [W, H]]); g.render(); }
}
function clipToGeo(el, layer) {
  const r = el.querySelector('clipPath[id$="geo"] rect');
  if (!r) return;
  const x = +r.getAttribute("x"), y = +r.getAttribute("y"), w = +r.getAttribute("width"), h = +r.getAttribute("height");
  const v = `inset(${y}px ${el.clientWidth - x - w}px ${el.clientHeight - y - h}px ${x}px)`;
  if (layer._clip !== v) layer.style.clipPath = layer._clip = v;
}

// 飛行機は地図の再描画をせず、地図の上に重ねた ✈ を動かすだけにする（ドラッグ・ズームを邪魔しない）
function animatePlanes(el, routes) {
  let layer = el.querySelector(":scope > .planes");
  if (!layer) { layer = document.createElement("div"); layer.className = "planes"; el.appendChild(layer); }
  layer.innerHTML = routes.map((r) => `<span style="color:${r.color}">✈</span>`).join("");
  const spans = [...layer.children];
  const a = (ANIM[el.id] = { stop: false, layer });
  const t0 = performance.now();
  const rad = Math.PI / 180;
  const frame = (now) => {
    if (a.stop || !document.body.contains(el)) { layer.remove(); return; }
    const g = el._fullLayout && el._fullLayout.geo && el._fullLayout.geo._subplot;
    if (g && g.projection) {
      clipToGeo(el, layer);
      const proj = g.projection, rot = proj.rotate();
      const globe = !!(proj.clipAngle && proj.clipAngle());
      // 地球儀の正面の中心（この点から90度以上離れた点は裏側）
      const cLon = -rot[0] * rad, cLat = -rot[1] * rad;
      routes.forEach((r, i) => {
        const t = ((now - t0) / 4200 + i * 0.37) % 1;
        const [lat, lon] = gcPoint(r.a, r.b, t);
        const [lat2, lon2] = gcPoint(r.a, r.b, Math.min(1, t + 0.01));
        const front = !globe || Math.sin(cLat) * Math.sin(lat * rad) + Math.cos(cLat) * Math.cos(lat * rad) * Math.cos(lon * rad - cLon) > 0.02;
        const p = front && proj([lon, lat]), q = front && proj([lon2, lat2]);
        if (!p || !q || Number.isNaN(p[0])) { spans[i].style.opacity = 0; return; }
        const ang = Math.atan2(q[1] - p[1], q[0] - p[0]) / rad;
        spans[i].style.opacity = 1;
        spans[i].style.transform = `translate(${p[0]}px, ${p[1]}px) translate(-50%, -50%) rotate(${ang}deg)`;
      });
    }
    a.raf = requestAnimationFrame(frame);
  };
  a.raf = requestAnimationFrame(frame);
}

// 地図の操作（ドラッグで回転・ホイール／ピンチで拡大）を自前で行う。
// Plotly 標準の操作はマウスが動くたびに地図全体を描き直すため重い。ここでは
// 1フレームに1回だけ軽い再描画（render）を行い、手を離したときに一度だけ Plotly に位置を伝える。
// 地球儀・平面とも地図の枠は動かさない（平行移動はしない）。平面のドラッグは東西に回すだけで、拡大もしない。
// ---- 地球儀の大きさ：拡大率（el._zoom、基準の大きさに対する比）を覚え、描き直しのたびに実際の大きさをそれに合わせる
// Plotly の fitScale は地球儀の向きによって2倍になることがある（例：アジアに向けると2倍）ので、基準には使わない。
// 基準＝地図の描画範囲の短い辺の半分（拡大率1で地球儀がちょうど収まる半径）
const globeBase = (el) => { const s = el._fullLayout && el._fullLayout._size; return s ? Math.min(s.w, s.h) / 2 : 275; };
function fixGlobeScale(el) {
  if (el._fixingScale || el._animating) return;
  const g = el._fullLayout && el._fullLayout.geo && el._fullLayout.geo._subplot;
  if (!g || !g.projection || !g.projection.clipAngle || !g.projection.clipAngle()) return;
  const want = (el._zoom || 1) * globeBase(el);
  if (Math.abs(g.projection.scale() - want) <= 1) return;
  el._fixingScale = true;
  Plotly.relayout(el, { "geo.projection.scale": want / g.fitScale }).finally(() => (el._fixingScale = false));
}
function bindMapInteraction(el) {
  const sub = () => el._fullLayout && el._fullLayout.geo && el._fullLayout.geo._subplot;
  const isGlobe = () => { const g = sub(); return !!(g && g.projection && g.projection.clipAngle && g.projection.clipAngle()); };
  // 1px のドラッグで回す角度。地球儀は半径から、平面（Natural Earth、横幅≒5.47×拡大率で360度）は横幅から
  const degPerPx = (g) => (isGlobe() ? 180 / Math.PI / g.projection.scale() : 360 / (5.47 * g.projection.scale()));
  let raf = null, syncTimer = null;
  let want = null;         // 目標 { scale, rot } — rAF で近づける
  let dirty = false;

  const frame = () => {
    raf = null;
    const g = sub();
    if (!g || !want) return;
    let more = false;
    if (want.scale != null) {
      const cur = g.projection.scale();
      // ホイールの拡大縮小は、目標の大きさへ少しずつ近づける（比で近づけて、なめらかに）
      const next = Math.abs(Math.log(want.scale / cur)) < 0.003 ? want.scale : cur * Math.pow(want.scale / cur, 0.25);
      g.projection.scale(next);
      more = next !== want.scale;
    }
    if (want.rot) g.projection.rotate(want.rot);
    g.render();
    dirty = true;
    if (more) raf = requestAnimationFrame(frame);
    else if (!dragging && !inertia) scheduleSync(60);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  // Plotly に現在の拡大率・向きを伝える（以後の再描画や平面のパンでずれないように）
  const sync = () => {
    clearTimeout(syncTimer);
    const g = sub();
    if (!g || !dirty) return;
    dirty = false;
    const r = g.projection.rotate();
    const upd = { "geo.projection.scale": g.projection.scale() / g.fitScale };
    if (isGlobe()) el._zoom = g.projection.scale() / globeBase(el);   // 自分で拡大縮小した大きさを覚える
    if (isGlobe()) {
      upd["geo.projection.rotation.lon"] = -r[0]; upd["geo.projection.rotation.lat"] = -r[1];
      upd["geo.center.lon"] = -r[0]; upd["geo.center.lat"] = -r[1];
    } else {
      upd["geo.projection.rotation.lon"] = -r[0]; upd["geo.center.lon"] = -r[0];
      upd["geo.projection.scale"] = 1;
    }
    want = null;
    Plotly.relayout(el, upd);
  };
  const scheduleSync = (ms) => { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); };
  el._syncView = sync;

  // ---- ホイールで拡大縮小
  // マウスが地球（平面なら地図の枠）の上にあるときだけ拡大縮小する。周りの余白では画面をスクロールさせる
  const overMap = (e) => {
    const g = sub();
    if (!g || !g.projection) return false;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (isGlobe()) {
      const [cx, cy] = g.projection.translate();
      return Math.hypot(x - cx, y - cy) <= g.projection.scale();
    }
    const xa = g.xaxis, ya = g.yaxis;
    return x >= xa._offset && x <= xa._offset + xa._length && y >= ya._offset && y <= ya._offset + ya._length;
  };
  el.addEventListener("wheel", (e) => {
    const g = sub();
    if (!g || !g.projection || !isGlobe() || !overMap(e)) return;  // 平面は拡大しない（枠の中で動かさない）
    e.preventDefault();
    if (touring) el._camUser = true;   // ツアー中にホイールで拡大縮小したら、その拡大率を優先する
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const base = want && want.scale != null ? want.scale : g.projection.scale();
    want = Object.assign(want || {}, { scale: Math.min(globeBase(el) * 12, Math.max(globeBase(el) * 0.7, base * Math.exp(-dy * 0.0016))) });
    clearTimeout(syncTimer);
    kick();
  }, { passive: false });

  // ---- 地球儀のドラッグ回転（1本指）とピンチ拡大（2本指）
  const pts = new Map();
  let dragging = false, start = null, moved = false, pinch = null;
  const inMap = (e) => !e.target.closest(".modebar, .legend, .planes") && e.target.closest(".geo, .geolayer, .bglayer, svg");
  // 手を離した後も少し回り続ける（慣性）
  let inertia = null, samples = [];
  const stopInertia = () => { if (inertia) { cancelAnimationFrame(inertia.raf); inertia = null; } };
  const startInertia = () => {
    const now = performance.now();
    const last = samples[samples.length - 1];
    // 離す直前まで動いていたときだけ、最後の約0.12秒の動きから速さを求める
    if (!last || now - last.t > 80) return false;
    const recent = samples.filter((p) => last.t - p.t <= 120);
    const a = recent.length >= 2 ? recent[0] : samples[samples.length - 2], b = last;
    if (!a || a === b) return false;
    const dt = Math.max(8, b.t - a.t);
    let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;   // px/ms
    if (Math.hypot(vx, vy) < 0.08) return false;
    let prevT = now;
    const step = (t) => {
      const g = sub();
      if (!g || !inertia) return;
      const d = Math.min(40, t - prevT); prevT = t;
      const k = degPerPx(g);
      const r = (want && want.rot) || g.projection.rotate();
      want = Object.assign(want || {}, { rot: [r[0] + vx * d * k, isGlobe() ? Math.max(-80, Math.min(80, r[1] - vy * d * k)) : r[1], 0] });
      kick();
      const f = Math.exp(-d / 320);
      vx *= f; vy *= f;
      if (Math.hypot(vx, vy) < 0.01) { inertia = null; scheduleSync(60); return; }
      inertia.raf = requestAnimationFrame(step);
    };
    inertia = { raf: requestAnimationFrame(step) };
    return true;
  };

  // 地球儀の上では Plotly 標準のドラッグ（地図を平行移動させてしまう）に渡さない。回転はこの下の自前処理だけで行う
  const block = (e) => { if (inMap(e)) e.stopPropagation(); };
  el.addEventListener("mousedown", block, true);
  el.addEventListener("touchstart", block, { capture: true, passive: true });
  el.addEventListener("pointerdown", (e) => {
    if ((e.pointerType === "mouse" && e.button !== 0) || !inMap(e)) return;
    const g = sub();
    stopInertia();
    clearTimeout(syncTimer);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    el.classList.add("grabbing");
    if (pts.size === 1) {
      dragging = true; moved = false; samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      start = { x: e.clientX, y: e.clientY, rot: g.projection.rotate().slice() };
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), scale: g.projection.scale() };
    }
  });
  el.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const g = sub();
    if (!g) return;
    if (pinch && pts.size >= 2 && isGlobe()) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      want = Object.assign(want || {}, { scale: Math.min(globeBase(el) * 12, Math.max(globeBase(el) * 0.7, pinch.scale * d / pinch.d)) });
      moved = true; kick();
      return;
    }
    if (!dragging || !start) return;
    samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
    if (samples.length > 12) samples.shift();
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved && touring) {
      // ツアー中につかんだら、この移動のあいだはカメラを手に渡す（飛行機・線は描き続ける）。つかんだ時点の向きから回す
      el._camUser = true;
      start = { x: e.clientX, y: e.clientY, rot: g.projection.rotate().slice() };
      samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      moved = true; el.classList.add("dragging"); Plotly.Fx.unhover(el);
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても回せる */ }
      return;
    }
    if (!moved) { moved = true; try { el.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても回せる */ } el.classList.add("dragging"); Plotly.Fx.unhover(el); }
    // 地球の半径（px）＝拡大率。1px 動かしたときの角度を求めて回す。平面は東西に回すだけ（上下には動かさない）
    const k = degPerPx(g);
    const lat = isGlobe() ? Math.max(-80, Math.min(80, start.rot[1] - dy * k)) : start.rot[1];
    want = Object.assign(want || {}, { rot: [start.rot[0] + dx * k, lat, 0] });
    kick();
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      dragging = false; start = null;
      el.classList.remove("dragging", "grabbing");
      if (moved) {
        if (!startInertia()) scheduleSync(0);
        suppressClick = true; setTimeout(() => (suppressClick = false), 50);
      }
      // ツアー中に地図をクリック（ドラッグせずに離した）したら一時停止する。再開は「▶ 再開」
      else if (touring && e.type === "pointerup" && typeof tour !== "undefined" && tour && !tour.paused && tour.playing) pauseTour("地図をクリックしたので一時停止しました");
    }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}
// ドラッグの直後に「クリック」と判定されてカードが開かないようにする
let suppressClick = false;

// 新着アラートの印を点滅させる（CSSで輪を広げる）
function markPulse(el) {
  if (!el.data) return;
  let k = -1;
  el.data.forEach((t, i) => { if (t.type === "scattergeo" && t.name === "新着アラート") k = i; });
  if (k < 0) return;
  const ord = el.data.slice(0, k).filter((t) => t.type === "scattergeo").length;
  const g = el.querySelectorAll(".scatterlayer .trace")[ord];
  if (g) g.classList.add("pulse");
}

function postsInCountry(iso) {
  const ps = new Set(Object.values(state.reports).map((r) => r.post).filter((p) => INFO[p] && INFO[p].iso3 === iso));
  return [...ps].sort((a, b) => a.localeCompare(b, "ja"));
}

// 地球儀／平面の切り替えと向きのボタン。ページ内のすべての地図に効く
function mapControls() {
  const v = view();
  return `<div class="row mapctl">
    <span class="seg"><button data-style="flat" class="${v.style === "flat" ? "on" : ""}">平面</button><button data-style="globe" class="${v.style === "globe" ? "on" : ""}">🌐 地球儀</button></span>
    <span class="seg skins"${v.style === "flat" ? " hidden" : ""}>${[["", "塗り分け"], ["blue", "🛰 衛星写真"], ["night", "🌃 夜の地球"]].map(([k, l]) => `<button data-skin="${k}" class="${(v.skin || "") === k ? "on" : ""}" title="${k ? "NASA の衛星画像" : "陸と海を単色で塗る"}">${l}</button>`).join("")}</span>
    <span class="seg rots"${v.style === "flat" ? " hidden" : ""}>${ROT_LABELS.map(([k, l]) => `<button data-rot="${k}" class="${v.rot === k ? "on" : ""}">${l}</button>`).join("")}</span>
    <span class="muted satcredit"${v.style === "globe" && EARTH_SKINS[v.skin] ? "" : " hidden"}>衛星画像：NASA（Blue Marble／Earth at Night）</span>
  </div>`;
}
function applyMapView() {
    const v = view(), globe = v.style === "globe";
    savePref("mapView", v);
    document.querySelectorAll(".mapctl [data-style]").forEach((b) => b.classList.toggle("on", b.dataset.style === v.style));
    document.querySelectorAll(".mapctl .rots, .mapctl .skins").forEach((x) => (x.hidden = !globe));
    document.querySelectorAll(".mapctl [data-skin]").forEach((b) => b.classList.toggle("on", b.dataset.skin === (v.skin || "")));
    document.querySelectorAll(".satcredit").forEach((x) => (x.hidden = !(globe && EARTH_SKINS[v.skin])));
    // 投影法を変えると地図の縦横比も変わるので、部分更新ではなく描き直す
    document.querySelectorAll(".js-plotly-plot").forEach((el) => {
      if (!el.layout || !el.layout.geo) return;
      skinTraces(el.data);
      Plotly.react(el, el.data, mapLayout(el.layout.height), MAP_CONFIG).then(() => { markPulse(el); bindSatellite(el); });
    });
}
function spinGlobeTo(el, lon, lat, ms = 1200) {
  const g = el._fullLayout && el._fullLayout.geo && el._fullLayout.geo._subplot;
  if (!g || !g.projection || !g.projection.clipAngle || !g.projection.clipAngle()) return;
  const r0 = g.projection.rotate(), lon0 = -r0[0], lat0 = -r0[1], sc0 = g.projection.scale();
  const dl = ((lon - lon0 + 540) % 360) - 180, dist = Math.min(1, Math.hypot(dl, lat - lat0) / 180);
  const t0 = performance.now(), dur = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : ms;
  el._spin = (el._spin || 0) + 1;
  const id = el._spin;
  el._animating = true;
  const step = (now) => {
    if (el._spin !== id) return;   // 別の地域が選ばれたら、そちらへ回り直す
    const t = Math.min(1, (now - t0) / dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    g.projection.rotate([-(lon0 + dl * e), -(lat0 + (lat - lat0) * e), 0]);
    // 回る途中で少し引いて戻る（対数の尺度で、なめらかに）
    g.projection.scale(sc0 * Math.pow(1 - 0.18 * dist, Math.sin(Math.PI * smoother(t))));
    g.render();
    if (t < 1) { requestAnimationFrame(step); return; }
    el._spinRelayout = true;
    el._animating = false;
    // 向きを変えると Plotly の基準の大きさが変わることがあるので、大きさは el._zoom から決め直す（急に大きさが変わらないように）
    Plotly.relayout(el, { "geo.projection.rotation.lon": lon, "geo.projection.rotation.lat": lat, "geo.center.lon": lon, "geo.center.lat": lat, "geo.projection.scale": sc0 / g.fitScale })
      .then(() => fixGlobeScale(el)).finally(() => (el._spinRelayout = false));
  };
  requestAnimationFrame(step);
}
function bindMapControls() {
  const apply = applyMapView;
  document.querySelectorAll(".mapctl [data-style]").forEach((b) => (b.onclick = () => { view().style = b.dataset.style; apply(); }));
  // 地域を選ぶと、地球儀がその地域までくるっと回る（約1.2秒。途中で少し引いて、着いたら元の大きさに）
  document.querySelectorAll(".mapctl [data-rot]").forEach((b) => (b.onclick = () => {
    const [lon, lat] = ROTATIONS[b.dataset.rot];
    Object.assign(view(), { lon, lat, rot: b.dataset.rot });
    savePref("mapView", view());
    document.querySelectorAll(".mapctl [data-rot]").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll(".js-plotly-plot").forEach((el) => spinGlobeTo(el, lon, lat));
  }));
  document.querySelectorAll(".mapctl [data-skin]").forEach((b) => (b.onclick = () => { view().skin = b.dataset.skin; apply(); }));
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
  // すべての国にマウスが反応するよう、透明な国の層をいちばん下に敷く（マウスを載せると国のカード）
  if (GEO) traces.push({ type: "choropleth", geojson: GEO, featureidkey: "id", locations: GEO.features.map((f) => f.id), z: GEO.features.map(() => 0), zmin: 0, zmax: 1,
    colorscale: [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0)"]], showscale: false, name: "_国（マウス）", showlegend: false, marker: { line: { width: 0 } },
    text: GEO.features.map(() => ""), hoverinfo: "none" });
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
  // 国名・首都・大きな都市（公館の印より下に描く）
  if (opt.labels) traces.push(...placeTraces(new Set(traces.filter((t) => t.type === "choropleth").flatMap((t) => t.locations || []))));
  if (opt.visits) {
    const rs = reportsOf(m).filter((r) => r.total !== null && coord(r.post));
    traces.push({ x: rs.map((r) => coord(r.post)[1]), y: rs.map((r) => coord(r.post)[0]), type: "scatter", mode: "markers",
      name: "受診者数（○の大きさ）", marker: { size: rs.map((r) => Math.max(5, 3 * Math.sqrt(r.total))), color: "rgba(0,0,0,0)", line: { color: css("--text") || "#263238", width: 1.3 } },
      text: rs.map((r) => `<b>${r.post}</b><br>医務官: ${r.officer || "―"}<br>受診者数: ${r.total}名<br><i>マウスを止めると公館カード</i>`), hoverinfo: "text",
      customdata: rs.map((r) => r.post) });
  }
  if (opt.alerts && m) {
    const g = {};
    for (const a of newAlerts(m)) if (coord(a.post)) (g[a.post] ||= []).push(a);
    const ps = Object.keys(g);
    if (ps.length) traces.push({ type: "scatter", mode: "markers", name: "新着アラート",
      x: ps.map((p) => coord(p)[1]), y: ps.map((p) => coord(p)[0]), customdata: ps,
      marker: { size: 24, color: "rgba(255,152,0,0.22)", line: { color: "#ff8f00", width: 2.5 } },
      text: ps.map((p) => `<b>新着 ${p}</b><br>` + g[p].map((a) => `${a.name}（${a.kind}${a.kind === "丙表に新登場" ? "" : "：" + a.detail}）`).join("<br>")), hoverinfo: "text" });
  }
  if (opt.junkai) {
    let first = true;
    for (const j of junkaiOf(m)) {
      const a = coord(j.from), b = coord(j.dest);
      if (!a || !b) continue;
      traces.push({ x: [a[1], b[1]], y: [a[0], b[0]], type: "scatter", mode: "lines", line: { width: 2.4, color: "#00897B" },
        name: "巡回健診", legendgroup: "jk", showlegend: first, hoverinfo: "skip" });
      traces.push(lineHover(a, b, `<b>🩺 巡回健診</b>${j.month ? " " + fmtMonth(j.month) : ""}<br>${j.from} → ${j.dest}${j.period ? "<br>" + j.period : ""}`, "#00897B", "jk"));
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
      traces.push(lineHover(a, b, `<b>👤 医務官の異動</b> ${fmtMonth(t.month)}<br>${t.after}：${t.from} → ${t.post}`, "#6A1B9A", "tr"));
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
        hoverinfo: "text", customdata: ps });
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
    hoverinfo: "text", customdata: ps,
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

// 画面の状態（対象月・開いているタブ・取り込みの対象月）をこのブラウザに覚えておき、再読み込みしても戻す
const PREFS_KEY = "geppou.prefs";
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
}
function savePref(key, value) {
  if (demoMode && key === "month") return;
  try {
    const p = loadPrefs();
    p[key] = value;
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch (e) { /* 保存できない環境では覚えないだけ */ }
}

function refreshMonths(select) {
  const ms = months();
  const cur = select || curMonth() || loadPrefs().month;
  $("#month").innerHTML = ms.length ? [...ms].reverse().map((m) => `<option value="${m}">${fmtMonth(m)}</option>`).join("") : `<option value="">（データなし）</option>`;
  if (cur && ms.includes(cur)) $("#month").value = cur;
  if (ms.length) savePref("month", $("#month").value);
}

// ----------------------------------------------------------------------- グラフの配色と共通の見た目
// 地域の色は検証済みパレット（色覚多様性に配慮した並び）を固定で割り当て、どのグラフでも同じ地域は同じ色にする
const isDark = () => { const t = document.documentElement.dataset.theme; return t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches); };
const REGION_COL = {
  light: { "アジア・大洋州": "#2a78d6", "アフリカ": "#eb6834", "ヨーロッパ": "#1baf7a", "中東": "#eda100", "米州": "#e87ba4" },
  dark: { "アジア・大洋州": "#3987e5", "アフリカ": "#d95926", "ヨーロッパ": "#199e70", "中東": "#c98500", "米州": "#d55181" },
};
const regionColor = (r, forExport = false) => ((forExport || !isDark() ? REGION_COL.light : REGION_COL.dark)[r] || "#8a8a85");
// 職員・家族・その他は1色相（青）の濃淡で
const VISIT_KEYS = [["staff", "職員", "#184f95"], ["family", "家族", "#3987e5"], ["other", "その他", "#86b6ef"]];
const UP_COL = "#e34948", DOWN_COL = "#2a78d6", OTHER_COL = "#b9b8b2";

function chartTemplate(forExport = false) {
  const ink = forExport ? "#52514e" : css("--muted") || "#52514e";
  const grid = forExport ? "#e6e5e0" : css("--border") || "#dde3ea";
  const surface = forExport ? "#ffffff" : css("--surface") || "#ffffff";
  const ax = { gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickfont: { color: ink, size: 12 }, title: { font: { color: ink, size: 12 } } };
  return {
    layout: { xaxis: ax, yaxis: ax, font: { size: 13 }, title: { x: 0, xanchor: "left", font: { size: 15 } }, bargap: 0.3,
      hoverlabel: { bgcolor: surface, bordercolor: grid, font: { color: forExport ? "#1c2430" : css("--text") } },
      // 凡例はグラフの下に置き、並びはデータの順のまま（タイトルと重ならないように）
      legend: { orientation: "h", x: 0, y: -0.14, yanchor: "top", traceorder: "normal", font: { size: 12 } } },
    // 積み上げの区切りが分かるよう、面と面の間に背景色の細い線を入れる
    data: { bar: [{ marker: { line: { color: surface, width: 1.5 } } }], pie: [{ marker: { line: { color: surface, width: 2 } } }] },
  };
}
function plot(el, traces, layout, config = {}) {
  const base = { paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: css("--text"), family: "inherit" },
    margin: { l: 90, r: 20, t: 56, b: 40 }, template: chartTemplate() };
  return Plotly.newPlot(el, traces, Object.assign(base, layout), Object.assign({ responsive: true, displaylogo: false }, config));
}

// ----------------------------------------------------------------------- 記述統計
function describe(vals) {
  const v = vals.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const total = v.reduce((a, b) => a + b, 0), mean = total / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const q = (p) => { const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return v[lo] + (v[hi] - v[lo]) * (i - lo); };
  return { n, total, mean, sd, min: v[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: v[n - 1], cv: mean ? sd / mean : 0 };
}
const f1 = (x) => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toLocaleString("ja-JP") : "―");
const pct = (a, b) => (b ? `${(Math.round((a / b) * 1000) / 10).toFixed(1)}%` : "―");

// ドーナツ（円）グラフ。上位6つまで表示し、残りは「その他」にまとめる
function donutFig(items, { title = "", unit = "件", top = 6, forExport = false, center } = {}) {
  const sorted = items.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, top), rest = sorted.slice(top);
  if (rest.length) head.push({ label: `その他（${rest.length}）`, value: rest.reduce((a, x) => a + x.value, 0), color: OTHER_COL });
  const total = head.reduce((a, x) => a + x.value, 0);
  const trace = { type: "pie", hole: 0.56, sort: false, direction: "clockwise", rotation: 0,
    labels: head.map((x) => x.label), values: head.map((x) => x.value), marker: { colors: head.map((x) => x.color) },
    texttemplate: "%{label}<br>%{percent:.0%}", textposition: "outside", automargin: true, textfont: { size: 12 },
    hovertemplate: `%{label}: %{value}${unit}（%{percent:.1%}）<extra></extra>` };
  const layout = { title, height: 340, showlegend: false, margin: { l: 30, r: 30, t: 56, b: 30 },
    annotations: [{ text: center || `<b>${total.toLocaleString("ja-JP")}</b><br><span style="font-size:11px">${unit === "名" ? "名" : unit}</span>`,
      showarrow: false, font: { size: 18, color: forExport ? "#1c2430" : css("--text") }, x: 0.5, y: 0.5 }] };
  return { traces: [trace], layout };
}
function donutItems(m) {
  const rep = reportsOf(m), dis = diseasesOf(m);
  const visit = VISIT_KEYS.map(([f, label, color]) => ({ label, value: sum(rep, (r) => r[f]), color }));
  const region = REGIONS.map((g) => ({ label: g, value: sum(rep.filter((r) => r.region === g), (r) => r.total), color: regionColor(g) }));
  const cat = {};
  for (const d of dis) if (d.category !== Z) cat[d.category] = (cat[d.category] || 0) + d.count;
  const catItems = Object.entries(cat).map(([c, v]) => ({ label: shortCat(c), value: v, color: D.colors[c] }));
  const zc = sum(dis.filter((d) => d.category === Z), (d) => d.count), real = sum(dis.filter((d) => d.category !== Z), (d) => d.count);
  const kind = [{ label: "実患（病気・けが）", value: real, color: "#2a78d6" }, { label: "検診・予防接種など", value: zc, color: "#86b6ef" }];
  return { visit, region, cat: catItems, kind };
}

function needData() {
  if (!months().length) {
    main.innerHTML = `<div class="card"><p>まだデータがありません。「取り込み」から月報を読み込んでください。</p>
      <p>どんなことができるか先に見てみたいときは、架空の公館による6か月分のデモをどうぞ。</p>
      <button class="primary" data-demo-start>デモを見る</button></div>`;
    return true;
  }
  return false;
}

// ----------------------------------------------------------------------- デモ
// 架空の公館・医務官による6か月分（demo.json）をメモリ上だけに読み込む。実データには触れない
// デモのデータを読み込む（保存済みの実データには触れない）
async function loadDemoData() {
  let d;
  try { d = await (await fetch("demo.json?v=2")).json(); }
  catch (e) { toast("デモデータを読み込めませんでした"); return false; }
  demoMode = true;
  clearCaches();
  state = Object.assign({ reports: {}, rosters: {}, junkai: {}, overrides: {}, groups: {}, cases: {} }, d, { junkai: {} });
  // 出来事・巡回健診・5行サマリーは取り込みと同じ処理で作る
  for (const r of Object.values(state.reports)) {
    r.events = detectEvents(r.hei);
    (state.junkai[r.month] ||= []).push(...detectJunkai(r.hei, r.post));
  }
  for (const r of Object.values(state.reports)) r.summary = ruleSummary(r.month, r.post);
  return true;
}
async function startDemo() {
  if (!(await loadDemoData())) return;
  document.body.classList.add("demo");
  $("#demoBtn").hidden = true; $("#demoExitBtn").hidden = false;
  $("#demobar").hidden = false;
  const ms = months();
  refreshMonths(ms[ms.length - 1]);
  if (page === "import" || page === "settings") page = "dashboard";
  render();
  toast("デモを表示しています。世界地図の「ハイライト・ツアー」や「タイムラプス」もお試しください");
}
async function exitDemo() {
  demoMode = false;
  document.body.classList.remove("demo");
  $("#demoBtn").hidden = false; $("#demoExitBtn").hidden = true;
  $("#demobar").hidden = true;
  state = { reports: {}, rosters: {}, junkai: {}, overrides: {}, groups: {}, cases: {} };
  clearCaches();
  await loadState();
  $("#month").innerHTML = "";
  refreshMonths();
  if (history.replaceState && location.search.includes("demo")) history.replaceState(null, "", location.pathname);
  render();
  toast("デモを終えました。保存済みのデータに戻りました");
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-demo-start]")) startDemo();
  if (e.target.closest("[data-demo-exit]")) exitDemo();
});

// ----------------------------------------------------------------------- バックアップの声かけ
// まだ一度も書き出していないとき、または最後の書き出しから7日以上たって変更があるときに上部に表示する
const BACKUP_DAYS = 7;
// バックアップもPDFと同じパスワードで暗号化して書き出す（PBKDF2-SHA256 + AES-GCM）
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function backupKey(salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(PDF_PASSWORD), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptBackup(obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await backupKey(salt), new TextEncoder().encode(JSON.stringify(obj))));
  return JSON.stringify({ format: "geppou-backup-encrypted", v: 1, kdf: "PBKDF2-SHA256-250000", cipher: "AES-256-GCM", salt: b64(salt), iv: b64(iv), data: b64(data) });
}
async function decryptBackup(text) {
  const o = JSON.parse(text);
  if (o.format !== "geppou-backup-encrypted") return o;  // 以前の暗号化していないバックアップもそのまま読める
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, await backupKey(unb64(o.salt)), unb64(o.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new Error("復号できませんでした（ファイルが壊れているか、別のパスワードで作られています）"); }
}
async function exportBackup() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([await encryptBackup(state)], { type: "application/octet-stream" }));
  a.download = `geppou_backup_${new Date().toISOString().slice(0, 10)}.geppou`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  if (!demoMode) savePref("lastBackup", Date.now());
  toast("暗号化したバックアップを書き出しました。医務官のみがアクセスできるフォルダに保存してください");
  updateBackupBar();
}
const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
function backupStatusText() {
  const p = loadPrefs();
  if (!p.lastBackup) return "まだバックアップを書き出していません。";
  const days = Math.floor((Date.now() - p.lastBackup) / 864e5);
  return `最後のバックアップ：${fmtDate(p.lastBackup)}（${days ? days + "日前" : "今日"}）` + (p.lastChange > p.lastBackup ? "。その後に変更があります。" : "。その後の変更はありません。");
}
function updateBackupBar() {
  const bar = $("#backupbar");
  if (!bar) return;
  const p = loadPrefs();
  const hasData = !demoMode && Object.keys(state.reports).length > 0;
  const snoozed = p.backupSnooze && Date.now() < p.backupSnooze;
  let msg = "";
  if (hasData && !snoozed) {
    if (!p.lastBackup) msg = "まだバックアップがありません。閲覧履歴やサイトデータを消去するとデータも消えるので、書き出して医務官のみがアクセスできるフォルダに保存してください。";
    else if (p.lastChange > p.lastBackup && Date.now() - p.lastBackup >= BACKUP_DAYS * 864e5)
      msg = `最後のバックアップから${Math.floor((Date.now() - p.lastBackup) / 864e5)}日たっています（その後に変更があります）。`;
  }
  bar.hidden = !msg;
  if (msg) $("#backupmsg").textContent = msg;
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-backup-now]")) exportBackup();
  if (e.target.closest("[data-backup-later]")) { savePref("backupSnooze", Date.now() + 864e5); updateBackupBar(); toast("明日また表示します"); }
});

function render() {
  updateBackupBar();
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  stopAllAnim();
  endTour(true);
  if (lapse) lapse.playing = false;
  closePostCard(true);
  Plotly.purge && document.querySelectorAll(".js-plotly-plot").forEach((el) => Plotly.purge(el));
  ({ import: pageImport, dashboard: pageDashboard, stats: pageStats, map: pageMap, summary: pageSummary, junkai: pageJunkai,
    transfer: pageTransfer, trend: pageTrend, report: pageReport, ai: pageAI, whm: pageWhm, settings: pageSettings,
    evac: () => pageCases("evac"), hogo: () => pageCases("hogo") })[page]();
}

// ======================================================================= 取り込み

let importMonth = loadPrefs().importMonth || "";
let importMode = loadPrefs().importMode || "auto";   // auto: ファイル名から / manual: 手動で指定
let pending = [];        // { file, path } 月報（PDF・Word）
let rosterDrafts = [];   // { name, path, rows, month, monthFrom } 医務官配置表（名簿）
const isRosterFile = (name) => /\.(xlsx|xlsm|xls)$/i.test(name);
const isReportFile = (name) => /\.(pdf|docx?)$/i.test(name);

// フォルダをドロップされたときに中のファイルを（サブフォルダも含めて）集める
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (!items.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file: f, path: entry.fullPath.replace(/^\//, "") });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of items) await walk(e);
  return out;
}

function pageImport() {
  const [iy, im] = importMonth ? importMonth.split("-").map(Number) : [0, 0];
  const thisYear = new Date().getFullYear();
  main.innerHTML = `
    <h2>月報の取り込み</h2>
    ${demoMode ? '<div class="warnbox">デモ表示中です。取り込んだ月報は保存されません。実際に取り込むときは「デモを終える」を押してください。</div>' : ""}
    <div class="card">
      <h3 style="margin-top:0">① 対象月の決め方</h3>
      <div class="modes">
        <label class="mode"><input type="radio" name="mmode" value="auto"${importMode === "auto" ? " checked" : ""}>
          <span><b>ファイル名から自動で読み取る</b><br><span class="muted">例：ケニア_202607.pdf、2026年7月_ケニア.docx、令和8年7月 …（フォルダ名でも可）。月の違うファイルをまとめて読み込めます</span></span></label>
        <label class="mode"><input type="radio" name="mmode" value="manual"${importMode === "manual" ? " checked" : ""}>
          <span><b>手動で指定する</b><br><span class="muted">読み込むファイルをすべて同じ月として扱います</span>
          <span class="row" style="margin:6px 0 0">
            <select id="iy"><option value="">年</option>${[thisYear - 2, thisYear - 1, thisYear, thisYear + 1].map((y) => `<option${y === iy ? " selected" : ""}>${y}</option>`).join("")}</select>
            <select id="im"><option value="">月</option>${Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}"${m === im ? " selected" : ""}>${m}月</option>`).join("")}</select>
          </span></span></label>
      </div>
      <h3>② ファイルまたはフォルダを追加</h3>
      <div class="drop" id="drop"></div>
      <div class="row">
        <button id="pickFiles">ファイルを選ぶ</button>
        <button id="pickFolder">フォルダを選ぶ</button>
        <span class="muted">PDF（ZIP形式・通常）・Word（.docx）。医務官配置表（.xlsx）も一緒に入れられます。パスワード付きのPDF（imukanmd）はそのまま開きます（別のパスワードのときは入力を求めます）</span>
      </div>
      <input type="file" id="files" accept=".pdf,.docx,.doc,.xlsx,.xlsm" multiple hidden>
      <input type="file" id="folder" webkitdirectory directory multiple hidden>
      <div id="pending"></div>
      <h3>③ 読み取る</h3>
      <div class="row"><button class="primary" id="start">読み取り開始</button><span id="progress" class="muted"></span></div>
    </div>
    <div id="drafts"></div>
    <h2>医務官配置表（名簿）</h2>
    <div class="card">
      <p class="muted">配置表（xlsx）を登録すると、未提出公館のチェック・医務官名の補完・異動検出に使います。「公館」を含む列と「氏名」列があれば読み取れます。
        適用する月はファイル名（なければ表の見出しの「◯年◯月」）から自動で入ります。違っていれば直してから保存してください。</p>
      <div class="row"><button id="pickRoster">配置表を選ぶ</button><input type="file" id="roster" accept=".xlsx,.xlsm,.xls" multiple hidden></div>
      <div id="rosterPreview"></div>
    </div>`;
  const drop = $("#drop");
  const ready = () => importMode === "auto" || !!importMonth;
  const update = () => {
    const auto = importMode === "auto";
    $("#iy").disabled = $("#im").disabled = auto;
    drop.classList.toggle("disabled", !ready());
    drop.innerHTML = ready()
      ? `ここに月報のファイルやフォルダをドラッグ＆ドロップ<br><span class="muted">${auto ? "対象月は各ファイル名から読み取ります" : `すべて ${fmtMonth(importMonth)}分 として読み取ります`}</span>`
      : `手動で指定する場合は、先に ① で年と月を選んでください`;
    if (!pending.length) { $("#pending").innerHTML = ""; }
    else {
      // 自動のときは、読み取った月ごとの件数を先に見せる
      const byMonth = {};
      for (const p of pending) { const k = auto ? monthFromName(p.path) || "?" : importMonth; byMonth[k] = (byMonth[k] || 0) + 1; }
      const summary = Object.entries(byMonth).sort().map(([k, v]) => k === "?"
        ? `<span class="badge warn">月が読めない ${v}件</span>` : `<span class="badge">${fmtMonth(k)} ${v}件</span>`).join(" ");
      const list = `<ul class="flist">${pending.map((p, i) => {
        const mm = auto ? monthFromName(p.path) : importMonth;
        return `<li title="${esc(p.path)}">${esc(p.file.name)} <span class="${mm ? "muted" : "bad"}">${mm ? fmtMonth(mm) : "月不明"}</span> <button data-rm="${i}" title="外す">×</button></li>`;
      }).join("")}</ul>`;
      $("#pending").innerHTML = `<div class="row">${summary}<span class="muted">計 ${pending.length}件</span><button id="clearPending">すべて外す</button></div>
        ${pending.length > 12 ? `<details><summary>ファイルの一覧</summary>${list}</details>` : list}
        ${auto && byMonth["?"] ? '<p class="muted">月が読めないファイルは、本文の「◯年◯月分」から読み取ります。それでも分からなければ確認の表で月を入れてください。</p>' : ""}`;
    }
    document.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { pending.splice(Number(b.dataset.rm), 1); update(); }));
    if ($("#clearPending")) $("#clearPending").onclick = () => { pending = []; update(); };
    $("#start").disabled = !(ready() && pending.length);
  };
  const add = async (items) => {
    const rosters = items.filter((x) => isRosterFile(x.file.name));
    const reports = items.filter((x) => isReportFile(x.file.name));
    const other = items.length - rosters.length - reports.length;
    if (rosters.length) await addRosters(rosters);
    if (reports.length && !ready()) { toast("手動で指定する場合は、先に年と月を選んでください"); return; }
    for (const x of reports) if (!pending.some((p) => p.path === x.path && p.file.size === x.file.size)) pending.push(x);
    if (other) toast(`月報・配置表以外のファイル ${other}件は外しました`);
    if (rosters.length) toast(`配置表 ${rosters.length}件を読み取りました（下の「医務官配置表」で確認・保存してください）`);
    update();
  };
  document.querySelectorAll("[name=mmode]").forEach((r) => (r.onchange = () => { importMode = r.value; savePref("importMode", importMode); update(); }));
  const setMonth = () => {
    const y = $("#iy").value, m = $("#im").value;
    importMonth = y && m ? `${y}-${String(m).padStart(2, "0")}` : "";
    savePref("importMonth", importMonth);
    update();
  };
  $("#iy").onchange = setMonth;
  $("#im").onchange = setMonth;
  drop.onclick = () => (ready() ? $("#files").click() : toast("先に年と月を選んでください"));
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = async (e) => { e.preventDefault(); drop.classList.remove("over"); add(await filesFromDrop(e.dataTransfer)); };
  $("#pickFiles").onclick = () => $("#files").click();
  $("#pickFolder").onclick = () => $("#folder").click();
  $("#files").onchange = (e) => { add([...e.target.files].map((f) => ({ file: f, path: f.name }))); e.target.value = ""; };
  $("#folder").onchange = (e) => { add([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))); e.target.value = ""; };
  $("#start").onclick = () => readFiles();
  $("#pickRoster").onclick = () => $("#roster").click();
  $("#roster").onchange = async (e) => { await addRosters([...e.target.files].map((f) => ({ file: f, path: f.name }))); e.target.value = ""; };
  update();
  renderDrafts();
  renderRosterDrafts();
}

function defaultMonth() {
  const d = new Date(); d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function readFiles() {
  const items = pending.slice();
  const auto = importMode === "auto";
  if ((!auto && !importMonth) || !items.length) return;
  $("#start").disabled = true;
  drafts = [];
  for (let i = 0; i < items.length; i++) {
    const { file, path } = items[i];
    $("#progress").textContent = `読み取り中… ${i + 1} / ${items.length}　${file.name}`;
    let r;
    try { r = await parseReport(file); }
    catch (e) {
      r = { filename: file.name, month: null, bodyMonth: null, post: null, officer: null, staff: null, family: null, other: null, total: null,
        diseases: [], hei: "", warnings: ["読み込み失敗: " + e.message], images: [] };
    }
    r.filename = path || file.name;
    if (auto) {
      // ファイル名（なければフォルダ名）→ 本文 の順に対象月を決める
      const byName = monthFromName(path || file.name);
      r.month = byName || r.bodyMonth || "";
      if (!byName && r.bodyMonth) r.warnings.push(`ファイル名に年月がないため本文から${fmtMonth(r.bodyMonth)}分と判定`);
      if (!r.month) r.warnings.push("対象月が分かりません。表の「対象月」に入れてください");
      if (byName && r.bodyMonth && r.bodyMonth !== byName) r.warnings.push(`本文は${fmtMonth(r.bodyMonth)}分の記載（ファイル名どおり${fmtMonth(byName)}として取り込みます）`);
    } else {
      // 手動のときは ① で選んだ月に統一する。本文の年月と違えば知らせる
      if (r.bodyMonth && r.bodyMonth !== importMonth) r.warnings.push(`本文は${fmtMonth(r.bodyMonth)}分の記載（${fmtMonth(importMonth)}として取り込みます）`);
      r.month = importMonth;
    }
    drafts.push(r);
  }
  const files = items;
  pending = [];
  $("#pending").innerHTML = "";
  const counts = {};
  for (const d of drafts) counts[d.month || "?"] = (counts[d.month || "?"] || 0) + 1;
  $("#progress").textContent = `${files.length}件を読み取りました（` + Object.entries(counts).sort().map(([k, v]) => `${k === "?" ? "月不明" : fmtMonth(k)} ${v}件`).join("、") + "）。下の表で確認して「保存する」を押してください。";
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
            <td><input type="month" data-f="month" value="${esc(d.month || "")}" class="${d.month ? "" : "need"}"></td>
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
  if (demoMode) { toast("デモ表示中は保存できません。上の「デモを終える」を押してから取り込んでください"); return; }
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
  const noMonth = [];
  for (const d of drafts) {
    const mm = String(d.month || "").match(/^(20\d{2})-(\d{1,2})$/);
    if (mm) d.month = `${mm[1]}-${mm[2].padStart(2, "0")}`;
    if (!mm) { noMonth.push(d.filename); continue; }
    if (!d.post) { skipped.push(d.filename); continue; }
    const rec = {
      month: d.month, post: d.post, region: regionOf(d.post), officer: d.officer || "", staff: d.staff, family: d.family,
      other: d.other, total: d.total, filename: d.filename, hei: d.hei, diseases: d.diseases, events: detectEvents(d.hei), summary: "",
    };
    state.reports[`${d.month}|${d.post}`] = rec;
    // 巡回健診はこの公館の丙表由来のものだけ差し替える
    const js = (state.junkai[d.month] || []).filter((j) => j.src !== d.post);
    state.junkai[d.month] = js.concat(detectJunkai(d.hei, d.post));
    if (state.cases && state.cases[d.month]) state.cases[d.month] = state.cases[d.month].filter((c) => c.src !== d.post).concat(detectCases(d.hei, d.post));
    saved++; lastMonth = d.month;
  }
  for (const d of drafts) if (d.post && state.reports[`${d.month}|${d.post}`]) state.reports[`${d.month}|${d.post}`].summary = ruleSummary(d.month, d.post);
  await saveState();
  drafts = [];
  refreshMonths(lastMonth);
  render();
  toast(`${saved}件を保存しました` + (skipped.length ? `（公館未選択のため未保存: ${skipped.join("、")}）` : "") + (noMonth.length ? `（対象月が空のため未保存: ${noMonth.join("、")}）` : ""));
}

// 配置表（名簿）: ファイル名 → 表の見出し の順に適用月を決め、確認してから保存する
async function addRosters(items) {
  for (const { file, path } of items) {
    try {
      const rows = await parseRoster(file);
      const byName = monthFromName(path || file.name);
      const month = byName || rows.sheetMonth || curMonth() || defaultMonth();
      const monthFrom = byName ? "ファイル名" : rows.sheetMonth ? "表の見出し" : "（読み取れず：表示中の月）";
      rosterDrafts = rosterDrafts.filter((r) => r.path !== path).concat([{ name: file.name, path, rows, month, monthFrom }]);
    } catch (err) {
      rosterDrafts.push({ name: file.name, path, error: err.message });
    }
  }
  renderRosterDrafts();
}
function renderRosterDrafts() {
  const box = $("#rosterPreview");
  if (!box) return;
  box.innerHTML = rosterDrafts.map((r, i) => r.error
    ? `<div class="warnbox">${esc(r.name)}：配置表を読み取れませんでした（${esc(r.error)}）<button data-rdel="${i}">外す</button></div>`
    : `<div class="rosterdraft">
        <div class="row"><b>${esc(r.name)}</b>
          <label>適用する月 <input type="month" data-rmonth="${i}" value="${esc(r.month)}"></label>
          <span class="muted">${esc(r.monthFrom)}から読み取り</span>
          ${state.rosters[r.month] ? `<span class="badge warn">${fmtMonth(r.month)}の配置表を上書きします</span>` : ""}</div>
        <p class="muted">${r.rows.length}公館（うち配置あり ${r.rows.filter((x) => x.staffed).length}）${
          r.rows.some((x) => !INFO[x.post]) ? `／公館マスタにない名前: ${esc(r.rows.filter((x) => !INFO[x.post]).map((x) => x.post).join("、"))}` : ""}</p>
        <details><summary>中身を見る</summary><div class="table-wrap" style="max-height:300px"><table><thead><tr><th>公館</th><th>医務官</th><th>備考</th><th>配置</th></tr></thead><tbody>
          ${r.rows.map((x) => `<tr><td>${esc(x.post)}</td><td>${esc(x.officer)}</td><td>${esc(x.note)}</td><td>${x.staffed ? "○" : "―"}</td></tr>`).join("")}
        </tbody></table></div></details>
        <div class="row"><button class="primary" data-rsave="${i}">この配置表を保存</button><button data-rdel="${i}">外す</button></div>
      </div>`).join("");
  box.querySelectorAll("[data-rmonth]").forEach((inp) => (inp.onchange = () => { rosterDrafts[inp.dataset.rmonth].month = inp.value; renderRosterDrafts(); }));
  box.querySelectorAll("[data-rdel]").forEach((b) => (b.onclick = () => { rosterDrafts.splice(Number(b.dataset.rdel), 1); renderRosterDrafts(); }));
  box.querySelectorAll("[data-rsave]").forEach((b) => (b.onclick = async () => {
    if (demoMode) { toast("デモ表示中は保存できません"); return; }
    const r = rosterDrafts[b.dataset.rsave];
    if (!/^20\d{2}-\d{2}$/.test(r.month)) { toast("適用する月を入れてください"); return; }
    state.rosters[r.month] = [...r.rows];
    await saveState();
    rosterDrafts.splice(Number(b.dataset.rsave), 1);
    refreshMonths(curMonth() || r.month);
    renderRosterDrafts();
    toast(`${fmtMonth(r.month)}の配置表として保存しました`);
  }));
}

// ======================================================================= 統計
function statsRows(m) {
  const rep = reportsOf(m).filter((r) => r.total !== null && r.total !== undefined && r.total !== "");
  const groups = [["全体", rep], ...REGIONS.map((g) => [g, rep.filter((r) => r.region === g)])].filter(([, rs]) => rs.length);
  return groups.map(([g, rs]) => {
    const d = describe(rs.map((r) => r.total));
    const minP = rs.find((r) => Number(r.total) === d.min), maxP = rs.find((r) => Number(r.total) === d.max);
    const tot = sum(rs, (r) => r.total);
    return { g, d, minP: minP && minP.post, maxP: maxP && maxP.post,
      staff: pct(sum(rs, (r) => r.staff), tot), family: pct(sum(rs, (r) => r.family), tot), other: pct(sum(rs, (r) => r.other), tot) };
  });
}
function momStats(m) {
  const out = [];
  for (const r of reportsOf(m)) {
    const p = getReport(prevMonth(m), r.post);
    if (p && Number.isFinite(Number(r.total)) && Number.isFinite(Number(p.total)) && r.total !== null && p.total !== null)
      out.push({ post: r.post, region: r.region, cur: Number(r.total), prev: Number(p.total), diff: Number(r.total) - Number(p.total) });
  }
  return out;
}

function pageStats() {
  if (needData()) return;
  const m = curMonth(), rep = reportsOf(m), dis = diseasesOf(m);
  const rows = statsRows(m), all = rows[0] ? rows[0].d : { n: 0 };
  const mom = momStats(m);
  const up = mom.filter((x) => x.diff > 0).length, down = mom.filter((x) => x.diff < 0).length, same = mom.filter((x) => x.diff === 0).length;
  const realN = sum(dis.filter((d) => d.category !== Z), (d) => d.count), zN = sum(dis.filter((d) => d.category === Z), (d) => d.count);
  const ms = [...new Set(Object.values(state.reports).map((r) => r.month))].sort();
  main.innerHTML = `
    <h2>${fmtMonth(m)} 統計</h2>
    <div class="kpis">
      <div class="kpi"><div class="label">1公館あたり受診者数（平均）</div><div class="value">${f1(all.mean)}<small> 名</small></div><div class="delta muted">標準偏差 ${f1(all.sd)}</div></div>
      <div class="kpi"><div class="label">中央値</div><div class="value">${f1(all.median)}<small> 名</small></div><div class="delta muted">四分位範囲 ${f1(all.q1)}〜${f1(all.q3)}</div></div>
      <div class="kpi"><div class="label">診断件数（乙表）</div><div class="value">${(realN + zN).toLocaleString("ja-JP")}</div><div class="delta muted">うち実患 ${pct(realN, realN + zN)}</div></div>
      <div class="kpi"><div class="label">前月比（前月も提出の${mom.length}公館）</div><div class="value"><span class="up">▲${up}</span> <span class="down">▼${down}</span></div><div class="delta muted">増加 ${up}・減少 ${down}・同数 ${same}</div></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">受診者数の記述統計（1公館あたり・延べ人数）</h3>
      <div class="table-wrap"><table class="stats">
        <thead><tr><th>地域</th><th class="num">公館数</th><th class="num">合計</th><th class="num">平均</th><th class="num">標準偏差</th><th class="num">最小</th><th class="num">第1四分位</th><th class="num">中央値</th><th class="num">第3四分位</th><th class="num">最大</th><th class="num">変動係数</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.g === "全体" ? "sub" : ""}"><td>${r.g === "全体" ? "全体" : `<span class="dot" style="background:${regionColor(r.g)}"></span>${esc(r.g)}`}</td>
          <td class="num">${r.d.n}</td><td class="num">${r.d.total.toLocaleString("ja-JP")}</td><td class="num">${f1(r.d.mean)}</td><td class="num">${f1(r.d.sd)}</td>
          <td class="num" title="${esc(r.minP || "")}">${f1(r.d.min)}<small class="muted"> ${esc(r.minP || "")}</small></td><td class="num">${f1(r.d.q1)}</td><td class="num"><b>${f1(r.d.median)}</b></td><td class="num">${f1(r.d.q3)}</td>
          <td class="num" title="${esc(r.maxP || "")}">${f1(r.d.max)}<small class="muted"> ${esc(r.maxP || "")}</small></td><td class="num">${r.d.mean ? pct(r.d.sd, r.d.mean) : "―"}</td></tr>`).join("")}</tbody>
      </table></div>
      <h3>受診者の構成比</h3>
      <div class="table-wrap"><table class="stats"><thead><tr><th>地域</th>${VISIT_KEYS.map(([, l, c]) => `<th class="num"><span class="dot" style="background:${c}"></span>${l}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.g === "全体" ? "sub" : ""}"><td>${esc(r.g)}</td><td class="num">${r.staff}</td><td class="num">${r.family}</td><td class="num">${r.other}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted">変動係数＝標準偏差÷平均（公館ごとのばらつきの大きさ）。最小・最大の横はその公館。</p>
    </div>
    <div class="grid2x2">
      <div class="card"><div id="s_d1" class="plot donut"></div></div>
      <div class="card"><div id="s_d2" class="plot donut"></div></div>
      <div class="card"><div id="s_d3" class="plot donut"></div></div>
      <div class="card"><div id="s_d4" class="plot donut"></div></div>
    </div>
    <div class="card"><div id="s_box" class="plot" style="min-height:420px"></div>
      <p class="muted">箱の中の線が中央値、箱の上下が四分位（真ん中半分の公館が入る範囲）。点は各公館で、離れた点は他より極端に多い・少ない公館です。点にマウスを重ねると公館名が出ます。</p></div>
    <div class="card"><div id="s_mom" class="plot" style="min-height:420px"></div></div>
    <div class="card"><div id="s_top" class="plot clickable" style="min-height:480px"></div></div>
    ${ms.length >= 2 ? `<div class="card"><div id="s_heat1" class="plot" style="min-height:460px"></div><p class="muted">数字は月ごとの件数（検診・予防接種を除く）。色は<b>その病名の中で</b>多い月ほど濃くしてあるので、件数の少ない病気でも流行の時期（季節の波）が見えます。</p></div>
      <div class="card"><div id="s_heat2" class="plot" style="min-height:300px"></div></div>` : ""}`;

  const di = donutItems(m);
  [["s_d1", di.visit, "受診者の内訳", "名"], ["s_d2", di.region, "地域別の受診者数", "名"], ["s_d3", di.cat, "疾病分類の構成（実患）", "件"], ["s_d4", di.kind, "実患と検診・予防接種", "件"]]
    .forEach(([id, items, title, unit]) => { const f = donutFig(items, { title, unit }); plot(id, f.traces, f.layout); });

  // 箱ひげ図（地域別の1公館あたり受診者数）
  const regs = REGIONS.filter((g) => rep.some((r) => r.region === g));
  plot("s_box", regs.map((g) => {
    const rs = rep.filter((r) => r.region === g && r.total !== null);
    return { type: "box", name: g, y: rs.map((r) => r.total), text: rs.map((r) => r.post), boxpoints: "all", jitter: 0.45, pointpos: 0,
      marker: { color: regionColor(g), size: 7, line: { color: css("--surface") || "#fff", width: 1 } }, line: { color: regionColor(g), width: 1.5 },
      fillcolor: "rgba(0,0,0,0)", boxmean: true, hovertemplate: "%{text}: %{y}名<extra>" + g + "</extra>" };
  }), { title: "地域別 1公館あたり受診者数の分布（箱ひげ図）", showlegend: false, height: 420, yaxis: { title: { text: "受診者数（名）" }, rangemode: "tozero" }, margin: { l: 60, r: 20, t: 56, b: 40 } });

  // 前月比の増減ランキング（増加上位・減少上位）
  const ups = mom.filter((x) => x.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 8);
  const downs = mom.filter((x) => x.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 8);
  const rk = [...downs.reverse(), ...ups.reverse()];
  if (rk.length) plot("s_mom", [{ type: "bar", orientation: "h", y: rk.map((x) => x.post), x: rk.map((x) => x.diff),
    marker: { color: rk.map((x) => (x.diff > 0 ? UP_COL : DOWN_COL)) }, text: rk.map((x) => `${x.diff > 0 ? "+" : ""}${x.diff}`), textposition: "outside", cliponaxis: false,
    customdata: rk.map((x) => [x.prev, x.cur]), hovertemplate: "%{y}: %{customdata[0]}→%{customdata[1]}名（%{text}）<extra></extra>" }],
    { title: "前月比の増減が大きい公館（増加上位8・減少上位8）", height: Math.max(320, 28 * rk.length + 90), xaxis: { title: { text: "前月からの増減（名）" }, zeroline: true, zerolinewidth: 2 },
      margin: { l: 130, r: 40, t: 56, b: 50 }, showlegend: false });
  else $("#s_mom").innerHTML = '<p class="muted" style="padding:16px">前月の月報がある公館がないため、前月比は出せません。</p>';

  // 病名グループの上位15（実患）と全体に占める割合
  const g = {};
  for (const d of dis) if (d.category !== Z) g[groupOf(d.name)] = (g[groupOf(d.name)] || 0) + d.count;
  const top = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 15).reverse();
  if (top.length) plot("s_top", [{ type: "bar", orientation: "h", y: top.map((x) => x[0]), x: top.map((x) => x[1]), marker: { color: "#2a78d6" },
    text: top.map((x) => `${x[1]}件（${pct(x[1], realN)}）`), textposition: "outside", cliponaxis: false, hovertemplate: "%{y}: %{x}件<extra></extra>" }],
    { title: "病名（まとめ）の上位15 と実患全体に占める割合（棒をクリックで UpToDate）", height: Math.max(360, 26 * top.length + 90), margin: { l: 190, r: 90, t: 56, b: 40 }, showlegend: false })
    .then((el) => el.on("plotly_click", (e) => {
      if (!e.points[0]) return;
      if (!navigator.onLine) { toast("UpToDate はインターネットにつながっているときだけ開けます"); return; }
      window.open(utdUrl(e.points[0].y), "_blank", "noopener");
    }));

  // ヒートマップ：病名（まとめ）×月、地域×月。色は行ごとの最大を最も濃くし（季節の波を見やすく）、数字は実数
  if (ms.length >= 2) {
    const blues = [[0, "#f3f8fe"], [0.2, "#cde2fb"], [0.45, "#86b6ef"], [0.75, "#2a78d6"], [1, "#0d366b"]];
    const heat = (id, title, ylabels, z, unit, h) => {
      const zn = z.map((row) => { const mx = Math.max(1, ...row); return row.map((v) => v / mx); });
      const ink = z.map((row) => { const mx = Math.max(1, ...row); return row.map((v) => (v / mx > 0.55 ? "#ffffff" : "#1c2430")); });
      plot(id, [{ type: "heatmap", x: ms.map(fmtMonth), y: ylabels, z: zn, customdata: z, colorscale: blues, zmin: 0, zmax: 1, xgap: 2, ygap: 2, showscale: false,
        hovertemplate: `%{y}（%{x}）: %{customdata}${unit}<extra></extra>` },
        // 件数をマスの中に書く（色だけに頼らない）
        { type: "scatter", mode: "text", x: ms.flatMap(() => []), y: [], hoverinfo: "skip", showlegend: false }],
        { title, height: h, yaxis: { autorange: "reversed" }, margin: { l: 180, r: 20, t: 56, b: 60 },
          annotations: z.flatMap((row, i) => row.map((v, j) => ({ x: fmtMonth(ms[j]), y: ylabels[i], text: v ? String(v) : "", showarrow: false,
            font: { size: 11, color: ink[i][j] } }))) });
    };
    const alld = diseasesOf().filter((d) => d.category !== Z);
    const gt = {};
    for (const d of alld) gt[groupOf(d.name)] = (gt[groupOf(d.name)] || 0) + d.count;
    const groups = Object.entries(gt).sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => x[0]);
    heat("s_heat1", "病名（まとめ）上位12 × 月 ― 季節による流行の波", groups,
      groups.map((g) => ms.map((mm) => sum(alld.filter((d) => d.month === mm && groupOf(d.name) === g), (d) => d.count))), "件", Math.max(380, 32 * groups.length + 110));
    const allr = reportsOf();
    heat("s_heat2", "地域 × 月の受診者数（色は地域ごとに最も多い月を濃く）", REGIONS,
      REGIONS.map((rg) => ms.map((mm) => sum(allr.filter((r) => r.month === mm && r.region === rg), (r) => r.total))), "名", 300);
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
    ${alertsCard(m)}
    <div class="grid2"><div class="card"><div id="p1" class="plot"></div></div><div class="card"><div id="p2" class="plot"></div></div></div>
    <div class="grid2"><div class="card"><div id="d1" class="plot donut"></div></div><div class="card"><div id="d2" class="plot donut"></div></div></div>
    <p class="muted" style="margin-top:-6px">平均・標準偏差・四分位などの記述統計や、ほかのグラフは「統計」タブにあります。</p>
    <div class="card"><h3 style="margin-top:0">公館別 受診者数 <span class="muted" style="font-weight:400;font-size:13px">公館名をクリックで公館カード</span></h3><div class="table-wrap">${visitTable(m)}</div></div>
    <div class="grid2">
      <div class="card"><h3 style="margin-top:0">未提出公館</h3>${
        !miss ? '<p class="muted">配置表が未登録のため判定できません（取り込み→医務官配置表）。</p>'
        : !miss.length ? '<div class="okbox">配置公館はすべて提出済みです。</div>'
        : `<table><thead><tr><th>地域</th><th>公館</th><th>医務官（配置表）</th><th>備考</th></tr></thead><tbody>${miss.map((x) => `<tr><td>${esc(x.region)}</td><td>${esc(x.post)}</td><td>${esc(x.officer)}</td><td>${esc(x.note)}</td></tr>`).join("")}</tbody></table>`}
      </div>
      <div class="card"><h3 style="margin-top:0">診断名トップ10（検診・予防接種を除く）</h3>${topTable(dis)}</div>
    </div>`;
  const regs = REGIONS.filter((r) => rep.some((x) => x.region === r));
  plot("p1", VISIT_KEYS.map(([f, name, color]) => ({
    type: "bar", orientation: "h", name, marker: { color }, y: regs, x: regs.map((g) => sum(rep.filter((r) => r.region === g), (r) => r[f])),
    hovertemplate: `%{y} ${name}: %{x}名<extra></extra>`,
  })), { title: "地域別 受診者数（職員・家族・その他）", barmode: "stack", yaxis: { autorange: "reversed" }, height: 360 });
  const di = donutItems(m);
  { const f = donutFig(di.visit, { title: "受診者の内訳", unit: "名" }); plot("d1", f.traces, f.layout); }
  { const f = donutFig(di.cat, { title: "疾病分類の構成（検診・予防接種を除く）" }); plot("d2", f.traces, f.layout); }
  const cats = CATEGORIES.filter((c) => c !== Z && dis.some((d) => d.category === c));
  plot("p2", cats.map((c) => ({
    type: "bar", orientation: "h", name: shortCat(c), marker: { color: D.colors[c] }, y: regs,
    x: regs.map((g) => sum(dis.filter((d) => d.region === g && d.category === c), (d) => d.count)),
  })), { title: "地域別 疾病分類（検診・予防接種を除く）", barmode: "stack", yaxis: { autorange: "reversed" }, height: 360 });
}

function alertsCard(m) {
  const al = newAlerts(m);
  if (!getReportsAny(prevMonth(m))) return "";
  return `<div class="card alerts"><h3 style="margin-top:0">新着アラート <span class="badge new">${al.length}件</span> <span class="muted" style="font-weight:400;font-size:13px">前月と比べて新しく出てきた病気・急に増えた病気</span></h3>${
    al.length ? (() => {
      const row = (a) => `<tr><td><span class="badge${a.kind === "乙表で急増" ? " warn" : " new"}">${esc(a.kind)}</span></td><td><button class="linklike" data-post-card="${esc(a.post)}">${esc(a.post)}</button></td><td><b>${utd(a.name)}</b></td><td>${esc(a.detail)}</td></tr>`;
      const head = al.slice(0, 10), rest = al.slice(10);
      return `<div class="table-wrap"><table><tbody>${head.map(row).join("")}</tbody></table></div>` +
        (rest.length ? `<details><summary>すべて表示（ほか${rest.length}件）</summary><div class="table-wrap"><table><tbody>${rest.map(row).join("")}</tbody></table></div></details>` : "");
    })()
    : '<p class="muted">前月と比べて新しく目立つ病気はありません。</p>'}</div>`;
}
const getReportsAny = (m) => Object.values(state.reports).some((r) => r.month === m);

function visitTable(m) {
  const rep = reportsOf(m), miss = missingPosts(m) || [];
  let html = `<table><thead><tr><th>地域</th><th>公館</th><th>医務官</th><th class="num">職員</th><th class="num">家族</th><th class="num">その他</th><th class="num">計</th><th class="num">前月比</th></tr></thead><tbody>`;
  for (const g of [...REGIONS, "未分類"]) {
    const rs = rep.filter((r) => r.region === g), ms = miss.filter((x) => x.region === g);
    if (!rs.length && !ms.length) continue;
    for (const r of rs) {
      const p = getReport(prevMonth(m), r.post);
      const d = p && p.total !== null && r.total !== null ? r.total - p.total : null;
      html += `<tr><td>${esc(g)}</td><td><button class="linklike" data-post-card="${esc(r.post)}">${esc(r.post)}</button></td><td>${esc(r.officer)}</td><td class="num">${n(r.staff)}</td><td class="num">${n(r.family)}</td><td class="num">${n(r.other)}</td><td class="num">${n(r.total)}</td><td class="num">${d === null ? "" : (d >= 0 ? "+" : "") + d}</td></tr>`;
    }
    for (const x of ms) html += `<tr class="missing"><td>${esc(g)}</td><td>${esc(x.post)}</td><td>${esc(x.officer)}</td><td colspan="5">未提出</td></tr>`;
    html += `<tr class="sub"><td></td><td>${esc(g)} 小計</td><td></td>${["staff", "family", "other", "total"].map((f) => `<td class="num">${sum(rs, (r) => r[f])}</td>`).join("")}<td></td></tr>`;
  }
  html += `<tr class="sub"><td></td><td>総計</td><td></td>${["staff", "family", "other", "total"].map((f) => `<td class="num">${sum(rep, (r) => r[f])}</td>`).join("")}<td></td></tr></tbody></table>`;
  return html;
}

function topDiseases(dis, k = 10) {
  const g = {};
  for (const d of dis) if (d.category !== Z) {
    const o = (g[groupOf(d.name)] ||= { c: 0, posts: new Set(), cats: {} });
    o.c += d.count; o.posts.add(d.post); o.cats[d.category] = (o.cats[d.category] || 0) + d.count;
  }
  return Object.entries(g).sort((a, b) => b[1].c - a[1].c).slice(0, k).map(([name, o]) => ({
    name, count: o.c, posts: o.posts.size, category: Object.entries(o.cats).sort((a, b) => b[1] - a[1])[0][0] }));
}
function topTable(dis) {
  const t = topDiseases(dis);
  if (!t.length) return '<p class="muted">乙表データなし</p>';
  return `<table><thead><tr><th>#</th><th>病名（まとめ）</th><th>分類</th><th class="num">件数</th><th class="num">公館数</th></tr></thead><tbody>${
    t.map((x, i) => `<tr><td>${i + 1}</td><td>${utd(x.name)}</td><td>${esc(shortCat(x.category))}</td><td class="num">${x.count}</td><td class="num">${x.posts}</td></tr>`).join("")}</tbody></table>`;
}

// ======================================================================= 世界地図

const mapOpt = { disease: true, visits: true, outbreak: true, alerts: true, events: true, junkai: true, transfers: true, planes: true, labels: true };
// ツアー専用のタブ（?tourtab=1&m=YYYY-MM[&demo=1]）。地図を大きく出し、ツアーだけを行う
const TOUR_TAB = new URLSearchParams(location.search).get("tourtab") === "1";
const mapHeight = () => (TOUR_TAB ? Math.max(560, window.innerHeight - 190) : 600);
async function pageMap() {
  if (needData()) return;
  const m = curMonth();
  await loadGeo();
  const labels = { disease: "疾病分類（乙表）", visits: "受診者数", outbreak: "丙表の流行情報", alerts: "新着アラート", events: "災害・治安等", junkai: "巡回健診", transfers: "医務官の異動", planes: "飛行機アニメ", labels: "国名・首都・都市" };
  const dis = diseasesOf(m);
  const cats = CATEGORIES.filter((c) => c !== Z && dis.some((d) => d.category === c));
  main.innerHTML = `
    <h2>世界地図（${fmtMonth(m)}）</h2>
    <div class="card">
      <div class="row">${Object.entries(labels).map(([k, v]) => `<label><input type="checkbox" data-k="${k}"${mapOpt[k] ? " checked" : ""}> ${v}</label>`).join("")}</div>
      <div class="row fun">
        <button class="primary" id="tourBtn" title="${TOUR_TAB ? "" : "別のタブで、地図を大きくしてツアーを行います"}">✨ 今月のハイライト・ツアー${TOUR_TAB ? "" : "（別タブ）"}</button>
        <button id="lapseBtn">▶ タイムラプス（全期間）</button>
        <button id="sndBtn" title="ツアーで、移動中は乗り物の音、着いたらその国の国歌（設定で登録した録音、なければ内蔵の旋律か地域の音楽）を流します">${soundOn() ? "🔊 音あり" : "🔇 音なし"}</button>
        <span class="muted">国・首都・都市・印にマウスを載せるとカードが開きます</span>
      </div>
      <p class="tour-note">※ ツアーで各国の<b>国歌の演奏（録音）</b>を流すには、先に「設定」→「国歌の録音」で<b>音源をダウンロード</b>しておく必要があります（「🐙 GitHubから取得」「🌐 コモンズから取得」。インターネットが必要）。音源のない国は、楽譜からの演奏か地域の音楽になります。
        <span id="anCount" class="muted"></span>${TOUR_TAB ? "" : ' <button class="linklike" id="goAnthem">設定で音源をダウンロードする →</button>'}</p>
      ${mapControls()}
      <div class="mapwrap">
        <div id="wmap" class="plot map globe"></div>
        <div id="lapseLabel" class="lapse" hidden></div>
        <div id="tourbox" class="tourbox" hidden></div>
      </div>
      <p class="muted">国の色＝その国で最も多い疾病分類（健診・予防接種は除外）。実患${MIN_FULL}件未満の国は同じ色を薄く表示。✚の横の文字は丙表に出てくる病名（↑＝流行・増加の記述あり）。記号にマウスを重ねる（スマホはタップ）と丙表の記述が出ます。地球儀はドラッグで回転、ホイール（スマホは2本指）で拡大できます。「地球儀／平面」と向きのボタンはこのページのすべての地図に効きます。</p>
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
      <p class="muted">乙表でその病名を報告した国を件数の濃さで塗り、丙表（報告事項）で触れている公館に ✚ を付けます。</p>
      <div class="pickers">
        <label class="picker"><span>一覧から選ぶ</span><select id="dsel"></select></label>
        <div class="picker"><span>キーワードで検索</span>
          <div class="row" style="margin:0"><input id="dq" type="search" placeholder="例: デング、マラリア、炎" size="18"><button id="dgo" class="primary">検索</button><button id="dclr">クリア</button></div>
        </div>
      </div>
      <div class="row"><label><input type="checkbox" id="dall"> 全期間を合算</label><span id="dstatus" class="muted"></span></div>
      <div id="dmap" class="plot map"></div>
      <div id="dtable" class="table-wrap"></div>
    </div>
    <div class="card"><h3 style="margin-top:0">丙表から検出した出来事</h3>${eventTable(m)}</div>`;
  const draw = () => drawMap("wmap", worldTraces(m, mapOpt), mapHeight(), { highlight: true });
  setupOutbreakMap(m);
  setupDiseaseNameMap(m);
  draw();
  bindMapControls();
  document.querySelectorAll("[data-k]").forEach((c) => (c.onchange = () => { mapOpt[c.dataset.k] = c.checked; draw(); }));
  $("#tourBtn").onclick = () => {
    if (tour) { endTour(); return; }
    if (TOUR_TAB) { startTour(m); return; }
    // ツアーは別のタブで開く（地図を大きく表示。元のタブはそのまま使える）
    const q = new URLSearchParams({ tourtab: "1", m });
    if (demoMode) q.set("demo", "1");
    const w = window.open(`${location.pathname}?${q}`, "_blank");
    if (!w) { toast("新しいタブを開けなかったので、このタブでツアーを始めます"); startTour(m); }
  };
  anthemList().then((set) => { const c = $("#anCount"); if (c) c.textContent = `（ダウンロード済み：${set.size}か国）`; });
  const ga = $("#goAnthem");
  if (ga) ga.onclick = () => { page = "settings"; render(); setTimeout(() => { const h = $("#anCommons"); if (h) h.closest(".card").scrollIntoView({ behavior: "smooth", block: "start" }); }, 50); };
  const res = tourResumeInfo(m);
  if (TOUR_TAB && !tour) {
    // 音を出すにはクリックが必要なので、開始ボタンを地図の上に出す（中断したツアーがあれば「続きから」も）
    const ov = document.createElement("div");
    ov.className = "tourstart";
    ov.innerHTML = `${res ? `<button class="primary" data-ts="resume">▶ 続きから再開（${res.i + 1} / ${res.n}：${esc(res.post || "")}）</button><button data-ts="new">最初から始める</button>`
      : `<button class="primary" data-ts="new">▶ ハイライト・ツアーを始める</button>`}<span>${fmtMonth(m)}　移動中は乗り物の音、着いたら国歌が流れます（${soundOn() ? "音あり" : "音なし"}）</span><span>※ 国歌の演奏（録音）は、元のタブの「設定」→「国歌の録音」で音源をダウンロードしておく必要があります（ない国は楽譜の演奏か地域の音楽）</span>`;
    document.querySelector(".mapwrap").appendChild(ov);
    ov.querySelectorAll("[data-ts]").forEach((b) => (b.onclick = () => { ov.remove(); startTour(m, b.dataset.ts === "resume" ? res : null); }));
  } else if (res && !tour) {
    // 元のタブ：中断したツアーの続きを別のタブで開くボタン
    const b = document.createElement("button");
    b.className = "tourresume";
    b.textContent = `▶ 続きから再開（${res.i + 1} / ${res.n}：${res.post || ""}）`;
    $("#tourBtn").after(b);
    b.onclick = () => {
      const q = new URLSearchParams({ tourtab: "1", m });
      if (demoMode) q.set("demo", "1");
      const w = window.open(`${location.pathname}?${q}`, "_blank");
      if (!w) { b.remove(); startTour(m, res); }
    };
  }
  $("#lapseBtn").onclick = () => (lapse ? (lapse.playing = false) : startLapse());
  $("#sndBtn").onclick = () => {
    savePref("tourSound", !soundOn());
    $("#sndBtn").textContent = soundOn() ? "🔊 音あり" : "🔇 音なし";
    // 「音あり」にしても、その場では何も流さない（次に着いた国・次の移動から音が出る）。「音なし」にしたらすぐ止める
    if (!soundOn()) stopMusic();
  };
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
      drawMap("cmap", traces, 480);
    };
    $("#cat").onchange = drawCat;
    drawCat();
  }
}

// ----------------------------------------------------------------------- ハイライト・ツアー
// 流行・増加の報告と新着アラートがある公館を、地球儀を回しながら順番に紹介する
let tour = null;
function tourStops(m) {
  // 世界をひと回りする：地域ごとに話題の多い公館を選び（流行・増加の報告、新着アラート、災害・治安、緊急移送、巡回健診）、
  // 話題のない地域も受診者数の多い公館に立ち寄る。東京を出て アジア・大洋州 → 中東 → アフリカ → ヨーロッパ → 米州 の順に回る
  const by = {};
  const add = (post) => (by[post] ||= { post, region: regionOf(post), items: [], alerts: [], notes: [], score: 0 });
  for (const o of outbreaksOf(m)) if (o.trend === "流行・増加" && coord(o.post)) { const s = add(o.post); s.items.push(o); s.score += 3; }
  for (const a of newAlerts(m)) if (coord(a.post)) { const s = add(a.post); s.alerts.push(a); s.score += 2; }
  for (const e of eventsOf(m)) if (coord(e.post) && !/感染症|邦人/.test(e.kind)) { const s = add(e.post); s.notes.push(`${e.kind}：${e.keyword}`); s.score += 1; }
  for (const [type, label] of [["evac", "緊急移送"], ["hogo", "邦人対応"]]) for (const c of casesOf(m, type)) if (coord(c.post)) { const s = add(c.post); s.notes.push(`${label}あり`); s.score += 1; }
  for (const j of junkaiOf(m)) if (coord(j.from)) { const s = add(j.from); s.notes.push(`巡回健診：${j.dest || "（巡回先不明）"}へ`); s.score += 1; }
  for (const r of reportsOf(m)) if (coord(r.post)) add(r.post).visits = Number(r.total) || 0;
  const order = ["アジア・大洋州", "中東", "アフリカ", "ヨーロッパ", "米州"];
  const PER_REGION = 4;
  const stops = [];
  for (const g of [...order, ...REGIONS.filter((x) => !order.includes(x))]) {
    const cand = Object.values(by).filter((s) => s.region === g).sort((a, b) => b.score - a.score || (b.visits || 0) - (a.visits || 0)).slice(0, PER_REGION);
    for (const s of cand) {
      s.notes = [...new Set(s.notes)];
      // 話題のない公館は、受診者数と多い病名を紹介する
      if (!s.items.length && !s.alerts.length && !s.notes.length) {
        const r = getReport(m, s.post), pr = getReport(prevMonth(m), s.post);
        if (r) {
          const top = Object.entries(groupCounts(r)).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
          const d = pr && r.total !== null && pr.total !== null ? r.total - pr.total : null;
          s.notes.push(`受診者 ${n(r.total)}名${d === null ? "" : `（前月比 ${d >= 0 ? "+" : ""}${d}）`}${top.length ? `　多い病名：${top.join("・")}` : ""}`);
        }
      }
    }
    // 地域の中は東から西へ（地球儀が一方向に回って見やすい）
    stops.push(...cand.sort((a, b) => coord(b.post)[1] - coord(a.post)[1]));
  }
  // 最後は成田国際空港に帰国し、陸路で霞が関の外務省に戻る
  if (stops.length) {
    const k = stops.length;
    stops.push({ post: "日本", label: "成田国際空港", region: "帰国", at: [35.76, 140.39], home: "nrt", items: [], alerts: [], notes: [`世界の${k}公館を回り、成田国際空港に帰国`] },
      { post: "日本", label: "外務省（霞が関）", region: "帰着", at: [35.6745, 139.7507], home: "mofa", items: [], alerts: [], notes: ["霞が関の外務省に戻りました。ハイライト・ツアーはここで終わりです"] });
  }
  return stops;
}
// ---- 各国の音楽（music.js が Web Audio でその場で演奏するので、音声ファイル不要・オフラインでも鳴る）
let audioCtx = null, curMusic = null;
const soundOn = () => loadPrefs().tourSound !== false;
// 全体の音量。別のタブに移ったとき（ツアーは動かし続ける）は半分くらいに下げる
const volFactor = () => (document.hidden ? 0.5 : 1);
function actx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx._master = audioCtx.createGain();
    audioCtx._master.gain.value = volFactor();
    audioCtx._master.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
let curTravel = null;
function stopMusic() {
  if (curMusic) { curMusic.stop(); curMusic = null; }
  stopAnthem();
  if (curTravel) { curTravel.stop(); curTravel = null; }
}
// 曲の切り替え：今の音楽・国歌を sec 秒かけてフェードアウトする（乗り物の音は止めない。次の音と重ねる）
const CROSSFADE = 1.5;
function fadeOutMusic(sec = CROSSFADE) {
  if (curMusic) { curMusic.stop(sec); curMusic = null; }
  stopAnthem(sec * 1000);
}
// 移動中の効果音（飛行機・船・車）。乗り換えの時刻に合わせて音も切り替える
function playTravel(plan, seconds) {
  if (curTravel) { curTravel.stop(); curTravel = null; }
  if (!soundOn() || !window.WorldMusic) return;
  try {
    // 最後の区間は着いてから少し鳴らし続け、国歌とフェードで重ねる
    const hs = plan.map((sg, k) => { const a = invEase(sg.u0) * seconds, b = invEase(sg.u1) * seconds + (k === plan.length - 1 ? CROSSFADE : 0); return WorldMusic.travel(actx(), sg.mode === "gov" ? "plane" : sg.mode, Math.max(0.4, b - a), 0.5, a); });
    curTravel = { stop: () => hs.forEach((h) => h.stop()) };
  } catch (e) { console.warn("travel", e); }
}
// ---- 移動の道のり：大圏上を細かく区切って陸か海かを調べ、陸は車・海は船に乗り換える（遠い所は飛行機）
// 陸・海の判定は国境データ（countries.geo.json）。多角形ごとの外接矩形で先に絞って速くする
let LAND = null;
function landIndex() {
  if (LAND || !GEO) return LAND;
  LAND = [];
  for (const f of GEO.features) {
    const g = f.geometry;
    if (!g) continue;
    for (const poly of g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) {
      const ring = poly[0];
      let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
      for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      LAND.push({ ring, x0, x1, y0, y1 });
    }
  }
  return LAND;
}
function onLand(lat, lon) {
  const L = landIndex();
  if (!L) return true;
  lon = ((lon + 540) % 360) - 180;
  for (const p of L) {
    if (lon < p.x0 || lon > p.x1 || lat < p.y0 || lat > p.y1) continue;
    let inside = false;
    const r = p.ring;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
// 道のりの計画 → [{ mode: "car" | "ship" | "heli" | "plane", u0, u1 }]（u は道のりの割合 0〜1）
function routePlan(from, to) {
  const km = gcDist(from, to) * 6371;
  const plane = [{ mode: "plane", u0: 0, u1: 1 }];
  if (km > 2500) return plane;
  const N = Math.max(30, Math.min(200, Math.round(km / 12)));
  const land = [];
  for (let i = 0; i <= N; i++) { const [la, lo] = gcPoint(from, to, i / N); land.push(onLand(la, lo)); }
  land[0] = land[N] = true;  // 公館は陸の上（粗い海岸線で海と判定されても陸に直す）
  // 同じ種類が続く区間にまとめる
  const runsOf = () => { const r = []; land.forEach((v, i) => { if (r.length && r[r.length - 1].land === v) r[r.length - 1].b = i; else r.push({ land: v, a: i, b: i }); }); return r; };
  // 短すぎる区間（小島・湖・海岸線の誤差。40km未満）は前後に合わせる
  const minPts = Math.max(2, Math.ceil(40 / (km / N)));
  for (let guard = 0; guard < 200; guard++) {
    const runs = runsOf();
    if (runs.length <= 1) break;
    const short = runs.filter((r) => r.b - r.a + 1 < minPts).sort((x, y) => (x.b - x.a) - (y.b - y.a))[0];
    if (!short) break;
    for (let i = short.a; i <= short.b; i++) land[i] = !short.land;
  }
  const runs = runsOf();
  // 60〜600km で海を渡る（島・海峡）か乗り換えが多すぎるときはヘリコプターでひと飛び
  if (km >= 60 && km <= 600 && (runs.length > 5 || runs.some((r) => !r.land))) return [{ mode: "heli", u0: 0, u1: 1 }];
  if (runs.length > 5) return plane;                              // 島づたいで乗り換えが多すぎる
  if (runs.length === 1 && km > 1500) return plane;               // 陸路でも遠すぎる
  return runs.map((r, k) => ({ mode: r.land ? "car" : "ship", u0: k === 0 ? 0 : (r.a - 0.5) / N, u1: k === runs.length - 1 ? 1 : (r.b + 0.5) / N }));
}
// アニメーションの進み（時間→道のり）は easeInOut。区間の切り替わり時刻を求めるための逆関数
const invEase = (u) => (u < 0.5 ? Math.sqrt(u / 2) : 1 - Math.sqrt((1 - u) / 2));
const TRAVEL_ICON = { plane: "✈", ship: "🚢", car: "🚗", heli: "🚁", ambu: "🚑", gov: "✈", train: "🚄" };
// 公館どうしを結ぶ高速鉄道（実在の路線のみ。約1,300km以内）。「外務省」は成田空港から都心への鉄道
const RAIL_LINES = [
  ["中国", "上海総領事館", "京滬高速鉄道（北京南→上海虹橋）"], ["中国", "瀋陽総領事館", "京哈高速鉄道（北京→瀋陽）"],
  ["上海総領事館", "広州総領事館", "高速鉄道（上海虹橋→広州南）"], ["広州総領事館", "香港総領事館", "広深港高速鉄道（広州南→香港西九龍）"],
  ["上海総領事館", "香港総領事館", "高速鉄道（上海虹橋→香港西九龍）"], ["上海総領事館", "瀋陽総領事館", "高速鉄道（上海虹橋→瀋陽）"],
  ["アメリカ合衆国", "ニューヨーク総領事館", "アセラ（ワシントンD.C.→ニューヨーク）"],
  ["英国", "フランス", "ユーロスター（ロンドン→パリ）"], ["フランス", "ドイツ", "ICE（パリ→ベルリン）"],
  ["日本", "外務省", "京成スカイライナー（成田空港→都心）"],
];
function railBetween(a, b) {
  const l = RAIL_LINES.find(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (!l) return null;
  // 逆向きのときは「A→B」の向きを入れ替えて表示する
  return l[0] === a || l[2].indexOf("→") < 0 ? l[2] : l[2].replace(/（(.+)→(.+)）/, "（$2→$1）");
}
// 公館のある国の音楽を seconds 秒流す（前の曲は止める）
function playMusic(post, seconds) {
  fadeOutMusic();
  if (!soundOn() || !window.WorldMusic) return;
  const info = INFO[post] || {};
  try { curMusic = WorldMusic.play(actx(), info.iso3, info.region, seconds); } catch (e) { console.warn("music", e); }
}

// ---- 国歌の録音（利用者が登録した音声ファイル）。ブラウザ内（IndexedDB）に保存し、ツアーで着いた国の国歌を流す
// 録音が登録されていない国は、music.js の国歌（確認できた国のみ）か地域の音楽を流す
const ANTHEM_MAX_SEC = 20;   // ツアーでは国歌を最初の20秒（最後はフェードアウト）。公館カードからは最後まで
const ISO_NAME = {};         // ISO3 → 表示名（国名の公館を優先）
for (const [name, v] of Object.entries(INFO)) if (v.iso3 && (!ISO_NAME[v.iso3] || ISO_NAME[v.iso3].includes("総領事館"))) ISO_NAME[v.iso3] = name;
const isoName = (iso) => ISO_NAME[iso] || iso;
// 英語の国名の言い換え（ファイル名から国を判定するため。比較は英字だけにして行う）
const ANTHEM_EN = {
  usa: "USA", unitedstatesofamerica: "USA", uk: "GBR", unitedkingdom: "GBR", greatbritain: "GBR", britain: "GBR", england: "GBR",
  southkorea: "KOR", republicofkorea: "KOR", korea: "KOR", vietnam: "VNM", russia: "RUS", russianfederation: "RUS", tanzania: "TZA", vietnam: "VNM", vietnamese: "VNM",
  laos: "LAO", syria: "SYR", equatorialguinea: "GNQ", guineabissau: "GNB", iran: "IRN", ivorycoast: "CIV", cotedivoire: "CIV", drcongo: "COD", democraticrepublicofthecongo: "COD", congokinshasa: "COD",
  republicofthecongo: "COG", congobrazzaville: "COG", uae: "ARE", unitedarabemirates: "ARE", turkey: "TUR", turkiye: "TUR", czechia: "CZE",
  eswatini: "SWZ", swaziland: "SWZ", myanmar: "MMR", burma: "MMR", easttimor: "TLS", timorleste: "TLS", capeverde: "CPV", caboverde: "CPV",
  holysee: "VAT", palestine: "PSE", bolivia: "BOL", venezuela: "VEN", moldova: "MDA", macedonia: "MKD", northmacedonia: "MKD", brunei: "BRN",
  micronesia: "FSM", gambia: "GMB", bahamas: "BHS", japan: "JPN", nippon: "JPN", china: "CHN", prc: "CHN",
};
// 国民・形容詞形（Commons のファイル名は「Tanzanian national anthem…」「Thai National Anthem…」のような形が多い）
Object.assign(ANTHEM_EN, {
  thai: "THA", philippine: "PHL", filipino: "PHL", chinese: "CHN", french: "FRA", german: "DEU", british: "GBR", italian: "ITA", spanish: "ESP",
  mexican: "MEX", argentine: "ARG", argentinian: "ARG", lao: "LAO", laotian: "LAO", burmese: "MMR", afghan: "AFG", saudi: "SAU", emirati: "ARE",
  turkish: "TUR", ivorian: "CIV", mozambican: "MOZ", malagasy: "MDG", burkinabe: "BFA", dutch: "NLD", swedish: "SWE", polish: "POL",
  ukrainian: "UKR", uzbek: "UZB", kazakh: "KAZ", kyrgyz: "KGZ", tajik: "TJK", turkmen: "TKM", canadian: "CAN", salvadoran: "SLV",
  trinidadian: "TTO", lebanese: "LBN", palestinian: "PSE", moroccan: "MAR", somali: "SOM", sudanese: "SDN", southsudanese: "SSD", nigerien: "NER",
  // 地図の国境データ（縮尺1:1.1億）にない小さな国
  comoros: "COM", comorian: "COM", dominica: "DMA", antiguaandbarbuda: "ATG", saintlucia: "LCA", saintvincentandthegrenadines: "VCT",
  monaco: "MCO", liechtenstein: "LIE", vatican: "VAT", luxembourg: "LUX", serbia: "SRB", serbian: "SRB", irish: "IRL", cookislands: "COK", singapore: "SGP", singaporean: "SGP", bahrain: "BHR", bahraini: "BHR", maldives: "MDV", maldivian: "MDV",
  mauritius: "MUS", mauritian: "MUS", seychelles: "SYC", samoa: "WSM", samoan: "WSM", tonga: "TON", tongan: "TON", kiribati: "KIR", tuvalu: "TUV",
  marshallislands: "MHL", palau: "PLW", nauru: "NRU", solomonislands: "SLB", vanuatu: "VUT", sanmarino: "SMR", malta: "MLT", andorra: "AND",
  greek: "GRC", swiss: "CHE", danish: "DNK", finnish: "FIN", norwegian: "NOR", hungarian: "HUN", czech: "CZE", belgian: "BEL", portuguese: "PRT",
});
// 国歌の曲名（ファイル名が曲名だけのとき。例：Lupang Hinirang instrumental.ogg）
const ANTHEM_TITLES = {
  nokoreach: "KHM", fatshelenolarona: "BWA", laconcorde: "GAB", rytanindrazanaymalala: "MDG", independenciatotal: "STP", angolaavante: "AGO",
  assalamalamiri: "QAT", desteapteromane: "ROU", desteaptateromane: "ROU", motherland: "MUS", himnusz: "HUN", hungariannationalanthem: "HUN",
  deboutcongolais: "COD", lacongolaise: "COG", kimigayo: "JPN", aegukga: "KOR", marchofthevolunteers: "CHN", yiyongjunjinxingqu: "CHN", lupanghinirang: "PHL", phlengchat: "THA", phlengchatthai: "THA",
  indonesiaraya: "IDN", negaraku: "MYS", majulahsingapura: "SGP", tienquanca: "VNM", nokorreach: "KHM", phengxatlao: "LAO", kabamakyei: "MMR",
  amarsonarbangla: "BGD", amarshonarbangla: "BGD", srilankamatha: "LKA", sayaunthungaphulka: "NPL", qaumitaranah: "PAK", janaganamana: "IND",
  advanceaustraliafair: "AUS", godblessfiji: "FJI", oariseallyousons: "PNG", godsavethequeen: "GBR", godsavetheking: "GBR", lamarseillaise: "FRA",
  deutschlandlied: "DEU", dasliedderdeutschen: "DEU", ilcantodegliitaliani: "ITA", fratelliditalia: "ITA", mazurekdabrowskiego: "POL",
  dugamladufria: "SWE", shchenevmerla: "UKR", starspangledbanner: "USA", ocanada: "CAN", himnonacionalmexicano: "MEX", labayamesa: "CUB",
  himnonacionalargentino: "ARG", somoslibres: "PER", hinonacionalbrasileiro: "BRA", nkosisikelel: "ZAF", eemungunguvuyetu: "KEN",
  mungubaribikiafrika: "TZA", mungubariki: "TZA", ohuganda: "UGA", rwandanziza: "RWA", standandsingofzambia: "ZMB", ariseocompatriots: "NGA",
  godblessourhomelandghana: "GHA", labidjanaise: "CIV", lelionrouge: "SEN", pinceztousvoskoras: "SEN", marchforwarddearmotherethiopia: "ETH",
  biladibiladi: "EGY", ishybilady: "ARE", ishibiladi: "ARE", ishybiladi: "ARE", ishibilady: "ARE", alnashidalwatani: "ARE", aashalmaleek: "SAU", mawtini: "IRQ", istiklalmarsi: "TUR", hetwilhelmus: "NLD",
  stateanthemoftherussianfederation: "RUS", hatikvah: "ISR",
  // コモンズの米海軍軍楽隊の録音で、曲名だけのファイル名のもの
  magyarhimnusz: "HUN", himnusz: "HUN", kassaman: "DZA", landderbergelandamstrome: "AUT", marchonbahamaland: "BHS", landofthefree: "BLZ",
  milarodino: "BGR", merhayrenik: "ARM", hymniiflamurit: "ALB", hymntoliberty: "GRC", aportuguesa: "PRT", lijepanasadomovino: "HRV",
  lofsongur: "ISL", biladybiladybilady: "EGY", laubenouvelle: "BEN", marchareal: "ESP", gaumiisalaam: "MDV", liberte: "GIN",
  obenamjungenrhein: "LIE", amhrannabhfiann: "IRL", belaurekid: "PLW", canticodaliberdade: "CPV", motherland: "MUS",
  independenciatotal: "STP", kosteseselwa: "SYC", nkulunkulumnikatiwetibusisotemaswati: "SWZ", forgedfromtheloveofliberty: "TTO",
  onsheemecht: "LUX", kdedomovmuj: "CZE", gloriaalbravopueblo: "VEN", innoemarciapontificale: "VAT", yumiyumiyumi: "VUT", maamme: "FIN",
  allahpeliharakansultan: "BRN", dereretyndigtland: "DNK", ohgloriainmarcesible: "COL", peacetothesultan: "OMN", sayaunthungaphoolka: "NPL",
  inplentyandintimeofneed: "BRB", arubadushitera: "ABW", assalamalamiri: "QAT", alsalamalamiri: "QAT", assalamalmalaki: "JOR",
};
const ISO3S = new Set(Object.values(INFO).map((x) => x.iso3).filter(Boolean));
const normEn = (x) => String(x).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
function isoFromFileName(fname) {
  const base = fname.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "")
    .replace(/(performed\s*by\s*(the\s*)?|by\s*)?(the\s*)?(u\.?\s*s\.?|united\s*states)\s*navy\s*band/ig, " ")
    .replace(/national\s*anthem(\s*of)?/ig, " ").replace(/\b(instrumental|complete|vocal|anthem)\b/ig, " ").replace(/国歌/g, " ").replace(/[_\-–—,]+/g, " ");
  // ファイル名がちょうど3文字なら国コード（KEN.mp3 など）
  const code = base.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code) && ISO3S.has(code)) return code;
  // 英語の国名（長い名前から照合：Nigeria と Niger、Equatorial Guinea と Guinea を取り違えない）
  const b = normEn(base);
  // 短い名前（4文字以下：Lao・USA・UK など）は単語として現れたときだけ（「malala ô」を Lao と読まない）
  const words = " " + base.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]+/g, " ").trim() + " ";
  if (b.length >= 2) {
    const cands = [...Object.entries(ANTHEM_TITLES), ...Object.entries(ANTHEM_EN), ...(GEO ? GEO.features.map((f) => [normEn(f.properties.name), f.id]) : [])].filter(([n]) => n.length >= 2)
      .sort((x, y) => y[0].length - x[0].length);
    // 短い名前は国民名の語尾（Chad-ian・Iraq-i・Mali-an・Sudan-ese）も認める
    for (const [n, iso] of cands) if (n.length > 4 ? b.includes(n) : new RegExp(` ${n}(ian|an|i|ese|n)? `).test(words)) return iso;
  }
  // 日本語の国名・公館名（日本語が含まれるときだけ。「La Concorde」の La をロサンゼルスと読まない）
  if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(base) && !/^[A-Z]{2,3}$/i.test(base.trim())) return null;
  const post = canonical(base.trim()) || findInText(base)[0];
  if (post && INFO[post] && INFO[post].iso3) return INFO[post].iso3;
  return null;
}
let anthemSet = null;
async function anthemList() {
  if (!anthemSet) { try { anthemSet = new Set((await idb.get("anthemIndex")) || []); } catch { anthemSet = new Set(); } }
  return anthemSet;
}
// meta：{ license, artist, source }（コモンズから取得したときの出典。CC BY・BY-SA は表示が必要なので再生時に出す）
// 保存は1件ずつ順に行う（同時に取得した録音が、ファイル名の一覧を上書きし合わないように）
let anthemSaveQueue = Promise.resolve();
function saveAnthem(iso, file, meta = {}) {
  const job = anthemSaveQueue.then(async () => {
    await idb.set("anthem:" + iso, { name: file.name, type: file.type || "audio/mpeg", data: await file.arrayBuffer(), meta });
    const s = await anthemList(); s.add(iso); await idb.set("anthemIndex", [...s]);
    const names = (await idb.get("anthemNames")) || {}; names[iso] = file.name; await idb.set("anthemNames", names);
  });
  anthemSaveQueue = job.catch(() => {});
  return job;
}
async function deleteAnthem(iso) {
  await idb.set("anthem:" + iso, null);
  const s = await anthemList(); s.delete(iso); await idb.set("anthemIndex", [...s]);
}
// すでに登録した録音のうち、国歌ではない曲（米国の愛国歌など）を取り除く（以前の版で誤って登録されたもの）
async function cleanupAnthems() {
  const set = await anthemList(), removed = [], names = {};
  for (const iso of [...set]) {
    let rec = null;
    try { rec = await idb.get("anthem:" + iso); } catch {}
    if (rec && !isRightAnthem(iso, rec.name)) { await deleteAnthem(iso); removed.push(`${isoName(iso)}（${rec.name}）`); }
    else if (rec) names[iso] = rec.name;
  }
  await idb.set("anthemNames", names);
  return removed;
}
let curAnthem = null, curAnthemRec = null;
// 次のコマ：画面に見えているときは描画に合わせ、別のタブに隠れているとき（requestAnimationFrame が止まる）はタイマーで進める
const nextTick = (fn) => (document.hidden ? setTimeout(fn, 100) : requestAnimationFrame(fn));
const nextFrame = () => new Promise((r) => nextTick(r));
function stopAnthem(fadeMs = 400) {
  const a = curAnthem;
  if (!a) return;
  curAnthem = null;
  const v0 = a.volume, t0 = performance.now();
  const step = () => { const k = Math.min(1, (performance.now() - t0) / Math.max(1, fadeMs)); a.volume = v0 * (1 - k); if (k < 1) nextTick(step); else { a.pause(); if (a.src.startsWith("blob:")) URL.revokeObjectURL(a.src); } };
  step();
}
// アプリに同梱している録音（登録がなくても流れる）。日本は米海軍軍楽隊の「君が代」（パブリックドメイン。open-assets-hub/national-anthems 経由、96kbps に変換）
const BUNDLED_ANTHEM = {
  JPN: { src: "lib/anthems/audio/JPN.mp3", name: "Kimi ga Yo instrumental - U.S. Navy Band.mp3", meta: { license: "Public domain", artist: "U.S. Navy Band", source: "https://github.com/open-assets-hub/national-anthems/tree/main/anthems/jp" } },
};
// ツアーで国歌を流す長さの上限（秒）
const anthemMaxSec = () => ANTHEM_MAX_SEC;
// 登録した国歌（なければ同梱の録音）を流す。流した秒数（ふつうは最大30秒）を返す。どちらもなければ 0
// full：最後まで流す（公館カードの「国歌を聞く」）。ツアーでは長い国歌を途中で切る
async function playAnthem(iso, full = false) {
  stopAnthem(150);
  if (!iso) return 0;
  const rec = (await anthemList()).has(iso) ? await idb.get("anthem:" + iso) : BUNDLED_ANTHEM[iso] || null;
  if (!rec) return 0;
  const maxSec = full ? Infinity : anthemMaxSec(iso);
  const a = new Audio(rec.src || URL.createObjectURL(new Blob([rec.data], { type: rec.type })));
  // フェードイン（乗り物の音と重ねる）
  a.volume = 0;
  const vt0 = performance.now(), fadeIn = () => { if (curAnthem !== a) return; const k = Math.min(1, (performance.now() - vt0) / (CROSSFADE * 1000)); a.volume = 0.9 * k * volFactor(); if (k < 1) nextTick(fadeIn); };
  curAnthemRec = rec;
  curAnthem = a;
  try { await a.play(); } catch (e) { console.warn("anthem", e); curAnthem = null; return 0; }
  fadeIn();
  await new Promise((r) => (isFinite(a.duration) ? r() : a.addEventListener("loadedmetadata", r, { once: true })));
  const sec = isFinite(a.duration) ? Math.min(maxSec, a.duration) : Math.min(maxSec, ANTHEM_MAX_SEC);
  // 再生した時間で切る（一時停止しても早く切れないように）
  if (a.duration > maxSec) a.addEventListener("timeupdate", () => { if (curAnthem === a && a.currentTime >= maxSec - 1.5) stopAnthem(1500); });
  return sec;
}
// 国歌の楽譜データ（lib/anthems/。anthem-scores：Wikipedia・Commons の自由ライセンスの楽譜から変換したもの）
let ANTHEM_INDEX = null;
async function anthemScoreIndex() {
  if (!ANTHEM_INDEX) ANTHEM_INDEX = fetch("lib/anthems/index.json").then((r) => r.json()).catch(() => ({}));
  return ANTHEM_INDEX;
}
async function anthemScore(post) {
  const iso2 = INFO[post] && INFO[post].iso2;
  if (!iso2) return null;
  const idx = await anthemScoreIndex(), e = idx[iso2.toUpperCase()];
  if (!e) return null;
  try { return Object.assign(await (await fetch("lib/anthems/" + e.file)).json(), { indexTitle: e.title }); } catch { return null; }
}
// 着いたときの音：①登録した国歌の録音 → ②国歌の楽譜データを演奏 → ③内蔵の旋律・地域の音楽。
// 紹介を続ける秒数と、表示する国歌の情報を返す
async function playArrival(post, force = false, full = false) {
  if (!soundOn() && !force) return { sec: 0 };
  const iso = INFO[post] && INFO[post].iso3;
  const sec = await playAnthem(iso, full);
  if (sec) {
    const md = (curAnthemRec && curAnthemRec.meta) || {};
    return { sec, label: `国歌（録音：${(curAnthemRec && curAnthemRec.name || "").replace(/\.[^.]+$/, "")}）`, credit: md.license ? `${md.artist ? md.artist + "／" : ""}${md.license}（${/github\.com|githubusercontent|jsdelivr/.test(md.source || "") ? "GitHub：open-assets-hub/national-anthems" : "Wikimedia Commons"}）` : "" };
  }
  const sc = await anthemScore(post);
  if (sc && window.WorldMusic) {
    fadeOutMusic();
    try {
      curMusic = WorldMusic.playScore(actx(), sc, full ? 600 : ANTHEM_MAX_SEC);
      return { sec: curMusic.seconds, label: `国歌「${sc.indexTitle || sc.title}」（${sc.composer}）`, credit: `楽譜：${sc.author}（${sc.license}）` };
    } catch (e) { console.warn("anthem score", e); }
  }
  playMusic(post, 8);
  return { sec: 0 };
}

// ---- 飛行機で次の公館へ。飛行機を画面の中心に置き、その下で地球儀を回す（長い距離は途中で少し引いて見せる）
const gcDist = ([la1, lo1], [la2, lo2]) => {
  const r = Math.PI / 180;
  return Math.acos(Math.min(1, Math.sin(la1 * r) * Math.sin(la2 * r) + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r)));
};
const clampLat = (lat) => Math.max(-50, Math.min(50, lat));
const flightMs = (from, to) => (matchMedia("(prefers-reduced-motion: reduce)").matches ? 900 : 2600 + Math.min(1, gcDist(from, to) / Math.PI) * 2600);
// 拡大率の補間：対数の尺度で、始めと終わりがゆっくりの曲線（smootherstep）。拡大・縮小が急に見えないように
const smoother = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * x * (x * (x * 6 - 15) + 10); };
const zoomLerp = (a, b, k) => a * Math.pow(b / a, smoother(k));
// scale：着いたときの拡大率、travelScale：移動中の拡大率（遠目に引いて見せる）。省略すると移動中も scale に向けて少しずつ変える
async function flyTo(el, from, to, isCurrent, scale = 1, plan = [{ mode: "plane", u0: 0, u1: 1 }], ends = null, travelScale = null) {
  const modeAt = (u) => (plan.find((sg) => u < sg.u1) || plan[plan.length - 1]).mode;
  const g = el._fullLayout.geo._subplot;
  const base = globeBase(el), sc0 = g.projection.scale(), sc1 = scale * base, scT = (travelScale || scale) * base;
  el._animating = true;
  const dist = gcDist(from, to);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ms = flightMs(from, to);
  const fly = !reduce && dist > 0.005;
  const r0 = g.projection.rotate(), lon0 = -r0[0], lat0 = -r0[1];
  el._camUser = false;  // 途中で地球をつかまれたら、そこからはカメラを追いかけさせない
  let layer = null, paths = [], plane = null;
  if (fly) {
    layer = document.createElement("div"); layer.className = "flight";
    // 区間ごとに線の種類を変える（車＝道、船＝航路、飛行機＝航空路）
    layer.innerHTML = `<svg>${plan.map((sg) => `<path class="${sg.mode}"/>`).join("")}</svg><span></span>`
      + (ends ? ends.map((t, k) => `<b class="aplabel" data-end="${k}">${esc(t)}</b>`).join("") : "");
    el.appendChild(layer);
    paths = [...layer.querySelectorAll("path")]; plane = layer.querySelector("span");
  }
  const rad = Math.PI / 180;
  let t0 = performance.now(), pausedAt = 0;
  let aborted = false;
  for (;;) {
    if (!isCurrent()) { aborted = true; break; }
    // ツアーの一時停止中はその場で止まり、再開したら続きから
    if (tour && tour.paused) { pausedAt ||= performance.now(); await nextFrame(); continue; }
    if (pausedAt) { t0 += performance.now() - pausedAt; pausedAt = 0; }
    widenGeoClip(el);
    const t = Math.min(1, (performance.now() - t0) / ms);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    let cLon, cLat;
    el._flyPos = gcPoint(from, to, e);   // 乗り物のいまの位置（移動中に「次へ」を押したら、ここから次の国へ向かう）
    if (fly) {
      // 出発直後は今の向きから飛行機へ、あとは飛行機を追いかける
      const [pl, po] = gcPoint(from, to, e);
      const k = Math.min(1, t / 0.15);
      cLon = lon0 + (((po - lon0 + 540) % 360) - 180) * k;
      cLat = lat0 + (clampLat(pl) - lat0) * k;
    } else {
      const dl = ((to[1] - lon0 + 540) % 360) - 180;
      cLon = lon0 + dl * e; cLat = lat0 + (clampLat(to[0]) - lat0) * e;
    }
    // 拡大率：出発してすぐ遠目に引き（〜25%）、移動中はそのまま、着く前に（70%〜）寄って拡大する
    // 拡大・縮小は時間に沿って（t）、対数の尺度でなめらかに（smootherstep）。出発後の約4割で引き、到着前の約45%で寄る
    const zoomNow = !fly || !travelScale ? zoomLerp(sc0, sc1, t) : t < 0.38 ? zoomLerp(sc0, scT, t / 0.38) : t < 0.55 ? scT : zoomLerp(scT, sc1, (t - 0.55) / 0.45);
    if (el._camUser) { const r = g.projection.rotate(); cLon = -r[0]; cLat = -r[1]; }
    else {
      g.projection.rotate([-cLon, -cLat, 0]);
      g.projection.scale(zoomNow);
      g.render();
    }
    if (fly) {
      clipToGeo(el, layer);
      const proj = g.projection, cl = cLat * rad, co = cLon * rad;
      const front = ([la, lo]) => Math.sin(cl) * Math.sin(la * rad) + Math.cos(cl) * Math.cos(la * rad) * Math.cos(lo * rad - co) > 0.02;
      plan.forEach((sg, k) => {
        const pts = [], end = Math.min(e, sg.u1);
        if (end > sg.u0) for (let i = 0; i <= 24; i++) {
          const q = gcPoint(from, to, sg.u0 + ((end - sg.u0) * i) / 24);
          if (front(q)) { const p = proj([q[1], q[0]]); if (p && !Number.isNaN(p[0])) pts.push(p); }
        }
        paths[k].setAttribute("d", pts.length > 1 ? "M" + pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join("L") : "");
      });
      // 出発・到着の空港名を、地図上のその場所に出す
      layer.querySelectorAll(".aplabel").forEach((lb) => {
        const pt = lb.dataset.end === "0" ? from : to, q = front(pt) && proj([pt[1], pt[0]]);
        if (!q || Number.isNaN(q[0])) { lb.style.opacity = 0; return; }
        lb.style.opacity = 1;
        lb.style.transform = `translate(${q[0]}px, ${q[1]}px) translate(-50%, ${lb.dataset.end === "0" ? "-170%" : "70%"})`;
      });
      // 今いる区間の乗り物にする（陸に上がれば車、海に出れば船）
      const mode = modeAt(e);
      if (plane._mode !== mode) { plane._mode = mode; plane.textContent = TRAVEL_ICON[mode]; plane.className = mode; }
      const a = gcPoint(from, to, e), b = gcPoint(from, to, Math.min(1, e + 0.01));
      const p = proj([a[1], a[0]]), q = proj([b[1], b[0]]);
      if (p && q && front(a)) {
        const ang = e >= 0.999 ? plane._ang || 0 : Math.atan2(q[1] - p[1], q[0] - p[0]) / rad;
        plane._ang = ang;
        plane.style.opacity = 1;
        if (mode === "plane" || mode === "gov") {
          // 離陸・着陸で少し小さく、巡航中は大きく
          const sz = 0.8 + 0.6 * Math.sin(Math.PI * e);
          plane.style.transform = `translate(${p[0]}px, ${p[1]}px) translate(-50%, -50%) rotate(${ang}deg) scale(${sz})`;
        } else {
          // 船・車の絵文字は左向きなので、東へ進むときは左右を反転し、揺れを少しつける
          // ヘリコプターは少し上下に揺れながら飛ぶ
          const east = Math.cos(ang * Math.PI / 180) > 0, bob = mode === "ship" ? Math.sin(performance.now() / 260) * 4 : mode === "heli" ? Math.sin(performance.now() / 180) * 3 - 6 * Math.sin(Math.PI * e) : mode === "train" ? 0 : Math.sin(performance.now() / (mode === "ambu" ? 55 : 70)) * 1.2;
          plane.style.transform = `translate(${p[0]}px, ${p[1] + bob}px) translate(-50%, -50%) scaleX(${east ? -1 : 1})`;
        }
      } else plane.style.opacity = 0;
    }
    if (t >= 1) break;
    await nextFrame();   // 別のタブに隠れていても進む
  }
  if (aborted) { el._animating = false; layer && layer.remove(); return false; }
  if (layer) { layer.classList.add("landed"); setTimeout(() => layer.remove(), 1200); }
  if (el._camUser) { el._animating = false; return true; }  // つかんで回した向きのままにする
  el._animating = false;
  el._zoom = scale;
  await Plotly.relayout(el, { "geo.projection.rotation.lon": to[1], "geo.projection.rotation.lat": clampLat(to[0]), "geo.center.lon": to[1], "geo.center.lat": clampLat(to[0]), "geo.projection.scale": sc1 / g.fitScale });
  return true;
}
// ツアーで国に着いたときの拡大率（地球儀の全体が1）
const TOUR_ARRIVE_ZOOM = 3.6;
// 国に着いて国歌が流れている間は、再描画（大きさの変更・印の更新など）で拡大が戻ってしまわないよう、拡大率を保つ
// （利用者がドラッグやホイールで動かしたときは、その操作を優先する）
function keepTourZoom(el) {
  if (!touring || !tour || tour.flying || el._camUser || el._keepingZoom) return;
  const g = el._fullLayout && el._fullLayout.geo && el._fullLayout.geo._subplot;
  if (!g || !g.projection || !g.projection.clipAngle || !g.projection.clipAngle()) return;
  el._zoom = TOUR_ARRIVE_ZOOM;
  fixGlobeScale(el);
}
// ---- 空港（ツアーで飛行機の区間に出発・到着の空港名を出す）
// 各国の玄関口の空港は lib/airports.json（世界医療情報マップと同じ。OurAirports、パブリックドメイン）。
// 総領事館や、首都と玄関口が離れている国は、公館のある都市の空港にする
const POST_AIRPORT = {
  "日本": ["NRT", "成田国際空港", 35.76, 140.39], "広州総領事館": ["CAN", "広州白雲国際空港", 23.39, 113.30], "上海総領事館": ["PVG", "上海浦東国際空港", 31.14, 121.81],
  "瀋陽総領事館": ["SHE", "瀋陽桃仙国際空港", 41.64, 123.48], "香港総領事館": ["HKG", "香港国際空港", 22.31, 113.92], "ホーチミン総領事館": ["SGN", "タンソンニャット国際空港", 10.82, 106.65],
  "ウラジオストク総領事館": ["VVO", "ウラジオストク国際空港", 43.40, 132.15], "ジッダ総領事館": ["JED", "キング・アブドゥルアズィーズ国際空港", 21.68, 39.16],
  "ニューヨーク総領事館": ["JFK", "ジョン・F・ケネディ国際空港", 40.64, -73.78], "ロサンゼルス総領事館": ["LAX", "ロサンゼルス国際空港", 33.94, -118.41],
  "マイアミ総領事館": ["MIA", "マイアミ国際空港", 25.79, -80.29], "サンパウロ総領事館": ["GRU", "サンパウロ・グアルーリョス国際空港", -23.43, -46.47],
  "ドバイ総領事館": ["DXB", "ドバイ国際空港", 25.25, 55.36], "コートジボワール": ["ABJ", "フェリックス・ウフェ＝ボワニ国際空港", 5.26, -3.93],
  "タンザニア": ["DAR", "ジュリウス・ニエレレ国際空港", -6.88, 39.20], "オーストラリア": ["CBR", "キャンベラ空港", -35.31, 149.19],
  "ミャンマー": ["RGN", "ヤンゴン国際空港", 16.91, 96.13], "トルコ": ["ESB", "アンカラ・エセンボーア国際空港", 40.13, 32.99],
  "ボリビア": ["LPB", "エル・アルト国際空港", -16.51, -68.19], "タイ": ["BKK", "スワンナプーム国際空港", 13.69, 100.75], "タジキスタン": ["DYU", "ドゥシャンベ国際空港", 38.54, 68.83],
  "イラン": ["IKA", "エマーム・ホメイニー国際空港", 35.42, 51.15], "メキシコ": ["MEX", "メキシコシティ国際空港", 19.44, -99.07],
};
// 日本語名（lib/airports.json に日本語名のない空港）
const AIRPORT_JA = {
  ALG: "ウアリ・ブーメディエン空港", LAD: "4・デ・フェヴェレイロ国際空港", LBV: "レオン・ムバ国際空港", NSI: "ヤウンデ・ンシマレン国際空港", CKY: "コナクリ国際空港",
  LUN: "ケネス・カウンダ国際空港", JIB: "ジブチ＝アンブリ国際空港", HRE: "ロバート・ガブリエル・ムガベ国際空港", KRT: "ハルツーム国際空港", DSS: "ブレーズ・ジャーニュ国際空港",
  TUN: "チュニス・カルタゴ国際空港", WDH: "ホセア・クタコ国際空港", OUA: "ワガドゥグー空港", COO: "コトヌー・カジュエン空港", GBE: "サー・セレツェ・カーマ国際空港",
  TNR: "イヴァト国際空港", LLW: "リロングウェ国際空港", BKO: "モディボ・ケイタ国際空港", JUB: "ジュバ国際空港", MPM: "マプト国際空港",
  NKC: "ヌアクショット・ウムトゥンスィ国際空港", CMN: "ムハンマド5世国際空港", KBL: "カブール国際空港", PNH: "プノンペン国際空港", CMB: "バンダラナイケ国際空港",
  KTM: "トリブバン国際空港", ISB: "イスラマバード国際空港", POM: "ジャクソンズ国際空港", DIL: "プレジデンテ・ニコラウ・ロバト国際空港", SUV: "ナウソリ国際空港",
  UBN: "チンギスハーン国際空港", VTE: "ワッタイ国際空港", GYD: "ヘイダル・アリエフ国際空港", KBP: "ボルィースピリ国際空港", TAS: "タシケント国際空港",
  NQZ: "ヌルスルタン・ナザルバエフ国際空港", FRU: "マナス国際空港", ARN: "ストックホルム・アーランダ空港", BEG: "ベオグラード・ニコラ・テスラ空港",
  ASB: "アシガバート国際空港", WAW: "ワルシャワ・ショパン空港", OTP: "アンリ・コアンダ国際空港", SAH: "サナア国際空港", TLV: "ベン・グリオン国際空港",
  BGW: "バグダード国際空港", MCT: "マスカット国際空港", KWI: "クウェート国際空港", RUH: "キング・ハーリド国際空港", DAM: "ダマスカス国際空港",
  AMM: "クイーン・アリア国際空港", BEY: "ベイルート・ラフィク・ハリリ国際空港", UIO: "マリスカル・スクレ国際空港", HAV: "ホセ・マルティ国際空港",
  GUA: "ラ・アウロラ国際空港", SDQ: "ラス・アメリカス国際空港", MGA: "アウグスト・C・サンディーノ国際空港", PAP: "トゥーサン・ルーヴェルチュール国際空港",
  PTY: "トクメン国際空港", ASU: "シルビオ・ペティロッシ国際空港", CCS: "シモン・ボリバル国際空港",
};
let AIRPORTS = null;
async function loadAirports() {
  if (!AIRPORTS) AIRPORTS = await fetch("lib/airports.json").then((r) => r.json()).catch(() => ({}));
  return AIRPORTS;
}
function airportFor(post) {
  const o = POST_AIRPORT[post];
  if (o) return { iata: o[0], name: o[1], lat: o[2], lon: o[3] };
  const iso2 = INFO[post] && INFO[post].iso2, a = iso2 && AIRPORTS && AIRPORTS[iso2.toUpperCase()];
  return a ? { iata: a.iata, name: a.ja || AIRPORT_JA[a.iata] || a.en, lat: a.lat, lon: a.lon } : null;
}
const airportLabel = (ap) => (ap ? `${ap.name}（${ap.iata}）` : "");

// ツアーの続きの情報（どの月の何番目まで進んだか）。別のタブに移って中断しても、戻ったときに続きから再開できる
const tourResumeInfo = (m) => {
  const r = loadPrefs().tourResume;
  return r && r.m === m && !!r.demo === !!demoMode && r.i > 0 && Date.now() - r.t < 7 * 864e5 ? r : null;
};
function saveTourResume() {
  if (!tour) return;
  savePref("tourResume", { m: tour.m, demo: !!demoMode, i: tour.i, n: tour.stops.length, post: tour.stops[tour.i] && (tour.stops[tour.i].label || tour.stops[tour.i].post), atPost: tour.atPost, at: tour.at, t: Date.now() });
}
async function startTour(m, resume = null) {
  await loadGeo();  // 陸か海かの判定に使う
  await loadAirports();
  const stops = tourStops(m);
  if (!stops.length) { toast("この月の月報がありません"); return; }
  // ツアーは地球儀を回して見せるので、平面のときは一時的に地球儀にし、終わったら平面に戻す
  const restoreFlat = view().style !== "globe";
  if (restoreFlat) { view().style = "globe"; applyMapView(); await sleep(400); }
  // 出発地は東京
  tour = { m, stops, i: 0, playing: true, cardOn: true, timer: null, at: coord("日本") || [35.68, 139.76], atPost: "日本", seq: 0, restoreFlat };
  // 続きから：中断したときの公館に、その1つ前の公館から移動して再開する
  let start = 0;
  if (resume && resume.i < stops.length) { start = resume.i; tour.atPost = resume.atPost || "日本"; tour.at = resume.at || tour.at; }
  touring = true;
  // 予備の見張り：国に着いて止まっている間は、約1秒ごとに拡大率を確かめて 3.6倍に戻す（再描画以外で変わった場合も）
  clearInterval(tourZoomTimer);
  tourZoomTimer = setInterval(() => { const el = $("#wmap"); if (el && el.data) keepTourZoom(el); }, 900);
  $("#tourBtn").textContent = "■ ツアーを終える";
  document.querySelectorAll(".tourresume").forEach((x) => x.remove());
  showStop(start);
}
async function showStop(i) {
  if (!tour) return;
  const el = $("#wmap"), s = tour.stops[i], n = tour.stops.length;
  tour.i = i;
  clearTimeout(tour.timer);
  tour.pending = null;
  if (tour.paused) { tour.paused = false; tour.playing = true; resumeAudio(); }
  document.querySelectorAll(".tourpause").forEach((x) => x.remove());
  saveTourResume();
  const box = $("#tourbox");
  box.hidden = false;
  box.innerHTML = `
    <div class="tourhead"><span class="badge">${i + 1} / ${n}</span>${flagImg(s.post)}<b>${esc(s.label || s.post)}</b><span class="muted">${esc(s.region)}</span></div>
    ${s.items.map((o) => `<div class="touritem"><span class="badge warn">${utd(o.name)} ↑</span> ${esc(o.sentence)}</div>`).join("")}
    ${s.alerts.map((a) => `<div class="touritem"><span class="badge new">新着</span> ${utd(a.name)}：${esc(a.kind === "丙表に新登場" ? a.detail : `${a.kind}（${a.detail}）`)}</div>`).join("")}
    <div class="tourroute" id="tourroute"></div>
    ${(s.notes || []).map((t) => `<div class="touritem"><span class="badge">メモ</span> ${esc(t)}</div>`).join("")}
    <div class="row tourbtns"><button data-t="prev">◀ 前へ</button><button data-t="play">${tour.paused ? "▶ 再開" : tour.playing ? "⏸ 一時停止" : "▶ 自動で進む"}</button><button data-t="next">次へ ▶</button><button data-t="card">${tour.cardOn ? "🗂 カードを隠す" : "🗂 公館カード"}</button><button data-t="end">✕</button></div>`;
  box.querySelector("[data-t=prev]").onclick = () => showStop((tour.i - 1 + n) % n);
  box.querySelector("[data-t=next]").onclick = () => showStop((tour.i + 1) % n);
  box.querySelector("[data-t=play]").onclick = () => {
    if (tour.paused) { resumeTour(); return; }
    if (tour.playing) { pauseTour(); return; }
    // 外務省に戻ったあとは、最初の公館からもう一周する
    tour.playing = true;
    showStop(s.home === "mofa" && tour.atPost === s.post && tour.at[0] === s.at[0] ? 0 : tour.i);
  };
  // 公館カードは着いた国のものを自動で開く（ツアーは止めない）。隠すと次の国からも出さない
  box.querySelector("[data-t=card]").onclick = (ev) => {
    tour.cardOn = !tour.cardOn;
    ev.target.textContent = tour.cardOn ? "🗂 カードを隠す" : "🗂 公館カード";
    if (tour.cardOn) openPostCard([s.post], tour.m); else closePostCard(true);
  };
  box.querySelector("[data-t=end]").onclick = () => endTour();
  const [lat, lon] = s.at || coord(s.post);
  if (el._hlIdx >= 0) Plotly.restyle(el, { lon: [[null]], lat: [[null]] }, [el._hlIdx]);
  // 移動中に「次へ」「前へ」を押したときは、前の国に戻らず、乗り物のいまの位置から次の国へ向かう
  const midway = !!(tour.flying && el._flyPos);
  const seq = ++tour.seq, from = midway ? el._flyPos.slice() : tour.at;
  // 移動中は乗り物の音（飛行機・船・車）、着いたらその国の国歌（ない国は地域の音楽）
  const plan = routePlan(from, [lat, lon]);
  // 高速鉄道が実際に走っている区間（中国の各都市・香港、ワシントン〜ニューヨーク、ロンドン〜パリ、パリ〜ベルリン、成田〜都心）は鉄道で
  const rail = !midway && railBetween(tour.atPost, s.home === "mofa" ? "外務省" : s.post);
  if (rail && !(tour.atPost === "日本" && !s.home) && s.home !== "nrt") { plan.length = 0; plan.push({ mode: "train", u0: 0, u1: 1 }); }
  // 陸路（車）の移動は乗り物をときどき変える：近くの国（約1,000km以内）はヘリコプター約35%・救急車約20%、遠い陸路は救急車約30%（日本国内は除く）
  if (plan.every((sg) => sg.mode === "car") && !s.home) {
    const near = gcDist(from, [lat, lon]) * 6371 <= 1000, r = Math.random();
    const mode = near ? (r < 0.35 ? "heli" : r < 0.55 ? "ambu" : "car") : r < 0.3 ? "ambu" : "car";
    if (mode !== "car") { plan.length = 0; plan.push({ mode, u0: 0, u1: 1 }); }
  }
  // 日本を出るとき（最初の公館へ）と、日本に帰るとき（成田へ）だけは政府専用機
  const govLeg = (tour.atPost === "日本" && !s.home) || s.home === "nrt";
  if (govLeg) { plan.length = 0; plan.push({ mode: "gov", u0: 0, u1: 1 }); }
  // 移動の説明：飛行機は出発と到着の空港名、車・船は陸路・海路
  const ap0 = midway ? null : airportFor(tour.atPost), ap1 = s.home === "mofa" ? null : airportFor(s.post), modes = [...new Set(plan.map((x) => x.mode))];
  const air = modes.includes("plane") || modes.includes("gov");
  const fromName = midway ? "移動の途中" : tour.atLabel || tour.atPost;
  const routeTxt = midway && air
    ? `✈ ${modes.includes("gov") ? "政府専用機　" : ""}移動の途中から ${airportLabel(ap1) || esc(s.post)} へ`
    : modes[0] === "train" && rail
    ? `🚄 ${rail}で${tour.atLabel || tour.atPost}から${s.label || s.post}へ`
    : air
    ? `✈ ${modes.includes("gov") ? "政府専用機　" : ""}${airportLabel(ap0) || esc(tour.atPost)} → ${airportLabel(ap1) || esc(s.post)}`
    : `${modes.map((md) => TRAVEL_ICON[md]).join("")} ${fromName}から${modes[0] === "heli" ? "ヘリコプター" : modes[0] === "ambu" ? "救急車" : modes.length > 1 ? "陸路・海路" : modes[0] === "ship" ? "海路" : "陸路"}で${s.label || s.post}へ`;
  const rt = box.querySelector("#tourroute");
  if (rt) rt.textContent = routeTxt;
  // 前の国の国歌・音楽はフェードアウトしながら、乗り物の音をフェードインで重ねる
  fadeOutMusic(2);
  playTravel(plan, flightMs(from, [lat, lon]) / 1000);
  // 移動中は遠目に（遠い所ほど引いて）、着いたらどの国も大きく拡大して見せる
  const km = gcDist(from, [lat, lon]) * 6371, travelZoom = km > 6000 ? 1.0 : km > 2500 ? 1.3 : km > 600 ? 1.8 : 2.4;
  widenGeoClip(el);
  tour.flying = true;
  const ok = await flyTo(el, from, [lat, lon], () => tour && tour.seq === seq, TOUR_ARRIVE_ZOOM, plan,
    air && ap0 && ap1 ? [`🛫 ${ap0.name}`, `🛬 ${ap1.name}`] : null, travelZoom);
  if (tour && tour.seq === seq) tour.flying = false;
  if (!ok || !tour || tour.seq !== seq) return;
  tour.atPost = s.post; tour.atLabel = s.label || s.post;
  if (tour.cardOn && !s.home) openPostCard([s.post], tour.m);
  else if (s.home) closePostCard(true);
  // 国歌は最後まで聞けるよう、その間は次へ進まない。曲名を吹き出しに出す
  // 日本に帰ったら成田に着いた時点で「君が代」。霞が関の外務省ではもう流さない
  const arr = s.home === "mofa" ? { sec: 0 } : await playArrival(s.post), anthemSec = arr.sec;
  if (!tour || tour.seq !== seq) { stopMusic(); return; }
  if (arr.label) box.querySelector(".tourhead").insertAdjacentHTML("afterend", `<div class="touranthem">🎵 ${esc(arr.label)}${arr.credit ? `<span class="muted">　${esc(arr.credit)}</span>` : ""}</div>`);
  tour.at = [lat, lon];
  if (el._hlIdx >= 0) await Plotly.restyle(el, { lon: [[lon]], lat: [[lat]] }, [el._hlIdx]);
  // 外務省に戻ったら自動では進まない（ツアーの終わり）。続きの記録も消す
  if (s.home === "mofa") {
    tour.playing = false; savePref("tourResume", null);
    const pb = box.querySelector("[data-t=play]"); if (pb) pb.textContent = "▶ もう一周";
    return;
  }
  scheduleNext(Math.max(6500, anthemSec * 1000 + 800));
}
// 着いた国での待ち時間のあと次の国へ。一時停止したら残り時間を覚えておく
function scheduleNext(ms) {
  const seq = tour.seq, n = tour.stops.length;
  tour.pending = { ms, seq, start: Date.now(), running: false };
  if (!tour.playing) return;
  tour.pending.running = true;
  tour.timer = setTimeout(() => tour && tour.seq === seq && !tour.paused && showStop((tour.i + 1) % n), ms);
}
function pauseAudio() {
  if (audioCtx && audioCtx.state === "running") audioCtx.suspend();
  if (curAnthem && !curAnthem.paused) { curAnthem.pause(); curAnthem._tourPaused = true; }
}
function resumeAudio() {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  if (curAnthem && curAnthem._tourPaused) { curAnthem._tourPaused = false; curAnthem.play().catch(() => {}); }
}
// ツアーの一時停止：移動のアニメーション・音楽・次の国へ進むまでの待ち時間を、その場で止める
function pauseTour(note = "") {
  if (!tour || tour.paused) return;
  tour.paused = true; tour.playing = false;
  clearTimeout(tour.timer);
  const p = tour.pending;
  if (p && p.running) { p.ms = Math.max(1500, p.ms - (Date.now() - p.start)); p.running = false; }
  pauseAudio();
  saveTourResume();
  const pb = document.querySelector("#tourbox [data-t=play]");
  if (pb) pb.textContent = "▶ 再開";
  const wrap = document.querySelector(".mapwrap");
  if (wrap && !wrap.querySelector(".tourpause")) {
    const ov = document.createElement("button");
    ov.className = "tourpause";
    ov.innerHTML = `⏸ 一時停止中<b>▶ 再開</b>${note ? `<small>${esc(note)}</small>` : ""}`;
    ov.onclick = (e) => { e.stopPropagation(); resumeTour(); };
    wrap.appendChild(ov);
  }
}
function resumeTour() {
  if (!tour || !tour.paused) return;
  tour.paused = false; tour.playing = true;
  document.querySelectorAll(".tourpause, .tourstart.resume").forEach((x) => x.remove());
  resumeAudio();
  const pb = document.querySelector("#tourbox [data-t=play]");
  if (pb) pb.textContent = "⏸ 一時停止";
  // 着いた国で待っている途中なら、残りの時間のあとに次の国へ
  const p = tour.pending;
  if (p && p.seq === tour.seq) {
    const seq = p.seq, n = tour.stops.length;
    p.start = Date.now(); p.running = true;
    tour.timer = setTimeout(() => tour && tour.seq === seq && !tour.paused && showStop((tour.i + 1) % n), p.ms);
  }
}
let tourZoomTimer = null;
function endTour(silent = false) {
  clearInterval(tourZoomTimer);
  if (!tour) { touring = false; return; }
  // ページを移ったとき（silent）は続きを覚えておく。ユーザーが終えたときは消す
  if (silent) saveTourResume(); else savePref("tourResume", null);
  clearTimeout(tour.timer);
  const restoreFlat = tour.restoreFlat;
  tour = null;
  touring = false;
  document.querySelectorAll(".flight").forEach((x) => x.remove());
  stopMusic();
  if (silent) { if (restoreFlat) { view().style = "flat"; savePref("mapView", view()); } return; }
  const el = $("#wmap");
  $("#tourbox").hidden = true;
  $("#tourBtn").textContent = `✨ 今月のハイライト・ツアー${TOUR_TAB ? "" : "（別タブ）"}`;
  if (el && el.data) {
    if (el._hlIdx >= 0) Plotly.restyle(el, { lon: [[null]], lat: [[null]] }, [el._hlIdx]);
    if (restoreFlat) { view().style = "flat"; applyMapView(); }
    else { el._zoom = 1; Plotly.relayout(el, { "geo.projection.scale": 1 }); }
  }
}


// 世界ツアーは、ブラウザの別のタブに移っても止めずに動かし続ける（音も流れ続ける）。タブを閉じたときのために、どこまで進んだかだけ覚えておく
document.addEventListener("visibilitychange", () => {
  if (tour && document.hidden) saveTourResume();
  // 別のタブに移ったら音量を半分に、戻ったら元に（約0.3秒でなめらかに）
  if (audioCtx && audioCtx._master) audioCtx._master.gain.setTargetAtTime(volFactor(), audioCtx.currentTime, 0.1);
  if (curAnthem && !curAnthem.paused && curAnthem.volume > 0) curAnthem.volume = Math.min(1, 0.9 * volFactor());
});

// ----------------------------------------------------------------------- タイムラプス
// 月を古い順に送り、地図の塗り分けと流行の印の移り変わりを見せる
let lapse = null;
async function startLapse() {
  const ms = [...new Set(Object.values(state.reports).map((r) => r.month))].sort();
  if (ms.length < 2) { toast("2か月以上のデータがあると再生できます"); return; }
  endTour();
  lapse = { playing: true };
  const btn = $("#lapseBtn"), label = $("#lapseLabel");
  btn.textContent = "■ 停止";
  label.hidden = false;
  for (const mm of ms) {
    if (!lapse || !lapse.playing) break;
    label.innerHTML = `${fmtMonth(mm)}<small>${ms.indexOf(mm) + 1} / ${ms.length}</small>`;
    $("#month").value = mm;
    await drawMap("wmap", worldTraces(mm, mapOpt), mapHeight(), { highlight: true });
    for (let t = 0; t < 20 && lapse && lapse.playing; t++) await sleep(100);
  }
  const last = curMonth();
  lapse = null;
  savePref("month", last);
  render();
}

// ----------------------------------------------------------------------- 公館カード
function sparkline(vals) {
  const w = 220, h = 48, pad = 4;
  const ys = vals.map((v) => v.y);
  const max = Math.max(1, ...ys), n = vals.length;
  const X = (i) => pad + (n === 1 ? (w - 2 * pad) / 2 : (i * (w - 2 * pad)) / (n - 1));
  const Y = (v) => h - pad - (v / max) * (h - 2 * pad);
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v.y).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="受診者数の推移">
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${vals.map((v, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(v.y).toFixed(1)}" r="${v.cur ? 4 : 2.5}" fill="${v.cur ? "var(--bad)" : "var(--accent)"}"><title>${fmtMonth(v.m)}: ${v.y}名</title></circle>`).join("")}
  </svg>`;
}
// ---- 公館のホームページと、外務省「世界の医療事情」へのリンク
// 大使館は https://www.{国コード}.emb-japan.go.jp/（国コードの例外と総領事館は下の表）。違っていたらカードの「✎ リンクを直す」で直せる（state.links）
const EMB_HOST = { gb: "uk", sa: "ksa", ae: "uae", iq: "iraq" };
const CONSULATE_HOST = {
  "広州総領事館": "guangzhou.cn", "上海総領事館": "shanghai.cn", "瀋陽総領事館": "shenyang.cn", "香港総領事館": "hk", "ホーチミン総領事館": "hcmcgj.vn",
  "ウラジオストク総領事館": "vladivostok.ru", "ドバイ総領事館": "dubai.uae", "ジッダ総領事館": "jeddah.ksa", "ニューヨーク総領事館": "ny.us",
  "ロサンゼルス総領事館": "la.us", "マイアミ総領事館": "miami.us", "サンパウロ総領事館": "sp.br",
};
const MEDI_INDEX = "https://www.mofa.go.jp/mofaj/toko/medi/index.html";
// ページを確認できた国（ほかはカードの「✎ リンクを直す」で登録すると、次から直接開く）
const MEDI_URL = { "アラブ首長国連邦": "https://www.mofa.go.jp/mofaj/toko/medi/nm_east/emirates.html" };
function postLinks(post) {
  const own = (state.links && state.links[post]) || {}, info = INFO[post] || {};
  const consulate = /総領事館$/.test(post), city = post.replace(/総領事館$/, "");
  const host = CONSULATE_HOST[post] || (info.iso2 && (EMB_HOST[info.iso2] || info.iso2));
  // 「世界の医療事情」のページ名は国・都市ごとにまちまちなので、登録がなければ外務省のサイト内を検索して開く
  const q = `site:mofa.go.jp/mofaj/toko/medi 世界の医療事情 ${consulate ? city : post}`;
  return {
    embName: consulate ? `在${city}日本国総領事館` : `在${post}日本国大使館`,
    emb: own.emb || (host ? `https://www.${host}.emb-japan.go.jp/` : ""),
    medi: own.medi || MEDI_URL[post] || `https://www.google.com/search?q=${encodeURIComponent(q)}`, mediSearch: !own.medi && !MEDI_URL[post], own,
  };
}
function postLinksHtml(post) {
  if (!INFO[post] || !INFO[post].isPost) return "";
  const L = postLinks(post), a = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text} ↗</a>`;
  return `<div class="pcblock pclinks"><div class="muted">リンク（インターネットが必要です）</div>
    ${L.emb ? `<div>${a(L.emb, `🏛 ${esc(L.embName)} ホームページ`)}</div>` : ""}
    <div>${a(L.medi, `🩺 世界の医療事情（${esc(post)}）`)}${L.mediSearch ? '<span class="muted">（外務省のサイト内を検索）</span>' : ""}　${a(MEDI_INDEX, "国の一覧")}</div>
    <div>${(() => { const c = countryJa(INFO[post].iso3) || post, city = /総領事館$/.test(post) ? post.replace(/総領事館$/, "") : null;
      return a(wikiUrl(c), `📖 Wikipedia「${esc(c)}」`) + (city ? `　${a(wikiUrl(city), `「${esc(city)}」`)}` : ""); })()}</div>
    <button class="linklike" data-links-edit="${esc(post)}">✎ リンクを直す</button></div>`;
}
// 「✎ リンクを直す」：ホームページと世界の医療事情の URL を、この公館について登録する（空にすると自動に戻る）
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-links-edit]");
  if (!b) return;
  const post = b.dataset.linksEdit, L = postLinks(post);
  const emb = prompt(`${L.embName} のホームページの URL（空にすると自動に戻ります）`, L.own.emb || L.emb);
  if (emb === null) return;
  const medi = prompt(`「世界の医療事情（${post}）」のページの URL（https://www.mofa.go.jp/mofaj/toko/medi/… 。空にすると検索に戻ります）`, L.own.medi || "");
  if (medi === null) return;
  const ok = (u) => !u.trim() || /^https:\/\/[^\s]+$/.test(u.trim());
  if (!ok(emb) || !ok(medi)) { toast("https:// で始まる URL を入れてください"); return; }
  state.links ||= {};
  const v = {};
  if (emb.trim() && (emb.trim() !== L.emb || L.own.emb)) v.emb = emb.trim();  // 自動の URL のままなら保存しない
  if (medi.trim()) v.medi = medi.trim();
  if (Object.keys(v).length) state.links[post] = v; else delete state.links[post];
  await saveState();
  const card = b.closest(".pclinks");
  if (card) card.outerHTML = postLinksHtml(post);
  toast("リンクを保存しました");
});
function postCardHtml(post, m) {
  const r = getReport(m, post);
  const hist = [...new Set(Object.values(state.reports).filter((x) => x.post === post).map((x) => x.month))].sort()
    .map((mm) => ({ m: mm, y: Number(getReport(mm, post).total) || 0, cur: mm === m }));
  const pr = getReport(prevMonth(m), post);
  const d = r && pr && r.total !== null && pr.total !== null ? r.total - pr.total : null;
  const top = r ? Object.entries(groupCounts(r)).sort((a, b) => b[1] - a[1]).slice(0, 5) : [];
  const ob = r ? reportOutbreaks(r) : [];
  const al = newAlerts(m).filter((a) => a.post === post);
  const jk = junkaiOf().filter((j) => j.from === post || j.dest === post).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 4);
  const tr = transfers().filter((t) => t.post === post || t.from === post);
  return `<section class="pc">
    <h3>${flagImg(post, "flag big")}${esc(post)} <span class="muted">${esc(regionOf(post))}</span>
      <button class="anthem-btn" data-anthem="${esc(post)}" title="この国の国歌を流します（登録した録音、なければ楽譜データからの演奏、なければ地域の音楽）">🎵 国歌を聞く</button></h3>
    <div class="pc-anthem muted" data-anthem-info="${esc(post)}"></div>
    ${postLinksHtml(post)}
    ${!r ? `<p class="muted">${fmtMonth(m)}の月報はありません。</p>` : `
    <div class="pcrow"><div><div class="muted">医務官</div><b>${esc(r.officer || "―")}</b></div>
      <div><div class="muted">受診者数（${fmtMonth(m)}）</div><b class="big">${n(r.total)}</b>${d === null ? "" : ` <span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${d}</span>`}</div></div>
    ${hist.length > 1 ? `<div class="muted">受診者数の推移（赤＝表示中の月）</div>${sparkline(hist)}` : ""}
    ${al.length ? `<div class="pcblock"><div class="muted">新着アラート</div>${al.map((a) => `<div><span class="badge new">新着</span> ${utd(a.name)}（${esc(a.kind)}${a.kind === "丙表に新登場" ? "" : "：" + esc(a.detail)}）</div>`).join("")}</div>` : ""}
    <div class="pcblock"><div class="muted">5行サマリー</div><ul>${(r.summary || ruleSummary(m, post)).split("\n").slice(0, 5).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>${reportFullHtml(r)}</div>
    ${top.length ? `<div class="pcblock"><div class="muted">主な病名（乙表）</div>${top.map(([g, c]) => `<span class="chip">${utd(g)} ${c}</span>`).join(" ")}</div>` : ""}
    ${ob.length ? `<div class="pcblock"><div class="muted">丙表に出てくる病気</div>${ob.map((o) => `<div><span class="badge${o.trend === "流行・増加" ? " warn" : ""}">${utd(o.name)} ${TREND_MARK[o.trend]}</span> ${esc(o.sentence)}</div>`).join("")}</div>` : ""}`}
    ${pcCases(post, m)}
    ${jk.length ? `<div class="pcblock"><div class="muted">巡回健診</div>${jk.map((j) => `<div>${fmtMonth(j.month)}　${esc(j.from)} → ${esc(j.dest || "?")}　${esc(j.period || "")}</div>`).join("")}</div>` : ""}
    ${tr.length ? `<div class="pcblock"><div class="muted">医務官の異動</div>${tr.map((t) => `<div>${fmtMonth(t.month)}　${esc(t.post)}：${esc(t.before)} → ${esc(t.after)}${t.from ? `（${esc(t.from)}から）` : ""}</div>`).join("")}</div>` : ""}
  </section>`;
}
// 月報の全文（甲表の人数・乙表のすべての病名・丙表の全文・元のファイル名）。開くと表示する
function reportFullHtml(r) {
  if (!r) return "";
  const dis = (r.diseases || []).slice().sort((a, b) => b.count - a.count);
  return `<details class="pcfull"><summary>📄 月報の全文を表示</summary>
    <div class="pcfull-body">
      <div class="muted">甲表（受診者数）</div>
      <table class="mini"><tr><th>職員</th><th>家族</th><th>その他</th><th>計</th></tr><tr><td class="num">${n(r.staff)}</td><td class="num">${n(r.family)}</td><td class="num">${n(r.other)}</td><td class="num"><b>${n(r.total)}</b></td></tr></table>
      <div class="muted">乙表（疾病分類・${dis.length}件）</div>
      ${dis.length ? `<table class="mini"><tr><th>病名</th><th>件数</th><th>分類</th></tr>${dis.map((d) => `<tr><td>${utd(d.name)}</td><td class="num">${d.count}</td><td class="muted">${esc(shortCat(classify(d.name)))}</td></tr>`).join("")}</table>` : '<p class="muted">（なし）</p>'}
      <div class="muted">丙表（報告事項）</div>
      <pre class="pcfull-hei">${esc(r.hei || "（なし）")}</pre>
      ${r.filename ? `<div class="muted" style="font-size:11px">元のファイル：${esc(r.filename)}</div>` : ""}
    </div></details>`;
}
function pcCases(post, m) {
  const ev = casesOf(null, "evac").filter((c) => c.post === post).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 4);
  const hg = casesOf(m, "hogo").filter((c) => c.post === post);
  return (ev.length ? `<div class="pcblock"><div class="muted">緊急移送（直近）</div>${ev.map((c) => `<div>${fmtMonth(c.month)}　${esc(c.who || "")} ${esc(c.cond || "")} → ${flagImg(c.dest, "flag sm")}${esc(c.dest || "?")}${c.outcome ? `（${esc(c.outcome)}）` : ""}</div>`).join("")}</div>` : "") +
    (hg.length ? `<div class="pcblock"><div class="muted">邦人対応（${fmtMonth(m)}）</div>${hg.map((c) => `<div><span class="badge">${esc(c.kind)}</span> ${esc(c.note)}</div>`).join("")}</div>` : "");
}
function openPostCard(posts, m = curMonth()) {
  let el = $("#postcard");
  if (!el) {
    el = document.createElement("aside");
    el.id = "postcard";
    el.className = "postcard";
    document.body.appendChild(el);
    bindCardDrag(el);
  }
  el.innerHTML = `<div class="pchead" title="ドラッグで動かせます。隅のつまみで大きさを変えられます（見出しをダブルクリックすると右端・元の大きさに戻す）"><span class="pcgrip" aria-hidden="true">⠿</span><b>公館カード</b><span class="muted">${fmtMonth(m)}</span><button id="pcClose" aria-label="閉じる">✕</button></div>` +
    `<div class="pcbody">${posts.map((p) => postCardHtml(p, m)).join("")}</div>` +
    `<div class="pcresize br" title="ドラッグで大きさを変えられます" aria-hidden="true"></div><div class="pcresize bl" title="ドラッグで大きさを変えられます" aria-hidden="true"></div>`;
  el.hidden = false;
  placeCard(el);
  $("#pcClose").onclick = () => closePostCard();
}
// ---- 公館カードは見出しの行をドラッグして画面上を動かせる。位置は prefs.cardPos に覚え、画面からはみ出さないようにする
// 大きさ（prefs.cardSize）は、隅のつまみをドラッグして変える。幅 300px〜画面幅、高さ 220px〜画面の高さ
function placeCard(el, pos = loadPrefs().cardPos, size = loadPrefs().cardSize) {
  const W = innerWidth, H = innerHeight;
  if (size) {
    el.classList.add("sized");
    el.style.width = Math.max(300, Math.min(W - 16, size.w)) + "px";
    el.style.height = Math.max(220, Math.min(H - 24, size.h)) + "px";
  } else { el.classList.remove("sized"); el.style.width = el.style.height = ""; }
  if (!pos) { el.classList.remove("moved"); el.style.left = el.style.top = el.style.maxHeight = ""; return; }
  const w = el.offsetWidth || 420;
  const x = Math.max(0, Math.min(W - w, pos.x)), y = Math.max(0, Math.min(H - 80, pos.y));
  el.classList.add("moved");
  el.style.left = x + "px"; el.style.top = y + "px"; el.style.maxHeight = `${H - y - 12}px`;
}
function bindCardDrag(el) {
  let d = null;
  // ---- 大きさの変更（右下・左下のつまみ）。左下は左端を動かして幅を変える
  let rz = null;
  el.addEventListener("pointerdown", (e) => {
    const g = e.target.closest(".pcresize");
    if (!g || (e.pointerType === "mouse" && e.button !== 0)) return;
    const r = el.getBoundingClientRect();
    // 右端に寄せた状態でも、いまの位置に固定してから大きさを変える
    placeCard(el, { x: r.left, y: r.top }, { w: r.width, h: r.height });
    rz = { id: e.pointerId, left: g.classList.contains("bl"), x0: e.clientX, y0: e.clientY, r };
    g.setPointerCapture(e.pointerId);
    el.classList.add("resizing");
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener("pointermove", (e) => {
    if (!rz || e.pointerId !== rz.id) return;
    const dx = e.clientX - rz.x0, dy = e.clientY - rz.y0, r = rz.r;
    const w = Math.max(300, Math.min(innerWidth - 16, rz.left ? r.width - dx : r.width + dx));
    const h = Math.max(220, Math.min(innerHeight - r.top - 12, r.height + dy));
    placeCard(el, { x: rz.left ? r.right - w : r.left, y: r.top }, { w, h });
  });
  const rzEnd = (e) => {
    if (!rz || e.pointerId !== rz.id) return;
    rz = null;
    el.classList.remove("resizing");
    savePref("cardSize", { w: el.offsetWidth, h: el.offsetHeight });
    savePref("cardPos", { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
  };
  el.addEventListener("pointerup", rzEnd);
  el.addEventListener("pointercancel", rzEnd);
  el.addEventListener("pointerdown", (e) => {
    const h = e.target.closest(".pchead");
    if (!h || e.target.closest("button, a, input") || (e.pointerType === "mouse" && e.button !== 0)) return;
    const r = el.getBoundingClientRect();
    d = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    h.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!d || e.pointerId !== d.id) return;
    placeCard(el, { x: e.clientX - d.dx, y: e.clientY - d.dy });
  });
  const end = (e) => {
    if (!d || e.pointerId !== d.id) return;
    d = null;
    el.classList.remove("dragging");
    if (el.classList.contains("moved")) savePref("cardPos", { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  // 見出しをダブルクリックすると、もとの右端に戻す
  el.addEventListener("dblclick", (e) => { if (e.target.closest(".pchead") && !e.target.closest("button")) { savePref("cardPos", null); savePref("cardSize", null); placeCard(el, null, null); } });
  addEventListener("resize", () => { if (!el.hidden) placeCard(el); });
}
function closePostCard(fromTour = false) {
  cardKey = null;
  const el = $("#postcard"); if (el) el.hidden = true;
  if (cardAnthemPost) { cardAnthemPost = null; stopMusic(); }
  // ツアー中に ✕ で閉じたら、次の国からも自動では開かない
  if (tour && fromTour !== true && tour.cardOn) { tour.cardOn = false; const b = document.querySelector("#tourbox [data-t=card]"); if (b) b.textContent = "🗂 公館カード"; }
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePostCard(); });
// 公館カードの「国歌を聞く」：もう一度押すと止める
let cardAnthemPost = null;
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-anthem]");
  if (!b) return;
  const post = b.dataset.anthem, info = document.querySelector(`[data-anthem-info="${CSS.escape(post)}"]`);
  const playing = cardAnthemPost === post && (curAnthem || curMusic);
  stopMusic();
  document.querySelectorAll("[data-anthem]").forEach((x) => (x.textContent = "🎵 国歌を聞く"));
  if (playing) { cardAnthemPost = null; if (info) info.textContent = ""; return; }
  if (tour) { tour.playing = false; clearTimeout(tour.timer); }
  cardAnthemPost = post;
  b.textContent = "⏹ 止める";
  const a = await playArrival(post, true, true);   // カードからは最後まで
  if (info) info.innerHTML = a.label ? `🎵 ${esc(a.label)}${a.credit ? `<br><span>${esc(a.credit)}</span>` : ""}` : "🎵 国歌の録音・楽譜がないため、地域の音楽を流しています（設定 → 国歌の録音 で登録できます）";
  const sec = a.sec || 8;
  setTimeout(() => { if (cardAnthemPost === post) { cardAnthemPost = null; b.textContent = "🎵 国歌を聞く"; } }, sec * 1000 + 500);
});
// 表などの公館名（data-post）をクリックしてもカードを開く
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-post-card]");
  if (b) openPostCard([b.dataset.postCard]);
});

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
    drawMap("obmap", traces, 480);
    const order = { "流行・増加": 0, "言及": 1, "減少・終息": 2 };
    list.sort((a, b) => order[a.trend] - order[b.trend] || a.name.localeCompare(b.name, "ja"));
    $("#obtable").innerHTML = list.length ? `<table><thead><tr><th>病名</th><th>状況</th><th>公館</th><th>地域</th>${all ? "<th>月</th>" : ""}<th>丙表の記述</th></tr></thead><tbody>${
      list.map((o) => `<tr><td>${utd(o.name)}</td><td>${o.trend === "流行・増加" ? '<span class="badge warn">流行・増加</span>' : esc(o.trend)}</td><td>${esc(o.post)}</td><td>${esc(o.region)}</td>${all ? `<td>${fmtMonth(o.month)}</td>` : ""}<td>${esc(o.sentence)}</td></tr>`).join("")}</tbody></table>`
      : '<p class="muted">丙表に病名の記述は見つかりませんでした。</p>';
  };
  fill();
  $("#obname").onchange = draw;
  $("#obdown").onchange = draw;
  $("#oball").onchange = () => { fill(); draw(); };
  draw();
}

let diseaseQuery = { mode: "select", text: "" };
function setupDiseaseNameMap(m) {
  let names = [], memberNames = {};
  const fill = () => {
    // 候補: 乙表の病名グループ（件数順）＋丙表に出てくる病名
    const all = $("#dall").checked;
    const cnt = {}, members = {};
    for (const d of diseasesOf(all ? null : m)) {
      const g = groupOf(d.name);
      cnt[g] = (cnt[g] || 0) + d.count;
      (members[g] ||= new Set()).add(d.name);
    }
    memberNames = members;
    names = Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, members[k].size > 1 ? `${v}件・${members[k].size}種類の表記` : `${v}件`]);
    const hei = {};
    for (const o of outbreaksOf(all ? null : m)) hei[o.name] = (hei[o.name] || 0) + 1;
    for (const [k, v] of Object.entries(hei).sort((a, b) => b[1] - a[1])) if (!cnt[k]) names.push([k, `丙表 ${v}公館`]);
    if (!diseaseQuery.text && names.length) diseaseQuery = { mode: "select", text: names[0][0] };
    fillSelect();
  };
  // 検索欄の文字で一覧を絞り込む（空なら全件）
  const fillSelect = () => {
    const kw = nfkc($("#dq").value.trim());
    // グループ名だけでなく、まとめた元の表記（例: 古典デング）でも引っかかるようにする
    const shown = kw ? names.filter(([k]) => nfkc(k).includes(kw) || [...(memberNames[k] || [])].some((x) => nfkc(x).includes(kw))) : names;
    $("#dsel").innerHTML = `<option value="">${kw ? `「${esc($("#dq").value.trim())}」を含む病名 ${shown.length}件` : `すべての病名 ${names.length}件`}</option>` +
      shown.map(([k, label]) => `<option value="${esc(k)}"${diseaseQuery.mode === "select" && k === diseaseQuery.text ? " selected" : ""}>${esc(k)}（${esc(label)}）</option>`).join("");
  };
  const draw = () => {
    // 一覧で選んだときはその病名だけ、検索のときはキーワードを含む病名すべてを対象にする
    const q = nfkc(diseaseQuery.text), part = diseaseQuery.mode === "search", all = $("#dall").checked;
    $("#dstatus").innerHTML = !q ? "" : (part ? `表示中：「${esc(diseaseQuery.text)}」を含む病名すべて` : `表示中：${esc(diseaseQuery.text)}`) + `　${utd(diseaseQuery.text, "📖 UpToDateで調べる")}`;
    const traces = baseTraces();
    if (!q) { drawMap("dmap", traces, 480); $("#dtable").innerHTML = ""; return; }
    const hit = (name) => (part ? nfkc(name).includes(q) || nfkc(groupOf(name)).includes(q) : groupOf(name) === diseaseQuery.text);
    const rows = {};
    const row = (r) => (rows[r.post] ||= { post: r.post, region: r.region, count: 0, names: {}, mentions: [] });
    for (const d of diseasesOf(all ? null : m)) if (hit(d.name)) { const o = row(d); o.count += d.count; o.names[d.name] = (o.names[d.name] || 0) + d.count; }
    for (const r of reportsOf(all ? null : m)) {
      const tag = all ? `[${fmtMonth(r.month)}] ` : "";
      const ss = new Set();
      // 丙表で拾った病名がこのグループに入るもの（例: 「デング出血熱」の記述 → デング熱）
      for (const o of heiDiseases(r.hei)) if (hit(o.name)) ss.add(o.sentence);
      for (const s of sentences(r.hei)) if (nfkc(s).includes(q)) ss.add(s.slice(0, 160));
      for (const s of ss) row(r).mentions.push(tag + s);
    }
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
    drawMap("dmap", traces, 480);
    list.sort((a, b) => b.count - a.count || b.mentions.length - a.mentions.length);
    $("#dtable").innerHTML = list.length ? `<table><thead><tr><th>公館</th><th>地域</th><th class="num">乙表の件数</th><th>元の病名（内訳）</th><th>丙表の記述</th></tr></thead><tbody>${
      list.map((o) => `<tr><td>${esc(o.post)}</td><td>${esc(o.region)}</td><td class="num">${o.count || ""}</td><td>${Object.entries(o.names).map(([k, v]) => `${utd(k)}(${v})`).join("、")}</td><td>${o.mentions.slice(0, 3).map(esc).join("<br>")}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">「${esc(diseaseQuery.text)}」の報告はありません。</p>`;
  };
  fill();
  const search = () => {
    const t = $("#dq").value.trim();
    if (!t) return;
    diseaseQuery = { mode: "search", text: t };
    fillSelect(); draw();
  };
  $("#dsel").onchange = () => { if (!$("#dsel").value) return; diseaseQuery = { mode: "select", text: $("#dsel").value }; draw(); };
  $("#dq").oninput = fillSelect;
  $("#dq").onkeydown = (e) => { if (e.key === "Enter") search(); };
  $("#dgo").onclick = search;
  $("#dclr").onclick = () => { $("#dq").value = ""; fillSelect(); };
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
        ${reportFullHtml(r)}
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
      ${mapControls()}<div id="jmap" class="plot map"></div>
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
  drawMap("jmap", worldTraces(m, { junkai: true }), 480);
  bindMapControls();
}

function junkaiHistory() {
  const g = {};
  for (const j of junkaiOf()) { const k = `${j.from}→${j.dest || "?"}`; const o = (g[k] ||= { c: 0, last: "" }); o.c++; if (j.month > o.last) o.last = j.month; }
  if (!Object.keys(g).length) return '<p class="muted">なし</p>';
  return `<table><thead><tr><th>実施公館→巡回先</th><th class="num">回数</th><th>直近</th></tr></thead><tbody>${
    Object.entries(g).map(([k, o]) => `<tr><td>${esc(k)}</td><td class="num">${o.c}</td><td>${fmtMonth(o.last)}</td></tr>`).join("")}</tbody></table>`;
}

// ======================================================================= 緊急移送・邦人対応
const CASE_DEF = {
  evac: { title: "緊急移送症例", desc: "丙表の「緊急移送」「搬送」などの記述から拾っています。行き先・手段・転帰の誤りは表で直して保存してください（行の追加・削除も可）。",
    cols: [["post", "公館", "post"], ["who", "対象", "who"], ["cond", "病名・状況", "text"], ["dest", "移送先", "place"], ["means", "手段", "means"], ["outcome", "転帰", "outcome"], ["note", "記載（丙表）", "note"]] },
  hogo: { title: "邦人対応事例", desc: "丙表で邦人（旅行者・出張者・留学生・在留邦人）に触れた記述から拾っています。区分・内容の誤りは表で直して保存してください（行の追加・削除も可）。",
    cols: [["post", "公館", "post"], ["kind", "区分", "kind"], ["who", "対象", "who"], ["cond", "病名・状況", "text"], ["outcome", "転帰", "outcome"], ["note", "記載（丙表）", "note"]] },
};
const KIND_COLORS = { "病気": "#1565C0", "事故": "#E67E22", "事件": "#6A1B9A", "死亡": "#37474F", "その他": "#90A4AE" };
let casesAll = !!loadPrefs().casesAll;

function caseInput(kind, f, v) {
  const sel = (opts) => `<select data-f="${f}"><option value=""></option>${opts.map((o) => `<option${o === v ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  if (kind === "post") return sel(POST_NAMES);
  if (kind === "place") return sel(ALL_PLACES);
  if (kind === "who") return sel(CASE_WHO);
  if (kind === "kind") return sel(CASE_KINDS);
  if (kind === "means") return sel(MEANS_RULES.map((x) => x[0]).concat(["その他"]));
  if (kind === "outcome") return sel(OUTCOME_RULES.map((x) => x[0]).concat(["不明"]));
  if (kind === "note") return `<textarea data-f="${f}" rows="2">${esc(v)}</textarea>`;
  return `<input data-f="${f}" value="${esc(v)}" size="14">`;
}

function caseTraces(list, type) {
  const traces = [];
  if (type === "evac") {
    let first = true;
    for (const c of list) {
      const a = coord(c.post), b = coord(c.dest);
      if (!a) continue;
      if (b) traces.push({ x: [a[1], b[1]], y: [a[0], b[0]], type: "scatter", mode: "lines", line: { width: 2.6, color: "#C62828" },
        name: "緊急移送", legendgroup: "ev", showlegend: first, hoverinfo: "skip" });
      if (b) traces.push(lineHover(a, b, `<b>🚑 緊急移送</b>${c.month ? " " + fmtMonth(c.month) : ""}<br>${c.post} → ${c.dest}${c.who || c.cond ? "<br>" + [c.who, c.cond].filter(Boolean).join(" ") : ""}`, "#C62828", "ev"));
      first = false;
    }
    const by = (key) => { const g = {}; for (const c of list) if (coord(c[key])) (g[c[key]] ||= []).push(c); return g; };
    const from = by("post"), to = by("dest");
    const pf = Object.keys(from), pt = Object.keys(to);
    if (pf.length) traces.push({ type: "scatter", mode: "markers", name: "発生公館", x: pf.map((p) => coord(p)[1]), y: pf.map((p) => coord(p)[0]), customdata: pf,
      marker: { size: pf.map((p) => 9 + 3 * from[p].length), color: "#C62828", line: { color: "#fff", width: 1 } },
      text: pf.map((p) => `<b>${p}</b>（${from[p].length}件）<br>` + from[p].map((c) => `${c.month ? fmtMonth(c.month) + " " : ""}${c.who} ${c.cond} → ${c.dest || "?"}`).join("<br>")), hoverinfo: "text" });
    if (pt.length) traces.push({ type: "scatter", mode: "markers+text", name: "移送先", x: pt.map((p) => coord(p)[1]), y: pt.map((p) => coord(p)[0]),
      marker: { symbol: "square", size: pt.map((p) => 9 + 3 * to[p].length), color: "#1565C0", line: { color: "#fff", width: 1 } },
      text: pt.map((p) => `${p}（${to[p].length}）`), textposition: "bottom center", textfont: { size: 11, color: "#0d47a1" },
      hovertext: pt.map((p) => `<b>移送先 ${p}</b>（${to[p].length}件）<br>` + to[p].map((c) => `${c.post}から ${c.cond}`).join("<br>")), hoverinfo: "text" });
  } else {
    for (const k of CASE_KINDS) {
      const g = {};
      for (const c of list) if (c.kind === k && coord(c.post)) (g[c.post] ||= []).push(c);
      const ps = Object.keys(g);
      if (!ps.length) continue;
      const off = CASE_KINDS.indexOf(k);
      traces.push({ type: "scatter", mode: "markers", name: k, customdata: ps,
        x: ps.map((p) => coord(p)[1] + 2 * Math.cos(off * 1.26)), y: ps.map((p) => coord(p)[0] + 1.5 * Math.sin(off * 1.26)),
        marker: { size: ps.map((p) => 9 + 3 * g[p].length), color: KIND_COLORS[k], line: { color: "#fff", width: 1 } },
        text: ps.map((p) => `<b>${p}：${k}（${g[p].length}件）</b><br>` + g[p].slice(0, 4).map((c) => wrap(c.note)).join("<br>")), hoverinfo: "text" });
    }
  }
  return traces;
}

async function pageCases(type) {
  if (needData()) return;
  const def = CASE_DEF[type], m = curMonth();
  await loadGeo();
  const list = casesOf(casesAll ? null : m, type);
  const allMonths = [...new Set(Object.values(state.reports).map((r) => r.month))].sort();
  const cnt = (key) => { const g = {}; for (const c of list) if (c[key]) g[c[key]] = (g[c[key]] || 0) + 1; return Object.entries(g).sort((a, b) => b[1] - a[1]); };
  const editable = !casesAll;
  main.innerHTML = `
    <h2>${def.title}（${casesAll ? "全期間" : fmtMonth(m)}）</h2>
    <div class="row"><label><input type="checkbox" id="call"${casesAll ? " checked" : ""}> 全期間を表示</label></div>
    <div class="kpis">
      <div class="kpi"><div class="label">件数</div><div class="value">${list.length}</div></div>
      <div class="kpi"><div class="label">対象</div><div class="delta">${cnt("who").map(([k, v]) => `${esc(k)} ${v}`).join("　") || "―"}</div></div>
      ${type === "evac"
        ? `<div class="kpi"><div class="label">主な移送先</div><div class="delta">${cnt("dest").slice(0, 4).map(([k, v]) => `${flagImg(k, "flag sm")}${esc(k)} ${v}`).join("　") || "―"}</div></div>
           <div class="kpi"><div class="label">転帰</div><div class="delta">${cnt("outcome").map(([k, v]) => `${esc(k)} ${v}`).join("　") || "―"}</div></div>`
        : `<div class="kpi"><div class="label">区分</div><div class="delta">${cnt("kind").map(([k, v]) => `<span class="dot" style="background:${KIND_COLORS[k]}"></span>${esc(k)} ${v}`).join("　") || "―"}</div></div>
           <div class="kpi"><div class="label">公館数</div><div class="value">${new Set(list.map((c) => c.post)).size}</div></div>`}
    </div>
    <div class="card">
      ${mapControls()}
      <div id="casemap" class="plot map"></div>
    </div>
    ${allMonths.length > 1 ? `<div class="card"><div id="casechart" class="plot" style="min-height:260px"></div></div>` : ""}
    <div class="card">
      <p class="muted">${def.desc}${editable ? "" : "（全期間表示では編集できません。月を選んで直してください）"}</p>
      <div class="table-wrap"><table id="ct"><thead><tr>${casesAll ? "<th>月</th>" : ""}${def.cols.map((c) => `<th>${c[1]}</th>`).join("")}${editable ? "<th></th>" : ""}</tr></thead><tbody>
        ${list.map((c) => `<tr data-src="${esc(c.src || "")}">${casesAll ? `<td>${fmtMonth(c.month)}</td>` : ""}${def.cols.map(([f, , kind]) => editable
          ? `<td>${caseInput(kind, f, c[f] || "")}</td>`
          : `<td>${kind === "post" || kind === "place" ? flagImg(c[f], "flag sm") : ""}${f === "post" ? `<button class="linklike" data-post-card="${esc(c.post)}">${esc(c.post)}</button>` : esc(c[f] || "")}</td>`).join("")}${editable ? "<td><button data-del>削除</button></td>" : ""}</tr>`).join("")}
      </tbody></table></div>
      ${list.length ? "" : `<p class="muted">${casesAll ? "" : fmtMonth(m) + "の"}${type === "evac" ? "緊急移送" : "邦人対応"}の記述は見つかりませんでした。</p>`}
      ${editable ? `<div class="row"><button id="caddRow">行を追加</button><button class="primary" id="csave">保存</button><button id="credetect">丙表から拾い直す</button></div>` : ""}
    </div>`;
  $("#call").onchange = (e) => { casesAll = e.target.checked; savePref("casesAll", casesAll); render(); };
  drawMap("casemap", caseTraces(list, type), 480);
  bindMapControls();
  if (allMonths.length > 1) {
    const all = casesOf(null, type);
    const groups = type === "evac" ? CASE_WHO : CASE_KINDS;
    const key = type === "evac" ? "who" : "kind";
    plot("casechart", groups.filter((g) => all.some((c) => c[key] === g)).map((g) => ({ type: "bar", name: g,
      ...(type === "hogo" ? { marker: { color: KIND_COLORS[g] } } : {}),
      x: allMonths.map(fmtMonth), y: allMonths.map((mm) => all.filter((c) => c.month === mm && c[key] === g).length) })),
      { title: `月別の件数（${type === "evac" ? "対象別" : "区分別"}）`, barmode: "stack", height: 260, margin: { l: 40, r: 20, t: 40, b: 40 } });
  }
  if (!editable) return;
  const bindDel = () => document.querySelectorAll("#ct [data-del]").forEach((b) => (b.onclick = () => b.closest("tr").remove()));
  bindDel();
  $("#caddRow").onclick = () => {
    $("#ct tbody").insertAdjacentHTML("beforeend", `<tr data-src="">${def.cols.map(([f, , kind]) => `<td>${caseInput(kind, f, "")}</td>`).join("")}<td><button data-del>削除</button></td></tr>`);
    bindDel();
  };
  $("#csave").onclick = async () => {
    const rows = [...document.querySelectorAll("#ct tbody tr")].map((tr) => {
      const o = { type, src: tr.dataset.src || "" };
      tr.querySelectorAll("[data-f]").forEach((i) => (o[i.dataset.f] = i.value.trim()));
      return o;
    }).filter((o) => o.post);
    // もう一方の種類（緊急移送／邦人対応）はそのまま残す
    const other = casesOf(m, type === "evac" ? "hogo" : "evac").map(({ month, ...c }) => c);
    (state.cases ||= {})[m] = other.concat(rows);
    await saveState(); toast("保存しました"); render();
  };
  $("#credetect").onclick = async () => {
    if (!confirm("この月の緊急移送・邦人対応の一覧を丙表から拾い直します。手で直した内容は消えます。よろしいですか？")) return;
    if (state.cases) delete state.cases[m];
    await saveState(); render();
  };
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
        ${mapControls()}<div id="tmap" class="plot map"></div>` : '<p class="muted">2か月以上のデータが揃うと交代を検出します。</p>'}
    </div>
    <div class="card"><h3 style="margin-top:0">公館×月 医務官一覧</h3><div class="table-wrap"><table><thead><tr><th>公館</th>${ms.map((m) => `<th>${fmtMonth(m)}</th>`).join("")}</tr></thead><tbody>${
      posts.map((p) => `<tr><td>${esc(p)}</td>${ms.map((m) => `<td>${esc((ot[m] || {})[p] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;
  if (tr.length) { drawMap("tmap", worldTraces(null, { transfers: true, allTransfers: true }), 480); bindMapControls(); }
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
    if (!g && !p) for (const reg of REGIONS) traces.push({ type: "scatter", mode: "lines+markers", name: reg, visible: "legendonly", x: xs, line: { color: regionColor(reg), width: 2 },
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

// ======================================================================= PDFレポート
// 書き出しはパスワード付きPDFのみ。各ページを画像にして「取扱注意」の透かしを焼き込むので、印刷しても必ず透かしが出る

const PDF_PASSWORD = "imukanmd";
const RP_W = 794, RP_H = 1123;  // A4（96dpi）
const WATERMARK = "取扱注意";

function pageReport() {
  if (needData()) return;
  const m = curMonth();
  main.innerHTML = `
    <h2>統合PDFレポート（${fmtMonth(m)}）</h2>
    <div class="card">
      <p>表紙・目次・全体概況・世界地図・受診者数統計・疾病分類統計・巡回健診／医務官の異動・緊急移送／邦人対応・公館別5行サマリーを含む PDF を作成します。</p>
      <ul class="muted" style="margin:6px 0 10px">
        <li>🔒 パスワード付き（開くときにパスワードが必要）。印刷のみ許可し、編集・文字のコピーはできません</li>
        <li>パスワードは解除できません（解除や権限の変更に必要な所有者パスワードは、作成のたびに乱数で作り、どこにも残しません）</li>
        <li><b>印刷したときだけ</b>、全ページに「${WATERMARK}」の透かし・印・注意書きが入ります（画面では表示しません）</li>
        <li>目次の各行を押すとその章へ移動します。ビューアの「しおり」からも移動できます</li>
        <li>作成もブラウザの中だけで行い、外部には送信しません</li>
      </ul>
      <div class="row"><b>PDFにする項目</b><button class="linklike" id="secAll">すべて選ぶ</button><button class="linklike" id="secNone">すべて外す</button></div>
      <div class="row secpick">${REPORT_SECTIONS.map(([k, t]) => `<label><input type="checkbox" data-rsec="${k}"${(loadPrefs().reportSecs || REPORT_SECTIONS.map((x) => x[0])).includes(k) ? " checked" : ""}> ${t}</label>`).join("")}</div>
      <p class="muted" style="margin-top:0">表紙と目次は常に入ります。</p>
      <div class="row"><button class="primary" id="mk">PDFを作成（別のタブで開く）</button><span id="wst" class="muted"></span></div>
      <p class="muted" style="margin-bottom:0">別のタブでPDFを作成し、できあがったPDFをそのタブで表示します（表示・印刷・保存はそのタブで）。作成中もこのタブで作業を続けられます。</p>
    </div>`;
  const chosen = () => [...document.querySelectorAll("[data-rsec]")].filter((c) => c.checked).map((c) => c.dataset.rsec);
  document.querySelectorAll("[data-rsec]").forEach((c) => (c.onchange = () => savePref("reportSecs", chosen())));
  $("#secAll").onclick = () => { document.querySelectorAll("[data-rsec]").forEach((c) => (c.checked = true)); savePref("reportSecs", chosen()); };
  $("#secNone").onclick = () => { document.querySelectorAll("[data-rsec]").forEach((c) => (c.checked = false)); savePref("reportSecs", chosen()); };
  $("#mk").onclick = () => {
    if (!chosen().length) { toast("PDFにする項目を1つ以上選んでください"); return; }
    const q = new URLSearchParams({ pdfjob: "1", m, secs: chosen().join(",") });
    if (demoMode) q.set("demo", "1");
    // 同じサイトのタブとして開く（同意の状態を引き継ぐため noopener は付けない）
    const w = window.open(`${location.pathname}?${q}`, "_blank");
    if (w) { $("#wst").textContent = "別のタブでPDFを作成しています"; return; }
    // ポップアップが止められたときは、このタブで作成する
    $("#wst").textContent = "新しいタブを開けなかったので、このタブで作成します…";
    makeHere();
  };
  const makeHere = async () => {
    $("#mk").disabled = true; $("#wst").textContent = "作成中…";
    try {
      const blob = await buildReportPdf(m, new Set(chosen()), (s) => ($("#wst").textContent = s));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `医務官月報統合レポート_${m.replace("-", "")}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      $("#wst").textContent = `ダウンロードしました（${(blob.size / 1048576).toFixed(1)} MB）。医務官のみがアクセスできるフォルダに保存してください`;
    } catch (e) {
      console.error(e);
      $("#wst").textContent = "作成に失敗しました: " + e.message;
    } finally { $("#mk").disabled = false; }
  };
}

async function figUrl(traces, layout, width, height, config = {}) {
  const div = document.createElement("div");
  div.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px`;
  document.body.appendChild(div);
  const lay = Object.assign({ width, height, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff", font: { color: "#1c2430", size: 13 } }, layout);
  await Plotly.newPlot(div, traces, lay, Object.assign({ staticPlot: true }, config));
  const url = await Plotly.toImage(div, { format: "png", width, height, scale: 2 });
  Plotly.purge(div); div.remove();
  return url;
}

// レポートの部品（DOM要素）。ページ割りは paginate() が行う
const rp = {
  el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; },
  H(text, level) { const e = rp.el("h" + level, "", esc(text)); return e; },
  P(text, cls = "") { return rp.el("p", cls, esc(text)); },
  LI(text) { return rp.el("div", "rp-li", esc(text)); },
  IMG(src, w) { const d = rp.el("div", "rp-fig"); const i = new Image(); i.src = src; i.style.width = w + "px"; d.appendChild(i); return d; },
  IMGS(srcs, w) { const d = rp.el("div", "rp-fig"); for (const s of srcs) { const i = new Image(); i.src = s; i.style.width = w + "px"; d.appendChild(i); } return d; },
  TABLE(head, rows, { bold = new Set(), widths } = {}) {
    const t = rp.el("table", "rp-table");
    if (widths) t.innerHTML = `<colgroup>${widths.map((w) => `<col style="width:${w}%">`).join("")}</colgroup>`;
    t.insertAdjacentHTML("beforeend", `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
      rows.map((r, i) => `<tr${bold.has(i) ? ' class="b"' : ""}>${r.map((v) => `<td${typeof v === "number" || /^[+\-]?\d+(\.\d+)?$/.test(String(v ?? "")) ? ' class="num"' : ""}>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody>`);
    return t;
  },
  BREAK: "break",
};

function paginate(blocks, host, header) {
  const pages = [];
  let body;
  const newPage = (cover) => {
    const pg = rp.el("div", "rp-page" + (cover ? " rp-cover" : ""));
    if (!cover) pg.innerHTML = `<div class="rp-head"><span>${esc(header)}</span></div>`;
    body = rp.el("div", "rp-body");
    pg.appendChild(body);
    if (!cover) pg.appendChild(rp.el("div", "rp-foot", `<span></span><span class="rp-no"></span>`));
    host.appendChild(pg); pages.push(pg);
  };
  const fits = () => body.scrollHeight <= body.clientHeight + 1;
  // ページの末尾に残った見出しは、次の内容と一緒に次のページへ送る
  const carryHeadings = () => {
    const out = [];
    while (body.lastElementChild && /^H[1-3]$/.test(body.lastElementChild.tagName)) out.unshift(body.removeChild(body.lastElementChild));
    return out;
  };
  const turn = (carry = []) => { newPage(); for (const c of carry) body.appendChild(c); };
  let first = true;
  for (const b of blocks) {
    if (b === rp.BREAK) { if (body && body.children.length) turn(); continue; }
    if (first) { newPage(b.classList.contains("rp-coverbox")); first = false; }
    body.appendChild(b);
    if (fits()) continue;
    if (b.tagName === "TABLE" && b.tBodies[0].rows.length > 1) {
      const rows = [...b.tBodies[0].rows], blank = b.cloneNode(true);
      blank.tBodies[0].innerHTML = "";
      b.tBodies[0].innerHTML = "";
      let cur = b;
      for (const r of rows) {
        cur.tBodies[0].appendChild(r);
        if (fits()) continue;
        cur.tBodies[0].removeChild(r);
        if (!cur.tBodies[0].rows.length) { body.removeChild(cur); turn([...carryHeadings(), cur]); }
        else { cur = blank.cloneNode(true); turn([cur]); }
        cur.tBodies[0].appendChild(r);
      }
      continue;
    }
    body.removeChild(b);
    if (!body.children.length) { body.appendChild(b); continue; }  // 1ページに収まらない大きさならそのまま
    turn([...carryHeadings(), b]);
  }
  return pages;
}

async function renderPages(pages, host, progress) {
  const out = [], S = 2;
  for (let i = 0; i < pages.length; i++) {
    progress && progress(`ページを画像にしています… ${i + 1} / ${pages.length}`);
    const cv = await html2canvas(pages[i], {
      scale: S, backgroundColor: "#ffffff", logging: false, useCORS: false,
      ignoreElements: (el) => el.parentElement === document.body && el !== host,
    });
    const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.85));
    out.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: cv.width, height: cv.height });
  }
  return out;
}

// 印刷するときだけ出る層（全ページ共通）：中央の斜めの透かし・右上の「取扱注意」の印・下の注意書き。
// PDF の任意コンテンツ（印刷時のみ表示）として重ねる。ページ画像と同じ大きさ（A4、96dpi の2倍）
function printOverlay() {
  const S = 2, cv = document.createElement("canvas");
  cv.width = RP_W * S; cv.height = RP_H * S;
  const c = cv.getContext("2d"), font = `"Hiragino Sans","Yu Gothic","Meiryo","Noto Sans CJK JP","Noto Sans JP",sans-serif`;
  c.save();
  c.translate(cv.width / 2, cv.height / 2);
  c.rotate(-Math.atan2(cv.height, cv.width));
  c.font = `bold ${140 * S}px ${font}`; c.textAlign = "center"; c.textBaseline = "middle";
  c.fillStyle = "rgba(200, 30, 30, 0.13)";
  c.fillText(WATERMARK, 0, 0);
  c.restore();
  // 右上の印
  c.font = `800 ${13 * S}px ${font}`; c.textBaseline = "middle";
  const tw = c.measureText("取 扱 注 意").width, bx = cv.width - 56 * S - tw - 24 * S, by = 30 * S;
  c.fillStyle = "#fff"; c.fillRect(bx, by, tw + 24 * S, 26 * S);
  c.strokeStyle = "#c62828"; c.lineWidth = 2 * S; c.strokeRect(bx, by, tw + 24 * S, 26 * S);
  c.fillStyle = "#c62828"; c.textAlign = "center"; c.fillText("取 扱 注 意", bx + (tw + 24 * S) / 2, by + 13 * S);
  // 下の注意書き
  c.font = `${10 * S}px ${font}`; c.textAlign = "left"; c.fillStyle = "#c62828";
  c.fillText(`${WATERMARK}：職員・家族の健康情報を含みます。関係者以外への開示・複製を禁じます。`, 56 * S, cv.height - 22 * S);
  return { rgba: c.getImageData(0, 0, cv.width, cv.height).data, width: cv.width, height: cv.height };
}

async function buildReportPdf(m, sections, progress) {
  progress && progress("グラフを作成しています…");
  const blocks = await reportBlocks(m, sections);
  const host = rp.el("div", "rp-host");
  document.body.appendChild(host);
  try {
    await document.fonts.ready;
    const [y, mo] = m.split("-");
    const pages = paginate(blocks, host, `医務官月報 統合レポート　${y}年${Number(mo)}月分`);
    await Promise.all([...host.querySelectorAll("img")].map((i) => i.decode().catch(() => {})));
    // 目次とページ番号
    pages.forEach((pg, i) => { const no = pg.querySelector(".rp-no"); if (no) no.textContent = `${i + 1} / ${pages.length}`; });
    // 目次：ページ番号を入れ、行全体をその章へのリンクにする。しおり（ビューアの左側の目次）も作る
    const pageOf = (el) => pages.findIndex((pg) => pg.contains(el));
    const links = [], outlines = [{ title: "表紙", dest: 0 }];
    const tocH = [...host.querySelectorAll("h1")].find((h) => h.textContent === "目次");
    if (tocH) outlines.push({ title: "目次", dest: pageOf(tocH) });
    host.querySelectorAll("[data-toc]").forEach((t) => {
      const h = host.querySelector(`h1[data-sec="${t.dataset.toc}"]`);
      const pi = h ? pageOf(h) : -1;
      t.querySelector(".pg").textContent = pi >= 0 ? pi + 1 : "";
      if (pi < 0) return;
      const ti = pageOf(t), pr = pages[ti].getBoundingClientRect(), r = t.getBoundingClientRect();
      links.push({ page: ti, dest: pi, rect: [(r.left - pr.left) / pr.width, (r.top - pr.top - 3) / pr.height, r.width / pr.width, (r.height + 6) / pr.height] });
      outlines.push({ title: t.dataset.toc, dest: pi });
    });
    const imgs = await renderPages(pages, host, progress);
    progress && progress("暗号化しています…");
    return await SecurePdf.buildEncryptedPdf(imgs, { userPassword: PDF_PASSWORD, title: `医務官月報 統合レポート ${y}年${Number(mo)}月分（${WATERMARK}）`, links, outlines, overlay: printOverlay() });
  } finally { host.remove(); }
}

// PDFにする章（選んだものだけを、この順で番号を振って入れる）
const REPORT_SECTIONS = [["overview", "全体概況"], ["map", "世界地図"], ["visits", "受診者数統計（甲表）"], ["diseases", "疾病分類統計（乙表）"],
  ["junkai", "巡回健診・医務官の異動"], ["cases", "緊急移送・邦人対応"], ["summary", "公館別 5行サマリー"]];
async function reportBlocks(m, sections) {
  const { H, P, LI, IMG, IMGS, TABLE, BREAK } = rp;
  const on = (k) => sections.has(k);
  const chosen = REPORT_SECTIONS.filter(([k]) => on(k)), titleOf = {};
  chosen.forEach(([k, t], i) => (titleOf[k] = `${i + 1}. ${t}`));
  const rep = reportsOf(m), dis = diseasesOf(m), miss = missingPosts(m) || [], tr = transfers().filter((t) => t.month === m), jk = junkaiOf(m);
  const [y, mo] = m.split("-");
  const ch = [];
  const sec = (key) => { const h = H(titleOf[key], 1); h.dataset.sec = titleOf[key]; ch.push(h); };

  ch.push(rp.el("div", "rp-coverbox", `
    <h1>医務官月報 統合レポート</h1>
    <p class="rp-cm">${y}年${Number(mo)}月分</p>
    <p class="rp-cs">提出 ${rep.length}公館　／　未提出 ${miss.length}公館</p>
    <p class="rp-cn">本資料には在外公館職員・家族の健康情報が含まれます。<br>取扱いに注意し、関係者以外への開示・複製・転送をしないでください。</p>
    <p class="rp-cd">作成日：${fmtDate(Date.now())}</p>`));
  ch.push(BREAK);

  const secs = chosen.map(([k]) => titleOf[k]);
  ch.push(H("目次", 1));
  for (const s of secs) { const e = rp.el("div", "rp-toc", `<span>${esc(s)}</span><span class="dots"></span><span class="pg"></span>`); e.dataset.toc = s; ch.push(e); }
  ch.push(BREAK);

  if (on("overview")) {
    sec("overview");
    overviewBullets(m).forEach((b) => ch.push(LI(b)));
  }

  if (on("map")) {
    await loadGeo();
    sec("map");
    // 紙で見るので、地球儀ではなく平面の世界地図にする
    ch.push(IMG(await figUrl(toGeoTraces(worldTraces(m, { disease: true, visits: true, outbreak: true, events: true, junkai: true, transfers: true })),
      Object.assign(mapLayout(620, true, true), { legend: { orientation: "h", y: -0.02, x: 0, font: { size: 12 } } }), 1200, 680,
      { topojsonURL: MAP_CONFIG.topojsonURL }), 690));
    ch.push(P(`※国の塗り分けは最多疾病分類（実患${MIN_FULL}件未満の国は薄色）。○は受診者数、✚と病名は丙表で報告された病気（↑＝流行・増加）、その他の記号は災害・治安等。`, "rp-note"));
  }

  const regs = REGIONS.filter((r) => rep.some((x) => x.region === r));
  if (on("visits")) {
  sec("visits");
  if (rep.length) {
    ch.push(IMG(await figUrl(VISIT_KEYS.map(([f, name, color]) => ({
      type: "bar", orientation: "h", name, marker: { color }, y: regs, x: regs.map((g) => sum(rep.filter((r) => r.region === g), (r) => r[f])) })),
      { title: "地域別 受診者数", barmode: "stack", yaxis: { autorange: "reversed" }, margin: { l: 110, r: 20, t: 50, b: 40 } }, 1000, 460), 600));
  }
  const ms = months().filter((x) => Object.values(state.reports).some((r) => r.month === x));
  if (ms.length >= 2) {
    const all = reportsOf();
    const traces = REGIONS.map((g) => ({ type: "scatter", mode: "lines+markers", name: g, line: { color: regionColor(g, true), width: 2 }, x: ms.map(fmtMonth), y: ms.map((mm) => sum(all.filter((r) => r.month === mm && r.region === g), (r) => r.total)) }));
    traces.push({ type: "scatter", mode: "lines+markers", name: "合計", line: { color: "#000", width: 3 }, x: ms.map(fmtMonth), y: ms.map((mm) => sum(all.filter((r) => r.month === mm), (r) => r.total)) });
    ch.push(IMG(await figUrl(traces, { title: "受診者数の月次推移（地域別）", margin: { l: 60, r: 20, t: 50, b: 40 } }, 1000, 440), 600));
  }
  if (rep.length) {
    // 受診者の内訳と地域構成のドーナツを横に並べる
    const di = donutItems(m);
    const fv = donutFig(di.visit, { title: "受診者の内訳", unit: "名", forExport: true });
    const fr = donutFig(di.region.map((x) => ({ ...x, color: regionColor(x.label, true) })), { title: "地域別の受診者数", unit: "名", forExport: true });
    const tpl = { template: chartTemplate(true) };
    ch.push(IMGS([await figUrl(fv.traces, Object.assign(fv.layout, tpl), 520, 400), await figUrl(fr.traces, Object.assign(fr.layout, tpl), 520, 400)], 330));
    ch.push(H("記述統計（1公館あたり受診者数）", 2));
    const sr = statsRows(m);
    ch.push(TABLE(["地域", "公館数", "合計", "平均", "標準偏差", "最小", "中央値", "最大", "職員/家族/その他"],
      sr.map((r) => [r.g, String(r.d.n), String(r.d.total), f1(r.d.mean), f1(r.d.sd), `${f1(r.d.min)}（${r.minP || ""}）`, f1(r.d.median), `${f1(r.d.max)}（${r.maxP || ""}）`, `${r.staff}/${r.family}/${r.other}`]),
      { bold: new Set([0]), widths: [13, 7, 7, 7, 8, 16, 7, 16, 19] }));
    const mo2 = momStats(m);
    if (mo2.length) ch.push(P(`前月も提出した${mo2.length}公館のうち、受診者数が増えたのは${mo2.filter((x) => x.diff > 0).length}公館、減ったのは${mo2.filter((x) => x.diff < 0).length}公館（合計 ${sum(mo2, (x) => x.diff) >= 0 ? "+" : ""}${sum(mo2, (x) => x.diff)}名）。`, "rp-small"));
    ch.push(H("公館別の受診者数", 2));
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
  ch.push(TABLE(["地域", "公館", "医務官", "職員", "家族", "その他", "計", "前月比"], rows, { bold, widths: [16, 20, 17, 8, 8, 8, 12, 11] }));
  }

  if (on("diseases")) {
  ch.push(BREAK);
  sec("diseases");
  if (dis.length) {
    const di = donutItems(m);
    const fc = donutFig(di.cat, { title: "疾病分類の構成（実患）", forExport: true }), fk = donutFig(di.kind, { title: "実患と検診・予防接種", forExport: true });
    const tpl = { template: chartTemplate(true) };
    ch.push(IMGS([await figUrl(fc.traces, Object.assign(fc.layout, tpl), 520, 400), await figUrl(fk.traces, Object.assign(fk.layout, tpl), 520, 400)], 330));
    const cats = CATEGORIES.filter((c) => c !== Z && dis.some((d) => d.category === c));
    ch.push(IMG(await figUrl(cats.map((c) => ({ type: "bar", orientation: "h", name: shortCat(c), marker: { color: D.colors[c] }, y: regs,
      x: regs.map((g) => sum(dis.filter((d) => d.region === g && d.category === c), (d) => d.count)) })),
      { title: "地域別 疾病分類（検診・予防接種を除く）", barmode: "stack", yaxis: { autorange: "reversed" }, margin: { l: 110, r: 20, t: 50, b: 40 }, legend: { orientation: "h", y: -0.15 } }, 1000, 520), 600));
    ch.push(H("分類別・地域別件数", 2));
    const allCats = CATEGORIES.filter((c) => dis.some((d) => d.category === c))
      .map((c) => [c, regs.map((g) => sum(dis.filter((d) => d.region === g && d.category === c), (d) => d.count))])
      .sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
    ch.push(TABLE(["疾病分類", ...regs, "計"], allCats.map(([c, v]) => [shortCat(c), ...v.map(String), String(v.reduce((x, y) => x + y, 0))])));
    ch.push(H("診断名トップ10（検診・予防接種等を除く）", 2));
    ch.push(TABLE(["順位", "診断名", "分類", "件数", "公館数"], topDiseases(dis).map((x, i) => [String(i + 1), x.name, shortCat(x.category), String(x.count), String(x.posts)]), { widths: [8, 42, 26, 12, 12] }));
  } else ch.push(P("乙表データなし"));
  }

  if (on("junkai")) {
  sec("junkai");
  ch.push(H("巡回健診", 2));
  if (jk.length) ch.push(TABLE(["実施公館", "巡回先", "期間", "記載"], jk.map((j) => [j.from, j.dest || "（不明）", j.period || "", (j.note || "").slice(0, 80)]), { widths: [18, 18, 14, 50] }));
  else ch.push(P("今月の巡回健診の報告なし"));
  ch.push(H("医務官の異動・交代", 2));
  if (tr.length) ch.push(TABLE(["公館", "前任", "後任", "後任の前任地"], tr.map((t) => [t.post, t.before, t.after, t.from || ""])));
  else ch.push(P("前月からの医務官の交代なし（月報ヘッダー・配置表による）"));
  }

  if (on("cases")) {
  sec("cases");
  const evs = casesOf(m, "evac"), hgs = casesOf(m, "hogo");
  ch.push(H("緊急移送症例", 2));
  if (evs.length) ch.push(TABLE(["公館", "対象", "病名・状況", "移送先", "手段", "転帰"], evs.map((c) => [c.post, c.who, c.cond, c.dest, c.means, c.outcome]), { widths: [16, 14, 24, 15, 18, 13] }));
  else ch.push(P("今月の緊急移送の報告なし"));
  ch.push(H("邦人対応事例", 2));
  if (hgs.length) ch.push(TABLE(["公館", "区分", "対象", "内容"], hgs.map((c) => [c.post, c.kind, c.who, c.note.slice(0, 90)]), { widths: [16, 10, 14, 60] }));
  else ch.push(P("今月の邦人対応の報告なし"));
  }

  if (on("summary")) {
  ch.push(BREAK);
  sec("summary");
  for (const g of [...REGIONS, "未分類"]) {
    const rs = rep.filter((r) => r.region === g), mm = miss.filter((x) => x.region === g);
    if (!rs.length && !mm.length) continue;
    ch.push(H(g, 2));
    for (const r of rs) {
      ch.push(H(`${r.post}（医務官：${r.officer || "―"}）`, 3));
      (r.summary || ruleSummary(m, r.post)).split("\n").slice(0, 5).forEach((l) => ch.push(LI(l)));
    }
    for (const x of mm) {
      ch.push(H(`${x.post}（医務官：${x.officer || "―"}）`, 3));
      ch.push(P(`${Number(mo)}月分の月報提出なし`, "rp-red"));
    }
  }
  }
  return ch;
}

// ======================================================================= AI分析（個人情報を含まない形で書き出す）
// MOFA GaiXer・政府AI「源内」で分析するための集計テキストを作る。
// 氏名・個別症例の記述（丙表の文章、緊急移送・邦人対応の内容）は入れず、件数と病名・国名だけにする。1〜2件は「3未満」と表記する
const AI_SITES = [["gaixer", "MOFA GaiXer"], ["gennai", "政府AI「源内」"]];
const aiUrls = () => Object.assign({ gaixer: "", gennai: "" }, loadPrefs().aiUrls || {});
// 依頼文（プロンプト）の一覧。ボタンで選ぶと、その分析に必要な集計の項目にも自動でチェックが入る
const AI_HEAD = "以下は在外公館の医務官月報を集計した統計です（個人情報は含みません）。";
const ALL_SECS = ["submit", "visits", "cats", "top", "hei", "events", "cases", "quality"];
const AI_PROMPT_LIST = [
  { group: "疫学的な俯瞰", items: [
    { k: "overview", icon: "🌏", title: "今月の全体像", ex: "例：今月、世界の公館で何が起きている？要点だけ知りたい", secs: ALL_SECS,
      text: "今月の状況を、疫学的な観点から要点5つ以内にまとめてください。各要点には根拠となる数値を添え、最後に「来月注意すべきこと」を3つ挙げてください。" },
    { k: "outbreak", icon: "🦟", title: "感染症の流行警戒", ex: "例：デング熱・マラリアなど、どこで何が増えている？職員への注意喚起は？", secs: ["hei", "cats", "top", "events"],
      text: "丙表で報告された感染症と疾病分類の件数から、流行・増加している感染症を国・地域別に整理してください。感染経路と予防策を簡潔に添え、在外職員・家族向けの注意喚起文案（300字程度）も作ってください。" },
    { k: "season", icon: "📈", title: "前月比・季節性", ex: "例：先月と比べて増えた病気は？季節的なものか、異常な増加か？", secs: ["visits", "cats", "top", "hei"],
      text: "前月からの変化と、各地域の季節（雨季・乾季、冬季など）を踏まえ、増減が季節的なものか異常な変化かを考察してください。追加で確認すべき点も挙げてください。" },
    { k: "region", icon: "🗺", title: "地域ごとの違い", ex: "例：アフリカとヨーロッパで疾病の構成はどう違う？背景は？", secs: ["visits", "cats", "top"],
      text: "地域ごとの受診者数と疾病分類の構成を比較し、違いの特徴とその背景（気候・衛生環境・医療事情など）を考察してください。地域別に重点を置くべき健康管理策も提案してください。" },
    { k: "mental", icon: "🧠", title: "メンタルヘルス", ex: "例：不眠・抑うつは増えている？災害・治安との関係は？", secs: ["cats", "top", "events", "visits"],
      text: "精神・行動の分類や不眠などの件数から、在外職員・家族のメンタルヘルスの状況を考察してください。災害・治安の状況との関連の可能性と、公館でできる支援策を提案してください。" },
    { k: "lifestyle", icon: "🩺", title: "生活習慣病・健康管理", ex: "例：高血圧・脂質異常などへの対策は？健診で何を重視すべき？", secs: ["cats", "top", "visits"],
      text: "循環器・内分泌などの生活習慣病に関する件数から、在外職員の健康管理上の課題を整理し、健康診断や保健指導で重視すべき点を提案してください。" },
    { k: "disaster", icon: "🌪", title: "災害・治安と健康影響", ex: "例：洪水・暴動などがあった国で、どんな健康リスクがある？", secs: ["events", "hei", "cases", "cats"],
      text: "災害・治安の報告がある国について、想定される健康リスク（感染症、外傷、精神的影響、医療アクセスの低下など）と、公館・医務官が取るべき備えを整理してください。" },
    { k: "evac", icon: "🚑", title: "緊急移送・邦人対応", ex: "例：緊急移送が多い地域は？体制上の課題は？", secs: ["cases", "events", "visits"],
      text: "緊急移送・邦人対応の地域別の件数から、医療体制や移送体制の課題を考察し、改善策を提案してください。" },
  ] },
  { group: "時系列・1か国", items: [
    { k: "trend", icon: "📉", title: "推移の分析（時系列）", ex: "例：この1年で増えた病気・減った病気は？季節の波は？", secs: ALL_SECS, period: 12,
      text: "月ごとの推移から、増加・減少している疾病、季節性のある疾病、受診者数や提出状況の変化を読み取り、要因の考察と今後の見通しをまとめてください。特に注意すべき変化は根拠となる数値とともに挙げてください。" },
    { k: "country", icon: "📍", title: "1か国の詳しい分析", ex: "例：ケニアの最近1年の傾向と、職員への助言は？", secs: ALL_SECS, period: 12, scope: "post",
      text: "対象の国（公館）について、月ごとの推移から疾病の傾向・季節性・注意すべき感染症をまとめ、その国で勤務する職員・家族への健康上の助言と、月報の記載をより充実させるための提案をしてください。" },
    { k: "compare", icon: "⚖", title: "地域の推移の比較", ex: "例：アフリカでは感染症が季節でどう変わる？他の地域と比べて？", secs: ["visits", "cats", "top", "hei"], period: 12,
      text: "対象地域の月ごとの推移について、疾病構成の変化と季節性を整理し、世界全体の傾向と比べて特徴的な点を考察してください。" },
  ] },
  { group: "提出率アップ・内容の充実", items: [
    { k: "rate", icon: "📮", title: "提出率を上げる", ex: "例：未提出が続く公館へどう働きかける？リマインド文案がほしい", secs: ["submit"],
      text: "提出状況から、提出率を上げるための具体策を提案してください。未提出の公館に送るリマインドの文案（丁寧で負担感の少ないもの、200字程度）も作ってください。" },
    { k: "quality", icon: "✍", title: "記載内容の充実", ex: "例：丙表が短い公館に、どんなことを書いてもらえばいい？記載例は？", secs: ["quality", "hei", "submit"],
      text: "記載状況から、月報の内容を充実させるための助言をまとめてください。丙表（報告事項）に書いてほしい項目の一覧と、短くても役に立つ記載例を3つ示してください。" },
    { k: "feedback", icon: "💌", title: "医務官へのフィードバック", ex: "例：全医務官に送る今月の総括とお礼のメールを書いてほしい", secs: ALL_SECS,
      text: "全医務官あてに、今月の月報の総括（全体の傾向、注目すべき報告）とお礼、来月の記載のお願いを含むメール文案（600〜800字、丁寧な文体）を作ってください。提出してくれたことへの感謝が伝わるようにしてください。" },
    { k: "form", icon: "🗂", title: "様式の改善", ex: "例：月報の様式をどう変えれば書きやすく・集計しやすくなる？", secs: ["quality", "submit", "cats"],
      text: "記載状況と集計結果から、月報の様式（甲表・乙表・丙表）を書きやすく、かつ集計しやすくするための改善案を提案してください。" },
  ] },
  { group: "報告・資料づくり", items: [
    { k: "brief", icon: "📄", title: "幹部向け1枚要約", ex: "例：上司に報告する1ページの要約を作りたい", secs: ALL_SECS,
      text: "幹部向けに、A4 1枚程度の報告用要約を作ってください。構成は「結論」「主な数値」「注意すべき事項」「対応・提案」とし、簡潔な箇条書きにしてください。" },
    { k: "charts", icon: "📊", title: "図表の提案", ex: "例：このデータはどんなグラフで見せると伝わる？", secs: ["visits", "cats", "top", "submit"],
      text: "この集計を報告資料にするとき、どのデータをどのグラフ・表で示すと伝わりやすいかを提案してください。各図表のタイトル案と読み取ってほしいポイントも添えてください。" },
  ] },
];
const AI_PROMPT_FLAT = AI_PROMPT_LIST.flatMap((g) => g.items);
const customPrompts = () => loadPrefs().aiCustomPrompts || [];
const AI_SECTIONS = [["submit", "提出状況・提出率"], ["visits", "受診者数（地域別）"], ["cats", "疾病分類（地域別）"], ["top", "病名の上位"],
  ["hei", "丙表の流行情報（国別・病名のみ）"], ["events", "災害・治安など（国別）"], ["cases", "緊急移送・邦人対応（地域別の件数のみ）"], ["quality", "月報の記載状況"]];
const small = (v) => (v > 0 && v < 3 ? "3未満" : String(v));

// 対象：地域と国（公館）を任意に組み合わせて選ぶ。scope = { regions: [...], posts: [...] }（どちらも空なら全世界）
const regionLabel = (g) => (g === "米州" ? "米州（北米・中南米）" : g);
const normScope = (sc) => {
  if (!sc) return { regions: [], posts: [] };
  if (sc.type === "region") return { regions: [sc.value], posts: [] };  // 以前の形式
  if (sc.type === "post") return { regions: [], posts: [sc.value] };
  if (sc.type === "world") return { regions: [], posts: [] };
  return { regions: (sc.regions || []).filter((g) => REGIONS.includes(g)), posts: sc.posts || [] };
};
const isWorld = (sc) => !sc.regions.length && !sc.posts.length;
const scopeFilter = (sc) => (post) => isWorld(sc) || sc.regions.includes(regionOf(post)) || sc.posts.includes(post);
const scopeLabel = (sc) => {
  if (isWorld(sc)) return "全世界";
  const all = [...sc.regions.map(regionLabel), ...sc.posts];
  return all.length > 6 ? `${all.slice(0, 6).join("・")} ほか${all.length - 6}` : all.join("・");
};
function aiText(m, secs, scope = { regions: [], posts: [] }) {
  const [y, mo] = m.split("-");
  // 1つの地域だけ・1つの国だけを選んだときは、表の見出しをその名前にする
  const region = scope.regions.length === 1 && !scope.posts.length ? scope.regions[0] : "", one = scope.posts.length === 1 && !scope.regions.length ? scope.posts[0] : "";
  const inR = scopeFilter(scope);
  const lab = (g) => one || g;
  const repOf = (x) => reportsOf(x).filter((r) => inR(r.post));
  const missOf = (x) => { const ms = missingPosts(x); return ms && ms.filter((r) => inR(r.post)); };
  const rep = repOf(m), miss = missOf(m), dis = diseasesOf(m).filter((d) => inR(d.post));
  const L = [];
  const table = (head, rows) => { L.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)); };
  L.push(`# 医務官月報 集計（${y}年${Number(mo)}月分・${scopeLabel(scope)}・個人情報を含まない形）`, "※氏名・個別症例の記述は含みません。1〜2件の値は「3未満」と表記しています。", "");
  const regs = REGIONS.filter((g) => rep.some((r) => r.region === g));
  if (secs.has("submit")) {
    L.push("## 提出状況");
    if (miss) {
      const n = rep.length + miss.length;
      L.push(`- 医務官配置公館 ${n}／提出 ${rep.length}（提出率 ${(100 * rep.length / n).toFixed(1)}%）`);
      L.push(`- 未提出公館：${miss.map((x) => x.post).join("、") || "なし"}`);
    } else L.push(`- 提出 ${rep.length}公館（配置表が未登録のため提出率は不明）`);
    const hist = months().filter((x) => x <= m).slice(-6).map((x) => { const ms = missOf(x), k = repOf(x).length; return ms ? `${fmtMonth(x)} ${(100 * k / (k + ms.length)).toFixed(1)}%` : `${fmtMonth(x)} ${k}公館`; });
    if (hist.length > 1) L.push(`- 直近の推移：${hist.join("、")}`);
    // 続けて未提出の公館（直近3か月）
    const last3 = months().filter((x) => x <= m).slice(-3);
    if (last3.length === 3 && last3.every((x) => missOf(x))) {
      const cont = (miss || []).map((x) => x.post).filter((p) => last3.every((x) => !getReport(x, p)));
      if (cont.length) L.push(`- 3か月続けて未提出：${cont.join("、")}`);
    }
    L.push("");
  }
  if (secs.has("visits") && rep.length) {
    L.push("## 受診者数（地域別）");
    const prev = repOf(prevMonth(m));
    table([one ? "公館" : "地域", "提出公館", "職員", "家族", "その他", "計", "前月計"], [...regs, ...(region || one ? [] : ["全体"])].map((g) => {
      const rs = g === "全体" ? rep : rep.filter((r) => r.region === g), ps = g === "全体" ? prev : prev.filter((r) => r.region === g);
      return [lab(g), rs.length, ...["staff", "family", "other", "total"].map((f) => sum(rs, (r) => r[f])), ps.length ? sum(ps, (r) => r.total) : "―"];
    }));
    L.push("");
  }
  if (secs.has("cats") && dis.length) {
    L.push("## 疾病分類（地域別の件数）");
    const cats = CATEGORIES.filter((c) => dis.some((d) => d.category === c));
    table(["疾病分類", ...regs.map(lab), "計"], cats.map((c) => [shortCat(c), ...regs.map((g) => small(sum(dis.filter((d) => d.region === g && d.category === c), (d) => d.count))),
      small(sum(dis.filter((d) => d.category === c), (d) => d.count))]));
    L.push("");
  }
  if (secs.has("top") && dis.length) {
    L.push("## 病名（まとめ）の上位15（検診・予防接種を除く）");
    const g = {};
    for (const d of dis) if (d.category !== Z) (g[groupOf(d.name)] ||= { c: 0, posts: new Set() }), g[groupOf(d.name)].c += d.count, g[groupOf(d.name)].posts.add(d.post);
    table(["順位", "病名", "件数", "報告公館数"], Object.entries(g).sort((a, b) => b[1].c - a[1].c).slice(0, 15).map(([k, o], i) => [i + 1, k, small(o.c), o.posts.size]));
    L.push("");
  }
  if (secs.has("hei")) {
    L.push("## 丙表で報告された感染症など（国別・病名と傾向のみ）");
    const by = {};
    for (const o of outbreaksOf(m)) if (inR(o.post)) (by[o.post] ||= []).push(`${o.name}（${o.trend}）`);
    const ks = Object.keys(by);
    if (ks.length) for (const p of ks) L.push(`- ${p}：${[...new Set(by[p])].join("、")}`); else L.push("- なし");
    L.push("");
  }
  if (secs.has("events")) {
    L.push("## 災害・治安など（国別）");
    const by = {};
    // 感染症は上の丙表の節と重なり、邦人保護は国名と合わせると個別の事例が分かりうるので入れない
    for (const e of eventsOf(m)) if (inR(e.post) && !/感染症|邦人/.test(e.kind)) (by[e.post] ||= new Set()).add(`${e.kind}：${e.keyword}`);
    const ks = Object.keys(by);
    if (ks.length) for (const p of ks) L.push(`- ${p}：${[...by[p]].join("、")}`); else L.push("- なし");
    L.push("");
  }
  if (secs.has("cases")) {
    L.push("## 緊急移送・邦人対応（地域別の件数のみ）");
    const ev = casesOf(m, "evac").filter((c) => inR(c.post)), hg = casesOf(m, "hogo").filter((c) => inR(c.post));
    table([one ? "公館" : "地域", "緊急移送", "邦人対応"], (one ? [regionOf(one)] : region ? [region] : [...(isWorld(scope) ? REGIONS : regs), "全体"]).map((g) => [lab(g), small(g === "全体" ? ev.length : ev.filter((c) => regionOf(c.post) === g).length), small(g === "全体" ? hg.length : hg.filter((c) => regionOf(c.post) === g).length)]));
    L.push("");
  }
  if (secs.has("quality") && rep.length) {
    L.push("## 月報の記載状況（内容充実の参考）");
    const noKou = rep.filter((r) => r.total === null), noOtsu = rep.filter((r) => !(r.diseases || []).length);
    const len = (r) => (r.hei || "").replace(/\s/g, "").length;
    const shortHei = rep.filter((r) => len(r) < 50);
    L.push(`- 甲表（受診者数）の数値が読み取れない：${noKou.length}公館${noKou.length ? "（" + noKou.map((r) => r.post).join("、") + "）" : ""}`);
    L.push(`- 乙表（病名）が空：${noOtsu.length}公館${noOtsu.length ? "（" + noOtsu.map((r) => r.post).join("、") + "）" : ""}`);
    L.push(`- 丙表（報告事項）が50字未満：${shortHei.length}公館${shortHei.length ? "（" + shortHei.map((r) => r.post).join("、") + "）" : ""}`);
    table([one ? "公館" : "地域", "丙表の平均文字数", "乙表の病名数（平均）", "丙表で感染症に触れた公館"], regs.map((g) => {
      const rs = rep.filter((r) => r.region === g);
      return [lab(g), Math.round(sum(rs, len) / rs.length), (sum(rs, (r) => (r.diseases || []).length) / rs.length).toFixed(1), new Set(outbreaksOf(m).filter((o) => o.region === g && inR(o.post)).map((o) => o.post)).size];
    }));
    L.push("");
  }
  return scrubNames(L.join("\n").trim() + "\n");
}

// 時系列：対象（全世界／地域／1か国）の月ごとの推移を表にする。n は直近の月数（0 なら全期間）
function aiSeries(m, secs, scope, n) {
  const inR = scopeFilter(scope), one = scope.posts.length === 1 && !scope.regions.length ? scope.posts[0] : "";
  const ms = months().filter((x) => x <= m && Object.values(state.reports).some((r) => r.month === x)).slice(n ? -n : 0);
  if (!ms.length) return "（対象期間のデータがありません）\n";
  const repOf = (x) => reportsOf(x).filter((r) => inR(r.post));
  const missOf = (x) => { const s = missingPosts(x); return s && s.filter((r) => inR(r.post)); };
  const disOf = (x) => diseasesOf(x).filter((d) => inR(d.post));
  const L = [];
  const table = (head, rows) => { L.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)); };
  L.push(`# 医務官月報 月次推移（${fmtMonth(ms[0])}〜${fmtMonth(ms[ms.length - 1])}・${scopeLabel(scope)}・個人情報を含まない形）`,
    "※氏名・個別症例の記述は含みません。1〜2件の値は「3未満」と表記しています。", "");
  if (one) L.push(`対象：${one}（${regionOf(one)}）`, "");
  if (secs.has("submit")) {
    L.push("## 提出状況の推移");
    if (one) table(["月", "提出"], ms.map((x) => [x, getReport(x, one) ? "提出" : (missOf(x) || []).some((r) => r.post === one) ? "未提出" : "―"]));
    else table(["月", "配置公館", "提出", "提出率", "未提出公館"], ms.map((x) => {
      const k = repOf(x).length, mi = missOf(x);
      return mi ? [x, k + mi.length, k, `${(100 * k / (k + mi.length)).toFixed(1)}%`, mi.map((r) => r.post).join("、") || "なし"] : [x, "―", k, "―", "（配置表なし）"];
    }));
    L.push("");
  }
  if (secs.has("visits")) {
    L.push("## 受診者数の推移");
    table(["月", "提出公館", "職員", "家族", "その他", "計"], ms.map((x) => { const rs = repOf(x); return [x, rs.length, ...["staff", "family", "other", "total"].map((f) => sum(rs, (r) => r[f]))]; }));
    L.push("");
  }
  if (secs.has("cats")) {
    L.push("## 疾病分類の推移（件数）");
    const all = ms.map(disOf);
    const cats = CATEGORIES.filter((c) => all.some((ds) => ds.some((d) => d.category === c)));
    table(["疾病分類", ...ms], cats.map((c) => [shortCat(c), ...all.map((ds) => small(sum(ds.filter((d) => d.category === c), (d) => d.count)))]));
    L.push("");
  }
  if (secs.has("top")) {
    L.push("## 主な病名（まとめ）の推移（期間合計の上位10、検診・予防接種を除く）");
    const all = ms.map(disOf), tot = {};
    for (const ds of all) for (const d of ds) if (d.category !== Z) tot[groupOf(d.name)] = (tot[groupOf(d.name)] || 0) + d.count;
    const top = Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 10).map((x) => x[0]);
    table(["病名", ...ms], top.map((g) => [g, ...all.map((ds) => small(sum(ds.filter((d) => d.category !== Z && groupOf(d.name) === g), (d) => d.count)))]));
    L.push("");
  }
  if (secs.has("hei")) {
    L.push("## 丙表で報告された感染症などの推移（病名と傾向のみ）");
    for (const x of ms) {
      const by = {};
      for (const o of outbreaksOf(x)) if (inR(o.post)) (by[`${o.name}（${o.trend}）`] ||= new Set()).add(o.post);
      const items = Object.entries(by).sort((a, b) => b[1].size - a[1].size).map(([k, ps]) => (one ? k : `${k} ${ps.size}公館`));
      L.push(`- ${x}：${items.join("、") || "なし"}`);
    }
    L.push("");
  }
  if (secs.has("events")) {
    L.push("## 災害・治安などの推移");
    for (const x of ms) {
      const items = [...new Set(eventsOf(x).filter((e) => inR(e.post) && !/感染症|邦人/.test(e.kind)).map((e) => (one ? `${e.kind}：${e.keyword}` : `${e.post}（${e.kind}：${e.keyword}）`)))];
      L.push(`- ${x}：${items.slice(0, 15).join("、") || "なし"}${items.length > 15 ? ` ほか${items.length - 15}件` : ""}`);
    }
    L.push("");
  }
  if (secs.has("cases")) {
    L.push("## 緊急移送・邦人対応の件数の推移");
    table(["月", "緊急移送", "邦人対応"], ms.map((x) => [x, small(casesOf(x, "evac").filter((c) => inR(c.post)).length), small(casesOf(x, "hogo").filter((c) => inR(c.post)).length)]));
    L.push("");
  }
  if (secs.has("quality")) {
    L.push("## 月報の記載状況の推移");
    const len = (r) => (r.hei || "").replace(/\s/g, "").length;
    table(["月", "提出公館", "丙表の平均文字数", "丙表50字未満", "乙表の病名数（平均）"], ms.map((x) => {
      const rs = repOf(x);
      return rs.length ? [x, rs.length, Math.round(sum(rs, len) / rs.length), rs.filter((r) => len(r) < 50).length, (sum(rs, (r) => (r.diseases || []).length) / rs.length).toFixed(1)] : [x, 0, "―", "―", "―"];
    }));
    L.push("");
  }
  return scrubNames(L.join("\n").trim() + "\n");
}

// 念のため、医務官名（月報・配置表）が混ざっていたら伏せる
function personNames() {
  const s = new Set();
  for (const r of Object.values(state.reports)) if (r.officer) s.add(r.officer);
  for (const rows of Object.values(state.rosters)) for (const r of rows) { if (r.officer) s.add(r.officer); if (r.kana) s.add(r.kana); }
  return [...s].map((x) => x.trim()).filter((x) => x.length >= 2);
}
function scrubNames(text) {
  for (const nm of personNames()) for (const v of new Set([nm, nm.replace(/[\s　]+/g, "")])) if (v.length >= 2) text = text.split(v).join("（氏名）");
  return text;
}
// 個人を特定しうる記載の点検（氏名・年齢・性別・連絡先・生年月日）
// AIに貼る文章の冒頭に必ず付ける表示と、回答の最初に注意文を出させる指示（どのAIでも回答の頭に注意が出る。GaiXer・源内では念押し）
const AI_GUARD_HEAD = "【取扱注意】この集計は外務省AI（MOFA GaiXer）・政府AI（源内）専用です。";
const AI_GUARD_NOTE = "※この集計は外務省AI（MOFA GaiXer）・政府AI（源内）専用です。それ以外のサービスに入力した場合は、直ちに履歴を削除してください。";
const AI_ID_LINE = "管理番号：";
const AI_GUARD = `${AI_GUARD_HEAD}
${AI_ID_LINE}（コピー・保存のときに付きます）
AIへの指示：回答の最初に、次の注意文をそのまま表示してから回答してください。
「${AI_GUARD_NOTE}」
────────────────────────
`;
// 利用者が冒頭の表示を消してしまっても、コピー・保存・送るときに付け直す
const withAiGuard = (t) => (t.startsWith(AI_GUARD_HEAD) ? t : AI_GUARD + t.replace(/^\s+/, ""));
// ---- 追跡用の管理番号：コピー・保存・送るたびに新しい番号を文章に入れ、いつ・どこへ・何を出したかを記録する（state.aiLog。バックアップにも入る）
// 万一外部で見つかったとき、番号（消されていても文章の指紋）から、どの書き出しかを特定できる
function newAiId() {
  const d = new Date(), ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(4));
  return `AI-${ymd}-${[...r].map((x) => abc[x % abc.length]).join("")}`;
}
async function textFingerprint(t) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t.replace(/^管理番号：.*$/m, "").replace(/\s+/g, " ").trim()));
  return [...new Uint8Array(h)].slice(0, 6).map((x) => x.toString(16).padStart(2, "0")).join("");
}
// 文章に管理番号を入れて記録する。番号入りの文章を返す
async function stampAiText(t, dest, info) {
  t = withAiGuard(t);
  const id = newAiId();
  t = /^管理番号：.*$/m.test(t) ? t.replace(/^管理番号：.*$/m, `${AI_ID_LINE}${id}`) : t.replace(AI_GUARD_HEAD + "\n", `${AI_GUARD_HEAD}\n${AI_ID_LINE}${id}\n`);
  (state.aiLog ||= []).unshift({ id, at: new Date().toISOString(), dest, fp: await textFingerprint(t), chars: t.length, ...info });
  state.aiLog = state.aiLog.slice(0, 500);
  try { await saveState(); } catch (e) { console.warn("aiLog", e); }
  return { t, id };
}
function privacyIssues(text) {
  const out = [];
  const names = personNames().filter((nm) => text.includes(nm) || text.includes(nm.replace(/[\s　]+/g, "")));
  if (names.length) out.push(`医務官名：${names.slice(0, 5).join("、")}`);
  const pats = [[/\d{1,3}\s*(歳|才)/, "年齢"], [/(男性|女性|男児|女児|夫人|令息|令嬢)/, "性別・続柄"], [/[\w.+-]+@[\w-]+\.[\w.]+/, "メールアドレス"],
    [/\+?\d{2,4}[-‐ ]\d{2,4}[-‐ ]\d{3,4}/, "電話番号"], [/(昭和|平成|令和|19\d\d|20\d\d)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日生/, "生年月日"], [/(様|さん|氏)(?![名族])/, "敬称（個人名の可能性）"]];
  for (const [re, label] of pats) { const mt = text.match(re); if (mt) out.push(`${label}：「${mt[0]}」`); }
  return out;
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    const ta = document.createElement("textarea"); ta.value = t; ta.style.cssText = "position:fixed;left:-9999px"; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  }
}

function pageAI() {
  if (needData()) return;
  const m = curMonth(), urls = aiUrls(), p = loadPrefs();
  const secs = new Set(p.aiSecs || AI_SECTIONS.map((s) => s[0]));
  main.innerHTML = `
    <h2>AI分析用テキスト（${fmtMonth(m)}・個人情報を含まない形）</h2>
    <div class="card">
      <p>MOFA GaiXer・政府AI「源内」で分析するための集計テキストを作ります。<b>氏名や個別症例の記述（丙表の文章、緊急移送・邦人対応の内容）は入れず</b>、件数・病名・国名だけにしています。1〜2件の値は「3未満」と表記します。</p>
      <p class="muted">文章の冒頭には「この集計は外務省AI（MOFA GaiXer）・政府AI（源内）専用」という表示と、AIへの「回答の最初に注意文（MOFA GaiXer・源内以外に入力した場合は直ちに履歴を削除）を表示する」指示が入ります。どのAIに貼っても回答の頭に注意が出ます（GaiXer・源内でも念押しとして出ます）。冒頭を消してもコピー・保存のときに付け直します。</p>
      <p class="muted">作成はこのブラウザの中だけで行います。下のボタンはテキストをコピーして各サービスを開くだけで、アプリから自動で送信はしません。貼り付ける前に内容を必ず確認してください。</p>
    </div>
    <div class="card">
      <h3 style="margin-top:0">① 何を分析したいか選ぶ</h3>
      <p class="muted" style="margin-top:0">ボタンを押すと、AIへの依頼文が入り、その分析に必要な集計の項目にも自動でチェックが入ります。</p>
      <div class="row ai-regions"><b>対象：</b><span class="seg">${["", ...REGIONS].map((g) => `<button data-aireg="${esc(g)}">${g ? esc(regionLabel(g)) : "🌏 全世界"}</button>`).join("")}</span></div>
      <p class="muted" style="margin:0 0 6px">地域のボタンは押すたびに選択／解除でき、複数選べます（地域まるごと）。国は下のボタンで1つずつ自由に選べます（地域と国を組み合わせることもできます）。</p>
      <div id="aiSel" class="ai-postlist"></div>
      <div id="aiPostPick" class="ai-postpick">
        <div class="row" style="margin:0"><b>国を個別に選ぶ</b><span class="muted">（押すたびに選択／解除）</span><input type="search" id="aiPostQ" placeholder="絞り込み（例：ケニア、広州、ブラジル）" size="28" autocomplete="off"><button class="linklike" id="aiPostClear">国の選択をすべて外す</button><span id="aiPostSel" class="muted"></span></div>
        <div id="aiPostList" class="ai-postlist"></div>
        <p class="ai-warn-soft">⚠ 少ない国だけの集計は件数が少なく、個人が推測されやすくなります。1〜2件は「3未満」と表記しますが、送る前に特に注意して確認してください。</p>
      </div>
      <div class="row ai-regions"><b>期間：</b><span class="seg">${[[0, "今月のみ"], [6, "📈 直近6か月の推移"], [12, "📈 直近12か月の推移"], [-1, "📈 全期間の推移"]].map(([v, l]) => `<button data-aiper="${v}">${l}</button>`).join("")}</span></div>
      <div id="aiPrompts"></div>
      <div class="row ai-secs" style="margin-top:12px"><b>含める集計：</b>${AI_SECTIONS.map(([k, label]) => `<label><input type="checkbox" data-sec="${k}"${secs.has(k) ? " checked" : ""}> ${label}</label>`).join("")}</div>
      <div class="row" style="justify-content:space-between;margin-top:8px"><b>AIへの依頼文（書き換えられます）</b>
        <span class="row" style="margin:0"><button id="aiAddPrompt">＋ この依頼文を「自分の依頼文」に追加</button></span></div>
      <textarea id="aiPromptText" class="ai-prompt" spellcheck="false" placeholder="依頼文なし（集計だけを送る）"></textarea>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">② 送るテキストを確認する</h3><span id="aiLen" class="muted"></span></div>
      <p class="muted" style="margin-top:4px">依頼文＋集計です。直接書き換えられます（①を変えると作り直されます）。</p>
      <textarea id="aiText" class="ai-text" spellcheck="false"></textarea>
      <div id="aiCheck"></div>
      <label class="notice-check" style="margin:10px 0"><input type="checkbox" id="aiOk"> 個人情報（氏名・年齢・性別・個別の症例など）が含まれていないことを確認しました</label>
      <div class="row">
        ${AI_SITES.map(([k, name]) => `<button class="primary" data-ai-go="${k}" disabled>📋 コピーして ${name} を開く</button>`).join("")}
        <button id="aiCopy" disabled>📋 コピーのみ</button><button id="aiSave" disabled>テキストを保存（.txt）</button>
      </div>
      <p class="muted" style="margin-bottom:0">${AI_SITES.map(([k, name]) => `${name}：${urls[k] ? esc(urls[k]) : "<b>URL未登録</b>"}`).join("　／　")}。URLは「設定」→「AI分析の送り先」で登録します（未登録のときはコピーだけ行います）。</p>
      <p class="muted" style="margin:4px 0">コピー・保存・送るたびに、追跡用の<b>管理番号</b>（例：AI-20261025-7F3K）を文章の冒頭に入れ、日時・行き先・範囲とあわせてこのブラウザに記録します（データのバックアップにも入ります）。</p>
      <div id="aiLog"></div>
    </div>`;
  let cur = p.aiPromptKey || "overview";
  // 対象（全世界／地域／1か国）と期間（今月のみ／直近Nか月の推移）
  const postsWithData = [...new Set(Object.values(state.reports).map((r) => r.post))].sort((a, b) => REGIONS.indexOf(regionOf(a)) - REGIONS.indexOf(regionOf(b)) || a.localeCompare(b, "ja"));
  let scope = normScope(p.aiScope || (REGIONS.includes(p.aiRegion) ? { type: "region", value: p.aiRegion } : null));
  scope.posts = scope.posts.filter((x) => postsWithData.includes(x));
  let period = [0, 6, 12, -1].includes(p.aiPeriod) ? p.aiPeriod : 0;
  const saveScope = () => { savePref("aiScope", scope); markScope(); fillPosts(); regen(); };
  const markScope = () => {
    document.querySelectorAll("[data-aireg]").forEach((b) => {
      const g = b.dataset.aireg, on = g ? scope.regions.includes(g) : isWorld(scope);
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
    });
    document.querySelectorAll("[data-aiper]").forEach((b) => { const on = +b.dataset.aiper === period; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    const nIn = isWorld(scope) ? postsWithData.length : postsWithData.filter(scopeFilter(scope)).length;
    $("#aiPostSel").textContent = isWorld(scope) ? "" : `分析の対象：${nIn}か国・公館` + (scope.regions.length && scope.posts.length ? `（地域で${postsWithData.filter((x) => scope.regions.includes(regionOf(x))).length}・個別に${scope.posts.filter((x) => !scope.regions.includes(regionOf(x))).length}）` : "");
    // 選んだもの（地域・国）をまとめて表示。✕で外せる
    $("#aiSel").innerHTML = isWorld(scope) ? '<span class="muted">選択中：🌏 全世界</span>'
      : '<span class="muted">選択中：</span>' + [...scope.regions.map((g) => `<span class="ai-post on">${esc(regionLabel(g))}<button class="linklike" data-unreg="${esc(g)}" title="外す">✕</button></span>`),
        ...scope.posts.map((x) => `<span class="ai-post on">${flagImg(x, "flag sm")}${esc(x)}<button class="linklike" data-unpost="${esc(x)}" title="外す">✕</button></span>`)].join("");
    document.querySelectorAll("[data-unreg]").forEach((b) => (b.onclick = () => { scope.regions = scope.regions.filter((g) => g !== b.dataset.unreg); saveScope(); }));
    document.querySelectorAll("[data-unpost]").forEach((b) => (b.onclick = () => { scope.posts = scope.posts.filter((x) => x !== b.dataset.unpost); saveScope(); }));
  };
  const fillPosts = () => {
    const q = nfkc($("#aiPostQ").value.trim());
    const hits = postsWithData.filter((x) => !q || nfkc(x).includes(q) || nfkc(regionOf(x)).includes(q) || nfkc(regionLabel(regionOf(x))).includes(q));
    // 地域ごとにすべての国（公館）のボタンを並べる
    $("#aiPostList").innerHTML = [...REGIONS, "未分類"].map((g) => {
      const xs = hits.filter((x) => regionOf(x) === g);
      // 地域ごと選んでいる国は、薄い色で「選択中」と分かるようにする（押すとその国だけ外す）
      const viaReg = scope.regions.includes(g);
      return xs.length ? `<div class="ai-pgroup${viaReg ? " viareg" : ""}"><div class="gh">${esc(regionLabel(g))}${viaReg ? '<span class="badge">地域ごと選択中</span>' : ""}</div><div class="ai-postlist">${xs.map((x) => {
        const on = scope.posts.includes(x), via = viaReg && !on;
        return `<button class="ai-post${on ? " on" : via ? " via" : ""}" data-aipost="${esc(x)}" aria-pressed="${on || via}" title="${via ? "地域ごと選択中（押すとこの国だけ外します）" : on ? "選択中（押すと外します）" : "押すと選択します"}">${flagImg(x, "flag sm")}${esc(x)}${on || via ? " ✓" : ""}</button>`;
      }).join("")}</div></div>` : "";
    }).join("") || '<span class="muted">見つかりません</span>';
    document.querySelectorAll("[data-aipost]").forEach((b) => (b.onclick = () => {
      const x = b.dataset.aipost, g = regionOf(x);
      if (scope.regions.includes(g)) {
        // 地域ごと選んでいる国を外す：その地域を、この国以外の国の個別選択に置き換える
        scope.regions = scope.regions.filter((r) => r !== g);
        const rest = postsWithData.filter((y) => regionOf(y) === g && y !== x);
        scope.posts = [...new Set([...scope.posts.filter((y) => y !== x), ...rest])];
      } else scope.posts = scope.posts.includes(x) ? scope.posts.filter((y) => y !== x) : [...scope.posts, x];
      saveScope();
    }));
  };
  document.querySelectorAll("[data-aireg]").forEach((b) => (b.onclick = () => {
    const g = b.dataset.aireg;
    if (!g) { scope = { regions: [], posts: [] }; saveScope(); return; }  // 全世界＝選択をすべて外す
    scope.regions = scope.regions.includes(g) ? scope.regions.filter((x) => x !== g) : [...scope.regions, g];
    saveScope();
  }));
  document.querySelectorAll("[data-aiper]").forEach((b) => (b.onclick = () => { period = +b.dataset.aiper; savePref("aiPeriod", period); markScope(); regen(); }));
  $("#aiPostQ").oninput = fillPosts;
  $("#aiPostClear").onclick = () => { scope.posts = []; saveScope(); };
  $("#aiPostQ").onkeydown = (e) => { if (e.key === "Enter") { const first = $("#aiPostList [data-aipost]"); if (first) first.click(); } };
  markScope(); fillPosts();
  const drawPrompts = () => {
    const btn = (it, custom) => `<button class="ai-pcard${it.k === cur ? " on" : ""}" data-pk="${esc(it.k)}" aria-pressed="${it.k === cur}">
        <span class="t">${it.icon || "📝"} ${esc(it.title)}</span><span class="ex">${esc(it.ex || "")}</span>${custom ? `<span class="del" data-pdel="${esc(it.k)}" title="削除">✕</span>` : ""}</button>`;
    const cps = customPrompts();
    $("#aiPrompts").innerHTML = AI_PROMPT_LIST.map((g) => `<div class="ai-pgroup"><div class="gh">${g.group}</div><div class="ai-pgrid">${g.items.map((it) => btn(it)).join("")}</div></div>`).join("")
      + `<div class="ai-pgroup"><div class="gh">自分の依頼文</div><div class="ai-pgrid">${cps.map((it) => btn({ ...it, icon: "⭐", ex: it.text.slice(0, 40) + (it.text.length > 40 ? "…" : "") }, true)).join("")}
         ${btn({ k: "none", icon: "∅", title: "依頼文なし", ex: "集計だけを送り、依頼はAIの画面で書く" })}</div></div>`;
    document.querySelectorAll("[data-pk]").forEach((b) => (b.onclick = (e) => {
      if (e.target.closest("[data-pdel]")) return;
      selectPrompt(b.dataset.pk, true);
    }));
    document.querySelectorAll("[data-pdel]").forEach((x) => (x.onclick = () => {
      if (!confirm("この依頼文を一覧から削除しますか？")) return;
      savePref("aiCustomPrompts", customPrompts().filter((c) => c.k !== x.dataset.pdel));
      if (cur === x.dataset.pdel) cur = "overview";
      drawPrompts();
    }));
  };
  const promptOf = (k) => AI_PROMPT_FLAT.find((x) => x.k === k) || customPrompts().find((x) => x.k === k);
  const selectPrompt = (k, setSecs) => {
    cur = k; savePref("aiPromptKey", k);
    const it = promptOf(k);
    $("#aiPromptText").value = it ? (AI_PROMPT_FLAT.includes(it) ? AI_HEAD + "\n" : "") + it.text : "";
    if (setSecs && it && it.secs) document.querySelectorAll("[data-sec]").forEach((c) => (c.checked = it.secs.includes(c.dataset.sec)));
    if (setSecs && it && it.period && !period) { period = it.period; savePref("aiPeriod", period); }
    if (setSecs && it && it.scope === "post" && !scope.posts.length) setTimeout(() => $("#aiPostPick").scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
    if (setSecs) { markScope(); fillPosts(); }
    drawPrompts(); regen();
  };
  $("#aiAddPrompt").onclick = () => {
    const text = $("#aiPromptText").value.trim();
    if (!text) { toast("依頼文が空です"); return; }
    const title = prompt("一覧に表示する名前を入れてください（例：結核の動向）", "");
    if (!title) return;
    const secsNow = [...document.querySelectorAll("[data-sec]")].filter((c) => c.checked).map((c) => c.dataset.sec);
    const k = "c" + Date.now();
    savePref("aiCustomPrompts", [...customPrompts(), { k, title: title.trim(), text, secs: secsNow }]);
    cur = k; savePref("aiPromptKey", k); drawPrompts();
    toast("「自分の依頼文」に追加しました（設定ファイルにも書き出されます）");
  };
  const regen = () => {
    const ss = new Set([...document.querySelectorAll("[data-sec]")].filter((c) => c.checked).map((c) => c.dataset.sec));
    savePref("aiSecs", [...ss]);
    const pt = $("#aiPromptText").value.trim();
    $("#aiText").value = AI_GUARD + (pt ? pt + "\n\n" : "") + (period ? aiSeries(m, ss, scope, period === -1 ? 0 : period) : aiText(m, ss, scope));
    $("#aiOk").checked = false;
    check();
  };
  const check = () => {
    const t = $("#aiText").value, iss = privacyIssues(t);
    $("#aiLen").textContent = `${t.length.toLocaleString()}文字`;
    $("#aiCheck").innerHTML = iss.length
      ? `<div class="ai-warn">⚠ 個人情報の可能性がある記載があります。削除・修正するまで送れません：<ul>${iss.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`
      : `<div class="ai-ok">✓ 氏名・年齢・性別・連絡先などの記載は見つかりませんでした（自動点検）。</div>`;
    const ok = !iss.length && $("#aiOk").checked && t.trim();
    document.querySelectorAll("[data-ai-go], #aiCopy, #aiSave").forEach((b) => (b.disabled = !ok));
  };
  document.querySelectorAll("[data-sec]").forEach((c) => (c.onchange = regen));
  $("#aiPromptText").oninput = regen;
  $("#aiText").oninput = () => { $("#aiOk").checked = false; check(); };
  $("#aiOk").onchange = check;
  // コピー・保存・送るたびに管理番号を付け、文章欄にも反映して記録する
  const stamp = async (dest) => {
    const { t, id } = await stampAiText($("#aiText").value, dest, { month: m, scope: scopeLabel(scope), period: period ? (period === -1 ? "全期間" : `直近${period}か月`) : "今月" });
    $("#aiText").value = t;
    drawAiLog();
    return { t, id };
  };
  $("#aiCopy").onclick = async () => { const { t, id } = await stamp("コピー"); toast((await copyText(t)) ? `コピーしました（管理番号 ${id}）。貼り付ける前にもう一度内容を確認してください` : "コピーできませんでした"); };
  $("#aiSave").onclick = async () => {
    const { t, id } = await stamp("ファイル保存");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([t], { type: "text/plain;charset=utf-8" }));
    a.download = `AI分析用_医務官月報集計_${m.replace("-", "")}_${id}.txt`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const drawAiLog = () => {
    const el = $("#aiLog");
    if (!el) return;
    const log = state.aiLog || [];
    el.innerHTML = log.length ? `<details><summary>書き出しの記録（管理番号）${log.length}件</summary><div class="table-wrap" style="max-height:260px"><table class="mini"><tr><th>管理番号</th><th>日時</th><th>行き先</th><th>対象月</th><th>範囲・期間</th><th>文字数</th><th>指紋</th></tr>${
      log.slice(0, 100).map((x) => `<tr><td><code>${esc(x.id)}</code></td><td>${esc(new Date(x.at).toLocaleString("ja-JP"))}</td><td>${esc(x.dest)}</td><td>${esc(fmtMonth(x.month))}</td><td>${esc(x.scope || "")}・${esc(x.period || "")}</td><td class="num">${(x.chars || 0).toLocaleString()}</td><td><code>${esc(x.fp || "")}</code></td></tr>`).join("")}</table></div>
      <p class="muted" style="margin:4px 0 0">外部で見つかった文章の管理番号、または文章の指紋（管理番号を消した本文から計算）で、どの書き出しかを確かめられます。<label class="btn" style="margin-left:6px">文章を照合する<input type="file" id="aiMatch" accept=".txt,text/plain" hidden></label><span id="aiMatchSt"></span></p></details>`
      : '<p class="muted" style="margin:0">書き出しの記録はまだありません（コピー・保存・送るたびに管理番号を付けて記録します）。</p>';
    const mf = $("#aiMatch");
    if (mf) mf.onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const t = await f.text(), idm = t.match(/AI-\d{8}-[A-Z0-9]{4}/), fp = await textFingerprint(t);
      const hit = (state.aiLog || []).find((x) => (idm && x.id === idm[0]) || x.fp === fp);
      $("#aiMatchSt").textContent = hit ? `　一致：${hit.id}（${new Date(hit.at).toLocaleString("ja-JP")}・${hit.dest}・${fmtMonth(hit.month)}）` : "　記録に一致する書き出しはありません";
    };
  };
  drawAiLog();
  document.querySelectorAll("[data-ai-go]").forEach((b) => (b.onclick = async () => {
    const k = b.dataset.aiGo, name = AI_SITES.find((s) => s[0] === k)[1], url = aiUrls()[k];
    const ok = await copyText((await stamp(name)).t);
    if (!ok) { toast("コピーできませんでした"); return; }
    if (url) { window.open(url, "_blank", "noopener"); toast(`コピーしました。開いた ${name} の入力欄に貼り付けてください（Ctrl+V）`); }
    else toast(`コピーしました。${name} のURLが未登録なので、${name} を開いて貼り付けてください（設定でURLを登録できます）`);
  }));
  selectPrompt(cur, !p.aiSecs);
}

// ======================================================================= 世界医療情報マップ（別アプリを組み込む）
// 同じサイトの「世界医療情報マップ」（https://ysk713.github.io/-/world-health-map/）をこのタブの中に表示する。
// 各国の医療・感染症のニュースや動画を集めたもので、インターネットに接続して表示する（オフラインでは使えない）
const WHM_URL = "../world-health-map/";
function pageWhm() {
  const online = navigator.onLine;
  // 日本語で表示する（同じサイトなので表示言語の設定を共有できる）
  try { if (!localStorage.getItem("whm-lang")) localStorage.setItem("whm-lang", "ja"); } catch {}
  main.innerHTML = `
    <h2>世界医療情報マップ</h2>
    <div class="card whm-note">
      <p><b>⚠ このタブはインターネットに接続して表示します。</b>各国の医療・感染症のニュースや動画を集めた別のアプリ「世界医療情報マップ」を、このタブの中に表示しています。</p>
      <ul class="muted" style="margin:4px 0 0">
        <li>オフラインでは表示されません（このタブ以外の機能はオフラインでも使えます）。</li>
        <li>ニュース（Google ニュース）や動画（YouTube）などの外部サイトに接続します。ニュースの見出しや外部サイトの内容は、各提供元のものです。</li>
        <li>月報のデータや個人情報は、このタブから送られることはありません。この中で月報の内容を入力・検索しないでください。</li>
      </ul>
      <div class="row" style="margin-bottom:0"><a class="btn" href="${WHM_URL}" target="_blank" rel="noopener">別のタブで開く ↗</a><span class="muted" id="whmSt"></span></div>
    </div>
    ${online ? `<iframe class="whm-frame" src="${WHM_URL}" title="世界医療情報マップ" loading="lazy" referrerpolicy="no-referrer"></iframe>`
      : '<div class="card"><p class="bad">インターネットにつながっていないため、表示できません。接続してからこのタブを開き直してください。</p></div>'}`;
}

// ======================================================================= 設定

// 設定画面：国歌の録音の登録・一覧
function bindAnthemSettings() {
  const countries = [...new Set(Object.values(INFO).map((v) => v.iso3).filter(Boolean))].sort((a, b) => isoName(a).localeCompare(isoName(b), "ja"));
  const drawList = async () => {
    const set = await anthemList(), names = (await idb.get("anthemNames")) || {};
    const posts = [...new Set(Object.values(state.reports).map((r) => INFO[r.post] && INFO[r.post].iso3).filter(Boolean))];
    const have = [...set].sort((a, b) => isoName(a).localeCompare(isoName(b), "ja"));
    const missing = posts.filter((iso) => !set.has(iso)).sort((a, b) => isoName(a).localeCompare(isoName(b), "ja"));
    $("#anList").innerHTML = `<p><b>登録済み ${have.length}か国</b>${posts.length ? `（月報のある国 ${posts.length}か国のうち ${posts.filter((i) => set.has(i)).length}か国）` : ""}</p>
      <div class="ai-postlist">${have.map((iso) => `<span class="ai-post">${flagImg(isoName(iso), "flag sm")}${esc(isoName(iso))}${names[iso] ? `<span class="an-file" title="${esc(names[iso])}">${esc(names[iso].replace(/\.[^.]+$/, "").replace(/^United States Navy Band\s*-\s*/i, "").slice(0, 28))}</span>` : ""}<button class="linklike" data-an-play="${iso}" title="試聴">▶</button><button class="linklike" data-an-del="${iso}" title="削除">✕</button></span>`).join("") || '<span class="muted">まだありません</span>'}</div>
      ${missing.length ? `<p class="muted" style="margin-bottom:0">未登録（月報のある国）：${missing.map((i) => esc(isoName(i))).join("、")}</p>` : ""}`;
    document.querySelectorAll("[data-an-play]").forEach((b) => (b.onclick = async () => { if (curAnthem) { stopAnthem(); return; } const sec = await playAnthem(b.dataset.anPlay); if (!sec) toast("再生できませんでした"); }));
    document.querySelectorAll("[data-an-del]").forEach((b) => (b.onclick = async () => { if (!confirm(`${isoName(b.dataset.anDel)} の国歌の録音を削除しますか？`)) return; stopAnthem(); await deleteAnthem(b.dataset.anDel); drawList(); }));
  };
  const add = async (files) => {
    await loadGeo();
    const audio = [...files].filter((f) => /^audio\//.test(f.type) || /\.(mp3|m4a|ogg|oga|wav|aac|flac|webm)$/i.test(f.name));
    const unmatched = [];
    let n = 0;
    for (const f of audio) {
      const iso = isoFromFileName(f.webkitRelativePath || f.name);
      if (iso) { $("#anSt").textContent = `登録中… ${++n}`; await saveAnthem(iso, f); } else unmatched.push(f);
    }
    $("#anSt").textContent = `${n}件を登録しました` + (unmatched.length ? `（国が分からないファイル ${unmatched.length}件）` : "");
    showUnmatched(unmatched);
  };
  // 国が分からなかったファイルは、一覧から国を選んで登録できるようにする
  const showUnmatched = (unmatched) => {
    $("#anUnmatched").innerHTML = unmatched.length ? `<div class="ai-postpick"><b>国が分からなかったファイル</b>：国を選んで登録してください${unmatched.map((f, i) => `
      <div class="row" style="margin:6px 0 0"><span>${esc(f.name)}</span><select data-an-pick="${i}"><option value="">（国を選ぶ）</option>${countries.map((c) => `<option value="${c}">${esc(isoName(c))}</option>`).join("")}</select></div>`).join("")}</div>` : "";
    document.querySelectorAll("[data-an-pick]").forEach((sel) => (sel.onchange = async () => {
      if (!sel.value) return;
      let f = unmatched[+sel.dataset.anPick];
      if (f.lazy) {
        try { const r = await fetch(f.lazy.url); f = new File([await r.blob()], f.lazy.name, { type: f.lazy.mime }); }
        catch { toast("取得できませんでした"); return; }
      }
      await saveAnthem(sel.value, f);
      sel.closest(".row").remove(); toast(`${isoName(sel.value)} に登録しました`); drawList();
    }));
    drawList();
  };
  $("#anFiles").onchange = (e) => add(e.target.files);
  $("#anFolder").onchange = (e) => add(e.target.files);
  // ウィキメディア・コモンズの米海軍軍楽隊の録音を、このブラウザから直接取得して登録する
  // 未登録の国を、コモンズ全体から国名・曲名で探して登録する
  $("#anDeep").onclick = async () => {
    const btn = $("#anDeep");
    if (!navigator.onLine) { toast("インターネットにつながっているときに探せます"); return; }
    btn.disabled = true;
    try {
      await loadGeo();
      const have = await anthemList(), scope = $("#anScope").value;
      const isos = [...anthemTargets(scope)]
        .filter((i) => i && !have.has(i)).sort((a, b) => isoName(a).localeCompare(isoName(b), "ja"));
      if (!isos.length) { $("#anSt").textContent = "未登録の国はありません"; return; }
      const { found, notFound } = await commonsDeepSearch(isos, (t) => ($("#anSt").textContent = t));
      const list = Object.entries(found);
      if (!list.length) { $("#anSt").textContent = `${isos.length}か国を探しましたが、自由なライセンスの録音は見つかりませんでした：${notFound.map(isoName).join("、")}`; return; }
      const mb = list.reduce((a, [, f]) => a + (f.size || 0), 0) / 1048576;
      const msg = `${list.length}か国の録音が見つかりました（約${mb.toFixed(0)}MB）：\n` + list.map(([iso, f]) => `・${isoName(iso)}：${f.name}（${f.license}）`).join("\n")
        + (notFound.length ? `\n\n見つからなかった国：${notFound.map(isoName).join("、")}` : "") + "\n\n登録しますか？";
      if (!confirm(msg)) { $("#anSt").textContent = ""; return; }
      let done = 0, fail = 0;
      for (const [iso, f] of list) {
        try {
          const r = await fetch(f.url);
          if (!r.ok) throw new Error(r.status);
          await saveAnthem(iso, new File([await r.blob()], f.name, { type: f.mime }), { license: f.license, artist: f.artist, source: f.page });
          done++;
        } catch (e) { fail++; console.warn("deep", f.name, e); }
        $("#anSt").textContent = `取得中… ${done + fail} / ${list.length}`;
      }
      $("#anSt").textContent = `${done}か国を登録しました` + (fail ? `（失敗 ${fail}件）` : "") + (notFound.length ? `。見つからなかった国：${notFound.map(isoName).join("、")}` : "");
      drawList();
    } catch (e) {
      console.warn(e);
      $("#anSt").textContent = "コモンズで検索できませんでした（" + e.message + "）";
    } finally { btn.disabled = false; }
  };
  // コモンズのファイルの URL を貼り付けて、その録音を登録する
  $("#anUrlIso").insertAdjacentHTML("beforeend", countries.map((c) => `<option value="${c}">${esc(isoName(c))}</option>`).join(""));
  $("#anUrlEx").onclick = () => { $("#anUrl").value = "https://commons.wikimedia.org/wiki/File:" + PREFERRED_ANTHEM.USA.replace(/ /g, "_"); $("#anUrlIso").value = "USA"; };
  $("#anUrlBtn").onclick = async () => {
    const name = commonsTitleFromUrl($("#anUrl").value);
    if (!name) { toast("コモンズのファイルの URL を貼り付けてください"); return; }
    if (!navigator.onLine) { toast("インターネットにつながっているときに登録できます"); return; }
    const btn = $("#anUrlBtn");
    btn.disabled = true;
    try {
      await loadGeo();
      $("#anSt").textContent = "コモンズで確認中…";
      const f = await commonsFileInfo(name);
      if (!f.free) { $("#anSt").textContent = `ライセンスが自由利用（パブリックドメイン・CC0・CC BY・CC BY-SA）ではないため登録できません（${f.license || "不明"}）`; return; }
      const iso = $("#anUrlIso").value || isoFromFileName(f.name);
      if (!iso) { $("#anSt").textContent = "国が分かりませんでした。右の欄で国を選んでから、もう一度押してください"; return; }
      if (!isRightAnthem(iso, f.name)) { $("#anSt").textContent = `${isoName(iso)}の国歌ではない曲のようです（${f.name}）`; return; }
      if (!confirm(`${isoName(iso)}の国歌として登録します：\n${f.name}\nライセンス：${f.license}${f.artist ? "\n作者：" + f.artist : ""}\n大きさ：約${((f.size || 0) / 1048576).toFixed(1)}MB\n\n登録済みの録音があれば差し替えます。よろしいですか？`)) { $("#anSt").textContent = ""; return; }
      $("#anSt").textContent = "取得中…";
      const r = await fetch(f.url);
      if (!r.ok) throw new Error(r.status);
      await saveAnthem(iso, new File([await r.blob()], f.name, { type: f.mime }), { license: f.license, artist: f.artist, source: f.page });
      $("#anSt").textContent = `${isoName(iso)}に「${f.name}」を登録しました`;
      $("#anUrl").value = "";
      drawList();
    } catch (e) {
      console.warn(e);
      $("#anSt").textContent = "登録できませんでした（" + e.message + "）";
    } finally { btn.disabled = false; }
  };
  // GitHub の open-assets-hub/national-anthems（米海軍軍楽隊の各国国歌 MP3。パブリックドメイン）から取得する
  $("#anGithub").onclick = async () => {
    const btn = $("#anGithub");
    if (!navigator.onLine) { toast("インターネットにつながっているときに取得できます"); return; }
    btn.disabled = true;
    try {
      await loadGeo();
      $("#anSt").textContent = "GitHub の一覧を読み込み中…";
      const idx = await ghAnthemIndex();
      const scope = $("#anScope").value, keep = $("#anKeep").checked, have = await anthemList(), names = (await idb.get("anthemNames")) || {};
      const want = anthemTargets(scope);
      const pick = {}, moved = [], wrong = [];
      for (const x of idx.anthems || []) {
        const pr = x.primary;
        if (!pr) continue;
        const src = (pr.source_file || "").replace(/^File:/, ""), expect = iso3of2(x.iso2);
        // 国コードと曲名・元のファイル名が食い違うもの（一覧の誤り）は、曲名から判定した国のものとして扱う
        const found = isoFromFileName(src) || isoFromFileName(pr.anthem_title || "");
        const iso = found || expect;
        if (!iso) continue;
        if (found && expect && found !== expect) (want.has(found) ? moved : wrong).push(`${x.iso2.toUpperCase()}→${isoName(found)}（${pr.anthem_title}）`);
        const name = src.replace(/\.[^.]+$/, "") + (/navy\s*band/i.test(src) ? "" : " - U.S. Navy Band") + ".mp3";
        if (!want.has(iso) || !isRightAnthem(iso, name)) continue;
        if (PREFERRED_ANTHEM[iso] && names[iso] === PREFERRED_ANTHEM[iso]) continue;   // 指定の録音は残す
        if (keep && have.has(iso) && BAND_RE.test(names[iso] || "")) continue;          // 登録済みのブラスバンドの録音は残す
        if (pick[iso] && found !== iso) continue;                                       // 曲名で確かめられたほうを優先
        pick[iso] = { name, url: pr.url || `${GH_ANTHEM_RAW}/${pr.file}`, file: pr.file, sec: pr.duration_sec || 60, page: `https://github.com/${GH_ANTHEM_REPO}/tree/main/${(pr.file || "").replace(/\/[^/]+$/, "")}` };
      }
      const todo = Object.entries(pick);
      if (!todo.length) { $("#anSt").textContent = "新しく登録できる国はありませんでした"; return; }
      const mb = todo.reduce((a, [, f]) => a + f.sec * 24000, 0) / 1048576;
      if (!confirm(`GitHub（open-assets-hub/national-anthems、米海軍軍楽隊・パブリックドメイン）から ${todo.length}か国の国歌の録音（約${mb.toFixed(0)}MB）を取得して、このブラウザに保存します。\n\n${todo.map(([iso]) => isoName(iso)).join("、")}\n\nよろしいですか？`)) { $("#anSt").textContent = ""; return; }
      let done = 0, fail = 0;
      const worker = async () => {
        while (todo.length) {
          const [iso, f] = todo.shift();
          try {
            let r = await fetch(f.url).catch(() => null);
            if (!r || !r.ok) r = await fetch(`${GH_ANTHEM_CDN}/${f.file}`);   // 予備：jsDelivr
            if (!r.ok) throw new Error(r.status);
            await saveAnthem(iso, new File([await r.blob()], f.name, { type: "audio/mpeg" }), { license: "Public domain", artist: "U.S. Navy Band", source: f.page });
            done++;
          } catch (e) { fail++; console.warn("github anthem", f.name, e); }
          $("#anSt").textContent = `取得中… ${done + fail} / ${done + fail + todo.length}`;
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      $("#anSt").textContent = `GitHub から ${done}か国を登録しました` + (fail ? `（失敗 ${fail}件）` : "")
        + (moved.length ? `。一覧の国コードと曲が違うため、曲の国として扱ったもの：${moved.join("、")}` : "")
        + (wrong.length ? `。一覧の国コードと曲が違うため除外：${wrong.join("、")}` : "");
      drawList();
    } catch (e) {
      console.warn(e);
      $("#anSt").textContent = "GitHub から取得できませんでした（" + e.message + "）。インターネット接続や、組織のネットワークで raw.githubusercontent.com・cdn.jsdelivr.net への接続が許可されているかを確認してください";
    } finally { btn.disabled = false; }
  };
  $("#anCommons").onclick = async () => {
    const btn = $("#anCommons");
    if (!navigator.onLine) { toast("インターネットにつながっているときに取得できます"); return; }
    btn.disabled = true;
    try {
      await loadGeo();
      $("#anSt").textContent = "コモンズの一覧を読み込み中…";
      const list = await commonsAnthemList((k) => ($("#anSt").textContent = `コモンズの一覧を読み込み中… ${k}件`));
      const scope = $("#anScope").value, keep = $("#anKeep").checked, have = await anthemList();
      // 日本（ツアーの出発・帰着で「君が代」）は公館がなくても必ず含める
      const want = anthemTargets(scope);
      // 「上書きしない」は、登録済みの録音がこのカテゴリー（米海軍軍楽隊＝ブラスバンド）のものときだけ。ほかの録音はブラスバンドの録音に差し替える
      const navy = new Set(list.map((f) => f.name)), names0 = (await idb.get("anthemNames")) || {};
      // 国ごとに1つ（「complete（全曲）」より短い版、同じなら小さいファイルを優先）
      const pick = {}, unmatched = [], skipped = [];
      let notAnthem = 0;
      for (const f of list) {
        if (NOT_ANTHEM.test(f.name)) { notAnthem++; continue; }
        if (!f.free) { skipped.push(f); continue; }
        const iso = isoFromFileName(f.name);
        if (!iso) { unmatched.push(f); continue; }
        if (!want.has(iso) || (keep && have.has(iso) && navy.has(names0[iso]))) continue;
        if (!isRightAnthem(iso, f.name)) { notAnthem++; continue; }
        const rank = (x) => (/complete|full/i.test(x.name) ? 1e10 : 0) + (x.size || 0);
        if (!pick[iso] || rank(f) < rank(pick[iso])) pick[iso] = f;
      }
      // 優先する録音（PREFERRED_ANTHEM：米国は「星条旗」の器楽演奏、スリランカは米海軍軍楽隊）は、ほかの録音が登録済みでも差し替える
      const names = (await idb.get("anthemNames")) || {};
      for (const [iso, nm] of Object.entries(PREFERRED_ANTHEM)) {
        if (!want.has(iso) || names[iso] === nm) { delete pick[iso]; continue; }
        try { pick[iso] = await commonsFileInfo(nm); } catch (e) { console.warn("preferred", nm, e); }
      }
      const todo = Object.entries(pick);
      const mb = todo.reduce((a, [, f]) => a + (f.size || 0), 0) / 1048576;
      if (!todo.length) { $("#anSt").textContent = `新しく登録できる国はありませんでした（一覧 ${list.length}件）`; return; }
      if (!confirm(`${todo.length}か国の国歌の録音（約${mb.toFixed(0)}MB）をコモンズから取得して、このブラウザに保存します。よろしいですか？`)) { $("#anSt").textContent = ""; return; }
      let done = 0, fail = 0;
      const worker = async () => {
        while (todo.length) {
          const [iso, f] = todo.shift();
          try {
            const r = await fetch(f.url);
            if (!r.ok) throw new Error(r.status);
            await saveAnthem(iso, new File([await r.blob()], f.name, { type: f.mime }), { license: f.license, artist: f.artist, source: f.page });
            done++;
          } catch (e) { fail++; console.warn("commons", f.name, e); }
          $("#anSt").textContent = `取得中… ${done + fail} / ${done + fail + todo.length}`;
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      $("#anSt").textContent = `コモンズから ${done}か国を登録しました` + (fail ? `（失敗 ${fail}件）` : "") + (skipped.length ? `。ライセンスが自由利用でないため除外：${skipped.length}件` : "") + (notAnthem ? `。国歌ではない曲（儀礼曲・愛国歌・旧国家の国歌など）を除外：${notAnthem}件` : "") + (unmatched.length ? `。国が分からないファイル：${unmatched.length}件（下で選べます）` : "");
      // 国が分からなかったファイルは、選んだときにだけ取得する
      showUnmatched(unmatched.map((f) => ({ name: f.name, lazy: f })));
      drawList();
    } catch (e) {
      console.warn(e);
      $("#anSt").textContent = "コモンズから取得できませんでした（" + e.message + "）。インターネット接続や、組織のネットワークで wikimedia.org への接続が許可されているかを確認してください";
    } finally { btn.disabled = false; }
  };
  drawList();
}

// ウィキメディア・コモンズの「米海軍軍楽隊による各国国歌の録音」カテゴリーの一覧（公式APIを使用。ブラウザから直接）
// コモンズのカテゴリーに混ざっている国歌ではない曲（米国の儀礼曲・愛国歌、王室歌、旧国家の国歌、民謡）
const NOT_ANTHEM = new RegExp([
  "ruffles\\s*and\\s*flourishes", "hail\\s*columbia", "columbia,?\\s*the\\s*gem", "auld\\s*lang\\s*syne", "kong\\s*kristian", "hey,?\\s*slavs", "zaire",
  // 米国の愛国歌・儀礼曲・軍歌（国歌は The Star-Spangled Banner だけ）
  "america,?\\s*the\\s*beautiful", "god\\s*bless\\s*america", "my\\s*country,?\\s*'?t?is\\s*of\\s*thee", "hail\\s*to\\s*the\\s*chief", "anchors\\s*aweigh",
  "stars\\s*and\\s*stripes\\s*forever", "battle\\s*hymn", "yankee\\s*doodle", "semper\\s*paratus", "marines'?\\s*hymn", "army\\s*goes\\s*rolling", "caissons",
  "eternal\\s*father", "\\btaps\\b", "air\\s*force\\s*song", "wild\\s*blue\\s*yonder", "dixie", "this\\s*land\\s*is\\s*your\\s*land",
].join("|"), "i");
// 米国は The Star-Spangled Banner（星条旗）だけを国歌とする
const isRightAnthem = (iso, name) => !NOT_ANTHEM.test(name) && (iso !== "USA" || /star[\s-]*spangled/i.test(name));
// ---- 未登録の国を、コモンズ全体から国名・国歌の曲名で検索する（米海軍軍楽隊のカテゴリー以外の録音も対象）
// 受け付けるライセンス：パブリックドメイン・CC0・CC BY・CC BY-SA（BY・BY-SA は作者とライセンスを再生時に表示）
const FREE_LICENSE = /public\s*domain|^pd|cc0|cc[\s-]*zero|^cc[\s-]*by(?![\s-]*(nc|nd))([\s-]*sa)?\b/i;
const SEARCH_NAME = {
  TZA: "Tanzania", SRB: "Serbia", USA: "United States", GBR: "United Kingdom", RUS: "Russia", KOR: "South Korea", COD: "Democratic Republic of the Congo",
  COG: "Republic of the Congo", CIV: "Ivory Coast", LAO: "Laos", VNM: "Vietnam", SYR: "Syria", IRN: "Iran", BOL: "Bolivia", VEN: "Venezuela", MDA: "Moldova",
  MKD: "North Macedonia", SWZ: "Eswatini", MMR: "Myanmar", TLS: "East Timor", GNB: "Guinea-Bissau", GMB: "Gambia", BHS: "Bahamas", SGP: "Singapore",
  BHR: "Bahrain", MDV: "Maldives", MUS: "Mauritius", SYC: "Seychelles", COM: "Comoros", WSM: "Samoa", TON: "Tonga", KIR: "Kiribati", TUV: "Tuvalu",
  MHL: "Marshall Islands", FSM: "Micronesia", PLW: "Palau", NRU: "Nauru", CPV: "Cape Verde", BRN: "Brunei", PSE: "Palestine", SSD: "South Sudan",
  CZE: "Czech Republic", DOM: "Dominican Republic", ARE: "United Arab Emirates", PNG: "Papua New Guinea", SLB: "Solomon Islands", VUT: "Vanuatu",
};
const isoEnName = (iso) => SEARCH_NAME[iso] || (GEO && (GEO.features.find((f) => f.id === iso) || {}).properties || {}).name || "";
async function commonsApi(params) {
  const r = await fetch("https://commons.wikimedia.org/w/api.php?" + new URLSearchParams(Object.assign({ action: "query", format: "json", formatversion: "2", origin: "*" }, params)));
  if (!r.ok) throw new Error("API " + r.status);
  return r.json();
}
async function commonsDeepSearch(isos, progress) {
  const titlesOf = {};
  for (const [t, iso] of Object.entries(ANTHEM_TITLES)) (titlesOf[iso] ||= []).push(t);
  const found = {}, notFound = [];
  // コモンズの「National anthem」のページ（各国の国歌の音声を集めたギャラリー）に載っている音声ファイルも候補にする
  let gallery = [];
  try {
    progress && progress("コモンズの「National anthem」のページを読み込み中…");
    const d = await commonsApi({ action: "parse", page: "National_anthem", prop: "images" });
    gallery = ((d.parse && d.parse.images) || []).map((x) => x.replace(/_/g, " ")).filter((x) => /\.(ogg|oga|opus|mp3|wav|flac|webm)$/i.test(x));
  } catch (e) { console.warn("gallery", e); }
  const inGallery = new Set(gallery);
  let k = 0;
  for (const iso of isos) {
    progress && progress(`検索中… ${++k} / ${isos.length}（${isoName(iso)}）`);
    const en = isoEnName(iso), qs = [];
    if (en) qs.push(`"${en}" anthem band filetype:audio`, `"${en}" anthem filetype:audio`, `"${en}" national anthem instrumental`);
    const cand = new Map();
    for (const nm of gallery) if (isoFromFileName(nm) === iso || (titlesOf[iso] || []).some((t) => normEn(nm).includes(t))) cand.set("File:" + nm, true);
    for (const q of qs) {
      try {
        const d = await commonsApi({ list: "search", srnamespace: "6", srlimit: "25", srsearch: q });
        for (const x of (d.query && d.query.search) || []) cand.set(x.title, true);
      } catch (e) { console.warn("search", q, e); }
    }
    if (!cand.size) { notFound.push(iso); continue; }
    // 候補の情報（ライセンス・形式・大きさ）をまとめて取得
    const titles = [...cand.keys()].slice(0, 40), infos = [];
    for (let i = 0; i < titles.length; i += 20) {
      const d = await commonsApi({ titles: titles.slice(i, i + 20).join("|"), prop: "imageinfo|videoinfo", iiprop: "url|size|mime|extmetadata", iiextmetadatafilter: "LicenseShortName|License|Artist", viprop: "derivatives" });
      for (const pg of (d.query && d.query.pages) || []) {
        const ii = pg.imageinfo && pg.imageinfo[0];
        if (!ii) continue;
        const md = ii.extmetadata || {}, lic = ((md.LicenseShortName && md.LicenseShortName.value) || (md.License && md.License.value) || "").replace(/<[^>]+>/g, "").trim();
        let url = ii.url, mime = ii.mime || "";
        if (!/^(audio\/|application\/ogg)/.test(mime) || /midi/.test(mime)) continue;   // 音声だけ（MIDI・動画は除く）
        if (/ogg/.test(mime) && !canPlayOgg()) {
          const mp3 = ((pg.videoinfo && pg.videoinfo[0] && pg.videoinfo[0].derivatives) || []).find((x) => /mpeg|mp3/.test(x.type || ""));
          if (!mp3) continue;
          url = mp3.src; mime = "audio/mpeg";
        }
        infos.push({ name: pg.title.replace(/^File:/, ""), url, mime, size: ii.size, license: lic, artist: ((md.Artist && md.Artist.value) || "").replace(/<[^>]+>/g, "").trim().slice(0, 80), page: ii.descriptionurl || "" });
      }
    }
    // その国の国歌と確かめられるもの（ファイル名から判定した国が一致、または国歌の曲名を含む）で、自由なライセンスのものだけ
    // ブラスバンド（軍楽隊・吹奏楽）の演奏だけ（ファイル名か作者で判定）
    const ok = infos.filter((f) => FREE_LICENSE.test(f.license) && isRightAnthem(iso, f.name) && BAND_RE.test(f.name + " " + f.artist)
      && ((inGallery.has(f.name) && isoFromFileName(f.name) === iso) || (isoFromFileName(f.name) === iso && /anthem|hymn|himno|hino|inno|hymne|himnusz|國歌|国歌/i.test(f.name)) || (titlesOf[iso] || []).some((t) => normEn(f.name).includes(t))));
    if (!ok.length) { notFound.push(iso); continue; }
    // パブリックドメイン・CC0 を優先、次に器楽（instrumental・軍楽隊）、短い版
    const score = (f) => (/public\s*domain|^pd|cc0/i.test(f.license) ? 0 : 1e9) + (/instrumental|band|orchestra/i.test(f.name) ? 0 : 1e8) + (/complete|full|vocal/i.test(f.name) ? 1e7 : 0) + (f.size || 0);
    found[iso] = ok.sort((a, b) => score(a) - score(b))[0];
  }
  return { found, notFound };
}

const COMMONS_ANTHEM_CAT = "Category:Audio_files_of_national_anthems_performed_by_the_United_States_Navy_Band";
const canPlayOgg = () => !!document.createElement("audio").canPlayType('audio/ogg; codecs="vorbis"');
// この形式をこのブラウザで再生できるか（Opus は Safari の古い版などで再生できない）
function canPlayAudio(mime, name = "") {
  const a = document.createElement("audio");
  if (/\.opus$/i.test(name) || /opus/.test(mime)) return !!a.canPlayType('audio/ogg; codecs="opus"');
  if (/ogg/.test(mime)) return canPlayOgg();
  return !!a.canPlayType(mime) || /mpeg|mp3|wav/.test(mime);
}
// GitHub の国歌 MP3 集（open-assets-hub/national-anthems）。一覧（index.json）は国コード・曲名・元のコモンズのファイル名つき
const GH_ANTHEM_REPO = "open-assets-hub/national-anthems";
const GH_ANTHEM_RAW = `https://raw.githubusercontent.com/${GH_ANTHEM_REPO}/main`, GH_ANTHEM_CDN = `https://cdn.jsdelivr.net/gh/${GH_ANTHEM_REPO}@main`;
async function ghAnthemIndex() {
  for (const base of [GH_ANTHEM_RAW, GH_ANTHEM_CDN]) {
    try { const r = await fetch(`${base}/index.json`); if (r.ok) return await r.json(); } catch (e) { console.warn("gh index", base, e); }
  }
  throw new Error("一覧を読み込めません");
}
// 国歌の録音を取得する国：「すべて」は公館のある国と巡回先の国（コンゴ共和国・ブルンジなど）、「月報のある国だけ」は月報の公館と巡回健診の行き先。日本は必ず
function anthemTargets(scope) {
  const out = new Set([HOME_ISO]);
  if (scope === "reports") {
    for (const r of Object.values(state.reports)) if (INFO[r.post] && INFO[r.post].iso3) out.add(INFO[r.post].iso3);
    for (const j of junkaiOf()) if (INFO[j.dest] && INFO[j.dest].iso3) out.add(INFO[j.dest].iso3);
  } else for (const v of Object.values(INFO)) if (v.iso3) out.add(v.iso3);
  out.delete(undefined);
  return out;
}
const iso3of2 = (c) => { const v = Object.values(INFO).find((v) => v.iso2 === (c || "").toLowerCase()); return v ? v.iso3 : null; };
// 日本（ツアーの出発・帰着地）。公館ではないので、録音の取得では別に加える
const HOME_ISO = "JPN";
// ブラスバンド（吹奏楽・軍楽隊）の録音か。国歌の録音はブラスバンドに揃える
const BAND_RE = /band|brass|military|navy|army|marine|air\s*force|guard|wind\s*(ensemble|orchestra)|banda|fanfare|musique|musikkorps|blasorchester|orkiestra\s*dęta|吹奏楽|軍楽|音楽隊/i;
// 国ごとに優先して使う録音（コモンズのファイル名）。「コモンズから取得」でこの録音を選ぶ
const PREFERRED_ANTHEM = {
  USA: "Star Spangled Banner instrumental.ogg",
  LKA: "Sri Lankan national anthem, performed by the United States Navy Band.oga",
  KHM: "United States Navy Band - Nokoreach.ogg",
};
// コモンズのファイルページの URL（…/wiki/File:… や upload.wikimedia.org の直リンク）またはファイル名から、ファイル名を取り出す
function commonsTitleFromUrl(u) {
  u = u.trim();
  let t = u;
  try {
    const url = new URL(u);
    if (/upload\.wikimedia\.org$/.test(url.hostname)) t = url.pathname.split("/").filter(Boolean).filter((x) => !/^\d+px-/.test(x)).pop();
    else t = url.searchParams.get("title") || url.pathname.replace(/^\/wiki\//, "");
  } catch { /* ファイル名だけが入力された */ }
  t = decodeURIComponent(t).replace(/^(File|ファイル|Image):/i, "").replace(/_/g, " ").trim();
  return t || null;
}
// コモンズのファイル1件の情報（URL・ライセンス・作者）。このブラウザで再生できない形式は、コモンズが用意している MP3 版にする
async function commonsFileInfo(name) {
  const d = await commonsApi({ titles: "File:" + name, prop: "imageinfo|videoinfo", iiprop: "url|size|mime|extmetadata", iiextmetadatafilter: "LicenseShortName|License|Artist", viprop: "derivatives" });
  const pg = d.query && d.query.pages && d.query.pages[0], ii = pg && pg.imageinfo && pg.imageinfo[0];
  if (!ii) throw new Error("コモンズにそのファイルが見つかりません");
  const md = ii.extmetadata || {}, lic = ((md.LicenseShortName && md.LicenseShortName.value) || (md.License && md.License.value) || "").replace(/<[^>]+>/g, "").trim();
  const nm = pg.title.replace(/^File:/, "");
  let url = ii.url, mime = ii.mime || "";
  if (!/^(audio\/|application\/ogg|video\/webm)/.test(mime) || /midi/.test(mime)) throw new Error("音声ファイルではありません");
  if (!canPlayAudio(mime, nm)) {
    const mp3 = ((pg.videoinfo && pg.videoinfo[0] && pg.videoinfo[0].derivatives) || []).find((x) => /mpeg|mp3/.test(x.type || ""));
    if (!mp3) throw new Error("このブラウザで再生できる形式がありません");
    url = mp3.src; mime = "audio/mpeg";
  }
  return { title: pg.title, name: nm, url, mime, size: ii.size, license: lic, free: FREE_LICENSE.test(lic),
    artist: ((md.Artist && md.Artist.value) || "").replace(/<[^>]+>/g, "").trim().slice(0, 80), page: ii.descriptionurl || "" };
}
async function commonsAnthemList(progress) {
  // ① カテゴリーの全ファイル名を集める（一覧だけなら1回に500件。続きがあれば最後まで読む。下位カテゴリーも1段）
  const titles = [], seen = new Set(), cats = [[COMMONS_ANTHEM_CAT, 0]];
  while (cats.length) {
    const [cat, depth] = cats.shift();
    if (seen.has(cat)) continue;
    seen.add(cat);
    let cont = {};
    for (let guard = 0; cont && guard < 100; guard++) {
      const d = await commonsApi(Object.assign({ list: "categorymembers", cmtitle: cat, cmtype: "file|subcat", cmlimit: "500" }, cont));
      for (const mbr of (d.query && d.query.categorymembers) || []) {
        if (mbr.ns === 14) { if (depth < 1) cats.push([mbr.title.replace(/ /g, "_"), depth + 1]); }
        else if (mbr.ns === 6 && !titles.includes(mbr.title)) titles.push(mbr.title);
      }
      cont = d.continue || null;
      progress && progress(titles.length);
    }
  }
  // ② ライセンス・URL・形式を50件ずつ調べる（ライセンス情報は1回に50件まで）
  const out = [], byTitle = {};
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    let cont = {};
    for (let guard = 0; cont && guard < 20; guard++) {
      const d = await commonsApi(Object.assign({ titles: batch.join("|"), prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiextmetadatafilter: "LicenseShortName|License|Artist" }, cont));
      for (const pg of (d.query && d.query.pages) || []) {
        const ii = pg.imageinfo && pg.imageinfo[0];
        if (!ii || byTitle[pg.title]) continue;
        const md = ii.extmetadata || {}, lic = ((md.LicenseShortName && md.LicenseShortName.value) || (md.License && md.License.value) || "").replace(/<[^>]+>/g, "").trim();
        const f = byTitle[pg.title] = { title: pg.title, name: pg.title.replace(/^File:/, ""), url: ii.url, mime: ii.mime || "audio/ogg", size: ii.size, license: lic,
          free: /public\s*domain|^pd|cc0|cc[\s-]*zero/i.test(lic), artist: ((md.Artist && md.Artist.value) || "").replace(/<[^>]+>/g, "").trim().slice(0, 80), page: ii.descriptionurl || "" };
        out.push(f);
      }
      cont = d.continue || null;
    }
    progress && progress(`${titles.length}件中 ${Math.min(titles.length, i + 50)}件の情報`);
  }
  // ③ Ogg を再生できないブラウザ（Safari など）は、コモンズが用意している MP3 版の URL を調べる
  if (!canPlayOgg()) {
    const oggs = out.filter((f) => /ogg/.test(f.mime));
    for (let i = 0; i < oggs.length; i += 10) {
      const d = await commonsApi({ titles: oggs.slice(i, i + 10).map((f) => f.title).join("|"), prop: "videoinfo", viprop: "derivatives" });
      for (const pg of (d.query && d.query.pages) || []) {
        const mp3 = ((pg.videoinfo && pg.videoinfo[0] && pg.videoinfo[0].derivatives) || []).find((x) => /mpeg|mp3/.test(x.type || ""));
        if (mp3 && byTitle[pg.title]) { byTitle[pg.title].url = mp3.src; byTitle[pg.title].mime = "audio/mpeg"; }
      }
    }
  }
  return out;
}

// 設定画面の入力欄（分類・まとめ方・AIの送り先）を state と prefs に反映する（保存は呼び出し側）
function applySettingsForm() {
  document.querySelectorAll("select[data-name]").forEach((x) => { state.overrides[x.dataset.name] = x.value; });
  document.querySelectorAll("[data-g]").forEach((i) => {
    const nm = i.dataset.g, v = i.value.trim();
    if (!v || v === autoGroup(nm)) delete state.groups[nm];
    else state.groups[nm] = v;
  });
  const urls = aiUrls();
  document.querySelectorAll("[data-aiurl]").forEach((i) => { urls[i.dataset.aiurl] = i.value.trim(); });
  savePref("aiUrls", urls);
}
// 書き出す設定（個人情報を含まないものだけ）
function settingsSnapshot() {
  const p = loadPrefs(), prefs = {};
  for (const k of ["aiUrls", "aiSecs", "aiPromptKey", "aiCustomPrompts", "aiPeriod", "tourSound", "importMode", "mapView", "tabOrder"]) if (p[k] !== undefined) prefs[k] = p[k];
  return { format: "geppou-settings", v: 1, saved: new Date().toISOString(), overrides: state.overrides, groups: state.groups, prefs };
}

function pageSettings() {
  const names = {};
  for (const r of Object.values(state.reports)) for (const d of r.diseases || []) names[d.name] = (names[d.name] || 0) + d.count;
  const rows = Object.entries(names).filter(([nm]) => classify(nm) === OTHER || state.overrides[nm]).sort((a, b) => b[1] - a[1]);
  const byMonth = months().map((m) => [m, reportsOf(m)]);
  main.innerHTML = `
    <h2>設定・データ管理</h2>
    <div class="card settings-save">
      <h3 style="margin-top:0">設定の保存</h3>
      <p class="muted">このページで変えた設定（疾病分類の手動設定・病名のまとめ方・AI分析の送り先）をまとめて保存します。設定は個人情報を含まないので、ファイルに書き出して他の医務官と共有したり、閲覧履歴を消したあとに読み込んで戻したりできます。</p>
      <div class="row">
        <button class="primary" id="saveAll">💾 設定を保存</button>
        <button id="setExp">設定をファイルに書き出す（.json）</button>
        <label class="btn">設定ファイルを読み込む<input type="file" id="setImp" accept=".json" hidden></label>
        <button id="showNotice" title="1か月表示しない設定も解除します">「はじめにお読みください」を表示</button>
        <button id="resetTabs">タブの並びを元に戻す</button>
        <span id="saveAllSt" class="muted"></span>
      </div>
      <p class="muted" style="margin:0">上のタブは横にドラッグして並べ替えられます（タッチ画面は長押ししてから動かす。キーボードは Alt+Shift+←/→）。並びはこのブラウザに保存されます。</p>
    </div>
    <div class="card">
      <h3 style="margin-top:0">AI分析の送り先</h3>
      <p class="muted">「AI分析（匿名）」タブのボタンで開くページのURLです（庁内ネットワークのアドレスを登録してください）。ボタンは個人情報を含まない集計テキストをコピーしてこのページを開くだけで、自動送信はしません。</p>
      ${AI_SITES.map(([k, name]) => `<div class="row"><label style="min-width:9em">${name}</label><input type="url" data-aiurl="${k}" value="${esc(aiUrls()[k])}" placeholder="https://..." size="48"></div>`).join("")}
    </div>
    <div class="card">
      <h3 style="margin-top:0">疾病分類の手動設定</h3>
      <p class="muted">キーワードで分類できなかった病名に分類を割り当てます。次回以降も同じ病名に適用されます。</p>
      ${rows.length ? `<table><thead><tr><th>病名</th><th class="num">件数</th><th>分類</th></tr></thead><tbody>${
        rows.map(([nm, c]) => `<tr><td>${esc(nm)}</td><td class="num">${c}</td><td><select data-name="${esc(nm)}">${CATEGORIES.map((cat) => `<option value="${esc(cat)}"${classify(nm) === cat ? " selected" : ""}>${esc(shortCat(cat))}</option>`).join("")}</select></td></tr>`).join("")}
      </tbody></table><div class="row"><button class="primary" id="saveOv">分類を保存</button></div>` : '<p class="muted">分類できなかった病名はありません。</p>'}
    </div>
    <div class="card">
      <h3 style="margin-top:0">病名のまとめ方</h3>
      <p class="muted">「感冒」「急性鼻咽頭炎」「上気道炎」→ かぜ（急性上気道炎）、「古典デング」「デング出血熱」→ デング熱 のように、表記の違う病名を1つにまとめて集計・地図表示します。まとめ先は書き換えられます（一覧にない名前を入れると新しいグループになります）。</p>
      <div class="row">
        <label><input type="checkbox" id="gonly"> まとめ先がない病名だけ表示</label>
        <input id="gfilter" type="search" placeholder="病名で絞り込み" size="16">
      </div>
      <datalist id="gnames">${[...new Set([...GROUP_NAMES, ...Object.values(state.groups)])].map((g) => `<option value="${esc(g)}">`).join("")}</datalist>
      <div class="table-wrap" style="max-height:420px"><table id="gtable"><thead><tr><th>報告された病名</th><th class="num">件数</th><th>まとめ先</th><th></th></tr></thead><tbody>${
        Object.entries(names).sort((a, b) => b[1] - a[1]).map(([nm, c]) => `<tr data-n="${esc(nm)}"><td>${esc(nm)}</td><td class="num">${c}</td>
          <td><input list="gnames" data-g="${esc(nm)}" value="${esc(groupOf(nm))}" size="22"></td><td class="muted">${state.groups[nm] ? "手動" : isGrouped(nm) ? "自動" : "まとめ先なし"}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="row"><button class="primary" id="saveG">まとめ方を保存</button><button id="resetG">自動の設定に戻す</button></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">国歌の録音（ハイライト・ツアー用）</h3>
      <p class="muted">ツアーで着いた国の国歌を流すには、国歌の音声ファイル（mp3・m4a・ogg・wav など）を登録します。ファイル名に国名（日本語・英語）か国コードを入れてください（例：<code>ケニア.mp3</code>、<code>Kenya.ogg</code>、<code>United States Navy Band - Kenya.ogg</code>、<code>KEN.mp3</code>）。フォルダごと読み込めます。登録した音声はこのブラウザの中だけに保存され、オフラインでも流れます。ツアーでは国歌の最初の${ANTHEM_MAX_SEC}秒を流します（公館カードの「国歌を聞く」は最後まで）。</p>
      <p class="muted">「🐙 GitHubから取得」は、GitHub の <a href="https://github.com/open-assets-hub/national-anthems" target="_blank" rel="noopener noreferrer">open-assets-hub/national-anthems</a>（米海軍軍楽隊による各国国歌の MP3、パブリックドメイン、約150か国）から取得します。一覧の国コードと曲が食い違うもの（例：AE に カタールの国歌、US に ハンガリーの国歌）は、曲名から判定した国のものとして扱うか除外します。1か国あたり約1〜3MB です。</p>
      <p class="muted">入手先：ウィキメディア・コモンズの <a href="https://commons.wikimedia.org/wiki/Category:Audio_files_of_national_anthems_performed_by_the_United_States_Navy_Band" target="_blank" rel="noopener noreferrer">米海軍軍楽隊（United States Navy Band）による各国国歌の録音</a>（米国政府職員が職務で作成したものでパブリックドメイン）。各ファイルのページで「パブリックドメイン」の表示を確認してから保存してください。ファイル名はそのままで読み込めます（「Thai National Anthem - US Navy Band.ogg」「Lupang Hinirang instrumental.ogg」のような国民名・曲名も判定します）。このリンクはインターネットが必要です。</p>
      <p class="muted">録音の登録がない国でも、<b>国歌の楽譜データがある${"43"}の国・地域</b>（日本・米国・英国・フランス・ドイツ・中国・ロシア・インド・インドネシア・イタリア・メキシコ・豪州・カナダ・パキスタン・ポーランド・スウェーデン・ウクライナ・南アフリカ・タンザニア・ザンビア・イスラエル・オーストリアなど）は、国歌の冒頭（約10〜20秒）をアプリが演奏します。楽譜データは anthem-scores（Wikipedia・Wikimedia Commons の自由ライセンスの楽譜から変換、出典は <a href="lib/anthems/CREDITS.md" target="_blank" rel="noopener">CREDITS</a>）。それ以外の国は地域の音楽を流します。</p>
      <div class="row"><button class="primary" id="anCommons">🌐 コモンズから取得</button><button id="anDeep">🔎 未登録の国を詳しく探す</button><button id="anGithub" title="GitHub の open-assets-hub/national-anthems（米海軍軍楽隊の各国国歌 MP3・パブリックドメイン）から取得">🐙 GitHubから取得</button>
        <select id="anScope"><option value="posts">公館のある国・巡回先の国すべて</option><option value="reports">月報のある国（巡回先を含む）だけ</option></select>
        <label title="登録済みの録音が米海軍軍楽隊のものでなければ、ブラスバンドの録音に差し替えます"><input type="checkbox" id="anKeep" checked> 登録済みの米海軍軍楽隊の録音は上書きしない</label></div>
      <p class="muted" style="margin-top:0">「コモンズから取得」は、このブラウザからウィキメディア・コモンズに接続して、ライセンスが自由利用（パブリックドメイン・CC0）の録音だけを取得します。国歌の録音は<b>ブラスバンド（米海軍軍楽隊）の演奏</b>に揃え、ほかの録音が登録されている国はブラスバンドの録音に差し替えます。公館のない日本（ツアーの出発・帰着で流す「君が代」）も取得します（月報のデータは送りません。インターネットが必要です）。</p>
      <div class="row"><input id="anUrl" type="url" placeholder="コモンズのファイルの URL（https://commons.wikimedia.org/wiki/File:…）" style="flex:1;min-width:260px">
        <select id="anUrlIso"><option value="">国（ファイル名から自動）</option></select>
        <button id="anUrlBtn">URLから登録</button><button class="linklike" id="anUrlEx" title="「星条旗」の器楽演奏（Star Spangled Banner instrumental.ogg）">例：米国（星条旗・器楽）</button></div>
      <div class="row"><label class="btn">音声ファイルを選ぶ<input type="file" id="anFiles" accept="audio/*,.mp3,.m4a,.ogg,.oga,.wav,.aac,.flac,.webm" multiple hidden></label>
        <label class="btn">フォルダを選ぶ<input type="file" id="anFolder" webkitdirectory directory multiple hidden></label><span id="anSt" class="muted"></span></div>
      <div id="anUnmatched"></div>
      <div id="anList"></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">オフラインでの利用</h3>
      <p id="offlineStatus">${offlineStatusText()}</p>
      <p class="muted">一度このページを開くと、アプリ一式（地図・国旗・ライブラリ・デモを含む）がこのブラウザに保存されます。インターネットがないときも同じアドレスを開けば使えます（Chrome・Edge では上の「⬇ アプリとして追加」でデスクトップから開けるようにもできます）。インターネットにつながったときは自動で新しい版に更新されます。<b>UpToDate のリンクだけはインターネットにつながっていないと開けません。</b></p>
    </div>
    <div class="card">
      <h3 style="margin-top:0">データのバックアップ</h3>
      <p class="muted">データはこのブラウザの中だけに保存されています。<b>閲覧履歴やCookie・サイトデータを消去するとデータも消えます</b>。必要な情報はファイルへ書き出し、<b>医務官のみがアクセスできるフォルダ</b>に保存してください。書き出すファイルは暗号化され、このアプリでしか読み込めません。</p>
      <p>${backupStatusText()}</p>
      <div class="row"><button id="exp">書き出し（暗号化 .geppou）</button><label class="btn">読み込み<input type="file" id="imp" accept=".geppou,.json" hidden></label>${demoMode ? '<button data-demo-exit>デモを終える</button>' : '<button data-demo-start>デモを見る（保存済みのデータはそのまま）</button>'}</div>
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
  const gfilt = () => {
    const only = $("#gonly").checked, kw = nfkc($("#gfilter").value.trim());
    document.querySelectorAll("#gtable tbody tr").forEach((tr) => {
      const nm = tr.dataset.n;
      tr.hidden = (only && isGrouped(nm)) || (kw && !nfkc(nm).includes(kw) && !nfkc(groupOf(nm)).includes(kw));
    });
  };
  $("#gonly").onchange = gfilt;
  $("#gfilter").oninput = gfilt;
  $("#saveG").onclick = async () => {
    document.querySelectorAll("[data-g]").forEach((i) => {
      const nm = i.dataset.g, v = i.value.trim();
      if (!v || v === autoGroup(nm)) delete state.groups[nm];
      else state.groups[nm] = v;
    });
    await saveState(); toast("まとめ方を保存しました"); render();
  };
  $("#resetG").onclick = async () => {
    if (!confirm("手動で付け替えたまとめ先をすべて自動に戻します。よろしいですか？")) return;
    state.groups = {};
    await saveState(); render();
  };
  $("#exp").onclick = async () => { await exportBackup(); render(); };
  bindAnthemSettings();
  const rt = $("#resetTabs");
  if (rt) rt.onclick = () => { savePref("tabOrder", null); flipTabs(applyTabOrder); toast("タブの並びを元に戻しました"); };
  $("#showNotice").onclick = () => {
    savePref("noticeSnoozeUntil", 0);
    $("#noticeOk").checked = false; $("#noticeSnooze").checked = false; $("#noticeBtn").disabled = true;
    $("#notice").showModal();
  };
  $("#saveAll").onclick = async () => {
    const bad = [...document.querySelectorAll("[data-aiurl]")].filter((i) => i.value.trim() && !/^https?:\/\//i.test(i.value.trim()));
    if (bad.length) { toast("URLは http:// または https:// から入力してください"); bad[0].focus(); return; }
    applySettingsForm();
    await saveState();
    $("#saveAllSt").textContent = `保存しました（${new Date().toLocaleTimeString("ja-JP")}）`;
    toast("設定を保存しました");
  };
  $("#setExp").onclick = () => {
    applySettingsForm();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(settingsSnapshot(), null, 1)], { type: "application/json" }));
    a.download = `geppou_settings_${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("設定を書き出しました（個人情報は含みません）");
  };
  $("#setImp").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const o = JSON.parse(await f.text());
      if (o.format !== "geppou-settings") throw new Error("設定ファイルではありません");
      if (!confirm("読み込んだ設定を今の設定に上書きします（月報のデータはそのまま）。よろしいですか？")) return;
      Object.assign(state.overrides, o.overrides || {});
      Object.assign(state.groups, o.groups || {});
      for (const [k, v] of Object.entries(o.prefs || {})) savePref(k, v);
      applyTabOrder();
      await saveState(); toast("設定を読み込みました"); render();
    } catch (err) { toast("読み込めませんでした: " + err.message); }
  };
  $("#imp").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const s = await decryptBackup(await f.text());
      if (!s.reports) throw new Error("形式が違います");
      if (!confirm("現在のデータを置き換えます。よろしいですか？")) return;
      state = Object.assign({ reports: {}, rosters: {}, junkai: {}, overrides: {}, groups: {}, cases: {} }, s);
      await saveState();
      savePref("lastBackup", Date.now());  // 読み込んだファイル自体がバックアップになっている
      refreshMonths(); toast("読み込みました"); render();
    } catch (err) { toast("読み込めませんでした: " + err.message); }
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
    state = { reports: {}, rosters: {}, junkai: {}, overrides: {}, groups: {}, cases: {} };
    await saveState(); refreshMonths(); render();
  };
}

// ======================================================================= オフライン対応（サービスワーカー）
// 初めて開いたときにアプリ一式をブラウザに保存し、以後はインターネットがなくても開ける（sw.js）。
// ネットにつながっていれば、開くたびに新しい版を確認して自動で入れ替える
const offline = { ready: false, version: "", supported: "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1") };
function offlineStatusText() {
  if (!offline.supported) return location.protocol === "file:"
    ? "ファイルを直接開いているため、オフライン保存は使えません。公開ページ（https://ysk713.github.io/-/geppou/）を一度開いてください。"
    : "このブラウザはオフライン保存に対応していません。";
  return offline.ready ? `✅ オフラインで使う準備ができています（版 ${offline.version || "―"}）。インターネットがなくても、このブラウザで開けば使えます。`
    : "⏳ オフライン用にアプリを保存しています…（数十秒かかることがあります）";
}
function updateNetBadge() { const b = $("#netBadge"); if (b) b.hidden = navigator.onLine; }
window.addEventListener("online", updateNetBadge);
window.addEventListener("offline", updateNetBadge);
updateNetBadge();
if (offline.supported) {
  // 更新で入れ替わったときは、作業中の画面を勝手に読み直さず、お知らせだけ出す
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) toast("アプリを新しい版に更新しました。再読み込みすると反映されます");
    hadController = true;
  });
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.version) { offline.version = e.data.version; offline.ready = true; if (page === "settings") { const el = $("#offlineStatus"); if (el) el.textContent = offlineStatusText(); } }
  });
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      // 新しい版が入ったらすぐ有効にする（アプリ本体はネット優先で取るので、古い版と混ざらない）
      const promote = (w) => w && w.addEventListener("statechange", () => w.state === "installed" && w.postMessage("skipWaiting"));
      promote(reg.installing);
      reg.addEventListener("updatefound", () => promote(reg.installing));
      await navigator.serviceWorker.ready;
      (navigator.serviceWorker.controller || reg.active).postMessage("version");
    } catch (e) { console.warn("service worker", e); }
  });
}
// 「アプリとして追加」（Chrome・Edge）
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; $("#installBtn").hidden = false; });
window.addEventListener("appinstalled", () => { $("#installBtn").hidden = true; toast("アプリとして追加しました"); });
$("#installBtn").onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $("#installBtn").hidden = true; };

// UpToDate はインターネットが必要。オフライン中にクリックしたら開かずに知らせる
document.addEventListener("click", (e) => {
  if (e.target.closest("a.utd") && !navigator.onLine) { e.preventDefault(); toast("UpToDate はインターネットにつながっているときだけ開けます"); }
});

// ======================================================================= 起動

// ---- タブの並び替え：横にドラッグして順番を変える（ほかのタブはアニメーションで場所をあける）。並びは prefs.tabOrder に保存
// マウスは少し動かすとドラッグ開始、タッチは長押し（0.3秒）で開始（ふつうのスワイプはタブの横スクロール）。キーボードは Alt+Shift+←/→
const DEFAULT_TAB_ORDER = [...document.querySelectorAll("#tabs button[data-page]")].map((b) => b.dataset.page);
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function applyTabOrder() {
  const nav = $("#tabs"), order = loadPrefs().tabOrder || [];
  const btns = [...nav.querySelectorAll("button[data-page]")];
  const rank = (k) => { const i = order.indexOf(k); return i >= 0 ? i : order.length + DEFAULT_TAB_ORDER.indexOf(k); };
  btns.sort((a, b) => rank(a.dataset.page) - rank(b.dataset.page)).forEach((b) => nav.appendChild(b));
}
const saveTabOrder = () => savePref("tabOrder", [...$("#tabs").querySelectorAll("button[data-page]")].map((b) => b.dataset.page));
// FLIP：DOM の並びを変えたあと、ほかのタブを元の位置から新しい位置へ滑らせる
function flipTabs(change, skip = null) {
  const nav = $("#tabs"), btns = [...nav.querySelectorAll("button[data-page]")];
  const before = new Map(btns.map((b) => [b, b.getBoundingClientRect().left]));
  change();
  if (reduceMotion()) return;
  for (const b of btns) {
    if (b === skip) continue;
    const dx = before.get(b) - b.getBoundingClientRect().left;
    if (!dx) continue;
    b.style.transition = "none";
    b.style.transform = `translateX(${dx}px)`;
    requestAnimationFrame(() => { b.style.transition = "transform .22s cubic-bezier(.2,.8,.2,1)"; b.style.transform = ""; });
  }
}
// メニューの本来の位置の目印（高さ0）。ページを切り替えたときに、ここまで戻す
const tabsAnchor = document.createElement("div");
$("#tabs").before(tabsAnchor);
// メニューが上に固定されている（ページがスクロールされた）ときは、下に影をつける
addEventListener("scroll", () => { const t = $("#tabs"); if (t) t.classList.toggle("stuck", t.getBoundingClientRect().top <= 0 && scrollY > 0); }, { passive: true });
let tabDragJustEnded = false;
(() => {
  const nav = $("#tabs");
  let drag = null;   // { b, id, x0, grab, started, timer, touch }
  const startDrag = () => {
    const d = drag;
    d.started = true;
    d.b.classList.add("tab-dragging");
    nav.classList.add("tabs-sorting");
    try { d.b.setPointerCapture(d.id); } catch {}
  };
  const place = (x) => {
    // 指の位置にタブを置く（今の並びの位置からのずれを transform で）
    const d = drag;
    d.b.style.transition = "none";
    d.b.style.transform = "";
    const slot = d.b.getBoundingClientRect().left;
    d.b.style.transform = `translateX(${x - d.grab - slot}px) translateY(-2px) scale(1.04)`;
  };
  const autoScroll = (x) => {
    const r = nav.getBoundingClientRect(), edge = 40;
    if (x < r.left + edge) nav.scrollLeft -= 12;
    else if (x > r.right - edge) nav.scrollLeft += 12;
  };
  nav.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("button[data-page]");
    if (!b || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag = { b, id: e.pointerId, x0: e.clientX, y0: e.clientY, grab: e.clientX - b.getBoundingClientRect().left, started: false, touch: e.pointerType !== "mouse" };
    // タッチは長押しで並び替え（短く動かしたときは横スクロール）
    if (drag.touch) drag.timer = setTimeout(() => { if (drag && !drag.started) { startDrag(); place(drag.x0); if (navigator.vibrate) navigator.vibrate(15); } }, 300);
  });
  nav.addEventListener("pointermove", (e) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.started) {
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (d.touch) { if (Math.hypot(dx, dy) > 8) { clearTimeout(d.timer); drag = null; } return; }   // 長押し前に動いたらスクロール
      if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(dy)) return;
      startDrag();
    }
    e.preventDefault();
    autoScroll(e.clientX);
    // 指の位置がとなりのタブの中央を越えたら入れ替える
    const sibs = [...nav.querySelectorAll("button[data-page]")].filter((x) => x !== d.b);
    const center = e.clientX - d.grab + d.b.offsetWidth / 2;
    let target = null;
    for (const s of sibs) { const r = s.getBoundingClientRect(); if (center < r.left + r.width / 2) { target = s; break; } }
    if (target !== d.b.nextElementSibling && !(target === null && !d.b.nextElementSibling)) flipTabs(() => nav.insertBefore(d.b, target), d.b);
    place(e.clientX);
  });
  const end = (e) => {
    const d = drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    clearTimeout(d.timer);
    drag = null;
    if (!d.started) return;
    nav.classList.remove("tabs-sorting");
    // 手を離したら、新しい場所へすっと収める
    d.b.style.transition = reduceMotion() ? "none" : "transform .2s cubic-bezier(.2,.8,.2,1)";
    d.b.style.transform = "";
    setTimeout(() => { d.b.classList.remove("tab-dragging"); d.b.style.transition = ""; }, 220);
    saveTabOrder();
    tabDragJustEnded = true; setTimeout(() => (tabDragJustEnded = false), 60);
  };
  nav.addEventListener("pointerup", end);
  nav.addEventListener("pointercancel", end);
  nav.addEventListener("contextmenu", (e) => { if (drag && drag.touch) e.preventDefault(); });   // 長押しのメニューを出さない
  // キーボード：Alt+Shift+←/→ で、選んでいるタブを左右に移す
  nav.addEventListener("keydown", (e) => {
    const b = e.target.closest("button[data-page]");
    if (!b || !e.altKey || !e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const ref = e.key === "ArrowLeft" ? b.previousElementSibling : b.nextElementSibling && b.nextElementSibling.nextElementSibling;
    if (e.key === "ArrowLeft" && !ref) return;
    if (e.key === "ArrowRight" && !b.nextElementSibling) return;
    flipTabs(() => nav.insertBefore(b, ref));
    b.focus();
    saveTabOrder();
  });
  applyTabOrder();
})();
$("#tabs").onclick = (e) => {
  if (tabDragJustEnded) return;   // ドラッグして離したときはページを切り替えない
  const b = e.target.closest("button[data-page]");
  if (!b) return;
  // 下のほうまでスクロールしていたら、新しいページは先頭から（メニューは上に固定されたまま）
  const top0 = tabsAnchor.getBoundingClientRect().top + scrollY;   // メニューの本来の位置（固定中のメニュー自身の位置は使えない）
  if (b.dataset.page !== page && scrollY > top0) scrollTo({ top: top0, behavior: "instant" });
  page = b.dataset.page;
  savePref("page", page);
  render();
};
$("#month").onchange = () => { savePref("month", curMonth()); render(); };

// 開いたときに取扱いの注意を表示する（同じタブで再読み込みしたときは出さない）
(() => {
  const d = $("#notice");
  let seen = false;
  try { seen = sessionStorage.getItem("geppou.notice") === "1"; } catch {}
  // 「1か月間表示しない」を選んでいれば、その期限までは出さない
  if ((loadPrefs().noticeSnoozeUntil || 0) > Date.now()) seen = true;
  // アプリから開いたPDF作成のタブでは出さない（元のタブで同意済み）
  if ((new URLSearchParams(location.search).get("pdfjob") || new URLSearchParams(location.search).get("tourtab")) && window.opener) seen = true;
  if (!d || seen || typeof d.showModal !== "function") return;
  // 「理解しました」にチェックするまで閉じられない（Esc キーでも閉じない）
  $("#noticeOk").onchange = () => ($("#noticeBtn").disabled = !$("#noticeOk").checked);
  d.addEventListener("cancel", (e) => e.preventDefault());
  d.addEventListener("close", () => {
    try { sessionStorage.setItem("geppou.notice", "1"); } catch {}
    if ($("#noticeSnooze").checked) savePref("noticeSnoozeUntil", Date.now() + 30 * 864e5);
  });
  d.showModal();
})();

// ---- 別のタブでPDFレポートを作成し、できあがったPDFをそのタブで表示する（?pdfjob=1&m=YYYY-MM&map=1[&demo=1]）
async function runPdfJob(params) {
  const m = params.get("m");
  const sections = new Set((params.get("secs") || REPORT_SECTIONS.map((x) => x[0]).join(",")).split(",").filter((k) => REPORT_SECTIONS.some((x) => x[0] === k)));
  document.body.classList.add("pdfjob");
  document.title = "PDFレポートを作成中…";
  $("#tabs").hidden = true; document.querySelector(".head-right").hidden = true; $("#backupbar").hidden = true;
  main.innerHTML = `
    <h2>統合PDFレポート（${m ? fmtMonth(m) : ""}）</h2>
    <div class="card" id="jobcard">
      <p><b id="jobst">準備しています…</b></p>
      <div class="jobbar"><div id="jobfill"></div></div>
      <p class="muted">作成中も、元のタブで作業を続けられます。このタブを閉じると作成は中止されます。</p>
    </div>
    <div id="jobout"></div>`;
  const step = (txt) => {
    $("#jobst").textContent = txt;
    const mm = txt.match(/(\d+)\s*\/\s*(\d+)/);
    $("#jobfill").style.width = (mm ? 15 + 80 * (+mm[1] / +mm[2]) : /暗号/.test(txt) ? 97 : 8) + "%";
    document.title = `PDF作成中 ${txt.replace(/^.*?(\d+\s*\/\s*\d+).*$/, "$1")}`;
  };
  try {
    if (params.get("demo") ? !(await loadDemoData()) : (await loadState(), false)) throw new Error("データを読み込めませんでした");
    if (!m || !reportsOf(m).length) throw new Error("この月のデータがありません");
    const blob = await buildReportPdf(m, sections, step);
    const url = URL.createObjectURL(blob), fname = `医務官月報統合レポート_${m.replace("-", "")}.pdf`;
    document.title = `PDFレポート ${fmtMonth(m)}`;
    $("#jobcard").innerHTML = `<p><b>できました（${(blob.size / 1048576).toFixed(1)} MB）</b>　下に表示しています。開くにはパスワードが必要です。目次の各行やしおりから各章へ移動できます。印刷はビューアの印刷ボタンから（印刷すると全ページに「${WATERMARK}」の透かし・印が入ります）。</p>
      <div class="row"><a class="btn primary" id="jobdl" href="${url}" download="${esc(fname)}">💾 保存（ダウンロード）</a>
      <a class="btn" href="${url}" target="_blank" rel="noopener">PDFだけを全画面で開く</a>
      <button id="jobclose">このタブを閉じる</button></div>
      <p class="muted" style="margin-bottom:0">保存するときは、医務官のみがアクセスできるフォルダに保存してください。</p>`;
    $("#jobout").innerHTML = `<iframe class="jobpdf" src="${url}" title="PDFレポート"></iframe>`;
    $("#jobclose").onclick = () => window.close();
  } catch (e) {
    console.error(e);
    document.title = "PDFレポートの作成に失敗しました";
    $("#jobcard").innerHTML = `<p class="bad">作成に失敗しました：${esc(e.message)}</p><p class="muted">元のタブに戻って、もう一度お試しください。</p>`;
  }
}

// 起動時に一度だけ、誤って登録された国歌の録音を取り除く
setTimeout(async () => {
  try {
    if (loadPrefs().anthemCleanV2) return;
    const removed = await cleanupAnthems();
    savePref("anthemCleanV2", 1);
    if (removed.length) toast(`国歌ではない録音を外しました：${removed.join("、")}。「設定 → 国歌の録音 → コモンズから取得」で取り直せます`);
  } catch (e) { console.warn("anthem cleanup", e); }
}, 2500);

(async () => {
  const qs = new URLSearchParams(location.search);
  if (qs.get("pdfjob")) { await runPdfJob(qs); return; }
  if (TOUR_TAB) {
    // ツアー専用のタブ：データを読み、地図のページだけを大きく表示する
    document.body.classList.add("tourtab");
    document.title = "ハイライト・ツアー";
    $("#tabs").hidden = true; document.querySelector(".head-right").hidden = true; $("#backupbar").hidden = true;
    if (qs.get("demo")) await loadDemoData(); else await loadState();
    refreshMonths(qs.get("m"));
    page = "map";
    render();
    return;
  }
  await loadState();
  if (qs.has("demo")) { await startDemo(); return; }
  refreshMonths();
  const saved = loadPrefs().page;
  if (saved && document.querySelector(`#tabs button[data-page="${saved}"]`)) page = saved;
  else if (months().length) page = "dashboard";
  render();
})();
