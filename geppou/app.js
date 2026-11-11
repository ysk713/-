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
// 国名を50音順に並べる。漢字の国名・公館名は読みに置き換えてから比べる（そのままだと漢字の名前が最後にまとまってしまう）
const KANJI_READ = [["南アフリカ", "みなみアフリカ"], ["南スーダン", "みなみスーダン"], ["中央アフリカ", "ちゅうおうアフリカ"], ["赤道ギニア", "せきどうギニア"],
  ["東ティモール", "ひがしティモール"], ["韓国", "かんこく"], ["中国", "ちゅうごく"], ["英国", "えいこく"], ["日本", "にほん"], ["広州", "こうしゅう"],
  ["上海", "しゃんはい"], ["瀋陽", "しんよう"], ["香港", "ほんこん"], ["民主共和国", "みんしゅきょうわこく"], ["共和国", "きょうわこく"],
  ["首長国連邦", "しゅちょうこくれんぽう"], ["合衆国", "がっしゅうこく"], ["総領事館", "そうりょうじかん"]];
// 読みは名前ごとに1回だけ作って覚える。比べるのは日本語の照合（Intl.Collator）を使い回す（並べ替えが速い）
const READING_MEMO = new Map(), JA_COLL = new Intl.Collator("ja");
const readingOf = (name) => {
  const k = String(name || "");
  let t = READING_MEMO.get(k);
  if (t === undefined) { t = k; for (const [w, r] of KANJI_READ) t = t.split(w).join(r); READING_MEMO.set(k, t); }
  return t;
};
const jaCmp = (a, b) => JA_COLL.compare(readingOf(a), readingOf(b)) || JA_COLL.compare(String(a), String(b));
const POST_NAMES = D.posts.map((p) => p.name).sort(jaCmp);
const ALL_PLACES = Object.keys(INFO).sort(jaCmp);
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
// 地域は、すべての画面・PDF・AI分析で7つ（アフリカ・アジア・大洋州・ヨーロッパ・中東・北米・中南米）に分けて扱う
// （公館一覧の地域「米州」「アジア・大洋州」を分ける）
let SPLIT_VIEW = 1;
const splitRegion = (g, name) => {
  const iso = INFO[name] && INFO[name].iso3;
  if (g === "米州") return iso === "USA" || iso === "CAN" ? "北米" : "中南米";
  if (g === "アジア・大洋州") return ["AUS", "NZL", "PNG", "FJI", "SLB", "VUT", "WSM", "TON", "KIR", "TUV", "MHL", "FSM", "PLW", "NRU"].includes(iso) ? "大洋州" : "アジア";
  return g;
};
const regionOf = (name) => { const g = INFO[name] ? INFO[name].region : "未分類"; return SPLIT_VIEW ? splitRegion(g, name) : g; };
REGIONS.splice(0, REGIONS.length, "アフリカ", "アジア", "大洋州", "ヨーロッパ", "中東", "北米", "中南米");
// 保存されている月報の地域（以前の「米州」「アジア・大洋州」）を、いまの7地域に直す
const fixReportRegions = () => { for (const r of Object.values(state.reports || {})) if (r && r.post) r.region = regionOf(r.post); };
const coord = (name) => (INFO[name] ? [INFO[name].lat, INFO[name].lon] : null);

// ======================================================================= 疾病分類

const Z = D.z, OTHER = D.other;
const CATEGORIES = [...new Set([...D.rules.map((r) => r[0]), OTHER])];
const shortCat = (c) => D.short[c] || c;
// 病名 → 分類。手で決めた分類 ＞ 病名のキーワード（いちばん長く一致したもの）＞ 乙表でその病名が書かれていた分類の欄（hint）の順
function classify(name, hint) {
  if (state.overrides[name]) return state.overrides[name];
  const ck = name + "\u0000" + (hint || "");
  const hit = CLASS_CACHE.get(ck);
  if (hit) return hit;
  const res = classifyRaw(name, hint);
  CLASS_CACHE.set(ck, res);
  return res;
}
// ワクチン・予防接種は、病名の語（「A型肝炎ワクチン」の「A型肝炎」など）より先に Z・「予防接種」にする（曝露後の予防は除く）
const VACCINE_RE = /ワクチン|予防接種|接種|トキソイド/, EXPOSURE_RE = /曝露|暴露|咬/;
// 接種の副反応（発熱・腫脹・アナフィラキシーなど）は予防接種ではなく、外傷・中毒（ICD-10 の T88・T80）
const ADVERSE_RE = /副反応|副作用|有害事象|腫脹|発赤|硬結|アナフィラキシー|反応/;
const isVaccineName = (n) => VACCINE_RE.test(n) && !EXPOSURE_RE.test(n) && !ADVERSE_RE.test(n);
const isVaccineAdverse = (n) => VACCINE_RE.test(n) && ADVERSE_RE.test(n);
// 保健サービス（指導・予防・検査・相談・証明など）は、病名の語より先に Z にする（「メンタルヘルスチェック」が精神・行動にならないように）
const SERVICE_RE = /指導|予防(?!接種後)|チェック|健診|検診|相談|証明|診断書|紹介状|面談|面接|処置|抜糸|就業制限|受け取り|検査|研修|教育|講話|巡視|ドック|交換/;
// 骨折・捻挫・脱臼・断裂は、部位の語（「頸部」「膝蓋」など）より先に外傷にする（骨粗鬆症による・病的なものは除く）
const INJURY_RE = /骨折|捻挫|脱臼|靭帯断裂|腱断裂|肉離れ/, NONTRAUMA_RE = /骨粗鬆|病的|疲労性?骨折/;
const isServiceName = (n) => SERVICE_RE.test(n) && !EXPOSURE_RE.test(n) && !isVaccineAdverse(n);
const rubyToKanji = (t) => t.replace(/[\u3040-\u309f]+<([\u4e00-\u9fff]+)>/g, "$1");
function classifyRaw(name, hint) {
  // いちばん長く一致したキーワードの分類を採る（「蕁麻疹」が「麻疹」で感染症にならないように）
  // ICD のふりがな書き（「そう<掻>痒症」「う<齲>蝕」「乾せん<癬>」）は漢字の形でも照合する
  let best = OTHER, len = 0;
  const t = nfkc(cleanDiseaseName(name)), t2 = rubyToKanji(t);
  if (isVaccineName(t)) return Z;
  if (isVaccineAdverse(t)) return "損傷、中毒及びその他の外因の影響";
  if (isServiceName(t)) return Z;
  if (INJURY_RE.test(t) && !NONTRAUMA_RE.test(t)) return "損傷、中毒及びその他の外因の影響";
  if (t === "痛み" || t === "疼痛") return "症状・徴候等（他に分類されないもの）";   // 部位の書いていない痛み（R52）
  // 「Q熱」のように英字で始まる病名は、ICDコードの切れ端として英字が除かれることがあるので、元の表記でも照合する
  const t3 = nfkc(String(name || ""));
  for (const [cat, kws] of D.rules) for (const k of kws) if (k.length > len && (t.includes(k) || t2.includes(k) || t3.includes(k))) { best = cat; len = k.length; }
  if (!len && hint && CATEGORIES.includes(hint)) return hint;
  return best;
}
// ICDコード（「J06」「J00-J99」）や表の分類名から、分類を決める
function codeCategory(code) {
  const c = String(code).toUpperCase().slice(0, 3);
  if (!/^[A-Z]\d{2}$/.test(c)) return null;
  const r = (D.codes || []).find(([a, b]) => c >= a && c <= b);
  return r ? r[2] : null;
}
function chapterHint(text) {
  const t = nfkc(text);
  const code = t.match(/(?<![A-Za-z])([A-Z]\d{2})(?:\.\d+)?(?:\s*[-~〜－ー]\s*[A-Z]?\d{2})?/);
  const w = (D.chapters || []).find(([k]) => t.includes(k));
  return (w && w[1]) || (code && codeCategory(code[1])) || null;
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
  // ICD-10 の分類名で書かれた病名のまとめ（2026年10月追加）
  ["結核", ["結核"]], ["非結核性抗酸菌症", ["非結核性抗酸菌"]], ["エムポックス", ["エムポックス", "サル痘"]], ["麻疹", ["麻疹", "はしか"]],
  ["風疹", ["風疹", "ドイツ麻疹"]], ["髄膜炎", ["髄膜炎"]], ["髄膜炎菌感染症", ["髄膜炎菌"]], ["虫垂炎", ["虫垂炎"]], ["心筋梗塞", ["心筋梗塞"]],
  ["胆石・胆のう炎", ["胆石", "胆のう<嚢>炎", "胆嚢炎"]], ["骨粗しょう症", ["骨粗しょう", "骨粗鬆"]], ["いぼ（疣贅）", ["いぼ<疣>", "疣贅"]],
  ["白血病", ["白血病"]],
  ["予防接種", ["予防接種", "ワクチン"]], ["健康診断", ["健康診断", "健診", "検診"]],
];
const GROUP_PATTERNS = DISEASE_GROUPS.flatMap(([g, pats]) => pats.map((p) => [nfkc(p), g])).sort((a, b) => b[0].length - a[0].length);
const GROUP_NAMES = DISEASE_GROUPS.map((g) => g[0]);
const GROUP_CACHE = new Map();  // 病名 → まとめ（パターンは変わらないので、ずっと覚えておいてよい）
function autoGroup(name) {
  let g = GROUP_CACHE.get(name);
  if (g === undefined) { g = autoGroupRaw(name); GROUP_CACHE.set(name, g); }
  return g;
}
function autoGroupRaw(name) {
  const c = nfkc(cleanDiseaseName(name)), t = c + "\u0000" + rubyToKanji(c);
  if (isVaccineName(c)) return "予防接種";
  if (isVaccineAdverse(c)) return "予防接種の副反応";
  for (const [p, g] of GROUP_PATTERNS) if (t.includes(p)) return g;
  return name;
}
// まとめ（state.groups）で付けた名前が、標準のまとめ（GROUP_NAMES）の言い換え（「感染性胃腸炎（疑い）」「単純ヘルペスウイルス感染症」など）なら、標準のまとめに入れる
const groupOf = (name) => {
  const g = state.groups[name];
  if (!g) return autoGroup(name);
  if (GROUP_NAMES.includes(g)) return g;
  const a = autoGroup(g);
  return GROUP_NAMES.includes(a) ? a : g;
};
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
  "非結核性抗酸菌症": "nontuberculous mycobacteria", "髄膜炎菌感染症": "meningococcal disease", "虫垂炎": "acute appendicitis",
  "心筋梗塞": "acute myocardial infarction", "胆石・胆のう炎": "cholecystitis gallstones", "骨粗しょう症": "osteoporosis", "いぼ（疣贅）": "warts", "白血病": "leukemia",
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
  // まとめて書く・消す（1回の書き込みで）
  async batch(puts, dels = []) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction("kv", "readwrite"), st = tx.objectStore("kv");
      for (const [k, v] of puts) st.put(v, k);
      for (const k of dels) st.delete(k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
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

// 保存の形：月報（state.reports）は月ごとに文字（JSON）にして、月ごとに別のところ（rep:2026-09）に入れ、変わった月だけを書き込む。
// 全部を一度に書き込むと、件数が多いとき画面が固まるため。月ごとに少しずつ文字にして、その合間に画面を動かす。
// それ以外（配置表・設定など）は「state」にそのまま
// 画面へ制御を返す（大量の処理の合間に）。setTimeout は、タブが裏にあると1回に1秒以上待たされる（ブラウザの節電）ので使わない。
// タブが見えていないときは、画面を動かす必要がないので待たずに続ける
const UI_CH = new MessageChannel(), UI_WAIT = [];
UI_CH.port1.onmessage = () => { const f = UI_WAIT.shift(); if (f) f(); };
const yieldUI = () => document.hidden ? Promise.resolve()
  : window.scheduler && scheduler.yield ? scheduler.yield() : new Promise((ok) => { UI_WAIT.push(ok); UI_CH.port2.postMessage(0); });
const MONTH_TEXT = new Map();   // 月 → 最後に書き込んだ（読み込んだ）文字
async function packMonths(st) {
  const by = {};
  for (const [k, r] of Object.entries(st.reports || {})) (by[k.split("|")[0]] ||= {})[k] = r;
  const months = {};
  let n = 0;
  for (const [m, rs] of Object.entries(by)) { months[m] = JSON.stringify(rs); if (++n % 4 === 0) await yieldUI(); }
  return months;
}
async function unpackState(s) {
  // 以前の版のアプリ（別のタブで開いたまま）が月報なしで書き込んだときは、月ごとのところから戻す
  if (s && !s.__packed && !Object.keys(s.reports || {}).length) {
    const list = await idb.get("repIndex").catch(() => null);
    if (list && list.length) { console.warn("月報を月ごとの保存から戻します"); s = { __packed: 3, rest: s, monthList: list }; }
  }
  if (!s || !s.__packed) return s;
  const reports = {};
  let n = 0;
  // 2：月ごとの文字を state の中に持つ（以前の形）。3：月ごとに別のところ
  const texts = s.__packed === 2 ? Object.entries(s.months || {}) : await Promise.all((s.monthList || []).map(async (m) => [m, await idb.get("rep:" + m)]));
  for (const [m, txt] of texts) { if (!txt) continue; Object.assign(reports, JSON.parse(txt)); if (s.__packed === 3) MONTH_TEXT.set(m, txt); if (++n % 6 === 0) await yieldUI(); }
  return { ...s.rest, reports };
}
// 書き込みは1つずつ順に（続けて保存したときに古い内容で上書きしないように）。
// 書き込み中にまた保存したときは、待っている書き込みを1つにまとめる（何度も全部を書き直さない。書くときに最新の内容を使う）
let writeChain = Promise.resolve(), writeQueued = null, writeArg = null;
function writeState(st) {
  writeArg = st;
  if (writeQueued) return writeQueued;
  const job = writeQueued = writeChain.then(async () => {
    writeQueued = null;
    const st = writeArg;
    const months = await packMonths(st);
    const puts = Object.entries(months).filter(([m, t]) => MONTH_TEXT.get(m) !== t).map(([m, t]) => ["rep:" + m, t]);
    const dels = [...MONTH_TEXT.keys()].filter((m) => !(m in months)).map((m) => "rep:" + m);
    const { reports, ...rest } = st;
    await idb.batch([...puts, ["state", { __packed: 3, rest, monthList: Object.keys(months) }], ["repIndex", Object.keys(months)]], dels);
    for (const [k, t] of puts) MONTH_TEXT.set(k.slice(4), t);
    for (const k of dels) MONTH_TEXT.delete(k.slice(4));
  });
  writeChain = job.catch(() => {});
  return job;
}
async function loadState() {
  try {
    const s = await unpackState(await idb.get("state"));
    if (s) state = Object.assign({ reports: {}, rosters: {}, junkai: {}, overrides: {}, groups: {}, cases: {} }, s);
    // 以前に保存した配置表の医務官名から、広・産・メの印を取り除く（月報の甲表の氏名には印はないので触らない）
    for (const rows of Object.values(state.rosters || {})) for (const r of rows || []) if (r && r.officer) r.officer = cleanOfficer(r.officer);
    // 以前の版で、名前に「月」「年」が入る医務官の欄に受診者数の数字を読んでしまった月報は、医務官名を空にする（配置表の名前で補う）
    let fixedOff = 0;
    for (const r of Object.values(state.reports || {})) if (r && r.officer && /^[\d\s.,]+$/.test(r.officer)) { r.officer = null; fixedOff++; }
    fixReportRegions();
    const before = state.summaryStamp;
    if (s && (upgradeSummaries() || state.summaryStamp !== before || fixedOff)) await writeState(state);
  } catch (e) {
    toast("ブラウザの保存領域が使えません。データは再読み込みで消えます。");
  }
}
// デモ表示中は実データと混ざらないよう、保存（IndexedDB）には書き込まない
let demoMode = false;
// 地域を絞ってレポートを作っている間（withRegions）は保存しない（絞った状態を保存しないように）。元に戻してから保存する
let scopedView = 0, saveAfterScope = false;
// 同じアプリを開いているほかのタブに「保存した」と知らせる（受け取ったタブは読み直す。下の stateChannel.onmessage）
const stateChannel = "BroadcastChannel" in window ? new BroadcastChannel("geppou-state") : null;
async function saveState() {
  if (scopedView) { saveAfterScope = true; return; }
  clearCaches();
  if (demoMode) return;
  savePref("lastChange", Date.now());
  try { await writeState(state); if (stateChannel) stateChannel.postMessage({ t: "saved" }); } catch (e) { toast("保存に失敗しました: " + e.message); }
  if (typeof scheduleAutoBackup === "function") scheduleAutoBackup();
}

// ======================================================================= データ参照

const months = () => [...new Set([...Object.values(state.reports).map((r) => r.month), ...Object.keys(state.rosters).map((k) => String(k).slice(0, 7))])].sort();
// 月ごとの月報の一覧（地域・50音順）。月報が変わると作り直す（clearCaches、または state.reports が入れ替わったとき）
let REP_INDEX = null;
function reportIndex() {
  // 入れ替わった・件数が変わったときは作り直す（月報の追加・削除が clearCaches を通らなくても古い一覧を使わないように）
  const n = Object.keys(state.reports).length;
  if (REP_INDEX && REP_INDEX.src === state.reports && REP_INDEX.n === n) return REP_INDEX;
  dropNameFragments();
  const all = Object.values(state.reports).sort((a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region) || jaCmp(a.post, b.post));
  const byMonth = new Map();
  for (const r of all) { if (!byMonth.has(r.month)) byMonth.set(r.month, []); byMonth.get(r.month).push(r); }
  return (REP_INDEX = { src: state.reports, n, all, byMonth });
}
const reportsOf = (m) => { const ix = reportIndex(); return (m ? ix.byMonth.get(m) || [] : ix.all).slice(); };
const getReport = (m, p) => state.reports[`${m}|${p}`];

function diseasesOf(m) {
  const key = m || "*";
  if (DIS_CACHE[key]) return DIS_CACHE[key];
  const out = (DIS_CACHE[key] = []);
  for (const r of reportsOf(m))
    for (const d of r.diseases || []) out.push({ month: r.month, post: r.post, region: r.region, name: d.name, count: d.count, category: classify(d.name, d.cat) });
  return out;
}
function eventsOf(m) {
  const out = [];
  for (const r of reportsOf(m)) for (const e of r.events || []) out.push({ ...e, post: r.post, month: r.month });
  return out;
}
const junkaiOf = (m) => (m ? state.junkai[m] || [] : Object.entries(state.junkai).flatMap(([mm, js]) => js.map((j) => ({ ...j, month: mm }))));

// 配置表の保存のしかた：「YYYY-MM」（月の初めから）または「YYYY-MM-DD」（月の途中で更新したときは日付で。同じ月に複数でもよい）
const rosterKeyMonth = (k) => String(k).slice(0, 7);
const rosterKeySort = (k) => (String(k).length === 7 ? k + "-00" : String(k));
const rosterKeys = () => Object.keys(state.rosters || {}).sort((a, b) => rosterKeySort(a).localeCompare(rosterKeySort(b)));
const fmtRosterKey = (k) => (String(k).length >= 10 ? `${fmtMonth(rosterKeyMonth(k))}${Number(String(k).slice(8, 10))}日` : fmtMonth(k));
// その月に使う配置表：その月までに保存した配置表のうち最も新しいもの（月の途中で更新していれば、その月の最後の日付のもの）
function rosterFor(m) {
  const ks = rosterKeys();
  if (!ks.length) return null;
  const le = ks.filter((k) => rosterKeyMonth(k) <= m);
  return state.rosters[le.length ? le[le.length - 1] : ks[0]];
}

function prevMonth(m) {
  let [y, mo] = m.split("-").map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}
// 月が入っていないとき（以前の書き出し記録など）は空にする
const fmtMonth = (m) => { if (!m) return ""; const [y, mo] = String(m).split("-"); return `${y}年${Number(mo)}月`; };
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const n = (v) => (v === null || v === undefined || v === "" || Number.isNaN(v) ? "―" : String(v));
// 同じ人か（空白の違い・名字だけの記載〔「大湾 喜行」と「大湾」〕も同じ人とみなす）
const SP_NORM = new Map();
const spNorm = (a) => { let v = SP_NORM.get(a); if (v === undefined) { v = nfkc(a).replace(/\s/g, ""); if (SP_NORM.size > 20000) SP_NORM.clear(); SP_NORM.set(a, v); } return v; };
const samePerson = (a, b) => {
  if (!a || !b) return false;
  const x = spNorm(a), y = spNorm(b);
  return x === y || (Math.min(x.length, y.length) >= 2 && (x.startsWith(y) || y.startsWith(x)));
};

// ======================================================================= PDF 読み込み

// 同じファイルを続けて読むとき（配置表かどうかの判定 → 月報の読み取り）は、1回目の結果を使う
// 同時に何件か読むので、ファイルごとに持つ（読み終えたら readFiles が消す）
const pagesMemo = new Map();
async function readPages(file) {
  if (pagesMemo.has(file)) return pagesMemo.get(file);
  const res = readPagesRaw(file);
  pagesMemo.set(file, res);
  try { return await res; } catch (e) { pagesMemo.delete(file); throw e; }
}
async function readPagesRaw(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4) {
    const z = await JSZip.loadAsync(buf);
    if (z.file("word/document.xml")) return ["word", await readDocx(z)];
    return ["zip", await readZip(z)];
  }
  if (/\.doc$/i.test(file.name)) throw new Error("古い形式の .doc は読めません。Wordで「.docx」形式で保存し直してください");
  return ["pdf", await readPdf(buf, file)];
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
// 何件かを同時に読むため、PDFの読み取り役（ワーカー）を複数用意して順に割り当てる
const PDF_WORKERS = [];
let pdfWorkerNext = 0;
function pdfWorker() {
  const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  if (PDF_WORKERS.length < n) PDF_WORKERS.push(new pdfjsLib.PDFWorker());
  return PDF_WORKERS[pdfWorkerNext++ % PDF_WORKERS.length];
}
// 読み取り中のPDF（ファイルごと）。時間切れ・中止のときに読み取りを打ち切るため
const PDF_TASKS = new Map();
function abortPdfRead(key) {
  const t = PDF_TASKS.get(key);
  if (!t) return;
  PDF_TASKS.delete(key);
  try { t.task.destroy(); } catch {}
  // 読み取り役が固まっていることがあるので、ほかに使っていなければ作り直す
  if (![...PDF_TASKS.values()].some((x) => x.worker === t.worker)) {
    const k = PDF_WORKERS.indexOf(t.worker);
    if (k >= 0) PDF_WORKERS.splice(k, 1);
    try { t.worker.destroy(); } catch {}
  }
}
async function openPdf(buf, key = null) {
  const worker = pdfWorker();
  const task = pdfjsLib.getDocument({ data: buf, password: IMPORT_PDF_PASSWORD, worker });
  if (key) PDF_TASKS.set(key, { task, worker });
  let triedLast = false, cancelled = false;
  task.onPassword = (update, reason) => {
    if (lastPdfPassword && !triedLast) { triedLast = true; update(lastPdfPassword); return; }
    const pw = prompt(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? "このPDFは別のパスワードが付いています（いつものパスワードでは開けませんでした）。パスワードを入力してください" : "このPDFのパスワードを入力してください", "");
    if (pw === null) { cancelled = true; task.destroy(); return; }
    lastPdfPassword = pw;
    update(pw);
  };
  try {
    return await task.promise;
  } catch (e) {
    if (key && PDF_TASKS.get(key)?.task === task) PDF_TASKS.delete(key);
    if (cancelled || (e && e.name === "PasswordException")) throw new Error("パスワード付きのPDFを開けませんでした（パスワードが違います）");
    throw e;
  }
}
// 確認の表で詳細を開いたときに、文字のないページの画像を作る → [[ページ, Blob]]
// OCRの前に、スキャンの網かけ（灰色の地・細かい点）を消して白黒にする：少しぼかしてから、明るさで白と黒に分ける
function ocrCleanCanvas(c) {
  const t = document.createElement("canvas"); t.width = c.width; t.height = c.height;
  const x = t.getContext("2d"); x.filter = "blur(1.2px)"; x.drawImage(c, 0, 0); x.filter = "none";
  const id = x.getImageData(0, 0, t.width, t.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const g = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2], v = g < 150 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; }
  c.getContext("2d").putImageData(id, 0, 0);
}
async function pdfPageImages(file, nums, scale = 1.4, clean = false) {
  const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
  const out = [];
  try {
    for (const i of nums) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = vp.width; c.height = vp.height;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);   // 背景を白に（透明のままだとOCRで黒く見える）
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (clean) ocrCleanCanvas(c);
      out.push([i, await new Promise((ok) => c.toBlob(ok, clean ? "image/png" : "image/jpeg", 0.85))]);
      c.width = c.height = 0;
      page.cleanup();
    }
  } finally { doc.destroy(); }
  return out;
}
async function readPdf(buf, key = null) {
  const doc = await openPdf(buf, key);
  const out = [];
  // 読み終えたら PDF を閉じてメモリを返す（大量に読むときに閉じないとブラウザのメモリが尽きる）
  try {
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = "", lastY = null;
    // Access などで作ったPDFは、文字が見た目と違う順番で入っている（上に戻る・右から入る）。
    // そういうページは、見た目の位置（上から下・左から右）で並べ直す
    let items = tc.items.filter((it) => it.str !== undefined);
    // 上に大きく戻る（あとから値だけをまとめて書き込んだ）ページ、または上に戻ることの多いページ
    let ups = 0, bigUp = 0;
    for (let k = 1; k < items.length; k++) { const dy = items[k].transform[5] - items[k - 1].transform[5]; if (dy > 2) ups++; if (dy > 60) bigUp++; }
    const isKou = items.some((it) => /受診者数等調査票|受診者数/.test(it.str)) && !items.some((it) => /疾病分類件数表/.test(it.str));
    if (isKou && items.length > 10 && (ups > items.length * 0.15 || bigUp >= 1)) {
      const rows = [];
      for (const it of items.slice().sort((a, b) => b.transform[5] - a.transform[5])) {
        const y = it.transform[5], h = Math.max(4, Math.abs(it.transform[3]) || it.height || 8);
        const row = rows.find((r) => Math.abs(r.y - y) <= h * 0.45);
        if (row) row.items.push(it); else rows.push({ y, items: [it] });
      }
      items = rows.sort((a, b) => b.y - a.y).flatMap((r) => r.items.sort((a, b) => a.transform[4] - b.transform[4]).map((it) => ({ ...it, transform: [...it.transform.slice(0, 5), r.y] })));
    }
    for (const it of items) {
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) text += "\n";
      else if (text && !text.endsWith("\n")) text += " ";
      text += it.str;
      lastY = y;
    }
    // 文字のないページ。文字がごく少ないページ（ページ番号・見出しだけが文字で、本文は画像・図形）も、
    // 画像や多くの図形が描かれていれば「文字のないページ」として扱う（「特記なし」だけの短いページは文字のあるページのまま）
    const nChars = text.replace(/\s/g, "").length;
    let needs = nChars === 0, image = null, outline = false;
    if (nChars < 20) {
      // 画像（スキャン）か、文字が図形（アウトライン）に変換されたものか（一太郎などの「文字をアウトライン化」）を見分ける
      try {
        const ops = (await page.getOperatorList()).fnArray, O = pdfjsLib.OPS;
        const paths = ops.filter((f) => f === O.constructPath).length;
        const imgs = ops.filter((f) => f === O.paintImageXObject || f === O.paintInlineImageXObject || f === O.paintJpegXObject).length;
        outline = !imgs && paths > 100;
        if (imgs || paths > 100) needs = true;
      } catch (e) { /* 見分けられなくても、文字がまったくなければ画像は出す */ }
    }
    // ページの画像は、ここでは作らない（時間がかかるため）。確認の表で詳細を開いたときに pdfPageImages で作る
    if (needs) image = "lazy";
    page.cleanup();
    out.push({ num: i, text, needs, image, outline });
  }
  } finally { if (key && PDF_TASKS.get(key)?.task === doc.loadingTask) PDF_TASKS.delete(key); doc.destroy(); }
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
    // 「2025011」（年4桁＋月3桁）＝2025年11月、「2025012」＝2025年12月
    if ((m = t.match(/(?<!\d)(20\d{2})0(0[1-9]|1[0-2])(?!\d)/)) && (r = ok(+m[1], +m[2]))) return r;
  }
  return null;
}
// 手で入れた年月を「YYYY-MM」に：202511・2025011・2025/11・2025-11・2025.11・2025年11月・R7.11・令和7年11月
function parseMonthInput(v) {
  const t = nfkc(String(v || "")).replace(/\s/g, "").replace(/(\d)年$/, "$1");   // 「202511年」も受ける
  if (!t) return "";
  const ok = (y, m) => (m >= 1 && m <= 12 && y >= 2000 && y <= 2099 ? `${y}-${String(m).padStart(2, "0")}` : null);
  let m;
  if ((m = t.match(/^(20\d{2})(?:年|[-/._])?(\d{1,2})月?分?$/))) return ok(+m[1], +m[2]);
  if ((m = t.match(/^(20\d{2})0(\d{2})$/))) return ok(+m[1], +m[2]);
  if ((m = t.match(/^(?:令和|R)(元|\d{1,2})(?:年|[-/._])(\d{1,2})月?分?$/i))) return ok((m[1] === "元" ? 1 : +m[1]) + 2018, +m[2]);
  return null;
}
// 人数の欄：全角の数字（１２）で入れても半角（12）に直す。数字以外は消す（日本語入力の変換中は待つ）
const fixNumInput = (inp) => { const v = nfkc(inp.value).replace(/[^\d]/g, ""); if (v !== inp.value) inp.value = v; };
document.addEventListener("input", (e) => { if (e.target.matches && e.target.matches("input.numin") && !e.isComposing) fixNumInput(e.target); }, true);
document.addEventListener("compositionend", (e) => {
  if (!(e.target.matches && e.target.matches("input.numin"))) return;
  fixNumInput(e.target);
  e.target.dispatchEvent(new Event("input", { bubbles: true }));   // 計の自動計算をやり直す
}, true);
// 年月の入力欄（数字だけで入れられる。欄を離れると「2025年11月」の形に直す）。値は data-ym に「YYYY-MM」で持つ
const monthField = (ym, attrs = "") => `<input type="text" class="monthin${ym ? "" : " need"}" inputmode="numeric" placeholder="例：202511" size="11" value="${esc(ym ? fmtMonth(ym) : "")}" data-ym="${esc(ym || "")}" ${attrs}>`;
document.addEventListener("change", (e) => {
  const inp = e.target.closest && e.target.closest("input.monthin");
  if (!inp) return;
  const ym = parseMonthInput(inp.value);
  if (ym === null) { inp.classList.add("need"); inp.dataset.ym = ""; toast("年月を読み取れません。「202511」や「2025年11月」の形で入れてください"); return; }
  inp.dataset.ym = ym;
  inp.value = ym ? fmtMonth(ym) : "";
  inp.classList.toggle("need", !ym);
  inp.dispatchEvent(new CustomEvent("monthset", { bubbles: true }));
}, true);
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
  m = nfkc(filename).match(/(20\d{2})[-_年]?(0[1-9]|1[0-2])(?!\d)/) || nfkc(filename).match(/(?<!\d)(20\d{2})0(0[1-9]|1[0-2])(?!\d)/);
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
        // 見出し・日付の行と、数字だけの行は飛ばす（「望月」のように名前に「月」「年」が入る人がいるので、日付は数字つきの形で見る）
        if (cand && !/受診者数|調査票|駐在公館|\d\s*年|\d\s*月|年\s*月分/.test(cand) && /[一-龯々〆ヵヶぁ-ゖァ-ヺ]/.test(cand) && !/^[\d\s.,]+$/.test(cand)) { officer = cand.replace(/医務官\s*$/, "").trim(); break; }
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

// 病名の後ろ半分だけの切れ端（単独では病名にならないもの）
const NAME_FRAGMENT = /^(血症|症|炎|病|症候群|障害|感染症|疾患|性|痛)$/;
// 表の折り返しで病名の途中から始まったもの（「の皮膚炎」「に分類されないもの」「格及び行動の障害」「…>検査」など）も切れ端
const NAME_PIECE = /^(いもの$|の(?!う<)|を|に|は|が|で|と|び(?!まん)|る|及び|又は|並びに|他に分類されないもの$|学的に|的又は|格及び|するその他|挫及び|所感染|染症|類され|障害,他|炎及び関連|路のその他|嚢>胞|<嚢>胞|TOO-)|^[^<]*>検査|^(その)?他の障害$/;
const isNameFragment = (name) => { const t = nfkc(String(name || "")).replace(/\s/g, ""); return !t || NAME_FRAGMENT.test(t) || NAME_PIECE.test(t); };
// 乙表の病名の前後に付いたごみ（表の罫線「|」、ICDコード「L00-」「EO0」、行頭の記号・番号、表の注記や分類の見出し）を取り除く
const NAME_FIX = [[/^(?:経過観察)?<?フォローアップ>検査$|^ローアップ>検査$|^察<フォローアップ>検査$/, "治療後の経過観察<フォローアップ>検査"], [/^ク?リーニング検査$/, "特殊スクリーニング検査"]];
const CLEAN_NAME_CACHE = new Map();
function cleanDiseaseName(name) {
  let c = CLEAN_NAME_CACHE.get(name);
  if (c === undefined) { c = cleanDiseaseNameRaw(name); CLEAN_NAME_CACHE.set(name, c); }
  return c;
}
function cleanDiseaseNameRaw(name) {
  let t = nfkc(String(name || "")).trim();
  for (const [re, to] of NAME_FIX) if (re.test(t.replace(/^[|_.'『/>\s]+/, ""))) return to;
  // 分類の見出し（表の行の見出し）が混じったもの：見出しより前はごみなので見出しごと取る。見出しの2行目（「常検査所見で…」）はそこだけ取る
  t = t.replace(/^.*?延べ件数、?乙/, "").replace(/^.*?翌月\d*日/, "").replace(/^全集計用/, "")
    .replace(/^.*?症状,[徴微]候及び異常了?臨床所見・異(?:常検査所見)?/, "").replace(/^.*?損傷,中毒及びその他の外因の影響?/, "")
    .replace(/常検査所見で他に分類されないも/g, "");
  // 罫線「|」で切れたもの：記号・コードだけの切れ端は捨て、病名の途中で切れたものはつなぐ
  if (t.includes("|")) t = t.split("|").filter((x) => !/^[\x00-\x7f]*$/.test(x) && !/[.=…]{2,}/.test(x)).join("");
  t = t.replace(/^[|_.'『/>・\s]+/, "")
    .replace(/^[A-Z][0-9OoIl]{1,2}[0-9OoIl]?(?:[-~][A-Z]?[0-9OoIl]{0,3})?-?(?=[\u3040-\u30ff\u4e00-\u9fff])/, "")
    .replace(/^[A-Z](?=[\u3040-\u30ff\u4e00-\u9fff])(?!型)/, "")
    .replace(/^\d+(?=[\u3040-\u30ff\u4e00-\u9fff])(?!型)/, "")
    .replace(/^[|_.'『/>・\s]+|[|_\s]+$/g, "");
  return t;
}
const FRAG_HEAD = /^(血症|症|炎|病|症候群|障害|感染症|疾患)/;
const hasChapter = (t) => (D.chapters || []).some(([k]) => t.includes(k));
// 病名だけの語（数字・ICDコード・分類の見出しを含まない日本語）
const plainNameTok = (t) => !/^\d+$/.test(t) && !/^[A-Z]\d{2}/.test(t) && !hasChapter(t) && /[\u3040-\u30ff\u4e00-\u9fff]/.test(t);
// 分類の見出し・ICDコードの後ろにくっついた病名の前半（「内分泌,栄養及び代謝疾患高尿酸」→「高尿酸」、「E79高尿酸」→「高尿酸」）。なければ空
function namePrefixOf(t) {
  let x = t;
  const ch = D.chapters || [];
  const full = ch.map(([, f]) => nfkc(f)).find((f) => x.includes(f)), key = full ? null : ch.map(([k]) => k).find((k) => x.includes(k));
  if (full) x = x.slice(x.lastIndexOf(full) + full.length);
  else if (key) return "";   // 見出しの一部しか分からないときは、どこからが病名か決められない
  x = x.replace(/^[\s()（）\[\]A-Z0-9.\-~〜、,]+/, "");
  return x !== t && /^[\u3040-\u30ff\u4e00-\u9fff]/.test(x) ? x : "";
}
const NOISE = [/^[\d\s]+$/, /^\(.*年.*月分\)$/, /^報告者/, /^\d{4}\s*\d{1,2}$/, /毎月分を翌月/, /甲表は延べ件数/, /^疾病分類件数表$/, /^在.+(大使館|総領事館)/];
function parseOtsu(pageTexts) {
  const pairs = [];
  // 表のどの分類の欄に書かれていたか（見出しの「J00-J99 呼吸器系の疾患」など）を覚えておき、病名の分類の手がかりにする
  let hint = null;
  for (const page of pageTexts) {
    const kept = nfkc(page).split("\n").map((s) => s.trim()).filter((s) => s && !NOISE.some((re) => re.test(s)));
    const joined = kept.join(" ");
    // OCRで表の列順が崩れても拾えるよう、内訳欄の「病名(件数)」だけを抜き出す
    for (const m of joined.matchAll(/([^()\d][^()]*?)\((\d+)\)/g)) {
      const toks = m[1].split(/\s+/).filter(Boolean);
      let cut = 0;
      toks.forEach((tok, i) => {
        if (/^\d+$/.test(tok) || /^[A-Z]\d{2}(\.\d+)?([-~][A-Z]?\d{2})?$/.test(tok) || /[A-Z]\d{2}.*[A-Z]\d{2}/.test(tok) || (D.chapters || []).some(([k]) => tok.includes(k)) || tok.includes("感染症及び寄生虫症")) cut = i + 1;
      });
      // 先頭にくっついたICDコード（「E79高尿酸」）は外す
      let name = toks.slice(cut).join("").replace(/^[、,，;；:：]+|[、,，;；:：]+$/g, "").replace(/^[A-Z]\d{2}(?:\.\d+)?(?=[\u3040-\u30ff\u4e00-\u9fff])/, "");
      // 表の病名の欄が2行に折り返して、後ろ半分（「血症」など）だけが残ったときは、前半とつなぐ：
      // 「高尿酸 2 血症(2)」（あいだに件数の数字）、「内分泌,栄養及び代謝疾患高尿酸 血症(9)」（分類の見出しに前半がくっつく）、「E79高尿酸 血症(9)」（コードにくっつく）
      if (cut >= 1 && FRAG_HEAD.test(name)) {
        let pre = namePrefixOf(toks[cut - 1]);
        if (!pre && cut >= 2 && /^\d+$/.test(toks[cut - 1])) pre = plainNameTok(toks[cut - 2]) ? toks[cut - 2] : namePrefixOf(toks[cut - 2]);
        if (pre) name = pre + name;
      }
      name = cleanDiseaseName(name);
      if (isNameFragment(name)) continue;
      const c = Number(m[2]);
      // 病名の前の部分に分類の見出しがあれば、この行からはその分類（病名の直前に個別のICDコードがあれば、それを優先）
      const head = toks.slice(0, cut).join(" ");
      const own = head.match(/(?:^|\s)([A-Z]\d{2})(?:\.\d+)?$/);
      const h = head ? chapterHint(head) : null;
      if (h && !own) hint = h;
      const cat = (own && codeCategory(own[1])) || hint;
      if (name.length >= 2 && c <= 500) pairs.push(cat ? { name, count: c, cat } : { name, count: c });
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
  // 同じ月報は結果を覚えておく（丙表の病名探しは重いため）
  let v = OUTB_CACHE.get(r);
  if (!v) { v = reportOutbreaksRaw(r); OUTB_CACHE.set(r, v); }
  return v;
}
function reportOutbreaksRaw(r) {
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
  return (OB_CACHE[m || "*"] ||= reportsOf(m).flatMap(reportOutbreaks));
}

// 新着アラート: 前月と比べて「丙表に新しく出てきた病気」と「乙表で急に増えた病気」
// 前月の月報がある公館だけを比べる（初めて出した公館で全部が新着にならないように）
function groupCounts(r) {
  const c = {};
  for (const d of r.diseases || []) if (classify(d.name, d.cat) !== Z) c[groupOf(d.name)] = (c[groupOf(d.name)] || 0) + d.count;
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

// 「11/3〜11/7」「11/3-7」の書き方も
const PERIOD_SLASH = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\s*\([^)]\))?\s*(?:[~〜～\-－ー]|から)\s*(?:(\d{1,2})\/)?(\d{1,2})(?![\d/])/;
const PERIOD = /(\d{1,2})月\s*(\d{1,2})日(?:\s*\([^)]\))?\s*(?:[~〜～\-－ー]|から)\s*(?:(\d{1,2})月\s*)?(\d{1,2})日/;
// 実際に行った（行う）巡回の文か。「在外公館を巡回する医師がいる」のような一般の話は除く
const JUNKAI_RE = /巡回(健診|検診|診療|相談|指導)|巡回(を(実施|行)|し(た|、|て)|に(出|行|赴)|から(の)?帰|中)|(大|総|館)巡回|臨時巡回|定期巡回/;
function detectJunkai(heiText, own) {
  const out = [];
  // 丙表に「(4) 巡回健診」の項があれば、その項だけから拾う（項の中は「巡回」の語がない文も、行き先か期間があれば巡回として読む）
  const sec = (heiCaseSections(heiText) || []).filter((x) => x.kind === "junkai");
  const inSec = sec.length > 0;
  for (const s of sentences(inSec ? sec.map((x) => x.body).join("\n") : heiText)) {
    if (inSec ? /^(なし|無し|該当なし|特になし|特記事項なし)|実施(しなかった|せず|なし)|予定(なし|はない)/.test(s) : !JUNKAI_RE.test(s)) continue;
    if (/巡回する医師|巡回医/.test(s)) continue;
    const places = findInText(s).filter((p) => p !== own);
    const m = s.match(PERIOD) || s.match(PERIOD_SLASH);
    const period = m ? `${m[1]}/${m[2]}〜${m[3] || m[1]}/${m[4]}` : "";
    const incoming = /(による|が来訪|を受け|来館)/.test(s);
    if (!places.length && period) out.push({ from: own, dest: "", period, note: s.slice(0, 160), src: own });
    for (const p of places) {
      if (incoming && INFO[p] && INFO[p].isPost) out.push({ from: p, dest: own, period, note: s.slice(0, 160), src: own });
      else out.push({ from: own, dest: p, period, note: s.slice(0, 160), src: own });
    }
  }
  // 同じ巡回（実施公館と巡回先が同じ）を何度も書いているときは1件にまとめる（期間の分かる記載を残す）
  const merged = [];
  for (const j of out) {
    const same = merged.find((x) => x.from === j.from && x.dest === j.dest && (x.dest || x.period === j.period));
    if (!same) { merged.push(j); continue; }
    if (!same.period && j.period) { same.period = j.period; same.note = j.note; }
  }
  return merged;
}

// ----------------------------------------------------------------------- 緊急移送・邦人対応の事例
// 丙表の文から事例を拾う。どちらも画面の表で直せる（直した月は state.cases に保存）
// 緊急移送：「緊急移送」などの言葉があるか、移送・搬送した先の国（日本を含む）が書かれている文だけ。「該当なし」「移送が必要な場合は」などは除く
const EVAC_RE = /緊急移送|医療搬送|患者移送|航空搬送|エア・?アンビュランス|医療専用機|メディバック|medevac|(移送|搬送)(した|された|し、|され、|を行|を実施|となった|する予定|される予定)|へ(移送|搬送)/i;
const EVAC_STRONG = /緊急移送|医療搬送|患者移送|航空搬送|エア・?アンビュランス|医療専用機|メディバック|medevac/i;
const EVAC_NOT = /(移送|搬送)[^。]{0,12}(不要|なし|無し|行わ|しなかった|なかった|ありません)|(該当|事例|案件|関与|特記事項|特記)[^。]{0,8}(なし|無し|なかった|ない|ありません)/;
const EVAC_GENERIC = /場合|際は|際には|可能|体制|保険|手配でき|必要な(とき|時)|1日に|ハイシーズン|ことがある|件数|統計/;
// 邦人対応：邦人（日本人・出張者・留学生）の、実際の事例の文だけ。「邦人保護 なし」「被害は報告されていない」「邦人が利用する病院」などは除く
const HOGO_RE = /邦人|日本人|出張者|留学生|(旅行者|観光客)[^。]{0,6}(案件|事案)/;
const HOGO_STRONG = /入院|死亡|亡くな|死去|逝去|搬送|移送|事故|事件|負傷|けが|怪我|拘束|逮捕|盗難|強盗|襲われ|ナイフ|面会|手術|発症|罹患し|産気|緊急着陸|体調不良|行方不明|意識障害|発見され|邦人保護[:：]?\s*\d+件|案件は継続/;
const HOGO_ACT = /フォロー(し|中)|受診し|診察し|治療し|相談[^。]{0,8}(あり|あっ|受け|対応)|対応し|対応され|面談|被害に|感染し/;
const HOGO_NOT = /(報告|事例|案件|該当|特記事項|特記|関与)[^。]{0,8}(なし|無し|ない|なかった|ありません|されていない)|邦人保護[^。]{0,8}(なし|無し|特記)|被害[^。]{0,8}(ない|なかった|されていない)|(感染|罹患)[^。]{0,12}(なかった|ていない)/;
const HOGO_GENERIC = /場合|際は|際には|ように|向け|周知|注意喚起|情報提供|推奨|おすすめ|勧め|利用(する|でき|可能)|受診(する|できる|可能)|可能性|多く訪れ|増え|ツーリズム|誘致|予定|必要に|べき|努め|報告する|について報告/;
const isEvacSentence = (s, post) => EVAC_RE.test(s) && !EVAC_NOT.test(s) && (EVAC_STRONG.test(s) ? !EVAC_GENERIC.test(s) || /(へ|に)(緊急)?(移送|搬送)し/.test(s) : (/本邦|日本へ|日本に|帰国させ/.test(s) || findInText(s).some((p) => p !== post)) && !EVAC_GENERIC.test(s));
const isHogoSentence = (s) => HOGO_RE.test(s) && !HOGO_NOT.test(s) && (HOGO_STRONG.test(s) || (HOGO_ACT.test(s) && !HOGO_GENERIC.test(s)));
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

// 「入院し、…へ移送した。手術を受け回復した。」のように、入院の後の経過が次の文にあればそちらを転帰にする
function outcomeOf(s, next) {
  const cur = firstRule(OUTCOME_RULES, s), nxt = firstRule(OUTCOME_RULES, next);
  return cur && cur !== "入院中" ? cur : nxt || cur;
}
// 移送先が総領事館などの公館名で当たったとき（「マイアミへ移送」→ マイアミ総領事館）は、その国の名前にする
const POST_OFFICE_RE = /総領事館|領事事務所|駐在官事務所|政府代表部|代表部$/;
function destCountry(name) {
  if (!name || !POST_OFFICE_RE.test(name) || !INFO[name]) return name;
  const iso = INFO[name].iso3;
  return Object.keys(INFO).find((n) => INFO[n].iso3 === iso && !POST_OFFICE_RE.test(n)) || name;
}
function caseFromSentence(s, post, type, next = "") {
  const conds = [];
  for (const w of COND_WORDS) if (s.includes(w) && !conds.some((c) => c.includes(w))) conds.push(w);
  for (const d of heiDiseases(s)) { const g = groupOf(d.name); if (!conds.some((c) => c.includes(g) || g.includes(c) || groupOf(c) === g)) conds.push(g); }
  let dest = "";
  if (type === "evac") {
    if (/本邦|日本へ|日本に|帰国させ/.test(s)) dest = "日本";
    else dest = destCountry(findInText(s).filter((p) => p !== post)[0] || "");
  }
  return {
    type, post, who: firstRule(WHO_RULES, s), cond: conds.slice(0, 3).join("・"), dest,
    // 転帰は次の文に書かれることが多い（「…へ緊急移送した。手術を受け回復した。」）
    means: type === "evac" ? firstRule(MEANS_RULES, s) : "", outcome: outcomeOf(s, next),
    kind: type === "hogo" ? firstRule(KIND_RULES, s, "その他") : "", note: s.slice(0, 200), src: post,
    // PDFに載せる丙表の記載：その文に、転帰が書かれた次の文も続ける
    detail: (s + (next && firstRule(OUTCOME_RULES, next) ? next : "")).slice(0, 400),
  };
}
// 丙表を段落に分ける（空行、または「・」「(1)」「【」などで始まる行・全角空白で字下げした行から新しい段落）。
// 各段落の文は sentences() と同じ切り方なので、文の並びは sentences(全文) と変わらない
const PARA_HEAD = /^\s*(?:[・●○■□◆◇【]|[(（]?\d{1,2}[)）.．、](?!\d)|[ア-ン][.．、)）]|　)/;
function heiParagraphs(text) {
  const paras = [];
  let cur = [];
  const flush = () => { if (cur.length) paras.push(cur.join("\n")); cur = []; };
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) { flush(); continue; }
    if (PARA_HEAD.test(line) && cur.length) flush();
    cur.push(line);
  }
  flush();
  return paras.map((raw) => {
    // 表示用：折り返しの改行をつなぎ、先頭の記号は取る（英数字どうしの間だけ空白を残す）
    const text = nfkc(raw).replace(/[ \t]+/g, " ").split("\n").map((l) => l.trim()).filter(Boolean)
      .reduce((a, l) => a + (a && /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(l) ? " " : "") + l, "")
      .replace(/^(?:[・●○■□◆◇\-*]|[(（]?\d{1,2}[)）.．、](?!\d))\s*/, "");
    return { ss: sentences(raw), text };
  });
}
// 丙表の「(3) 緊急移送」「(4) 邦人保護」の項だけを抜き出す（見出しの次の行から、次の「(5)」「5.」「【」などの見出しの前まで）。
// 見出しが見つからない様式では null（そのときは丙表全体から拾う）
const SEC_HEAD = /^\s*(?:[(（]\s*\d{1,2}\s*[)）]|\d{1,2}\s*[.．、)）](?!\d)|[【〔［\[]|第\d{1,2})/;
const CASE_SEC = /^\s*(?:[(（]\s*\d{1,2}\s*[)）]|\d{1,2}\s*[.．、)）]?(?!\d)|[【〔［\[])?\s*(緊急移送|患者移送|医療搬送|邦人保護|邦人援護|巡回健診|巡回診療)[】〕］\]）)]?\s*(?:[:：]\s*)?(.*)$/;
function heiCaseSections(text) {
  const lines = nfkc(String(text || "")).split("\n"), secs = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(CASE_SEC);
    // 見出しは短い行だけ（「緊急移送した。」で始まる本文の行を見出しと取り違えない）
    if (m && (SEC_HEAD.test(line) || line.trim().length <= 12 || /^\s*(緊急移送|邦人保護|邦人援護|巡回健診|巡回診療)\s*[:：]/.test(line))) {
      // 項の終わり：「(3)」で始まったら次の「(n)」か上の階層（「4.」「【」）、「3.」で始まったら次の「n.」か「【」（中の「(1)」「①」「・」は項の中の箇条書き）
      const style = /^\s*[(（]/.test(line) ? "paren" : /^\s*\d/.test(line) ? "dot" : "any";
      cur = { kind: /邦人/.test(m[1]) ? "hogo" : /巡回/.test(m[1]) ? "junkai" : "evac", style, lines: m[2] ? [m[2]] : [] }; secs.push(cur); continue;
    }
    if (cur && SEC_HEAD.test(line) && (cur.style === "any" || cur.style === "paren" || !/^\s*[(（]/.test(line))) { cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  return secs.length ? secs.map((x) => ({ kind: x.kind, body: x.lines.join("\n").trim() })).filter((x) => x.body) : null;
}
// 同じ月・同じ公館で丙表の記載（項の文章）が同じ症例が続くときは、PDFの「丙表：」の行は最後の1件の下にだけ出す
function sameHei(a, b) { return !!(a && b && a.month === b.month && a.post === b.post && (a.detail || a.note) && (a.detail || a.note) === (b.detail || b.note)); }
function detectCases(heiText, post) {
  const out = [];
  const ss = [], paraOf = [];
  const secs = (heiCaseSections(heiText) || []).filter((x) => x.kind !== "junkai");
  if (secs.length) {
    // 項ごと：記載はその項の文章をまるごと
    for (const sec of secs) {
      const text = heiParagraphs(sec.body).map((p) => p.text).join("\n");
      for (const s of sentences(sec.body)) { ss.push(s); paraOf.push(text); }
    }
  } else for (const p of heiParagraphs(heiText)) for (const s of p.ss) { ss.push(s); paraOf.push(p.text); }
  let last = { evac: -9, hogo: -9 };
  ss.forEach((s, i) => {
    // 次の文が別の事例（移送・邦人の話）なら転帰の参考にしない
    const next = ss[i + 1] && !isEvacSentence(ss[i + 1], post) && !isHogoSentence(ss[i + 1]) ? ss[i + 1] : "";
    for (const [type, hit] of [["evac", isEvacSentence(s, post)], ["hogo", isHogoSentence(s)]]) {
      if (!hit) continue;
      const c = caseFromSentence(s, post, type, next);
      // 丙表の記載はその文を含む段落をすべて載せる（極端に長いときだけ2000字で切る）
      if (paraOf[i].length > c.detail.length) c.detail = paraOf[i].slice(0, 2000);
      // 続けて書かれた同じ事例（前の文の続き）は1件にまとめ、分からなかった項目を補う
      const prev = out.length && last[type] === i - 1 ? [...out].reverse().find((x) => x.type === type) : null;
      if (prev && (!c.dest || !prev.dest || c.dest === prev.dest)) {
        for (const k of ["who", "cond", "dest", "means", "outcome"]) if (!prev[k] && c[k]) prev[k] = c[k];
        if (type === "hogo" && prev.kind === "その他" && c.kind !== "その他") prev.kind = c.kind;
        prev.note = (prev.note + " " + s).slice(0, 300);
        if (!prev.detail.includes(s)) prev.detail = (prev.detail + " " + (paraOf[i].length > s.length ? paraOf[i] : s)).slice(0, 4000);
      } else out.push(c);
      last[type] = i;
    }
  });
  // 同じ移送（行き先と病名が同じ）を別の段落で書き直しているときも1件に
  return out.filter((c, k) => c.type !== "evac" || !c.dest || !out.slice(0, k).some((x) => x.type === "evac" && x.dest === c.dest && (!c.cond || !x.cond || x.cond === c.cond)));
}
// 丙表から拾った事例のキャッシュ（データが変わったら clearCaches() で捨てる）
// 計算の結果を覚えておく（データが変わったら saveState → clearCaches() で捨てる）。AI分析で対象を変えるたびの再計算を速くする
let CASE_CACHE = {}, ALERT_CACHE = {}, DIS_CACHE = {}, OB_CACHE = {}, OUTB_CACHE = new WeakMap(), CLASS_CACHE = new Map();
// 病名の切れ端（「血症」だけなど。表の折り返しで病名の後ろ半分だけが読めたもの）は病名として扱わない（以前に保存した月報も）
const NAMES_CHECKED = new WeakSet();
function dropNameFragments() {
  // 以前に保存した病名も、ごみを取り除いてから切れ端を外す（同じ病名になったものは件数を合わせる）
  for (const r of Object.values(state.reports)) {
    if (NAMES_CHECKED.has(r)) continue;   // 一度確かめた月報は確かめ直さない（保存のたびに全件を見ると、件数が多いとき遅い）
    NAMES_CHECKED.add(r);
    const ds = r.diseases || [];
    if (!ds.some((d) => cleanDiseaseName(d.name) !== d.name || isNameFragment(d.name))) continue;
    const out = [];
    for (const d of ds) {
      const name = cleanDiseaseName(d.name);
      if (isNameFragment(name)) continue;
      const same = out.find((x) => x.name === name && x.cat === d.cat);
      if (same) same.count += d.count; else out.push({ ...d, name });
    }
    r.diseases = out;
  }
  // 保存した検定・推定の結果（保存したときの表と文）からも、切れ端の病名の行・記載を除く
  for (const x of state.statNotes || []) {
    if (Array.isArray(x.rows) && x.rows.some((row) => (row || []).some((c) => isNameFragment(c)))) x.rows = x.rows.filter((row) => !(row || []).some((c) => isNameFragment(c)));
    if (Array.isArray(x.text)) x.text = x.text.map(dropFragmentText);
  }
}
// 文の中の「インドネシアの血症、」のような切れ端の病名の記載を除く
const FRAG_IN_TEXT = new RegExp(`([、：:])[^、：:。]*?の(?:${NAME_FRAGMENT.source.replace(/^\^\(|\)\$$/g, "")})(?=[、。]|$)`, "g");
const dropFragmentText = (t) => typeof t !== "string" ? t : t.replace(FRAG_IN_TEXT, "$1").replace(/([：:])、/g, "$1").replace(/、{2,}/g, "、").replace(/、(。|$)/g, "$1");
// 地域・国で絞ってレポートを作る間だけ集計の作り置きを替え、終わったら元に戻す（全部捨てると、次のタブで作り直しになり遅い）
const snapCaches = () => ({ REP_INDEX, CASE_CACHE, ALERT_CACHE, DIS_CACHE, OB_CACHE, OUTB_CACHE });
const restoreCaches = (c) => { ({ REP_INDEX, CASE_CACHE, ALERT_CACHE, DIS_CACHE, OB_CACHE, OUTB_CACHE } = c); };
function clearCaches() { dropNameFragments(); REP_INDEX = null; CASE_CACHE = {}; ALERT_CACHE = {}; DIS_CACHE = {}; OB_CACHE = {}; OUTB_CACHE = new WeakMap(); CLASS_CACHE = new Map(); }
// 新着アラートは月ごとに1回だけ計算する（15行サマリーで公館ごとに使うため）
const alertsOf = (m) => (ALERT_CACHE[m] ||= newAlerts(m));
// 画面で直した月は保存した一覧を、そうでなければ丙表から拾った一覧を返す
function casesOf(m, type) {
  const ms = m ? [m] : [...new Set(Object.values(state.reports).map((r) => r.month))].sort();
  const out = [];
  for (const mm of ms) {
    const list = (state.cases && state.cases[mm]) || (CASE_CACHE[mm] ||= reportsOf(mm).flatMap((r) => detectCases(r.hei, r.post)));
    for (const c of list) if (!type || c.type === type) out.push({ ...c, month: mm, ...(c.type === "evac" && c.dest ? { dest: destCountry(c.dest) } : {}) });
  }
  return out;
}

// 緊急移送と邦人援護の両方に当たる同じ出来事（同じ月・同じ公館で、丙表の同じ文から拾ったもの）
const sameCase = (e, h) => e.month === h.month && e.post === h.post && !!e.note && !!h.note && (e.note.includes(h.note.slice(0, 20)) || h.note.includes(e.note.slice(0, 20)));
const bothCount = (evs, hgs) => evs.filter((e) => hgs.some((h) => sameCase(e, h))).length;
const caseCell = (v) => v || "記載なし";
async function parseReport(file) {
  const [fmt, pages] = await readPages(file);
  return parseReportPages(fmt, pages, file);
}
// 読み取った各ページの文字から、月報の中身を取り出す（OCRで読み直したときもここを使う）
function parseReportPages(fmt, pages, file) {
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
  const vis = pages.filter((p) => p.needs && !p.outline).map((p) => p.num), outl = pages.filter((p) => p.needs && p.outline).map((p) => p.num);
  if (vis.length) warnings.push(`OCRテキストなし（要目視）: p.${vis.join(", ")}`);
  if (outl.length) warnings.push(`文字が図形（アウトライン）に変換されたPDFのため、文字を読み取れません（要目視）: p.${outl.join(", ")}。作成元（一太郎など）で文字をアウトライン化せずにPDFを作り直すか、元のファイル（Word・一太郎）で受け取ると読み取れます`);
  const diseases = parseOtsu(otsu);
  if (otsu.length && !diseases.length) warnings.push("乙表の病名を抽出できません");
  const hei_ = hei.join("\n").trim();
  return {
    filename: file.name, format: fmt, month: detectMonth(full, file.name), bodyMonth: monthFromText(full), post, officer: k.officer,
    staff: k.counts ? k.counts[0] : null, family: k.counts ? k.counts[1] : null,
    other: k.counts ? k.counts[2] : null, total: k.counts ? k.counts[3] : null,
    // 甲表の読み取った文字（確認の表で受診者数・医務官名などを見比べるため。保存はしない）
    kou: (kou.length ? kou.join("\n") : "").trim(),
    diseases, hei: hei_, warnings, images: pages.filter((p) => p.needs && p.image && p.image !== "lazy").map((p) => [p.num, p.image]),
    // PDFの文字のないページ：画像は詳細を開いたときに元のファイルから作る
    lazyPages: pages.filter((p) => p.needs && p.image === "lazy").map((p) => p.num), srcFile: pages.some((p) => p.needs) || !k.counts || !k.officer ? file : null,
    ocr: pages.some((p) => p.ocr),
  };
}

// ---- OCR（文字認識）：文字のない（スキャン・図形の）ページを画像にして、文字を認識してから読み直す
// Tesseract.js と日本語の学習データをアプリに同梱し、ブラウザの中だけで動かす（外部には送らない）。初めて使うときに読み込む
let ocrWorkerP = null, ocrLog = null;
const loadScriptOnce = (src) => new Promise((ok, ng) => { const el = document.createElement("script"); el.src = src; el.onload = ok; el.onerror = () => ng(new Error(src + " を読み込めません")); document.head.appendChild(el); });
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, ng) => setTimeout(() => ng(new Error(msg)), ms))]);
function ocrWorker() {
  ocrWorkerP ||= (async () => {
    if (!window.Tesseract) await loadScriptOnce("lib/tesseract/tesseract.min.js");
    // 日本語の学習データが届くかを先に確かめる（届かない・別のページが返るときは、原因が分かるように知らせる）
    const langUrl = new URL("lib/tesseract/lang/jpn.traineddata.gz", location.href).href;
    const r = await fetch(langUrl).catch((e) => { throw new Error("日本語の学習データを読み込めません（" + e.message + "）。インターネット接続か、組織のネットワークの制限を確かめてください"); });
    if (!r.ok) throw new Error(`日本語の学習データを読み込めません（${r.status}）`);
    const head = new Uint8Array(await r.clone().arrayBuffer()).slice(0, 2);
    if (!(head[0] === 0x1f && head[1] === 0x8b) && /html/i.test(r.headers.get("content-type") || "")) throw new Error("日本語の学習データの代わりに別のページが返りました（ネットワークの制限の可能性）");
    const opts = (blob) => ({
      workerPath: new URL("lib/tesseract/worker.min.js", location.href).href, corePath: new URL("lib/tesseract/", location.href).href,
      langPath: new URL("lib/tesseract/lang", location.href).href, gzip: true, workerBlobURL: blob,
      cacheMethod: "none",   // 学習データはアプリと一緒に保存済み。OCR側では保存しない（途中で壊れたものが残らないように）
      logger: (m) => ocrLog && ocrLog(m), errorHandler: (e) => console.warn("ocr", e),
    });
    // ブラウザの設定でワーカーの作り方が制限されているときは、別の作り方でもう一度
    try { return await withTimeout(Tesseract.createWorker("jpn", 1, opts(true)), 90000, "OCRの準備が90秒で終わりませんでした"); }
    catch (e) { console.warn("ocr worker (blob)", e); return await withTimeout(Tesseract.createWorker("jpn", 1, opts(false)), 90000, "OCRの準備が90秒で終わりませんでした（" + (e.message || e) + "）"); }
  })().catch((e) => { ocrWorkerP = null; throw e; });
  return ocrWorkerP;
}
// OCRの動作確認：アプリの中で見本の文字（架空）を画像にして読ませる。結果と時間を返す
async function ocrSelfTest() {
  const c = document.createElement("canvas"); c.width = 900; c.height = 260;
  const x = c.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.fillStyle = "#000";
  x.font = '48px "Yu Gothic", "Meiryo", "MS Gothic", "Hiragino Sans", "Noto Sans JP", sans-serif';
  x.fillText("受診者数　12　3　0　15", 40, 100); x.fillText("急性上気道炎(5)", 40, 190);
  const t0 = performance.now();
  const w = await ocrWorker();
  const { data } = await withTimeout(w.recognize(c), 120000, "読み取りが120秒で終わりませんでした");
  return { text: ocrClean(data.text), sec: ((performance.now() - t0) / 1000).toFixed(1) };
}
// OCRで崩れた件数の印を直す：「(D)」「(l)」「(り」→「(1)」、閉じ括弧のない「(2」→「(2)」
const JA = "[\\u3040-\\u30ff\\u4e00-\\u9fff>＞）\\]」]";
const ocrFixCounts = (t) => t
  // 丸数字（④）は数字に
  .replace(/[(（]?\s*([①-⑳])[①-⑳)）]*/g, (m, c) => `(${c.charCodeAt(0) - 0x245f})`)
  .replace(new RegExp(`(${JA})\\s*(?:い|l|I|\\|)\\s*[)）]`, "gm"), "$1(1)")
  // 中が空の「()」は 1（細い「1」は読み落とされやすい）。開き括弧の落ちた「>14)」は「>(14)」に
  .replace(new RegExp(`(${JA})\\s*[(（]\\s*[)）]`, "gm"), "$1(1)").replace(new RegExp(`(${JA})\\s*(\\d{1,2})\\s*[)）]`, "gm"), "$1($2)")
  .replace(new RegExp(`(${JA})\\s*[(（]\\s*(?:D|l|I|\\||り|J|i|い)\\s*(?:[)）]|(?=\\s|$))`, "gm"), "$1(1)").replace(new RegExp(`(${JA})\\s*[(（]\\s*(\\d{1,2})\\s*(?=$|\\n|\\s)`, "gm"), "$1($2)")
  // 病名の前に残った罫線・ICDコードの範囲（「ーー」「KO0-K93。」）を除く
  .replace(/(^|\s)り?[ー―\-_|]{2,}/gm, "$1")
  // 網かけがOCRで「間間症剖」のような文字の列になったもの、病名の前の英字の切れ端（「DD」）を除く
  .replace(/[間癌回症還本利昌誠生旧剖問語着導和]{3,}/g, " ").replace(/(^|\s)[A-Za-z”"'!|]{1,3}(?=[\u3040-\u30ff\u4e00-\u9fff])/gm, "$1").replace(/(^|\s)[(（]?[A-Z][0-9OoIl]{1,2}\s*-\s*[A-Z]?[0-9OoIl]{1,3}[)）。.]?\s*/gm, "$1");
// 日本語の文字のあいだに入る空白を詰める（数字・英字のあいだの空白は表の区切りなので残す）
const ocrClean = (t) => String(t || "").replace(/([^\x00-\x7F])[ \t]+(?=[^\x00-\x7F])/g, "$1").replace(/[ \t]+\n/g, "\n").trim();
// 甲表の「受診者数」の行を、見出し（職員・家族・その他・計）の位置で4つの欄に分け、欄ごとに数字だけで読み直す。
// 4つの数がそろい、職員＋家族＋その他＝計 になったときだけ、OCRの文のその行を置き換える
async function ocrFixVisitRow(w, img, data, t, frac = 0.3) {
  const lines = (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
  const sq = (x) => String(x || "").replace(/\s/g, "");
  let row = lines.find((l) => /受診者数/.test(sq(l.text)) && !/調査/.test(sq(l.text)));
  let band = false;
  if (!row) {
    // 表の中がOCRで読めない（罫線の多い表で文字の並びが崩れた）ときは、「駐在公館分」と「その他内訳」のあいだを表とみなし、
    // その下半分（受診者数の行）を数字だけで読む
    const a = lines.find((l) => /駐在公館|公館分/.test(sq(l.text))) || lines.find((l) => /調査票/.test(sq(l.text)));
    const b = a && (lines.find((l) => /内訳/.test(sq(l.text)) && l.bbox.y0 > a.bbox.y1) || lines.find((l) => /在留邦人|旅行者|現地職員/.test(sq(l.text)) && l.bbox.y0 > a.bbox.y1));
    if (!a || !b || b.bbox.y0 - a.bbox.y1 < 40) return t;
    const top = a.bbox.y1 + (b.bbox.y0 - a.bbox.y1) * frac, bot = b.bbox.y0 - 6;
    row = { bbox: { x0: 0, x1: (img.width || 0), y0: top + 8, y1: bot - 8 }, words: [] };
    band = true;
  }
  const words = lines.flatMap((l) => l.words || []), above = words.filter((x) => x.bbox.y1 <= row.bbox.y0 + 4 && x.bbox.y1 > row.bbox.y0 - 160);
  const cx = (re) => { const x = above.filter((v) => re.test(sq(v.text))).sort((a, b) => b.bbox.y1 - a.bbox.y1)[0]; return x ? (x.bbox.x0 + x.bbox.x1) / 2 : null; };
  const cs = [cx(/^職/), cx(/^家|族$/), cx(/その他|^他$/), cx(/^計$/)];
  const headOk = !band && !cs.some((v) => v == null) && cs[0] < cs[1] && cs[1] < cs[2] && cs[2] < cs[3];
  const y0 = row.bbox.y0 - 8, h = row.bbox.y1 - row.bbox.y0 + 16;
  const src = img instanceof HTMLCanvasElement ? img : await (async () => { const c = document.createElement("canvas"); const bm = await createImageBitmap(img); c.width = bm.width; c.height = bm.height; c.getContext("2d").drawImage(bm, 0, 0); return c; })();
  // 切り出した部分から、罫線（縦の長い線）を白く消す（数字の「1」と読まれないように）
  const crop = (a, cw) => {
    const c = document.createElement("canvas"); c.width = Math.round(cw + 40); c.height = Math.round(h + 40);
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(src, a, y0, cw, h, 20, 20, cw, h);
    const id = x.getImageData(20, 20, Math.round(cw), Math.round(h)), W = id.width, H = id.height, dk = (i) => id.data[i] + id.data[i + 1] + id.data[i + 2] < 380;
    // 縦の罫線：続けて黒い長さが、行だけを切り出したときは高さの93%以上、表の帯を切り出したときは60%以上
    const vmin = band ? H * 0.6 : H * 0.93, hmin = band ? W * 0.35 : W * 0.6;
    for (let xx = 0; xx < W; xx++) { let run = 0, best = 0, n = 0; for (let yy = 0; yy < H; yy++) { if (dk((yy * W + xx) * 4)) { run++; n++; best = Math.max(best, run); } else run = 0; }
      if ((band ? best : n) > vmin) for (let yy = 0; yy < H; yy++) { const i = (yy * W + xx) * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = 255; } }
    for (let yy = 0; yy < H; yy++) { let n = 0; for (let xx = 0; xx < W; xx++) if (dk((yy * W + xx) * 4)) n++; if (n > hmin) for (let xx = 0; xx < W; xx++) { const i = (yy * W + xx) * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = 255; } }
    x.putImageData(id, 20, 20);
    return c;
  };
  await w.setParameters({ tessedit_char_whitelist: "0123456789 " });
  let nums = [];
  try {
    if (!headOk) {
      // 見出しが読めないとき：行の見出し（受診者数）の右から行の右端までを1つにして、数字の並びを読む
      const lab = (row.words || []).filter((v) => /[受診者数]/.test(sq(v.text))).sort((a, b) => b.bbox.x1 - a.bbox.x1)[0];
      const a0 = band ? src.width * 0.12 : (lab ? lab.bbox.x1 : row.bbox.x0) + 10, a1 = band ? src.width * 0.97 : row.bbox.x1 + Math.max(30, (row.bbox.x1 - row.bbox.x0) * 0.05);
      const { data: d } = await withTimeout(w.recognize(crop(a0, a1 - a0)), 30000, "欄の読み取りが終わりませんでした");
      // 上下の行の切れ端が数字に読まれることがあるので、続く4つの数で「職員＋家族＋その他＝計」になる組を探す
      const all = (String(d.text || "").match(/\d+/g) || []).map(Number);
      for (let k = all.length - 4; k >= 0; k--) if (all[k] + all[k + 1] + all[k + 2] === all[k + 3]) { nums = all.slice(k, k + 4); break; }
    } else for (const [a, b] of cs.map((c, i) => [i ? (cs[i - 1] + c) / 2 : c - (cs[1] - cs[0]) / 2, i < 3 ? (c + cs[i + 1]) / 2 : c + (cs[3] - cs[2]) / 2])) {
      const pad = 4, cw = Math.max(10, b - a - 2 * pad);
      const { data: d } = await withTimeout(w.recognize(crop(a + pad, cw)), 30000, "欄の読み取りが終わりませんでした");
      const m = String(d.text || "").match(/\d+/g);
      nums.push(m ? Number(m.join("")) : null);
    }
  } finally { await w.setParameters({ tessedit_char_whitelist: "" }); }
  if (nums.length !== 4 || nums.some((v) => v == null) || nums[0] + nums[1] + nums[2] !== nums[3]) {
    // 表の帯で読めなかったときは、帯の上端を変えてもう一度（見出しの行の切れ端がまざると読み誤ることがある）
    if (band && frac < 0.5) return ocrFixVisitRow(w, img, data, t, frac + 0.15);
    return t;
  }
  const rowText = t.split("\n").find((l) => /受診者数/.test(sq(l)) && !/調査/.test(sq(l)));
  return rowText ? t.replace(rowText, `受診者数 ${nums.join(" ")}`) : `${t}\n受診者数 ${nums.join(" ")}`;
}
async function ocrOtsuColumn(w, img, data, t) {
  if (!/疾病分類|大分類/.test(t.replace(/\s/g, ""))) return t;
  const lines = (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
  const sq = (x) => String(x || "").replace(/\s/g, "");
  const head = lines.find((l) => /内訳|病名により/.test(sq(l.text)) && /件数|大分類|分類/.test(sq(l.text)));
  if (!head) return t;
  const wd = (head.words || []).find((x) => /内|訳|病名/.test(sq(x.text)));
  if (!wd) return t;
  const bm = await createImageBitmap(img), W = bm.width, H = bm.height;
  const x0 = Math.max(0, wd.bbox.x0 - W * 0.015), y0 = head.bbox.y1 + 4, cw = W * 0.985 - x0, ch = H * 0.97 - y0;
  if (cw < W * 0.2 || ch < H * 0.2) return t;
  const c = document.createElement("canvas"); c.width = Math.round(cw); c.height = Math.round(ch);
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(bm, x0, y0, cw, ch, 0, 0, cw, ch);
  const { data: d } = await withTimeout(w.recognize(c), 180000, "内訳の欄の読み取りが3分で終わりませんでした");
  const col = ocrClean(d.text);
  if (col.replace(/\s/g, "").length < 10) return t;
  // 表題・公館名の行（内訳の見出しより上）はそのまま残し、その下を内訳の欄の文に置き換える
  const topLines = lines.filter((l) => l.bbox.y1 <= head.bbox.y1 + 2).map((l) => ocrClean(l.text));
  return [...topLines, col].join("\n");
}
// 甲表の「在○○大使館　氏名　医務官」の行から、氏名の部分だけを切り出し、2倍に大きくして読み直す
async function ocrOfficerName(w, img, data) {
  const lines = (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
  const sq = (x) => String(x || "").replace(/\s/g, "");
  const line = lines.find((l) => /医務/.test(sq(l.text)) && /館|部|事務所/.test(sq(l.text)) && !/月報/.test(sq(l.text)));
  if (!line) return null;
  const ws = line.words || [];
  const end = ws.filter((x) => /館|部|所$/.test(sq(x.text))).sort((a, b) => a.bbox.x1 - b.bbox.x1)[0];
  const med = ws.filter((x) => /医|務|官/.test(sq(x.text)) && (!end || x.bbox.x0 > end.bbox.x1)).sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];
  if (!med) return null;
  const bm = await createImageBitmap(img);
  const x0 = end ? end.bbox.x1 + 6 : line.bbox.x0 + (line.bbox.x1 - line.bbox.x0) * 0.45, x1 = med.bbox.x0 - 4;
  const y0 = line.bbox.y0 - 8, h = line.bbox.y1 - line.bbox.y0 + 16;
  if (x1 - x0 < 20) return null;
  const c = document.createElement("canvas"), S = 2; c.width = Math.round((x1 - x0) * S + 60); c.height = Math.round(h * S + 40);
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = "high";
  x.drawImage(bm, x0, y0, x1 - x0, h, 30, 20, (x1 - x0) * S, h * S);
  const { data: d } = await withTimeout(w.recognize(c), 30000, "医務官名の読み取りが終わりませんでした");
  const nm = nfkc(d.text || "").replace(/[^\u3040-\u30ff\u4e00-\u9fff々〆ヵヶ\s]/g, " ").replace(/\s+/g, " ").trim();
  return nm.replace(/\s/g, "").length >= 2 ? nm : null;
}
// OCRで読んだ医務官名を、その公館の医務官として分かっている名前（配置表・保存済みの月報）に合わせる。
// 文字の重なりが半分以上ある名前のうち、いちばん近いもの。月が近い配置表の名前を優先する。見つからなければ、ゴミの文字だけ除いて返す
function snapOfficer(post, month, name, extra = [], withScore = false) {
  const res = snapOfficer0(post, month, name, extra);
  return withScore ? res : res.name;
}
function snapOfficer0(post, month, name, extra) {
  const clean = (x) => nfkc(String(x || "")).replace(/[\s|｜!！:：;；.。,、'"“”`\-_]/g, "").replace(/^[A-Za-z]+(?=[\u3040-\u30ff\u4e00-\u9fff])/, "").replace(/(医務官|医師|報告者)$/, "");
  const raw = clean(name);
  const cands = new Map();   // 名前 → 近さの重み（月が近いほど大きい）
  const mm = (k) => { const [y, m] = String(k).slice(0, 7).split("-").map(Number); return y * 12 + m; };
  const target = month ? mm(month) : null;
  const add = (nm, k) => { const c = clean(cleanOfficer(nm)); if (c.length < 2) return; const wgt = target && k ? 1 / (1 + Math.abs(mm(k) - target) / 6) : 0.5; cands.set(c, Math.max(cands.get(c) || 0, wgt)); };
  for (const k of rosterKeys()) for (const r of state.rosters[k] || []) if (r.post === post) { if (r.officer) add(r.officer, k); for (const o of r.officers || []) if (o.name) add(o.name, k); }
  for (const r of Object.values(state.reports)) if (r.post === post && r.officer) add(r.officer, r.month);
  for (const [nm, k] of extra) add(nm, k);
  if (!cands.size) return { name: raw || name || null, sim: 0 };
  if (!raw) return { name: null, sim: 0 };
  // 文字の重なり（同じ文字の数）÷ 長い方の長さ
  const sim = (a, b) => { const bs = [...b]; let n = 0; for (const ch of a) { const i = bs.indexOf(ch); if (i >= 0) { n++; bs.splice(i, 1); } } return n / Math.max(a.length, b.length); };
  let best = null, bs = 0;
  for (const [c, wgt] of cands) { const v = sim(raw, c); const score = v + wgt * 0.1; if (v >= 0.5 && score > bs) { best = c; bs = score; } }
  if (!best) return { name: raw, sim: 0 };
  // 配置表の書き方（姓と名のあいだの空白）に合わせる
  const orig = [...rosterKeys().flatMap((k) => (state.rosters[k] || []).filter((r) => r.post === post).flatMap((r) => [r.officer, ...(r.officers || []).map((o) => o.name)])), ...Object.values(state.reports).filter((r) => r.post === post).map((r) => r.officer), ...extra.map((x) => x[0])]
    .find((x) => x && clean(cleanOfficer(x)) === best);
  return { name: orig ? cleanOfficer(orig) : best, sim: bs - (cands.get(best) || 0) * 0.1 };
}
// 1件の月報（確認の表の d）をOCRで読み直す。status(文字) で進み具合を知らせる
async function ocrDraft(d, status) {
  if (!d.srcFile) throw new Error("元のファイルがありません（もう一度ファイルを読み込んでください）");
  const [fmt, pages] = await readPagesRaw(d.srcFile);
  // 文字のないページがなければ（文字はあるのに受診者数などが読めないとき）、PDFは全ページをOCRにかける
  let targets = pages.filter((p) => p.needs), force = false;
  if (!targets.length && fmt === "pdf") { targets = pages.slice(); force = true; }
  if (!targets.length) throw new Error("文字のないページがありません");
  status("OCRの準備をしています…（初回は数秒かかります）");
  const w = await ocrWorker();
  // PDFはページを大きめ（2倍）の画像にすると、認識しやすい
  // 1ページ目（甲表：医務官名・受診者数）はそのまま、2ページ目から（乙表・丙表：網かけの多い表）は白黒にしてから読む
  const pdfImgs = fmt === "pdf" ? new Map([...await pdfPageImages(d.srcFile, targets.filter((p) => p.num === 1).map((p) => p.num), 3),
    ...await pdfPageImages(d.srcFile, targets.filter((p) => p.num !== 1).map((p) => p.num), 3, true)]) : null;
  const shown = [];
  let officerCrop = null;
  for (let k = 0; k < targets.length; k++) {
    const p = targets[k], img = pdfImgs ? pdfImgs.get(p.num) : p.image;
    if (!img) continue;
    ocrLog = (m) => { if (m.status === "recognizing text") status(`OCRで読み取り中… ${k + 1} / ${targets.length}ページ（${Math.round((m.progress || 0) * 100)}%）`); };
    status(`OCRで読み取り中… ${k + 1} / ${targets.length}ページ`);
    const { data } = await withTimeout(w.recognize(img, {}, { text: true, blocks: true }), 180000, `p.${p.num} の読み取りが3分で終わりませんでした`);
    let t = ocrFixCounts(ocrClean(data.text));
    // 甲表の受診者数の欄は、「1」のような細い数字が落ちやすいので、欄ごとに数字だけで読み直す
    try { t = await ocrFixVisitRow(w, img, data, t); } catch (e) { console.warn("ocr visit row", e); }
    if (p.num === 1) try { officerCrop = await ocrOfficerName(w, img, data); } catch (e) { console.warn("ocr officer", e); }
    // 乙表のページは、病名の並ぶ「内訳」の欄だけを切り出して読み直す（大分類の見出しや件数の欄と混ざらないように）
    try { t = await ocrOtsuColumn(w, img, data, t); } catch (e) { console.warn("ocr otsu column", e); }
    t = ocrFixCounts(t);
    // もとの文字よりOCRの方が多く読めたときだけ置き換える
    // （全ページにかけたときは、もとの文字が崩れていることがあるので、OCRで20文字以上読めれば置き換える）
    const nt = t.replace(/\s/g, "").length;
    if (nt >= (p.text || "").replace(/\s/g, "").length || (force && nt >= 20)) p.text = t;
    Object.assign(p, { needs: false, ocr: true });
    shown.push([p.num, img]);
  }
  ocrLog = null;
  const got = targets.reduce((a, p) => a + (p.text || "").replace(/\s/g, "").length, 0);
  if (!got) throw new Error("文字を1つも認識できませんでした（画像がうすい・小さい・傾いている可能性）。ページの画像を見て、表に手で入れてください");
  const r = parseReportPages(fmt, pages, d.srcFile);
  // 医務官名：OCRの読み誤り（「m下功」など）を、配置表・保存済みの月報にあるその公館の医務官名に合わせる
  // 表の文から読んだ名前にゴミ（英字・記号）が混ざるか読めないときは、名前の欄だけを読み直した結果を使う
  // 公館名が読めないとき（「アメリメカ合衆国」など）は、「在○○大使館」の部分を公館の一覧のいちばん近い名前に合わせる
  if (!r.post) {
    const all = pages.map((p) => p.text || "").join("\n"), m = nfkc(all).replace(/\s/g, "").match(/在(.{2,14}?)(大使館|総領事館|政府代表部|代表部|領事事務所)/);
    if (m) {
      const want = m[1] + (m[2] === "大使館" ? "" : m[2]);
      const sim = (a, b) => { const bs = [...b]; let n = 0; for (const ch of a) { const i = bs.indexOf(ch); if (i >= 0) { n++; bs.splice(i, 1); } } return n / Math.max(a.length, b.length); };
      const best = MASTER_POSTS().map((p) => [p, sim(want, p)]).sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= 0.7) { r.post = best[0]; r.warnings = r.warnings.filter((x) => !/公館名を特定できません/.test(x)); r.warnings.push(`公館名をOCRの「在${m[1]}${m[2]}」から「${best[0]}」と判断しました（確かめてください）`); }
    }
    if (!r.post && d.post) r.post = d.post;
  }
  const junk = (x) => !x || /[A-Za-z|｜!?？_]/.test(x) || nfkc(x).replace(/[^\u3040-\u30ff\u4e00-\u9fff]/g, "").length < 2;
  // 同じ取り込みの中の、同じ公館のほかの月報（文字のあるPDFなど）の医務官名も手がかりにする
  const extra = drafts.filter((x) => x !== d && x.officer && (x.post === (r.post || d.post))).map((x) => [x.officer, x.month, x.ocr ? 0.5 : 1]);
  const pick = [r.officer, officerCrop].filter(Boolean).map((x) => snapOfficer(r.post || d.post, r.month || d.month, x, extra, true)).sort((a, b) => b.sim - a.sim)[0];
  if (pick && pick.sim >= 0.5) r.officer = pick.name;
  else if (officerCrop && junk(r.officer)) r.officer = officerCrop;
  r.warnings.unshift(`OCR（文字認識）で読み取りました（${got}文字）。誤読があり得るので、ページの画像と見比べて数字・病名・医務官名を確かめてください`);
  r.images = shown; r.lazyPages = [];
  return r;
}

async function parseRoster(file) {
  if (/\.(pdf|docx)$/i.test(file.name)) {
    const [, pages] = await readPages(file);
    return parseRosterText(pages.map((p) => p.text).join("\n"));
  }
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellDates: true });
  const sname = wb.SheetNames.find((s) => s.includes("配置")) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sname], { header: 1, defval: "" });
  return parseRosterRows(rows);
}
// Excel の配置表の行（2次元の配列）を読む。
// 見出しの行：「公館」と「氏名（医務官）」の両方を含む行（「令和3年1月1日現在 在外公館定員…」のような表題の行を見出しと取り違えない）。
// 印の列（広＝広域医務官・産＝産業医・メ＝メンタルヘルス相談医）、発令年月日の列、専門の列があれば読む。
// 公館の欄が空の行（結合したセル）は、すぐ上の公館の2人目（タイ・フランスのメンタルヘルス相談医など）。
// 番号の列が番号でなくなったら（「看護師」「本省」「出向」などの欄）、医務官の欄はおしまい
function parseRosterRows(rows) {
  const sq = (v) => nfkc(String(v ?? "")).replace(/\s+/g, "");
  let h = rows.slice(0, 20).findIndex((r) => { const t = r.map(sq).join(" "); return /公館/.test(t) && /氏名|医務官名|医務官$/.test(t); });
  if (h < 0) h = rows.slice(0, 20).findIndex((r) => r.map(sq).some((c) => c === "駐在公館名" || c === "公館名" || c === "駐在公館"));
  if (h < 0) h = rows.slice(0, 15).findIndex((r) => r.join(" ").includes("公館"));
  if (h < 0) throw new Error("「公館」を含む見出し行が見つかりません");
  // 「2026年8月1日現在」「令和3年1月1日現在」など、表の上の見出しに書かれた年月
  const headText = rows.slice(0, Math.max(1, h)).map((r) => r.join(" ")).join(" ");
  const sheetMonth = monthFromText(headText.replace(/(\d{1,2})\s*月(?!\s*分)/, "$1月分")) || monthFromName(headText);
  const cap = nfkc(headText).match(/定員\s*(\d+)\s*公館\s*(\d+)\s*名/);
  const dayM = nfkc(headText).match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*現在/);
  const cols = rows[h].map(sq);
  const pick = (keys, exclude = []) => cols.findIndex((c) => keys.some((k) => c.includes(k)) && !exclude.some((e) => c.includes(e)));
  const cPost = pick(["駐在公館", "公館"]);
  const cName = pick(["氏名", "医務官"], ["ふりがな", "フリガナ", "公館"]);
  const cKana = pick(["ふりがな", "フリガナ", "よみ"]);
  const cNote = pick(["備考", "状況"]);
  const cDate = pick(["発令", "着任日", "赴任日"]);
  const cSpec = pick(["専門"]);
  const cMarks = cols.map((c, i) => (/^(広|産|メ|広域|産業医|メンタル.*)$/.test(c) ? i : -1)).filter((i) => i >= 0);
  // 番号の列：見出しが空か「No」「番号」で、すぐ下の行が数字
  const cNum = cols.findIndex((c, i) => (!c || /^(No\.?|番号|NO)$/i.test(c)) && i < cPost && /^\d+$/.test(sq((rows[h + 1] || [])[i])));
  const dateOf = (v) => {
    if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
    const t = sq(v), m = t.match(/(20\d{2}|19\d{2})\D(\d{1,2})\D(\d{1,2})/) || t.match(/^([RHＲＨ])(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/);
    if (!m) return "";
    if (m.length === 5) return `${(/^[HＨ]/.test(m[1]) ? 1988 : 2018) + Number(m[2])}-${m[3].padStart(2, "0")}-${m[4].padStart(2, "0")}`;
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  };
  const out = [], byPost = {};
  let prevPost = null;
  for (const r of rows.slice(h + 1)) {
    const num = cNum >= 0 ? sq(r[cNum]) : "";
    const raw = String(r[cPost] ?? "").trim();
    // 番号の列に「看護師」「本省」などの見出しが来たら、医務官の欄はおしまい
    if (cNum >= 0 && num && !/^\d+$/.test(num)) break;
    const marks = cMarks.map((i) => sq(r[i])).join("");
    let rawName = cName >= 0 ? nfkc(String(r[cName] ?? "")).replace(/\s+/g, " ").trim().replace(/^[*＊#＃]+\s*/, "") : "";
    const note0 = cNote >= 0 ? String(r[cNote] || "").trim() : "";
    let post;
    if (raw) {
      post = rosterPostName(raw) || canonical(raw) || findInText(raw)[0] || null;
      if (!post) { prevPost = null; continue; }   // 公館でない行（注記など）
      prevPost = post;
    } else if (prevPost && (num || rawName || marks)) post = prevPost;   // 結合したセル：上の公館の2人目
    else continue;
    const [m2, nm] = splitOfficerMarks(rawName);
    const allMarks = marks + m2;
    const noteWord = (nm.match(/退避中?|欠員|空席|未配置|不在/) || [""])[0];
    const officer = noteWord ? "" : nm.replace(/\s+/g, " ").trim();
    const kana = officer && cKana >= 0 ? String(r[cKana] || "").replace(/\s+/g, " ").trim() : "";
    const date = officer && cDate >= 0 ? dateOf(r[cDate]) : "";
    let cur = byPost[post];
    if (!cur) { cur = byPost[post] = { post, officer: "", kana: "", note: "", staffed: false, officers: [] }; out.push(cur); }
    const mental = allMarks.includes("メ");
    if (!officer && !noteWord && !mental) cur.bodyVacant = true;   // 身体の医務官の欄が空（「広」の印だけなど）
    if (officer || (mental && cur.officers.length) || (cur.officers.length && !officer && !noteWord)) {
      // 同じ種類（身体・メンタル）の医務官が2人いれば、発令年月日の新しい方がいまの医務官、古い方は離任
      if (officer) for (const y of cur.officers.filter((y) => !!y.mental === mental && y.name)) { if (!y.date || !date || date >= y.date) y.leaving = true; }
      const older = officer && cur.officers.some((y) => !!y.mental === mental && y.name && !y.leaving && y.date && date && y.date > date);
      cur.officers.push({ name: officer, kana, mental, date, leaving: older || undefined, speciality: officer && cSpec >= 0 ? String(r[cSpec] || "").trim() : "", wide: allMarks.includes("広"), sangyo: allMarks.includes("産") });
    }
    if (noteWord || note0) cur.note = [cur.note, noteWord, note0].filter(Boolean).join(" ");
    const main = cur.officers.find((o) => !o.mental && o.name && !o.leaving) || cur.officers.find((o) => o.name && !o.leaving) || cur.officers.find((o) => o.name);
    if (main) Object.assign(cur, { officer: main.name, kana: main.kana, staffed: !/未配置|欠員|退避|不在/.test(cur.note) });
    else if (!cur.note) cur.note = "空席";
  }
  for (const x of out) {
    for (const o of x.officers) if (o.leaving === undefined) delete o.leaving;
    const bv = x.bodyVacant; delete x.bodyVacant;
    // 1行目（身体）が空席で、2人目（メンタル）がいる・その逆のとき、どちらが空席かを備考に書く
    const body = x.officers.some((o) => !o.mental && o.name && !o.leaving), mental = x.officers.some((o) => o.mental && o.name && !o.leaving);
    if (x.officer && /(^|\s)空席$/.test(x.note)) x.note = x.note.replace(/\s*空席$/, "");
    if (x.officer && !body && mental && bv) x.note = [x.note, "身体の医務官は空席"].filter(Boolean).join(" ");
    else if (x.officer && x.officers.some((o) => o.mental && !o.name)) x.note = [x.note, "メンタルヘルス相談医は空席"].filter(Boolean).join(" ");
  }
  out.sheetMonth = sheetMonth;
  if (dayM) out.sheetDay = Number(dayM[2]);
  if (cap) out.capacity = { posts: Number(cap[1]), slots: Number(cap[2]) };
  return out;
}

// PDF・Word の配置表：1行ごとに「在◯◯大使館（総領事館など）」を探し、その後ろの漢字の名前を医務官、かなを読み、
// 「退避」「欠員」などを備考として読む（表の列の並びは問わない。読み取った内容は保存の前に一覧で確認できる）
const ROSTER_NOTE = /退避|欠員|未配置|不在|兼轄|兼務|着任|離任|予定|休暇|赴任|一時|※/;
const POST_RE = /在\S{1,25}?(?:日本国)?(?:大使館|総領事館|政府代表部|代表部|領事事務所)/;
// 配置表の公館の欄の書き方：「ケニア」＝大使館、「広州総」「総 広州」「広州（総）」＝総領事館。「在◯◯大使館」の正式名も読む
// 配置表の氏名の前の印：広＝広域担当、産＝産業医、メ＝メンタルヘルス相談医。氏名には入れない
// （メンタルヘルス相談医がいるのは、タイ・南アフリカ・アメリカ・サンパウロ・フランスの5館）
const MENTAL_POSTS = ["タイ", "南アフリカ共和国", "アメリカ合衆国", "サンパウロ総領事館", "フランス"];
// いま実際に2人（身体とメンタル）いる公館。アメリカ・南アフリカはメンタルが空席で1人、サンパウロはメンタルの医務官1人（2026年10月現在）
const TWO_DOCTOR_POSTS = ["タイ", "フランス"];
// メンタルの医務官が1人だけの公館
const MENTAL_ONLY_POSTS = ["サンパウロ総領事館"];
// その公館の医務官の人数。配置表に身体とメンタルの欄があれば、名前の入っている人数（空席は数えない）。
// 配置表がない・欄が1つのときは、2人いる公館は2人、それ以外は1人
function doctorCount(post, m) {
  const ro = (m && rosterFor(m)) || latestRoster(), x = ro && ro.find((r) => r.post === post);
  if (x && (x.officers || []).length > 1) return Math.max(1, x.officers.filter((o) => o.name).length);
  return TWO_DOCTOR_POSTS.includes(post) ? 2 : 1;
}
// 先頭の印を1文字ずつ見る。メ・産はいつも取る（その字で始まる名字はまずない）。
// 広は「広田」「広瀬」のような名字があるので、取ったあとの名字が2文字以上残るとき（広松田→松田）か、次が印・空白のときだけ取る
// → [印, 残り]
function splitOfficerMarks(text) {
  let t = nfkc(String(text || "")).replace(/^\s+/, ""), marks = "";
  for (let k = 0; k < 4 && /^[広産メ]/.test(t); k++) {
    const c = t[0], rest = t.slice(1).replace(/^[\s・　]+/, ""), fam = rest.split(/[\s　]/)[0];
    // 「広」だけの欄（広域医務官の印だけで、氏名がない＝空席）も印として取る
    if (c === "広" && rest && !/^[産メ\s・　]/.test(t.slice(1)) && fam.replace(/[^一-龯々〆ヵヶ]/g, "").length < 2) break;
    marks += c; t = rest;
    if (!/[一-龯々〆ヵヶぁ-ゖ]/.test(rest)) break;   // 印だけの行（「メ」だけ＝空席）
  }
  return [marks, t];
}
const cleanOfficer = (name) => splitOfficerMarks(nfkc(String(name || "")).replace(/\s+/g, " ").trim())[1].trim();
function rosterPostName(raw) {
  let t = nfkc(raw || "").trim().replace(/^在/, "");
  if (!t || /^\d+$/.test(t)) return null;
  const cg = /^総|総$|[(（]総[)）]|総領事館$/.test(t);
  const base = t.replace(/[(（][総大][)）]/g, "").replace(/^総/, "").replace(/総(領事館)?$/, "").replace(/(日本国)?大使館$/, "").replace(/^日本国/, "").trim();
  if (!base || base.length < 2 && !/^[ァ-ヺ]/.test(base)) return null;
  if (cg) return canonical(base + "総領事館") || null;
  const c = canonical(base);
  return c && INFO[c] ? c : null;
}
// 1行から公館と、その後ろの欄（氏名・ふりがな・備考）を取り出す
const ROSTER_SKIP = new Set(["No", "No.", "番号", ...REGIONS, "アジア", "大洋州", "北米", "中南米", "欧州", "米州", "アフリカ", "中東"]);
function rosterLinePost(l) {
  const m = l.match(POST_RE);
  if (m) { const post = canonical(m[0]) || findInText(m[0])[0]; if (post) return { post, rest: l.slice(m.index + m[0].length) }; }
  const toks = l.split(/\s+/).filter(Boolean);
  for (let i = 0; i < Math.min(toks.length, 4); i++) {
    const t = toks[i];
    if (/^\d+\.?$/.test(t) || ROSTER_SKIP.has(t)) continue;
    // 「広州 総」「広州 （総）」のように「総」が別の欄に分かれているとき
    const next = toks[i + 1] || "";
    if (/^[(（]?総[)）]?$/.test(next)) { const p = rosterPostName(t + "総"); if (p) return { post: p, rest: toks.slice(i + 2).join(" ") }; }
    const p = rosterPostName(t);
    if (p) return { post: p, rest: toks.slice(i + 1).join(" ") };
    break;  // 先頭の番号・地域の次の欄が公館でなければ、公館の行ではない
  }
  return null;
}
// ---- 番号つきの配置表（「1 インド植山　徹うえやま　とおるR07.01.24 救急医学」のように、番号・公館・氏名・ふりがな・発令日が続けて並ぶPDF）
// 結合したセルの公館名は行から外れて別の場所に出る（「タイ」「アメリカ合衆国」など）ので、公館のない行に地域と50音の並びから当てはめる
const SKIPCH = /[\s・\-_'’]/;
// 先頭の公館名を探す（「広州総」「ニューヨーク総」は総領事館）。{post, rest} を返す
function rosterPrefixPost(raw) {
  const s = nfkc(raw).replace(/^\s+/, "");
  const compact = norm(s);
  // 元の文字列で、空白などを除いて n 文字分すすんだ位置
  const cut = (n) => { let k = 0, i = 0; while (i < s.length && k < n) { if (!SKIPCH.test(s[i])) k++; i++; } return s.slice(i); };
  const cg = compact.match(/^([^\d総]{1,12}?)総(?!領)/);
  if (cg) { const c = canonical(cg[1] + "総領事館"); if (c && INFO[c]) return { post: c, rest: cut(cg[0].length) }; }
  for (const [alias, name] of ALIAS_SORTED) {
    if (alias.length < 2 || !compact.startsWith(alias)) continue;
    // 長い名前から順に見るので「インドネシア」を「インド」と取り違えない（「アフガニスタンアメリカ合衆国…」のように続けて並ぶこともある）
    return { post: name, rest: cut(alias.length) };
  }
  return null;
}
// 公館の後ろの欄から氏名を取り出す：先頭の印（広・産・メ）を除き、ふりがな（ひらがな）の前まで。名がひらがなの人（例：遠藤 ひろみ）も扱う
function rosterOfficerOf(rest) {
  let [marks, t] = splitOfficerMarks(rest);
  const dm = t.match(/[RHＲ]\d{1,2}\.\d{1,2}\.\d{1,2}/);
  const before = (dm ? t.slice(0, dm.index) : t).trim(), after = dm ? t.slice(dm.index + dm[0].length).trim() : "";
  const k = before.search(/[ぁ-ゖ]/);
  let officer = (k < 0 ? before : before.slice(0, k)).replace(/\s+/g, " ").trim(), kana = k < 0 ? "" : before.slice(k).replace(/\s+/g, " ").trim();
  // 「ひろみえんどう ひろみ」：先頭の名（ひらがな）が、ふりがなの終わりにもう一度出る
  const kc = kana.replace(/\s/g, "");
  // 漢字の氏名が名字だけ（1語）のときに限る（「吉川 潔 よしかわ きよし」の「よし」を名と取り違えない）
  for (let n = officer.split(" ").length === 1 ? Math.floor(kc.length / 2) - 1 : 0; n >= 2; n--) {
    const x = kc.slice(0, n);
    if (kc.endsWith(x)) { officer = `${officer} ${x}`; kana = kana.replace(new RegExp("^" + [...x].join("\\s*")), "").trim(); break; }
  }
  if (!/[一-龯々〆ヵヶ]/.test(officer)) officer = "";
  const note = (before.match(/未配置|退避中?|欠員|空席/) || [""])[0];
  // 「メ」＝メンタルヘルス相談医（アメリカ・フランス・タイ・南アフリカは身体とメンタルの2人体制）
  // 発令年月日（「R08.09.22」＝令和8年9月22日）。同じ公館に2人いるときの新旧の見分けに使う
  const dd = dm && dm[0].match(/(\d{1,2})\.(\d{1,2})\.(\d{1,2})/), date = dd ? `${(/^[HＨ]/.test(dm[0]) ? 1988 : 2018) + Number(dd[1])}-${dd[2].padStart(2, "0")}-${dd[3].padStart(2, "0")}` : "";
  return { officer: note ? "" : officer, kana: note ? "" : kana, note: note || (officer ? "" : "空席"), speciality: after, mental: marks.includes("メ"), date };
}
function parseRosterNumbered(lines) {
  const rows = [], others = [];
  let last = 0, ended = false;
  for (const l of lines) {
    const m = !ended && l.match(/^(\d{1,3})\s*(.*)$/);
    if (m && Number(m[1]) === last + 1) { rows.push({ n: Number(m[1]), body: m[2] }); last++; continue; }
    // 番号のない人の行（「高次 寛治 たかつぎ かんじ R08.09.22 …」）は、すぐ上の番号の行の公館の2人目（着任・離任の発令者）
    if (!m && !ended && rows.length && /^[一-龯々〆ヵヶ]{1,4}\s+\S+\s+[ぁ-ゖ]/.test(l) && /[RHＲ]\d{1,2}\.\d{1,2}\.\d{1,2}/.test(l) && !findInText(l).length) {
      (rows[rows.length - 1].extra ||= []).push(l); continue;
    }
    if (m && last >= 10 && Number(m[1]) <= last) ended = true;   // 番号が1に戻ったら医務官の欄はおしまい（看護師・本省・出向の欄）
    others.push(l);
  }
  if (rows.length < 10) return null;
  for (const r of rows) {
    const hit = rosterPrefixPost(r.body);
    if (hit) {
      // 行の後ろに別の公館名がはみ出していれば（「アフガニスタンアメリカ合衆国医務官等配置表」）、それは行から外れた公館名
      const extra = findInText(hit.rest).filter((p) => p !== hit.post);
      if (extra.length) { others.push(hit.rest); r.post = hit.post; Object.assign(r, { officer: "", kana: "", note: "空席" }); }
      else Object.assign(r, { post: hit.post }, rosterOfficerOf(hit.rest));
    } else Object.assign(r, { post: null }, rosterOfficerOf(r.body));
  }
  if (rows.filter((r) => r.post).length < rows.length / 2) return null;
  // 行から外れた公館名（どの行にもないもの）
  const used = new Set(rows.map((r) => r.post).filter(Boolean));
  const orphans = [];
  for (const l of others) for (const p of findInText(l)) if (!used.has(p) && !orphans.includes(p) && INFO[p] && INFO[p].isPost) orphans.push(p);
  // 公館のない行（続けて並ぶものは同じ公館）に当てはめる。前後の行と同じ地域で、50音で間に入るものを優先。なければ前の行の公館（同じ公館の2人目）
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].post) continue;
    let j = i; while (j + 1 < rows.length && !rows[j + 1].post) j++;
    const prev = rows[i - 1] && rows[i - 1].post, next = rows[j + 1] && rows[j + 1].post;
    const regs = [prev, next].filter(Boolean).map(regionOf);
    const cands = orphans.filter((p) => regs.includes(regionOf(p)));
    const between = cands.filter((p) => (!prev || regionOf(prev) !== regionOf(p) || jaCmp(prev, p) < 0) && (!next || regionOf(next) !== regionOf(p) || jaCmp(p, next) < 0));
    const pick = between[0] || cands[0] || null;
    if (pick) orphans.splice(orphans.indexOf(pick), 1);
    for (let k = i; k <= j; k++) rows[k].post = pick || prev;
    i = j;
  }
  // 公館ごとにまとめる。1公館に2人（身体の医務官とメンタルヘルス相談医）のときは、身体の医務官を「医務官」にして、2人とも officers に持つ
  const out = [], byPost = {};
  for (const r of rows) {
    if (!r.post) continue;
    let cur = byPost[r.post];
    if (!cur) { cur = byPost[r.post] = { post: r.post, officer: "", kana: "", note: r.note, staffed: false, officers: [] }; out.push(cur); }
    // 名前のない「メ」の行（メンタルヘルス相談医の空席）も枠として持つ
    if (r.officer || (r.mental && cur.officers.length)) cur.officers.push({ name: r.officer || "", kana: r.kana || "", mental: !!r.mental, date: r.date || "" });
    // 同じ欄に2人（離任する人と着任する人）：発令年月日の新しい方がいまの医務官、古い方は離任
    for (const x of r.extra || []) {
      const o = rosterOfficerOf(x);
      if (!o.officer) continue;
      const same = cur.officers.filter((y) => !!y.mental === !!r.mental && y.name);
      const newer = same.every((y) => !y.date || !o.date || o.date >= y.date);
      for (const y of same) if (newer) y.leaving = true;
      cur.officers.push({ name: o.officer, kana: o.kana, mental: !!r.mental, date: o.date, leaving: !newer });
    }
    const main = cur.officers.find((o) => !o.mental && o.name && !o.leaving) || cur.officers.find((o) => o.name && !o.leaving) || cur.officers.find((o) => o.name);
    if (main) Object.assign(cur, { officer: main.name, kana: main.kana, note: "", staffed: true });
    else if (!cur.note) cur.note = r.note;
  }
  out.slots = rows.length;
  return out;
}
function parseRosterText(text) {
  const lines = nfkc(text).split("\n").map((s) => s.trim()).filter(Boolean);
  const numbered = parseRosterNumbered(lines);
  if (numbered) {
    const all = lines.join(" ");
    const cap = all.match(/定員\s*(\d+)\s*公館\s*(\d+)\s*名/);
    numbered.capacity = cap ? { posts: Number(cap[1]), slots: Number(cap[2]) } : null;
    const hm = all.match(/(令和\s*(?:元|\d{1,2})\s*年\s*\d{1,2}\s*月|20\d{2}\s*年\s*\d{1,2}\s*月)[^)）]{0,8}現在/);
    numbered.sheetMonth = hm ? monthFromText(hm[1].replace(/月$/, "月分")) : (monthFromText(all.replace(/(\d{1,2})\s*月(?!\s*分)/, "$1月分")) || null);
    const dm2 = all.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*現在/);
    if (dm2) numbered.sheetDay = Number(dm2[2]);
    return numbered;
  }
  const hi = lines.findIndex((l) => rosterLinePost(l));
  if (hi < 0) throw new Error("公館名（「ケニア」「広州総」「在◯◯大使館」など）が見つかりません（文字のないスキャンPDFは読めません。Excelの配置表を使ってください）");
  const headText = lines.slice(0, Math.min(hi + 1, 8)).join(" ");
  const sheetMonth = monthFromText(headText.replace(/(\d{1,2})\s*月(?!\s*分)/, "$1月分")) || monthFromName(headText);
  const out = [], seen = new Set();
  for (const l of lines) {
    const hit = rosterLinePost(l);
    if (!hit || seen.has(hit.post)) continue;
    const toks = hit.rest.split(/\s+/).filter(Boolean);
    const ni = toks.findIndex((t) => ROSTER_NOTE.test(t));
    const body = ni >= 0 ? toks.slice(0, ni) : toks, note = ni >= 0 ? toks.slice(ni).join(" ") : "";
    const kana = body.filter((t) => /^[ぁ-ゖァ-ヺー・]+$/.test(t));
    const officer = cleanOfficer(body.filter((t) => /[一-龯々〆ヵヶ]/.test(t) && !/^\d+$/.test(t)).slice(0, 2).join(" "));
    seen.add(hit.post);
    out.push({ post: hit.post, officer, kana: kana.join(" "), note, staffed: !!officer && !/未配置|欠員|退避|不在/.test(officer + note) });
  }
  out.sheetMonth = sheetMonth;
  return out;
}

// ======================================================================= 分析

// 縦に広げられる一覧の枠（右下のつまみで高さを変える）。はじめは高さ 420px まで。変えた高さは覚えておき、次に開いたときも使う
function vresize(root = document) {
  root.querySelectorAll(".vresize[data-rkey]").forEach((box) => {
    const key = box.dataset.rkey, h = Number(loadPrefs()[key]) || 0;
    box.style.height = h ? `${h}px` : box.scrollHeight > 420 ? "420px" : "";
    let first = true;
    new ResizeObserver(() => {
      if (first) { first = false; return; }   // 最初の1回は表示しただけ
      if (box.isConnected && box.offsetHeight > 0) savePref(key, Math.round(box.offsetHeight));
    }).observe(box);
  });
}
// ---- 提出状況（公館×月）：足りない月報を見つける
// 対象＝アプリの公館一覧と、その月の配置表にあるすべての公館（医務官がいない公館も含む）。
// 月報を出した公館だけを基準にすると、出していない公館が数えられず「すべて提出」になってしまうため、公館一覧を基準にする
const MASTER_POSTS = () => Object.keys(INFO).filter((nm) => INFO[nm].isPost);
// 配置表があれば、配置表の公館すべて（定員の公館。医務官がいない・空席・退避中の公館も含む）。なければアプリの公館一覧。
// 公館の顔ぶれは過去も同じなので、月にかかわらず最新の配置表の公館を使う（医務官名は月ごとの配置表のまま）
function latestRoster() {
  const ms = rosterKeys().filter((k) => (state.rosters[k] || []).length);
  return ms.length ? state.rosters[ms[ms.length - 1]] : null;
}
function expectedPosts(m) {
  const ro = latestRoster();
  return new Set((ro ? ro.map((r) => r.post) : MASTER_POSTS()).filter((p) => p && p !== "日本"));
}
// 配置表で医務官の名前がない公館（その月）
const noOfficerIn = (m) => { const ro = rosterFor(m); return new Set(ro ? ro.filter((r) => !r.staffed).map((r) => r.post) : []); };
function submitMatrix(span) {
  const repMs = [...new Set(Object.values(state.reports).map((r) => r.month))].sort();
  if (!repMs.length) return null;
  // 月報を取り込み始めた月より前は数えない（データがないだけで「足りない」わけではない）
  const ms = spanMonths(repMs[repMs.length - 1], span).filter((mm) => mm >= repMs[0]);
  const posts = new Set(), miss = [];
  const cell = {};
  for (const mm of ms) {
    const exp = expectedPosts(mm), got = new Set(reportsOf(mm).map((r) => r.post));
    for (const p of new Set([...exp, ...got])) {
      posts.add(p);
      const st = got.has(p) ? "ok" : "miss";
      (cell[p] ||= {})[mm] = st;
      if (st === "miss") miss.push({ month: mm, post: p });
    }
  }
  const rows = [...posts].sort((a, b) => REGIONS.indexOf(regionOf(a)) - REGIONS.indexOf(regionOf(b)) || jaCmp(a, b));
  return { ms, rows, cell, miss };
}
const SUBMIT_SPANS = [[3, "直近3か月"], [6, "直近6か月"], [12, "直近12か月"], [0, "全期間"]];
function renderSubmitGrid() {
  const el = $("#submitGrid");
  if (!el) return;
  const pr = loadPrefs(), span = SUBMIT_SPANS.some(([k]) => k === pr.submitSpan) ? pr.submitSpan : 6, only = pr.submitOnlyMiss !== false;
  const mx = submitMatrix(span);
  if (!mx) { el.innerHTML = ""; return; }
  const shown = only ? mx.rows.filter((p) => mx.ms.some((mm) => mx.cell[p][mm] === "miss")) : mx.rows;
  const nPosts = new Set(mx.miss.map((x) => x.post)).size;
  // 新しい月を左に（いちばん左が最新の月）
  const cols = [...mx.ms].reverse();
  el.innerHTML = `
    <div class="card" id="submitCard">
      <h3 style="margin-top:0">📮 提出状況（足りない月報）</h3>
      <p class="muted" style="margin-top:0">${Object.keys(state.rosters).length ? `最新の医務官配置表にあるすべての公館（${(latestRoster() || []).length}公館。医務官がいない・空席・退避中の公館も含み、過去の月にも同じ公館を当てはめます）` : `アプリの公館一覧（${MASTER_POSTS().length}公館。医務官配置表を登録すると、配置表の公館で判定します）`}について、月報がそろっているかを表示します（<b class="miss-mark">未</b>＝足りない月報）。</p>
      <div class="row"><span class="seg">${SUBMIT_SPANS.map(([k, t]) => `<button data-sspan="${k}" class="${k === span ? "on" : ""}">${t}</button>`).join("")}</span>
        <label><input type="checkbox" id="sOnly"${only ? " checked" : ""}> 足りない公館だけ表示</label>
        <b class="${mx.miss.length ? "miss-mark" : ""}">${mx.miss.length ? `足りない月報 ${mx.miss.length}件（${nPosts}公館）` : "✓ すべてそろっています"}</b>
        ${mx.miss.length ? '<button id="sCopy">足りない月報の一覧をコピー</button>' : ""}</div>
      ${shown.length ? `<div class="table-wrap vresize" data-rkey="submitH"><table class="subgrid"><thead><tr><th class="sreg">地域</th><th class="spost">公館</th>${cols.map((mm) => `<th class="num">${esc(mm.slice(2, 4) + "/" + Number(mm.slice(5)))}</th>`).join("")}</tr></thead><tbody>
        ${shown.map((p) => `<tr><td class="muted sreg">${esc(regionOf(p))}</td><td class="spost">${esc(p)}${(() => { const ro = latestRoster(), x = ro && ro.find((r) => r.post === p); return x && !x.staffed ? ` <span class="badge" title="配置表で医務官の名前がありません">${esc(x.note || "医務官なし")}</span>` : ""; })()}</td>${cols.map((mm) => { const st = mx.cell[p][mm];
          return st === "ok" ? '<td class="num ok">✓</td>' : st === "miss" ? `<td class="num miss" title="${esc(fmtMonth(mm))}の月報がありません">未</td>` : '<td class="num muted">―</td>'; }).join("")}</tr>`).join("")}
        <tr class="sub"><td class="sreg">足りない件数</td><td class="spost"></td>${cols.map((mm) => { const k = mx.miss.filter((x) => x.month === mm).length; return `<td class="num${k ? " miss" : ""}">${k || ""}</td>`; }).join("")}</tr>
        </tbody></table></div>` : ""}
    </div>`;
  vresize(el);
  el.querySelectorAll("[data-sspan]").forEach((b) => (b.onclick = () => { savePref("submitSpan", Number(b.dataset.sspan)); renderSubmitGrid(); }));
  $("#sOnly").onchange = (e) => { savePref("submitOnlyMiss", e.target.checked); renderSubmitGrid(); };
  if ($("#sCopy")) $("#sCopy").onclick = async () => {
    const by = {};
    for (const x of mx.miss) (by[x.month] ||= []).push(x.post);
    const t = Object.keys(by).sort().map((mm) => `${fmtMonth(mm)}分（${by[mm].length}公館）：${by[mm].sort(jaCmp).join("、")}`).join("\n");
    toast((await copyText(t)) ? "足りない月報の一覧をコピーしました" : "コピーできませんでした");
  };
}
function missingPosts(m) {
  const ro = rosterFor(m);
  if (!ro) return null;
  const got = new Set(reportsOf(m).map((r) => r.post));
  return ro.filter((r) => r.staffed && !got.has(r.post)).map((r) => ({ ...r, region: regionOf(r.post) }))
    .sort((a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region));
}

function officerTable() {
  // 月×公館の医務官名。配置表から読む（月報ヘッダーの医務官名は使わない）。同じ月に複数の配置表があるときは後の方
  const t = {};
  for (const k of rosterKeys()) for (const r of state.rosters[k]) {
    const names = (r.officers || []).length ? r.officers.filter((o) => !o.leaving && o.name).map((o) => cleanOfficer(o.name)) : r.staffed && r.officer ? [cleanOfficer(r.officer)] : [];
    const row = (t[rosterKeyMonth(k)] ||= {});
    if (names.length) row[r.post] = names.join("・"); else if (!r.staffed) row[r.post] = `（${r.note || "空席"}）`;
  }
  return t;
}
// 月×公館の医務官の名前の一覧（配置表の身体・メンタルの両方と、月報の医務官名）
// 配置表のふりがなを覚えておき、漢字が少し違っても（誤記・誤読）ふりがなが同じなら同じ人とみなす
let KANA_OF = new Map();
const kanaKey = (k) => nfkc(k || "").replace(/\s/g, "");
const sameOfficer = (a, b) => samePerson(a, b) || (!!KANA_OF.get(a) && KANA_OF.get(a) === KANA_OF.get(b));
function officerSets() {
  const t = {}, gone = {};
  KANA_OF = new Map();
  const add = (m, post, name, kana) => {
    name = cleanOfficer(name || "").trim(); if (!name) return;
    if (kana && !KANA_OF.has(name)) KANA_OF.set(name, kanaKey(kana));
    const xs = ((t[m] ||= {})[post] ||= []); if (!xs.some((x) => sameOfficer(x, name))) xs.push(name);
  };
  const vacant = {};
  // 同じ月に複数の配置表（月の途中の更新）があるときは、その月の最後の配置表を使い、それより前の配置表にだけいた医務官は離任とする
  const lastOfMonth = {};
  for (const k of rosterKeys()) lastOfMonth[rosterKeyMonth(k)] = k;
  for (const k of rosterKeys()) {
    const m = rosterKeyMonth(k);
    if (lastOfMonth[m] === k) continue;
    const later = state.rosters[lastOfMonth[m]] || [];
    for (const r of state.rosters[k] || []) {
      const now = later.find((x) => x.post === r.post), nowNames = now ? [now.officer, ...(now.officers || []).filter((o) => !o.leaving).map((o) => o.name)].filter(Boolean) : [];
      for (const nm of [r.officer, ...(r.officers || []).filter((o) => !o.leaving).map((o) => o.name)].filter(Boolean))
        if (!nowNames.some((x) => samePerson(x, nm))) { const c = cleanOfficer(nm); const g = ((gone[m] ||= {})[r.post] ||= []); if (!g.includes(c)) g.push(c); }
    }
  }
  for (const [m, rows] of Object.entries(lastOfMonth).map(([mm, k]) => [mm, state.rosters[k]])) for (const r of rows || []) {
    // 配置表で医務官の名前がない公館（空席・退避中など）。前に医務官がいれば離任として出す
    if (!r.staffed && !(r.officers || []).some((o) => o.name)) { ((vacant[m] ||= {})[r.post] = r.note || "空席"); continue; }
    // 離任の発令者（同じ欄の古い方）は、その月の医務官に入れず、前任として覚える
    if ((r.officers || []).length) r.officers.forEach((o) => { if (o.leaving) { if (o.name) ((gone[m] ||= {})[r.post] ||= []).push(cleanOfficer(o.name)); KANA_OF.set(cleanOfficer(o.name), kanaKey(o.kana)); } else add(m, r.post, o.name, o.kana); });
    else add(m, r.post, r.officer, r.kana);
  }
  // 異動は配置表から読む（月報ヘッダーの医務官名は使わない）
  t.gone = gone; t.vacant = vacant;
  return t;
}

// 医務官の交代：公館ごとに、前に分かっている医務官（間の月の月報・配置表がなくてもよい）にいなかった人が新しく出てきたら交代とみなす。
// 2人体制（身体・メンタル）の公館で、月報にどちらか1人だけが書かれていても交代にしない（新しい名前が出たときだけ）
function transfers() {
  const t = officerSets(), goneAt = t.gone, vacant = t.vacant;
  delete t.gone; delete t.vacant;
  const ms = [...new Set([...Object.keys(t), ...Object.keys(vacant)])].sort();
  const last = {}, seenAt = {};   // 公館 → 前に分かっている医務官、人 → 最後にいた公館
  const out = [];
  for (const m of ms) {
    // 配置表で空席になった公館（月報の医務官名もない）：前の医務官の離任
    for (const [post, note] of Object.entries(vacant[m] || {})) {
      if ((t[m] || {})[post] || !(last[post] || []).length) continue;
      out.push({ month: m, post, before: last[post].join("・"), after: `（${note}）`, from: null });
      last[post] = [];
    }
    for (const [post, names] of Object.entries(t[m] || {})) {
      // 配置表に離任の発令者が書かれていれば、その人も前任として扱う（前の月の配置表・月報がなくても交代が分かる）
      const leaving = (goneAt[m] || {})[post] || [];
      const prev = [...(last[post] || []), ...leaving.filter((g) => !(last[post] || []).some((p) => sameOfficer(p, g)))];
      if (prev.length) {
        const fresh = names.filter((n) => !prev.some((p) => sameOfficer(p, n)));
        if (fresh.length) {
          const gone = prev.filter((p) => !names.some((n) => sameOfficer(p, n)));
          for (const after of fresh) {
            const from = Object.entries(seenAt).find(([n, p]) => p !== post && sameOfficer(n, after));
            out.push({ month: m, post, before: gone.join("・") || "（空席）", after, from: from ? from[1] : null });
          }
        }
        // 2人体制で月報に1人だけのときは、もう1人も残す
        const base = last[post] || [];
        last[post] = fresh.length || names.length >= base.length ? names : [...names, ...base.filter((p) => !names.some((n) => sameOfficer(p, n)))];
      } else last[post] = names;
    }
    for (const [post, names] of Object.entries(t[m] || {})) for (const n of names) seenAt[n] = post;
  }
  return out;
}

// 医務官ごとの公館の移り変わり（配置表から）。同じ人（ふりがな・表記ゆれ）は1人にまとめる
function officerPaths() {
  const t = officerSets(); delete t.gone; delete t.vacant;
  const ms = Object.keys(t).sort(), people = [];
  // 人ごとに、月 → その月の配置表に名前のある公館
  const byKey = new Map();   // 空白を除いた名前 → 人（同じ書き方なら照合を省く。数千件でも速いように）
  for (const m of ms) for (const [post, names] of Object.entries(t[m])) for (const nm of names) {
    const k = spNorm(nm);
    let p = byKey.get(k);
    if (!p) { p = people.find((x) => sameOfficer(x.name, nm)); if (!p) people.push((p = { name: nm, at: {} })); byKey.set(k, p); }
    (p.at[m] ||= new Set()).add(post);
  }
  for (const p of people) {
    const pm = ms.filter((m) => p.at[m]);
    // 同じ月に2つの公館に名前があるとき（発令の前後・兼務など）は、その後の月に多く出てくる方（異動先）をその月の公館にする
    const future = (k, post) => pm.slice(k + 1).filter((m) => p.at[m].has(post)).length;
    const seq = pm.map((m, k) => {
      const ps = [...p.at[m]];
      return { m, post: ps.length === 1 ? ps[0] : ps.sort((a, b) => future(k, b) - future(k, a) || jaCmp(a, b))[0] };
    });
    // 続く同じ公館をまとめる
    let runs = [];
    for (const x of seq) { const last = runs[runs.length - 1]; if (last && last.post === x.post) last.to = x.m; else runs.push({ post: x.post, from: x.m, to: x.m, n: 1 }); if (runs[runs.length - 1].from !== x.m) runs[runs.length - 1].n++; }
    // A→B→A で B が1〜2か月だけのもの（配置表の書き方のゆれ）は、A にまとめる
    for (let changed = true; changed;) {
      changed = false;
      for (let k = 1; k < runs.length - 1; k++) if (runs[k - 1].post === runs[k + 1].post && runs[k].n <= 2) {
        runs.splice(k - 1, 3, { post: runs[k - 1].post, from: runs[k - 1].from, to: runs[k + 1].to, n: runs[k - 1].n + runs[k].n + runs[k + 1].n }); changed = true; break;
      }
    }
    p.posts = runs;
    delete p.at;
  }
  return people.sort((a, b) => (b.posts.length > 1) - (a.posts.length > 1) || jaCmp(a.name, b.name));
}
// 公館別サマリー（月報データから自動で作る。画面で書き換えて保存できる）。5行・10行・15行をその場で切り替えられる
// 医療事情を厚くする：数値は3行にまとめ、丙表の医療の記述に4行（感染症の動向・感染症と公衆衛生・医療機関・医薬品と医療体制）を使う
const SUMMARY_SIZES = [5, 10, 15];
const PDF_SUMMARY_LINES = 15;  // 期間のレポートで医療事情の行を取り出すときの行数
// PDFに載せる公館のサマリー（n行）。手で書いた・AIで作ったサマリーの行数が n と違うときは、
// n行の項目の順に、その項目の行があれば手で書いた文を、なければ自動作成の文を使う（項目名のない文なら先頭から n 行）
function pdfSummaryLines(m, r, n) {
  const auto = ruleSummary(m, r.post, n).split("\n");
  if (!(r.summaryManual && r.summary)) return auto;
  const man = r.summary.split("\n").map((l) => l.trim()).filter(Boolean);
  if (man.length <= n) return man;
  const labOf = (l) => (l.match(/^([^：:]{1,20})[：:]/) || [])[1];
  if (!man.some(labOf)) return man.slice(0, n);
  return summaryLabels(n).map((lab, i) => man.find((l) => labOf(l) === lab) || auto.find((l) => labOf(l) === lab) || auto[i]).filter(Boolean);
}
// PDFレポートの公館別サマリーの行数（PDFレポートのタブで選ぶ。はじめは5行）
const pdfSumLines = (v) => (SUMMARY_SIZES.includes(Number(v)) ? Number(v) : 5);
const summaryLines = () => (SUMMARY_SIZES.includes(loadPrefs().summaryLines) ? loadPrefs().summaryLines : 10);
const SUMMARY_LABELS5 = ["受診者数", "主な疾病", "医療・感染症", "邦人保護・緊急対応", "その他"];
const SUMMARY_LABELS15_EXTRA = ["受診者数の推移", "新着アラート", "緊急移送", "医療事情（その他）", "その他の報告"];
const SUMMARY_LABELS = ["受診者数", "主な疾病", "疾病分類", "感染症の動向", "感染症・公衆衛生", "医療機関", "医薬品・医療体制", "邦人保護・緊急対応", "巡回健診・医務官", "治安・災害・その他"];
const MED_HEAD = /医療|感染|衛生|保健|疾病|病院|薬|ワクチン|健康/;
const KW_PUBLIC = ["流行", "感染", "症例", "患者", "予防接種", "ワクチン", "蚊", "飲料水", "水道", "衛生", "注意喚起", "検疫", "WHO", "保健省"];
const KW_FACILITY = ["病院", "医療機関", "クリニック", "診療所", "病床", "救急", "ICU", "集中治療", "専門医", "検査", "手術", "透析", "医師", "看護", "受診先", "紹介"];
const KW_SUPPLY = ["医薬品", "薬", "在庫", "品薄", "不足", "供給", "医療費", "保険", "医療体制", "医療事情", "停電", "酸素", "血液", "輸血", "ストライキ"];
// 丙表を「見出しの下の文」に分け、医療の見出し（「1. 医療事情」など）の下の文に印を付ける
function heiSentences(hei) {
  const out = [];
  let med = false;
  for (const raw of nfkc(hei || "").split("\n")) {
    const line = raw.trim().replace(/^(?:[・●○■□◆◇\-*]|[(（]?\d{1,2}[)）.．、](?!\d))\s*/, "");
    if (!line) continue;
    if (line.length <= 14 && !line.includes("。")) { med = MED_HEAD.test(line); continue; }
    for (let t of sentences(raw)) {
      // 単独で読むと不自然な文頭のつなぎ言葉を外し、「特記事項なし」だけの文は使わない
      t = t.replace(/^(また|なお|さらに|一方|加えて|このほか|他方|その他)[、,]\s*/, "");
      if (/^(特記(すべき)?(事項)?(は|も)?(なし|無し|ない|ありません)|特になし|特に(問題|変化)(は)?(なし|ない))/.test(t) || t.length < 8) continue;
      out.push({ t, med });
    }
  }
  return out;
}
const summaryLabels = (n = summaryLines()) => (n === 5 ? SUMMARY_LABELS5 : n === 15 ? [...SUMMARY_LABELS, ...SUMMARY_LABELS15_EXTRA] : SUMMARY_LABELS);
// サマリーの文を自然な日本語にするための部品
const CAT_PHRASE = { "呼吸器": "呼吸器疾患", "消化器": "消化器疾患", "感染症": "感染症", "精神・行動": "精神・行動の障害", "皮膚": "皮膚疾患", "眼": "眼疾患",
  "耳": "耳の疾患", "筋骨格": "筋骨格系の疾患", "外傷・中毒": "外傷・中毒", "腎尿路生殖器": "腎尿路生殖器の疾患", "神経": "神経疾患",
  "内分泌・代謝": "内分泌・代謝疾患", "循環器": "循環器疾患", "新生物": "新生物（腫瘍）", "症状・徴候": "症状・徴候（診断名のつかないもの）", "分類不能": "分類不能の疾患" };
const catPhrase = (c) => CAT_PHRASE[shortCat(c)] || shortCat(c);
// 「A、B及びC」
const jaList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join("、")}及び${xs[xs.length - 1]}`);
// 文末を「。」でそろえる
const endS = (t) => (t ? t.replace(/[。．.\s]+$/, "") + "。" : "");
// 長い文は読点の位置で区切って「…」を付ける（語の途中で切らない）
function clipJa(t, n = 120) {
  if (!t) return "";
  t = t.replace(/。$/, "");
  if (t.length <= n) return t + "。";
  const cut = t.lastIndexOf("、", n - 1);
  return (cut > n * 0.5 ? t.slice(0, cut) : t.slice(0, n - 1)) + "…";
}
const OUTCOME_PHRASE = { "回復・退院": "回復・退院した", "入院中": "現在入院中である", "死亡": "死亡した", "帰国": "帰国した", "手術": "手術を受けた" };
function ruleSummary(m, post, n = summaryLines()) {
  const r = getReport(m, post);
  if (!r) return "";
  const pr = getReport(prevMonth(m), post);
  const has = (v) => v !== null && v !== undefined && v !== "";
  const L = (i, text) => `${SUMMARY_LABELS[i]}：${text || "特記なし"}`;
  const lines = [];
  // 1. 受診者数と前月比
  let visits = "";
  if (has(r.total)) {
    visits = `${r.total}名（職員${r.staff || 0}名、家族${r.family || 0}名、その他${r.other || 0}名）`;
    if (pr && has(pr.total)) {
      const d = r.total - pr.total, pct = pr.total ? `（${Math.abs(Math.round((100 * d) / pr.total))}%）` : "";
      visits += d === 0 ? `で、前月（${pr.total}名）と同数であった。` : `で、前月（${pr.total}名）から${Math.abs(d)}名${pct}${d > 0 ? "増加" : "減少"}した。`;
    } else visits += pr ? "であった。" : "であった（前月の月報なし）。";
  }
  lines.push(L(0, visits || "未記載"));
  // 2〜3. 乙表：主な疾病、疾病分類と検診・予防接種
  const agg = {}, cats = {};
  let zc = 0;
  for (const d of r.diseases || []) {
    const c = classify(d.name, d.cat);
    if (c === Z) { zc += d.count; continue; }
    if (PRIV_MENTAL && isMentalLike(d.name, c)) continue;
    agg[groupOf(d.name)] = (agg[groupOf(d.name)] || 0) + d.count;
    cats[c] = (cats[c] || 0) + d.count;
  }
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 3);
  lines.push(L(1, top.length === 1 ? `${top[0][0]}が${top[0][1]}件であった。` : top.length ? `${jaList(top.map(([k, v]) => `${k}${v}件`))}が多かった。` : ""));
  const tc = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 2);
  let catText = tc.length === 2 && tc[0][1] === tc[1][1] ? `${catPhrase(tc[0][0])}と${catPhrase(tc[1][0])}がそれぞれ${tc[0][1]}件で最も多かった。`
    : tc.length === 2 ? `${catPhrase(tc[0][0])}が${tc[0][1]}件で最も多く、次いで${catPhrase(tc[1][0])}が${tc[1][1]}件であった。`
    : tc.length ? `${catPhrase(tc[0][0])}が${tc[0][1]}件であった。` : "";
  if (zc) catText += `${catText ? "このほか、" : ""}検診・予防接種が${zc}件あった。`;
  lines.push(L(2, catText));
  // 4. 丙表の感染症（流行・増加／減少・終息／記載のみ）
  const obs = reportOutbreaks(r), byT = (t) => obs.filter((o) => o.trend === t).map((o) => o.name);
  const obText = [byT("流行・増加").length && `${jaList(byT("流行・増加"))}の流行・増加が報告されている。`,
    byT("減少・終息").length && `${jaList(byT("減少・終息"))}は減少・終息に向かっている。`,
    byT("言及").length && `${jaList(byT("言及"))}についての記載がある。`].filter(Boolean).join("");
  lines.push(L(3, obText));
  // 5〜10. 丙表の文から（同じ文は2度使わない）。医療の3行は長めに載せ、キーワードがなくても医療の見出しの下の文で埋める
  const ss = heiSentences(r.hei), used = new Set();
  // 邦人・館員の個別の事例（入院・移送など）は医療事情の行に使わず、邦人保護の行に回す
  const isCase0 = (s) => HOGO_RE.test(s.t) || (EVAC_RE.test(s.t) && !EVAC_NOT.test(s.t));
  // 事例の直後の短い文（「手術を受け回復した。」など経過だけの文）は、その事例の続きとして扱う
  ss.forEach((s, i) => { const nx = ss[i + 1]; if (nx && isCase0(s) && !isCase0(nx) && nx.t.length <= 40 && /回復|退院|軽快|手術|死亡|帰国|入院|転院/.test(nx.t)) nx.cont = s; });
  const isCase = (s) => isCase0(s) || !!s.cont;
  const pick = (kws, medical = false) => {
    const x = ss.find((s) => !used.has(s) && !(medical && isCase(s)) && kws.some((k) => s.t.includes(k)));
    if (x) used.add(x);
    return x;
  };
  const clip = (x, n = 120) => clipJa(x && (x.t || x), n);
  const infect = [...D.events["感染症"], ...KW_PUBLIC];
  const groups = [infect, KW_FACILITY, KW_SUPPLY], anyMed = groups.flat();
  // 同じ話題の短い文がもう1つあれば続けて載せる（1行120字まで）
  const joinMore = (x, kws) => {
    if (!x) return "";
    let t = endS(x.t);
    const y = ss.find((s) => !used.has(s) && !isCase(s) && kws.some((k) => s.t.includes(k)) && t.length + s.t.length <= 120);
    if (y) { used.add(y); t += endS(y.t); }
    return t;
  };
  const med = groups.map((kws) => pick(kws, true)).map((x, i) => joinMore(x, groups[i]));
  // 空いた医療の行は、医療の見出しの下の文、それでもなければ医療の語を含む残りの文で埋める
  for (let i = 0; i < 3; i++) if (!med[i]) {
    const x = ss.find((s) => s.med && !used.has(s) && !isCase(s)) || ss.find((s) => !used.has(s) && !isCase(s) && anyMed.some((k) => s.t.includes(k)));
    if (x) { used.add(x); med[i] = endS(x.t); }
  }
  med.forEach((t, i) => lines.push(L(4 + i, clip(t))));
  const hogo = pick(D.events["邦人保護"]);
  const hogoNext = hogo && ss.find((s) => s.cont === hogo && !used.has(s));
  if (hogoNext) used.add(hogoNext);
  lines.push(L(7, clip(hogo && endS(hogo.t) + (hogoNext ? endS(hogoNext.t) : ""), 140)));
  const junkai = pick(["巡回", "着任", "離任", "異動", "赴任", "帰国"]);
  lines.push(L(8, clip(junkai)));
  const other = pick([...D.events["治安・社会"], ...D.events["気象・災害"]]);
  lines.push(L(9, clip(other || ss.find((x) => !used.has(x)))));
  if (n === 5) {
    // 5行：受診者数、主な疾病、医療・感染症（流行の状況と医療の記述）、邦人保護、その他（巡回・医務官・治安・災害）
    let medText = "";
    for (const t of med.filter(Boolean)) if (!medText || medText.length + t.length <= 120) medText += t;
    // 医療の記述に流行の病名がすべて出ていれば、流行の文は重ねない
    const obPart = obs.length && !obs.every((o) => medText.includes(o.name)) ? obText : "";
    const M = (i, t) => `${SUMMARY_LABELS5[i]}：${t || "特記なし"}`;
    const body = (l) => l.slice(l.indexOf("：") + 1).replace(/^特記なし$/, "");
    return [M(0, body(lines[0])), M(1, body(lines[1])), M(2, clip(obPart + medText, 160)), M(3, body(lines[7])),
      M(4, clip([junkai, other].filter(Boolean).map((x) => endS(x.t)).join(""), 120))].join("\n");
  }
  if (n === 15) {
    // 15行：受診者数の推移・新着アラート・緊急移送・医療のその他の記述・その他の報告を足す
    const X = (i, t) => `${SUMMARY_LABELS15_EXTRA[i]}：${t || "特記なし"}`;
    const hist = [];
    for (let mm = m, k = 0; k < 4; k++, mm = prevMonth(mm)) { const x = getReport(mm, post); if (x && has(x.total)) hist.unshift(`${Number(mm.split("-")[1])}月${x.total}名`); }
    lines.push(X(0, hist.length > 1 ? `${hist.join("、")}と推移した。` : ""));
    lines.push(X(1, alertsOf(m).filter((a) => a.post === post).map((a) => a.kind === "丙表に新登場" ? `${a.name}が丙表に新たに記載された。`
      : a.kind === "乙表で急増" ? `${a.name}が乙表で急増した（${a.detail}）。` : `${a.name}が乙表に新たに計上された（${a.detail}）。`).join("")));
    const ev = casesOf(m, "evac").filter((c) => c.post === post);
    lines.push(X(2, ev.length ? `${ev.length}件。` + ev.map((c) => {
      const who = c.who || "患者", cond = c.cond ? `（${c.cond}）` : "", to = c.dest ? `${c.dest}へ` : "", by = c.means ? `${c.means}で` : "";
      return `${who}${cond}を${to}${by}緊急移送し${c.outcome ? "、" + (OUTCOME_PHRASE[c.outcome] || c.outcome) : "た"}。`;
    }).join("") : ""));
    const rest = (f) => { const xs = ss.filter((s) => !used.has(s) && f(s)); let t = ""; for (const x of xs) { if (t && t.length + x.t.length > 120) break; used.add(x); t += endS(x.t); } return t; };
    lines.push(X(3, clip(rest((s) => !isCase(s) && (s.med || anyMed.some((k) => s.t.includes(k)))))));
    lines.push(X(4, clip(rest(() => true))));
  }
  return lines.join("\n");
}
// 自動で作ったサマリー（以前の5行・10行の形も含む）は、開いたときに今の形で作り直す。手で書き換えたものはそのまま
const OLD_SUMMARY = [/^受診者数.*\n主な疾病：.*\n医療・感染症：.*\n邦人保護・緊急対応：.*\nその他：.*$/,
  /^受診者数：.*\n前月比：.*\n主な疾病：.*\n疾病分類：.*\n検診・予防接種：.*\n感染症の動向：.*\n医療事情：.*\n邦人保護・緊急対応：.*\n巡回健診・医務官：.*\n治安・災害・その他：.*$/];
// 自動作成のサマリーを作り直すのは、作り方（SUMMARY_RULES_V）・行数・月報の件数が変わったときだけ（起動のたびに全件を作り直すと遅い）
// 2：病名の切れ端（「血症」など）を載せない　3：ICD-10の分類名の分類を広げた
const SUMMARY_RULES_V = 3;
function upgradeSummaries(force = false) {
  const stamp = `${SUMMARY_RULES_V}|${summaryLines()}|${Object.keys(state.reports).length}`;
  if (!force && state.summaryStamp === stamp) return 0;
  state.summaryStamp = stamp;
  dropNameFragments();
  let n = 0;
  for (const r of Object.values(state.reports)) {
    if (!r.summary || r.summaryManual) continue;
    if (OLD_SUMMARY.some((re) => re.test(r.summary)) || r.summaryAuto) {
      const t = ruleSummary(r.month, r.post);
      if (t !== r.summary) { r.summary = t; n++; }
      r.summaryAuto = true;
    }
  }
  return n;
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
  // 概況は要点だけ：報告した公館の多い順に主なものを挙げ、公館名は4つまで（全部は各章・公館別サマリーにある）
  const top = (g, n, per = 4) => { const es = Object.entries(g).sort((a, b) => b[1].size - a[1].size || jaCmp(a[0], b[0]));
    return es.slice(0, n).map(([k, ps]) => `${k}（${[...ps].slice(0, per).join("・")}${ps.size > per ? `ほか${ps.size - per}公館` : ""}）`).join("／") + (es.length > n ? `／ほか${es.length - n}件` : ""); };
  if (Object.keys(ob).length) out.push(`丙表で流行・増加が報告された主な病気（${Object.keys(ob).length}種類）：` + top(ob, 8) + "。");
  const al = newAlerts(m).filter((a) => !(a.kind === "丙表に新登場" && ob[a.name] && ob[a.name].has(a.post)));   // 上の流行・増加と同じものは重ねない
  if (al.length) out.push(`前月からの新着アラート ${al.length}件（主なもの）：` + al.slice(0, 5).map((a) => `${a.post}の${a.name}（${a.kind}${a.kind === "丙表に新登場" ? "" : "、" + a.detail}）`).join("、") + (al.length > 5 ? " ほか" : "") + "。");
  for (const kind of ["気象・災害", "治安・社会"]) {
    const g = {};
    for (const e of ev.filter((e) => e.kind === kind)) (g[e.keyword] ||= new Set()).add(e.post);
    if (Object.keys(g).length) out.push(`${kind}：` + top(g, 6, 3) + "。");
  }
  const ev2 = casesOf(m, "evac"), hg = casesOf(m, "hogo");
  if (ev2.length) out.push(`緊急移送 ${ev2.length}件：` + ev2.slice(0, 8).map((c) => `${c.post}→${c.dest || "（行先不明）"}${[c.who, c.cond].filter(Boolean).length ? `（${[c.who, c.cond].filter(Boolean).join("・")}）` : ""}`).join("、") + (ev2.length > 8 ? " ほか" : "") + "。");
  if (hg.length) out.push(`邦人対応 ${hg.length}件（` + CASE_KINDS.map((k) => [k, hg.filter((c) => c.kind === k).length]).filter(([, v]) => v).map(([k, v]) => `${k}${v}`).join("・") + "）。");
  if (jk.length) { const js = [...new Set(jk.map((j) => `${j.from}→${j.dest || "（行先不明）"}`))];
    out.push(`巡回健診の報告 ${js.length}件：` + js.slice(0, 10).join("、") + (js.length > 10 ? " ほか" : "") + "。"); }
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
// 国名は、一覧・推移と同じ短い名前（韓国・タイ）にそろえる。公館のない国は地図データの名前
let ISO_SHORT = null;
const countryJa = (iso) => {
  if (!ISO_SHORT) { ISO_SHORT = {}; for (const [nm, inf] of Object.entries(INFO)) if (inf.iso3 && !/総領事館$/.test(nm) && !ISO_SHORT[inf.iso3]) ISO_SHORT[inf.iso3] = nm; }
  if (ISO_SHORT[iso]) return ISO_SHORT[iso];
  const c = PLACES && PLACES.countries.find((x) => x[4] === iso); return c ? c[0] : null;
};
const popLabel = (n) => (n >= 1e4 ? `約${Math.round(n / 1e4).toLocaleString()}万人` : `約${n.toLocaleString()}人`);
const LABEL_DETAIL_ZOOM = 1.8;   // これ以上拡大したら、すべての国名・首都名・都市名を出す
const BIG_CAPITAL = 5e6;          // 地球全体を見ているときも名前を出す首都の人口
// 国名・首都（★）・人口50万人以上の都市（●）。細かいものは拡大したときだけ出す（meta: "detail"＝約1.8倍以上、"detail2"＝約4.5倍以上）
// filled：疾病分類で色を塗った国（国コード）。その上の名前は白、塗っていない国の上は濃い色にして読みやすくする
function placeTraces(filled = new Set()) {
  if (!PLACES) return [];
  const dark = css("--text") || "#263238";
  const inkOf = (iso) => (filled.has(iso) ? "rgba(255,255,255,0.95)" : dark);
  // 暗い表示では、塗っていない国の上の名前も明るい色にする（暗い背景にとけないように）
  const softOf = (iso) => (filled.has(iso) ? "rgba(255,255,255,0.88)" : isDark() ? "rgba(220,228,236,0.92)" : "rgba(70,85,100,0.92)");
  // 細かい名前（meta: "detail"）は最初は隠しておき、拡大したら updateLabelDetail() で出す
  const T = (rows, extra) => Object.assign({ x: rows.map((r) => r[1]), y: rows.map((r) => r[2]), type: "scatter", showlegend: false }, extra, extra.meta ? { visible: false } : {});
  const C = PLACES.countries, cap = PLACES.capitals, city = PLACES.cities;
  const cd = (kind) => (r) => ({ kind, name: r[0], iso: r[4], pop: r[3], en: r[5] || "" });
  const capHover = (r) => `★ <b>${r[0]}</b>（首都）${countryJa(r[4]) ? "・" + countryJa(r[4]) : ""}<br>人口 ${popLabel(r[3])}<br><i>クリックで Wikipedia へのリンク</i>`;
  const cityHover = (r) => `● <b>${r[0]}</b>${countryJa(r[4]) ? "・" + countryJa(r[4]) : ""}<br>人口 ${popLabel(r[3])}<br><i>クリックで Wikipedia へのリンク</i>`;
  const major = C.filter((c) => c[3] <= 3), minor = C.filter((c) => c[3] > 3);
  const bigCap = cap.filter((r) => r[3] >= BIG_CAPITAL), smallCap = cap.filter((r) => r[3] < BIG_CAPITAL);
  return [
    T(major, { mode: "text", text: major.map((c) => c[0]), textfont: { size: 11, color: major.map((c) => softOf(c[4])) }, hoverinfo: "none", customdata: major.map((c) => ({ kind: "country", name: c[0], iso: c[4] })), name: "_国名" }),
    T(minor, { mode: "text", text: minor.map((c) => c[0]), textfont: { size: 10, color: minor.map((c) => softOf(c[4])) }, hoverinfo: "none", customdata: minor.map((c) => ({ kind: "country", name: c[0], iso: c[4] })), name: "_国名（小）", meta: "detail" }),
    // 都市（人口50万人以上）：●は300万人以上はいつも、それより小さい都市は拡大したとき。名前は100万人以上は拡大したとき、50万〜100万人はさらに拡大したとき
    ...[[city.filter((r) => r[3] >= 3e6), "_都市", undefined, 4.5], [city.filter((r) => r[3] < 3e6), "_都市（中）", "detail", 3.6]].map(([rows, name, meta, size]) =>
      T(rows, { mode: "markers", marker: { size, color: rows.map((r) => inkOf(r[4])), opacity: 0.85 }, text: rows.map(cityHover), hoverinfo: "text", customdata: rows.map(cd("city")), name, meta })),
    ...[[city.filter((r) => r[3] >= 1e6), "_都市名", "detail"], [city.filter((r) => r[3] < 1e6), "_都市名（小）", "detail2"]].map(([rows, name, meta]) =>
      T(rows, { mode: "text", text: rows.map((r) => r[0]), textposition: "top center", textfont: { size: 9, color: rows.map((r) => inkOf(r[4])) }, hovertext: rows.map(cityHover), hoverinfo: "text", customdata: rows.map(cd("city")), name, meta })),
    // 首都の★：人口100万人以上はいつも、それより小さい首都は拡大したときだけ（地球全体では欧州などが★だらけになるため）
    ...[[cap.filter((r) => r[3] >= 1e6), "_首都", undefined], [cap.filter((r) => r[3] < 1e6), "_首都（小）", "detail"]].map(([rows, name, meta]) =>
      T(rows, { mode: "markers", marker: { symbol: "star", size: 8, color: rows.map((r) => inkOf(r[4])), line: { color: rows.map((r) => (filled.has(r[4]) ? "#000" : "#fff")), width: 0.6 } },
        text: rows.map(capHover), hoverinfo: "text", customdata: rows.map(cd("capital")), name, meta })),
    T(bigCap, { mode: "text", text: bigCap.map((r) => r[0]), textposition: "bottom center", textfont: { size: 9.5, color: bigCap.map((r) => inkOf(r[4])) }, hovertext: bigCap.map(capHover), hoverinfo: "text", customdata: bigCap.map(cd("capital")), name: "_首都名" }),
    T(smallCap, { mode: "text", text: smallCap.map((r) => r[0]), textposition: "bottom center", textfont: { size: 9, color: smallCap.map((r) => inkOf(r[4])) }, hovertext: smallCap.map(capHover), hoverinfo: "text", customdata: smallCap.map(cd("capital")), name: "_首都名（小）", meta: "detail" }),
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
// ツアー中に自分で選んだカードは、海や何もない所にマウスを移したら（約0.5秒）、国歌が流れている国のカードに戻す
// （カードの上にマウスを移したとき・別の国や都市に載せたときは戻さない）
let tourCardBackTimer = null;
// ツアー以外では、海や何もない所の上にマウスを置いたら（約0.5秒）カードを閉じる（カードの上・地図の外にマウスがあるときは閉じない）
let seaCloseTimer = null;
function scheduleSeaClose(map, ms = 500) {
  clearTimeout(seaCloseTimer);
  const c = $("#postcard");
  if (touring || !c || c.hidden) return;
  seaCloseTimer = setTimeout(() => {
    const c2 = $("#postcard");
    if (touring || !c2 || c2.hidden || c2.matches(":hover") || !map.matches(":hover") || map.classList.contains("pc-hover")) return;
    closePostCard(true);
  }, ms);
}
function scheduleTourCardBack(ms = 500) {
  clearTimeout(tourCardBackTimer);
  if (!touring || !tour || !tour.userCard || !tour.cardPost) return;
  tourCardBackTimer = setTimeout(() => {
    const c = $("#postcard");
    if (!touring || !tour || !tour.userCard || !tour.cardPost || (c && c.matches(":hover"))) return;
    tour.userCard = false;
    openPostCard([tour.cardPost], tour.m);
  }, ms);
}
// 国・首都・都市のカードの「国歌を聞く」（その国の国歌）。公館マスタにある国はその名前、ない国は国コードで流す
const anthemKey = (iso) => (ISO_NAME[iso] ? ISO_NAME[iso] : `iso:${iso}`);
const anthemBtnHtml = (iso) => (iso ? `<button class="anthem-btn" data-anthem="${esc(anthemKey(iso))}" title="この国の国歌を流します（登録した録音、なければ楽譜データからの演奏、なければ地域の音楽）">🎵 国歌を聞く</button>` : "");
// マウスを載せたものから、開くカードを決める（公館の印・国・首都・都市）

function hoverTarget(pt) {
  if (!pt) return null;
  const cd = pt.customdata;
  // 国は国名の文字の上でも国の形の上でも同じもの（国コードで見分ける）
  if (cd && typeof cd === "object" && cd.kind) return { key: cd.kind === "country" && cd.iso ? `country:${cd.iso}` : `${cd.kind}:${cd.name}`, open: () => openPlaceCard(cd) };
  if (typeof cd === "string" && INFO[cd]) return { key: `post:${cd}`, open: () => openPostCard([cd]) };
  const iso = pt.location;
  if (!iso) return null;
  const posts = postsInCountry(iso);
  return { key: `country:${iso}`, open: () => (posts.length ? openPostCard(posts) : openPlaceCard({ kind: "country", iso, name: countryJa(iso) || (GEO && ((GEO.features.find((f) => f.id === iso) || {}).properties || {}).name) || iso })) };
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
    <h3>${p.kind === "capital" ? "★ " : p.kind === "city" ? "● " : ""}${esc(p.name)} ${country && p.kind !== "country" ? `<span class="muted">${esc(country)}</span>` : ""}${anthemBtnHtml(p.iso)}</h3>
    ${p.iso ? `<div class="pc-anthem muted" data-anthem-info="${esc(anthemKey(p.iso))}"></div>` : ""}
    ${p.pop ? `<p>人口 ${popLabel(p.pop)}<span class="muted">（Natural Earth の推計）</span></p>` : ""}
    ${p.kind === "country" ? '<p class="muted">この国の月報はありません（公館がない、または巡回先の国）。</p>' : ""}
    <div class="pcblock pclinks"><div class="muted">リンク（インターネットが必要です）</div>
      <div>${a(wikiUrl(p.name), `📖 Wikipedia「${esc(p.name)}」`)}</div>
      ${p.kind !== "country" && country ? `<div>${a(wikiUrl(country), `📖 Wikipedia「${esc(country)}」`)}</div>` : ""}</div>
    ${posts.length ? `<div class="pcblock"><button class="linklike" data-place-posts="${esc(posts.join("|"))}">この国の公館カードを開く（${esc(posts.join("・"))}）</button></div>` : ""}
  </section>`;
  el.hidden = false;
  placeCard(el);
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
// PDFで地域・国を選んでいるときは、その範囲に地図を寄せる（世界全体のままだと、島しょ国などが小さすぎて見えない）
function scopedMap(layout) {
  if (!scopedView) return layout;
  const pts = [...new Set(Object.values(state.reports).map((r) => r.post))].map(coord).filter(Boolean);
  if (!pts.length) return layout;
  let lons = pts.map((p) => p[1]);
  // 日付変更線をまたぐ（大洋州など）ときは、西経を +360 にして連続させる
  if (Math.max(...lons) - Math.min(...lons) > 180) lons = lons.map((x) => (x < 0 ? x + 360 : x));
  const lats = pts.map((p) => p[0]);
  let [x0, x1] = [Math.min(...lons), Math.max(...lons)], [y0, y1] = [Math.min(...lats), Math.max(...lats)];
  // 公館の位置（首都）だけでなく国の広がりも入るよう、余白を広めにとり、地図の枠（横長）に合わせる
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let w = Math.max(60, (x1 - x0) * 1.6 + 20), h = Math.max(36, (y1 - y0) * 1.5 + 16);
  if (h > w * 0.55) w = h / 0.55; else h = w * 0.55;
  const geo = layout.geo;
  geo.projection = { ...geo.projection, rotation: { lon: cx > 180 ? cx - 360 : cx, lat: 0 } };
  geo.lonaxis = { ...(geo.lonaxis || {}), range: [cx - w / 2, cx + w / 2].map((x) => (x > 180 ? x - 360 : x)) };
  geo.lataxis = { ...(geo.lataxis || {}), range: [Math.max(-85, cy - h / 2), Math.min(85, cy + h / 2)] };
  geo.fitbounds = false;
  return layout;
}
function mapLayout(height = 560, forExport = false, flat = null) {
  const v = view();
  const globe = flat === null ? v.style === "globe" : !flat;
  const grid = { showgrid: globe, gridcolor: "rgba(120,140,160,.25)", gridwidth: 0.5 };
  return {
    // ドラッグは bindMapInteraction() で自前処理する（地球儀は回転、平面は東西に回すだけ）。Plotly の平行移動は使わない
    height, margin: { l: 0, r: 0, t: 10, b: 0 }, hovermode: "closest", dragmode: false,
    geo: {
      projection: { type: globe ? "orthographic" : "natural earth", rotation: { lon: globe ? v.lon : forExport ? 0 : v.flatLon || 0, lat: globe ? v.lat : 0 } },
      // 地球儀は中心＝回転の向きに固定する（ずれると地球儀が画面の中で横にずれて欠ける）
      ...(globe ? { center: { lon: v.lon, lat: v.lat } } : {}),
      showland: true, landcolor: forExport ? "#dde3ea" : css("--land") || "#dde3ea",
      showocean: true, oceancolor: forExport ? "#eef4f8" : css("--ocean") || "#e4eef5",
      showcountries: true, countrycolor: forExport ? "#ffffff" : css("--surface") || "#ffffff", countrywidth: 0.5,
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
  return Plotly.react(el, data, mapLayout(height), MAP_CONFIG).then(() => {
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
    // 国・首都・都市・公館の印にマウスを載せたら指の形にして、クリックできることを示す（カードはクリックで開く）
    el.on("plotly_hover", (e) => {
      clearTimeout(el._unhoverTimer);   // 対象が入れ替わっただけ（Plotly は入れ替わるたびに「離れた」を送る）なら、離れた扱いにしない
      const on = !!hoverTarget(e.points && e.points[0]);
      el.classList.toggle("pc-hover", on);
      if (on) { clearTimeout(tourCardBackTimer); clearTimeout(seaCloseTimer); }
    });
    el.on("plotly_unhover", () => {
      clearTimeout(el._unhoverTimer);
      el._unhoverTimer = setTimeout(() => { el.classList.remove("pc-hover"); if (touring) scheduleTourCardBack(); else scheduleSeaClose(el); }, 120);
    });
    // 国や印をクリックすると公館カードを開く
    el.on("plotly_click", (e) => {
      if (suppressClick) return;
      const pt = e.points && e.points[0];
      if (!pt) return;
      // ツアー中に自分で選んだときは、そのカードを出す。次の国に着いたら、その国のカードに替わる（カードを隠していても出す）
      if (touring && tour && hoverTarget(pt)) {
        tour.cardOn = true;
        tour.userCard = true;   // 自分で選んだカード（海などにマウスを移すと、ツアーの国のカードに戻す）
        const cb = document.querySelector("#tourbox [data-t=card]");
        if (cb) cb.textContent = "🗂 カードを隠す";
      }
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
// （広げないと、拡大したとき左右が縦にすっぱり切れて見える）。乗り物の重ね絵も同じ範囲になる
function widenGeoClip(el) {
  if (!el._fullLayout || !el._fullLayout.geo || el._fullLayout.geo.projection.type !== "orthographic") return;
  const r = el.querySelector('clipPath[id$="geo"] rect'), W = el._fullLayout.width, H = el._fullLayout.height;
  if (r && (+r.getAttribute("width") !== W || +r.getAttribute("height") !== H)) { r.setAttribute("x", 0); r.setAttribute("y", 0); r.setAttribute("width", W); r.setAttribute("height", H); }
  // 国の形などは地図の投影法（d3）の切り抜き範囲でも切られるので、そちらも広げる
  const g = el._fullLayout.geo && el._fullLayout.geo._subplot, p = g && g.projection;
  // マウス（ドラッグ・指の形・クリック）を受ける背景も地図全体に広げる（広げないと四角い枠の外の左右がつかめない）
  const bg = g && g.bgRect && g.bgRect.node();
  if (bg && (+bg.getAttribute("width") !== W || +bg.getAttribute("x") !== 0)) {
    const sz = el._fullLayout._size;
    bg.setAttribute("x", 0); bg.setAttribute("width", W);
    bg.setAttribute("y", 0); bg.setAttribute("height", sz ? sz.t + sz.h : H);
  }
  // Plotly はマウスの位置が四角い枠（xaxis/yaxis の _offset・_length）の外だと反応しないので、枠を地図全体に合わせる
  if (g && g.xaxis && g.yaxis && (g.xaxis._offset !== 0 || g.xaxis._length !== W)) {
    const sz = el._fullLayout._size;
    g.xaxis._offset = 0; g.xaxis._length = W;
    g.yaxis._offset = 0; g.yaxis._length = sz ? sz.t + sz.h : H;
  }
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
  const inMap = (e) => !e.target.closest(".modebar, .legend, .planes") && (e.target.closest(".geo, .geolayer, .bglayer, svg") || e.target.classList.contains("svg-container"));
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
      // （国・首都・都市・公館の印＝指の形の所をクリックしたときは、カードを開くだけで止めない）
      else if (touring && e.type === "pointerup" && !el.classList.contains("pc-hover") && typeof tour !== "undefined" && tour && !tour.paused && tour.playing) pauseTour("地図をクリックしたので一時停止しました");
    }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  // 地図の上で押して地図の外で離したときも、押したままの状態を解く（解かないとマウスを載せてもカードが開かなくなる）
  addEventListener("pointerup", (e) => { if (pts.has(e.pointerId) && !el.contains(e.target)) end({ pointerId: e.pointerId, type: "pointercancel" }); });
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
  return [...ps].sort(jaCmp);
}

// 地球儀／平面の切り替えと向きのボタン。ページ内のすべての地図に効く
function mapControls() {
  const v = view();
  return `<div class="row mapctl">
    <span class="seg"><button data-style="flat" class="${v.style === "flat" ? "on" : ""}">平面</button><button data-style="globe" class="${v.style === "globe" ? "on" : ""}">🌐 地球儀</button></span>
    <span class="seg rots"${v.style === "flat" ? " hidden" : ""}>${ROT_LABELS.map(([k, l]) => `<button data-rot="${k}" class="${v.rot === k ? "on" : ""}">${l}</button>`).join("")}</span>
  </div>`;
}
function applyMapView() {
    const v = view(), globe = v.style === "globe";
    savePref("mapView", v);
    document.querySelectorAll(".mapctl [data-style]").forEach((b) => b.classList.toggle("on", b.dataset.style === v.style));
    document.querySelectorAll(".mapctl .rots").forEach((x) => (x.hidden = !globe));
    // 投影法を変えると地図の縦横比も変わるので、部分更新ではなく描き直す
    document.querySelectorAll(".js-plotly-plot").forEach((el) => {
      if (!el.layout || !el.layout.geo) return;
      Plotly.react(el, el.data, mapLayout(el.layout.height), MAP_CONFIG).then(() => markPulse(el));
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
    for (const r of countryDominant(opt.dis || diseasesOf(m))) {
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
      text: rs.map((r) => `<b>${r.post}</b><br>医務官: ${r.officer || "―"}<br>受診者数: ${r.total}名<br><i>クリックで公館カード</i>`), hoverinfo: "text",
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
    textposition: "top center", textfont: { size: 11, color: isDark() ? "#ff8a80" : "#7a0016" },
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

// 月報のある最新の月（月報がなければ、配置表を含めた最新の月）
const latestMonth = () => { const r = [...new Set(Object.values(state.reports).map((x) => x.month))].sort(); const ms = months(); return r[r.length - 1] || ms[ms.length - 1] || null; };
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
  light: { "アジア・大洋州": "#2a78d6", "アフリカ": "#eb6834", "ヨーロッパ": "#1baf7a", "中東": "#eda100", "米州": "#e87ba4", "アジア": "#2a78d6", "大洋州": "#17a2b8", "北米": "#8e5bd0", "中南米": "#e87ba4" },
  dark: { "アジア・大洋州": "#3987e5", "アフリカ": "#d95926", "ヨーロッパ": "#199e70", "中東": "#c98500", "米州": "#d55181", "アジア": "#3987e5", "大洋州": "#1fb5cc", "北米": "#9d6fe0", "中南米": "#d55181" },
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
// 画面の下の方のグラフは、近くまでスクロールしたときに描く（タブを開くのを速くする）。描くまでは高さだけ取っておく
const lazyPlotObs = "IntersectionObserver" in window ? new IntersectionObserver((ents) => {
  for (const e of ents) if (e.isIntersecting) { lazyPlotObs.unobserve(e.target); const f = e.target._lazyPlot; e.target._lazyPlot = null; if (f) f(); }
}, { rootMargin: "800px 0px" }) : null;
let lazyPlotOn = true;
// タブを替えたとき：描く前のグラフの見張りをやめる
// 見えているグラフも、タブの画面を先に出してから1つずつ順に描く（タブを押してから画面が替わるまでを速く）
let plotChain = Promise.resolve(), plotGen = 0;
const lazyPlotReset = () => { if (lazyPlotObs) lazyPlotObs.disconnect(); plotGen++; plotChain = Promise.resolve(); };
function plot(el, traces, layout, config = {}) {
  const base = { paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: css("--text"), family: "inherit" },
    margin: { l: 90, r: 20, t: 56, b: 40 }, template: chartTemplate() };
  const node = typeof el === "string" ? document.getElementById(el) : el;
  // 月の横軸（「2025年9月」…）は、目盛りを横書きで短くして切れないようにする（ヒートマップ以外）
  const mt = traces[0] && traces[0].type !== "heatmap" ? monthTickAxis(traces[0].x || []) : null;
  if (mt) layout = Object.assign({}, layout, { xaxis: Object.assign({}, mt, (layout && layout.xaxis) || {}) });
  const draw = () => { if (node) node.style.minHeight = ""; return Plotly.newPlot(node || el, traces, Object.assign(base, layout), Object.assign({ responsive: true, displaylogo: false }, config)); };
  if (!lazyPlotOn || !node || !node.isConnected) return draw();
  if (!lazyPlotObs || node.getBoundingClientRect().top < innerHeight + 200) {
    const gen = plotGen;
    node.style.minHeight = `${(layout && layout.height) || 450}px`;
    return new Promise((ok, ng) => {
      plotChain = plotChain.then(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))))
        .then(() => (gen === plotGen && node.isConnected ? draw().then(ok, ng) : ok(node)));
    });
  }
  return new Promise((ok, ng) => {
    node.style.minHeight = `${(layout && layout.height) || 450}px`;
    node._lazyPlot = () => draw().then(ok, ng);
    lazyPlotObs.observe(node);
  });
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
  fixReportRegions();
  // 出来事・巡回健診・サマリーは取り込みと同じ処理で作る
  for (const r of Object.values(state.reports)) {
    r.events = detectEvents(r.hei);
    (state.junkai[r.month] ||= []).push(...detectJunkai(r.hei, r.post));
  }
  for (const r of Object.values(state.reports)) { r.summary = ruleSummary(r.month, r.post); r.summaryAuto = true; }
  // デモの配置表：異動は配置表から読むので、最新の配置表をもとに、それより前の月の配置表を架空の月報の医務官名から作る
  const rk = Object.keys(state.rosters || {}).sort(), tplKey = rk[rk.length - 1], tpl = tplKey ? state.rosters[tplKey] : null;
  if (tpl) for (const m of [...new Set(Object.values(state.reports).map((r) => r.month))].filter((m) => m < rosterKeyMonth(tplKey))) {
    if (state.rosters[m]) continue;
    const rows = tpl.map((row) => {
      const r = getReport(m, row.post), nm = r && r.officer;
      if (!nm || !row.staffed || nm === row.officer) return { ...row };
      const { officers, kana, ...rest } = row;
      return { ...rest, officer: nm, staffed: true };
    });
    rows.sheetMonth = m; state.rosters[m] = rows;
  }
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
  refreshMonths(latestMonth());
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
  let o;
  try { o = JSON.parse(text); } catch { throw new Error("月報くんのバックアップのファイルではないか、壊れています"); }
  if (!o || typeof o !== "object") throw new Error("月報くんのバックアップのファイルではありません");
  if (o.format !== "geppou-backup-encrypted") return o;  // 以前の暗号化していないバックアップもそのまま読める
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, await backupKey(unb64(o.salt)), unb64(o.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new Error("復号できませんでした（ファイルが壊れているか、別のパスワードで作られています）"); }
}
// バックアップのファイル名は日時入り（1日に何回もバックアップしても、どれが最新か分かるように）：月報くん_2026-10-28_14-32-05.geppou
const pad2 = (n) => String(n).padStart(2, "0");
const backupFileName = (t = Date.now()) => { const d = new Date(t); return `月報くん_${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}.geppou`; };
// ファイル名の日時 → ミリ秒（以前の名前「geppou_backup_2026-10-28.geppou」も読む）
function backupTimeOf(name) {
  const m = String(name).match(/(20\d{2})-(\d{2})-(\d{2})(?:_(\d{2})-(\d{2})-(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime() : 0;
}
// download=true：設定の「書き出し」（いつもファイルとしてダウンロードする）
async function exportBackup(download = false) {
  if (demoMode) { toast("デモ表示中はバックアップしません"); return; }
  if (download) return downloadBackup();
  // 「💾 バックアップ」は、月報くんの「バックアップ」フォルダに保存する。まだつないでいなければ、ここで1回だけフォルダを選ぶ
  if (!bkdir.handle && bkdirSupported()) {
    toast("保存先として、月報くんの「バックアップ」フォルダを選んでください（次からは自動でそこに保存します）");
    if (await bkdirChoose(false)) { const bar = $("#bkdirbar"); if (bar) bar.hidden = true; }
  }
  // つないだフォルダがあるのに使えないとき（ブラウザを開き直すと、もう一度許可が要る）は、ここで許可を求める。
  // 許可されない・フォルダが移動などで使えないときは、黙ってダウンロードにせず、知らせてフォルダを選び直してもらう
  if (bkdir.handle && bkdirSupported()) {
    // 許可が外れていれば（ブラウザを開き直したあとなど）、すぐにフォルダを選ぶ画面を開いて選び直してもらう（選ぶと書き込みも許可される）
    if (!bkdir.ok) bkdir.ok = (await bkdirPermission(bkdir.handle, false)) || (await bkdirChoose(false));
    const allowed = bkdir.ok;
    if (allowed && await backupToFolder(true)) { const bar = $("#bkdirbar"); if (bar) bar.hidden = true; return; }
    bkdirTrouble(allowed ? "フォルダが移動・名前の変更・同期などで使えなくなった可能性があります" : "書き込みが許可されませんでした");
    return;
  } else if (await backupToFolder(true)) return;
  // フォルダに保存できないとき（Chrome・Edge 以外、フォルダを選ばなかったとき）は、ダウンロードする
  return downloadBackup();
}
async function downloadBackup() {
  const t = Date.now();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([await encryptBackup(state)], { type: "application/octet-stream" }));
  a.download = backupFileName(t);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  savePref("lastBackup", t);
  toast("暗号化したバックアップを書き出しました。月報くんの「バックアップ」フォルダ（医務官のみがアクセスできる場所）に保存してください");
  updateBackupBar();
}
const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
const fmtDateTime = (t) => { const d = new Date(t); return `${fmtDate(t)} ${d.getHours()}:${pad2(d.getMinutes())}`; };
function backupStatusText() {
  const p = loadPrefs();
  if (!p.lastBackup) return "まだバックアップを書き出していません。";
  const days = Math.floor((Date.now() - p.lastBackup) / 864e5);
  return `最後のバックアップ：${fmtDateTime(p.lastBackup)}（${days ? days + "日前" : "今日"}${p.lastBackupFile ? `・${p.lastBackupFile}` : ""}）` + (p.lastChange > p.lastBackup ? "。その後に変更があります。" : "。その後の変更はありません。");
}

// ---- バックアップフォルダ（月報くん／バックアップ）：一度つなぐと、変更のたびに自動で保存し、開いたときは最新のものを自動で読み込む
// ブラウザの「フォルダへの書き込み」の機能（Chrome・Edge）を使う。フォルダの場所はこのブラウザの中にだけ覚える
const bkdir = { handle: null, ok: false, timer: null, busy: false };
const bkdirSupported = () => "showDirectoryPicker" in window;
async function bkdirPermission(h, ask) {
  const o = { mode: "readwrite" };
  try {
    if ((await h.queryPermission(o)) === "granted") return true;
    if (!ask) return false;
    const r = await h.requestPermission(o);
    if (r !== "granted") logError("バックアップ", `フォルダ「${h.name}」への書き込みが許可されませんでした（${r}）`, "bkdirPermission");
    return r === "granted";
  } catch (e) { logError("バックアップ", `フォルダ「${h && h.name}」の許可を確かめられません：${e.message}`, "bkdirPermission"); return false; }
}
// sync=false：「💾 バックアップ」から選んだとき（フォルダの中身は読み込まず、いまのデータを保存する）
async function bkdirChoose(sync = true) {
  if (!bkdirSupported()) { alert("このブラウザ（または組織の設定）では、フォルダへの保存が使えません。Chrome か Edge で開くか、設定タブの「書き出し」でバックアップをファイルとして保存してください。"); return false; }
  let h;
  // フォルダを選ぶ画面は、ボタンを押してすぐに開く（ほかの処理を待ってからだと、ブラウザが開かせないことがある）。前につないだフォルダから開く
  toast("フォルダを選ぶ画面を開きます…（月報くんの「バックアップ」フォルダを選び、「編集を許可」を押してください）");
  try {
    const o = { id: "geppou-backup", mode: "readwrite" };
    if (bkdir.handle) o.startIn = bkdir.handle;
    try { h = await window.showDirectoryPicker(o); }
    catch (e) { if (e && e.name !== "AbortError" && o.startIn) { delete o.startIn; h = await window.showDirectoryPicker(o); } else throw e; }   // 前のフォルダがもうないとき
  } catch (e) {
    bkdir.lastErr = e && e.name === "AbortError" ? "フォルダを選ぶ画面が閉じられました（フォルダを選ばずに閉じたか、ブラウザが画面を開かせませんでした）" : `フォルダを選ぶ画面を開けませんでした（${(e && e.name) || ""} ${(e && e.message) || ""}）`;
    if (e && e.name === "AbortError") logError("バックアップ", "フォルダを選ぶ画面が閉じられました（AbortError）", "bkdirChoose");
    if (e && e.name !== "AbortError") {
      logError("バックアップ", `フォルダを選ぶ画面を開けません：${e.name} ${e.message}`, "bkdirChoose");
      // よくある原因：組織のChromeの設定でフォルダへの書き込みが止められている／別のページ（Teams・SharePoint など）の中で開いている
      const why = window.top !== window ? "アプリが別のページの中で開かれているため" : /NotAllowed|Security/.test(e.name) ? "組織のブラウザの設定で、フォルダへの保存が止められている可能性があります" : e.message;
      alert(`フォルダを選ぶ画面を開けませんでした（${why}）。\n\n・Chrome のアドレス欄から月報くんを直接開いて（タブで）、もう一度押してください。\n・それでも開けないときは、組織の設定でこの機能が使えない可能性があります。設定タブの「書き出し」でバックアップをファイルとして保存し、医務官のみがアクセスできるフォルダに置いてください。\n\n（詳しい内容は 設定 →「動作の記録」に残しました：${e.name}）`);
    }
    return false;
  }
  if (!(await bkdirPermission(h, true))) { toast("フォルダへの書き込みが許可されませんでした"); return false; }
  bkdir.handle = h; bkdir.ok = true;
  await idb.set("backupDir", h);
  savePref("backupDirName", h.name);
  toast(`バックアップフォルダ「${h.name}」につなぎました。これから変更のたびに自動で保存します`);
  if (sync) { try { await bkdirSync(true); } catch (e) { logError("バックアップ", `選んだフォルダ「${h.name}」を読めません：${e.name} ${e.message}`, "bkdirChoose"); } }
  return true;
}
// フォルダの中のバックアップ（新しい順）
async function bkdirList() {
  const out = [];
  for await (const [name, e] of bkdir.handle.entries()) if (e.kind === "file" && /\.geppou$/i.test(name)) out.push({ name, e, t: backupTimeOf(name) });
  for (const x of out) if (!x.t) { try { x.t = (await x.e.getFile()).lastModified; } catch {} }
  return out.sort((a, b) => b.t - a.t || b.name.localeCompare(a.name));
}
// フォルダへ保存する。manual は「💾 バックアップ」を押したとき（変更がなくても保存する）
// つないだフォルダが見つからない（NotFoundError）ときの説明
const BKDIR_GONE = (name) => `つないでいたフォルダ「${name}」が見つかりません。フォルダを移動・名前の変更・削除したか、OneDrive・SharePoint の同期で作り直された可能性があります。もう一度、月報くんの「バックアップ」フォルダを選んでください（何度も起きるときは、同期していないパソコンの中のフォルダ〔医務官のみがアクセスできる場所〕に「月報くん」フォルダを置くと安定します）`;
// バックアップフォルダに保存できないとき：黙ってダウンロードにせず、画面の真ん中に窓を出して、
// その場で「フォルダを選んでつなぐ」（押すとすぐに選ぶ画面）か「ファイルとして書き出す」を選んでもらう（上の帯は、下までスクロールしていると見えないため）
function bkdirTrouble(why) {
  const bar = $("#bkdirbar"), name = bkdir.handle ? bkdir.handle.name : "";
  const detail = bkdir.lastErr || why;
  bkdir.lastErr = "";
  logError("バックアップ", `フォルダ「${name}」に保存できません：${detail}`, "exportBackup");
  if (bar) { $("#bkdirmsg").textContent = `バックアップフォルダ「${name}」に保存できませんでした。「📁 バックアップフォルダを選んでつなぐ」を押して、フォルダを選んでください。`; bar.hidden = false; }
  const dlg = document.createElement("dialog");
  dlg.className = "notice bkdlg";
  dlg.innerHTML = `<h2>💾 バックアップフォルダに保存できませんでした</h2>
    <p>${name ? `つないでいたフォルダ：<b>${esc(name)}</b><br>` : ""}理由：${esc(detail)}</p>
    <p class="muted">下の「📁 フォルダを選んでつなぐ」を押すと、フォルダを選ぶ画面が開きます。月報くんの「バックアップ」フォルダを選び、「編集を許可」を押してください。選ぶ画面が開かないときは、組織のブラウザの設定でこの機能が使えない可能性があります。その場合は「ファイルとして書き出す」で保存し、医務官のみがアクセスできるフォルダに置いてください。</p>
    <div class="row" style="margin-top:12px"><button class="primary" data-bk="pick">📁 フォルダを選んでつなぐ</button><button data-bk="dl">ファイルとして書き出す</button><button data-bk="close">閉じる</button></div>`;
  document.body.appendChild(dlg);
  const done = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-bk="pick"]').onclick = async () => {
    done();
    if (await bkdirChoose(false) && await backupToFolder(true)) { if (bar) bar.hidden = true; return; }
    // 選ぶ画面を自分で閉じたときは、もう一度は出さない
    if (bkdir.lastErr && !/閉じられました/.test(bkdir.lastErr)) bkdirTrouble("フォルダを選べませんでした");
  };
  dlg.querySelector('[data-bk="dl"]').onclick = async () => { done(); await downloadBackup(); };
  dlg.querySelector('[data-bk="close"]').onclick = done;
  dlg.oncancel = (e) => { e.preventDefault(); done(); };
  dlg.showModal();
}
async function backupToFolder(manual = false) {
  if (manual) for (let k = 0; bkdir.busy && k < 100; k++) await new Promise((ok) => setTimeout(ok, 200));   // 自動のバックアップの途中なら終わるまで待つ
  if (!bkdir.handle || demoMode || bkdir.busy) return false;
  if (!bkdir.ok && !(bkdir.ok = await bkdirPermission(bkdir.handle, manual))) return false;
  const p = loadPrefs();
  if (!manual && !(p.lastChange > (p.lastBackup || 0))) return true;
  bkdir.busy = true;
  try {
    const t = Date.now(), name = backupFileName(t);
    const fh = await bkdir.handle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(await encryptBackup(state));
    await w.close();
    savePref("lastBackup", t); savePref("lastBackupFile", name);
    if (manual) toast(`バックアップしました：${bkdir.handle.name}／${name}`);
    updateBackupBar();
    return true;
  } catch (e) {
    console.warn("backup folder", e);
    logError("バックアップ", `フォルダ「${bkdir.handle.name}」に書き込めません：${e.name} ${e.message}`, "backupToFolder");
    if (e && e.name === "NotFoundError") bkdir.lastErr = BKDIR_GONE(bkdir.handle.name);
    bkdir.ok = false;
    toast("バックアップフォルダに保存できませんでした（" + e.message + "）");
    return false;
  } finally { bkdir.busy = false; }
}
// 変更があったら、少し待ってから自動で保存する（続けて変更するときに何個も作らないように）
function scheduleAutoBackup() {
  if (!bkdir.handle || demoMode) return;
  clearTimeout(bkdir.timer);
  bkdir.timer = setTimeout(() => backupToFolder(false), 60000);
}
// タブを閉じる・切り替えるときは、待たずに保存する
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && bkdir.handle && bkdir.ok) { clearTimeout(bkdir.timer); backupToFolder(false); } });
// つないだとき・開いたとき：フォルダの最新のバックアップが、このブラウザで最後に保存・読み込みしたものと違えば読み込む
async function bkdirSync(afterChoose = false) {
  const list = await bkdirList();
  const p = loadPrefs(), latest = list[0];
  const hasLocal = Object.keys(state.reports).length > 0;
  if (!latest) { if (hasLocal) await backupToFolder(true); return; }
  if (latest.name === p.lastBackupFile) return;
  // このブラウザの方が新しい（フォルダの最新より後に変更した）ときは、上書きせずにこちらを保存する
  if (hasLocal && (p.lastChange || 0) > latest.t) {
    if (afterChoose || confirm(`バックアップフォルダの最新（${fmtDateTime(latest.t)}）より、このブラウザのデータの方が新しいようです。\n\n「OK」：このブラウザのデータをフォルダに保存する（おすすめ）\n「キャンセル」：フォルダの最新のバックアップを読み込む`)) { await backupToFolder(true); return; }
  }
  try {
    const s = await decryptBackup(await (await latest.e.getFile()).text());
    if (!s.reports) throw new Error("形式が違います");
    state = Object.assign({ reports: {}, rosters: {}, junkai: {}, overrides: {}, groups: {}, cases: {} }, s);
    clearCaches();
    try { await writeState(state); } catch {}
    savePref("lastBackup", latest.t); savePref("lastBackupFile", latest.name); savePref("lastChange", latest.t);
    refreshMonths(); render();
    toast(`バックアップフォルダの最新のデータ（${fmtDateTime(latest.t)}）を読み込みました`);
  } catch (e) { toast(`最新のバックアップ（${latest.name}）を読み込めませんでした：${e.message}`); }
}
// 「月報くん」フォルダ（zip）：ダブルクリックで開くショートカット・バックアップフォルダ・説明書き
async function makeAppFolderZip() {
  const url = new URL("./", location.href).href.split("?")[0];
  const z = new JSZip(), f = z.folder("月報くん");
  // Chrome のタブで開く起動ファイル（既定のブラウザが Edge でも Chrome で開く。Chrome がなければ既定のブラウザ）
  const chromeAt = ["%ProgramFiles%", "%ProgramFiles(x86)%", "%LocalAppData%"].map((d) => `${d}\\Google\\Chrome\\Application\\chrome.exe`);
  f.file("月報くん（Chromeのタブで開く）.cmd", ["@echo off",
    ...chromeAt.map((c) => `if exist "${c}" ( start "" "${c}" "${url}" & exit /b )`),
    `start "" "${url}"`, ""].join("\r\n"));
  // Windows のインターネットショートカット（ダブルクリックで、既定のブラウザのタブでアプリが開く）
  f.file("月報くん（既定のブラウザで開く）.url", `[InternetShortcut]\r\nURL=${url}\r\nIconIndex=0\r\n`);
  f.file("バックアップ/ここにバックアップが入ります.txt",
    "このフォルダに、月報くんのバックアップ（月報くん_年-月-日_時-分-秒.geppou。暗号化済み）が自動で保存されます。\r\n月報くんを開いたときは、ここの一番新しいバックアップを自動で読み込みます。\r\nファイルを消したり名前を変えたりしないでください。\r\n");
  f.file("はじめにお読みください.txt", [
    "月報くん（医務官月報 取りまとめ）", "",
    "1. この「月報くん」フォルダを、医務官のみがアクセスできる場所に置いてください（共有フォルダや他の人が見られる場所は不可）。",
    "2. 「月報くん（Chromeのタブで開く）」をダブルクリックすると、Chrome のタブでアプリが開きます（既定のブラウザが Edge でも Chrome で開きます）。",
    "   組織の設定でこのファイルが開けないときは「月報くん（既定のブラウザで開く）」を使ってください（既定のブラウザが Edge なら Edge で開きます）。",
    "   月報のデータはブラウザごとに別々に保存されます。いつも同じブラウザ（Chrome）で開いてください。",
    "3. はじめて開いたときは、画面上の「📁 バックアップフォルダを選んでつなぐ」（または 設定 →「📁 バックアップフォルダを選ぶ」）で、",
    "   このフォルダの中の「バックアップ」フォルダを選び、「編集を許可」してください。",
    "4. あとは、変更のたびに自動で「バックアップ」フォルダに保存され（ファイル名に日付と時刻）、",
    "   次に開いたときは一番新しいバックアップを自動で読み込みます。",
    "   ブラウザを開き直したときに「許可」をもう一度求められることがあります。そのときは帯のボタンを1回押してください。",
    "", "・アプリ本体はインターネット上にあり、月報のデータは外部に送信しません（読み取り・集計はブラウザの中だけで行います）。",
    "・バックアップは暗号化されていて、月報くんでしか開けません。",
    "・Chrome か Edge で使ってください（フォルダへの自動保存はこの2つのブラウザの機能です）。", "",
    `アプリのアドレス：${url}`, ""].join("\r\n"));
  const blob = await z.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "月報くん.zip"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("「月報くん.zip」を書き出しました。展開した「月報くん」フォルダを、医務官のみがアクセスできる場所に置いてください");
}
// 起動時：以前つないだフォルダがあれば使う（許可がなければ、上の帯から1回押してつなぐ）
async function bkdirInit() {
  if (!bkdirSupported() || demoMode) return;
  let h = null;
  try { h = await idb.get("backupDir"); } catch {}
  const bar = $("#bkdirbar");
  if (!h) {
    // まだつないでいない：データがあれば、つなぐように案内する
    const p = loadPrefs();
    if (bar && Object.keys(state.reports).length && !(p.bkdirSnooze && Date.now() < p.bkdirSnooze)) {
      $("#bkdirmsg").textContent = "月報くんの「バックアップ」フォルダにつなぐと、自動でバックアップし、開いたときは最新のものを自動で読み込みます。";
      bar.hidden = false;
    }
  } else {
    bkdir.handle = h;
    bkdir.ok = await bkdirPermission(h, false);
    if (bkdir.ok) {
      // フォルダがもう見つからないとき（移動・名前の変更・同期で作り直し）は、開いたときに知らせて選び直してもらう
      try { await bkdirSync(); }
      catch (e) {
        bkdir.ok = false;
        logError("バックアップ", `開いたときにフォルダ「${h.name}」を読めません：${e.name} ${e.message}`, "bkdirInit");
        if (bar) { $("#bkdirmsg").textContent = e.name === "NotFoundError" ? BKDIR_GONE(h.name) : `バックアップフォルダ「${h.name}」を読めませんでした（${e.message}）。選び直してください。`; bar.hidden = false; }
      }
    }
    else if (bar) { $("#bkdirmsg").textContent = `バックアップフォルダ「${h.name}」につなぎ直してください（ブラウザを開き直すと必要になります）。ボタンを押すとフォルダを選ぶ画面が開くので、「${h.name}」を選んでください。`; bar.hidden = false; }
  }
  if (!bar) return;
  // 「バックアップフォルダを選んでつなぐ」：押すとすぐにフォルダを選ぶ画面を開く（前のフォルダから）。選んだフォルダにつなぐ
  $("#bkdirConnect").onclick = async () => {
    if (await bkdirChoose()) bar.hidden = true;
  };
  $("#bkdirLater").onclick = () => { bar.hidden = true; savePref("bkdirSnooze", Date.now() + 7 * 864e5); };
}
function updateBackupBar() {
  // 上部の「💾 バックアップ」ボタン（どのタブからでも押せる）に、最後に書き出した日を出す
  const top = $("#backupTop");
  const fl = $("#backupFloat");
  if (fl) fl.title = `バックアップ：データを暗号化してファイルに書き出します\n${backupStatusText()}`;
  if (top) top.title = `データを暗号化してファイルに書き出します（医務官のみがアクセスできるフォルダに保存してください）\n${backupStatusText()}`;
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

// ======================================================================= 絵（線のアイコン）
// 文字を減らすため、タブ・上のボタン・数字のカードに絵を付ける。補足の（…）は ⓘ にまとめ、触れると出す
const ICON_PATHS = {
  import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  stats: '<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6" rx=".5"/><rect x="12" y="8" width="3" height="10" rx=".5"/><rect x="17" y="5" width="3" height="13" rx=".5"/>',
  map: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/><path d="M12 2.5a14.5 14.5 0 0 1 0 19a14.5 14.5 0 0 1 0-19z"/>',
  summary: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
  junkai: '<circle cx="6" cy="19" r="2.5"/><path d="M8.5 19h8a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="2.5"/>',
  evac: '<path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  hogo: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8.5v6M9 11.5h6"/>',
  transfer: '<path d="M17 3l4 4-4 4"/><path d="M3 7h18"/><path d="M7 21l-4-4 4-4"/><path d="M21 17H3"/>',
  trend: '<path d="M22 6l-8.5 9.5-5-5L1 18"/><path d="M16 6h6v6"/>',
  report: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><rect x="8.5" y="13.5" width="7" height="5" rx="1"/><path d="M10 13.5V12a2 2 0 0 1 4 0v1.5"/>',
  ai: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/><path d="M19 2v4M17 4h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  bug: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M12 11v9M9 4l1.5 2M15 4l-1.5 2M3 13h4M17 13h4M4 8l3 2M20 8l-3 2M4 19l3-2M20 19l-3-2"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  building: '<path d="M3 21h18M5 21V8l7-5 7 5v13"/><path d="M9 21v-5h6v5M9 11h.01M15 11h.01"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  virus: '<circle cx="12" cy="12" r="5"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5M4.9 4.9l3.5 3.5M15.6 15.6l3.5 3.5M4.9 19.1l3.5-3.5M15.6 8.4l3.5-3.5"/>',
  play: '<circle cx="12" cy="12" r="9.5"/><path d="M10 8.5l5.5 3.5-5.5 3.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};
const ico = (k, cls = "") => `<svg class="ico${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[k] || ""}</svg>`;
// タブ：絵＋短い名前（元の名前は触れると出す）
const TAB_SHORT = { ai: "AI分析", transfer: "異動", report: "PDF" };
function decorateChrome() {
  document.querySelectorAll("#tabs button[data-page]").forEach((b) => {
    if (b.querySelector(".ico")) return;
    const full = b.textContent.trim(), k = b.dataset.page;
    b.title = full;
    b.innerHTML = `${ico(k)}<span class="tlab">${esc(TAB_SHORT[k] || full)}</span>`;
  });
  // 上のボタンは絵だけにする（名前は触れると出る・読み上げる）
  for (const [id, k, short] of [["installBtn", "folder"], ["tutBtn", "book"], ["bugBtn", "bug"], ["backupTop", "save", "バックアップ"]]) {
    const b = document.getElementById(id);
    if (!b || b.querySelector(".ico")) continue;
    const full = b.textContent.replace(/^\S+\s/, "").trim();
    b.setAttribute("aria-label", full);
    b.title = b.title ? `${full}：${b.title}` : full;
    b.innerHTML = ico(k) + (short ? `<span class="blab">${short}</span>` : "");
    b.classList.add(short ? "iconbtn-l" : "iconbtn");
  }
  const sub = document.querySelector(".brand .sub");
  if (sub && !sub.classList.contains("safe")) { sub.title = sub.textContent; sub.classList.add("safe"); sub.innerHTML = `${ico("lock")}外部に送信しません`; }
}
// 月報の用語（ⓘ・バッジに触れると出す）
const GLOSSARY = "甲表＝受診者数（職員・家族・その他）／乙表＝病名ごとの件数（疾病分類件数表）／丙表＝報告事項（医療事情・感染症・邦人保護などの文章）";
// 補足の（…）：.row の中の、名前のない短い注記を ⓘ にする（触れる・押すと出る）
function hintify(root) {
  root.querySelectorAll(".badge:not([title])").forEach((b) => { if (/[甲乙丙]表/.test(b.textContent)) b.title = GLOSSARY; });
  root.querySelectorAll(".row > span.muted:not([id]), .stephead > span.muted:not([id]), .secpick-sub > span.muted:not([id]):not(.keep)").forEach((el) => {
    if (el.children.length) return;
    const t = el.textContent.trim();
    if (!/^（.+）$/.test(t) && t.length < 30 && !el.parentElement.classList.contains("stephead")) return;
    const h = document.createElement("button");
    h.type = "button"; h.className = "hint"; h.textContent = "i";
    h.dataset.tip = t.replace(/^（(.+)）$/, "$1"); h.setAttribute("aria-label", h.dataset.tip);
    el.replaceWith(h);
  });
  // カードの見出しのすぐ下の長い説明文も、見出しの ⓘ にまとめる
  root.querySelectorAll(".card > h3 + p.muted:not([id]), .card > .row + p.muted:not([id]), .flowcard > .flow + p.muted").forEach((el) => {
    if (el.querySelector("input, button, select, a, textarea, [id]")) return;
    const t = el.textContent.trim();
    if (t.length < 40) return;
    const h = document.createElement("button");
    h.type = "button"; h.className = "hint"; h.textContent = "i";
    h.dataset.tip = t; h.setAttribute("aria-label", t);
    el.previousElementSibling.append(" ", h);
    el.remove();
  });
}
document.addEventListener("click", (e) => {
  const h = e.target.closest(".hint");
  document.querySelectorAll(".hint.open").forEach((x) => x !== h && x.classList.remove("open"));
  if (h) { placeHint(e); h.classList.toggle("open"); }
});
// 吹き出しが画面の端からはみ出さないよう、端に近い ⓘ は向きを変える
const placeHint = (e) => {
  const h = e.target.closest && e.target.closest(".hint");
  if (!h) return;
  const r = h.getBoundingClientRect();
  h.classList.toggle("tip-r", r.right > innerWidth - 200);
  h.classList.toggle("tip-l", r.left < 200);
  h.classList.toggle("tip-d", r.top < 140);
};
document.addEventListener("mouseover", placeHint);
document.addEventListener("focusin", placeHint);
let hintQueued = false;
new MutationObserver(() => {
  if (hintQueued) return;
  hintQueued = true;
  requestAnimationFrame(() => { hintQueued = false; hintify(main); });
}).observe(document.getElementById("main"), { childList: true, subtree: true });

function render() {
  lazyPlotReset();
  decorateChrome();
  updateBackupBar();
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  stopAllAnim();
  endTour(true);
  if (lapse) lapse.playing = false;
  closePostCard(true);
  // グラフの片付けは少し後で行う（描いている途中で片付けると、グラフ部品の中でエラーになるため）
  if (Plotly.purge) { const old = [...document.querySelectorAll(".js-plotly-plot")]; setTimeout(() => old.forEach((el) => { try { Plotly.purge(el); } catch {} }), 2500); }
  ({ import: pageImport, dashboard: pageDashboard, stats: pageStats, map: pageMap, summary: pageSummary, junkai: pageJunkai,
    transfer: pageTransfer, trend: pageTrend, report: pageReport, ai: pageAI, settings: pageSettings,
    evac: () => pageCases("evac"), hogo: () => pageCases("hogo") })[page]();
}

// ======================================================================= 取り込み

let importMonth = loadPrefs().importMonth || "";
let importMode = loadPrefs().importMode || "auto";   // auto: ファイル名から / manual: 手動で指定
let pending = [];        // { file, path } 月報（PDF・Word）
let rosterDrafts = [];   // { name, path, rows, month, monthFrom } 医務官配置表（名簿）
// 配置表：Excel、またはファイル名に「配置」を含む PDF・Word（名前で分からない PDF も、中身が配置表なら読み取りのときに振り分ける）
const isRosterFile = (name) => /\.(xlsx|xlsm|xls)$/i.test(name) || (/\.(pdf|docx)$/i.test(name) && /配置/.test(nfkc(name)));
const isReportFile = (name) => /\.(pdf|docx?)$/i.test(name);

// フォルダをドロップされたときに中のファイルを（サブフォルダも含めて）集める
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (!items.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
  const out = [], bad = [];
  // 開けないファイル・フォルダが1つあっても、ほかは読み込む（OneDrive・SharePoint の同期でまだダウンロードされていないファイルなど）
  const walk = async (entry) => {
    try {
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
    } catch (e) { console.warn("drop", entry.fullPath, e); bad.push(entry.name); }
  };
  for (const e of items) await walk(e);
  if (bad.length) toast(`開けなかったファイル・フォルダが ${bad.length}件あります（${bad.slice(0, 3).join("、")}${bad.length > 3 ? " ほか" : ""}）。OneDrive・SharePoint の同期フォルダなら、右クリック →「このデバイス上に常に保持する」でダウンロードしてから入れ直してください`);
  return out;
}

function pageImport() {
  const [iy, im] = importMonth ? importMonth.split("-").map(Number) : [0, 0];
  const thisYear = new Date().getFullYear();
  main.innerHTML = `
    <h2>月報の取り込み</h2>
    ${demoMode ? '<div class="warnbox">デモ表示中です。取り込んだ月報は保存されません。実際に取り込むときは「デモを終える」を押してください。</div>' : ""}
    <div class="card">
      <h3 class="stephd" style="margin-top:0"><span class="stepno">1</span>対象月の決め方</h3>
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
      <h3 class="stephd"><span class="stepno">2</span>ファイルまたはフォルダを追加</h3>
      <div class="drop" id="drop"></div>
      <div class="row">
        <button id="pickFiles">ファイルを選ぶ</button>
        <button id="pickFolder">フォルダを選ぶ</button>
        <span class="muted">PDF（ZIP形式・通常）・Word（.docx）。医務官配置表（.xlsx）も一緒に入れられます。パスワード付きのPDFもそのまま開きます（別のパスワードのときは入力を求めます）</span>
      </div>
      <input type="file" id="files" accept=".pdf,.docx,.doc,.xlsx,.xlsm" multiple hidden>
      <input type="file" id="folder" webkitdirectory directory multiple hidden>
      <div id="pending"></div>
      <h3 class="stephd"><span class="stepno">3</span>読み取る</h3>
      <div class="row"><button class="primary" id="start">読み取り開始</button><button id="pauseRead" hidden></button><button class="danger" id="stopRead" hidden title="読み取りをやめます。読み終えた分は下の表で確認・保存でき、まだ読んでいないファイルは一覧に残ります">■ 読み取りを中止</button><span id="progress" class="muted">${esc(importBusy || drafts.length ? importProgress : "")}</span></div>
    </div>
    <div id="drafts"></div>
    <div id="submitGrid"></div>
    <h2>医務官配置表（名簿）</h2>
    <div class="card">
      <p class="muted">配置表（Excel・PDF・Word）を登録すると、未提出公館のチェック・医務官名の補完・異動検出に使います。「公館」を含む列と「氏名」列があれば読み取れます。
        適用する月はファイル名（なければ表の見出しの「◯年◯月」）から自動で入ります。違っていれば直してから保存してください。</p>
      <div class="drop" id="rosterDrop">ここに配置表（Excel・PDF・Word）をドラッグ＆ドロップ<br><span class="muted">上の月報の欄に一緒に入れても、ファイル名に「配置」があれば配置表として読み取ります</span></div>
      <div class="row"><button id="pickRoster">配置表を選ぶ（複数可）</button><button id="pickRosterDir">📁 フォルダごと選ぶ</button><input type="file" id="roster" accept=".xlsx,.xlsm,.xls,.pdf,.docx" multiple hidden><input type="file" id="rosterDir" webkitdirectory multiple hidden>
        <span class="muted keep">過去の配置表もまとめて入れられます。読み取ったあと「すべて保存」で一度に保存します。</span></div>
      <div id="rosterPreview"></div>
      <div id="rosterSaved"></div>
    </div>`;
  const drop = $("#drop");
  const ready = () => importMode === "auto" || !!importMonth;
  const update = () => {
    persistDrafts();   // 読み取る前のファイルの一覧も控える（再読み込みしても消えない）
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
      // 1件ずつ「読み取る」「消去」。チェックを付けたものだけをまとめて読み取ることもできる
      const nSel = pending.filter((p) => p.sel !== false).length;
      // 一覧は PENDING_PAGE 件ずつ（1000件を一度に出すと、チェックや読み取りの進み具合を出すたびに一覧全体を計算し直して重い）
      const nPg = Math.ceil(pending.length / PENDING_PAGE);
      pendingPage = Math.max(0, Math.min(pendingPage, nPg - 1));
      const from = pendingPage * PENDING_PAGE;
      const pager = nPg > 1 ? `<div class="row dpager"><button data-ppg="-1"${pendingPage ? "" : " disabled"}>◀ 前の${PENDING_PAGE}件</button>
          <select class="ppgsel">${Array.from({ length: nPg }, (_, k) => `<option value="${k}"${k === pendingPage ? " selected" : ""}>${k * PENDING_PAGE + 1}〜${Math.min(pending.length, (k + 1) * PENDING_PAGE)}件目</option>`).join("")}</select>
          <span class="muted">/ ${pending.length}件</span><button data-ppg="1"${pendingPage < nPg - 1 ? "" : " disabled"}>次の${PENDING_PAGE}件 ▶</button></div>` : "";
      const list = `${pager}<div class="table-wrap plist"><table><thead><tr>
          <th><input type="checkbox" id="pselAll" title="すべて選ぶ／外す（全ページ）"${nSel === pending.length ? " checked" : ""}></th><th>ファイル</th><th>対象月</th><th></th></tr></thead><tbody>
        ${pending.slice(from, from + PENDING_PAGE).map((p, k) => {
          const i = from + k, mm = auto ? monthFromName(p.path) : importMonth;
          return `<tr><td><input type="checkbox" data-psel="${i}"${p.sel !== false ? " checked" : ""}></td><td title="${esc(p.path)}">${esc(p.file.name)}${p.skipped ? ` <span class="badge warn" title="1件ずつ「読み取る」を押すと、${READ_LIMIT.one / 60000}分まで待って読み直します">⏱ ${esc(p.skipped)}</span>` : ""}</td>
            <td class="${mm ? "muted" : "bad"}">${mm ? fmtMonth(mm) : "月不明"}</td>
            <td class="nowrap"><button data-pread="${i}"${importBusy ? " disabled" : ""}>読み取る</button> <button data-rm="${i}" title="一覧から外す（ファイルそのものは消えません）">消去</button></td></tr>`;
        }).join("")}</tbody></table></div>`;
      $("#pending").innerHTML = `<div class="row">${summary}<span class="muted">計 ${pending.length}件（選択 ${nSel}件）</span>
          <button id="rmSelPending"${nSel ? "" : " disabled"}>選択したものを消去</button><button id="clearPending">すべて外す</button></div>
        ${list}
        ${auto && byMonth["?"] ? '<p class="muted">月が読めないファイルは、本文の「◯年◯月分」から読み取ります。それでも分からなければ確認の表で月を入れてください。</p>' : ""}`;
    }
    document.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { pending.splice(Number(b.dataset.rm), 1); update(); }));
    document.querySelectorAll("[data-ppg]").forEach((b) => (b.onclick = () => { pendingPage += Number(b.dataset.ppg); update(); }));
    document.querySelectorAll(".ppgsel").forEach((sl) => (sl.onchange = () => { pendingPage = Number(sl.value); update(); }));
    document.querySelectorAll("[data-psel]").forEach((c) => (c.onchange = () => { pending[c.dataset.psel].sel = c.checked; update(); }));
    document.querySelectorAll("[data-pread]").forEach((b) => (b.onclick = () => ready() && readFiles([pending[b.dataset.pread]])));
    if ($("#pselAll")) $("#pselAll").onchange = (e) => { pending.forEach((p) => (p.sel = e.target.checked)); update(); };
    if ($("#rmSelPending")) $("#rmSelPending").onclick = () => { pending = pending.filter((p) => p.sel === false); update(); };
    if ($("#clearPending")) $("#clearPending").onclick = () => { pending = []; pendingPage = 0; update(); };
    const nSel = pending.filter((p) => p.sel !== false).length;
    $("#start").textContent = pending.length && nSel < pending.length ? `選択した ${nSel}件を読み取る` : "読み取り開始";
    $("#start").disabled = importBusy || !(ready() && nSel);
  };
  const add = async (items) => {
    const rosters = items.filter((x) => isRosterFile(x.file.name));
    const reports = items.filter((x) => isReportFile(x.file.name) && !isRosterFile(x.file.name));
    const other = items.length - rosters.length - reports.length;
    if (rosters.length) await addRosters(rosters);
    if (reports.length && !ready()) { toast("手動で指定する場合は、先に年と月を選んでください"); return; }
    let same = 0;
    // 新しく入れたファイルは一覧の一番上に（入れた順のまま）
    const add = [];
    // 同じファイルか：名前（フォルダつき）と大きさが同じときは、中身も比べる
    // （別の公館のフォルダの「月報.docx」を順に入れたとき、名前と大きさがたまたま同じで落とされていた）
    const hashOf = async (x) => (x.hash ||= b64(new Uint8Array(await crypto.subtle.digest("SHA-256", await x.file.arrayBuffer()))));
    const sameAs = async (a, b) => a.path === b.path && a.file.size === b.file.size && (a.file === b.file || (await hashOf(a)) === (await hashOf(b)));
    const isSame = async (x, list) => { for (const p of list) if (await sameAs(x, p)) return true; return false; };
    for (const x of reports) { if (!(await isSame(x, pending)) && !(await isSame(x, add))) add.push(x); else same++; }
    pending = add.concat(pending);
    pendingPage = 0;   // 新しく入れたファイルは一番上（1ページ目）
    if (same) toast(`同じファイル ${same}件はすでに一覧にあるため、重ねて追加しませんでした`);
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
  $("#start").onclick = () => readFiles(pending.filter((p) => p.sel !== false));
  $("#pickRoster").onclick = () => $("#roster").click();
  const rd = $("#rosterDrop");
  rd.onclick = () => $("#roster").click();
  rd.ondragover = (e) => { e.preventDefault(); rd.classList.add("over"); };
  rd.ondragleave = () => rd.classList.remove("over");
  rd.ondrop = async (e) => {
    e.preventDefault(); rd.classList.remove("over");
    const items = (await filesFromDrop(e.dataTransfer)).filter((x) => /\.(xlsx|xlsm|xls|pdf|docx)$/i.test(x.file.name));
    if (!items.length) { toast("配置表は Excel・PDF・Word のファイルを入れてください"); return; }
    await addRosters(items);
    toast(`配置表 ${items.length}件を読み取りました（下で確認・保存してください）`);
  };
  $("#roster").onchange = async (e) => { await addRosters([...e.target.files].map((f) => ({ file: f, path: f.name }))); e.target.value = ""; };
  $("#pickRosterDir").onclick = () => $("#rosterDir").click();
  $("#rosterDir").onchange = async (e) => {
    const items = [...e.target.files].filter((f) => /\.(xlsx|xlsm|xls|pdf|docx)$/i.test(f.name) && !/^~\$/.test(f.name)).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
    e.target.value = "";
    if (!items.length) { toast("フォルダに配置表（Excel・PDF・Word）がありません"); return; }
    await addRosters(items);
  };
  update();
  renderDrafts();
  // 提出状況の表は少しあとで作る（取り込みの画面を先に出し、件数が多いときも画面が固まらないように）
  setTimeout(renderSubmitGrid, 0);
  updatePauseBtn();
  renderRosterDrafts();
}

function defaultMonth() {
  const d = new Date(); d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// まだ保存していない読み取り結果（確認の表・配置表）は、ページを再読み込みしても消えないようブラウザ内（IndexedDB）に控えておく
let draftTimer = null;
// typing=true は表に入力している途中（少し待ってからまとめて控える）。それ以外（読み取り・保存・消去など）はすぐ控える
function persistDrafts(typing = false) {
  if (demoMode) return;
  clearTimeout(draftTimer);
  if (typing) draftTimer = setTimeout(writeDrafts, 300);
  else writeDrafts();
}
function writeDrafts() {
  draftTimer = null;
  if (demoMode) return;
  // 読み取る前のファイル（pending）も File のまま控える（このブラウザの中だけ）
  const v = drafts.length || rosterDrafts.length || pending.length ? { drafts, rosterDrafts, importProgress, pending } : null;
  idb.set("drafts", v).catch((e) => console.warn("drafts", e));
}
// ページを閉じる・再読み込みする・別のタブへ移るときは、待たずにすぐ控える（直した内容を失わないように）
const flushDrafts = () => { if (draftTimer) { clearTimeout(draftTimer); try { syncDrafts(); } catch {} writeDrafts(); } };
window.addEventListener("pagehide", flushDrafts);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushDrafts(); });
async function restoreDrafts() {
  try {
    const v = await idb.get("drafts");
    if (!v || (!(v.drafts || []).length && !(v.rosterDrafts || []).length && !(v.pending || []).length)) return 0;
    drafts = v.drafts || []; rosterDrafts = v.rosterDrafts || []; pending = (v.pending || []).filter((p) => p && p.file);
    if (drafts.length || rosterDrafts.length) importProgress = `前回の読み取り結果（月報 ${drafts.length}件${rosterDrafts.length ? `・配置表 ${rosterDrafts.length}件` : ""}）を戻しました。確認して「保存する」を押してください。`;
    return drafts.length + rosterDrafts.length + pending.length;
  } catch (e) { console.warn("drafts", e); return 0; }
}
// 読み込めなかった理由を日本語で（ブラウザの部品のエラーは英語のため）
function readErrorText(e, file) {
  const m = String((e && e.message) || e || "");
  if (file && file.size === 0 || /empty|zero bytes/i.test(m)) return "ファイルが空です（0バイト）。元のファイルをもう一度保存・送付してもらってください";
  if (/Invalid PDF structure|Invalid XRef|Missing PDF|UnexpectedResponse|InvalidPDF/i.test(m)) return "PDFとして読めません（ファイルが壊れているか、途中までしか保存されていないか、PDFではありません）。開けるか確かめて、もう一度受け取ってください";
  if (/zip|central directory|End of data/i.test(m)) return "ファイルが壊れています（中身を取り出せません）。もう一度受け取ってください";
  if (/password|パスワード/i.test(m)) return m;
  if (/NotReadable|NotFound|could not be read|requested file/i.test(m) || /NotReadableError|NotFoundError/.test((e && e.name) || "")) return "ファイルを開けません（読み込んだあとに移動・削除されたか、OneDrive・SharePoint の同期でまだパソコンにダウンロードされていない可能性）。同期フォルダなら右クリック →「このデバイス上に常に保持する」のあと、もう一度入れてください";
  return m || "原因の分からないエラー";
}
// 対象月を決める（取り込みの方法が「ファイル名から自動」なら ファイル名 → 本文 の順、手動なら選んだ月）
function finishDraftMonth(r, name) {
  r.filename = name;
  r.info = [];
  if (importMode === "auto") {
    const byName = monthFromName(name);
    r.month = byName || r.bodyMonth || "";
    // ファイル名・フォルダ名に年月がなくても、本文（甲表の「○年○月分」）で月が分かれば要確認にはしない（お知らせとして表に出す）
    if (!byName && r.bodyMonth) (r.info ||= []).push(`ファイル名に年月がないため、本文から${fmtMonth(r.bodyMonth)}分と判定しました`);
    if (!r.month) r.warnings.push("対象月が分かりません。表の「対象月」に入れてください");
    if (byName && r.bodyMonth && r.bodyMonth !== byName) r.warnings.push(`本文は${fmtMonth(r.bodyMonth)}分の記載（ファイル名どおり${fmtMonth(byName)}として取り込みます）`);
  } else {
    if (r.bodyMonth && r.bodyMonth !== importMonth) r.warnings.push(`本文は${fmtMonth(r.bodyMonth)}分の記載（${fmtMonth(importMonth)}として取り込みます）`);
    r.month = importMonth;
  }
  return r;
}
// 読み取りは他のタブを開いても続ける。進み具合はここに持ち、「取り込み」タブに戻ったら表示し直す
let importBusy = false, importProgress = "", importPaused = false;
// 読み取りの中止（読み取り中だけ使える。いま読んでいるファイルもすぐにやめる）
let importStop = false, importStopFn = null;
// 1件の読み取りにかける時間の上限。超えたらそのファイルはスキップして次へ（一覧に残し、あとで1件ずつ読み直せる）
// 1件だけを「読み取る」で読むときは長めに待つ
const READ_LIMIT = { many: 60000, one: 300000 };
// 読み取りの一時停止・再開（読み取り中だけボタンを出す。いま読んでいるファイルは読み終えてから止まる）
function updatePauseBtn() {
  const s = $("#stopRead");
  if (s) { s.hidden = !importBusy; s.disabled = importStop; s.onclick = () => importStopFn && importStopFn(); }
  const b = $("#pauseRead");
  if (!b) return;
  b.hidden = !importBusy;
  b.textContent = importPaused ? "▶ 再開" : "⏸ 一時停止";
  b.classList.toggle("primary", importPaused);
  b.onclick = () => {
    importPaused = !importPaused;
    if (importPaused) setImportProgress(importProgress.replace(/^読み取り中…/, "⏸ 一時停止中…") + "（いま読んでいるファイルを読み終えたら止まります。「▶ 再開」で続きを読みます）");
    else setImportProgress(importProgress.replace(/^⏸ 一時停止中…/, "読み取り中…").replace(/（いま読んでいる.*$/, ""));
  };
}
// 読み取り中にページを閉じる・再読み込みするときは確認を出す（途中までの結果は消える）
window.addEventListener("beforeunload", (e) => { if (importBusy) { e.preventDefault(); e.returnValue = ""; } });
function setImportProgress(t) {
  importProgress = t;
  updatePauseBtn();
  const el = $("#progress");
  if (el) el.textContent = t;
  const b = $('#tabs button[data-page="import"]');
  if (b) { b.classList.toggle("busy", importBusy); b.title = importBusy ? t : ""; }
}
// 甲表・乙表がなく、「配置表」の見出しと公館名が並ぶ PDF・Word を配置表とみなす
async function looksLikeRoster(file) {
  if (!/\.(pdf|docx)$/i.test(file.name)) return false;
  try {
    const [, pages] = await readPages(file);
    const t = nfkc(pages.map((p) => p.text).join("\n"));
    return /配置表/.test(t) && !/受診者数|疾病分類/.test(t) && t.split("\n").filter((l) => rosterLinePost(l.trim())).length >= 3;
  } catch { return false; }
}
async function readFiles(items = pending.filter((p) => p.sel !== false)) {
  const auto = importMode === "auto";
  if (importBusy || (!auto && !importMonth) || !items.length) return;
  importBusy = true; importStop = false;
  const STOP = {}, TIMEOUT = {}, limit = items.length === 1 ? READ_LIMIT.one : READ_LIMIT.many;
  const stopP = new Promise((ok) => (importStopFn = () => {
    if (importStop) return;
    importStop = true; importPaused = false; ok(STOP);
    setImportProgress("中止しています…");
  }));
  if ($("#start")) $("#start").disabled = true;
  document.querySelectorAll("[data-pread]").forEach((b) => (b.disabled = true));
  for (const it of items) delete it.skipped;
  let skipped = 0;
  // 読み取った結果は、まだ保存していない確認の表に足す（同じファイルを読み直したときは入れ替える）
  const results = new Array(items.length);
  let rosterFound = 0, done = 0, next = 0;
  // 読み取った分は途中でも控えておく（大量に読むときに、途中でブラウザが落ちても・再読み込みしても、読み終えた分は残る）
  const prevDrafts = drafts;
  const merge = () => {
    const fresh = results.filter(Boolean), names = new Set(fresh.map((d) => d.filename));
    // 新しく読み取った月報は確認の表の一番上に
    drafts = fresh.concat(prevDrafts.filter((d) => !names.has(d.filename)));
    // 読み終えたファイルは「読み取る前のファイル」から外す（読み取り中に追加したファイルは残す）
    const finished = new Set(items.filter((_, k) => results[k] !== undefined));
    pending = pending.filter((p) => !finished.has(p));
    return fresh;
  };
  let lastFlush = Date.now();
  // 1件を読む（配置表なら配置表として登録し null を返す）
  const readOne = async (i, tok) => {
    const { file, path } = items[i];
    let r;
    try {
    // ファイル名では分からなかった配置表（PDF・Word）は、中身を見て配置表として読む
    if (await looksLikeRoster(file)) { if (tok.dead) return null; await addRosters([{ file, path }]); rosterFound++; return null; }
    try { r = await parseReport(file); }
    catch (e) {
      r = { filename: file.name, month: null, bodyMonth: null, post: null, officer: null, staff: null, family: null, other: null, total: null,
        diseases: [], hei: "", warnings: ["読み込み失敗: " + readErrorText(e, file)], images: [] };
    }
    } finally { pagesMemo.delete(file); }   // 読み終えたファイルの中身は手放す
    return finishDraftMonth(r, path || file.name);
  };
  try {
    // 何件かを同時に読む（PDFの読み取り役を複数使う）。結果は選んだ順に並べる
    const lanes = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    const lane = async () => {
      while (next < items.length) {
        if (importPaused) { merge(); persistDrafts(); }   // 一時停止したら、それまでに読んだ分を控える
        while (importPaused && !importStop) await new Promise((ok) => setTimeout(ok, 300));   // 一時停止中は待つ
        if (importStop || next >= items.length) break;
        const i = next++;
        await yieldUI();   // 画面へ制御を返す（大量のときも固まらない）
        // 時間がかかりすぎるファイルはスキップ。中止したら、いま読んでいるファイルもすぐにやめる
        const tok = {};
        let timer;
        const res = await Promise.race([readOne(i, tok), stopP, new Promise((ok) => (timer = setTimeout(() => ok(TIMEOUT), limit)))]);
        clearTimeout(timer);
        if (res === STOP || res === TIMEOUT) {
          tok.dead = true; abortPdfRead(items[i].file); pagesMemo.delete(items[i].file);
          if (res === STOP) break;
          // 一覧に残し、印を付ける（チェックは外す。あとで1件ずつ「読み取る」で時間をかけて読み直せる）
          items[i].skipped = `時間がかかったためスキップ（${limit / 1000}秒）`; items[i].sel = false; skipped++;
          continue;
        }
        results[i] = res;
        done++;
        if (Date.now() - lastFlush > 5000) { lastFlush = Date.now(); merge(); persistDrafts(); }
        if (!importStop) setImportProgress(`${importPaused ? "⏸ 一時停止中…" : "読み取り中…"} ${done + skipped} / ${items.length}${skipped ? `（スキップ ${skipped}件）` : ""}　${items[i].file.name}${importPaused ? "（「▶ 再開」で続きを読みます）" : ""}`);
      }
    };
    setImportProgress(`読み取り中… 0 / ${items.length}`);
    await Promise.all(Array.from({ length: lanes }, lane));
  } finally { importBusy = false; importPaused = false; importStopFn = null; pagesMemo.clear(); updatePauseBtn(); }
  const stopped = importStop;
  importStop = false;
  // 読み終えたファイルだけを一覧から外す（中止・スキップで読まなかったファイルは一覧に残る）
  const fresh = merge();
  const left = items.filter((it, k) => results[k] === undefined && !it.skipped).length;
  draftPage = 0;
  persistDrafts();
  const counts = {};
  for (const d of fresh) counts[d.month || "?"] = (counts[d.month || "?"] || 0) + 1;
  if (rosterFound) toast(`配置表 ${rosterFound}件を見つけました（下の「医務官配置表」で確認・保存してください）`);
  setImportProgress((stopped ? "■ 中止しました。" : "") + `${fresh.length}件を読み取りました` + (fresh.length ? "（" + Object.entries(counts).sort().map(([k, v]) => `${k === "?" ? "月不明" : fmtMonth(k)} ${v}件`).join("、") + "）。下の表で確認して「保存する」を押してください。" : "。")
    + (fresh.some(draftSaved) ? `📌 うち ${fresh.filter(draftSaved).length}件は、同じ月・同じ公館の月報をすでに保存しています（表の「保存済み」の印）。` : "")
    + (stopped && left ? `まだ読んでいない ${left}件は「読み取る前のファイル」に残しています。` : "")
    + (skipped ? `⏱ 時間がかかった ${skipped}件はスキップしました（一覧に ⏱ の印。1件ずつ「読み取る」を押すと、${READ_LIMIT.one / 60000}分まで待って読み直します）。` : ""));
  if (page === "import" && $("#drop")) {
    pageImport();
    $("#drafts").scrollIntoView({ behavior: "smooth" });
  } else toast(stopped ? "読み取りを中止しました。読み終えた分は「取り込み」タブで確認して保存できます" : `月報 ${items.length}件の読み取りが終わりました。「取り込み」タブで確認して保存してください`);
}

// ---- 国名の候補リスト（入力欄を押すと一覧が開き、文字を入れると絞り込む。▲▼と Enter でも選べる）
// ブラウザ標準の候補（datalist）は、欄に名前が入っているとその名前に合う候補しか出さないため、自前で出す。候補は data-combo の datalist から読む
const combo = { box: null, input: null, items: [], idx: -1, typed: false };
function comboClose() { if (combo.box) combo.box.remove(); combo.box = null; combo.input = null; }
function comboRender() {
  const inp = combo.input;
  if (!inp) return;
  const dl = document.getElementById(inp.dataset.combo);
  const all = dl ? [...dl.options].map((o) => ({ v: o.value, l: o.label || "" })) : [];
  const q = combo.typed ? nfkc(inp.value).trim().toLowerCase() : "";
  combo.items = q ? all.filter((o) => nfkc(o.v + " " + o.l).toLowerCase().includes(q)) : all;
  if (!combo.box) { combo.box = document.createElement("div"); combo.box.className = "combo-list"; document.body.appendChild(combo.box); }
  const r = inp.getBoundingClientRect();
  // 下に場所がなければ欄の上に開く。高さは画面に収まるようにする
  const below = innerHeight - r.bottom - 8, above = r.top - 8, up = below < 200 && above > below;
  Object.assign(combo.box.style, { left: `${Math.max(4, Math.min(r.left, innerWidth - Math.max(r.width, 220) - 4))}px`, minWidth: `${Math.max(r.width, 220)}px`,
    maxHeight: `${Math.max(120, Math.min(280, up ? above : below))}px`, top: up ? "auto" : `${r.bottom + 2}px`, bottom: up ? `${innerHeight - r.top + 2}px` : "auto" });
  combo.box.innerHTML = combo.items.length ? combo.items.slice(0, 300).map((o, i) =>
    `<div class="combo-item${i === combo.idx ? " on" : ""}${o.v === inp.value ? " cur" : ""}" data-ci="${i}">${esc(o.v)}${o.l ? `<span>${esc(o.l)}</span>` : ""}</div>`).join("")
    : '<div class="combo-none">候補がありません</div>';
  const on = combo.box.querySelector(".on") || (combo.idx < 0 && combo.box.querySelector(".cur"));
  if (on) on.scrollIntoView({ block: "nearest" });
}
function comboPick(i) {
  const inp = combo.input, o = combo.items[i];
  if (!inp || !o) return;
  inp.value = o.v;
  comboClose();
  inp.dispatchEvent(new Event("change", { bubbles: true }));
}
document.addEventListener("focusin", (e) => {
  const inp = e.target.closest && e.target.closest("input[data-combo]");
  if (!inp) return;
  combo.input = inp; combo.typed = false; combo.idx = -1;
  comboRender();
});
document.addEventListener("click", (e) => {
  const inp = e.target.closest && e.target.closest("input[data-combo]");
  if (inp && combo.input !== inp) { combo.input = inp; combo.typed = false; combo.idx = -1; comboRender(); }
});
document.addEventListener("input", (e) => {
  if (!combo.input || e.target !== combo.input) return;
  combo.typed = true; combo.idx = -1;
  comboRender();
});
document.addEventListener("keydown", (e) => {
  if (!combo.input || e.target !== combo.input || !combo.box) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    combo.idx = Math.max(0, Math.min(combo.items.length - 1, combo.idx + (e.key === "ArrowDown" ? 1 : -1)));
    comboRender();
  } else if (e.key === "Enter" && combo.idx >= 0) { e.preventDefault(); comboPick(combo.idx); }
  else if (e.key === "Escape") comboClose();
});
// 一覧の上で押したときは、入力欄から焦点が外れないようにしてから選ぶ
document.addEventListener("mousedown", (e) => {
  const it = e.target.closest && e.target.closest(".combo-item");
  if (it) { e.preventDefault(); comboPick(Number(it.dataset.ci)); return; }
  if (combo.box && !e.target.closest(".combo-list") && e.target !== combo.input) comboClose();
});
document.addEventListener("focusout", (e) => { if (e.target === combo.input) setTimeout(() => { if (document.activeElement !== combo.input) comboClose(); }, 150); });
window.addEventListener("resize", comboClose);
document.addEventListener("scroll", (e) => { if (combo.box && !(e.target.closest && e.target.closest(".combo-list"))) comboClose(); }, true);

// 入力した国名・公館名（英語名・都市名・「在◯◯大使館」でもよい）を、マスタの名前にそろえる。分からなければ空
function resolvePlace(v) {
  v = String(v || "").trim();
  if (!v) return "";
  if (INFO[v]) return v;
  const hit = canonical(v) || findInText(v)[0];
  if (hit) return hit;
  // 表記ゆれ（ケニヤ→ケニア、ヴ→ブ など）
  const alt = v.replace(/ヤ$/, "ア").replace(/ヴァ/g, "バ").replace(/ヴ/g, "ブ").replace(/ー$/, "");
  return alt !== v ? canonical(alt) || findInText(alt)[0] || "" : "";
}
// 公館名の入力候補（公館マスタの公館を先に、医務官のいない国を後に。英語名・都市名でも探せるよう別名を添える）
function postDatalist() {
  const alias = {};
  for (const p of D.posts) alias[p.name] = (p.aliases || []).join("・");
  const opt = (nm, extra) => `<option value="${esc(nm)}" label="${esc([alias[nm], INFO[nm] && regionOf(nm), extra].filter(Boolean).join("　"))}"></option>`;
  // 50音順の1つの一覧（医務官のいない国はそう添える）
  return `<datalist id="postList">${ALL_PLACES.filter((nm) => nm !== "日本").map((nm) => opt(nm, INFO[nm].isPost ? "" : "医務官なしの国")).join("")}</datalist>`;
}
// 読み取る前のファイルの一覧も PENDING_PAGE 件ずつ
const PENDING_PAGE = 50;
let pendingPage = 0;
// 確認の表は1ページ DRAFT_PAGE 件ずつ出す（数百件を一度に出すと、1文字入れるたび・1行消すたびに表全体を計算し直して重くなる）
const DRAFT_PAGE = 30;
let draftPage = 0, draftWarnOnly = false, draftDupOnly = false;
// 読み取り結果の「対象月|公館」（保存したときの月報の鍵）。月か公館が分からなければ null
const draftKey = (d) => { const mm = String(d.month || "").match(/^(20\d{2})-(\d{1,2})$/); return mm && d.post ? `${mm[1]}-${mm[2].padStart(2, "0")}|${d.post}` : null; };
// すでに保存している同じ月・同じ公館の月報。same＝受診者数・医務官・病名の数が同じ（同じ月報をもう一度読んだもの）
function draftSaved(d) {
  const k = draftKey(d), old = k && state.reports[k];
  if (!old) return null;
  const same = Number(old.total) === Number(d.total) && Number(old.staff) === Number(d.staff) && samePerson(old.officer || "", d.officer || "") === !!(old.officer || d.officer) && (old.diseases || []).length === (d.diseases || []).length;
  return { old, same };
}
// 文字のない（スキャン・図形の）ページだけで、まだOCRにかけていない月報
const needsOcr = (d) => d.srcFile && !d.ocr && !d.ocrFailed && (d.warnings || []).some((w) => /OCRテキストなし/.test(w));
function renderDrafts() {
  const el = $("#drafts");
  if (!el) return;
  // 読み取りの途中は確認の表を出さない（終わってから全件をまとめて確認・保存する）
  if (!drafts.length || importBusy) { el.innerHTML = ""; if (!importBusy) persistDrafts(); return; }
  const nWarn = drafts.filter((d) => d.warnings.length).length;
  if (!nWarn) draftWarnOnly = false;
  const saved = drafts.map(draftSaved), nSaved = saved.filter(Boolean).length, nSame = saved.filter((x) => x && x.same).length;
  if (!nSaved) draftDupOnly = false;
  // 表の中で同じ月・同じ公館が2つ以上あるもの
  const keyCount = {};
  for (const d of drafts) { const k = draftKey(d); if (k) keyCount[k] = (keyCount[k] || 0) + 1; }
  const all = drafts.map((_, i) => i).filter((i) => (!draftWarnOnly || drafts[i].warnings.length) && (!draftDupOnly || saved[i]));
  const nPages = Math.max(1, Math.ceil(all.length / DRAFT_PAGE));
  draftPage = Math.max(0, Math.min(draftPage, nPages - 1));
  const view = all.slice(draftPage * DRAFT_PAGE, (draftPage + 1) * DRAFT_PAGE);
  const pager = all.length > DRAFT_PAGE || nWarn && nWarn < drafts.length || draftWarnOnly || nSaved || draftDupOnly ? `<div class="row dpager">
      ${nWarn && nWarn < drafts.length || draftWarnOnly ? `<label><input type="checkbox" class="dwarnonly"${draftWarnOnly ? " checked" : ""}> <span class="badge warn">要確認</span> だけ表示（${nWarn}件）</label>` : ""}
      ${nSaved ? `<label><input type="checkbox" class="ddupyonly"${draftDupOnly ? " checked" : ""}> <span class="badge dup">保存済み</span> だけ表示（${nSaved}件）</label>` : ""}
      ${nPages > 1 ? `<button data-dpg="-1"${draftPage ? "" : " disabled"}>◀ 前の${DRAFT_PAGE}件</button>
      <select class="dpgsel" title="ページを選ぶ">${Array.from({ length: nPages }, (_, k) => `<option value="${k}"${k === draftPage ? " selected" : ""}>${k * DRAFT_PAGE + 1}〜${Math.min(all.length, (k + 1) * DRAFT_PAGE)}件目</option>`).join("")}</select>
      <span class="muted">/ ${all.length}件</span>
      <button data-dpg="1"${draftPage < nPages - 1 ? "" : " disabled"}>次の${DRAFT_PAGE}件 ▶</button>` : `<span class="muted">${all.length}件</span>`}
    </div>` : "";
  // 公館は入力して検索できる（候補から選ぶ。英語名・都市名でも探せる）。一覧にない国名も入れられる（医務官のいない国）
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">読み取り結果の確認</h3>
      <p class="muted">誤読があれば直接修正してください。<span class="badge warn">要確認</span> の行は特に確認を。${drafts.length > DRAFT_PAGE ? `全 ${drafts.length}件を ${DRAFT_PAGE}件ずつ表示しています（「保存する」は全件が対象）。` : ""}</p>
      ${nSaved ? `<div class="warnbox dupbox">📌 読み取った ${drafts.length}件のうち <b>${nSaved}件</b> は、同じ月・同じ公館の月報を<b>すでに保存しています</b>（<span class="badge dup">保存済み</span> の印。うち ${nSame}件は受診者数・医務官・病名の数も同じ＝同じ月報）。
          保存すると上書きするかスキップするかを聞きます。${nSame ? `<button id="dropSameDrafts">保存済みと同じ ${nSame}件を表から外す</button>` : ""}</div>` : ""}
      ${(() => { const n = drafts.filter(needsOcr).length; return n ? `<div class="warnbox ocrbulk">🔎 <b>文字のない（スキャンした）月報が ${n}件</b>あります。このままでは数字・病名を読めません。OCR（文字認識。このPCの中だけで動き、外部には送りません）で読み取れます（1件20秒ほど）。
          <div class="row" style="margin:6px 0 0"><button class="primary" id="ocrAll">🔎 ${n}件をすべてOCRで読み取る</button><button id="ocrAllStop" hidden>■ 止める</button><span id="ocrAllSt" class="muted keep"></span></div></div>` : ""; })()}
      ${pager}
      <div class="table-wrap"><table class="drafttbl">
        <thead><tr><th><input type="checkbox" id="dselAll" title="すべて選ぶ／外す"${drafts.every((d) => d.sel !== false) ? " checked" : ""}></th><th></th><th></th><th>ファイル</th><th>対象月</th><th>公館</th><th>医務官</th><th class="num">職員</th><th class="num">家族</th><th class="num">その他</th><th class="num">計</th></tr></thead>
        <tbody>${view.map((i) => { const d = drafts[i]; return `
          <tr data-i="${i}">
            <td><input type="checkbox" class="dsel"${d.sel !== false ? " checked" : ""}></td>
            <td>${d.warnings.length ? '<span class="badge warn">要確認</span>' : '<span class="badge">OK</span>'}${saved[i] ? ` <span class="badge dup" title="保存済み：${esc(saved[i].old.filename || "")}（受診者数 ${esc(String(saved[i].old.total ?? "―"))}名・医務官 ${esc(saved[i].old.officer || "―")}）">${saved[i].same ? "保存済み（同じ）" : "保存済み（内容が違う）"}</span>` : ""}${keyCount[draftKey(d)] > 1 ? ' <span class="badge warn" title="この表の中に、同じ月・同じ公館の読み取り結果がほかにもあります">表の中で重複</span>' : ""}</td>
            <td class="nowrap"><button data-dsave="${i}" title="この月報だけを保存します">保存</button> <button data-ddel="${i}" title="この読み取り結果を表から消します（保存済みのデータやファイルは消えません）">消去</button></td>
            <td>${esc(d.filename)}</td>
            <td>${monthField(d.month, 'data-f="month"')}</td>
            <td><input data-f="post" data-combo="postList" value="${esc(d.post || "")}" placeholder="国名を入力して検索" class="${d.post ? "" : "need"}" autocomplete="off"></td>
            <td><input data-f="officer" value="${esc(d.officer || "")}" size="10"></td>
            ${["staff", "family", "other", "total"].map((f) => `<td class="num"><input type="text" class="numin" inputmode="numeric" autocomplete="off" data-f="${f}" value="${d[f] ?? ""}"${f === "total" ? ' title="職員・家族・その他を入れると自動で計算します（直接直すこともできます）"' : ""}></td>`).join("")}
          </tr>
          <tr class="ddet"><td></td><td colspan="10">
          ${d.warnings.length ? `<ul class="dwarn">${d.warnings.map((w) => `<li>⚠ ${esc(w)}</li>`).join("")}</ul>` : ""}${(d.info || []).length ? `<ul class="dinfo">${d.info.map((w) => `<li>ℹ ${esc(w)}</li>`).join("")}</ul>` : ""}
          ${d.srcFile && !d.ocr && ((d.lazyPages || []).length + d.images.length || d.total == null || !d.officer) ? `<div class="row ocrrow"><button data-ocr="${i}" title="文字のない（スキャン・図形の）ページを画像にして、文字を認識してから読み直します。このパソコンの中だけで行い、外部には送りません">🔎 OCRで読み取ってみる</button><span class="muted" data-ocrst="${i}">文字のないページの文字を認識して、甲表・乙表・丙表を読み直します（1ページ数秒〜十数秒）</span></div>`
            : !d.srcFile && !d.ocr && d.warnings.some((w) => /OCRテキストなし|図形（アウトライン）/.test(w)) ? '<p class="muted">🔎 OCRを使うには、この月報のファイルをもう一度読み込んでください（以前の版で読み取った結果には、元のファイルが残っていません）。</p>' : ""}
        <details data-i="${i}">
          <summary>詳細を見る（甲表・乙表 ${d.diseases.length}件・丙表${d.images.length + (d.lazyPages || []).length ? `・ページ画像 ${d.images.length + (d.lazyPages || []).length}枚` : ""}）</summary>
          ${d.images.length + (d.lazyPages || []).length ? `<div class="warnbox">OCRテキストのないページがあります。画像を見て上の表や下の欄を補ってください。</div>` + d.images.map(([n], k) => `<img class="pageimg" data-img="${k}" alt="p.${n}">`).join("")
            + ((d.lazyPages || []).length ? `<div class="lazyimgs muted" data-lazy="1">ページの画像を作っています…（p.${d.lazyPages.join(", ")}）</div>` : "") : ""}
          <label class="kou">甲表（読み取った文字。受診者数・医務官名を上の欄と見比べてください）<textarea rows="8" readonly>${esc(d.kou || "（甲表のページを見つけられませんでした）")}</textarea></label>
          <div class="grid2">
            <label>乙表（1行に「病名(件数)」）<textarea data-f="diseases" rows="10">${esc(d.diseases.map((x) => `${x.name}(${x.count})`).join("\n"))}</textarea></label>
            <label>丙表（報告事項）<textarea data-f="hei" rows="10">${esc(d.hei)}</textarea></label>
          </div>
        </details>
          </td></tr>`; }).join("")}
        </tbody></table></div>
      ${nPages > 1 ? pager : ""}
      ${postDatalist()}
      <div class="row"><button class="primary" id="saveDrafts">保存する</button><button id="saveSelDrafts"></button>${(() => { const n = drafts.filter((d) => !d.warnings.length).length;
        return n && n < drafts.length ? `<button id="saveOkDrafts" title="「要確認」の行は残して、確認の済んだ行だけを先に保存します">要確認以外をすべて保存（${n}件）</button>` : ""; })()}<button id="clearDrafts">取り消し</button></div>
    </div>`;
  $("#saveDrafts").onclick = () => saveDrafts();
  if ($("#saveOkDrafts")) $("#saveOkDrafts").onclick = () => saveDrafts("ok");
  // 選んだ行だけを保存する（チェックを変えても表は描き直さない。入力中の修正を消さないように）
  // 選択は表に出ていない行も含めて drafts に持つ
  const selBoxes = [...el.querySelectorAll(".dsel")];
  const selLabel = () => {
    const n = drafts.filter((d) => d.sel !== false).length, b = $("#saveSelDrafts");
    b.textContent = `選択した ${n}件を保存`; b.disabled = !n; b.hidden = n === drafts.length;
    $("#dselAll").checked = n === drafts.length;
  };
  selBoxes.forEach((c) => (c.onchange = () => { drafts[c.closest("tr").dataset.i].sel = c.checked; selLabel(); }));
  // ページの切り替え・要確認だけ表示（切り替える前に、入力中の修正を drafts に書き戻す）
  const goPage = (k) => { syncDrafts(); draftPage = k; renderDrafts(); $("#drafts").scrollIntoView({ block: "start" }); };
  el.querySelectorAll("[data-dpg]").forEach((b) => (b.onclick = () => goPage(draftPage + Number(b.dataset.dpg))));
  el.querySelectorAll(".dpgsel").forEach((sl) => (sl.onchange = (e) => { e.stopPropagation(); goPage(Number(sl.value)); }));
  el.querySelectorAll(".dwarnonly").forEach((c) => (c.onchange = (e) => { e.stopPropagation(); draftWarnOnly = c.checked; goPage(0); }));
  el.querySelectorAll(".ddupyonly").forEach((c) => (c.onchange = (e) => { e.stopPropagation(); draftDupOnly = c.checked; goPage(0); }));
  if ($("#dropSameDrafts")) $("#dropSameDrafts").onclick = () => {
    syncDrafts();
    const n = drafts.length;
    drafts = drafts.filter((d) => { const x = draftSaved(d); return !(x && x.same); });
    draftDupOnly = false; draftPage = 0;
    renderDrafts();
    toast(`保存済みと同じ ${n - drafts.length}件を表から外しました（保存済みのデータはそのまま）`);
  };
  // 公館名は入力し終えたらマスタの名前にそろえる（英語名・都市名・「在◯◯大使館」でもよい）
  el.querySelectorAll('[data-f="post"]').forEach((inp) => (inp.onchange = () => {
    const r = resolvePlace(inp.value);
    if (r) inp.value = r;
    inp.classList.toggle("need", !r);
    if (!r && inp.value.trim()) toast(`「${inp.value.trim()}」は公館・国の一覧にありません。候補から選んでください`);
  }));
  // 職員・家族・その他を手で入れたら、計を自動で計算する（3つとも空なら計も空）
  el.querySelectorAll("tr[data-i]").forEach((tr) => {
    const parts = ["staff", "family", "other"].map((f) => tr.querySelector(`[data-f="${f}"]`)), tot = tr.querySelector('[data-f="total"]');
    parts.forEach((p) => (p.oninput = () => {
      tot.value = parts.every((x) => x.value === "") ? "" : parts.reduce((a, x) => a + (Number(x.value) || 0), 0);
      tot.classList.add("autocalc");
      setTimeout(() => tot.classList.remove("autocalc"), 600);
    }));
  });
  $("#dselAll").onchange = (e) => { selBoxes.forEach((c) => (c.checked = e.target.checked)); drafts.forEach((d) => (d.sel = e.target.checked)); selLabel(); };
  selLabel();
  $("#saveSelDrafts").onclick = () => saveDrafts("sel");
  el.querySelectorAll("[data-dsave]").forEach((b) => (b.onclick = () => saveDrafts(drafts[b.dataset.dsave])));
  el.querySelectorAll("[data-ddel]").forEach((b) => (b.onclick = () => {
    syncDrafts();
    drafts.splice(Number(b.dataset.ddel), 1);
    renderDrafts();
  }));
  $("#clearDrafts").onclick = () => { drafts = []; draftPage = 0; renderDrafts(); };
  // 文字のない月報をまとめてOCRで読み取る（1件ずつ順に。途中で止められる）
  if ($("#ocrAll")) {
    let stop = false;
    $("#ocrAllStop").onclick = () => { stop = true; $("#ocrAllSt").textContent = "この1件が終わったら止めます…"; };
    $("#ocrAll").onclick = async () => {
      syncDrafts();
      const list = drafts.filter(needsOcr);
      $("#ocrAll").disabled = true; $("#ocrAllStop").hidden = false; el.querySelectorAll("[data-ocr]").forEach((x) => (x.disabled = true));
      let ok = 0, ng = 0;
      for (let k = 0; k < list.length && !stop; k++) {
        const d = list[k], st = (t) => ($("#ocrAllSt").textContent = `${k + 1} / ${list.length}件目（${d.filename}）：${t}`);
        try {
          const r = await ocrDraft(d, st);
          finishDraftMonth(r, d.filename);
          if (d.month) r.month = d.month;
          Object.assign(d, r, { sel: d.sel, srcFile: r.srcFile || d.srcFile });
          ok++;
        } catch (e) { console.warn(e); ng++; d.ocrFailed = e.message; d.warnings = [`OCRで読み取れませんでした（${e.message}）`, ...d.warnings.filter((x) => !/^OCRで読み取れません/.test(x))]; }
        persistDrafts();
      }
      renderDrafts();
      toast(`OCRで ${ok}件を読み取りました${ng ? `（読み取れなかったもの ${ng}件）` : ""}${stop ? "（途中で止めました）" : ""}。ページの画像と見比べて、数字・病名を確かめてください`);
    };
  }
  // OCRで読み直す（読み取った結果で、その行の欄・乙表・丙表を置き換える。ページの画像は見比べ用に残す）
  el.querySelectorAll("[data-ocr]").forEach((b) => (b.onclick = async () => {
    syncDrafts();
    const i = Number(b.dataset.ocr), d = drafts[i], st = el.querySelector(`[data-ocrst="${i}"]`);
    el.querySelectorAll("[data-ocr]").forEach((x) => (x.disabled = true));
    try {
      const r = await ocrDraft(d, (t) => { if (st) st.textContent = t; });
      finishDraftMonth(r, d.filename);
      if (d.month) r.month = d.month;   // 表で入れた対象月は残す
      drafts[i] = Object.assign(d, r, { sel: d.sel, srcFile: r.srcFile || d.srcFile });
      persistDrafts();
      renderDrafts();
      const det = document.querySelector(`#drafts details[data-i="${i}"]`);
      if (det) { det.open = true; det.scrollIntoView({ behavior: "smooth", block: "center" }); }
      toast("OCRで読み取りました。ページの画像と見比べて確かめてください");
    } catch (e) {
      console.warn(e);
      if (st) st.textContent = "OCRで読み取れませんでした（" + e.message + "）";
      el.querySelectorAll("[data-ocr]").forEach((x) => (x.disabled = false));
    }
  }));
  // 表で直した内容も控えておく（再読み込みしても直した内容が残る）
  el.oninput = () => { syncDrafts(); persistDrafts(true); };
  el.onchange = () => { syncDrafts(); persistDrafts(); };
  persistDrafts();
  // ページの画像は詳細を開いたときにだけ出す（大量に読んだときに全部の画像を一度に出すと重い）
  el.querySelectorAll("details[data-i]").forEach((det) => (det.ontoggle = async () => {
    if (!det.open) return;
    const d = drafts[det.dataset.i];
    det.querySelectorAll("img[data-img]:not([src])").forEach((img) => (img.src = pageImageUrl(d.images[img.dataset.img][1])));
    // PDFの文字のないページは、ここで初めて画像にする（読み取りを速くするため）
    const box = det.querySelector("[data-lazy]");
    if (!box || box.dataset.busy || !d.srcFile || !(d.lazyPages || []).length) return;
    box.dataset.busy = "1";
    try {
      const imgs = await pdfPageImages(d.srcFile, d.lazyPages);
      d.images = d.images.concat(imgs); d.lazyPages = [];
      box.outerHTML = imgs.map(([n, b]) => `<img class="pageimg" alt="p.${n}" src="${pageImageUrl(b)}">`).join("");
      persistDrafts();
    } catch (e) { box.textContent = "ページの画像を作れませんでした（" + e.message + "）"; delete box.dataset.busy; }
  }));
}
const IMG_URLS = new WeakMap();
const pageImageUrl = (x) => typeof x === "string" ? x : (IMG_URLS.get(x) || (IMG_URLS.set(x, URL.createObjectURL(x)), IMG_URLS.get(x)));

// 取り込み済みの月報と重なるときの確認。"overwrite"（上書き）・"skip"（重なるものは保存しない）・"cancel"（やめる）を返す
function askDuplicates(list) {
  return new Promise((res) => {
    const dlg = document.createElement("dialog");
    dlg.className = "notice dupdlg";
    dlg.innerHTML = `<h2>同じ月報がすでに取り込まれています</h2>
      <p>次の ${list.length}件は、同じ月・同じ公館の月報がすでに保存されています。</p>
      <div class="table-wrap" style="max-height:260px"><table><thead><tr><th>対象月・公館</th><th>今回のファイル</th><th>保存済みのファイル</th></tr></thead><tbody>
        ${list.map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.file)}</td><td class="muted">${esc(x.old || "")}</td></tr>`).join("")}</tbody></table></div>
      <div class="row" style="margin-top:14px"><button class="primary" data-ans="skip">重なるものはスキップ（保存済みを残す）</button>
        <button data-ans="overwrite">上書きする</button><button data-ans="cancel">やめる</button></div>`;
    document.body.appendChild(dlg);
    const done = (a) => { dlg.close(); dlg.remove(); res(a); };
    dlg.querySelectorAll("[data-ans]").forEach((b) => (b.onclick = () => done(b.dataset.ans)));
    dlg.oncancel = (e) => { e.preventDefault(); done("cancel"); };
    dlg.showModal();
  });
}
// 確認の表で直した内容（と選択）を drafts に書き戻す
function syncDrafts() {
  document.querySelectorAll("#drafts tr[data-i]").forEach((tr) => {
    const d = drafts[tr.dataset.i];
    const c = tr.querySelector(".dsel");
    if (c) d.sel = c.checked;
    tr.querySelectorAll("[data-f]").forEach((inp) => {
      const f = inp.dataset.f;
      d[f] = ["staff", "family", "other", "total"].includes(f) ? (inp.value === "" ? null : Number(inp.value)) : f === "post" ? resolvePlace(inp.value) : f === "month" ? inp.dataset.ym || "" : inp.value.trim();
    });
  });
  document.querySelectorAll("#drafts details[data-i]").forEach((det) => {
    const d = drafts[det.dataset.i];
    d.hei = $("[data-f=hei]", det).value;
    // 表で直しても、読み取ったときの分類の欄（cat）は病名ごとに引き継ぐ
    const catOf = Object.fromEntries((d.diseases || []).filter((x) => x.cat).map((x) => [x.name, x.cat]));
    d.diseases = $("[data-f=diseases]", det).value.split("\n").map((l) => nfkc(l).trim().match(/^(.+?)\s*[(,\s]\s*(\d+)\)?$/))
      .filter(Boolean).map((m) => { const name = m[1].trim(); return catOf[name] ? { name, count: Number(m[2]), cat: catOf[name] } : { name, count: Number(m[2]) }; });
  });
}
// pick: なし＝すべて、"ok"＝「要確認」のない行、"sel"＝チェックした行、読み取り結果1件＝その行だけ。
// 一部だけを保存したときは、残りの行を表に残して直してから保存できるようにする
let saveBusy = false;
async function saveDrafts(pick = null) {
  if (demoMode) { toast("デモ表示中は保存できません。上の「デモを終える」を押してから取り込んでください"); return; }
  if (saveBusy) { toast("保存しています。終わるまでお待ちください"); return; }
  saveBusy = true;
  try { await saveDraftsRun(pick); } finally {
    saveBusy = false;
    const el = $("#drafts");
    if (el) { el.classList.remove("saving"); el.querySelectorAll(".savingbox").forEach((x) => x.remove()); }
  }
}
// 大量に保存するときに画面が固まらないよう、少しずつ（SAVE_CHUNK 件ずつ）処理して、その合間に画面を動かす。進み具合を表の上に出す
const SAVE_CHUNK = 40;
async function saveDraftsRun(pick) {
  const skipped = [];
  let saved = 0, lastMonth = null;
  syncDrafts();
  const noMonth = [];
  const chosen = pick === "ok" ? drafts.filter((d) => !d.warnings.length) : pick === "sel" ? drafts.filter((d) => d.sel !== false)
    : pick ? drafts.filter((d) => d === pick) : drafts.slice();
  if (!chosen.length) return;
  let targets = chosen;
  // 同じ月・同じ公館の月報がすでに保存されている（または今回のファイルの中で重なる）ときは、上書きかスキップかを聞く
  const keyOf = draftKey;
  const seen = new Set(), dups = [];
  for (const d of targets) { const k = keyOf(d); if (!k) continue; if (state.reports[k] || seen.has(k)) dups.push(d); seen.add(k); }
  if (dups.length) {
    const ans = await askDuplicates(dups.map((d) => { const k = keyOf(d), old = state.reports[k];
      return { d, label: `${fmtMonth(k.split("|")[0])} ${d.post}`, file: d.filename, old: old ? old.filename : "今回の別のファイル" }; }));
    if (ans === "cancel") return;
    if (ans === "skip") targets = targets.filter((d) => !dups.includes(d));
  }
  // 保存中は表を触れないようにし、進み具合を出す
  const el = $("#drafts"), many = targets.length > SAVE_CHUNK;
  let box = null;
  if (el && many) {
    el.classList.add("saving");
    box = document.createElement("div"); box.className = "savingbox";
    el.prepend(box);
  }
  const step = async (k, what) => {
    if (!many || k % SAVE_CHUNK) return;
    if (box) box.textContent = `💾 保存しています… ${what} ${k} / ${targets.length}件（画面を閉じずにお待ちください）`;
    await yieldUI();
  };
  let k = 0;
  for (const d of targets) {
    await step(k++, "月報を登録");
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
  clearCaches();   // 追加した月報を一覧・集計に入れてからサマリーを作る
  k = 0;
  for (const d of targets) {
    await step(k++, "サマリーを作成");
    const r = d.post && state.reports[`${d.month}|${d.post}`];
    if (r) { r.summary = ruleSummary(d.month, d.post); r.summaryAuto = true; r.summaryManual = false; }
  }
  if (box) box.textContent = "💾 ブラウザに保存しています…";
  await saveState();
  const skippedDup = dups.length && !targets.includes(dups[0]) ? dups.length : 0;
  drafts = pick ? drafts.filter((d) => !chosen.includes(d)) : [];
  persistDrafts();
  if (drafts.length) importProgress = `まだ保存していない ${drafts.length}件が下の表に残っています。確認してから保存してください。`;
  refreshMonths(lastMonth);
  render();
  toast(`${saved}件を保存しました` + (skippedDup ? `（取り込み済みの ${skippedDup}件はスキップ）` : "") + (drafts.length ? `（残りの ${drafts.length}件は表に残しています）` : "") + (skipped.length ? `（公館未選択のため未保存: ${skipped.join("、")}）` : "") + (noMonth.length ? `（対象月が空のため未保存: ${noMonth.join("、")}）` : ""));
}

// 配置表（名簿）: ファイル名 → 表の見出し の順に適用月を決め、確認してから保存する
async function addRosters(items) {
  const box = $("#rosterPreview");
  let k = 0;
  for (const { file, path } of items) {
    k++;
    if (items.length > 1 && box) { box.innerHTML = `<p class="okbox">配置表を読み取っています… ${k} / ${items.length}（${esc(file.name)}）</p>`; await new Promise((r) => setTimeout(r, 0)); }
    try {
      const rows = await parseRoster(file);
      const byName = monthFromName(path || file.name);
      const month = byName || rows.sheetMonth || curMonth() || defaultMonth();
      const monthFrom = byName ? "ファイル名" : rows.sheetMonth ? "表の見出し" : "（読み取れず：表示中の月）";
      // 日：表の見出しの「○月○日現在」、なければファイル名の「2026.07.15」。1日（月の初め）なら月だけで保存する
      const dn = nfkc(path || file.name).match(/(20\d{2})[.\-_年](\d{1,2})[.\-_月](\d{1,2})/), dd = rows.sheetDay || (dn && `${dn[1]}-${dn[2].padStart(2, "0")}` === month ? Number(dn[3]) : 0);
      const day = dd > 1 && dd <= 31 ? dd : "";
      // 定員（「定員104公館108名」）と、読み取った人数の欄の数は、配列のままだと保存で消えるので別に持つ
      rosterDrafts = [{ name: file.name, path, rows, month, day, monthFrom, capacity: rows.capacity || null, slots: rows.slots || null }].concat(rosterDrafts.filter((r) => r.path !== path));   // 新しいものを上に
    } catch (err) {
      rosterDrafts.unshift({ name: file.name, path, error: err.message });
    }
  }
  // 古い月から並べる（読めなかったものは最初に）
  rosterDrafts.sort((a, b) => (!!b.error - !!a.error) || String(a.month ? rosterDraftKey(a) : "").localeCompare(String(b.month ? rosterDraftKey(b) : "")));
  renderRosterDrafts();
  if (items.length > 1) toast(`配置表 ${items.length}件を読み取りました。下で確かめて「すべて保存」を押してください`);
}
// 保存するときのキー：日が入っていれば「YYYY-MM-DD」、なければ「YYYY-MM」
const rosterDraftKey = (r) => (r.day ? `${r.month}-${String(r.day).padStart(2, "0")}` : r.month);
// 配置表の中身の表（確認用・保存済みの表示で共通）
const rosterTableHtml = (rows) => `<div class="table-wrap vresize" data-rkey="rosterH"><table><thead><tr><th>地域</th><th>公館</th><th>医務官</th><th>備考</th><th>配置</th></tr></thead><tbody>
  ${rows.slice().sort((a, b) => REGIONS.indexOf(regionOf(a.post)) - REGIONS.indexOf(regionOf(b.post)) || jaCmp(a.post, b.post)).map((x) => `<tr><td class="muted">${esc(regionOf(x.post) || "")}</td><td>${esc(x.post)}${INFO[x.post] ? "" : ' <span class="badge warn" title="公館マスタにない名前">要確認</span>'}${MENTAL_ONLY_POSTS.includes(x.post) && (x.officers || []).length <= 1 ? ' <span class="badge" title="メンタルヘルスの医務官1人">メンタル単独</span>' : (x.officers || []).length > 1 || MENTAL_POSTS.includes(x.post) ? ' <span class="badge" title="身体の医務官とメンタルヘルス相談医">メンタルあり</span>' : ""}</td><td>${esc((x.officers || []).length > 1 ? x.officers.map((o) => (o.name || "空席") + (o.leaving ? "（離任）" : o.mental ? "（メンタル）" : x.officers.some((y) => y.leaving) ? `（着任${o.date ? " " + o.date.replace(/-/g, "/") : ""}）` : "（身体）")).join("／") : x.officer)}</td><td>${esc(x.note)}</td><td>${x.staffed ? "○" : "―"}</td></tr>`).join("")}
  </tbody></table></div>`;
// 保存した配置表の一覧（新しい月から）。中身を見る・削除する
function renderRosterSaved() {
  const box = $("#rosterSaved");
  if (!box) return;
  const ms = rosterKeys().filter((k) => (state.rosters[k] || []).length).reverse();
  box.innerHTML = ms.length ? `<h4>保存した配置表（${ms.length}件）</h4><div class="rosterlist">` + ms.map((m) => { const rows = state.rosters[m];
    return `<details class="rostersaved"><summary><b>${fmtRosterKey(m)}</b>　${rows.length}公館（配置あり ${rows.filter((x) => x.staffed).length}・医務官 ${rows.reduce((a, x) => a + Math.max(x.staffed ? 1 : 0, (x.officers || []).filter((o) => o.name && !o.leaving).length), 0)}名）${m === rosterKeys().pop() ? ' <span class="badge">最新</span>' : ""}</summary>
      <div class="rstbl" data-rskey="${esc(m)}"></div><div class="row"><button class="danger" data-rsdel="${m}">この配置表を削除</button></div></details>`; }).join("") + "</div>"
    : '<p class="muted">保存した配置表はまだありません。</p>';
  // 中身の表は開いたときに作る（配置表が多いと、全部の表を最初に作るのは重い）
  box.querySelectorAll("details.rostersaved").forEach((d) => (d.ontoggle = () => {
    if (!d.open) return;
    const t = d.querySelector(".rstbl");
    if (t && !t.dataset.done) { t.innerHTML = rosterTableHtml(state.rosters[t.dataset.rskey] || []); t.dataset.done = "1"; }
    vresize(d);
  }));
  box.querySelectorAll("[data-rsdel]").forEach((b) => (b.onclick = async () => {
    if (demoMode) { toast("デモ表示中は削除できません"); return; }
    if (!confirm(`${fmtRosterKey(b.dataset.rsdel)}の配置表を削除しますか？（月報は消えません）`)) return;
    delete state.rosters[b.dataset.rsdel];
    await saveState();
    renderRosterSaved();
    toast(`${fmtRosterKey(b.dataset.rsdel)}の配置表を削除しました`);
  }));
}
function renderRosterDrafts() {
  persistDrafts();
  renderRosterSaved();
  const box = $("#rosterPreview");
  if (!box) return;
  const ok = rosterDrafts.filter((r) => !r.error), keyCount = {};
  for (const r of ok) keyCount[rosterDraftKey(r)] = (keyCount[rosterDraftKey(r)] || 0) + 1;
  const dupKeys = Object.keys(keyCount).filter((k) => keyCount[k] > 1);
  const bulk = rosterDrafts.length > 1 ? `<div class="okbox rosterbulk"><b>読み取った配置表 ${ok.length}件</b>${ok.length ? `（${fmtRosterKey(rosterDraftKey(ok[0]))}〜${fmtRosterKey(rosterDraftKey(ok[ok.length - 1]))}）` : ""}${rosterDrafts.length - ok.length ? `・読めなかったもの ${rosterDrafts.length - ok.length}件` : ""}
      ${dupKeys.length ? `<br><span class="miss-mark">同じ月（日）の配置表が複数あります：${dupKeys.map(fmtRosterKey).join("、")}。すべて保存では、下にある方が使われます。月の途中の更新なら「日」を入れてください。</span>` : ""}
      <div class="row" style="margin:6px 0 0"><button class="primary" id="rosterSaveAll"${ok.length ? "" : " disabled"}>💾 すべて保存（${ok.length}件）</button><button id="rosterClearAll">すべて外す</button></div></div>` : "";
  box.innerHTML = bulk + rosterDrafts.map((r, i) => r.error
    ? `<div class="warnbox">${esc(r.name)}：配置表を読み取れませんでした（${esc(r.error)}）<button data-rdel="${i}">外す</button></div>`
    : `<div class="rosterdraft">
        <div class="row"><b>${esc(r.name)}</b>
          <label>適用する月 ${monthField(r.month, `data-rmonth="${i}"`)}</label>
          <label title="月の途中で更新した配置表は日を入れると、同じ月に複数保存できます（空なら月の初めから）">日 <input type="number" min="1" max="31" data-rday="${i}" value="${r.day || ""}" placeholder="―" style="width:4em"></label>
          <span class="muted">${esc(r.monthFrom)}から読み取り</span>
          ${state.rosters[rosterDraftKey(r)] ? `<span class="badge warn">${fmtRosterKey(rosterDraftKey(r))}の配置表を上書きします</span>` : rosterKeys().some((k) => rosterKeyMonth(k) === r.month) ? `<span class="badge">${fmtMonth(r.month)}の配置表がほかにもあります（日付で分けて保存）</span>` : ""}</div>
        <p class="muted rosterinfo">${r.rows.length}公館（うち配置あり ${r.rows.filter((x) => x.staffed).length}${(() => { const c = (n) => r.rows.filter((x) => (x.note || "").startsWith(n)).length;
          return ["退避", "空席", "未配置"].map((n) => c(n) ? `・${n} ${c(n)}` : "").join(""); })()}）${r.capacity ? `<b class="${r.capacity.posts === r.rows.length ? "" : "miss-mark"}">　表の見出し：定員 ${r.capacity.posts}公館${r.capacity.slots}名${r.capacity.posts === r.rows.length ? "（一致）" : `（読み取った公館数 ${r.rows.length} と違います。中身を確かめてください）`}</b>` : ""}${
          r.rows.some((x) => !INFO[x.post]) ? `／公館マスタにない名前: ${esc(r.rows.filter((x) => !INFO[x.post]).map((x) => x.post).join("、"))}` : ""}</p>
        <details><summary>中身を見る</summary>${rosterTableHtml(r.rows)}</details>
        <div class="row"><button class="primary" data-rsave="${i}">この配置表を保存</button><button data-rdel="${i}">外す</button></div>
      </div>`).join("");
  if ($("#rosterSaveAll")) $("#rosterSaveAll").onclick = async () => {
    if (demoMode) { toast("デモ表示中は保存できません"); return; }
    const targets = rosterDrafts.filter((r) => !r.error && /^20\d{2}-\d{2}$/.test(r.month || ""));
    const bad = rosterDrafts.filter((r) => !r.error && !/^20\d{2}-\d{2}$/.test(r.month || ""));
    if (!targets.length) { toast("保存できる配置表がありません（適用する月を入れてください）"); return; }
    const over = targets.filter((r) => state.rosters[rosterDraftKey(r)]).length;
    if (over && !confirm(`${targets.length}件の配置表を保存します。そのうち ${over}件は、同じ月（日）の保存済みの配置表を上書きします。よろしいですか？`)) return;
    for (const r of targets) state.rosters[rosterDraftKey(r)] = [...r.rows];
    await saveState();
    rosterDrafts = rosterDrafts.filter((r) => r.error || bad.includes(r));
    refreshMonths(curMonth() || targets[targets.length - 1].month);
    renderRosterDrafts();
    toast(`配置表 ${targets.length}件を保存しました${bad.length ? `（適用する月がない ${bad.length}件は残しています）` : ""}`);
  };
  if ($("#rosterClearAll")) $("#rosterClearAll").onclick = () => { if (confirm("読み取った配置表をすべて外しますか？（保存済みの配置表は消えません）")) { rosterDrafts = []; renderRosterDrafts(); } };
  box.querySelectorAll("[data-rmonth]").forEach((inp) => inp.addEventListener("monthset", () => { rosterDrafts[inp.dataset.rmonth].month = inp.dataset.ym; renderRosterDrafts(); }));
  box.querySelectorAll("[data-rday]").forEach((inp) => (inp.onchange = () => { const d = Number(inp.value); rosterDrafts[inp.dataset.rday].day = d >= 1 && d <= 31 ? d : ""; renderRosterDrafts(); }));
  box.querySelectorAll("[data-rdel]").forEach((b) => (b.onclick = () => { rosterDrafts.splice(Number(b.dataset.rdel), 1); renderRosterDrafts(); }));
  box.querySelectorAll("[data-rsave]").forEach((b) => (b.onclick = async () => {
    if (demoMode) { toast("デモ表示中は保存できません"); return; }
    const r = rosterDrafts[b.dataset.rsave];
    if (!/^20\d{2}-\d{2}$/.test(r.month)) { toast("適用する月を入れてください"); return; }
    const key = rosterDraftKey(r);
    state.rosters[key] = [...r.rows];
    await saveState();
    rosterDrafts.splice(Number(b.dataset.rsave), 1);
    refreshMonths(curMonth() || r.month);
    renderRosterDrafts();
    toast(`${fmtRosterKey(key)}の配置表として保存しました`);
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

// ======================================================================= 自由集計（統計タブ：好きなグラフ・記述統計を作る）
// 1件＝1公館の1か月分の月報（「単位」）。指標を単位ごとに取り出し、横軸・色分けで集計してグラフと表にする
const FS_MEASURES = [["total", "受診者数（計）", "名"], ["staff", "受診者数（職員）", "名"], ["family", "受診者数（家族）", "名"], ["other", "受診者数（その他）", "名"],
  ["real", "実患の件数（乙表・検診等を除く）", "件"], ["z", "検診・予防接種等の件数", "件"], ["cat", "特定の疾病分類の件数", "件"], ["dis", "特定の病名の件数", "件"],
  ["posts", "提出公館数", "公館"], ["evac", "緊急移送の件数", "件"], ["hogo", "邦人対応の件数", "件"], ["ob", "流行・増加の報告数（丙表）", "件"]];
const FS_DIMS = [["month", "月"], ["region", "地域"], ["post", "国・公館"], ["cat", "疾病分類"], ["dis", "病名（まとめ）"], ["kind", "受診者区分（職員・家族・その他）"]];
const FS_AGG = [["sum", "合計"], ["mean", "平均（1公館1か月あたり）"], ["median", "中央値（1公館1か月あたり）"]];
const FS_CHARTS = [["bar", "棒"], ["barh", "横棒"], ["stack", "積み上げ棒"], ["stack100", "100%積み上げ"], ["line", "折れ線"], ["pie", "円"],
  ["box", "箱ひげ図"], ["hist", "ヒストグラム"], ["heat", "ヒートマップ"], ["scatter", "散布図（2つの指標）"]];
const FS_ITEM_DIMS = ["cat", "dis", "kind"];  // 1つの月報から複数の値が出る分け方（分類ごと・病名ごと・区分ごと）
const FS_PRESETS = [
  ["📈 受診者数の推移（地域別）", { measure: "total", x: "month", color: "region", chart: "line", agg: "sum", span: 12 }],
  ["🍩 疾病分類の構成", { measure: "real", x: "cat", color: "", chart: "pie", agg: "sum", span: 1 }],
  ["📦 公館ごとのばらつき（地域別）", { measure: "total", x: "region", color: "", chart: "box", agg: "sum", span: 1 }],
  ["🌡 病名上位×月", { measure: "real", x: "month", color: "dis", chart: "heat", agg: "sum", span: 12, top: 15 }],
  ["🔗 受診者数と実患件数の関係", { measure: "total", measure2: "real", x: "post", color: "", chart: "scatter", agg: "sum", span: 1 }],
  ["🧱 地域別の疾病分類", { measure: "real", x: "region", color: "cat", chart: "stack100", agg: "sum", span: 1 }],
];
const FS_DEFAULT = { measure: "total", measure2: "real", param: "", x: "month", color: "region", agg: "sum", chart: "line", span: 12, regions: [], posts: [], top: 15, pct: false, sort: "auto" };
const FS_SORTS = [["auto", "おまかせ（国は50音順）"], ["kana", "50音順"], ["value", "多い順"]];
// ヒートマップの色：少ないほど青、多いほど赤（真ん中は白）
const HEAT_BR = [[0, "#2166ac"], [0.25, "#67a9cf"], [0.5, "#f7f7f7"], [0.75, "#ef8a62"], [1, "#b2182b"]];
const FS_PALETTE = ["#2a78d6", "#e34948", "#2e9e6b", "#f0a020", "#8e6bd8", "#17a2b8", "#d6609a", "#7a8b99", "#b5651d", "#4b5bd6", "#69a832", "#c94f7c", "#3f8f8f", "#a0522d", "#5f6caf"];
const FS_REGION_COL = { "アフリカ": "#c0504d", "アジア": "#4f81bd", "大洋州": "#17a2b8", "ヨーロッパ": "#8064a2", "中東": "#f79646", "北米": "#2e9e6b", "中南米": "#9bbb59", "未分類": "#999" };
const fsColor = (dim, key, i) => (dim === "region" ? FS_REGION_COL[key] : dim === "cat" ? D.colors[key] : dim === "kind" ? (VISIT_KEYS.find((v) => v[1] === key) || [])[2] : null) || FS_PALETTE[i % FS_PALETTE.length];
const fsLabel = (dim, key) => (dim === "month" ? fmtMonth(key) : dim === "cat" ? shortCat(key) : key);

// 期間・対象の月報を「単位」の一覧にする
const INF_CAT = "感染症及び寄生虫症";
// 感染症として数える範囲：乙表で感染症に分類した病名に加え、胃腸炎・下痢症・インフルエンザ・新型コロナは、
// 公館が消化器・呼吸器に分類していても感染症として数える（公館によって分類の付け方が違い、章によって件数が食い違っていた）
const INF_EXTRA_RE = /胃腸炎|腸炎|下痢|インフルエンザ|新型コロナ|コロナウイルス|COVID/;
const isInfectious = (name, c) => c === INF_CAT || (c !== Z && INF_EXTRA_RE.test(name));
// PDFでは、精神・行動の病名を公館別に載せない（件数の少ない公館では個人が特定されやすい）。PDFを作る間だけ true
let PRIV_MENTAL = false;
// 分類にかかわらず、こころの病名とみなす語（自殺念慮など。分類が漏れても公館別に出さないための安全網）
const MENTAL_SENSITIVE_RE = /自殺|希死|自傷|念慮|精神|心因|うつ病|抑うつ/;
// 妊娠・出産も、件数の少ない公館では「誰が妊娠中か」が分かるので、公館別の文には出さない（妊婦健診などの検診も）
const PREG_RE = /妊娠|妊婦|流産|早産|悪阻|つわり|分娩|出産|産褥|産じょく/;
const isMentalLike = (name, cat) => cat === "精神及び行動の障害" || cat === "妊娠、分娩及び産じょく" || MENTAL_SENSITIVE_RE.test(String(name || "")) || PREG_RE.test(String(name || ""));
// 対象の公館が少ない（MENTAL_MIN_POSTS 未満）ときは、上位の病名・分類の表から精神・行動、妊娠・出産を除く（受診した人が特定されうるため）
// 同じ一覧で何度も呼ばれる（病名1件ごとなど）ので、一覧ごとに結果を覚えておく
const FEW_CACHE = new WeakMap();
const fewPosts = (dis) => { let v = FEW_CACHE.get(dis); if (v === undefined) { v = new Set(dis.map((d) => d.post)).size < 3; FEW_CACHE.set(dis, v); } return v; };
const fewHide = (dis) => fewPosts(dis) && PRIV_MENTAL;
const privTop = (dis) => (fewHide(dis) ? dis.filter((d) => !isMentalLike(d.name, d.category || classify(d.name, d.cat))) : dis);
const FEW_NOTE = "※対象の公館が3つ未満のため、精神・行動、妊娠・出産の病名・件数は示していません（受診した人が特定されうるため）。";
const privDis = (dis) => (PRIV_MENTAL ? dis.filter((d) => !isMentalLike(d.name, d.category || classify(d.name, d.cat))) : dis);
function fsFacts(o, m) {
  const ms = spanMonths(m, o.span), inS = inReportScope(o.regions, o.posts), out = [];
  for (const mm of ms) {
    const ev = casesOf(mm, "evac"), hg = casesOf(mm, "hogo");
    for (const r of reportsOf(mm)) {
      if (!inS(r.post)) continue;
      const cats = {}, groups = {}, inf = {}, dl = [];
      let real = 0, z = 0;
      for (const d of r.diseases || []) {
        const c = classify(d.name, d.cat);
        dl.push({ n: cleanDiseaseName(d.name), c, k: d.count });
        if (c === Z) { z += d.count; continue; }
        real += d.count; cats[c] = (cats[c] || 0) + d.count;
        const g = groupOf(d.name); groups[g] = (groups[g] || 0) + d.count;
        if (isInfectious(cleanDiseaseName(d.name), c)) inf[g] = (inf[g] || 0) + d.count;   // 感染症（病名のまとめごと。INF_EXTRA_RE の病名を含む）
      }
      out.push({ month: mm, post: r.post, region: aiRegionOf(r.post), staff: r.staff, family: r.family, other: r.other, total: r.total, real, z, cats, groups, inf, dl,
        evac: ev.filter((c) => c.post === r.post).length, hogo: hg.filter((c) => c.post === r.post).length,
        ob: reportOutbreaks(r).filter((x) => x.trend === "流行・増加").length });
    }
  }
  return { facts: out, ms };
}
function fsValue(f, measure, param) {
  if (measure === "posts") return 1;
  if (measure === "cat") return f.cats[param] || 0;
  if (measure === "dis") return f.groups[param] || 0;
  const v = f[measure];
  return v === null || v === undefined || v === "" ? null : Number(v);
}
// 1つの単位から、分け方に応じた [ {keys:{dim:key}, v} ] を作る（分類・病名・区分で分けるときは1単位から複数）
function fsPoints(facts, o, dims) {
  const item = dims.find((d) => FS_ITEM_DIMS.includes(d));
  const pts = [];
  for (const f of facts) {
    const base = { month: f.month, region: f.region, post: f.post };
    let items;
    if (item === "cat") items = Object.entries(f.cats).map(([k, v]) => [k, v]);
    else if (item === "dis") items = Object.entries(f.groups).map(([k, v]) => [k, v]);
    else if (item === "kind") items = VISIT_KEYS.map(([k, l]) => [l, f[k] == null ? null : Number(f[k])]);
    else items = [[null, fsValue(f, o.measure, o.param)]];
    for (const [k, v] of items) {
      if (v === null || !Number.isFinite(v)) continue;
      const keys = {};
      for (const d of dims) keys[d] = FS_ITEM_DIMS.includes(d) ? k : base[d];
      pts.push({ keys, v, f });
    }
  }
  return pts;
}
const fsAggregate = (vals, agg) => (!vals.length ? 0 : agg === "mean" ? vals.reduce((a, b) => a + b, 0) / vals.length : agg === "median" ? describe(vals).median : vals.reduce((a, b) => a + b, 0));
// 横軸・色分けの並び（月は古い順、地域は決まった順、そのほかは値の大きい順。上位N）
// 並び順 sort：auto＝国は50音順・そのほかは多い順、kana＝50音順、value＝多い順（上位N件は常に多い順で選ぶ）
function fsOrder(dim, pts, ms, top, sort = "auto") {
  if (dim === "month") return ms;
  const tot = {};
  for (const p of pts) tot[p.keys[dim]] = (tot[p.keys[dim]] || 0) + p.v;
  let keys = Object.keys(tot);
  if (dim === "region") return [...AI_REGIONS, "未分類"].filter((g) => keys.includes(g));
  if (dim === "kind") return VISIT_KEYS.map((v) => v[1]).filter((k) => keys.includes(k));
  keys.sort((a, b) => tot[b] - tot[a]);
  if (top) keys = keys.slice(0, top);
  const kana = sort === "kana" || (sort === "auto" && dim === "post");
  return kana ? keys.sort(dim === "cat" ? (a, b) => jaCmp(shortCat(a), shortCat(b)) : jaCmp) : keys;
}
// 最小二乗の直線と相関
function fsRegress(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (!sxx) return null;
  const b = sxy / sxx, a = my - b * mx, r = syy ? sxy / Math.sqrt(sxx * syy) : 0;
  return { a, b, r, r2: r * r, n };
}
function fsSpearman(xs, ys) {
  const rank = (v) => { const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = new Array(v.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
  const reg = fsRegress(rank(xs), rank(ys));
  return reg ? reg.r : null;
}
const fsCorrWord = (r) => { const a = Math.abs(r); return a >= 0.7 ? "強い" : a >= 0.4 ? "中程度の" : a >= 0.2 ? "弱い" : "ほとんどない"; };

function mountFreeStats() {
  if (page !== "stats" || !main.querySelector(".kpis") || $("#fsCard")) return;
  const m = curMonth();
  const o = Object.assign({}, FS_DEFAULT, loadPrefs().freeStats || {});
  const withData = [...new Set(Object.values(state.reports).map((r) => r.post))].sort((a, b) => AI_REGIONS.indexOf(aiRegionOf(a)) - AI_REGIONS.indexOf(aiRegionOf(b)) || jaCmp(a, b));
  o.posts = (o.posts || []).filter((x) => withData.includes(x));
  const allCats = CATEGORIES.filter((c) => c !== Z);
  const card = document.createElement("div");
  card.className = "card fs";
  card.id = "fsCard";
  const sel = (id, list, v) => `<select id="${id}">${list.map(([k, l]) => `<option value="${k}"${k === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  card.innerHTML = `
    <h3 style="margin-top:0">🔧 自由集計 ― 好きなグラフ・統計を作る</h3>
    <p class="muted" style="margin-top:0">期間・対象・指標・分け方・グラフの種類を選ぶと、すぐにグラフと記述統計・集計表ができます（計算はすべてブラウザの中）。</p>
    <div class="row fs-presets"><b>よく使う例：</b>${FS_PRESETS.map(([l], i) => `<button class="linklike" data-fsp="${i}">${esc(l)}</button>`).join("")}</div>
    <div class="fs-grid">
      <label>期間 ${sel("fsSpan", REPORT_SPANS.map(([k, t]) => [String(k), t]), String(o.span))}</label>
      <label>指標 ${sel("fsMeasure", FS_MEASURES.map(([k, l]) => [k, l]), o.measure)}</label>
      <label id="fsParamL">　${sel("fsParam", [], o.param)}</label>
      <label>集計方法 ${sel("fsAgg", FS_AGG, o.agg)}</label>
      <label>横軸 ${sel("fsX", FS_DIMS, o.x)}</label>
      <label>色分け ${sel("fsColor", [["", "なし"], ...FS_DIMS], o.color)}</label>
      <label>上位 ${sel("fsTop", [["10", "10"], ["15", "15"], ["20", "20"], ["30", "30"], ["0", "すべて"]], String(o.top))}</label>
      <label>並び順 ${sel("fsSort", FS_SORTS, o.sort)}</label>
      <label>グラフ ${sel("fsChart", FS_CHARTS, o.chart)}</label>
      <label id="fsM2L">縦軸の指標 ${sel("fsMeasure2", FS_MEASURES.filter(([k]) => k !== "posts").map(([k, l]) => [k, l]), o.measure2)}</label>
    </div>
    <div class="row"><b>地域</b><span class="seg"><button data-fsreg="">🌏 全世界</button>${loadPrefs().homePost && withData.includes(loadPrefs().homePost) ? `<button data-fshome="${esc(loadPrefs().homePost)}">🏠 自分の公館</button>` : ""}${AI_REGIONS.map((g) => `<button data-fsreg="${esc(g)}">${esc(g)}</button>`).join("")}</span>
      <b>国</b><input id="fsPost" data-combo="fsPostList" placeholder="国名を入力して追加" autocomplete="off" size="14"><span id="fsPostChips"></span></div>
    <datalist id="fsPostList">${withData.slice().sort(jaCmp).map((x) => `<option value="${esc(x)}" label="${esc(aiRegionOf(x))}"></option>`).join("")}</datalist>
    <div id="fsMsg" class="muted"></div>
    <div id="fsPlot" style="min-height:420px"></div>
    <div class="row"><button id="fsPng">🖼 グラフを画像で保存</button><button id="fsCsv">📄 集計表をCSVで保存</button>
      <label><input type="checkbox" id="fsPct"${o.pct ? " checked" : ""}> 集計表を構成比（％）で表示</label>
      <span class="muted">保存したファイルは、医務官のみがアクセスできるフォルダに置いてください。</span></div>
    <div id="fsStats"></div>`;
  main.querySelector(".kpis").insertAdjacentElement("afterend", card);
  const $c = (s) => card.querySelector(s);

  const fillParam = () => {
    const meas = $c("#fsMeasure").value;
    $c("#fsParamL").hidden = !["cat", "dis"].includes(meas);
    if (meas === "cat") $c("#fsParam").innerHTML = allCats.map((c) => `<option value="${esc(c)}"${c === o.param ? " selected" : ""}>${esc(shortCat(c))}</option>`).join("");
    if (meas === "dis") {
      const g = {};
      for (const d of diseasesOf()) if (d.category !== Z) g[groupOf(d.name)] = (g[groupOf(d.name)] || 0) + d.count;
      const names = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 80).map((x) => x[0]);
      $c("#fsParam").innerHTML = names.map((nm) => `<option${nm === o.param ? " selected" : ""}>${esc(nm)}</option>`).join("");
    }
  };
  const read = () => {
    Object.assign(o, { span: Number($c("#fsSpan").value), measure: $c("#fsMeasure").value, param: $c("#fsParam").value, agg: $c("#fsAgg").value,
      x: $c("#fsX").value, color: $c("#fsColor").value, top: Number($c("#fsTop").value), chart: $c("#fsChart").value, measure2: $c("#fsMeasure2").value, pct: $c("#fsPct").checked, sort: $c("#fsSort").value });
    savePref("freeStats", o);
  };
  const showScope = () => {
    card.querySelectorAll("[data-fsreg]").forEach((b) => b.classList.toggle("on", b.dataset.fsreg ? o.regions.includes(b.dataset.fsreg) : !o.regions.length && !o.posts.length));
    card.querySelectorAll("[data-fshome]").forEach((b) => b.classList.toggle("on", !o.regions.length && o.posts.length === 1 && o.posts[0] === b.dataset.fshome));
    $c("#fsPostChips").innerHTML = o.posts.map((x) => `<button class="ai-post on chip-x" data-fsdel="${esc(x)}" title="押すと選択を外します">${esc(x)}<span class="x">✕</span></button>`).join("");
    card.querySelectorAll("[data-fsdel]").forEach((b) => (b.onclick = () => { o.posts = o.posts.filter((x) => x !== b.dataset.fsdel); savePref("freeStats", o); draw(); }));
  };
  let last = null;  // 直近の集計表（CSV用）

  const draw = () => {
    fillParam(); read(); showScope();
    $c("#fsM2L").hidden = o.chart !== "scatter";
    const unit = (FS_MEASURES.find((x) => x[0] === o.measure) || [])[2] || "";
    const { facts, ms } = fsFacts(o, m);
    const scopeTxt = `${reportLabel(m, o.span)}・${regionsLabel(o.regions, o.posts)}・月報${facts.length}件`;
    const el = $c("#fsPlot"), st = $c("#fsStats");
    Plotly.purge(el);
    if (!facts.length) { $c("#fsMsg").textContent = `対象：${scopeTxt}　選んだ期間・対象の月報がありません。`; el.innerHTML = ""; st.innerHTML = ""; last = null; return; }
    // 分け方の組み合わせの調整（分類・病名・区分は同時に1つだけ）
    let x = o.x, color = o.color === o.x ? "" : o.color;
    const notes = [];
    if (FS_ITEM_DIMS.includes(x) && FS_ITEM_DIMS.includes(color)) { notes.push("疾病分類・病名・受診者区分は同時に1つだけ使えるため、色分けを外しました。"); color = ""; }
    const item = [x, color].find((d) => FS_ITEM_DIMS.includes(d));
    if (item === "kind") notes.push("受診者区分で分けたときの指標は受診者数です。");
    if (item === "cat" || item === "dis") notes.push(`${item === "cat" ? "疾病分類" : "病名"}で分けたときの指標は実患の件数です。`);
    const mLabel = item === "kind" ? "受診者数" : item ? "実患の件数" : (FS_MEASURES.find((z) => z[0] === o.measure) || [])[1] + (["cat", "dis"].includes(o.measure) && o.param ? `：${o.measure === "cat" ? shortCat(o.param) : o.param}` : "");
    const aggLabel = (FS_AGG.find((a) => a[0] === o.agg) || [])[1];
    $c("#fsMsg").innerHTML = `対象：${esc(scopeTxt)}　指標：${esc(mLabel)}（${esc(aggLabel)}）${notes.length ? `<br>※ ${notes.map(esc).join(" ")}` : ""}`;
    const tpl = { template: chartTemplate() }, title = `${mLabel}（${aggLabel}）`;

    // ---- 散布図：2つの指標を公館ごと（期間の合計）に比べ、相関と回帰直線を出す
    if (o.chart === "scatter") {
      const byPost = {};
      for (const f of facts) {
        const b = (byPost[f.post] ||= { x: 0, y: 0, k: 0, region: f.region });
        const vx = fsValue(f, o.measure, o.param), vy = fsValue(f, o.measure2, o.param);
        if (vx !== null && vy !== null) { b.x += vx; b.y += vy; b.k++; }
      }
      const ps = Object.entries(byPost).filter(([, b]) => b.k).sort((a, b) => jaCmp(a[0], b[0]));
      const xs = ps.map(([, b]) => b.x), ys = ps.map(([, b]) => b.y), reg = fsRegress(xs, ys), rho = fsSpearman(xs, ys);
      const l1 = (FS_MEASURES.find((z) => z[0] === o.measure) || [])[1], l2 = (FS_MEASURES.find((z) => z[0] === o.measure2) || [])[1];
      const regs = [...new Set(ps.map(([, b]) => b.region))];
      const traces = regs.map((g) => { const pp = ps.filter(([, b]) => b.region === g); return { type: "scatter", mode: "markers", name: g, x: pp.map(([, b]) => b.x), y: pp.map(([, b]) => b.y), text: pp.map(([p]) => p),
        marker: { size: 10, color: FS_REGION_COL[g] || "#888", opacity: 0.85 }, hovertemplate: "%{text}<br>%{x} / %{y}<extra></extra>" }; });
      if (reg) { const x0 = Math.min(...xs), x1 = Math.max(...xs); traces.push({ type: "scatter", mode: "lines", name: "回帰直線", x: [x0, x1], y: [reg.a + reg.b * x0, reg.a + reg.b * x1], line: { color: "#555", dash: "dash" } }); }
      plot(el, traces, Object.assign({ title: `${l1} と ${l2}（公館ごと・期間の合計）`, xaxis: { title: { text: l1 } }, yaxis: { title: { text: l2 } }, height: 460 }, tpl));
      st.innerHTML = reg ? `<h4>相関と回帰</h4><table class="stats"><tbody>
          <tr><td>公館数</td><td class="num">${ps.length}</td></tr>
          <tr><td>ピアソンの相関係数 r</td><td class="num">${reg.r.toFixed(2)}（${fsCorrWord(reg.r)}${reg.r >= 0 ? "正" : "負"}の相関）</td></tr>
          <tr><td>スピアマンの順位相関 ρ</td><td class="num">${rho === null ? "―" : rho.toFixed(2)}</td></tr>
          <tr><td>決定係数 R²</td><td class="num">${reg.r2.toFixed(2)}</td></tr>
          <tr><td>回帰直線</td><td class="num">${esc(l2)} ＝ ${reg.a.toFixed(1)} ＋ ${reg.b.toFixed(3)} × ${esc(l1)}</td></tr></tbody></table>
          <p class="muted">相関は2つの数値が一緒に増減する程度で、原因と結果の関係を示すものではありません。公館数が少ないときは偶然の影響が大きくなります。</p>` : '<p class="muted">点が少ないため、相関を計算できません。</p>';
      last = { head: ["公館", "地域", l1, l2], rows: ps.map(([p, b]) => [p, b.region, b.x, b.y]) };
      return;
    }

    const dims = [x, color].filter(Boolean);
    const pts = fsPoints(facts, o, dims);
    const xKeys = fsOrder(x, pts, ms, ["post", "dis"].includes(x) ? o.top : 0, o.sort);
    const cKeys = color ? fsOrder(color, pts, ms, ["post", "dis"].includes(color) ? o.top : 0, o.sort) : [null];
    const cell = (xk, ck) => fsAggregate(pts.filter((p) => p.keys[x] === xk && (!color || p.keys[color] === ck)).map((p) => p.v), o.agg);
    const grid = cKeys.map((ck) => xKeys.map((xk) => cell(xk, ck)));
    const xl = xKeys.map((k) => fsLabel(x, k)), cl = cKeys.map((k) => (k === null ? mLabel : fsLabel(color, k)));

    // ---- グラフ
    if (o.chart === "pie") {
      const vals = xKeys.map((xk) => fsAggregate(pts.filter((p) => p.keys[x] === xk).map((p) => p.v), o.agg));
      const f = donutFig(xKeys.map((k, i) => ({ label: xl[i], value: vals[i], color: fsColor(x, k, i) })), { title, unit, top: 10 });
      plot(el, f.traces, Object.assign(f.layout, { height: 440 }, tpl));
    } else if (o.chart === "box") {
      const traces = xKeys.map((xk, i) => ({ type: "box", name: xl[i], y: pts.filter((p) => p.keys[x] === xk).map((p) => p.v), boxpoints: "all", jitter: 0.4, pointpos: 0,
        marker: { color: fsColor(x, xk, i), size: 4, opacity: 0.6 }, text: pts.filter((p) => p.keys[x] === xk).map((p) => `${p.f.post}・${fmtMonth(p.f.month)}`), hovertemplate: "%{text}: %{y}<extra></extra>" }));
      plot(el, traces, Object.assign({ title: `${mLabel}のばらつき（1公館1か月ごとの値）`, showlegend: false, yaxis: { title: { text: unit } }, height: 460 }, tpl));
    } else if (o.chart === "hist") {
      const groups = color ? cKeys.map((ck, i) => ({ name: cl[i], v: pts.filter((p) => p.keys[color] === ck).map((p) => p.v), c: fsColor(color, ck, i) })) : [{ name: mLabel, v: pts.map((p) => p.v), c: FS_PALETTE[0] }];
      plot(el, groups.map((g) => ({ type: "histogram", name: g.name, x: g.v, marker: { color: g.c }, opacity: color ? 0.6 : 0.9 })),
        Object.assign({ title: `${mLabel}の分布（1公館1か月ごとの値）`, barmode: "overlay", xaxis: { title: { text: unit } }, yaxis: { title: { text: "度数" } }, height: 440 }, tpl));
    } else if (o.chart === "heat") {
      if (!color) { el.innerHTML = '<p class="muted">ヒートマップは「色分け」も選んでください（例：横軸＝月、色分け＝病名）。</p>'; }
      // 少ないほど青、多いほど赤。いちばん多いものを上に置く
      else plot(el, [{ type: "heatmap", x: xl, y: cl, z: grid, colorscale: HEAT_BR, hovertemplate: "%{y} × %{x}: %{z}<extra></extra>" }],
        Object.assign({ title, height: Math.max(360, 28 * cKeys.length + 140), margin: { l: 160, r: 20, t: 56, b: 60 }, yaxis: { autorange: "reversed", automargin: true } }, tpl));
    } else {
      const horiz = o.chart === "barh", isLine = o.chart === "line";
      let g2 = grid;
      if (o.chart === "stack100") g2 = grid.map((row) => row.map((v, j) => { const t = grid.reduce((a, r) => a + r[j], 0); return t ? (100 * v) / t : 0; }));
      const traces = cKeys.map((ck, i) => ({ type: isLine ? "scatter" : "bar", mode: isLine ? "lines+markers" : undefined, name: cl[i], orientation: horiz ? "h" : "v",
        x: horiz ? g2[i] : xl, y: horiz ? xl : g2[i], marker: { color: color ? fsColor(color, ck, i) : x === "region" || x === "cat" ? xKeys.map((k, j) => fsColor(x, k, j)) : FS_PALETTE[0] },
        line: isLine ? { color: color ? fsColor(color, ck, i) : FS_PALETTE[0], width: 2.5 } : undefined }));
      plot(el, traces, Object.assign({ title: o.chart === "stack100" ? `${mLabel}の構成比（％）` : title, barmode: ["stack", "stack100"].includes(o.chart) ? "stack" : "group",
        showlegend: !!color, height: horiz ? Math.max(380, 24 * xKeys.length + 140) : 460,
        xaxis: horiz ? { title: { text: o.chart === "stack100" ? "％" : unit } } : { automargin: true }, yaxis: horiz ? { autorange: "reversed", automargin: true } : { title: { text: o.chart === "stack100" ? "％" : unit } } }, tpl));
    }

    // ---- 記述統計（横軸ごと。1公館1か月ごとの値のばらつき）
    // 表示している色分けの項目（上位）だけを数える
    const shown = (p) => !color || cKeys.includes(p.keys[color]);
    const dRows = xKeys.map((xk, i) => [xl[i], describe(pts.filter((p) => p.keys[x] === xk && shown(p)).map((p) => p.v))]);
    dRows.push(["全体", describe(pts.filter((p) => xKeys.includes(p.keys[x]) && shown(p)).map((p) => p.v))]);
    const descTable = `<h4>記述統計（${esc(fsLabel("x", FS_DIMS.find((d) => d[0] === x)[1]))}ごと・1公館1か月ごとの値）</h4>
      <div class="table-wrap"><table class="stats"><thead><tr><th>${esc(FS_DIMS.find((d) => d[0] === x)[1])}</th><th class="num">件数</th><th class="num">合計</th><th class="num">平均</th><th class="num">標準偏差</th>
        <th class="num">最小</th><th class="num">第1四分位</th><th class="num">中央値</th><th class="num">第3四分位</th><th class="num">最大</th><th class="num">変動係数</th></tr></thead>
        <tbody>${dRows.map(([l, d], i) => `<tr class="${i === dRows.length - 1 ? "sub" : ""}"><td>${esc(l)}</td>${d.n ? `<td class="num">${d.n}</td><td class="num">${f1(d.total)}</td><td class="num">${f1(d.mean)}</td><td class="num">${f1(d.sd)}</td>
          <td class="num">${f1(d.min)}</td><td class="num">${f1(d.q1)}</td><td class="num"><b>${f1(d.median)}</b></td><td class="num">${f1(d.q3)}</td><td class="num">${f1(d.max)}</td><td class="num">${d.mean ? Math.round(100 * d.cv) + "%" : "―"}</td>`
          : '<td class="num">0</td><td colspan="9" class="muted">データなし</td>'}</tr>`).join("")}</tbody></table></div>`;
    // ---- 集計表（横軸 × 色分け）
    const totals = xKeys.map((_, j) => grid.reduce((a, r) => a + r[j], 0));
    const fmt = (v, j) => (o.pct && color ? (totals[j] ? (Math.round((1000 * v) / totals[j]) / 10).toFixed(1) + "%" : "―") : f1(v));
    const pivot = `<h4>集計表（${esc(aggLabel)}）</h4><div class="table-wrap"><table class="stats"><thead><tr><th>${esc(FS_DIMS.find((d) => d[0] === x)[1])}</th>
        ${color ? cl.map((c) => `<th class="num">${esc(c)}</th>`).join("") : `<th class="num">${esc(mLabel)}</th>`}${color && o.agg === "sum" ? '<th class="num">計</th>' : ""}</tr></thead>
      <tbody>${xKeys.map((_, j) => `<tr><td>${esc(xl[j])}</td>${grid.map((r) => `<td class="num">${fmt(r[j], j)}</td>`).join("")}${color && o.agg === "sum" ? `<td class="num"><b>${f1(totals[j])}</b></td>` : ""}</tr>`).join("")}
      ${o.agg === "sum" ? `<tr class="sub"><td>合計</td>${grid.map((r) => `<td class="num">${f1(r.reduce((a, b) => a + b, 0))}</td>`).join("")}${color ? `<td class="num"><b>${f1(totals.reduce((a, b) => a + b, 0))}</b></td>` : ""}</tr>` : ""}</tbody></table></div>`;
    // ---- 傾向（横軸が月のとき）：月ごとの値に直線を当てはめ、1か月あたりの増減を出す
    let trend = "";
    if (x === "month" && xKeys.length >= 3) {
      const rowsT = cKeys.map((ck, i) => { const ys = grid[i], reg = fsRegress(ys.map((_, k) => k), ys); return [cl[i], reg, ys[0], ys[ys.length - 1]]; }).filter(([, r]) => r);
      if (rowsT.length) trend = `<h4>傾向（月ごとの値に直線を当てはめた結果）</h4><div class="table-wrap"><table class="stats"><thead><tr><th>系列</th><th class="num">1か月あたりの増減</th><th class="num">決定係数 R²</th><th class="num">最初の月</th><th class="num">最後の月</th><th>見立て</th></tr></thead>
        <tbody>${rowsT.map(([l, r, a, b]) => `<tr><td>${esc(l)}</td><td class="num">${r.b >= 0 ? "+" : ""}${r.b.toFixed(2)}</td><td class="num">${r.r2.toFixed(2)}</td><td class="num">${f1(a)}</td><td class="num">${f1(b)}</td>
          <td>${r.r2 < 0.3 ? "はっきりした傾向なし" : r.b > 0 ? "増加傾向" : "減少傾向"}</td></tr>`).join("")}</tbody></table></div>
        <p class="muted">決定係数が0.3未満のときは、増減のばらつきが大きく、直線的な傾向とは言えません。提出公館数が月によって違うときは、合計より平均で比べると公平です。</p>`;
    }
    // 3つの表は縦に並べると長いので、切り替えて1つずつ見せる（選んだものは覚える）
    const parts = [["desc", "📋 記述統計", descTable], ["pivot", "🔢 集計表", pivot], ["trend", "📈 傾向", trend]].filter(([, , h]) => h);
    const cur = parts.some(([k]) => k === loadPrefs().fsTab) ? loadPrefs().fsTab : parts[0][0];
    st.innerHTML = `<div class="seg fstabs">${parts.map(([k, l]) => `<button data-fstab="${k}" class="${k === cur ? "on" : ""}">${l}</button>`).join("")}</div>` +
      parts.map(([k, , h]) => `<div class="fstab" data-fsp="${k}"${k === cur ? "" : " hidden"}>${h}</div>`).join("");
    st.querySelectorAll("[data-fstab]").forEach((b) => (b.onclick = () => {
      savePref("fsTab", b.dataset.fstab);
      st.querySelectorAll("[data-fstab]").forEach((x) => x.classList.toggle("on", x === b));
      st.querySelectorAll("[data-fsp]").forEach((x) => (x.hidden = x.dataset.fsp !== b.dataset.fstab));
    }));
    scrollTables(st, 8);
    last = { head: [FS_DIMS.find((d) => d[0] === x)[1], ...(color ? cl : [mLabel])], rows: xKeys.map((_, j) => [xl[j], ...grid.map((r) => Math.round(r[j] * 100) / 100)]) };
  };

  card.querySelectorAll("select, #fsPct").forEach((s) => (s.onchange = draw));
  card.querySelectorAll("[data-fshome]").forEach((b) => (b.onclick = () => { o.regions = []; o.posts = [b.dataset.fshome]; savePref("freeStats", o); draw(); }));
  card.querySelectorAll("[data-fsreg]").forEach((b) => (b.onclick = () => {
    const g = b.dataset.fsreg;
    if (!g) { o.regions = []; o.posts = []; } else o.regions = o.regions.includes(g) ? o.regions.filter((x) => x !== g) : [...o.regions, g];
    savePref("freeStats", o); draw();
  }));
  $c("#fsPost").onchange = () => {
    const v = resolvePlace($c("#fsPost").value);
    if (v && withData.includes(v) && !o.posts.includes(v)) o.posts.push(v);
    else if ($c("#fsPost").value.trim() && !withData.includes(v)) toast("月報のある国から選んでください");
    $c("#fsPost").value = "";
    savePref("freeStats", o); draw();
  };
  card.querySelectorAll("[data-fsp]").forEach((b) => (b.onclick = () => {
    const p = FS_PRESETS[Number(b.dataset.fsp)][1];
    Object.assign(o, { color: "", top: 15 }, p);
    for (const [id, k] of [["#fsSpan", "span"], ["#fsMeasure", "measure"], ["#fsAgg", "agg"], ["#fsX", "x"], ["#fsColor", "color"], ["#fsTop", "top"], ["#fsChart", "chart"], ["#fsMeasure2", "measure2"]])
      $c(id).value = String(o[k] ?? "");
    draw();
  }));
  $c("#fsPng").onclick = () => { const el = $c("#fsPlot"); if (el.data) Plotly.downloadImage(el, { format: "png", width: 1200, height: 700, filename: `自由集計_${m.replace("-", "")}` }); };
  $c("#fsCsv").onclick = () => {
    if (!last) { toast("集計表がありません"); return; }
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = "﻿" + [last.head, ...last.rows].map((r) => r.map(q).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `自由集計_${m.replace("-", "")}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  draw();
}

// ======================================================================= 推測統計（検定・推定）の計算
// 分布の関数（ガンマ関数・不完全ベータ関数・不完全ガンマ関数から t・F・カイ二乗・正規・ポアソンの確率を出す）
const ST = (() => {
  const logGamma = (x) => {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (const v of c) ser += v / ++y;
    return -tmp + Math.log((2.5066282746310005 * ser) / x);
  };
  // 正則化不完全ベータ関数 I_x(a, b)
  const betacf = (a, b, x) => {
    const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
    let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  };
  const ibeta = (x, a, b) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
  };
  // 正則化下側不完全ガンマ関数 P(a, x)
  const gammaP = (a, x) => {
    if (x <= 0) return 0;
    const gln = logGamma(a);
    if (x < a + 1) {
      let ap = a, sum = 1 / a, del = sum;
      for (let n = 0; n < 1000; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 3e-15) break; }
      return sum * Math.exp(-x + a * Math.log(x) - gln);
    }
    let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
    for (let i = 1; i < 1000; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 3e-15) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
  };
  const normCdf = (z) => 0.5 * (1 + Math.sign(z) * gammaP(0.5, (z * z) / 2));
  const normP2 = (z) => Math.min(1, 2 * (1 - normCdf(Math.abs(z))));
  const tP2 = (t, df) => (df > 0 && Number.isFinite(t) ? ibeta(df / (df + t * t), df / 2, 0.5) : NaN);  // 両側
  const tCdf = (t, df) => { const p = 0.5 * tP2(t, df); return t >= 0 ? 1 - p : p; };
  const tQuantile = (p, df) => { let lo = -1e3, hi = 1e3; for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (tCdf(mid, df) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; };
  const fP = (f, d1, d2) => (f > 0 ? 1 - ibeta((d1 * f) / (d1 * f + d2), d1 / 2, d2 / 2) : 1);
  const chi2P = (x, df) => (x > 0 ? 1 - gammaP(df / 2, x / 2) : 1);
  // ポアソン分布で、平均 lambda のとき k 以上になる確率
  const poissonUpper = (k, lambda) => (k <= 0 ? 1 : lambda <= 0 ? 0 : gammaP(k, lambda));
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const variance = (v) => { const m = mean(v); return v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1); };
  // 順位（同順位は平均順位）
  const ranks = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = new Array(v.length), ties = [];
    for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; if (j > i) ties.push(j - i + 1); i = j + 1; }
    return { r, ties };
  };
  const holm = (ps) => { const o = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]), adj = new Array(ps.length); let run = 0; o.forEach(([p, i], k) => { run = Math.max(run, Math.min(1, (ps.length - k) * p)); adj[i] = run; }); return adj; };

  // 2群：ウェルチの t 検定（平均の差・95%信頼区間・効果量 d）
  function welch(a, b) {
    const n1 = a.length, n2 = b.length;
    if (n1 < 2 || n2 < 2) return null;
    const m1 = mean(a), m2 = mean(b), v1 = variance(a), v2 = variance(b), se = Math.sqrt(v1 / n1 + v2 / n2);
    const df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
    const t = se ? (m1 - m2) / se : 0, q = tQuantile(0.975, df), sp = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
    return { n1, n2, m1, m2, diff: m1 - m2, lo: m1 - m2 - q * se, hi: m1 - m2 + q * se, t, df, p: se ? tP2(t, df) : 1, d: sp ? (m1 - m2) / sp : 0 };
  }
  // 2群：マン・ホイットニーの U 検定（正規近似・同順位の補正）
  function mannWhitney(a, b) {
    const n1 = a.length, n2 = b.length, N = n1 + n2;
    if (!n1 || !n2) return null;
    const { r, ties } = ranks([...a, ...b]);
    const R1 = r.slice(0, n1).reduce((x, y) => x + y, 0), U1 = R1 - (n1 * (n1 + 1)) / 2, U = Math.min(U1, n1 * n2 - U1);
    const tc = ties.reduce((s, t) => s + t ** 3 - t, 0), sd = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tc / (N * (N - 1))));
    const z = sd ? (U1 - (n1 * n2) / 2) / sd : 0;
    return { U, U1, z, p: sd ? normP2(z) : 1, r: z / Math.sqrt(N), ps: U1 / (n1 * n2) };
  }
  // 3群以上：一元配置分散分析とクラスカル・ウォリス検定
  function anova(groups) {
    const gs = groups.filter((g) => g.length), k = gs.length, all = gs.flat(), N = all.length;
    if (k < 2 || N <= k) return null;
    const gm = mean(all), ssb = gs.reduce((s, g) => s + g.length * (mean(g) - gm) ** 2, 0), ssw = gs.reduce((s, g) => s + g.reduce((a, x) => a + (x - mean(g)) ** 2, 0), 0);
    const df1 = k - 1, df2 = N - k, F = ssw ? ssb / df1 / (ssw / df2) : 0;
    return { F, df1, df2, p: ssw ? fP(F, df1, df2) : 1, eta2: ssb / (ssb + ssw || 1) };
  }
  function kruskal(groups) {
    const gs = groups.filter((g) => g.length), k = gs.length, all = gs.flat(), N = all.length;
    if (k < 2 || N < 3) return null;
    const { r, ties } = ranks(all);
    let pos = 0, H = 0;
    for (const g of gs) { const R = r.slice(pos, pos + g.length).reduce((a, b) => a + b, 0); H += (R * R) / g.length; pos += g.length; }
    H = (12 / (N * (N + 1))) * H - 3 * (N + 1);
    const tc = 1 - ties.reduce((s, t) => s + t ** 3 - t, 0) / (N ** 3 - N);
    if (tc > 0) H /= tc;
    return { H, df: k - 1, p: chi2P(H, k - 1), eps2: H / (N - 1) };
  }
  // 対応のある2つ：対応のある t 検定とウィルコクソンの符号順位検定
  function paired(x, y) {
    const d = x.map((v, i) => v - y[i]), n = d.length;
    if (n < 2) return null;
    const md = mean(d), sd = Math.sqrt(variance(d)), se = sd / Math.sqrt(n), t = se ? md / se : 0, q = tQuantile(0.975, n - 1);
    const nz = d.filter((v) => v !== 0), { r, ties } = ranks(nz.map(Math.abs)), Wp = nz.reduce((s, v, i) => s + (v > 0 ? r[i] : 0), 0), m = nz.length;
    const sdW = Math.sqrt((m * (m + 1) * (2 * m + 1)) / 24 - ties.reduce((s, t2) => s + t2 ** 3 - t2, 0) / 48);
    const zW = sdW ? (Wp - (m * (m + 1)) / 4) / sdW : 0;
    return { n, md, lo: md - q * se, hi: md + q * se, t, df: n - 1, p: se ? tP2(t, n - 1) : 1, dz: sd ? md / sd : 0, W: Wp, zW, pW: sdW ? normP2(zW) : 1, up: d.filter((v) => v > 0).length, down: d.filter((v) => v < 0).length };
  }
  // 分割表：カイ二乗検定（独立性）、クラメールの V、調整済み残差
  function chisq(table) {
    const R = table.length, C = table[0].length, rs = table.map((r) => r.reduce((a, b) => a + b, 0)), cs = table[0].map((_, j) => table.reduce((a, r) => a + r[j], 0)), N = rs.reduce((a, b) => a + b, 0);
    if (!N || R < 2 || C < 2) return null;
    let x2 = 0, small = 0;
    const res = table.map((row, i) => row.map((o, j) => {
      const e = (rs[i] * cs[j]) / N;
      if (e < 5) small++;
      x2 += e ? (o - e) ** 2 / e : 0;
      const v = e * (1 - rs[i] / N) * (1 - cs[j] / N);
      return v > 0 ? (o - e) / Math.sqrt(v) : 0;
    }));
    const df = (R - 1) * (C - 1);
    return { x2, df, p: chi2P(x2, df), V: Math.sqrt(x2 / (N * Math.min(R - 1, C - 1))), res, smallShare: small / (R * C), N };
  }
  // 割合：ウィルソンの95%信頼区間、2つの割合の差（z 検定・差の95%信頼区間）
  function wilson(x, n) {
    if (!n) return null;
    const z = 1.959964, p = x / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
  }
  function twoProp(x1, n1, x2, n2) {
    if (!n1 || !n2) return null;
    const p1 = x1 / n1, p2 = x2 / n2, pp = (x1 + x2) / (n1 + n2), se0 = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2)), z = se0 ? (p1 - p2) / se0 : 0;
    const w1 = wilson(x1, n1), w2 = wilson(x2, n2), d = p1 - p2;
    // ニューカムの方法による差の信頼区間
    const lo = d - Math.sqrt((p1 - w1.lo) ** 2 + (w2.hi - p2) ** 2), hi = d + Math.sqrt((w1.hi - p1) ** 2 + (p2 - w2.lo) ** 2);
    return { p1, p2, d, lo, hi, z, p: se0 ? normP2(z) : 1 };
  }
  // 相関の検定（ピアソン r の p 値とフィッシャーの z による95%信頼区間）
  function corr(xs, ys) {
    const n = xs.length;
    if (n < 4) return null;
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    if (!sxx || !syy) return null;
    const r = sxy / Math.sqrt(sxx * syy), t = r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r)), zf = Math.atanh(Math.min(0.999999, Math.max(-0.999999, r))), se = 1 / Math.sqrt(n - 3);
    const rr = ranks(xs).r, ry = ranks(ys).r, rho = (() => { const a = mean(rr), b = mean(ry); let s1 = 0, s2 = 0, s3 = 0; for (let i = 0; i < n; i++) { s1 += (rr[i] - a) * (ry[i] - b); s2 += (rr[i] - a) ** 2; s3 += (ry[i] - b) ** 2; } return s1 / Math.sqrt(s2 * s3); })();
    const trho = rho * Math.sqrt((n - 2) / Math.max(1e-12, 1 - rho * rho));
    return { n, r, p: tP2(t, n - 2), lo: Math.tanh(zf - 1.959964 * se), hi: Math.tanh(zf + 1.959964 * se), rho, pRho: tP2(trho, n - 2) };
  }
  // 傾向の検定：回帰の傾きの t 検定と95%信頼区間、マン・ケンドールの傾向検定
  function trend(ys) {
    const n = ys.length;
    if (n < 4) return null;
    const xs = ys.map((_, i) => i), mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    const b = sxy / sxx, a = my - b * mx, sse = ys.reduce((s, y, i) => s + (y - a - b * i) ** 2, 0), se = Math.sqrt(sse / (n - 2) / sxx), q = tQuantile(0.975, n - 2);
    let S = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) S += Math.sign(ys[j] - ys[i]);
    const { ties } = ranks(ys), varS = (n * (n - 1) * (2 * n + 5) - ties.reduce((s, t) => s + t * (t - 1) * (2 * t + 5), 0)) / 18, zS = S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0;
    return { n, b, lo: b - q * se, hi: b + q * se, t: se ? b / se : 0, p: se ? tP2(b / se, n - 2) : 1, S, zS, pMK: normP2(zS), r2: 1 - sse / ys.reduce((s, y) => s + (y - my) ** 2, 0 || 1) };
  }
  // 平均の95%信頼区間（t 分布）
  function meanCI(v) {
    const n = v.length;
    if (n < 2) return null;
    const m = mean(v), se = Math.sqrt(variance(v) / n), q = tQuantile(0.975, n - 1);
    return { n, m, lo: m - q * se, hi: m + q * se };
  }
  return { logGamma, ibeta, gammaP, normCdf, normP2, tP2, tQuantile, fP, chi2P, poissonUpper, holm, welch, mannWhitney, anova, kruskal, paired, chisq, wilson, twoProp, corr, trend, meanCI, mean };
})();

// ======================================================================= 統計タブ「🧪 検定・推定」（推測統計）
// 公館ごとの値（期間の1か月あたりの平均）を1件として比べる（同じ公館の毎月の値は独立でないため、公館ごとにまとめてから検定する）
const INF_TYPES = [["two", "2つの地域の比較（t検定・U検定）"], ["multi", "地域の間の比較（分散分析・クラスカル・ウォリス）"], ["prev", "前の期間との比較（同じ公館・対応のある検定）"],
  ["chi", "構成の違い（カイ二乗検定）"], ["prop", "割合の比較（2つの割合の差）"], ["excess", "件数の異常な増加（流行の早期察知・ポアソン検定）"],
  ["corr", "2つの指標の相関の検定"], ["trend", "増加・減少傾向の検定（回帰・マン・ケンドール）"]];
const INF_MEASURES = FS_MEASURES.filter(([k]) => !["posts", "cat", "dis"].includes(k));
const pFmt = (p) => (!Number.isFinite(p) ? "―" : p < 0.001 ? "p<0.001" : `p=${p.toFixed(3)}`);
const sigWord = (p) => (p < 0.05 ? "偶然のばらつきだけでは説明しにくい（統計的に有意、5%水準）" : "偶然のばらつきの範囲内の可能性がある（統計的に有意な差とは言えない）");
const sizeWord = (v, cuts) => { const a = Math.abs(v); return a < cuts[0] ? "ほとんどない" : a < cuts[1] ? "小さい" : a < cuts[2] ? "中くらい" : "大きい"; };
const f2 = (x) => (Number.isFinite(x) ? (Math.round(x * 100) / 100).toLocaleString("ja-JP") : "―");
// 公館ごとの値（期間の1か月あたりの平均）
function infPostValues(facts, measure) {
  const by = {};
  for (const f of facts) { const v = fsValue(f, measure, ""); if (v === null) continue; (by[f.post] ||= { s: 0, k: 0, region: f.region }); by[f.post].s += v; by[f.post].k++; }
  return Object.fromEntries(Object.entries(by).map(([p, b]) => [p, { v: b.s / b.k, region: b.region }]));
}

// 選んだ検定を行い、{ title, text:[...], head, rows, notes:[...], fig? } を返す
function runInference(o, m) {
  const regsF = o.reg ? [o.reg] : [];
  const cur = fsFacts({ span: o.span, regions: regsF, posts: [] }, m), facts = cur.facts, ms = cur.ms;
  const prevFacts = () => (o.span === 0 ? null : fsFacts({ span: o.span, regions: regsF, posts: [] }, prevMonth(ms[0])).facts);
  const mLabel = (k) => (INF_MEASURES.find((x) => x[0] === k) || [])[1] || k;
  const scopeTxt = `${reportLabel(m, o.span)}・${o.reg || "全世界"}`;
  const notes = ["値は公館ごとに期間の1か月あたりの平均をとり、1公館を1件として比べています。", "p値は「差がないとしたとき、偶然これだけの差が出る確率」の目安です。小さいほど偶然では説明しにくくなります。差の大きさ（効果量・信頼区間）とあわせて読んでください。"];
  if (!facts.length) return { title: "対象の月報がありません", text: [], notes: [] };

  if (o.type === "two" || o.type === "multi") {
    const pv = infPostValues(fsFacts({ span: o.span, regions: [], posts: [] }, m).facts, o.measure);
    const grp = (g) => Object.values(pv).filter((x) => x.region === g).map((x) => x.v);
    if (o.type === "two") {
      const a = grp(o.a), b = grp(o.b), w = ST.welch(a, b), u = ST.mannWhitney(a, b);
      if (!w) return { title: "比べられません", text: ["それぞれの地域に2公館以上の値が必要です。"], notes: [] };
      return { title: `${mLabel(o.measure)}：${o.a} と ${o.b} の比較（${reportLabel(m, o.span)}）`,
        text: [`${o.a}の平均は${f1(w.m1)}、${o.b}の平均は${f1(w.m2)}で、差は${f1(w.diff)}（95%信頼区間 ${f1(w.lo)}〜${f1(w.hi)}）。`,
          `ウェルチのt検定：${pFmt(w.p)}。${sigWord(w.p)}。差の大きさ（効果量d＝${f2(w.d)}）は${sizeWord(w.d, [0.2, 0.5, 0.8])}。`,
          `分布の形によらない検定（マン・ホイットニーのU検定）：${pFmt(u.p)}。`],
        head: ["", o.a, o.b], rows: [["公館数", String(w.n1), String(w.n2)], ["平均", f1(w.m1), f1(w.m2)], ["中央値", f1(describe(a).median), f1(describe(b).median)], ["標準偏差", f1(describe(a).sd), f1(describe(b).sd)]],
        notes: [...notes, "公館数が少ないと、差があっても検出できないことがあります。"], fig: { type: "box", groups: [[o.a, a], [o.b, b]], y: mLabel(o.measure) } };
    }
    const gs = AI_REGIONS.filter((g) => grp(g).length >= 2), an = ST.anova(gs.map(grp)), kw = ST.kruskal(gs.map(grp));
    if (!an) return { title: "比べられません", text: ["2つ以上の地域に、それぞれ2公館以上の値が必要です。"], notes: [] };
    // 多重比較（ホルム法で補正したウェルチのt検定）
    const pairs = [];
    for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) { const w = ST.welch(grp(gs[i]), grp(gs[j])); if (w) pairs.push([gs[i], gs[j], w]); }
    const adj = ST.holm(pairs.map((x) => x[2].p));
    const sig = pairs.map((x, i) => [...x, adj[i]]).filter((x) => x[3] < 0.05).sort((a, b) => a[3] - b[3]);
    return { title: `${mLabel(o.measure)}：地域の間の比較（${reportLabel(m, o.span)}）`,
      text: [`一元配置分散分析：F(${an.df1}, ${an.df2})＝${f2(an.F)}、${pFmt(an.p)}。${sigWord(an.p)}。地域で説明できる割合（η²）は${Math.round(100 * an.eta2)}%（${sizeWord(an.eta2, [0.01, 0.06, 0.14])}）。`,
        `分布の形によらない検定（クラスカル・ウォリス検定）：H＝${f2(kw.H)}、${pFmt(kw.p)}。`,
        sig.length ? `補正後も差がある組（ホルム法、5%水準）：${sig.slice(0, 8).map(([a, b, w]) => `${a}と${b}（差${f1(w.diff)}）`).join("、")}。` : "補正（ホルム法）後に差がある地域の組はありません。"],
      head: ["地域", "公館数", "平均", "95%信頼区間", "中央値"], rows: gs.map((g) => { const ci = ST.meanCI(grp(g)); return [g, String(grp(g).length), f1(ci.m), `${f1(ci.lo)}〜${f1(ci.hi)}`, f1(describe(grp(g)).median)]; }),
      notes: [...notes, "多くの組を比べると偶然「有意」になるものが出るため、ホルム法で補正しています。"], fig: { type: "box", groups: gs.map((g) => [g, grp(g)]), y: mLabel(o.measure) } };
  }

  if (o.type === "prev") {
    const pf = prevFacts();
    if (!pf) return { title: "比べられません", text: ["全期間では前の期間がありません。期間を選んでください。"], notes: [] };
    const a = infPostValues(facts, o.measure), b = infPostValues(pf, o.measure), ps = Object.keys(a).filter((p) => p in b).sort(jaCmp);
    const r = ST.paired(ps.map((p) => a[p].v), ps.map((p) => b[p].v));
    if (!r) return { title: "比べられません", text: ["両方の期間に月報のある公館が2つ以上必要です。"], notes: [] };
    const what = o.span === 1 ? "前月" : `前の${o.span}か月`;
    return { title: `${mLabel(o.measure)}：${what}との比較（${scopeTxt}・同じ公館）`,
      text: [`両方の期間に月報のある${r.n}公館で、${mLabel(o.measure)}の平均の変化は${r.md >= 0 ? "+" : ""}${f1(r.md)}（95%信頼区間 ${f1(r.lo)}〜${f1(r.hi)}）。増えた公館${r.up}、減った公館${r.down}。`,
        `対応のあるt検定：${pFmt(r.p)}。${sigWord(r.p)}。差の大きさ（効果量dz＝${f2(r.dz)}）は${sizeWord(r.dz, [0.2, 0.5, 0.8])}。`,
        `分布の形によらない検定（ウィルコクソンの符号順位検定）：${pFmt(r.pW)}。`],
      head: ["", "今回", what], rows: [["公館数", String(r.n), String(r.n)], ["平均", f1(ST.mean(ps.map((p) => a[p].v))), f1(ST.mean(ps.map((p) => b[p].v)))]],
      notes: [...notes, "同じ公館の今回と前回の差を比べるので、公館ごとの規模の違いの影響を受けにくい方法です。"] };
  }

  if (o.type === "chi" || o.type === "prop") {
    const pf = o.by === "period" ? prevFacts() : null;
    if (o.by === "period" && !pf) return { title: "比べられません", text: ["全期間では前の期間がありません。"], notes: [] };
    const all = o.by === "region" ? fsFacts({ span: o.span, regions: [], posts: [] }, m).facts : facts;
    const groups = o.by === "region" ? (o.type === "prop" ? [o.a, o.b] : AI_REGIONS.filter((g) => all.some((f) => f.region === g))).map((g) => [g, all.filter((f) => f.region === g)])
      : [["今回", facts], [o.span === 1 ? "前月" : "前の期間", pf]];
    if (o.type === "chi") {
      const catTot = {};
      for (const f of facts) for (const [c, v] of Object.entries(f.cats)) catTot[c] = (catTot[c] || 0) + v;
      const top = Object.entries(catTot).sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0]);
      const cols = o.cols === "kind" ? VISIT_KEYS.map((v) => v[1]) : [...top.map(shortCat), "その他"];
      const val = (fs, j) => (o.cols === "kind" ? sum(fs, (f) => f[VISIT_KEYS[j][0]]) : j < top.length ? sum(fs, (f) => f.cats[top[j]] || 0) : sum(fs, (f) => f.real) - sum(top, (c) => sum(fs, (f) => f.cats[c] || 0)));
      const table = groups.map(([, fs]) => cols.map((_, j) => val(fs, j))).filter((r) => r.some((v) => v > 0));
      const names = groups.filter(([, fs]) => cols.some((_, j) => val(fs, j) > 0)).map((g) => g[0]);
      const c = ST.chisq(table);
      if (!c) return { title: "比べられません", text: ["2つ以上の群と2つ以上の項目が必要です。"], notes: [] };
      const marks = [];
      c.res.forEach((row, i) => row.forEach((r, j) => { if (Math.abs(r) >= 1.96) marks.push(`${names[i]}の${cols[j]}が${r > 0 ? "多い" : "少ない"}`); }));
      return { title: `${o.cols === "kind" ? "受診者区分" : "疾病分類"}の構成の違い（${o.by === "region" ? "地域" : "今回と前の期間"}・${scopeTxt}）`,
        text: [`カイ二乗検定：χ²(${c.df})＝${f2(c.x2)}、${pFmt(c.p)}。${sigWord(c.p)}。関連の強さ（クラメールのV＝${f2(c.V)}）は${sizeWord(c.V, [0.1, 0.3, 0.5])}。`,
          marks.length ? `ほかと比べて目立つところ（調整済み残差の絶対値が1.96以上）：${marks.slice(0, 10).join("、")}${marks.length > 10 ? ` ほか${marks.length - 10}` : ""}。` : "ほかと比べて特に目立つマスはありません。",
          ...(c.smallShare > 0.2 ? [`※期待される件数が5未満のマスが${Math.round(100 * c.smallShare)}%あり、結果は不安定です。`] : [])],
        head: ["", ...cols], rows: table.map((r, i) => [names[i], ...r.map((v, j) => `${v}${c.res[i][j] >= 1.96 ? " ▲" : c.res[i][j] <= -1.96 ? " ▼" : ""}`)]),
        notes: [...notes.slice(1), "表の ▲ はほかと比べて多い、▼ は少ないマス（調整済み残差の絶対値1.96以上）。件数そのもの（1件＝1件）を数えています。"] };
    }
    // 割合の比較
    const [kind, key] = (o.target || "").split(":");
    const cnt = (fs) => sum(fs, (f) => (kind === "c" ? f.cats[key] || 0 : f.groups[key] || 0));
    const [[g1, f1s], [g2, f2s]] = groups;
    const x1 = cnt(f1s), n1 = sum(f1s, (f) => f.real), x2 = cnt(f2s), n2 = sum(f2s, (f) => f.real), r = ST.twoProp(x1, n1, x2, n2);
    const tname = kind === "c" ? shortCat(key) : key;
    if (!r) return { title: "比べられません", text: ["どちらかの群に実患の件数がありません。"], notes: [] };
    const pc = (v) => (100 * v).toFixed(1) + "%";
    return { title: `実患のうち「${tname}」の割合の比較（${g1} と ${g2}）`,
      text: [`${g1}：${x1}/${n1}件（${pc(r.p1)}）、${g2}：${x2}/${n2}件（${pc(r.p2)}）。割合の差は${r.d >= 0 ? "+" : ""}${(100 * r.d).toFixed(1)}ポイント（95%信頼区間 ${(100 * r.lo).toFixed(1)}〜${(100 * r.hi).toFixed(1)}）。`,
        `2つの割合の差の検定：${pFmt(r.p)}。${sigWord(r.p)}。`],
      head: ["", "件数", "実患の件数", "割合", "95%信頼区間"], rows: [[g1, x1, n1], [g2, x2, n2]].map(([g, x, n]) => { const w = ST.wilson(x, n); return [g, String(x), String(n), pc(w.p), `${pc(w.lo)}〜${pc(w.hi)}`]; }),
      notes: ["割合は実患の件数（乙表・検診等を除く）に占める割合です。信頼区間はウィルソンの方法、差の信頼区間はニューカムの方法。", notes[1]] };
  }

  if (o.type === "excess") {
    // 今月の件数を、その公館の前の12か月の平均と比べる（ポアソン分布）
    const base = fsFacts({ span: 12, regions: regsF, posts: [] }, prevMonth(m)).facts, now = fsFacts({ span: 1, regions: regsF, posts: [] }, m).facts, rows = [];
    let tests = 0;
    for (const f of now) {
      const hist = base.filter((b) => b.post === f.post);
      if (hist.length < 3) continue;
      for (const [g, obs] of Object.entries(f.groups)) {
        tests++;
        const lam = Math.max(sum(hist, (h) => h.groups[g] || 0) / hist.length, 0.2), p = ST.poissonUpper(obs, lam);
        if (obs >= 3 && p < 0.01) rows.push([f.post, g, obs, lam, p, hist.length]);
      }
    }
    rows.sort((a, b) => a[4] - b[4]);
    const bonf = 0.05 / Math.max(1, tests);
    return { title: `件数の異常な増加（${fmtMonth(m)}・${o.reg || "全世界"}）`,
      text: rows.length ? [`${tests}通り（公館×病名）を調べ、いつもより明らかに多いもの（今月3件以上で p<0.01）が${rows.length}件ありました。`,
        `うち、調べた数の多さを考えても偶然とは言いにくいもの（ボンフェローニ補正 p<${Number(bonf.toPrecision(2)).toFixed(Math.max(2, 1 - Math.floor(Math.log10(bonf))))}）：${rows.filter((r) => r[4] < bonf).map((r) => `${r[0]}の${r[1]}`).slice(0, 8).join("、") || "なし"}。`]
        : [`${tests}通り（公館×病名）を調べ、いつもより明らかに多いもの（今月3件以上で p<0.01）はありませんでした。`],
      head: ["公館", "病名", "今月", "いつもの月平均", "比", "p値", "判定"], rows: rows.slice(0, 25).map(([p, g, obs, lam, pv, k]) => [p, g, String(obs), `${f2(lam)}（${k}か月）`, `${f2(obs / lam)}倍`, pFmt(pv), pv < bonf ? "要注意" : "注意"]),
      notes: ["「いつもの月平均」はその公館の前の12か月（月報のある月）の平均。前の月報が3か月未満の公館は除いています。過去に0件の病名は月平均0.2として計算しています。",
        "「要注意」は、調べた組み合わせの多さを考えても（ボンフェローニ補正）偶然とは言いにくいもの。流行の始まりや、受診のしかた・記載のしかたの変化の可能性があります。丙表の記述とあわせて確認してください。"] };
  }

  if (o.type === "corr") {
    const a = infPostValues(facts, o.measure), b = infPostValues(facts, o.measure2), ps = Object.keys(a).filter((p) => p in b);
    const c = ST.corr(ps.map((p) => a[p].v), ps.map((p) => b[p].v));
    if (!c) return { title: "計算できません", text: ["4公館以上の値が必要です（値がすべて同じときも計算できません）。"], notes: [] };
    return { title: `${mLabel(o.measure)} と ${mLabel(o.measure2)} の相関（${scopeTxt}）`,
      text: [`${c.n}公館で、ピアソンの相関係数 r＝${f2(c.r)}（95%信頼区間 ${f2(c.lo)}〜${f2(c.hi)}）、${pFmt(c.p)}。${fsCorrWord(c.r)}${c.r >= 0 ? "正" : "負"}の相関で、${c.p < 0.05 ? "偶然とは言いにくい（統計的に有意）" : "偶然の可能性がある（統計的に有意とは言えない）"}。`,
        `外れ値の影響を受けにくい順位相関（スピアマンのρ）＝${f2(c.rho)}、${pFmt(c.pRho)}。`],
      notes: ["相関は2つの値が一緒に増減する程度で、原因と結果の関係を示すものではありません。", notes[0]] };
  }

  if (o.type === "trend") {
    const tm = o.span !== 0 && o.span < 4 ? 12 : o.span;
    const tf = fsFacts({ span: tm, regions: regsF, posts: [] }, m), months2 = tf.ms.filter((mm) => tf.facts.some((f) => f.month === mm));
    const ys = months2.map((mm) => { const fs = tf.facts.filter((f) => f.month === mm), v = fs.map((f) => fsValue(f, o.measure, "")).filter((x) => x !== null); return v.length ? ST.mean(v) : 0; });
    const t = ST.trend(ys);
    if (!t) return { title: "計算できません", text: ["4か月以上のデータが必要です。"], notes: [] };
    return { title: `${mLabel(o.measure)}（1公館あたり）の傾向（${fmtMonth(months2[0])}〜${fmtMonth(months2[months2.length - 1])}・${o.reg || "全世界"}）`,
      text: [`1か月あたりの変化は${t.b >= 0 ? "+" : ""}${f2(t.b)}（95%信頼区間 ${f2(t.lo)}〜${f2(t.hi)}）、回帰の傾きの検定：${pFmt(t.p)}。決定係数 R²＝${f2(t.r2)}。`,
        `月ごとの増減の向きを数える検定（マン・ケンドール）：${pFmt(t.pMK)}。`,
        t.p < 0.05 && t.pMK < 0.05 ? `→ ${t.b > 0 ? "増加" : "減少"}傾向は偶然とは言いにくい。` : "→ はっきりした増加・減少の傾向とは言えない（季節の波や月ごとのばらつきの範囲の可能性）。"],
      head: ["月", "1公館あたり"], rows: months2.map((mm, i) => [fmtMonth(mm), f1(ys[i])]),
      notes: ["提出公館数の違いの影響を除くため、月ごとに1公館あたりの平均で見ています。", "季節の波がある指標では、12か月未満の期間の傾向は季節の影響を受けます。"] };
  }
  return { title: "", text: [], notes: [] };
}

function mountInference() {
  if (page !== "stats" || $("#infCard")) return;
  const anchor = $("#fsCard") || main.querySelector(".kpis");
  if (!anchor) return;
  const m = curMonth();
  const o = Object.assign({ type: "two", span: 1, reg: "", measure: "total", measure2: "real", a: "アフリカ", b: "アジア", by: "region", cols: "cat", target: "" }, loadPrefs().infer || {});
  const card = document.createElement("div");
  card.className = "card fs";
  card.id = "infCard";
  const sel = (id, list, v) => `<select id="${id}">${list.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const catTot = {}, gTot = {};
  for (const d of diseasesOf()) if (d.category !== Z) { catTot[d.category] = (catTot[d.category] || 0) + d.count; gTot[groupOf(d.name)] = (gTot[groupOf(d.name)] || 0) + d.count; }
  const targets = [...Object.entries(catTot).sort((a, b) => b[1] - a[1]).map(([c]) => [`c:${c}`, `疾病分類：${shortCat(c)}`]), ...Object.entries(gTot).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([g]) => [`g:${g}`, `病名：${g}`])];
  if (!o.target && targets.length) o.target = targets[0][0];
  const regs = AI_REGIONS.map((g) => [g, g]);
  card.innerHTML = `
    <details id="infDet"${loadPrefs().inferOpen ? " open" : ""}><summary><h3 style="margin:0;display:inline">🧪 検定・推定（推測統計）</h3> <span class="muted">― 差や傾向が偶然か確かめる（押すと開く）</span></summary>
    <p class="muted" style="margin-top:0">差や傾向が「偶然のばらつきで説明できるか」を確かめます。結果は p値・信頼区間・効果量と、ふつうの言葉の説明で示します（計算はすべてブラウザの中）。</p>
    <div class="fs-grid">
      <label style="grid-column: span 2">知りたいこと ${sel("infType", INF_TYPES, o.type)}</label>
      <label>期間 ${sel("infSpan", REPORT_SPANS.map(([k, t]) => [String(k), t]), String(o.span))}</label>
      <label data-for="prev excess corr trend chi-period prop-period">地域 ${sel("infReg", [["", "全世界"], ...regs], o.reg)}</label>
      <label data-for="two multi prev corr trend">指標 ${sel("infMeasure", INF_MEASURES, o.measure)}</label>
      <label data-for="corr">もう1つの指標 ${sel("infMeasure2", INF_MEASURES, o.measure2)}</label>
      <label data-for="chi prop">比べ方 ${sel("infBy", [["region", "地域どうし"], ["period", "今回と前の期間"]], o.by)}</label>
      <label data-for="two prop-region">地域A ${sel("infA", regs, o.a)}</label>
      <label data-for="two prop-region">地域B ${sel("infB", regs, o.b)}</label>
      <label data-for="chi">構成 ${sel("infCols", [["cat", "疾病分類（上位6＋その他）"], ["kind", "受診者区分（職員・家族・その他）"]], o.cols)}</label>
      <label data-for="prop">割合を見る項目 ${sel("infTarget", targets, o.target)}</label>
    </div>
    <div id="infOut"></div>
    <div class="row"><button id="infSave">📌 この結果を保存（PDFレポートの統計分析に入れられます）</button><span class="muted" id="infSt"></span></div></details>`;
  anchor.insertAdjacentElement("afterend", card);
  const $c = (s) => card.querySelector(s);
  let last = null;
  const draw = () => {
    Object.assign(o, { type: $c("#infType").value, span: Number($c("#infSpan").value), reg: $c("#infReg").value, measure: $c("#infMeasure").value, measure2: $c("#infMeasure2").value,
      a: $c("#infA").value, b: $c("#infB").value, by: $c("#infBy").value, cols: $c("#infCols").value, target: $c("#infTarget").value });
    savePref("infer", o);
    // 種類に合う選択だけを出す
    const tags = [o.type, `${o.type}-${o.by}`];
    card.querySelectorAll("[data-for]").forEach((l) => (l.hidden = !l.dataset.for.split(" ").some((t) => tags.includes(t))));
    if (o.type === "excess") $c("#infSpan").closest("label").hidden = true; else $c("#infSpan").closest("label").hidden = false;
    let r;
    try { r = runInference(o, m); } catch (e) { console.error(e); r = { title: "計算できませんでした", text: [e.message], notes: [] }; }
    last = r;
    $c("#infOut").innerHTML = `<h4>${esc(r.title)}</h4>${r.text.map((t) => `<p class="inf-text">${esc(t)}</p>`).join("")}
      ${r.head ? `<div class="table-wrap"><table class="stats"><thead><tr>${r.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${r.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(String(c))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : ""}
      <div id="infFig"></div>
      ${r.notes.length ? `<ul class="muted inf-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`;
    scrollTables($c("#infOut"), 8);
    if (r.fig && r.fig.type === "box") plot($c("#infFig"), r.fig.groups.map(([g, v]) => ({ type: "box", name: g, y: v, boxpoints: "all", jitter: 0.4, pointpos: 0, marker: { color: FS_REGION_COL[g] || "#888", size: 5, opacity: 0.7 } })),
      Object.assign({ title: "公館ごとの値の分布", showlegend: false, height: 360, yaxis: { title: { text: r.fig.y } } }, { template: chartTemplate() }));
    $c("#infSave").disabled = !r.text.length || !r.head && r.text.length < 1;
  };
  card.querySelectorAll("select").forEach((s) => (s.onchange = draw));
  $c("#infDet").ontoggle = () => { savePref("inferOpen", $c("#infDet").open); if ($c("#infDet").open) draw(); };
  $c("#infSave").onclick = async () => {
    if (!last || !last.text.length) return;
    (state.statNotes ||= []).unshift({ id: `S${Date.now().toString(36)}`, at: new Date().toISOString(), month: m, title: last.title, text: last.text, head: last.head || null, rows: (last.rows || []).map((r) => r.map(String)), notes: last.notes });
    await saveState();
    $c("#infSt").textContent = `保存しました（${(state.statNotes || []).filter((x) => x.month === m).length}件）。PDFレポートの「統計分析」で「保存した検定・推定の結果」を選ぶと入ります`;
  };
  draw();
}

// 行の多い表は、高さを抑えた枠の中でスクロールし、見出しの行を上に固定する（統計タブが縦に長くなりすぎないように）
function scrollTables(root, minRows = 9) {
  if (!root) return;
  root.querySelectorAll("table").forEach((t) => {
    if (t.closest(".scrolltbl, .vresize, .rp-host")) return;
    if (t.querySelectorAll("tbody tr").length < minRows) return;
    let w = t.parentElement;
    if (!w.classList.contains("table-wrap")) { const d = document.createElement("div"); d.className = "table-wrap"; t.replaceWith(d); d.appendChild(t); w = d; }
    w.classList.add("scrolltbl");
  });
}
function pageStats() {
  if (needData()) return;
  setTimeout(() => { mountFreeStats(); mountInference(); scrollTables(main); }, 0);  // 自由集計と検定・推定の欄を、要約の数値の下に置く
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
    <div class="grid2"><div class="card"><div id="s_box" class="plot" style="min-height:420px"></div>
      <p class="muted">箱の中の線が中央値、箱の上下が四分位（真ん中半分の公館が入る範囲）。点は各公館で、離れた点は他より極端に多い・少ない公館です。点にマウスを重ねると公館名が出ます。</p></div>
    <div class="card"><div id="s_mom" class="plot" style="min-height:420px"></div></div></div>
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
    const heat = (id, title, ylabels, z, unit, h) => {
      const zn = z.map((row) => { const mx = Math.max(1, ...row); return row.map((v) => v / mx); });
      // 色の濃い両端（青・赤）のマスは白い字にする
      const ink = zn.map((row) => row.map((v) => (v < 0.18 || v > 0.82 ? "#ffffff" : "#1c2430")));
      plot(id, [{ type: "heatmap", x: ms.map(fmtMonth), y: ylabels, z: zn, customdata: z, colorscale: HEAT_BR, zmin: 0, zmax: 1, xgap: 2, ygap: 2, showscale: false,
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
    const byMG = new Map();
    for (const d of alld) { const k = `${d.month}|${groupOf(d.name)}`; byMG.set(k, (byMG.get(k) || 0) + (Number(d.count) || 0)); }
    heat("s_heat1", "病名（まとめ）上位12 × 月 ― 季節による流行の波", groups,
      groups.map((g) => ms.map((mm) => byMG.get(`${mm}|${g}`) || 0)), "件", Math.max(380, 32 * groups.length + 110));
    const byMR = new Map();
    for (const r of reportsOf()) byMR.set(`${r.month}|${r.region}`, (byMR.get(`${r.month}|${r.region}`) || 0) + (Number(r.total) || 0));
    heat("s_heat2", "地域 × 月の受診者数（色は地域ごとに最も多い月を濃く）", REGIONS,
      REGIONS.map((rg) => ms.map((mm) => byMR.get(`${mm}|${rg}`) || 0)), "名", 300);
  }
}

// ======================================================================= ダッシュボード

// 地域の選択（"" すべて／"@home" 自分の公館／地域名）
const inRegSel = (r, g) => !g || (g === "@home" ? r.post === loadPrefs().homePost : r.region === g);
// 設定の「自分の公館」：今月の受診者数・主な病名を1枚に（公館カードを開ける）
function homeCard(m) {
  const home = loadPrefs().homePost;
  if (!home) return "";
  const r = getReport(m, home), rp = getReport(prevMonth(m), home);
  const top = r ? topDiseases(diseasesOf(m).filter((d) => d.post === home), 3) : [];
  return `<div class="card homecard"><div class="row" style="margin:0"><b>🏠 自分の公館：${esc(home)}</b>
    <span>${r ? `受診者 ${r.total}名${rp ? `（前月 ${rp.total}名）` : ""}${top.length ? `　主な病名：${top.map((x) => `${esc(x.name)} ${x.count}`).join("、")}` : ""}` : `${esc(fmtMonth(m))}の月報はまだありません`}</span>
    <button class="linklike" data-homecard="${esc(home)}">公館カードを開く</button></div></div>`;
}
function pageDashboard() {
  if (needData()) return;
  const m = curMonth(), rep = reportsOf(m), pr = reportsOf(prevMonth(m)), dis = diseasesOf(m), miss = missingPosts(m), ev = eventsOf(m);
  const tot = sum(rep, (r) => r.total), ptot = sum(pr, (r) => r.total);
  const delta = (a, b) => (pr.length ? `<div class="delta ${a - b >= 0 ? "up" : "down"}">前月比 ${a - b >= 0 ? "+" : ""}${a - b}</div>` : "");
  main.innerHTML = `
    <h2>${fmtMonth(m)} ダッシュボード</h2>
    ${homeCard(m)}
    <div class="kpis">
      <div class="kpi kpi-building">${ico("building", "kico")}<div class="label">提出公館</div><div class="value">${rep.length}</div>${delta(rep.length, pr.length)}</div>
      <div class="kpi kpi-users">${ico("users", "kico")}<div class="label">受診者数（延べ）</div><div class="value">${tot}</div>${delta(tot, ptot)}</div>
      <div class="kpi kpi-alert">${ico("alert", "kico")}<div class="label">未提出公館</div><div class="value">${miss ? miss.length : "―"}</div>${miss ? "" : '<div class="delta muted">配置表未登録</div>'}</div>
      <div class="kpi kpi-virus">${ico("virus", "kico")}<div class="label">感染症の報告（公館数）</div><div class="value">${new Set(ev.filter((e) => e.kind === "感染症").map((e) => e.post)).size}</div></div>
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
  document.querySelectorAll("[data-homecard]").forEach((b) => (b.onclick = () => openPostCard([b.dataset.homecard], m)));
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
  scrollTables(main);   // 公館別の表など、行の多い表は見出し固定の枠に入れる
}

function alertsCard(m) {
  const al = newAlerts(m);
  if (!getReportsAny(prevMonth(m))) return "";
  return `<div class="card alerts"><h3 style="margin-top:0">新着アラート <span class="badge new">${al.length}件</span> <span class="muted" style="font-weight:400;font-size:13px">前月と比べて新しく出てきた病気・急に増えた病気</span> <button type="button" class="hint" data-tip="${esc(GLOSSARY)}" aria-label="${esc(GLOSSARY)}">i</button></h3>${
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

// 世界地図の表示：はじめは疾病分類・丙表の流行・新着アラートだけ（すべて出すと文字と印が重なって読めないため）。選んだものは覚える
const MAP_OPT_DEFAULT = { disease: true, visits: false, outbreak: true, alerts: true, events: false, junkai: false, transfers: false, planes: false, labels: false };
const mapOpt = Object.assign({}, MAP_OPT_DEFAULT, (() => { try { return loadPrefs().mapOpt || {}; } catch (e) { return {}; } })(),
  new URLSearchParams(location.search).get("tourtab") === "1" ? { planes: true, labels: true } : {});
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
        <span class="muted">国・首都・都市・印をクリックするとカードが開きます（指の形になる所）</span>
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
  document.querySelectorAll("[data-k]").forEach((c) => (c.onchange = () => { mapOpt[c.dataset.k] = c.checked; if (!TOUR_TAB) savePref("mapOpt", { ...mapOpt }); draw(); }));
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
  // 下の表（病名で見る・流行中の病気・出来事）は、行が多いと長いので見出し固定の枠に入れる
  scrollTables(main); setTimeout(() => scrollTables(main), 400);
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
  const order = ["アジア", "大洋州", "中東", "アフリカ", "ヨーロッパ", "北米", "中南米"];
  const PER_REGION = 3;
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
  // 出発は霞が関の外務省から。まず成田国際空港へ（鉄道。音楽は流さず効果音だけ）、そこから政府専用機で最初の公館へ
  // 最後は成田国際空港に帰国し、陸路で霞が関の外務省に戻る
  if (stops.length) {
    const k = stops.length;
    stops.unshift({ post: "日本", label: "成田国際空港", region: "出発", at: [35.76, 140.39], home: "depart", items: [], alerts: [], notes: ["霞が関の外務省を出発し、成田国際空港へ。ここから政府専用機で世界の公館を回ります"] });
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
  tour = { m, stops, i: 0, playing: true, cardOn: true, timer: null, at: [35.6745, 139.7507], atPost: "外務省", atLabel: "外務省（霞が関）", seq: 0, restoreFlat };
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
    showStop(s.home === "mofa" && tour.atPost === "外務省" ? 0 : tour.i);
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
  // 外務省に着いたら「外務省」（もう一周するときは、ここから成田へ鉄道で向かう）
  tour.atPost = s.home === "mofa" ? "外務省" : s.post; tour.atLabel = s.label || s.post;
  tour.cardPost = s.home ? null : s.post;   // 国歌が流れている国（カードを戻す先）
  tour.userCard = false;
  if (tour.cardOn && !s.home) openPostCard([s.post], tour.m);
  else if (s.home) closePostCard(true);
  // 国歌は最後まで聞けるよう、その間は次へ進まない。曲名を吹き出しに出す
  // 日本に帰ったら成田に着いた時点で「君が代」。霞が関の外務省ではもう流さない
  // 出発の成田では何も流さない（効果音だけ）
  const arr = s.home === "mofa" || s.home === "depart" ? { sec: 0 } : await playArrival(s.post), anthemSec = arr.sec;
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
  scheduleNext(s.home === "depart" ? 2500 : Math.max(6500, anthemSec * 1000 + 800));
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
    <div class="pcblock"><div class="muted">${summaryLines()}行サマリー</div><ul>${(r.summary || ruleSummary(m, post)).split("\n").slice(0, summaryLines()).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>${reportFullHtml(r)}</div>
    ${top.length ? `<div class="pcblock"><div class="muted">主な病名（乙表）</div>${top.map(([g, c]) => `<span class="chip">${utd(g)} ${c}</span>`).join(" ")}</div>` : ""}
    ${ob.length ? `<div class="pcblock"><div class="muted">丙表に出てくる病気</div>${ob.map((o) => `<div><span class="badge${o.trend === "流行・増加" ? " warn" : ""}">${utd(o.name)} ${TREND_MARK[o.trend]}</span> ${esc(o.sentence)}</div>`).join("")}</div>` : ""}`}
    ${pcCases(post, m)}
    ${jk.length ? `<div class="pcblock"><div class="muted">巡回健診</div>${jk.map((j) => `<div>${fmtMonth(j.month)}　${esc(j.from)} → ${esc(j.dest || "?")}　${esc(j.period || "")}</div>`).join("")}</div>` : ""}
    ${tr.length ? `<div class="pcblock"><div class="muted">医務官の異動</div>${tr.map((t) => `<div>${fmtMonth(t.month)}　${esc(t.post)}：${esc(t.before)} → ${esc(t.after)}${t.from ? `（${esc(t.from)}から）` : ""}</div>`).join("")}</div>` : ""}
  </section>`;
}
// 月報の全文（甲表の人数・乙表のすべての病名・丙表の全文・元のファイル名）。開くと表示する
// 月報の全文は、開いたときに作る（サマリーのタブで全公館分を最初から作ると、表の数が多くて画面の切り替えが遅くなるため）
const lazyFullHtml = (r) => (r ? `<details class="pcfull" data-lazyfull="${esc(r.month)}|${esc(r.post)}"><summary>📄 月報の全文を表示</summary></details>` : "");
document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open || !d.dataset.lazyfull) return;
  const [m, post] = d.dataset.lazyfull.split("|"), r = getReport(m, post);
  const tmp = document.createElement("div"); tmp.innerHTML = reportFullHtml(r);
  const body = tmp.querySelector(".pcfull-body");
  if (body) d.appendChild(body);
  delete d.dataset.lazyfull;
}, true);
function reportFullHtml(r) {
  if (!r) return "";
  const dis = (r.diseases || []).slice().sort((a, b) => b.count - a.count);
  return `<details class="pcfull"><summary>📄 月報の全文を表示</summary>
    <div class="pcfull-body">
      <div class="muted">甲表（受診者数）</div>
      <table class="mini"><tr><th>職員</th><th>家族</th><th>その他</th><th>計</th></tr><tr><td class="num">${n(r.staff)}</td><td class="num">${n(r.family)}</td><td class="num">${n(r.other)}</td><td class="num"><b>${n(r.total)}</b></td></tr></table>
      <div class="muted">乙表（疾病分類・${dis.length}件）</div>
      ${dis.length ? `<table class="mini"><tr><th>病名</th><th>件数</th><th>分類</th></tr>${dis.map((d) => `<tr><td>${utd(d.name)}</td><td class="num">${d.count}</td><td class="muted">${esc(shortCat(classify(d.name, d.cat)))}</td></tr>`).join("")}</table>` : '<p class="muted">（なし）</p>'}
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
    el.addEventListener("mouseenter", () => { clearTimeout(tourCardBackTimer); clearTimeout(seaCloseTimer); });

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
  const a = post.startsWith("iso:")
    ? await playAnthem(post.slice(4), true).then((sec) => (sec ? { sec, label: `国歌（録音：${((curAnthemRec && curAnthemRec.name) || "").replace(/\.[^.]+$/, "")}）` } : { sec: 0 }))
    : await playArrival(post, true, true);   // カードからは最後まで
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

// ======================================================================= 公館別サマリー（5・10・15行）

const flash = (el) => { el.classList.remove("flashed"); void el.offsetWidth; el.classList.add("flashed"); };

// ---- GaiXer／源内でサマリーを作る：個人情報を除いた公館データと指示をコピー → AIの回答を貼り戻して取り込む
// 年齢・生年月日・連絡先・性別・続柄は自動で伏せ、氏名は月報・配置表の医務官名を伏せる（残りは点検で知らせる）
function maskPersonal(t) {
  return scrubNames(t || "")
    .replace(/(昭和|平成|令和|19\d\d|20\d\d)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日生(まれ)?/g, "（生年月日）")
    .replace(/\d{1,3}\s*(歳|才)(代)?/g, "（年齢）")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "（メール）").replace(/\+?(?:\d{1,3}[-‐ ])?\(?\d{1,4}\)?[-‐ ]\d{1,4}[-‐ ]\d{3,8}/g, "（電話）")
    .replace(/男児|女児|夫人|令息|令嬢/g, "（性別等）");   // 「男性」「女性」は個人を特定しないので伏せない
}
// 1公館分のデータ（AIに渡す。数値の照合にも使う）
function aiSummaryData(m, r, n) {
  const pr = getReport(prevMonth(m), r.post);
  const L = [`【${r.post}】（${r.region}）`];
  L.push(`受診者数：計${r.total ?? "未記載"}名（職員${r.staff ?? "-"}名・家族${r.family ?? "-"}名・その他${r.other ?? "-"}名）／前月：${pr && pr.total != null ? pr.total + "名" : "月報なし"}`);
  const dis = (r.diseases || []).slice().sort((a, b) => b.count - a.count);
  if (dis.length) L.push(`乙表（病名と件数）：${dis.map((d) => `${d.name}${d.count}件`).join("、")}`);
  const cats = {};
  for (const d of dis) { const c = classify(d.name, d.cat); cats[c] = (cats[c] || 0) + d.count; }
  if (dis.length) L.push(`疾病分類：${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c === Z ? "検診・予防接種" : catPhrase(c)}${v}件`).join("、")}`);
  const ob = reportOutbreaks(r);
  if (ob.length) L.push(`丙表で報告された感染症：${ob.map((o) => `${o.name}（${o.trend}）`).join("、")}`);
  if (n === 15) {
    const hist = [];
    for (let mm = m, k = 0; k < 4; k++, mm = prevMonth(mm)) { const x = getReport(mm, r.post); if (x && x.total != null) hist.unshift(`${Number(mm.split("-")[1])}月${x.total}名`); }
    if (hist.length > 1) L.push(`受診者数の推移：${hist.join("、")}`);
    const al = alertsOf(m).filter((a) => a.post === r.post);
    if (al.length) L.push(`新着アラート：${al.map((a) => `${a.name}（${a.kind}${a.detail && a.kind !== "丙表に新登場" ? "・" + a.detail : ""}）`).join("、")}`);
  }
  L.push("丙表（報告事項）：", maskPersonal(r.hei || "（記載なし）").trim());
  return L.join("\n");
}
function aiSummaryPrompt(m, rs, n = summaryLines()) {
  const [y, mo] = m.split("-");
  return [`# 依頼：在外公館 医務官月報の公館別サマリー（${y}年${Number(mo)}月分・${rs.length}公館）`,
    `下の「公館データ」をもとに、公館ごとに${n}行のサマリーを作ってください。`,
    `- 各行は「項目名：本文」とし、項目は次の${n}個をこの順で：${summaryLabels(n).join("／")}`,
    "- 本文は自然な日本語の常体（〜である・〜した）で、1行120字以内。医療事情は具体的に。",
    "- 数値は公館データにあるものだけを使う（増減・割合の計算はよい）。推測で補わない。",
    "- 該当する記載がない項目は「特記なし」とだけ書く。",
    "- 氏名・年齢・性別・続柄など個人が特定される情報は書かない。",
    "- 出力は次の形式だけ（前置き・説明・まとめは不要）。公館の間は空行で区切る：",
    "【公館名】", `${summaryLabels(n)[0]}：本文`, "（以下、項目の順に）", "",
    "## 公館データ", "", ...rs.map((r) => aiSummaryData(m, r, n) + "\n")].join("\n");
}
// AIの回答を公館ごとに分ける。数値が公館データにないものは「要確認」にする
function parseAiSummaries(m, text) {
  const out = [], unknown = [];
  // 「**【タイ】**」「## 【タイ】」のような見出しの飾りも許す
  const blocks = String(text || "").replace(/\r/g, "").split(/^[\s*#>\-・]*[【\[]([^】\]\n]{1,30})[】\]].*$/m);
  for (let i = 1; i < blocks.length; i += 2) {
    const raw = blocks[i].trim(), body = blocks[i + 1] || "";
    const post = canonical(raw) || findInText(raw)[0] || raw;
    const r = getReport(m, post);
    if (!r) { unknown.push(raw); continue; }
    const lines = body.split("\n").map((l) => l.trim().replace(/^[-・*●○■□]\s*/, "").replace(/\*\*/g, ""))
      .filter((l) => /^[^：:]{1,20}[：:]/.test(l)).map((l) => l.replace(/^([^：:]{1,20}):\s*/, "$1："));
    if (!lines.length) { unknown.push(raw); continue; }
    // 公館データに出てくる数と、前月との差・割合だけを許す
    const src = aiSummaryData(m, r, 15), ok = new Set((src.match(/\d+/g) || []).map(Number));
    const pr = getReport(prevMonth(m), post);
    if (pr && pr.total != null && r.total != null) {
      ok.add(Math.abs(r.total - pr.total));
      if (pr.total) { const pc = Math.abs((100 * (r.total - pr.total)) / pr.total); [Math.floor(pc), Math.round(pc), Math.ceil(pc)].forEach((x) => ok.add(x)); }
    }
    const bad = [...new Set(nfkc(lines.join("\n")).match(/\d+(\.\d+)?/g) || [])].filter((x) => !ok.has(Number(x)) && !ok.has(Math.round(Number(x))));
    out.push({ post, lines, bad });
  }
  return { items: out, unknown };
}
function pageSummary() {
  if (needData()) return;
  const m = curMonth();
  main.innerHTML = `
    <h2>公館別 ${summaryLines()}行サマリー（${fmtMonth(m)}）</h2>
    <div class="row">
      <span class="seg" title="行数を変えると、自動作成のサマリーをその場で作り直します（手で書き換えたものはそのまま）">${SUMMARY_SIZES.map((k) => `<button data-slines="${k}" class="${k === summaryLines() ? "on" : ""}">${k}行</button>`).join("")}</span>
      <label>地域 <select id="sreg"><option value="">すべて</option>${loadPrefs().homePost ? `<option value="@home">🏠 自分の公館（${esc(loadPrefs().homePost)}）</option>` : ""}${REGIONS.map((r) => `<option>${r}</option>`).join("")}</select></label>
      <button id="regenAll">全公館を自動作成し直す</button>
      <button class="primary" id="saveAllSum" title="下に表示している公館のサマリー（書き換えたものも）を、まとめて保存します">💾 表示中のサマリーをすべて保存</button>
    </div>
    <p class="muted">${summaryLabels().join("／")} の${summaryLines()}行を月報データから自動で作成します。自由に書き換えて保存できます。行数は公館カードにも反映されます（PDFレポートの行数は、PDFレポートのタブで選びます。はじめは5行）。</p>
    <div class="card aichoice"><b>🤖 AI（MOFA GaiXer／源内）を使う</b>
      <div class="row" style="margin:8px 0 0">
        <button class="primary" id="aisStart" title="個人情報を除いた月報データを GaiXer／源内に渡し、公館ごとのサマリーを自然な文章に書き直してもらいます">📝 公館ごとのサマリーを書き直す</button>
        <button class="primary" id="ovStart" title="全公館の5行サマリーを読ませて、全体の概況（PDFレポートの最初の章）を作ってもらいます">🌏 全体の概況を作る</button>
      </div></div>
    <details class="card aisum" id="ovCard">
      <summary><b>🌏 全体の概況を作る（AI）</b> <span class="muted">― 全公館を読んで<b>1つの文章</b>（PDFレポートの最初の章「AIによる概況」）を作ります</span></summary>
      <ol class="muted" style="margin:6px 0 10px">
        <li>「① 概況用の文章を作る」を押す。${fmtMonth(m)}の全公館の5行サマリー（PDFと同じ文。医務官名は伏せ、精神・行動、妊娠・出産の病名は公館別に入れません）と、概況を作る依頼文が入ります。</li>
        <li>内容を確かめてチェックを入れ、「コピーして ◯◯ を開く」。開いた GaiXer／源内に貼り付けて送る。</li>
        <li>AIの回答をすべてコピーし、下に貼り付けて「③ 概況として保存」。PDFレポートでは最初の章「AIによる概況」になります（公館別5行サマリーは、これまでどおり最後の章）。</li>
      </ol>
      <div class="row"><b>送り方</b><span class="seg">${[[1, "分割しない"], [0, "地域ごとに分ける"], [3, "3分割"]].map(([k, l]) => `<button data-ovsplit="${k}">${l}</button>`).join("")}</span>
        <span class="muted">全公館では2万字ほどになります。AIの回答が途中で切れる・入力が長すぎるときは分けて送ります（同じ会話の中で順に送ると、最後の部で概況をまとめます）</span></div>
      <div class="row"><button id="ovMake">① 概況用の文章を作る</button><span class="muted" id="ovLen"></span></div>
      <div id="ovParts" class="aisparts"><textarea id="ovText" rows="8" placeholder="「① 概況用の文章を作る」を押すと、ここに入ります（直接直せます）"></textarea></div>
      <label class="row"><input type="checkbox" id="ovOk"> 内容を確認し、個人が特定される記載がないことを確かめた</label>
      <div class="row" id="ovGoRow">${AI_SITES.map(([k, name]) => `<button class="primary" data-ov-go="${k}" data-ovi="0" disabled>② コピーして ${name} を開く</button>`).join("")}</div>
      <h4 style="margin:12px 0 4px">③ AIの回答（概況）を貼り付けて保存</h4>
      <textarea id="ovAnswer" rows="8" placeholder="1. 全体の動き&#10;…"></textarea>
      <div class="row"><button class="primary" id="ovSave" disabled>③ 概況として保存</button><span class="muted" id="ovSt"></span></div>
      <div id="ovSaved"></div>
    </details>
    <details class="card aisum" id="aisum">
      <summary><b>📝 公館ごとのサマリーを書き直す（AI）</b> <span class="muted">― <b>公館ごとの</b>サマリーの文を、AIで自然な文章に書き直します</span></summary>
      <ol class="muted" style="margin:6px 0 10px">
        <li>「AIに渡す文章を作る」を押す（上で選んだ地域の公館・今の行数）。年齢・性別・連絡先・医務官名は自動で伏せます。</li>
        <li>内容を確かめてチェックを入れ、「コピーして ◯◯ を開く」。開いた GaiXer／源内に貼り付けて送る。</li>
        <li>AIの回答をすべてコピーし、下の「AIの回答」に貼り付けて「読み取る」。数値が月報と合っているかを確かめてから取り込みます。</li>
      </ol>
      <div class="row"><b>送り方</b><span class="seg">${[[1, "分割しない"], [3, "3分割"], [5, "5分割"]].map(([k, l]) => `<button data-aissplit="${k}">${l}</button>`).join("")}</span>
        <span class="muted">AIの回答が途中で切れるときは「3分割」「5分割」に（分けた文章を窓に並べて出し、窓ごとにコピーして送ります）</span></div>
      <div class="row"><button id="aisMake">① AIに渡す文章を作る</button><span class="muted" id="aisLen"></span></div>
      <div id="aisParts" class="aisparts"></div>
      <label class="row"><input type="checkbox" id="aisOk"> <span id="aisOkL">内容を確認し、個人が特定される記載がないことを確かめた</span></label>
      <div class="row"><button id="aisCsv" disabled title="上の窓の文章（直した内容も）を、CSV（はじめに依頼の行、続いて1行1公館の公館データ）にして保存します。AIに読ませやすい形です">📄 CSVで書き出す（AIに読ませる用）</button><button id="aisXlsx" disabled title="上の窓の文章（直した内容も）を、Excel（依頼文のシートと、1行1公館の公館データのシート）にして保存します">📊 Excelで書き出す</button>
        <span class="muted">GaiXer／源内にファイルとして添付して読ませるとき用。個人情報の点検が済み、確認のチェックを入れると押せます。保存したファイルは医務官のみがアクセスできるフォルダに。</span></div>
      <h4 style="margin:12px 0 4px">③ AIの回答を貼り付けて取り込む</h4>
      <textarea id="aisAnswer" rows="8" placeholder="【ケニア】&#10;受診者数：…&#10;主な疾病：…"></textarea>
      <div class="row"><button id="aisParse">読み取る</button></div>
      <div id="aisPreview"></div>
    </details>
    <div class="card sindex" id="sindex"></div>
    <div id="slist"></div>`;
  // ---- 概況（全公館の5行サマリーをAIにまとめさせる）
  const ovSaved = () => {
    const ns = (state.aiNotes || []).filter((x) => x.kind === "overview");
    $("#ovSaved").innerHTML = ns.length ? `<p class="muted" style="margin:8px 0 2px">保存した概況（新しい順）：</p><ul class="ai-notes">${ns.slice(0, 10).map((x) => `<li><b>${esc(x.title)}</b> <span class="muted">${esc(new Date(x.at).toLocaleString("ja-JP"))}・${x.text.length.toLocaleString()}文字</span> <button class="linklike" data-ov-del="${esc(x.id)}">削除</button><details><summary>中身を見る</summary><pre class="pcfull-hei">${esc(x.text)}</pre></details></li>`).join("")}</ul>` : "";
    document.querySelectorAll("[data-ov-del]").forEach((b) => (b.onclick = async () => {
      if (!confirm("この概況を削除します。よろしいですか？")) return;
      state.aiNotes = (state.aiNotes || []).filter((x) => x.id !== b.dataset.ovDel); await saveState(); ovSaved();
    }));
  };
  let ovSplit = loadPrefs().ovSplit ?? 1;
  const ovTas = () => [...document.querySelectorAll("#ovParts textarea")];
  const ovCheck = () => {
    const ts = ovTas(), total = ts.reduce((a, t) => a + t.value.length, 0);
    $("#ovLen").textContent = total ? `${total.toLocaleString()}文字${ts.length > 1 ? `（${ts.length}つに分けて送る）` : ""}` : "";
    document.querySelectorAll("[data-ov-go]").forEach((b) => (b.disabled = !(ovTas()[Number(b.dataset.ovi)] || {}).value || !$("#ovOk").checked));
    $("#ovSave").disabled = !$("#ovAnswer").value.trim();
  };
  const markOvSplit = () => document.querySelectorAll("[data-ovsplit]").forEach((b) => b.classList.toggle("on", Number(b.dataset.ovsplit) === ovSplit));
  // 分けるとき：1つ目に依頼文、途中の部は「受け取りました」とだけ答えてもらい、最後の部で概況をまとめてもらう
  const ovMakeParts = () => {
    const body = aiText(m, new Set(["sum5"]));
    const head = body.slice(0, body.indexOf("### ")), secsTxt = body.slice(body.indexOf("### ")).split(/(?=^### )/m).filter((x) => x.trim());
    let groups;
    if (ovSplit === 1 || secsTxt.length < 2) groups = [secsTxt.join("")];
    else if (ovSplit === 0) groups = secsTxt;
    else { const n = Math.min(ovSplit, secsTxt.length), per = Math.ceil(secsTxt.length / n); groups = []; for (let i = 0; i < secsTxt.length; i += per) groups.push(secsTxt.slice(i, i + per).join("")); }
    const N = groups.length;
    return groups.map((g, i) => N === 1 ? AI_GUARD + SUM5_TEXT + "\n\n" + head + g
      : AI_GUARD + (i === 0 ? SUM5_TEXT + `\n\nこの資料は全${N}部に分けて送ります。最後の部（${N}/${N}）を受け取るまでは、概況をまとめずに「受け取りました（k/${N}）」とだけ答えてください。\n\n` + head : "") + `【${i + 1}/${N}部】\n` + g + (i === N - 1 ? `\nこれで全${N}部です。1部目の依頼に沿って、すべての部の公館を読んだうえで全体の概況をまとめてください。` : `\n（${i + 1}/${N}部ここまで。「受け取りました（${i + 1}/${N}）」とだけ答えてください）`));
  };
  const ovDraw = (texts) => {
    const N = texts.length;
    $("#ovParts").className = "aisparts" + (N > 1 ? " many" : "");
    $("#ovParts").innerHTML = texts.map((t, i) => `<div class="aispart">${N > 1 ? `<div class="row" style="margin:0"><b>${i + 1}/${N}</b></div>` : ""}<textarea ${i ? "" : 'id="ovText"'} rows="${N > 1 ? 10 : 8}"></textarea>
      ${N > 1 ? `<div class="row">${AI_SITES.map(([k, name]) => `<button class="primary" data-ov-go="${k}" data-ovi="${i}" disabled>② ${i + 1}つ目をコピーして ${name} ${i ? "に" : "を開く"}</button>`).join("")}</div>` : ""}</div>`).join("");
    ovTas().forEach((ta, i) => { ta.value = texts[i]; ta.oninput = () => { $("#ovOk").checked = false; ovCheck(); }; });
    $("#ovGoRow").hidden = N > 1;
    bindOvGo(); ovCheck();
  };
  const bindOvGo = () => document.querySelectorAll("[data-ov-go]").forEach((btn) => (btn.onclick = async () => {
    const k = btn.dataset.ovGo, i = Number(btn.dataset.ovi), name = AI_SITES.find((x) => x[0] === k)[1], url = aiUrls()[k], ta = ovTas()[i], N = ovTas().length;
    const { t, id } = await stampAiText(ta.value, name, { month: m, scope: `概況（全公館の5行サマリー）${N > 1 ? `・${i + 1}/${N}` : ""}`, period: "今月" });
    ta.value = t;
    if (!(await copyText(t))) { toast("コピーできませんでした"); return; }
    if (url && i === 0) window.open(url, "_blank", "noopener");
    btn.classList.add("done");
    toast(`コピーしました（管理番号 ${id}）。${name} の入力欄に貼り付けて送ってください${N > 1 && i < N - 1 ? `。返事が来たら ${i + 2}つ目を同じ会話に送ります` : "。回答を下の欄に貼り付けてください"}`);
  }));
  document.querySelectorAll("[data-ovsplit]").forEach((b) => (b.onclick = () => { ovSplit = Number(b.dataset.ovsplit); savePref("ovSplit", ovSplit); markOvSplit(); if (ovTas().some((t) => t.value)) ovDraw(ovMakeParts()); }));
  markOvSplit();
  $("#ovMake").onclick = () => { $("#ovOk").checked = false; ovDraw(ovMakeParts()); };
  $("#ovText").oninput = () => { $("#ovOk").checked = false; ovCheck(); };
  $("#ovOk").onchange = ovCheck;
  $("#ovAnswer").oninput = ovCheck;
  bindOvGo();
  $("#ovSave").onclick = async () => {
    const text = $("#ovAnswer").value.trim();
    if (!text) return;
    (state.aiNotes ||= []).unshift({ id: `N${Date.now().toString(36)}`, at: new Date().toISOString(), month: m, periodLabel: fmtMonth(m), title: `${fmtMonth(m)}の概況（全公館の5行サマリーから）`, scope: "全世界", kind: "overview", text });
    await saveState();
    $("#ovAnswer").value = ""; ovCheck();
    $("#ovSt").textContent = "保存しました。PDFレポートで「AIによる概況」（最初の章）として選べます";
    ovSaved();
  };
  ovCheck(); ovSaved();
  const draw = () => {
    const g = $("#sreg").value;
    $("#slist").innerHTML = reportsOf(m).filter((r) => inRegSel(r, g)).map((r) => `
      <div class="card sumcard" data-post="${esc(r.post)}">
        <h4>${esc(r.post)} <span class="muted">${esc(r.region)}　医務官：${esc(r.officer || "―")}　受診者数：${n(r.total)}</span>${r.summaryAI ? ' <span class="badge">🤖 AI作成</span>' : ""}</h4>
        <textarea rows="${summaryLines()}">${esc(r.summary || ruleSummary(m, r.post))}</textarea>
        <div class="row"><button class="primary" data-act="save">保存</button><button data-act="regen">自動作成し直す</button></div>
        ${lazyFullHtml(r)}
      </div>`).join("");
    // 全公館のサマリーを並べるとページが非常に長いので、はじめは公館名の一覧（目次）だけを出し、押した公館を開く
    // （自分の公館を設定していればそれを開く。「すべて表示」で全部）
    const shownPosts = new Set(loadPrefs().sumShowAll ? [] : [loadPrefs().homePost].filter(Boolean));
    const applyShow = () => {
      const all = !!loadPrefs().sumShowAll;
      $("#slist").querySelectorAll(".sumcard").forEach((c) => c.classList.toggle("sumhide", !all && !shownPosts.has(c.dataset.post)));
      $("#sindex").querySelectorAll("[data-sopen]").forEach((b) => b.classList.toggle("on", all || shownPosts.has(b.dataset.sopen)));
      $("#sAll").textContent = all ? "一覧だけにする" : "すべての公館を表示";
    };
    const rs0 = reportsOf(m).filter((r) => inRegSel(r, g)), byReg = {};
    for (const r of rs0) (byReg[r.region] ||= []).push(r.post);
    $("#sindex").innerHTML = `<div class="row" style="margin:0 0 6px"><b>公館を選ぶ</b><span class="muted keep">（押した公館のサマリーが下に開きます。もう一度押すと閉じます）</span><button class="linklike" id="sAll"></button></div>` +
      Object.entries(byReg).map(([rg, ps]) => `<div class="sidx-row"><span class="sidx-reg">${esc(rg)}</span>${ps.map((p) => `<button class="ai-post" data-sopen="${esc(p)}">${esc(p)}</button>`).join("")}</div>`).join("");
    $("#sindex").querySelectorAll("[data-sopen]").forEach((b) => (b.onclick = () => {
      if (loadPrefs().sumShowAll) { savePref("sumShowAll", false); shownPosts.clear(); }
      const p = b.dataset.sopen;
      if (shownPosts.has(p)) shownPosts.delete(p); else shownPosts.add(p);
      applyShow();
      if (shownPosts.has(p)) { const c = $("#slist").querySelector(`.sumcard[data-post="${CSS.escape(p)}"]`); if (c) c.scrollIntoView({ behavior: "smooth", block: "start" }); }
    }));
    $("#sAll").onclick = () => { savePref("sumShowAll", !loadPrefs().sumShowAll); shownPosts.clear(); applyShow(); };
    applyShow();
    // カードの文を月報に入れる（保存はしない）。自動作成のままなら次の改良で作り直す。書き換えたものは残す
    const putSummary = (post, ta) => {
      const r = getReport(m, post);
      if (!r) return false;
      const v = ta.value.split("\n").slice(0, summaryLines()).join("\n");
      const changed = v !== (r.summary || "");
      r.summary = v;
      r.summaryManual = r.summary !== ruleSummary(m, post); r.summaryAuto = !r.summaryManual;
      if (!r.summaryManual) delete r.summaryAI;
      return changed;
    };
    $("#saveAllSum").onclick = async () => {
      const cards = [...document.querySelectorAll(".sumcard")];
      if (!cards.length) { toast("保存するサマリーがありません"); return; }
      let changed = 0;
      for (const card of cards) if (putSummary(card.dataset.post, $("textarea", card))) changed++;
      await saveState();
      toast(`${cards.length}公館のサマリーを保存しました${changed ? `（書き換えたもの ${changed}件）` : ""}`);
    };
    document.querySelectorAll(".sumcard").forEach((card) => {
      const post = card.dataset.post, ta = $("textarea", card);
      $("[data-act=save]", card).onclick = async () => {
        putSummary(post, ta);
        await saveState(); toast(`${post} を保存しました`);
      };
      $("[data-act=regen]", card).onclick = async () => {
        const r = getReport(m, post), before = ta.value, t = ruleSummary(m, post);
        // 今の文（手で書いたもの・AIで作ったもの）が消えるときは確かめる
        if (before.trim() && before !== t && !confirm(`${post} の今のサマリーは消えて、月報の内容から作り直した文に置き換わります（元には戻せません）。よろしいですか？`)) return;
        ta.value = r.summary = t; r.summaryAuto = true; r.summaryManual = false; delete r.summaryAI;
        await saveState();
        // 押したことが分かるように、欄を光らせてお知らせする（作り直しても同じ文面のことがある）
        flash(ta);
        toast(before === t ? `${post}：自動作成し直しました（月報の内容から作ると、今の文面と同じでした）` : `${post}：月報の内容から自動作成し直しました`);
      };
    });
  };
  $("#sreg").onchange = () => { draw(); if ($("#aisText").value) $("#aisMake").onclick(); else drawParts(); };
  // ---- GaiXer／源内でサマリーを作る
  // 送り方：分割しない（1回）／3分割／5分割。分けたときは窓を並べて出し、窓ごとにコピーして送る
  let aisSplit = [1, 3, 5].includes(loadPrefs().aisSplit) ? loadPrefs().aisSplit : 1;
  const markSplit = () => document.querySelectorAll("[data-aissplit]").forEach((b) => b.classList.toggle("on", Number(b.dataset.aissplit) === aisSplit));
  const aisTargets = () => { const g = $("#sreg").value; return reportsOf(m).filter((r) => inRegSel(r, g)); };
  const aisBatches = () => {
    const rs = aisTargets(), size = Math.max(1, Math.ceil(rs.length / aisSplit)), out = [];
    for (let i = 0; i < rs.length; i += size) out.push(rs.slice(i, i + size));
    return out.length ? out : [[]];
  };
  // 窓 i の文章欄・点検欄（1つ目は #aisText / #aisCheck）
  const taOf = (i) => $(i ? `#aisText${i}` : "#aisText"), ckOf = (i) => $(i ? `#aisCheck${i}` : "#aisCheck");
  const nParts = () => document.querySelectorAll("#aisParts textarea").length;
  const aisCheck = () => {
    let total = 0;
    for (let i = 0; i < nParts(); i++) {
      const ta = taOf(i), t = ta.value, left = privacyPanel(ta, ckOf(i));
      total += t.length;
      const ok = t.trim() && !left && $("#aisOk").checked;
      document.querySelectorAll(`[data-ais-go][data-pi="${i}"]`).forEach((b) => (b.disabled = !ok));
      const lab = $(`#aisPartLen${i}`); if (lab) lab.textContent = t ? `${t.length.toLocaleString()}文字` : "";
    }
    $("#aisLen").textContent = total ? `計 ${total.toLocaleString()}文字` : "";
    const allOk = nParts() && [...Array(nParts()).keys()].every((i) => taOf(i).value.trim()) && !document.querySelector("#aisParts .ai-warn.pv") && $("#aisOk").checked;
    $("#aisXlsx").disabled = $("#aisCsv").disabled = !allOk;
  };
  // Excelで書き出す：「依頼文」のシート（注意書き・管理番号・依頼）と「公館データ」のシート（1行1公館）
  // 窓の文章を、依頼の行と1行1公館のデータに分ける（Excel・CSV で共通）
  const aisTable = async (dest) => {
    const texts = [...Array(nParts()).keys()].map((i) => taOf(i).value);
    const { id } = await stampAiText(texts.join("\n\n"), dest, { month: m, scope: `公館別サマリー（${$("#sreg").value || "全地域"}）`, period: "今月" });
    const head = (texts[0].split(/^## 公館データ\s*$/m)[0] || "").trim();
    const rows = [];
    texts.forEach((tx, gi) => {
      const data = tx.split(/^## 公館データ\s*$/m)[1] || "";
      for (const blk of data.split(/\n(?=【[^】\n]{1,30}】)/)) {
        const mm = blk.trim().match(/^【([^】\n]{1,30})】([\s\S]*)$/);
        if (!mm) continue;
        const r = getReport(m, canonical(mm[1]) || mm[1]);
        rows.push([gi + 1, mm[1], r ? aiRegionOf(r.post) : "", mm[2].trim()]);
      }
    });
    return { id, guide: [`管理番号：${id}`, ...head.split("\n").filter((l) => !/^管理番号：/.test(l))], rows };
  };
  $("#aisCsv").onclick = async () => {
    const { id, guide, rows } = await aisTable("CSV書き出し");
    downloadCsv([["区分", "組", "公館", "地域", "内容"], ...guide.filter((l) => l.trim()).map((l) => ["依頼", "", "", "", l]), ...rows.map((r) => ["公館データ", ...r])],
      `サマリー_AI用_${m.replace("-", "")}_${id}.csv`);
    toast(`CSV（公館 ${rows.length}件・管理番号 ${id}）を書き出しました。GaiXer／源内に添付して「区分が依頼の行のとおりに、公館データの行ごとにサマリーを作ってください」と送ってください`);
  };
  $("#aisXlsx").onclick = async () => {
    const texts = [...Array(nParts()).keys()].map((i) => taOf(i).value);
    const { t, id } = await stampAiText(texts.join("\n\n"), "Excel書き出し", { month: m, scope: `公館別サマリー（${$("#sreg").value || "全地域"}）`, period: "今月" });
    const head = (texts[0].split(/^## 公館データ\s*$/m)[0] || "").trim();
    const rows = [];
    texts.forEach((tx, gi) => {
      const data = tx.split(/^## 公館データ\s*$/m)[1] || "";
      for (const blk of data.split(/\n(?=【[^】\n]{1,30}】)/)) {
        const mm = blk.trim().match(/^【([^】\n]{1,30})】([\s\S]*)$/);
        if (!mm) continue;
        const r = getReport(m, canonical(mm[1]) || mm[1]);
        rows.push([gi + 1, mm[1], r ? aiRegionOf(r.post) : "", mm[2].trim()]);
      }
    });
    const guide = [`管理番号：${id}`, ...head.split("\n").filter((l) => !/^管理番号：/.test(l)), "",
      "※公館データは、このファイルの「公館データ」のシートにあります（1行が1公館。「AIに渡す内容」の列が各公館のデータ）。"];
    const wb = XLSX.utils.book_new();
    const s1 = XLSX.utils.aoa_to_sheet(guide.map((l) => [l]));
    s1["!cols"] = [{ wch: 120 }];
    const s2 = XLSX.utils.aoa_to_sheet([["組", "公館", "地域", "AIに渡す内容"], ...rows]);
    s2["!cols"] = [{ wch: 5 }, { wch: 18 }, { wch: 10 }, { wch: 120 }];
    XLSX.utils.book_append_sheet(wb, s1, "依頼文");
    XLSX.utils.book_append_sheet(wb, s2, "公館データ");
    XLSX.writeFile(wb, `サマリー_AI用_${m.replace("-", "")}_${id}.xlsx`);
    toast(`Excel（公館 ${rows.length}件・管理番号 ${id}）を書き出しました。GaiXer／源内に添付して「依頼文のシートのとおりにサマリーを作ってください」と送り、回答を下に貼り付けてください`);
  };
  const drawParts = (texts) => {
    const bs = aisBatches(), many = bs.length > 1;
    $("#aisParts").classList.toggle("many", many);
    $("#aisOkL").textContent = many ? `すべての窓（${bs.length}つ）の内容を確認し、個人が特定される記載がないことを確かめた` : "内容を確認し、個人が特定される記載がないことを確かめた";
    $("#aisParts").innerHTML = bs.map((b, i) => `<div class="aispart">
        ${many ? `<div class="row" style="margin:0"><b>${i + 1}/${bs.length}</b><span class="muted">${b.length ? `${esc(b[0].post)}〜${esc(b[b.length - 1].post)}（${b.length}公館）` : ""}</span><span class="muted" id="aisPartLen${i}"></span></div>` : ""}
        <textarea id="${i ? `aisText${i}` : "aisText"}" data-pi="${i}" rows="${many ? 10 : 8}" placeholder="「① AIに渡す文章を作る」を押すと、ここに入ります（直接直せます）"></textarea>
        <div id="${i ? `aisCheck${i}` : "aisCheck"}"></div>
        <div class="row">${AI_SITES.map(([k, name]) => `<button class="primary" data-ais-go="${k}" data-pi="${i}" disabled>② ${many ? `${i + 1}つ目を` : ""}コピーして ${name} を開く</button>`).join("")}</div>
      </div>`).join("");
    (texts || []).forEach((t, i) => { if (taOf(i)) taOf(i).value = t; });
    document.querySelectorAll("#aisParts textarea").forEach((ta) => (ta.oninput = () => { $("#aisOk").checked = false; aisCheck(); }));
    document.querySelectorAll("[data-ais-go]").forEach((btn) => (btn.onclick = async () => {
      const k = btn.dataset.aisGo, i = Number(btn.dataset.pi), name = AI_SITES.find((x) => x[0] === k)[1], url = aiUrls()[k], ta = taOf(i), nb = nParts();
      const { t, id } = await stampAiText(ta.value, name, { month: m, scope: `公館別サマリー（${$("#sreg").value || "全地域"}）${nb > 1 ? `・${i + 1}/${nb}` : ""}`, period: "今月" });
      ta.value = t;
      if (!(await copyText(t))) { toast("コピーできませんでした"); return; }
      if (url) window.open(url, "_blank", "noopener");
      btn.classList.add("done"); btn.textContent = `✓ ${nb > 1 ? `${i + 1}つ目を` : ""}コピーしました（${name}）`;
      toast(`${nb > 1 ? `${i + 1}つ目（${i + 1}/${nb}）を` : ""}コピーしました（管理番号 ${id}）。${name} の入力欄に貼り付けて送り、回答を下の「AIの回答」に貼り付けてください${nb > 1 ? "（回答は続けて貼り付けて、まとめて読み取れます）" : ""}`);
    }));
    aisCheck();
  };
  markSplit(); drawParts();
  $("#aisMake").onclick = () => {
    drawParts(aisBatches().map((b) => AI_GUARD + aiSummaryPrompt(m, b)));
    $("#aisOk").checked = false;
    aisCheck();
  };
  document.querySelectorAll("[data-aissplit]").forEach((b) => (b.onclick = () => {
    aisSplit = Number(b.dataset.aissplit); savePref("aisSplit", aisSplit); markSplit();
    if ($("#aisText").value) $("#aisMake").onclick(); else drawParts();
  }));
  // 「AIでサマリーを作る」：手順の欄を開き、AIに渡す文章を作って、その場所へ移る
  $("#ovStart").onclick = () => { $("#ovCard").open = true; $("#ovCard").scrollIntoView({ behavior: "smooth", block: "start" }); };
  $("#aisStart").onclick = () => {
    $("#aisum").open = true;
    $("#aisMake").onclick();
    $("#aisum").scrollIntoView({ behavior: "smooth", block: "start" });
    toast("AIに渡す文章を作りました。内容を確かめてチェックを入れ、「コピーして GaiXer／源内 を開く」を押してください");
  };
  $("#aisOk").onchange = aisCheck;
  let parsed = null;
  $("#aisParse").onclick = () => {
    parsed = parseAiSummaries(m, $("#aisAnswer").value);
    const { items, unknown } = parsed;
    $("#aisPreview").innerHTML = !items.length ? '<div class="ai-warn">公館ごとのサマリーを読み取れませんでした。回答が「【公館名】」と「項目名：本文」の形になっているか確かめてください。</div>' : `
      <div class="table-wrap"><table class="mini"><tr><th><input type="checkbox" id="aisAll" checked></th><th>公館</th><th>行数</th><th>確認</th><th>内容（先頭）</th></tr>
      ${items.map((x, i) => `<tr><td><input type="checkbox" data-ais-i="${i}" checked></td><td>${esc(x.post)}</td><td class="num">${x.lines.length}</td>
        <td>${x.bad.length ? `<span class="badge warn">要確認</span> 月報にない数値：${esc(x.bad.join("、"))}` : '<span class="badge">数値OK</span>'}</td>
        <td class="muted">${esc(x.lines.slice(0, 2).join(" ／ ").slice(0, 80))}…</td></tr>`).join("")}</table></div>
      ${unknown.length ? `<p class="muted">この月の月報にない公館名のため読み飛ばしたもの：${esc(unknown.join("、"))}</p>` : ""}
      <div class="row"><button class="primary" id="aisApply">選んだ公館のサマリーとして取り込む</button>
      <span class="muted">取り込んだサマリーは「🤖 AI作成」になり、自動作成で上書きされません（各公館の「自動作成し直す」で元に戻せます）。</span></div>`;
    if (!items.length) return;
    $("#aisAll").onchange = (e) => document.querySelectorAll("[data-ais-i]").forEach((c) => (c.checked = e.target.checked));
    $("#aisApply").onclick = async () => {
      const over = [...document.querySelectorAll("[data-ais-i]")].filter((c) => c.checked).map((c) => parsed.items[c.dataset.aisI].post)
        .filter((pst) => { const r = getReport(m, pst); return r && (r.summaryManual || r.summaryAI); });
      if (over.length && !confirm(`次の公館の今のサマリー（手で書いたもの・以前にAIで作ったもの）は消えて、AIの回答に置き換わります（元には戻せません）。よろしいですか？\n${over.join("、")}`)) return;
      let k = 0;
      document.querySelectorAll("[data-ais-i]").forEach((c) => {
        if (!c.checked) return;
        const x = parsed.items[c.dataset.aisI], r = getReport(m, x.post);
        r.summary = x.lines.join("\n"); r.summaryManual = true; r.summaryAuto = false; r.summaryAI = new Date().toISOString(); k++;
      });
      await saveState();
      draw();
      const left = aisTargets().filter((r) => !(getReport(m, r.post) || {}).summaryAI).length;
      toast(`${k}公館のサマリーを AI の回答から取り込みました${nParts() > 1 && left ? `（AIのサマリーがまだない公館 ${left}件。残りの窓の回答も貼り付けて読み取ってください）` : ""}`);
    };
  };
  document.querySelectorAll("[data-slines]").forEach((b) => (b.onclick = async () => {
    savePref("summaryLines", Number(b.dataset.slines));
    const changed = upgradeSummaries();
    await saveState();
    const g = $("#sreg").value;
    pageSummary();
    $("#sreg").value = g; $("#sreg").onchange();
    toast(`サマリーを${summaryLines()}行にしました（作り直したサマリー ${changed}件〔全月分〕。手で書き換えたものはそのまま）`);
  }));
  $("#regenAll").onclick = async () => {
    if (!confirm("全公館の今のサマリー（手で書いたもの・AIで作ったものも含む）は消えて、月報の内容から作り直した文に置き換わります（元には戻せません）。よろしいですか？")) return;
    let changed = 0;
    for (const r of reportsOf(m)) { const t = ruleSummary(m, r.post); if (t !== r.summary) changed++; r.summary = t; r.summaryAuto = true; r.summaryManual = false; delete r.summaryAI; }
    await saveState(); draw();
    document.querySelectorAll(".sumcard textarea").forEach(flash);
    toast(`${reportsOf(m).length}公館のサマリーを自動作成し直しました（文面が変わったもの ${changed}件）`);
  };
  draw();
}

// ======================================================================= 巡回健診

async function pageJunkai() {
  if (needData()) return;
  const m = curMonth();
  await loadGeo();
  // 国は入力して検索できる（候補から選ぶ。英語名・都市名でもよい）
  const place = (f, v) => `<input data-f="${f}" data-combo="postList" value="${esc(v || "")}" placeholder="国名を入力" autocomplete="off" size="12">`;
  const rows = junkaiOf(m);
  main.innerHTML = `
    <h2>巡回健診（${fmtMonth(m)}）</h2>
    <div class="card">
      <p class="muted">丙表の「巡回」を含む記述から自動抽出しています。行先・期間の誤りは直して保存してください。</p>
      <div class="table-wrap"><table id="jt"><thead><tr><th>実施公館</th><th>巡回先</th><th>期間</th><th>記載</th><th></th></tr></thead><tbody>
      ${rows.map((j) => `<tr data-src="${esc(j.src || "")}"><td>${place("from", j.from)}</td><td>${place("dest", j.dest)}</td>
        <td><input data-f="period" value="${esc(j.period)}" size="10"></td><td><input data-f="note" value="${esc(j.note)}" style="width:100%"></td><td><button data-del>削除</button></td></tr>`).join("")}
      </tbody></table></div>
      ${postDatalist()}
      <div class="row"><button id="addJ">行を追加</button><button class="primary" id="saveJ">保存</button></div>
      ${mapControls()}<div id="jmap" class="plot map"></div>
    </div>
    <div class="card"><h3 style="margin-top:0">これまでの巡回健診</h3>${junkaiHistory()}</div>`;
  bindJunkaiHistory();
  const bindDel = () => document.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => b.closest("tr").remove()));
  bindDel();
  $("#addJ").onclick = () => {
    $("#jt tbody").insertAdjacentHTML("beforeend", `<tr data-src=""><td>${place("from", "")}</td><td>${place("dest", "")}</td><td><input data-f="period" size="10"></td><td><input data-f="note" style="width:100%"></td><td><button data-del>削除</button></td></tr>`);
    bindDel();
  };
  $("#saveJ").onclick = async () => {
    state.junkai[m] = [...document.querySelectorAll("#jt tbody tr")].map((tr) => {
      const o = { src: tr.dataset.src || "" };
      tr.querySelectorAll("[data-f]").forEach((i) => (o[i.dataset.f] = ["from", "dest"].includes(i.dataset.f) ? resolvePlace(i.value) || i.value.trim() : i.value.trim()));
      return o;
    }).filter((j) => j.from);
    await saveState(); toast("保存しました"); render();
  };
  drawMap("jmap", worldTraces(m, { junkai: true }), 480);
  bindMapControls();
}

// これまでの巡回健診：実施公館→巡回先ごとに1行（新しい順）。行をクリックすると、各回の丙表「巡回健診」の記載を開く
function junkaiHistory() {
  const g = {};
  for (const j of junkaiOf()) { const k = `${j.from}→${j.dest || "?"}`; const o = (g[k] ||= { c: 0, last: "", list: [] }); o.c++; o.list.push(j); if (j.month > o.last) o.last = j.month; }
  if (!Object.keys(g).length) return '<p class="muted">なし</p>';
  const ents = Object.entries(g).sort((x, y) => y[1].last.localeCompare(x[1].last) || jaCmp(x[0], y[0]));
  JH_GROUPS = Object.fromEntries(ents);
  return `<p class="muted" style="margin-top:0">行をクリックすると、その巡回について丙表の「巡回健診」の記載を表示します。</p>
    <div class="table-wrap scrolltbl"><table id="jhist"><thead><tr><th>実施公館→巡回先</th><th class="num">回数</th><th>直近</th></tr></thead><tbody>${
    ents.map(([k, o]) => `<tr class="jhrow" data-jh="${esc(k)}" tabindex="0" title="クリックで丙表の記載を表示"><td><span class="jharrow">▸</span> ${esc(k)}</td><td class="num">${o.c}</td><td>${fmtMonth(o.last)}</td></tr>`).join("")}</tbody></table></div>`;
}
let JH_GROUPS = {};
// その回の丙表から「巡回健診」の項を取り出す（項がない様式は、拾った文）
function junkaiHeiText(j) {
  const r = state.reports[`${j.month}|${j.src || j.from}`] || state.reports[`${j.month}|${j.from}`];
  const sec = r && r.hei ? (heiCaseSections(r.hei) || []).filter((x) => x.kind === "junkai") : [];
  if (sec.length) return sec.map((x) => heiParagraphs(x.body).map((p) => p.text).join("\n")).join("\n");
  return j.note || "（丙表の記載なし）";
}
function bindJunkaiHistory() {
  const toggle = (tr) => {
    const nx = tr.nextElementSibling;
    if (nx && nx.classList.contains("jhdet")) { nx.remove(); tr.classList.remove("open"); tr.querySelector(".jharrow").textContent = "▸"; return; }
    const o = JH_GROUPS[tr.dataset.jh]; if (!o) return;
    const items = o.list.slice().sort((a, b) => b.month.localeCompare(a.month)).map((j) =>
      `<div class="jhitem"><b>${fmtMonth(j.month)}</b>${j.period ? `（${esc(j.period)}）` : ""}　<span class="muted">${esc(j.src || j.from)}の丙表</span><div class="jhtext">${esc(junkaiHeiText(j)).replace(/\n/g, "<br>")}</div></div>`).join("");
    tr.insertAdjacentHTML("afterend", `<tr class="jhdet"><td colspan="3">${items}</td></tr>`);
    tr.classList.add("open"); tr.querySelector(".jharrow").textContent = "▾";
  };
  document.querySelectorAll("#jhist tr.jhrow").forEach((tr) => {
    tr.onclick = () => toggle(tr);
    tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(tr); } };
  });
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
  // 移送先は公館のない国・都市（スイス・ジュネーブなど）もあるので、一覧から選ぶだけでなく自由に入力できる
  if (kind === "place") return `<input data-f="${f}" list="placeList" value="${esc(v)}" size="14" placeholder="国名・都市名">`;
  if (kind === "who") return sel(CASE_WHO);
  if (kind === "kind") return sel(CASE_KINDS);
  if (kind === "means") return sel(MEANS_RULES.map((x) => x[0]).concat(["その他"]));
  if (kind === "outcome") return sel(OUTCOME_RULES.map((x) => x[0]).concat(["不明"]));
  if (kind === "note") return `<textarea data-f="${f}" rows="${Math.min(6, Math.max(3, Math.ceil(String(v).length / 40)))}">${esc(v)}</textarea>`;
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
      text: pt.map((p) => `${p}（${to[p].length}）`), textposition: "bottom center", textfont: { size: 11, color: isDark() ? "#90caf9" : "#0d47a1" },
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
  const cnt = (key, blank = false) => { const g = {}; for (const c of list) { const k = c[key] || (blank ? "記載なし" : ""); if (k) g[k] = (g[k] || 0) + 1; } return Object.entries(g).sort((a, b) => (a[0] === "記載なし") - (b[0] === "記載なし") || b[1] - a[1]); };
  const editable = !casesAll;
  // 丙表の記載は、表の右端の狭い欄ではなく、各症例の下の行に全幅で出す
  const mainCols = def.cols.filter(([f]) => f !== "note"), nCols = mainCols.length + (casesAll ? 1 : 0) + (editable ? 1 : 0);
  const noteRow = (v) => `<tr class="noterow"><td colspan="${nCols}"><span class="muted">📄 丙表の記載：</span>${editable ? `<textarea data-f="note" rows="${Math.min(5, Math.max(2, Math.ceil(String(v).length / 70)))}">${esc(v)}</textarea>` : `<span class="notetext">${esc(v)}</span>`}</td></tr>`;
  main.innerHTML = `
    <h2>${def.title}（${casesAll ? "全期間" : fmtMonth(m)}）</h2>
    <div class="row"><label><input type="checkbox" id="call"${casesAll ? " checked" : ""}> 全期間を表示</label></div>
    <div class="kpis">
      <div class="kpi"><div class="label">件数</div><div class="value">${list.length}</div></div>
      <div class="kpi"><div class="label">対象</div><div class="delta">${cnt("who", true).map(([k, v]) => `<span class="kv">${esc(k)} ${v}</span>`).join("") || "―"}</div></div>
      ${type === "evac"
        ? `<div class="kpi"><div class="label">主な移送先</div><div class="delta">${cnt("dest").slice(0, 4).map(([k, v]) => `<span class="kv">${flagImg(k, "flag sm")}${esc(k)} ${v}</span>`).join("") || "―"}</div></div>
           <div class="kpi"><div class="label">転帰</div><div class="delta">${cnt("outcome", true).map(([k, v]) => `<span class="kv">${esc(k)} ${v}</span>`).join("") || "―"}</div></div>
           <div class="kpi"><div class="label">理由（疾病分類）</div><div class="delta">${list.length ? evacBreakdown(list).reason.map(([k, v]) => `<span class="kv">${esc(k)} ${v}</span>`).join("") : "―"}</div></div>
           <div class="kpi"><div class="label">手段</div><div class="delta">${cnt("means", true).map(([k, v]) => `<span class="kv">${esc(k)} ${v}</span>`).join("") || "―"}</div></div>`
        : `<div class="kpi"><div class="label">区分</div><div class="delta">${cnt("kind").map(([k, v]) => `<span class="kv"><span class="dot" style="background:${KIND_COLORS[k]}"></span>${esc(k)} ${v}</span>`).join("") || "―"}</div></div>
           <div class="kpi"><div class="label">公館数</div><div class="value">${new Set(list.map((c) => c.post)).size}</div></div>`}
    </div>
    <div class="card">
      ${mapControls()}
      <div id="casemap" class="plot map"></div>
    </div>
    ${allMonths.length > 1 ? `<div class="card"><div id="casechart" class="plot" style="min-height:260px"></div></div>` : ""}
    <div class="card">
      <p class="muted">${def.desc}${editable ? "" : "（全期間表示では編集できません。月を選んで直してください）"}</p>
      <datalist id="placeList">${ALL_PLACES.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
      <div class="table-wrap"><table id="ct"><thead><tr>${casesAll ? "<th>月</th>" : ""}${mainCols.map((c) => `<th>${c[1]}</th>`).join("")}${editable ? "<th></th>" : ""}</tr></thead><tbody>
        ${list.map((c) => `<tr class="caserow" data-src="${esc(c.src || "")}">${casesAll ? `<td>${fmtMonth(c.month)}</td>` : ""}${mainCols.map(([f, , kind]) => editable
          ? `<td>${caseInput(kind, f, c[f] || "")}</td>`
          : `<td>${kind === "post" || kind === "place" ? flagImg(c[f], "flag sm") : ""}${f === "post" ? `<button class="linklike" data-post-card="${esc(c.post)}">${esc(c.post)}</button>` : esc(c[f] || "")}</td>`).join("")}${editable ? "<td><button data-del>削除</button></td>" : ""}</tr>
          ${noteRow(c.detail || c.note || "")}`).join("")}
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
  const bindDel = () => document.querySelectorAll("#ct [data-del]").forEach((b) => (b.onclick = () => { const tr = b.closest("tr"), nx = tr.nextElementSibling; if (nx && nx.classList.contains("noterow")) nx.remove(); tr.remove(); }));
  bindDel();
  $("#caddRow").onclick = () => {
    $("#ct tbody").insertAdjacentHTML("beforeend", `<tr class="caserow" data-src="">${mainCols.map(([f, , kind]) => `<td>${caseInput(kind, f, "")}</td>`).join("")}<td><button data-del>削除</button></td></tr>${noteRow("")}`);
    bindDel();
  };
  $("#csave").onclick = async () => {
    const rows = [...document.querySelectorAll("#ct tbody tr.caserow")].map((tr) => {
      const o = { type, src: tr.dataset.src || "" };
      const nx = tr.nextElementSibling, cells = [...tr.querySelectorAll("[data-f]"), ...(nx && nx.classList.contains("noterow") ? nx.querySelectorAll("[data-f]") : [])];
      cells.forEach((i) => (o[i.dataset.f] = i.value.trim()));
      // 移送先は一覧の表記ゆれ（「ジュネーブ」→ 一覧にあればその名前）に合わせ、一覧になければ入力したまま残す
      if (o.dest && !INFO[o.dest]) { const c = canonical(o.dest); if (c && nfkc(c) === nfkc(o.dest).replace(/^在|大使館$/g, "")) o.dest = c; }
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
  const tr = transfers(), ot = officerTable(), ms = Object.keys(ot).sort(), paths = officerPaths();
  // 月が多いと表が大きくなり重いので、はじめは直近24か月だけ（「全期間を表示」で全部）
  const gAll = !!loadPrefs().trGridAll, gms = gAll ? ms : ms.slice(-24);
  const posts = [...new Set(Object.values(ot).flatMap((o) => Object.keys(o)))].sort(jaCmp);
  main.innerHTML = `
    <h2>医務官の異動</h2>
    <div class="card">
      <p class="muted">取り込んだ配置表の医務官名を、配置表の日付の順に比べて交代を見つけます（月報の医務官名は使いません）。同じ氏名が別の公館に出てきたときは、前任地として示します。</p>
      ${tr.length ? `<div class="table-wrap vresize trgrid" data-rkey="trListH"><table><thead><tr><th class="tpost">公館</th><th>月</th><th>前任</th><th>後任</th><th>後任の前任地</th></tr></thead><tbody>${
        tr.slice().reverse().map((t) => `<tr><td class="tpost">${esc(t.post)}</td><td>${fmtMonth(t.month)}</td><td>${esc(t.before)}</td><td>${esc(t.after)}</td><td>${esc(t.from || "")}</td></tr>`).join("")}</tbody></table></div>
        ` : `<p class="muted">${rosterKeys().length ? "配置表が2つ以上（日付の違うもの）そろうと交代を見つけます。" : "配置表がまだありません。「取り込み」タブの「医務官配置表」で配置表（Excel・PDF）を取り込むと、交代を見つけます。"}</p>`}
    </div>
    ${ms.length ? "" : "<!--"}<div class="card"><h3 style="margin-top:0">公館×月 医務官一覧（配置表から） ${ms.length > 24 ? `<button class="linklike" id="trGridAll">${gAll ? "直近24か月だけ表示" : `全期間を表示（${ms.length}か月）`}</button>` : ""}</h3><div class="table-wrap vresize trgrid" data-rkey="trGridH"><table><thead><tr><th class="tpost">公館</th>${gms.map((m) => `<th>${fmtMonth(m)}</th>`).join("")}</tr></thead><tbody>${
      posts.map((p) => `<tr><td class="tpost">${esc(p)}</td>${gms.map((m) => `<td>${esc((ot[m] || {})[p] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>${ms.length ? "" : "-->"}
    ${paths.length ? `<div class="card"><h3 style="margin-top:0">医務官ごとの異動先（配置表から）</h3>
      <p class="muted">医務官ごとに、いた公館を時期の順に並べます。異動した人を上にしています。</p>
      <div class="table-wrap vresize trgrid" data-rkey="trPathH"><table><thead><tr><th class="tpost">医務官</th><th>異動前の公館</th><th>異動先・いまの公館</th><th>公館の移り変わり</th></tr></thead><tbody>${
        paths.map((o) => { const a = o.posts, cur = a[a.length - 1], prev = a.length > 1 ? a[a.length - 2] : null, gone = ms.length && cur.to < ms[ms.length - 1];
          return `<tr><td class="tpost">${esc(officerShow(o.name))}</td><td>${prev ? esc(prev.post) : ""}</td><td>${prev ? `<b>${esc(cur.post)}</b>（${fmtMonth(cur.from)}〜）` : esc(cur.post)}${gone ? `<span class="muted">（${fmtMonth(cur.to)}の後は配置表になし）</span>` : ""}</td><td>${a.map((x) => `${esc(x.post)}（${fmtMonth(x.from)}${x.to !== x.from ? "〜" + fmtMonth(x.to) : ""}）`).join(" → ")}</td></tr>`; }).join("")}</tbody></table></div></div>` : ""}`;
  vresize(main);
  if ($("#trGridAll")) $("#trGridAll").onclick = () => { savePref("trGridAll", !gAll); render(); };
  const g = main.querySelector(".trgrid[data-rkey='trGridH']"); if (g) g.scrollLeft = g.scrollWidth;   // 最新の月が見えるように右端から
}

// ======================================================================= 推移

function pageTrend() {
  if (needData()) return;
  const all = reportsOf();
  main.innerHTML = `
    <h2>月ごとの推移</h2>
    <div class="row">
      <b>地域</b><span class="seg" id="tregBtns"></span>
      <label hidden>地域 <select id="treg"><option value="">すべて</option>${loadPrefs().homePost ? `<option value="@home">🏠 自分の公館（${esc(loadPrefs().homePost)}）</option>` : ""}${REGIONS.map((r) => `<option>${r}</option>`).join("")}</select></label>
      <label>公館 <select id="tpost"></select></label>
    </div>
    <div class="card"><div id="t1" class="plot"></div></div>
    <div class="card"><div id="t2" class="plot"></div></div>
    <div class="card"><h3 style="margin-top:0">公館×月 受診者数 <button class="linklike" id="tpivAll" hidden></button></h3><div class="table-wrap vresize" data-rkey="trendPivH" id="tpiv"></div></div>`;
  const fillPosts = () => {
    const g = $("#treg").value;
    const ps = [...new Set(all.filter((r) => inRegSel(r, g)).map((r) => r.post))].sort(jaCmp);
    $("#tpost").innerHTML = `<option value="">すべて</option>` + ps.map((p) => `<option>${esc(p)}</option>`).join("");
  };
  const draw = () => {
    const g = $("#treg").value, p = $("#tpost").value;
    const rs = all.filter((r) => inRegSel(r, g) && (!p || r.post === p));
    const ms = [...new Set(all.map((r) => r.month))].sort();
    // 月ごとの月報は1回だけまとめる（月×月報の総当たりにしない）
    const byMon = new Map(); for (const r of rs) { const a = byMon.get(r.month); if (a) a.push(r); else byMon.set(r.month, [r]); }
    const xs = ms.map(fmtMonth);
    const traces = [["staff", "職員"], ["family", "家族"], ["other", "その他"], ["total", "計"]].map(([f, name]) => ({
      type: "scatter", mode: "lines+markers", name, x: xs, y: ms.map((m) => sum(byMon.get(m) || [], (r) => r[f])),
      line: f === "total" ? { width: 3 } : {} }));
    // 月×地域の合計は1回まとめて数える
    const byMR = new Map();
    for (const r of rs) byMR.set(`${r.month}|${r.region}`, (byMR.get(`${r.month}|${r.region}`) || 0) + (Number(r.total) || 0));
    if (!g && !p) for (const reg of REGIONS) traces.push({ type: "scatter", mode: "lines+markers", name: reg, visible: "legendonly", x: xs, line: { color: regionColor(reg), width: 2 },
      y: ms.map((m) => byMR.get(`${m}|${reg}`) || 0) });
    plot("t1", traces, { title: "受診者数の推移（凡例クリックで地域別も表示）", height: 380, margin: { l: 50, r: 20, t: 40, b: 40 } });
    const dis = diseasesOf().filter((d) => inRegSel(d, g) && (!p || d.post === p) && d.category !== Z);
    const cats = CATEGORIES.filter((c) => dis.some((d) => d.category === c));
    const byMC = new Map();
    for (const d of dis) byMC.set(`${d.month}|${d.category}`, (byMC.get(`${d.month}|${d.category}`) || 0) + (Number(d.count) || 0));
    plot("t2", cats.map((c) => ({ type: "bar", name: shortCat(c), marker: { color: D.colors[c] }, x: xs,
      y: ms.map((m) => byMC.get(`${m}|${c}`) || 0) })),
      { title: "疾病分類の推移（検診・予防接種を除く）", barmode: "stack", height: 380, margin: { l: 50, r: 20, t: 40, b: 40 } });
    const ps = [...new Set(rs.map((r) => r.post))];
    // 公館の多い表は、枠の中で縦横にスクロールする（公館の列と月の見出しは動かさない。はじめは最新の月が見える右端に）
    const box0 = $("#tpiv");
    // 国名（公館）の列は左に固定し、月は横にスクロールする（月が多くても列を詰めず、見出しを折り返さない）
    // 月が多いと表が大きく重いので、はじめは直近24か月だけ（「全期間を表示」で全部）
    const pAll = !!loadPrefs().trendPivAll, pms = pAll ? ms : ms.slice(-24);
    $("#tpivAll").hidden = ms.length <= 24; $("#tpivAll").textContent = pAll ? "直近24か月だけ表示" : `全期間を表示（${ms.length}か月）`;
    $("#tpiv").innerHTML = `<table class="trpiv"><thead><tr><th class="tpost">公館</th>${pms.map((m) => `<th class="num">${fmtMonth(m)}</th>`).join("")}</tr></thead><tbody>${
      ps.map((pp) => `<tr><td class="tpost" title="${esc(regionOf(pp))}">${esc(pp)}</td>${pms.map((m) => { const r = getReport(m, pp); return `<td class="num">${r ? n(r.total) : ""}</td>`; }).join("")}</tr>`).join("")}</tbody></table>`;
    box0 && (box0.scrollLeft = box0.scrollWidth);
    const box = $("#tpiv");
    if (!box.dataset.vrInit) { box.dataset.vrInit = "1"; vresize(box.parentElement); }
    else if (!Number(loadPrefs().trendPivH)) box.style.height = box.scrollHeight > 420 ? "420px" : "";
  };
  $("#treg").onchange = () => { fillPosts(); draw(); markTreg(); };
  // 地域はほかの画面（統計・PDF・AI分析）と同じくボタンで選ぶ（中の選択ボックスと連動）
  $("#tregBtns").innerHTML = [...$("#treg").options].map((o) => `<button data-treg="${esc(o.value)}">${o.value === "" ? "🌏 全世界" : esc(o.textContent)}</button>`).join("");
  const markTreg = () => document.querySelectorAll("[data-treg]").forEach((b) => b.classList.toggle("on", b.dataset.treg === $("#treg").value));
  document.querySelectorAll("[data-treg]").forEach((b) => (b.onclick = () => { $("#treg").value = b.dataset.treg; $("#treg").onchange(); }));
  $("#tpivAll").onclick = () => { savePref("trendPivAll", !loadPrefs().trendPivAll); draw(); };
  $("#tpost").onchange = draw;
  // 自分の公館を設定していれば、はじめはその公館から
  if (loadPrefs().homePost && $("#treg").querySelector('option[value="@home"]')) $("#treg").value = "@home";
  fillPosts(); draw(); markTreg();
}

// ======================================================================= PDFレポート
// 書き出しはパスワード付きPDFのみ。各ページを画像にして「取扱注意」の透かしを焼き込むので、印刷しても必ず透かしが出る

const PDF_PASSWORD = "imukanmd";
const RP_W = 794, RP_H = 1123;  // A4（96dpi）
const WATERMARK = "取扱注意";

// 分析の目的 → それに要る章（secs）と統計（stats）。期間が短すぎるときは minSpan か月にする（時系列は1年以上）
const REPORT_PURPOSES = [
  { k: "exec", t: "📋 幹部への定期報告（要点）", d: "全体概況・地図・受診者数・疾病分類・緊急移送・邦人援護・公館別5行サマリー", secs: ["aisum", "overview", "map", "visits", "diseases", "evac", "hogo", "summary"], stats: [], sumLines: 5 },
  { k: "trend", t: "📈 時系列の傾向を知る", d: "月ごとの推移・増減の傾向・前年同月との比較・いつもより多い病名・感染症の推移（期間は1年以上にします）", secs: ["overview", "visits", "diseases", "stats"], stats: ["trend", "yoy", "excess", "infect", "heatdis", "change"], minSpan: 12 },
  { k: "infect", t: "🦠 感染症の流行を監視する", d: "世界地図・いつもより多い病名・主な感染症の推移・病名×月・前年同月", secs: ["overview", "map", "diseases", "stats"], stats: ["excess", "infect", "watch", "spread", "heatdis", "yoy"] },
  { k: "region", t: "🌏 地域を比べる", d: "地図・受診者数と疾病分類の地域別・ばらつき・構成比・疾病分類×地域", secs: ["map", "visits", "diseases", "stats"], stats: ["desc", "box", "share", "heatcat"] },
  { k: "workload", t: "🏥 業務量・体制を見る（配置の検討）", d: "公館別の受診者数（医務官1人あたり）・ばらつき・増えた減った公館・巡回健診と異動・提出状況", secs: ["visits", "stats", "junkai", "submit"], stats: ["posts", "desc", "box", "change"] },
  { k: "hogo", t: "🚑 邦人保護・緊急対応", d: "全体概況・緊急移送の症例・邦人援護の事例", secs: ["overview", "evac", "hogo"], stats: [] },
  { k: "quality", t: "📮 月報の提出・記載状況", d: "提出率・未提出の公館・記載の足りない月報", secs: ["submit"], stats: [] },
  { k: "epi", t: "🧫 疫学・公衆衛生", d: "注目する疾患群の推移・感染症の地理的な広がり・いつもより多い病名・前年同月・受診率（在籍人数を入れたとき）", secs: ["overview", "map", "diseases", "stats"], stats: ["watch", "spread", "excess", "infect", "yoy", "rate", "heatdis"], minSpan: 12 },
  { k: "occ", t: "👷 産業保健（職員の健康管理）", d: "職員の受診・生活習慣病・こころの不調（地域別のみ）・外傷・健診と予防接種・受診率", secs: ["overview", "visits", "stats"], stats: ["occ", "rate", "watch", "zcat", "trend"] },
  { k: "special", t: "🩺 専門科の視点（内訳）", d: "皮膚・外傷・感染症・呼吸器・こころの内訳、予防接種・健診の内訳", secs: ["diseases", "stats"], stats: ["subcat", "zcat"] },
  { k: "stats", t: "📊 統計を詳しく", d: "統計分析のすべての項目と、保存した検定・推定の結果", secs: ["stats"], stats: null },
  { k: "ai", t: "🤖 AI分析の結果をまとめる", d: "全体概況と、保存したAIの回答", secs: ["overview", "ai"], stats: [] },
  { k: "feedback", t: "✉️ 全医務官あての統合サマリー", d: "全医務官に送る今月のまとめ：世界と地域の数字・多い疾病・地域ごとの感染症の流行・公館ごとの一覧・緊急移送と邦人対応の件数（事例の中身は載せない）・巡回健診・異動・提出状況（期間は1か月にします）", secs: ["feedback"], stats: [], oneMonth: true },
];
function pageReport() {
  if (needData()) return;
  // 期間：「直近○か月」は月報のある最新の月まで（上で選んでいる月ではない）。「期間を指定」は始めと終わりの月を自分で選ぶ
  const repMonths = [...new Set(Object.values(state.reports).map((r) => r.month))].sort();
  const latest = repMonths[repMonths.length - 1] || curMonth();
  const pr = loadPrefs();
  // 期間の初めの値は「全期間」（以前に選んだ「1か月」などが残っていても、この版で一度だけ全期間に戻す）
  if (pr.reportSpanV !== 2) { savePref("reportSpanV", 2); savePref("reportSpan", 0); savePref("reportMode", "recent"); pr.reportSpan = 0; pr.reportMode = "recent"; }
  // 「どんな分析をしたいか」が何も選ばれていなければ、項目・統計も何も選ばない状態から始める（この版で一度だけ、以前の「すべて選ぶ」を外す）
  if (pr.reportSelV !== 1) { savePref("reportSelV", 1); if (!(pr.reportPurposes || []).length) { savePref("reportSecs", []); savePref("reportStats2", []); } }
  let mode = pr.reportMode === "custom" ? "custom" : "recent";
  let range = pr.reportRange && pr.reportRange.from && pr.reportRange.to ? { ...pr.reportRange } : { from: spanMonths(latest, 3)[0], to: latest };
  let recentSpan = REPORT_SPANS.some(([k]) => k === pr.reportSpan) ? pr.reportSpan : 0;
  let m = latest, span = recentSpan;   // レポートの終わりの月と月数（全期間は 0）
  const recompute = () => {
    if (mode === "custom") { m = range.to; span = monthsBetween(range.from, range.to); }
    else { m = latest; span = recentSpan; }
  };
  main.innerHTML = `
    <h2>統合PDFレポート</h2>
    <div class="card step">
      <div class="stephead"><span class="stepno">1</span><h3>期間と範囲</h3></div>
      <div class="row"><b class="flab">期間</b><span class="seg">${REPORT_SPANS.map(([k, t]) => `<button data-rspan="${k}">${k ? "直近" + t : t}</button>`).join("")}<button data-rspan="custom">📅 期間を指定</button></span></div>
      <div class="row" id="rrange"><b class="flab">指定する期間</b>${monthField(range.from, 'id="rfrom"')} 〜 ${monthField(range.to, 'id="rto"')}<span class="muted">（「202601」のように数字だけでも入れられます）</span></div>
      <div class="row"><b class="flab">地域</b><span class="seg">${[`<button data-rreg="">🌏 全世界</button>`, ...AI_REGIONS.map((g) => `<button data-rreg="${esc(g)}">${esc(g)}</button>`)].join("")}</span>
        <span class="muted">（複数選べます）</span></div>
      <div class="row"><b class="flab">国</b><input id="rpost" data-combo="rpostList" placeholder="国名を入力して追加" autocomplete="off" size="16"><button id="rpostAdd">追加</button>
        <span id="rpostChips"></span><span class="muted">（地域と組み合わせられます）</span></div>
      <datalist id="rpostList"></datalist>
      <div class="scopebox" id="rspanLab"></div>
    </div>
    <div class="card step">
      <div class="stephead"><span class="stepno">2</span><h3>どんな分析をしたいか</h3><span class="muted">選ぶと、要る項目・統計に自動でチェックが入ります。いくつでも選べ、下で足し引きもできます。絵に触れると中身が出ます</span></div>
      ${(() => {
        // よく使う4つを上に大きく、残りは「ほかの目的」にまとめる（選んでいるものがあれば開いておく）
        const card = (x) => `<label class="purcard" title="${esc(x.d)}"><input type="checkbox" data-rpur="${x.k}"${(loadPrefs().reportPurposes || []).includes(x.k) ? " checked" : ""}><span class="pure">${x.t.split(" ")[0]}</span><span class="purt">${x.t.replace(/^\S+\s/, "")}</span></label>`;
        const main4 = ["exec", "infect", "hogo", "quality"], rest = REPORT_PURPOSES.filter((x) => !main4.includes(x.k));
        const openRest = rest.some((x) => (loadPrefs().reportPurposes || []).includes(x.k));
        return `<div class="purgrid rpurpose purmain">${main4.map((k) => card(REPORT_PURPOSES.find((x) => x.k === k))).join("")}</div>
          <details class="purmore"${openRest ? " open" : ""}><summary>ほかの目的（${rest.length}）― 時系列・地域の比較・疫学・産業保健・専門科・統計 など</summary><div class="purgrid rpurpose">${rest.map(card).join("")}</div></details>`;
      })()}
      <p class="okbox" id="rpurNote" style="margin-bottom:0" hidden></p>
    </div>
    <div class="card step">
      <div class="stephead"><span class="stepno">3</span><h3>PDFにする項目</h3><span class="muted">（表紙と目次は常に入ります）</span><button class="linklike" id="secAll">すべて選ぶ</button><button class="linklike" id="secNone">すべて外す</button></div>
      <div class="row secpick chips">${REPORT_SECTIONS.map(([k, t]) => `<label><input type="checkbox" data-rsec="${k}"${secsCompat(loadPrefs().reportSecs || []).includes(k) ? " checked" : ""}> ${t}</label>`).join("")}</div>
      <div id="rstatPick" class="secpick-sub"><b>統計分析に入れる統計</b> <button class="linklike" id="rstatAll">すべて選ぶ</button><button class="linklike" id="rstatNone">すべて外す</button>
        <div class="row secpick chips">${STAT_ITEMS.map(([k, t]) => `<label><input type="checkbox" data-rstat="${k}"${(loadPrefs().reportStats2 || []).includes(k) ? " checked" : ""}> ${t}</label>`).join("")}</div></div>
      <div id="rsnPick" class="secpick-sub"></div>
      <div id="raiPick" class="secpick-sub"></div>
      <div class="secpick-sub"><label><input type="checkbox" id="rpriv"${loadPrefs().reportPrivMental === false ? "" : " checked"}> 🔒 <b>精神・行動、妊娠・出産の病名を公館別に載せない</b></label> <span class="muted">（件数の少ない公館では個人が特定されやすいため。公館別サマリーの「主な疾病」などから外し、地域別・全体の集計には含めます）</span></div>
      <div id="rsumPick" class="secpick-sub"><b>公館別サマリーの行数</b> <span class="seg">${SUMMARY_SIZES.map((k) => `<button data-rsum="${k}">${k}行</button>`).join("")}</span>
        <span class="muted">（「特記なし」の行は載せません。手で書いたサマリー・AIで作ったサマリーはその文のまま）</span></div>
    </div>
    <div class="card step mkcard">
      <div class="stephead"><span class="stepno">4</span><h3>作成</h3><span class="muted">別のタブでPDFを作り、そのタブで表示します（表示・印刷・保存はそのタブで）。作成中もこのタブで作業を続けられます</span></div>
      <div class="row"><button class="primary big" id="mk">PDFを作成（別のタブで開く）</button><button class="big" id="mkWord" title="同じ内容を Word 文書（.docx）で作ります。文章や表をあとから書き直せます">📝 Wordで作成（.docx）</button><button class="danger" id="mkStop" hidden>■ 作成を中止</button><b id="mkWhat"></b><span id="wst" class="muted"></span></div>
      <details class="quiet"><summary>PDF・Wordについて（印刷・目次・書き直し）</summary>
      <ul class="muted" style="margin:6px 0 4px">
        <li>パスワードは付けません。保存先は医務官のみがアクセスできるフォルダにしてください</li>
        <li>Word（.docx）は同じ内容を、見出し・表・図のある文書にします。文章や表をあとから書き直せます（見出しは Word の「見出し1〜3」なので、ナビゲーションや目次の挿入に使えます）</li>
        <li><b>印刷したときだけ</b>、全ページに「${WATERMARK}」の透かし・印・注意書きが入ります（画面では表示しません）</li>
        <li>目次の各行を押すとその章へ移動します。ビューアの「しおり」からも移動できます</li>
        <li>作成もブラウザの中だけで行い、外部には送信しません</li>
      </ul></details>
    </div>
    <div class="card">
      <h3 class="stephd" style="margin-top:0">📁 作成したPDF（このブラウザに最近の20件）</h3>
      <p class="muted" id="pdfStoreHelp" style="margin-top:0">作成したPDFは、このPCのこのブラウザの中に新しい順に20件まで残ります（古いものから自動で消えます。デモ表示中は残しません）。ブラウザのデータを消すと、ここに残したPDFも消えます。</p>
      <div id="pdfStore"></div>
    </div>
`;
  const chosen = () => [...document.querySelectorAll("[data-rsec]")].filter((c) => c.checked).map((c) => c.dataset.rsec);
  renderPdfStore();
  // 地域（設定として覚える）
  recompute();
  let regs = [...new Set((loadPrefs().reportRegions || []).flatMap((g) => SPLIT_REGIONS[g] || [g]))].filter((g) => AI_REGIONS.includes(g));
  // 個別に選ぶ国（月報のある公館から）
  const withData = [...new Set(Object.values(state.reports).map((r) => r.post))].sort((a, b) => AI_REGIONS.indexOf(aiRegionOf(a)) - AI_REGIONS.indexOf(aiRegionOf(b)) || jaCmp(a, b));
  // 一度も選んでいないときは、設定の「自分の公館」から始める
  const prH = loadPrefs(), homeP = prH.homePost && withData.includes(prH.homePost) && prH.reportPosts === undefined && prH.reportRegions === undefined ? [prH.homePost] : null;
  let rposts = homeP || (loadPrefs().reportPosts || []).filter((x) => withData.includes(x));
  $("#rpostList").innerHTML = withData.slice().sort(jaCmp).map((x) => `<option value="${esc(x)}" label="${esc(aiRegionOf(x))}"></option>`).join("");
  const showOpts = () => {
    document.querySelectorAll("[data-rspan]").forEach((b) => b.classList.toggle("on", b.dataset.rspan === "custom" ? mode === "custom" : mode === "recent" && Number(b.dataset.rspan) === span));
    $("#rrange").hidden = mode !== "custom";
    document.querySelectorAll("[data-rreg]").forEach((b) => b.classList.toggle("on", b.dataset.rreg ? regs.includes(b.dataset.rreg) : !regs.length && !rposts.length));
    $("#rpostChips").innerHTML = rposts.map((x) => `<button class="ai-post on chip-x" data-rpost-del="${esc(x)}" title="押すと選択を外します">${esc(x)}<span class="x">✕</span></button>`).join("");
    document.querySelectorAll("[data-rpost-del]").forEach((b) => (b.onclick = () => { rposts = rposts.filter((x) => x !== b.dataset.rpostDel); savePref("reportPosts", rposts); showOpts(); }));
    const inS = inReportScope(regs, rposts), ms = spanMonths(m, span), have = ms.filter((mm) => reportsOf(mm).some((r) => inS(r.post)));
    $("#rspanLab").textContent = `対象：${mode === "recent" && span ? "直近 " : ""}${reportLabel(m, span)}・${regionsLabel(regs, rposts)}（月報のある月 ${have.length}/${ms.length}）`;
    if ($("#mkWhat")) $("#mkWhat").textContent = `期間：${reportLabel(m, span)}`;
  };
  const periodChanged = () => { recompute(); showOpts(); if ($("#raiPick")) { drawStatNotePick(); drawAiPick(); } };
  document.querySelectorAll("[data-rspan]").forEach((b) => (b.onclick = () => {
    if (b.dataset.rspan === "custom") mode = "custom";
    else { mode = "recent"; recentSpan = Number(b.dataset.rspan); savePref("reportSpan", recentSpan); }
    savePref("reportMode", mode); periodChanged();
  }));
  // 指定する期間：始めが終わりより後なら入れ替える
  for (const id of ["#rfrom", "#rto"]) $(id).addEventListener("monthset", () => {
    const a = $("#rfrom").dataset.ym, b = $("#rto").dataset.ym;
    if (!a || !b) return;
    range = a <= b ? { from: a, to: b } : { from: b, to: a };
    if (a > b) { $("#rfrom").value = fmtMonth(range.from); $("#rfrom").dataset.ym = range.from; $("#rto").value = fmtMonth(range.to); $("#rto").dataset.ym = range.to; }
    savePref("reportRange", range); periodChanged();
  });
  document.querySelectorAll("[data-rreg]").forEach((b) => (b.onclick = () => {
    const g = b.dataset.rreg;
    if (!g) { regs = []; rposts = []; savePref("reportPosts", rposts); }  // 全世界＝選択をすべて外す
    else regs = regs.includes(g) ? regs.filter((x) => x !== g) : [...regs, g];
    savePref("reportRegions", regs); showOpts();
  }));
  const addPost = () => {
    const v = resolvePlace($("#rpost").value);
    if (!v || !withData.includes(v)) { if ($("#rpost").value.trim()) toast("月報のある国から選んでください"); return; }
    if (!rposts.includes(v)) rposts.push(v);
    $("#rpost").value = "";
    savePref("reportPosts", rposts); showOpts();
  };
  $("#rpostAdd").onclick = addPost;
  $("#rpost").onchange = addPost;
  $("#rpost").onkeydown = (e) => { if (e.key === "Enter" && !(combo.input === e.target && combo.idx >= 0)) addPost(); };
  showOpts();
  const hasData = () => { const inS = inReportScope(regs, rposts); return spanMonths(m, span).some((mm) => reportsOf(mm).some((r) => inS(r.post))); };
  // 統計分析の中身（チェックで選ぶ）。統計分析の章を選んだときだけ表示する
  const statsChosen = () => [...document.querySelectorAll("[data-rstat]")].filter((c) => c.checked).map((c) => c.dataset.rstat);
  // AI分析の結果：AI分析タブで保存した回答の、新しい方から10件から選ぶ（期間に入る月のものを最初から選んでおく）
  const notesAll = state.aiNotes || [];
  // 統計：統計タブの「検定・推定」で保存した結果の、新しい方から10件から選ぶ
  const statNotesAll = (state.statNotes || []).slice(0, 10);
  const statNotesChosen = () => [...document.querySelectorAll("[data-rsn]")].filter((c) => c.checked).map((c) => c.dataset.rsn);
  const drawStatNotePick = () => {
    const box = $("#rsnPick");
    box.hidden = !chosen().includes("stats");
    if (box.hidden) return;
    const ms = spanMonths(m, span);
    box.innerHTML = statNotesAll.length ? `<b>統計分析に入れる「保存した検定・推定の結果」</b><span class="muted">（新しい順・最近の${statNotesAll.length}件）</span><div class="secpick ai-notepick">${statNotesAll.map((x) => `<label><input type="checkbox" data-rsn="${esc(x.id)}"${ms.includes(x.month) ? " checked" : ""}>
        ${esc(fmtMonth(x.month))}「${esc(x.title)}」<span class="muted">（${esc(new Date(x.at).toLocaleDateString("ja-JP"))}）</span></label>`).join("")}</div>`
      : '<span class="muted keep">保存した検定・推定の結果がありません（統計タブの「検定・推定」で「📌 この結果を保存」を押すと、ここで選べます）</span>';
    // 結果を選んだら、統計の「保存した検定・推定の結果」にもチェックを入れる
    box.querySelectorAll("[data-rsn]").forEach((c) => (c.onchange = () => { const inf = document.querySelector('[data-rstat="infer"]'); if (c.checked && inf && !inf.checked) { inf.checked = true; savePref("reportStats2", statsChosen()); } }));
  };
  const aiChosen = () => [...document.querySelectorAll("[data-rai]")].filter((c) => c.checked).map((c) => c.dataset.rai);
  // AIの回答は、AI分析の章を選んでいなくても常に選べる（回答を選ぶと AI分析の章にもチェックが入る）
  const drawAiPick = () => {
    const box = $("#raiPick");
    const ms = spanMonths(m, span), on = chosen().includes("ai"), was = new Set(aiChosen());
    const pick = (x) => (was.size || !on ? was.has(x.id) : ms.includes(x.month));
    box.innerHTML = notesAll.length ? `<b>🤖 PDFに入れるAIの回答</b><span class="muted">（新しい順・保存した${notesAll.length}件。選ぶと「AI分析の結果」の章に入ります）</span><div class="secpick ai-notepick">${notesAll.map((x) => `<label><input type="checkbox" data-rai="${esc(x.id)}"${pick(x) ? " checked" : ""}>
        ${x.kind === "overview" ? '<span class="badge">概況（最初の章）</span> ' : ""}${esc(x.periodLabel || fmtMonth(x.month))}「${esc(x.title)}」<span class="muted">（${esc(x.scope || "")}・${esc(new Date(x.at).toLocaleDateString("ja-JP"))}）</span></label>`).join("")}</div>`
      : '<b>🤖 PDFに入れるAIの回答</b> <span class="muted keep">保存したAIの回答はまだありません（AI分析タブの「③ AIの回答を保存する」で保存すると、ここで選べます）</span>';
    box.querySelectorAll("[data-rai]").forEach((c) => (c.onchange = () => {
      const nt = notesAll.find((x) => x.id === c.dataset.rai), sec = document.querySelector(`[data-rsec="${nt && nt.kind === "overview" ? "aisum" : "ai"}"]`);
      if (c.checked && sec && !sec.checked) { sec.checked = true; savePref("reportSecs", chosen()); }
    }));
  };
  // 公館別サマリーの行数（はじめは5行。選んだ行数は覚える）
  let sumLines = pdfSumLines(loadPrefs().reportSumLines);
  const markSum = () => document.querySelectorAll("[data-rsum]").forEach((b) => b.classList.toggle("on", Number(b.dataset.rsum) === sumLines));
  document.querySelectorAll("[data-rsum]").forEach((b) => (b.onclick = () => { sumLines = Number(b.dataset.rsum); savePref("reportSumLines", sumLines); markSum(); }));
  markSum();
  const showStatPick = () => { $("#rstatPick").hidden = !chosen().includes("stats"); $("#rsumPick").hidden = !chosen().includes("summary"); drawStatNotePick(); drawAiPick(); };
  document.querySelectorAll("[data-rstat]").forEach((c) => (c.onchange = () => savePref("reportStats2", statsChosen())));
  $("#rstatAll").onclick = () => { document.querySelectorAll("[data-rstat]").forEach((c) => (c.checked = true)); savePref("reportStats2", statsChosen()); };
  $("#rstatNone").onclick = () => { document.querySelectorAll("[data-rstat]").forEach((c) => (c.checked = false)); savePref("reportStats2", statsChosen()); };
  document.querySelectorAll("[data-rsec]").forEach((c) => (c.onchange = () => { savePref("reportSecs", chosen()); showStatPick(); }));
  $("#secAll").onclick = () => { document.querySelectorAll("[data-rsec]").forEach((c) => (c.checked = true)); savePref("reportSecs", chosen()); showStatPick(); };
  $("#secNone").onclick = () => { document.querySelectorAll("[data-rsec]").forEach((c) => (c.checked = false)); savePref("reportSecs", chosen()); showStatPick(); };
  showStatPick();
  // 分析の目的：選んだ目的に要る章と統計にチェックを入れる（目的を外したら、残りの目的の分だけにする）
  const applyPurposes = () => {
    const ps = REPORT_PURPOSES.filter((x) => document.querySelector(`[data-rpur="${x.k}"]`).checked);
    savePref("reportPurposes", ps.map((x) => x.k));
    // 目的を全部外したら、項目・統計・AIの回答の選択もすべて外す（ここから選び直す）
    if (!ps.length) {
      document.querySelectorAll("[data-rsec], [data-rstat], [data-rai], [data-rsn]").forEach((c) => (c.checked = false));
      savePref("reportSecs", chosen()); savePref("reportStats2", statsChosen());
      $("#rpurNote").textContent = ""; $("#rpurNote").hidden = true; showStatPick(); return;
    }
    $("#rpurNote").hidden = false;
    const secs = new Set(ps.flatMap((x) => x.secs)), stats = new Set(ps.flatMap((x) => x.stats || STAT_ITEMS.map((y) => y[0])));
    if (ps.some((x) => x.k === "stats")) stats.add("infer");
    document.querySelectorAll("[data-rsec]").forEach((c) => (c.checked = secs.has(c.dataset.rsec)));
    document.querySelectorAll("[data-rstat]").forEach((c) => (c.checked = stats.has(c.dataset.rstat)));
    savePref("reportSecs", chosen()); savePref("reportStats2", statsChosen());
    const sl = ps.map((x) => x.sumLines).find(Boolean);
    if (sl && secs.has("summary")) { sumLines = sl; savePref("reportSumLines", sumLines); markSum(); }
    // 時系列の傾向は1年以上の期間で見る
    const need = Math.max(0, ...ps.map((x) => x.minSpan || 0));
    let note = `「${ps.map((x) => x.t.replace(/^\S+\s/, "")).join("」「")}」に合わせて、PDFの項目を${secs.size}個${stats.size && secs.has("stats") ? `、統計を${stats.size}個` : ""}選びました。`;
    if (need && mode === "recent" && span && span < need) { recentSpan = need; savePref("reportSpan", recentSpan); periodChanged(); note += `傾向を見るため、期間を「直近${need}か月」にしました。`; }
    // 統合サマリーだけのときは、1か月（月報のある最新の月）で作る
    else if (!need && ps.every((x) => x.oneMonth) && mode === "recent" && span !== 1) { recentSpan = 1; savePref("reportSpan", 1); periodChanged(); note += "統合サマリーは月ごとのまとめなので、期間を「直近1か月」にしました。"; }
    $("#rpurNote").textContent = note;
    showStatPick();
  };
  document.querySelectorAll("[data-rpur]").forEach((c) => (c.onchange = applyPurposes));
  $("#rpriv").onchange = () => savePref("reportPrivMental", $("#rpriv").checked);
  const mkJob = (fmt) => {
    if (!chosen().length) { toast("レポートにする項目を1つ以上選んでください"); return; }
    if (!hasData()) { toast("選んだ期間・地域・国の月報がありません"); return; }
    if (chosen().includes("stats") && !statsChosen().length) { toast("統計分析に入れる統計を1つ以上選んでください（または統計分析の章を外す）"); return; }
    const q = new URLSearchParams({ pdfjob: "1", m, secs: chosen().join(","), span: String(span), regs: regs.join(","), posts: rposts.join(","), stats: statsChosen().join(","), ains: aiChosen().join(","), sns: statNotesChosen().join(","), sl: String(sumLines), pm: $("#rpriv").checked ? "1" : "0" });
    if (fmt === "docx") q.set("fmt", "docx");
    if (demoMode) q.set("demo", "1");
    // 同じサイトのタブとして開く（同意の状態を引き継ぐため noopener は付けない）
    const w = window.open(`${location.pathname}?${q}`, "_blank");
    // 選んだ章のうち、期間・範囲に報告がないもの（緊急移送・邦人援護）は、作る前に知らせる
    const inR = inReportScope(regs, rposts), mmList = spanMonths(m, span);
    const none = [["evac", "緊急移送"], ["hogo", "邦人援護"]].filter(([k]) => chosen().includes(k) && !mmList.some((mm) => casesOf(mm, k).some((c) => inR(c.post)))).map(([, t]) => t);
    const noneMsg = none.length ? `（この期間・範囲には${none.join("・")}の報告がないため、その章は入りません。全体概況に「報告はなかった」と書きます）` : "";
    if (w) { $("#wst").textContent = `別のタブで${fmt === "docx" ? "Word" : "PDF"}を作成しています` + noneMsg; return; }
    // ポップアップが止められたときは、このタブで作成する
    $("#wst").textContent = "新しいタブを開けなかったので、このタブで作成します…";
    makeHere(fmt);
  };
  $("#mk").onclick = () => mkJob("pdf");
  $("#mkWord").onclick = () => mkJob("docx");
  const makeHere = async (fmt) => {
    $("#mk").disabled = true; $("#wst").textContent = "作成中…";
    pdfCancel = false; $("#mkStop").hidden = false; $("#mkStop").disabled = false;
    $("#mkStop").onclick = () => { pdfCancel = true; $("#mkStop").disabled = true; $("#wst").textContent = "中止しています…"; };
    try {
      const ropt = { span, regions: regs, posts: rposts, stats: statsChosen(), aiNotes: aiChosen(), statNotes: statNotesChosen(), sumLines, privMental: $("#rpriv").checked };
      if (fmt === "docx") {
        const doc = await buildReportDocx(m, new Set(chosen()), (s) => ($("#wst").textContent = s), ropt);
        const saved = await savePdfAs(doc, reportFileName(m, span, regs, rposts, chosen()).replace(/\.pdf$/, ".docx"));
        $("#wst").textContent = saved ? `「${saved}」を保存しました。医務官のみがアクセスできるフォルダに保存してください` : "保存を取りやめました";
        return;
      }
      const blob = await buildReportPdf(m, new Set(chosen()), (s) => ($("#wst").textContent = s), ropt);
      await pdfStoreAdd(blob, reportFileName(m, span, regs, rposts, chosen()), `${reportLabel(m, span)}${regs.length || rposts.length ? "・" + regionsLabel(regs, rposts) : ""}`);
      renderPdfStore();
      const saved = await savePdfAs(blob, reportFileName(m, span, regs, rposts, chosen()));
      $("#wst").textContent = saved ? `「${saved}」を保存しました（${(blob.size / 1048576).toFixed(1)} MB）。医務官のみがアクセスできるフォルダに保存してください` : "保存を取りやめました";
    } catch (e) {
      if (e.cancelled) { $("#wst").textContent = "作成を中止しました"; return; }
      console.error(e);
      $("#wst").textContent = "作成に失敗しました: " + e.message;
    } finally { $("#mk").disabled = false; if ($("#mkStop")) $("#mkStop").hidden = true; }
  };
}

// PDFを保存する：保存の画面（ファイル名を入れた状態。保存する場所も選べる）を出す。使えないブラウザでは、そのファイル名でダウンロード
async function savePdfAs(blob, fname) {
  if (window.showSaveFilePicker) {
    try {
      const zip = /\.zip$/i.test(fname), docx = /\.docx$/i.test(fname);
      const h = await window.showSaveFilePicker({ suggestedName: fname, id: "geppou-report", types: [zip ? { description: "ZIP", accept: { "application/zip": [".zip"] } } : docx ? { description: "Word 文書", accept: { "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"] } } : { description: "PDF", accept: { "application/pdf": [".pdf"] } }] });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      return h.name;
    } catch (e) { if (e && e.name === "AbortError") return null; console.warn("save picker", e); }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = fname; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return fname;
}
// PDFをファイル名の入ったアドレスで表示する（サービスワーカーが返す）。ビューアの保存ボタンでもこのファイル名になる。使えないときは null
const PDFVIEW_CACHE = "geppou-pdfview";
// ---- 作成したPDF（パスワード付き）を、このブラウザに新しい順に20件まで保存しておく（デモ表示中は保存しない）
const PDF_KEEP = 20;
async function pdfStoreList() { try { return (await idb.get("pdfIndex")) || []; } catch { return []; } }
async function pdfStoreAdd(blob, name, label) {
  if (demoMode || !blob) return;
  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const list = [{ id, name, label: label || "", at: Date.now(), size: blob.size }, ...(await pdfStoreList())];
    const drop = list.slice(PDF_KEEP).map((x) => "pdf:" + x.id);
    await idb.batch([["pdf:" + id, new Blob([await blob.arrayBuffer()], { type: "application/pdf" })], ["pdfIndex", list.slice(0, PDF_KEEP)]], drop);
  } catch (e) { try { logError("PDFの保存（ブラウザ内）", String((e && e.message) || e)); } catch {} }
}
// 別のタブでPDFを作り終えたあと、このタブに戻ったら一覧を新しくする
window.addEventListener("focus", () => { if (typeof page !== "undefined" && page === "report") renderPdfStore(); });
async function pdfStoreGet(id) { return idb.get("pdf:" + id); }
async function pdfStoreDel(ids) {
  const list = await pdfStoreList();
  await idb.batch([["pdfIndex", list.filter((x) => !ids.includes(x.id))]], ids.map((id) => "pdf:" + id));
}
// PDFレポートのタブ：保存したPDFの一覧（開く・保存・削除）
async function renderPdfStore() {
  const box = $("#pdfStore");
  if (!box) return;
  const list = await pdfStoreList();
  box.innerHTML = list.length ? `<div class="table-wrap pdfstore"><table><thead><tr><th>作成日時</th><th>ファイル名</th><th class="num">大きさ</th><th></th></tr></thead><tbody>${list.map((x) => `<tr>
      <td>${esc(fmtDateTime(x.at))}</td><td>${esc(x.name)}${x.label ? `<div class="muted">${esc(x.label)}</div>` : ""}</td><td class="num">${(x.size / 1048576).toFixed(1)} MB</td>
      <td class="row" style="margin:0;flex-wrap:nowrap"><button data-pdfopen="${x.id}">開く</button><button data-pdfsave="${x.id}">💾 保存</button><button class="linklike" data-pdfdel="${x.id}">削除</button></td></tr>`).join("")}</tbody></table></div>`
    : '<p class="muted" style="margin:0">まだありません。PDFを作成すると、ここに新しい順に20件まで残ります。</p>';
  const item = (id) => list.find((x) => x.id === id);
  box.querySelectorAll("[data-pdfopen]").forEach((b) => (b.onclick = async () => {
    const x = item(b.dataset.pdfopen), blob = await pdfStoreGet(x.id);
    if (!blob) { toast("このPDFはもう残っていません"); return; }
    const url = (await namedPdfUrl(blob, x.name)) || URL.createObjectURL(blob);
    window.open(url, "_blank");
  }));
  box.querySelectorAll("[data-pdfsave]").forEach((b) => (b.onclick = async () => {
    const x = item(b.dataset.pdfsave), blob = await pdfStoreGet(x.id);
    if (!blob) { toast("このPDFはもう残っていません"); return; }
    const n = await savePdfAs(blob, x.name);
    if (n) toast(`「${n}」を保存しました。医務官のみがアクセスできるフォルダに保存してください`);
  }));
  box.querySelectorAll("[data-pdfdel]").forEach((b) => (b.onclick = async () => {
    if (!confirm("このPDFを、このブラウザから削除しますか？（保存したファイルは消えません）")) return;
    await pdfStoreDel([b.dataset.pdfdel]); renderPdfStore();
  }));
}
async function namedPdfUrl(blob, fname) {
  if (!("caches" in window) || !navigator.serviceWorker || !navigator.serviceWorker.controller) return null;
  try {
    const url = new URL(`pdfview/${Date.now().toString(36)}/${encodeURIComponent(fname)}`, location.href).href;
    const c = await caches.open(PDFVIEW_CACHE);
    // 半日より前に作ったものは消す（ほかのタブで表示中の新しいものは残す）
    for (const k of await c.keys()) { const r = await c.match(k); if (!r || Date.now() - Number(r.headers.get("x-created") || 0) > 12 * 3600e3) await c.delete(k); }
    await c.put(url, new Response(blob, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(fname)}`, "x-created": String(Date.now()) } }));
    window.addEventListener("pagehide", () => { caches.open(PDFVIEW_CACHE).then((x) => x.delete(url)); });
    return url;
  } catch (e) { console.warn("pdfview", e); return null; }
}
// ファイル名は中身がひと目で分かるように：医務官月報_（内容）_（期間）_（地域・公館）.pdf
// 内容：選んだ項目が「分析の目的」と同じならその名前、そうでなければ主な項目（3つまで。多いときは「統合レポート」）
const RPUR_SHORT = { exec: "幹部報告", trend: "時系列の傾向", infect: "感染症の流行監視", region: "地域比較", workload: "業務量・体制",
  hogo: "緊急移送・邦人援護", quality: "提出・記載状況", epi: "疫学・公衆衛生", occ: "産業保健", special: "専門科の内訳", stats: "統計分析", ai: "AI分析" };
const RSEC_SHORT = { visits: "受診者数", diseases: "疾病分類", stats: "統計分析", ai: "AI分析", junkai: "巡回健診・異動", evac: "緊急移送症例",
  hogo: "邦人援護", submit: "提出・記載状況", summary: "公館別サマリー", map: "疾病地図", overview: "全体概況", aisum: "AI概況" };
function reportContentName(secs) {
  if (!secs) return "統合レポート";
  const ks = secsCompat(secs), all = REPORT_SECTIONS.map((x) => x[0]).filter((k) => k !== "feedback");
  if (!ks.length || all.every((k) => ks.includes(k))) return "統合レポート";
  const set = new Set(ks), pur = REPORT_PURPOSES.find((x) => RPUR_SHORT[x.k] && x.secs.length === set.size && x.secs.every((k) => set.has(k)));
  if (pur) return RPUR_SHORT[pur.k];
  if (set.has("evac") && set.has("hogo")) { set.delete("evac"); set.delete("hogo"); set.add("evhogo"); }
  // 全体概況・地図・AI概況は添え物なので、ほかの項目があるときは名前に入れない
  let main = [...set].filter((k) => !["overview", "map", "aisum"].includes(k));
  if (!main.length) main = [...set];
  if (main.length > 3) return "統合レポート";
  const order = ["visits", "diseases", "stats", "evhogo", "evac", "hogo", "junkai", "submit", "summary", "ai", "map", "overview", "aisum"];
  return main.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((k) => (k === "evhogo" ? "緊急移送・邦人援護" : RSEC_SHORT[k] || k)).join("・");
}
function reportPeriodName(m, span) {
  const [y, mo] = m.split("-").map(Number);
  if (span === 0) return `全期間（${y}年${mo}月まで）`;
  if (span <= 1) return `${y}年${mo}月`;
  let s = m;
  for (let i = 1; i < span; i++) s = prevMonth(s);
  const [sy, smo] = s.split("-").map(Number);
  return sy === y ? `${y}年${smo}〜${mo}月` : `${sy}年${smo}月〜${y}年${mo}月`;
}
const reportFileName = (m, span = 1, regs = [], posts = [], secs = null) => {
  const all = [...regs, ...posts], who = all.length > 3 ? `${all.slice(0, 3).join("・")}ほか${all.length - 3}` : all.join("・");
  if (secs && [...secs].length === 1 && [...secs][0] === "feedback") return allFeedbackFileName(m).replace(/\.pdf$/, `${who ? "_" + who : ""}.pdf`);
  return `医務官月報_${reportContentName(secs ? [...secs] : null)}_${reportPeriodName(m, span)}${who ? "_" + who : "_全世界"}.pdf`.replace(/[\\/:*?"<>|]/g, "");
};
// 横軸が「2025年9月」のような月のときの目盛り：横書きで短く（「9月」。最初の月と1月だけ「2025年<br>9月」）、多いときは間引く
function monthTickAxis(xs) {
  const re = /^(\d{4})年(\d{1,2})月$/;
  if (!xs.length || !xs.every((x) => re.test(String(x)))) return null;
  const step = Math.max(1, Math.ceil(xs.length / 18));
  const show = xs.filter((x, i) => i % step === 0 || i === xs.length - 1);
  return { type: "category", tickangle: 0, automargin: true, tickvals: show,
    ticktext: show.map((x, i) => { const [, y, mo] = String(x).match(re); return i === 0 || mo === "1" || (step > 1 && Number(mo) <= step) ? `${y}年<br>${mo}月` : `${mo}月`; }) };
}
async function figUrl(traces, layout, width, height, config = {}) {
  // 月の横軸は、目盛りの文字が切れないように整える（PDFレポートの推移のグラフ）
  const xs = (traces[0] && traces[0].x) || [];
  const mt = monthTickAxis(xs);
  if (mt) {
    layout = Object.assign({}, layout, { xaxis: Object.assign({}, mt, layout.xaxis || {}) });
    if (layout.margin && layout.margin.b < 60) layout.margin = Object.assign({}, layout.margin, { b: 60 });
  }
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
      rows.map((r, i) => r && r.full !== undefined ? `<tr class="rp-full"><td colspan="${head.length}">${esc(r.full)}</td></tr>` : `<tr${bold.has(i) ? ' class="b"' : ""}>${r.map((v) => `<td${typeof v === "number" || /^[+\-]?\d+(\.\d+)?$/.test(String(v ?? "")) ? ' class="num"' : ""}>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody>`);
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
      // このページに何行入るかを数える。数行だけが次のページに残る（または数行しか入らない）ときは、
      // 表を切らずに次のページから始める（1ページに収まる表に限る。白紙に近いページを作らない）
      let k = 0;
      for (const r of rows) { b.tBodies[0].appendChild(r); if (!fits()) { b.tBodies[0].removeChild(r); break; } k++; }
      b.tBodies[0].innerHTML = "";
      if ((rows.length - k <= 5 || k <= 3) && body.children.length > 1) {
        const test = b.cloneNode(true); rows.forEach((r) => test.tBodies[0].appendChild(r.cloneNode(true)));
        body.removeChild(b);
        const carry = carryHeadings();
        turn([...carry, test]);
        if (fits()) { body.removeChild(test); rows.forEach((r) => b.tBodies[0].appendChild(r)); body.appendChild(b); continue; }
        // 1ページにも入らない長い表：見出しを戻し、前のページから切って続ける
        body.removeChild(test); pages.pop().remove();
        body = pages[pages.length - 1].querySelector(".rp-body");
        for (const c of carry) body.appendChild(c);
        body.appendChild(b);
      }
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

// PDFの作成を途中でやめる（「■ 作成を中止」）。ページを1枚画像にするごとに確かめる
let pdfCancel = false;
const checkPdfCancel = () => { if (pdfCancel) { const e = new Error("作成を中止しました"); e.cancelled = true; throw e; } };
// PDFレポートの大きさの上限（メールやフォルダに置きやすいよう 10MB 未満に収める）
const PDF_MAX_BYTES = 10 * 1048576;
// 1ページの画像の作り方の候補（きれいな順。上から順に試し、そのページの持ち分に収まった最初のものを使う）
const PAGE_ENCODINGS = [[1, 0.85], [1, 0.75], [1, 0.65], [0.75, 0.8], [0.75, 0.65], [0.625, 0.65], [0.5, 0.6], [0.5, 0.45]];
const canvasJpeg = async (cv, f, q) => {
  let c = cv;
  if (f < 1) {
    c = document.createElement("canvas");
    c.width = Math.round(cv.width * f); c.height = Math.round(cv.height * f);
    const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cv, 0, 0, c.width, c.height);
  }
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", q));
  const r = { jpeg: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height };
  if (c !== cv) c.width = c.height = 0;
  return r;
};
// budget：全ページの画像に使える合計バイト数。まだ作っていないページで残りを等分し、持ち分を超えるページだけ画質・解像度を下げる
async function renderPages(pages, host, progress, budget = Infinity, start = 0) {
  const out = [], S = 2;
  let left = budget;
  // 画像にするページだけを別の入れ物に移してから写す（全ページが入ったままだと、1ページごとに全体を複製するので遅い）
  const solo = rp.el("div", "rp-host");
  document.body.appendChild(solo);
  try {
  for (let i = 0; i < pages.length; i++) {
    checkPdfCancel();
    progress && progress(`ページを画像にしています… ${i + 1} / ${pages.length}`);
    const pg = pages[i], back = pg.nextSibling, parent = pg.parentNode;
    solo.appendChild(pg);
    let cv;
    try {
      cv = await html2canvas(pg, {
        scale: S, backgroundColor: "#ffffff", logging: false, useCORS: false,
        ignoreElements: (el) => el.parentElement === document.body && el !== solo,
      });
    } finally { parent.insertBefore(pg, back); }
    const share = left / (pages.length - i);
    let img = null;
    for (let k = start; k < PAGE_ENCODINGS.length; k++) {
      img = await canvasJpeg(cv, ...PAGE_ENCODINGS[k]);
      if (img.jpeg.length <= share) break;
    }
    left -= img.jpeg.length;
    out.push(img);
    cv.width = cv.height = 0;
  }
  } finally { solo.remove(); }
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

async function withSplitRegions(fn) {
  const keepRegs = REGIONS.slice(), touched = [];
  SPLIT_VIEW++;
  REGIONS.splice(0, REGIONS.length, "アフリカ", "アジア", "大洋州", "ヨーロッパ", "中東", "北米", "中南米");
  for (const r of Object.values(state.reports)) { const g = regionOf(r.post); if (r.region !== g) { touched.push([r, r.region]); r.region = g; } }
  // いまは地域をいつも7つで扱うので、ふつうは直すものがない（そのときは作り置きを捨てない）
  if (touched.length) clearCaches();
  try { return await fn(); } finally {
    SPLIT_VIEW--; REGIONS.splice(0, REGIONS.length, ...keepRegs);
    for (const [r, g] of touched) r.region = g;
    if (touched.length) clearCaches();
  }
}
// レポートのブロック（見出し・文・表・図）を作る（PDF と Word で共通）
async function reportBlocksFor(m, sections, progress, opt = {}) {
  const span = opt.span ?? 1, regs = opt.regions || [], posts = opt.posts || [], scoped = regs.length + posts.length > 0;
  progress && progress("グラフを作成しています…");
  checkPdfCancel();
  const head = { label: reportLabel(m, span), scope: regionsLabel(regs, posts), stats: opt.stats, aiNotes: opt.aiNotes || [], statNotes: opt.statNotes || null, sumLines: pdfSumLines(opt.sumLines) };
  PRIV_MENTAL = opt.privMental !== false;
  let blocks;
  try { blocks = await withRegions(regs, () => withSplitRegions(() => (span !== 1 ? periodBlocks(m, span, sections, head) : reportBlocks(m, sections, head))), posts); }
  finally { PRIV_MENTAL = false; }
  const name = sections.size === 1 && sections.has("feedback") ? "全医務官あて 統合サマリー" : "医務官月報 統合レポート";
  return { blocks, header: `${name}　${head.label}${scoped ? "・" + head.scope : ""}`, title: `${name} ${head.label}${scoped ? "・" + head.scope : ""}（${WATERMARK}）` };
}
async function buildReportPdf(m, sections, progress, opt = {}) {
  const { blocks, header, title } = await reportBlocksFor(m, sections, progress, opt);
  return pdfFromBlocks(blocks, header, title, progress, opt);
}
// Word（.docx）：PDF と同じ内容を、見出し・表・図のある Word 文書にする（パスワードなし）
async function buildReportDocx(m, sections, progress, opt = {}) {
  const { blocks, header, title } = await reportBlocksFor(m, sections, progress, opt);
  progress && progress("Word にまとめています…");
  // 図の大きさを読めるよう、いったん画面の外に置く
  const host = rp.el("div", "rp-host");
  document.body.appendChild(host);
  try {
    for (const b of blocks) if (b && b.nodeType === 1) host.appendChild(b);
    await Promise.all([...host.querySelectorAll("img")].map((i) => i.decode().catch(() => {})));
    return await DocxReport.buildDocx(blocks, { title, header, footer: WATERMARK });
  } finally { host.remove(); }
}
// ブロック（見出し・文・表・図）から、ページに割り付け・画像にして、パスワード付きPDFを作る（統合レポート・医務官あての月次サマリーで共通）
async function pdfFromBlocks(blocks, header, title, progress, opt = {}) {
  const host = rp.el("div", "rp-host");
  document.body.appendChild(host);
  try {
    await document.fonts.ready;
    const pages = paginate(blocks, host, header);
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
    // 10MB 未満に収める：透かしの層・目次などの分（ページ数に応じた余裕）を引いた残りをページの画像に割り当てる
    const overlay = printOverlay(), limit = opt.maxBytes || PDF_MAX_BYTES;
    // レポートのPDFはパスワードなし（印刷時の透かしは入れる）
    const make = (imgs) => SecurePdf.buildPdf(imgs, { title, links, outlines, overlay });
    let budget = limit * 0.97 - 400 * 1024 - pages.length * 4096, start = 0, blob = null, imgs = [];
    for (let tries = 0; tries < 3; tries++) {
      checkPdfCancel();
      imgs = await renderPages(pages, host, tries ? (s) => progress && progress(s.replace("画像にしています", "10MB に収まるよう画質を下げて作り直しています")) : progress, budget, start);
      checkPdfCancel();
      progress && progress("暗号化しています…");
      blob = await make(imgs);
      if (blob.size < limit) break;
      // まだ大きいとき（ほとんどない）：超えた分だけ持ち分を減らし、きれいすぎる候補を飛ばして作り直す
      budget -= blob.size - limit + 256 * 1024; start = Math.min(start + 2, PAGE_ENCODINGS.length - 1);
    }
    // 作ったばかりのレポートを、パスワードなしでその場で確かめられるよう、ページの画像・目次のリンク・しおりも渡す（保存するファイルはパスワード付き）
    blob.preview = { pages: imgs, links, outlines };
    return blob;
  } finally { host.remove(); }
}

// ---- レポートの形式：期間（1・3・6・12か月）と地域（分析の地域。北米と中南米は別）
// span = 0 は全期間（月報のある最初の月から m まで）
const REPORT_SPANS = [[1, "1か月"], [3, "3か月"], [6, "6か月（半年）"], [12, "12か月（1年）"], [36, "36か月（3年）"], [60, "60か月（5年）"], [0, "全期間"]];
// 終わりの月 m から前に span か月（古い順）
function spanMonths(m, span) {
  if (span === 0) {
    // 地域・国で絞っている間（withRegions）も、全期間はすべての月報の最初の月から数える
    const first = [...new Set(Object.values(scopedAllReports || state.reports).map((r) => r.month))].filter((x) => x && x <= m).sort()[0] || m;
    const out = [m];
    while (out[0] > first) out.unshift(prevMonth(out[0]));
    return out;
  }
  const out = [m]; while (out.length < span) out.unshift(prevMonth(out[0])); return out;
}
// from〜to の月数（両端を含む）
const monthsBetween = (from, to) => { const [y1, m1] = from.split("-").map(Number), [y2, m2] = to.split("-").map(Number); return Math.max(1, (y2 * 12 + m2) - (y1 * 12 + m1) + 1); };
function reportLabel(m, span = 1) {
  if (span === 1) return `${fmtMonth(m)}分`;
  const ms = spanMonths(m, span);
  return span === 0 ? `全期間（${fmtMonth(ms[0])}〜${fmtMonth(m)}・${ms.length}か月）` : `${fmtMonth(ms[0])}〜${fmtMonth(m)}（${span}か月）`;
}
// 対象の表示（地域と個別に選んだ国。どちらもなければ全世界）
const regionsLabel = (regs = [], posts = []) => {
  const all = [...(regs || []), ...(posts || [])];
  return !all.length ? "全世界" : all.length > 6 ? `${all.slice(0, 6).join("・")} ほか${all.length - 6}` : all.join("・");
};
const inReportScope = (regs = [], posts = []) => (post) => (!regs.length && !posts.length) || regs.includes(aiRegionOf(post)) || posts.includes(post);
// 地域を選んだときは、その地域の公館のデータだけが見えるようにしてレポートを作る（作り終えたら元に戻す。保存はしない）
let scopedAllReports = null;   // 絞る前のすべての月報（全期間の始まりの月を決めるため）
async function withRegions(regs, fn, posts = []) {
  regs = regs || [];
  if (!regs.length && !posts.length) return fn();
  const keep = { reports: state.reports, rosters: state.rosters, junkai: state.junkai, cases: state.cases };
  const keepAll = scopedAllReports, keepCache = snapCaches();
  scopedAllReports = scopedAllReports || keep.reports;
  const inR = inReportScope(regs, posts);
  state.reports = Object.fromEntries(Object.entries(keep.reports).filter(([, r]) => inR(r.post)));
  state.rosters = Object.fromEntries(Object.entries(keep.rosters).map(([mm, rows]) => { const o = rows.filter((x) => inR(x.post)); o.sheetMonth = rows.sheetMonth; return [mm, o]; }));
  state.junkai = Object.fromEntries(Object.entries(keep.junkai).map(([mm, js]) => [mm, js.filter((j) => inR(j.src || j.from))]));
  state.cases = Object.fromEntries(Object.entries(keep.cases || {}).map(([mm, cs]) => [mm, cs.filter((c) => inR(c.post))]));
  clearCaches();
  scopedView++;
  try { return await fn(); } finally {
    Object.assign(state, keep); scopedAllReports = keepAll; scopedView--;
    // データを書き換えていなければ、絞る前の作り置きに戻す（書き換えたときは捨てて作り直す）
    if (saveAfterScope) clearCaches(); else { clearCaches(); restoreCaches(keepCache); }
    if (!scopedView && saveAfterScope) { saveAfterScope = false; await saveState(); }
  }
}

// PDFにする章（選んだものだけを、この順で番号を振って入れる）
// ---- AI分析の結果（AI分析タブで保存した回答）をレポートの文に変える。見出し・箇条書き・表（| 区切り）を読み分ける
function aiNoteBlocks(note) {
  const { H, P, LI, TABLE } = rp;
  const out = [H(`${note.title}（${note.periodLabel || fmtMonth(note.month)}・${note.scope || "全世界"}）`, 2),
    P(`MOFA GaiXer／政府AI源内による分析の回答（${new Date(note.at).toLocaleDateString("ja-JP")} 保存）。AIの回答のため、内容と数値は医務官が確認のうえ利用すること。`, "rp-note")];
  const clean = (t) => t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`/g, "").trim();
  let table = null;
  const flush = () => {
    if (!table) return;
    const rows = table.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c.trim())));
    if (rows.length > 1) out.push(TABLE(rows[0].map(clean), rows.slice(1).map((r) => r.map(clean))));
    else if (rows.length) out.push(P(rows[0].map(clean).join("　")));
    table = null;
  };
  for (const raw of note.text.split("\n")) {
    const l = raw.trim();
    // 冒頭の取扱注意の文（AIへの指示で出させたもの）は載せない
    if (!l || /専用です。それ以外のサービスに入力した場合/.test(l)) { flush(); continue; }
    if (/^\|.*\|$/.test(l)) { (table ||= []).push(l.slice(1, -1).split("|")); continue; }
    flush();
    const h = l.match(/^#{1,6}\s*(.+)$/);
    if (h) { out.push(H(clean(h[1]), 3)); continue; }
    const li = l.match(/^(?:[-*・●]|\d{1,2}[.)．、])\s*(.+)$/);
    if (li) { out.push(LI(clean(li[1]))); continue; }
    out.push(P(clean(l)));
  }
  flush();
  return out;
}
// レポートの「統計分析」の章に入れる統計（チェックで選ぶ）
const STAT_ITEMS = [["desc", "記述統計（1公館1か月あたりの受診者数・地域別）"], ["box", "受診者数のばらつき（箱ひげ図・地域別）"],
  ["share", "構成比（受診者区分・疾病分類の地域別の割合）"], ["heatcat", "疾病分類×地域（ヒートマップ）"], ["heatdis", "病名の上位×月（ヒートマップ）"],
  ["trend", "月ごとの傾向（回帰による増減）"], ["excess", "いつもより多い病名（例年・前の期間と比べた増え方）"], ["infect", "主な感染症の月ごとの推移"],
  ["yoy", "前年同月との比較（季節の波）"], ["posts", "公館別の受診者数（業務量の多い公館）"], ["change", "前の期間と比べて増えた・減った公館"],
  ["watch", "注目する疾患群の推移（輸入・熱帯感染症・ワクチンで防げる感染症・生活習慣病・こころ・外傷）"], ["spread", "感染症の地理的な広がり（報告した公館数・地域）"],
  ["rate", "受診率（在籍人数あたり）"], ["occ", "産業保健の指標（職員の受診・生活習慣病・こころ・外傷・健診）"],
  ["subcat", "疾病分類の中の内訳（皮膚・外傷・感染症・呼吸器・こころ）"], ["zcat", "予防接種・健診の内訳"],
  ["infer", "保存した検定・推定の結果（統計タブで保存したもの）"]];
// ---- 疫学・公衆衛生・産業保健の分析で使う病名のまとまり（病名に含まれる語で判定。1つの病名は最初に当てはまったものに入れる）
const MENTAL_CAT = "精神及び行動の障害", INJ_CAT = "損傷、中毒及びその他の外因の影響", SKIN_CAT = "皮膚及び皮下組織の疾患", RESP_CAT = "呼吸器系の疾患";
// 皮膚の感染症（白癬・とびひ・帯状疱疹など）は ICD-10 では感染症に入るが、皮膚科の視点では皮膚として見る
const SKIN_INF_RE = /白癬|水虫|癜風|膿痂疹|とびひ|帯状疱疹|単純疱疹|ヘルペス|疥癬|疣|いぼ|軟属腫|皮膚カンジダ|皮膚真菌|糸状菌|蜂巣炎|蜂窩織炎|皮膚幼虫移行|リーシュマニア|ハエ幼虫|トゥンガ/;
// 虫刺症（分類は外傷・中毒）も、皮膚科の見方では皮膚の内訳「虫・寄生虫」に入れる
const isSkin = (d) => d.c === SKIN_CAT || (d.c === INF_CAT && SKIN_INF_RE.test(d.n)) || (d.c === "損傷、中毒及びその他の外因の影響" && /虫刺|虫さされ|刺咬症/.test(d.n));
// 心血管・脳血管疾患（虚血性心疾患・心不全・不整脈・脳卒中・静脈血栓塞栓症・大動脈疾患）
const CVD_RE = /狭心症|心筋梗塞|虚血性心|心不全|心房細動|心房粗動|心室細動|頻拍|不整脈|脳梗塞|脳出血|脳内出血|くも膜下|脳卒中|一過性脳虚血|脳血管|深部静脈血栓|静脈血栓|肺塞栓|大動脈解離|大動脈瘤|心筋虚血|冠症候群|冠動脈|房室ブロック|脚ブロック|洞房ブロック|期外収縮|QT延長|ブルガダ|WPW|徐脈|洞不全|心筋症|弁膜症|弁狭窄|弁閉鎖不全|心内膜炎|心筋炎|閉塞性動脈硬化|末梢動脈|頸動脈狭窄|頚動脈狭窄|エコノミークラス/;
// こころの不調（精神・行動）は、対象の公館が MENTAL_MIN_POSTS 未満のときは数を示さない（少ない公館では受診した人が特定されうる）
const MENTAL_MIN_POSTS = 3;
const LIFESTYLE_RE = /高血圧|糖尿|脂質異常|高脂血|コレステロール|高尿酸|痛風|肥満|脂肪肝|メタボ/;
const WATCH_GROUPS = [
  ["蚊が媒介する感染症", (d) => d.c !== Z && !VACCINE_RE.test(d.n) && /デング|マラリア|チクングニア|ジカ|黄熱|日本脳炎|ウエストナイル|フィラリア/.test(d.n)],
  ["消化管・水系の感染症", (d) => d.c !== Z && !VACCINE_RE.test(d.n) && /胃腸炎|腸炎|腸管感染|下痢|赤痢|コレラ|腸チフス|パラチフス|アメーバ|ジアルジア|ランブル|食中毒|ノロ|ロタ|旅行者下痢|感染性胃腸炎|A型肝炎|E型肝炎/.test(d.n)],
  ["ワクチンで防げる感染症", (d) => d.c !== Z && !VACCINE_RE.test(d.n) && /麻疹|はしか|風疹|水痘|みずぼうそう|ムンプス|流行性耳下腺|おたふく|百日咳|インフルエンザ|新型コロナ|COVID|ジフテリア|破傷風|髄膜炎菌|B型肝炎|ポリオ/.test(d.n)],
  ["狂犬病（曝露・予防）", (d) => /狂犬病|動物咬|犬咬|咬傷/.test(d.n)],
  ["結核・性感染症", (d) => d.c !== Z && !VACCINE_RE.test(d.n) && /結核|梅毒|淋|クラミジア|HIV|性感染/.test(d.n)],
  ["生活習慣病", (d) => d.c !== Z && LIFESTYLE_RE.test(d.n)],
  ["心血管・脳血管疾患", (d) => d.c !== Z && CVD_RE.test(d.n)],
  ["こころの不調", (d) => d.c === MENTAL_CAT],
  ["外傷・中毒", (d) => d.c === INJ_CAT],
];
// 大分類の中の内訳（専門科の視点）
const SUBCATS = {
  [SKIN_CAT]: [["湿疹・皮膚炎", /湿疹|皮膚炎|アトピー|かぶれ|汗疹|あせも|脂漏/], ["皮膚の感染", /白癬|水虫|カンジダ|癜風|膿痂疹|とびひ|蜂巣炎|蜂窩織炎|せつ|癰|毛包炎|膿瘍|疣|いぼ|軟属腫|ヘルペス|帯状疱疹/],
    ["虫・寄生虫（熱帯の皮膚疾患を含む）", /虫刺|刺咬|疥癬|ハエ幼虫|蝿|幼虫移行|リーシュマニア|トゥンガ|スナノミ|シラミ|ダニ/], ["日光・熱・寒冷", /日光|日焼|光線|熱傷|凍瘡|しもやけ/],
    ["蕁麻疹・かゆみ", /蕁麻疹|じんま|痒/], ["ざ瘡・酒さ", /ざ瘡|にきび|酒さ|しゅさ/]],
  [INJ_CAT]: [["骨折", /骨折/], ["捻挫・打撲・脱臼", /捻挫|打撲|挫傷|脱臼/], ["創傷", /創|裂傷|切傷|擦過/], ["熱傷・凍傷", /熱傷|やけど|凍傷/], ["咬傷・刺傷（動物・虫）", /咬|刺/], ["中毒", /中毒|過量/], ["環境（熱中症・高山病など）", /熱中症|高山病|低体温|凍死|潜水|日射/]],
  [INF_CAT]: WATCH_GROUPS.slice(0, 5).map(([t, fn]) => [t, fn]).concat([["皮膚の感染症（白癬・とびひ・帯状疱疹など）", SKIN_INF_RE], ["ウイルス性の発疹・かぜ症状", /手足口|ヘルパンギーナ|伝染性紅斑|突発性発疹|アデノ|RS/]]),
  [RESP_CAT]: [["インフルエンザ・新型コロナ", /インフルエンザ|コロナ|COVID/], ["かぜ・上気道", /かぜ|感冒|鼻咽頭|咽頭|扁桃|喉頭|副鼻腔|上気道/], ["気管支・肺炎", /気管支|肺炎/], ["喘息・アレルギー", /喘息|アレルギー|花粉/]],
  [MENTAL_CAT]: [["睡眠の障害", /不眠|睡眠/], ["抑うつ", /うつ|抑鬱/], ["不安・パニック", /不安|パニック|恐怖/], ["適応障害・ストレス", /適応|ストレス/], ["アルコール・依存", /アルコール|依存|嗜癖/]],
};
// 元の病名の語で判定し、当たらなければ「まとめた病名」（上気道炎→かぜ、腸管感染症→胃腸炎・下痢症 など）でも判定する
const subcatOf = (cat, d) => {
  const hit = (dd) => { for (const [t, x] of SUBCATS[cat] || []) if (typeof x === "function" ? x(dd) : x.test(dd.n)) return t; return null; };
  return hit(d) || hit({ ...d, n: groupOf(d.n) }) || "その他";
};
// 在籍人数（受診率の分母）。設定タブで入れる：{ 公館: { staff, family } }
// 1公館に年月つきで複数入れられる（[{ from: "YYYY-MM", staff, family }]）。月ごとに、その月以前で最も新しい値（なければ最も古い値）を使う
const headcountList = (post) => { const v = (state.headcount || {})[post]; return !v ? [] : (Array.isArray(v) ? v : [{ from: "", ...v }]).slice().sort((a, b) => (a.from || "").localeCompare(b.from || "")); };
const headcountOf = (post, month = "") => { const l = headcountList(post); if (!l.length) return null; const ok = l.filter((h) => !h.from || !month || h.from <= month); return ok.length ? ok[ok.length - 1] : l[0]; };
// 統計分析の章の中身（ブロックの配列）。地域・国の絞り込みは呼び出し側（withRegions）で済んでいる
async function statsBlocks(m, span, items, noteIds = null) {
  const { H, P, IMG, IMGS, TABLE } = rp;
  const out = [], on = (k) => items.includes(k);
  const { facts, ms } = fsFacts({ span, regions: [], posts: [] }, m);
  if (!facts.length) return [P("対象の月報がありません")];
  const regs = [...AI_REGIONS, "未分類"].filter((g) => facts.some((f) => f.region === g));
  const tpl = { template: chartTemplate(true) };
  // 対象の公館の数（こころの不調を示してよいか）と、1公館だけのときの名前
  const postsIn = (fs) => new Set(fs.map((f) => f.post)).size;
  const mentalOk = (fs) => postsIn(fs) >= MENTAL_MIN_POSTS;
  const onePost = postsIn(facts) === 1 ? facts[0].post : "";
  const HIDDEN = "（公館が少ないため示さない）";
  // 地域の行（1公館だけのときは公館名の1行。地域が1つだけのときは「全体」の行を重ねない）
  const rowGroups = onePost ? [[onePost, facts]] : [...regs.map((g) => [g, facts.filter((f) => f.region === g)]), ...(regs.length > 1 ? [["全体", facts]] : [])];
  const rowHead = onePost ? "公館" : "地域";
  const heatImg = async (title, ylab, xlab, z, perRow, h) => {
    const zn = perRow ? z.map((row) => { const mx = Math.max(1, ...row); return row.map((v) => v / mx); }) : (() => { const mx = Math.max(1, ...z.flat()); return z.map((row) => row.map((v) => v / mx)); })();
    return IMG(await figUrl([{ type: "heatmap", x: xlab, y: ylab, z: zn, colorscale: HEAT_BR, zmin: 0, zmax: 1, xgap: 2, ygap: 2, showscale: false }],
      Object.assign({ title, yaxis: { autorange: "reversed", automargin: true }, margin: { l: 170, r: 20, t: 56, b: 70 },
        annotations: z.flatMap((row, i) => row.map((v, j) => ({ x: xlab[j], y: ylab[i], text: v ? String(v) : "", showarrow: false, font: { size: 11, color: zn[i][j] < 0.18 || zn[i][j] > 0.82 ? "#fff" : "#1c2430" } }))) }, tpl), 1000, h), 600);
  };
  const descRow = (l, d) => [l, String(d.n), f1(d.total), f1(d.mean), f1(d.sd), f1(d.min), f1(d.q1), f1(d.median), f1(d.q3), f1(d.max), d.mean ? Math.round(100 * d.cv) + "%" : "―"];

  if (on("desc")) {
    out.push(H("記述統計（1公館1か月あたりの受診者数）", 2));
    const rows = regs.map((g) => descRow(g, describe(facts.filter((f) => f.region === g).map((f) => f.total))));
    rows.push(descRow("全体", describe(facts.map((f) => f.total))));
    out.push(TABLE(["地域", "件数", "合計", "平均", "標準偏差", "最小", "第1四分位", "中央値", "第3四分位", "最大", "変動係数"], rows, { bold: new Set([rows.length - 1]), widths: [12, 7, 9, 8, 9, 7, 10, 9, 10, 8, 11] }));
    out.push(P("※件数は月報の数（1公館の1か月分を1件）。変動係数＝標準偏差÷平均（公館によるばらつきの大きさ）。", "rp-note"));
  }
  if (on("box")) {
    out.push(H("受診者数のばらつき（地域別）", 2));
    out.push(IMG(await figUrl(regs.map((g) => ({ type: "box", name: g, y: facts.filter((f) => f.region === g).map((f) => f.total), boxpoints: "all", jitter: 0.4, pointpos: 0,
      marker: { color: FS_REGION_COL[g] || "#888", size: 4, opacity: 0.6 } })), Object.assign({ title: "1公館1か月あたりの受診者数の分布", showlegend: false, yaxis: { title: { text: "名" } } }, tpl), 1000, 440), 600));
    out.push(P("※箱は中央の半分（第1〜第3四分位）、箱の中の線は中央値、点は各公館の各月の値。", "rp-note"));
  }
  if (on("share")) {
    out.push(H("構成比（地域別）", 2));
    const vrows = regs.map((g) => { const fs = facts.filter((f) => f.region === g), t = sum(fs, (f) => f.total); return [g, ...VISIT_KEYS.map(([k]) => (t ? (100 * sum(fs, (f) => f[k]) / t).toFixed(1) + "%" : "―")), String(t)]; });
    out.push(TABLE(["地域", ...VISIT_KEYS.map((v) => v[1]), "受診者数"], vrows));
    const catTot = {};
    for (const f of facts) for (const [c, v] of Object.entries(f.cats)) catTot[c] = (catTot[c] || 0) + v;
    const topC = Object.entries(catTot).sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0]);
    const crows = regs.map((g) => {
      const fs = facts.filter((f) => f.region === g), t = sum(fs, (f) => f.real);
      const pc = (v) => (t ? (100 * v / t).toFixed(1) + "%" : "―");
      return [g, ...topC.map((c) => pc(sum(fs, (f) => f.cats[c] || 0))), pc(t - sum(topC, (c) => sum(fs, (f) => f.cats[c] || 0))), String(t)];
    });
    out.push(TABLE(["地域", ...topC.map(shortCat), "その他", "実患件数"], crows));
  }
  if (on("heatcat")) {
    out.push(H("疾病分類×地域", 2));
    const catTot = {};
    for (const f of facts) for (const [c, v] of Object.entries(f.cats)) catTot[c] = (catTot[c] || 0) + v;
    const cs = Object.entries(catTot).sort((a, b) => b[1] - a[1]).slice(0, 10).map((x) => x[0]);
    out.push(await heatImg("疾病分類×地域の件数（色は分類ごとに最も多い地域を赤く）", cs.map(shortCat), regs,
      cs.map((c) => regs.map((g) => sum(facts.filter((f) => f.region === g), (f) => f.cats[c] || 0))), true, Math.max(360, 30 * cs.length + 130)));
  }
  if (on("heatdis")) {
    out.push(H(ms.length >= 2 ? "病名の上位×月" : "病名の上位×地域", 2));
    const gt = {};
    for (const f of facts) for (const [g, v] of Object.entries(f.groups)) gt[g] = (gt[g] || 0) + v;
    const gs = Object.entries(gt).sort((a, b) => b[1] - a[1]).slice(0, 15).map((x) => x[0]);
    const cols = ms.length >= 2 ? ms : regs, lab = ms.length >= 2 ? ms.map(fmtMonth) : regs;
    out.push(await heatImg(ms.length >= 2 ? "病名（まとめ）上位15×月（色は病名ごとに最も多い月を赤く＝季節の波）" : "病名（まとめ）上位15×地域", gs, lab,
      gs.map((g) => cols.map((k) => sum(facts.filter((f) => (ms.length >= 2 ? f.month : f.region) === k), (f) => f.groups[g] || 0))), true, Math.max(380, 30 * gs.length + 130)));
  }
  if (on("trend")) {
    // 期間が短いときは、直近12か月で傾向を見る
    const tf = ms.length >= 3 ? { facts, ms } : fsFacts({ span: 12, regions: [], posts: [] }, m);
    const tms = tf.ms.filter((mm) => tf.facts.some((f) => f.month === mm));
    out.push(H(`月ごとの傾向（${fmtMonth(tms[0])}〜${fmtMonth(tms[tms.length - 1])}）`, 2));
    if (tms.length < 3) out.push(P("3か月以上のデータがないため、傾向は計算できません"));
    else {
      const per = (mm, fn) => { const fs = tf.facts.filter((f) => f.month === mm); return fs.length ? sum(fs, fn) / fs.length : 0; };
      const catTot = {};
      for (const f of tf.facts) for (const [c, v] of Object.entries(f.cats)) catTot[c] = (catTot[c] || 0) + v;
      const series = [["受診者数", (f) => f.total], ["実患の件数", (f) => f.real], ...Object.entries(catTot).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => [shortCat(c), (f) => f.cats[c] || 0])];
      // 24か月以上あれば、月ごとの平均（季節の波）を引いてから傾きを見る。24か月未満は季節の波を除けない
      const deseason = tms.length >= 24;
      const rows = series.map(([l, fn]) => {
        const raw = tms.map((mm) => per(mm, fn));
        const mavg = {};
        if (deseason) for (let k = 1; k <= 12; k++) { const v = raw.filter((_, i) => Number(tms[i].slice(5)) === k); mavg[k] = v.length ? sum(v, (x) => x) / v.length : 0; }
        const ys = deseason ? raw.map((v, i) => v - mavg[Number(tms[i].slice(5))]) : raw, reg = fsRegress(ys.map((_, k) => k), ys);
        return [l, reg ? `${reg.b >= 0 ? "+" : ""}${reg.b.toFixed(2)}` : "―", reg ? reg.r2.toFixed(2) : "―", f1(raw[0]), f1(raw[raw.length - 1]), !reg || reg.r2 < 0.3 ? "はっきりした傾向なし" : (reg.b > 0 ? "増加傾向" : "減少傾向") + (deseason ? "" : "（季節の影響の可能性）")];
      });
      out.push(TABLE([onePost ? `指標（${onePost}の月ごとの値）` : "指標（1公館あたり）", "1か月あたりの増減", "決定係数 R²", "最初の月", "最後の月", "見立て"], rows, { widths: [24, 16, 13, 13, 13, 21] }));
      out.push(P(`※${onePost ? `${onePost}の月ごとの値の傾向です。` : "提出公館数の違いの影響を除くため、1公館あたりの平均で比べています。"}決定係数が0.3未満のときは、直線的な傾向とは言えません。${deseason ? "24か月以上あるため、月ごとの平均（季節の波）を引いてから傾きを求めています。" : "24か月未満のため季節の波（休暇の時期・感染症の季節など）を除いていません。季節の形だけで増加・減少に見えることがあるので、前年同月との比較と合わせて見てください。"}`, "rp-note"));
    }
  }
  // 1公館1か月あたりにそろえる（月報を出した公館の数が月によって違うため）
  const perPost = (fs, fn) => (fs.length ? sum(fs, fn) / fs.length : 0);
  const hist = span === 0 ? { facts, ms } : fsFacts({ span: 0, regions: [], posts: [] }, m);   // 月報のある最初の月から m まで
  if (on("excess")) {
    // 期間の件数（観察）を、基準の時期の1公館1か月あたりの件数 × 期間の月報の数（期待）と比べる。
    // 基準：前の年の同じ月（1年以上前のデータがあるとき）。なければ期間の直前の12か月
    // 全期間（または基準の時期がないとき）は、期間の最後の3か月を、それより前の月と比べる
    let obsMs = ms, obsFacts = facts;
    const cur = new Set(ms), mset = new Set(ms.map((mm) => mm.slice(5)));
    let base = span === 0 ? [] : hist.facts.filter((f) => !cur.has(f.month) && f.month < ms[0] && mset.has(f.month.slice(5))), baseLabel = "前の年の同じ月";
    if (!base.length && span !== 0) { const b12 = new Set(spanMonths(prevMonth(ms[0]), 12)); base = hist.facts.filter((f) => b12.has(f.month)); baseLabel = "直前の12か月"; }
    const haveMs = ms.filter((mm) => facts.some((f) => f.month === mm));
    if (!base.length && haveMs.length >= 6) {
      obsMs = haveMs.slice(-3); const o3 = new Set(obsMs);
      obsFacts = facts.filter((f) => o3.has(f.month)); base = facts.filter((f) => !o3.has(f.month)); baseLabel = "それより前の月";
    }
    out.push(H("いつもより多い病名", 2));
    if (!base.length) out.push(P("比べる基準の時期のデータがありません（6か月以上の月報があると、最後の3か月をそれより前の月と比べます）"));
    else {
      const bm = [...new Set(base.map((f) => f.month))].sort();
      const gs = new Set(obsFacts.flatMap((f) => Object.keys(f.groups)));
      const rows = [...gs].map((g) => {
        const o = sum(obsFacts, (f) => f.groups[g] || 0), e = perPost(base, (f) => f.groups[g] || 0) * obsFacts.length;
        return { g, o, e, ratio: (o + 0.5) / (e + 0.5) };
      }).filter((x) => x.o >= 5 && x.ratio >= 1.3).sort((a, b) => b.ratio - a.ratio).slice(0, 12);
      out.push(P(`期間（${fmtMonth(obsMs[0])}${obsMs.length > 1 ? "〜" + fmtMonth(obsMs[obsMs.length - 1]) : ""}）の件数を、${baseLabel}（${fmtMonth(bm[0])}〜${fmtMonth(bm[bm.length - 1])}のうち${bm.length}か月）の1公館1か月あたりの件数から見込んだ数と比べました。5件以上で、見込みの1.3倍以上のもの。`));
      // 前の年の同じ月と比べられないときは、季節の違う月と比べている（冬のインフルエンザ・夏の熱中症なども「多い」と出る）
      if (baseLabel !== "前の年の同じ月") out.push(P(`※季節の影響に注意：前の年の同じ月の月報がないため、季節の違う月（${baseLabel}）と比べています。インフルエンザ（冬）・熱中症（夏）・蚊が媒介する感染症（雨季）など、季節の流行もそのまま「いつもより多い」と出ます。前の年の同じ月の月報がそろうと、同じ月どうしで比べます。`, "rp-note"));
      if (!rows.length) out.push(P("見込みより目立って多い病名はありませんでした。"));
      else {
        const lab = rows.map((x) => x.g).reverse(), rr = rows.slice().reverse();
        out.push(IMG(await figUrl([{ type: "bar", orientation: "h", y: lab, x: rr.map((x) => x.ratio),
          marker: { color: rr.map((x) => (x.ratio >= 2 ? "#c0392b" : "#e67e22")) }, text: rr.map((x) => (x.e < 0.5 ? `${x.o}件（新たに報告）` : `${x.o}件（見込み ${x.e.toFixed(1)}件）`)), textposition: "outside", cliponaxis: false }],
          // 倍率は対数の目盛り（基準の時期にほとんどなかった病名の倍率が大きくなっても、ほかの棒がつぶれないように）
          Object.assign({ title: `見込みの何倍か（基準：${baseLabel}）`, showlegend: false, margin: { l: 190, r: 170, t: 56, b: 50 },
            xaxis: { title: { text: "倍（1＝いつもどおり。対数の目盛り）" }, type: "log", range: [0, Math.log10(Math.max(3, ...rows.map((x) => x.ratio)) * 1.15)],
              tickvals: [1, 1.5, 2, 3, 5, 10, 20, 50, 100], ticktext: ["1", "1.5", "2", "3", "5", "10", "20", "50", "100"] }, yaxis: { automargin: true },
            shapes: [{ type: "line", x0: 1, x1: 1, yref: "paper", y0: 0, y1: 1, line: { color: "#555", dash: "dash" } }] }, tpl), 1000, Math.max(300, 34 * rows.length + 120)), 600));
        out.push(P("※赤は見込みの2倍以上。「新たに報告」は基準の時期にほとんど報告のなかった病名。件数の少ない病名は偶然でも倍率が大きくなるので、件数と合わせて見てください。流行の確認には丙表（報告事項）の記述も参照してください。", "rp-note"));
      }
    }
  }
  if (on("infect")) {
    // 期間が短いときは、直近12か月で見る
    const tf = ms.length >= 3 ? { facts, ms } : fsFacts({ span: 12, regions: [], posts: [] }, m);
    const tms = tf.ms.filter((mm) => tf.facts.some((f) => f.month === mm));
    out.push(H(`主な感染症の月ごとの推移（${fmtMonth(tms[0])}〜${fmtMonth(tms[tms.length - 1])}）`, 2));
    const it = {};
    for (const f of tf.facts) for (const [g, v] of Object.entries(f.inf)) it[g] = (it[g] || 0) + v;
    const top = Object.entries(it).sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0]);
    if (!top.length || tms.length < 2) out.push(P(top.length ? "2か月以上のデータがないため、推移は描けません" : "期間に感染症の報告がありません"));
    else {
      const pal = ["#c0392b", "#2a78d6", "#e67e22", "#27ae60", "#8e44ad", "#7f8c8d"];
      out.push(IMG(await figUrl(top.map((g, k) => ({ type: "scatter", mode: "lines+markers", name: g, line: { color: pal[k], width: 2.5 }, marker: { size: 6 },
        x: tms.map(fmtMonth), y: tms.map((mm) => sum(tf.facts.filter((f) => f.month === mm), (f) => f.inf[g] || 0)) })),
        Object.assign({ title: "感染症の件数（上位6・月ごとの合計）", yaxis: { title: { text: "件" }, rangemode: "tozero" }, legend: { orientation: "h", y: -0.2 }, margin: { l: 60, r: 20, t: 56, b: 90 } }, tpl), 1000, 460), 600));
      out.push(P("※乙表で「感染症及び寄生虫症」に分類した病名に加え、胃腸炎・下痢症・インフルエンザ・新型コロナは、公館が消化器・呼吸器に分類していても感染症として数えています（診断名の上位の表の「分類」とは異なることがあります）。月報を出した公館の数が月によって違うことに注意してください。", "rp-note"));
    }
  }
  if (on("yoy")) {
    // 年ごとに1〜12月の線を重ね、季節の波と前年との違いを見る（直近3年。5年以上のレポートでは直近5年）
    const years = [...new Set(hist.facts.map((f) => f.month.slice(0, 4)))].sort().slice(span === 0 || span >= 60 ? -5 : -3);
    out.push(H("前年同月との比較", 2));
    // 同じ月が2年以上そろっていないと比べられない
    const overlap = Array.from({ length: 12 }, (_, i) => years.filter((y) => hist.facts.some((f) => f.month === `${y}-${String(i + 1).padStart(2, "0")}`)).length).some((n) => n >= 2);
    if (!overlap) out.push(P("同じ月の月報が2年分そろっていないため、前年と比べられません（月報がたまると表示します）"));
    else {
      const yc = ["#e1e7f0", "#ccd6e6", "#b8c4d6", "#7f9cc4", "#184f95"].slice(-years.length);
      const line = (fn) => years.map((y, k) => ({ type: "scatter", mode: "lines+markers", name: `${y}年`, line: { color: yc[k], width: k === years.length - 1 ? 3 : 2 },
        x: Array.from({ length: 12 }, (_, i) => `${i + 1}月`),
        y: Array.from({ length: 12 }, (_, i) => { const fs = hist.facts.filter((f) => f.month === `${y}-${String(i + 1).padStart(2, "0")}`); return fs.length ? +perPost(fs, fn).toFixed(2) : null; }) }));
      const lay = (title, unit) => Object.assign({ title, yaxis: { title: { text: unit }, rangemode: "tozero" }, legend: { orientation: "h", y: -0.18 }, margin: { l: 55, r: 15, t: 56, b: 80 } }, tpl);
      out.push(IMGS([await figUrl(line((f) => Number(f.total) || 0), lay("受診者数（1公館あたり）", "名"), 520, 400),
        await figUrl(line((f) => sum(Object.values(f.inf), (v) => v)), lay("感染症の件数（1公館あたり）", "件"), 520, 400)], 330));
      out.push(P("※月報を出した公館の数の違いをならすため、1公館あたりの平均で比べています。濃い線が最新の年。", "rp-note"));
    }
  }
  if (on("posts")) {
    out.push(H("公館別の受診者数（業務量）", 2));
    // 医務官1人あたりで比べる（フランス・タイなど身体とメンタルの2人体制の公館は、受診者数を人数で割る）
    const by = {};
    for (const f of facts) { const b = (by[f.post] ||= { n: 0, staff: 0, family: 0, other: 0, total: 0 }); const d = doctorCount(f.post, f.month); b.n++; for (const k of ["staff", "family", "other", "total"]) b[k] += (Number(f[k]) || 0) / d; }
    const ps = Object.entries(by).map(([p, b]) => ({ p, ...b, avg: b.total / b.n, docs: doctorCount(p, m) })).sort((a, b) => b.avg - a.avg);
    const top = ps.slice(0, 25);
    if (!top.length) out.push(P("対象の月報がありません"));
    else {
      const med = describe(ps.map((x) => x.avg)).median;
      const lab = top.map((x) => (x.docs > 1 ? `${x.p}（${x.docs}人）` : x.p)).reverse();
      const multi = ps.filter((x) => x.docs > 1).map((x) => `${x.p}（${x.docs}人）`);
      out.push(IMG(await figUrl(VISIT_KEYS.map(([k, name, color]) => ({ type: "bar", orientation: "h", name, marker: { color }, y: lab, x: top.slice().reverse().map((x) => +(x[k] / x.n).toFixed(1)) })),
        Object.assign({ title: `医務官1人・1か月あたりの受診者数の多い公館（上位${top.length}${ps.length > top.length ? `／${ps.length}公館` : ""}）`, barmode: "stack", margin: { l: 170, r: 20, t: 56, b: 70 },
          xaxis: { title: { text: "名／月（医務官1人あたり）" } }, yaxis: { automargin: true }, legend: { orientation: "h", y: -0.12 },
          shapes: [{ type: "line", x0: med, x1: med, yref: "paper", y0: 0, y1: 1, line: { color: "#555", dash: "dot" } }],
          annotations: [{ x: med, y: 1, yref: "paper", text: `全公館の中央値 ${f1(med)}名`, showarrow: false, yanchor: "bottom", font: { size: 11 } }] }, tpl), 1000, Math.max(360, 22 * top.length + 140)), 600));
      out.push(P(`※期間に月報のある月の平均を、医務官の人数で割った値。${multi.length ? `医務官が2人以上の公館（${multi.join("、")}。身体とメンタル）は、受診者数を人数で割っています。` : ""}${ps.length > 1 ? `点線は全${ps.length}公館の中央値。` : ""}業務量の偏りや、巡回・応援の検討の目安になります。`, "rp-note"));
    }
  }
  if (on("change")) {
    out.push(H(span === 1 ? "前月と比べて増えた・減った公館" : "前の期間と比べて増えた・減った公館", 2));
    if (span === 0) out.push(P("全期間のレポートでは、比べる前の期間がありません"));
    else {
      const pms = spanMonths(prevMonth(ms[0]), span);
      const cur = {}, prv = {};
      for (const f of facts) cur[f.post] = (cur[f.post] || 0) + (Number(f.total) || 0);
      for (const mm of pms) for (const r of reportsOf(mm)) prv[r.post] = (prv[r.post] || 0) + (Number(r.total) || 0);
      const diffs = Object.keys(cur).filter((p) => p in prv).map((p) => [p, cur[p], prv[p], cur[p] - prv[p]]);
      if (!diffs.length) out.push(P("前の期間のデータがありません"));
      else {
        const pct = (a, b) => (b ? `${a - b >= 0 ? "+" : ""}${Math.round((100 * (a - b)) / b)}%` : "―");
        const up = diffs.filter((d) => d[3] > 0).sort((a, b) => b[3] - a[3]).slice(0, 8), dn = diffs.filter((d) => d[3] < 0).sort((a, b) => a[3] - b[3]).slice(0, 8);
        out.push(P(`${span === 1 ? "前月" : "前の期間"}と比べられる${diffs.length}公館のうち、増えたのは${diffs.filter((d) => d[3] > 0).length}公館、減ったのは${diffs.filter((d) => d[3] < 0).length}公館。`));
        if (up.length) out.push(TABLE(["増えた公館", "今回", "前回", "増減", "増減率"], up.map((d) => [d[0], String(d[1]), String(d[2]), `+${d[3]}`, pct(d[1], d[2])])));
        if (dn.length) out.push(TABLE(["減った公館", "今回", "前回", "増減", "増減率"], dn.map((d) => [d[0], String(d[1]), String(d[2]), String(d[3]), pct(d[1], d[2])])));
      }
    }
  }
  const regOf = (f) => f.region;
  const monthsShown = ms.length > 12 ? ms.slice(-12) : ms;
  const cntBy = (fs, fn) => sum(fs, (f) => sum(f.dl, (d) => (fn(d) ? d.k : 0)));
  if (on("watch")) {
    out.push(H("注目する疾患群の推移", 2));
    const rows = WATCH_GROUPS.map(([t, fn]) => { const tot = cntBy(facts, fn);
      if (t === "こころの不調" && !mentalOk(facts)) return [t, ...monthsShown.map(() => "―"), HIDDEN, "―"];
      // 期間を通して0件の群は「報告なし」（該当する病名が乙表に1件も書かれていない）とはっきり示す
      return tot ? [t, ...monthsShown.map((mm) => String(cntBy(facts.filter((f) => f.month === mm), fn))), String(tot), String(new Set(facts.filter((f) => f.dl.some((d) => fn(d))).map((f) => f.post)).size)]
        : [t, ...monthsShown.map(() => "―"), "0（該当する病名なし）", "0"]; });
    out.push(TABLE(["疾患群", ...monthsShown.map((mm) => `${Number(mm.slice(5))}月`), "期間の計", "報告公館数"], rows));
    if (monthsShown.length >= 2) {
      const pal = ["#c0392b", "#e67e22", "#2a78d6", "#8e44ad", "#7f8c8d", "#27ae60", "#d81b60", "#16a085", "#a0522d"];
      out.push(IMG(await figUrl(WATCH_GROUPS.filter(([t]) => t !== "こころの不調" || mentalOk(facts)).map(([t, fn], k) => ({ type: "scatter", mode: "lines+markers", name: t, line: { color: pal[k], width: 2 },
        x: monthsShown.map(fmtMonth), y: monthsShown.map((mm) => { const fs = facts.filter((f) => f.month === mm); return fs.length ? +(1000 * cntBy(fs, fn) / Math.max(1, sum(fs, (f) => Number(f.total) || 0))).toFixed(1) : null; }) })),
        Object.assign({ title: "受診者1,000人あたりの件数（月ごと。受診者の中での割合で、発生率ではありません）", yaxis: { title: { text: "件／受診者1,000人（受診者の中での割合）" }, rangemode: "tozero" }, legend: { orientation: "h", y: -0.2 }, margin: { l: 60, r: 20, t: 56, b: 110 } }, tpl), 1000, 480), 600));
    }
    out.push(P(`※乙表の病名に含まれる語で分けています（1つの病名が複数の群に入ることがあります）。グラフは、月報を出した公館の数の違いをならすため、受診者1,000人あたりにしています。「こころの不調」は個人の特定を避けるため、対象の公館が${MENTAL_MIN_POSTS}つ未満のときは示しません。心血管・脳血管疾患は、狭心症・心筋梗塞・急性冠症候群・心不全・不整脈（伝導障害・期外収縮を含む）・心筋症・弁膜症・心内膜炎・脳卒中・静脈血栓塞栓症・大動脈疾患・末梢動脈疾患。`, "rp-note"));
  }
  if (on("spread")) {
    out.push(H("感染症の地理的な広がり", 2));
    const inf = {};
    for (const f of facts) for (const [g, v] of Object.entries(f.inf)) inf[g] = (inf[g] || 0) + v;
    const top = Object.entries(inf).sort((a, b) => b[1] - a[1]).slice(0, 10).map((x) => x[0]);
    if (!top.length) out.push(P("期間に感染症の報告がありません"));
    else {
      const half = Math.floor(ms.length / 2), early = new Set(ms.slice(0, half)), late = new Set(ms.slice(half));
      const rows = top.map((gname) => {
        const fs = facts.filter((f) => f.inf[gname]);
        const posts = new Set(fs.map((f) => f.post)), regsOf = [...new Set(fs.map(regOf))];
        const pe = new Set(fs.filter((f) => early.has(f.month)).map((f) => f.post)), pl = new Set(fs.filter((f) => late.has(f.month)).map((f) => f.post));
        // 丙表（報告事項）で流行・増加が報告された公館
        const obPosts = [...new Set(ms.flatMap((mm) => reportsOf(mm).filter((r) => reportOutbreaks(r).some((o) => o.trend === "流行・増加" && groupOf(o.name) === gname)).map((r) => r.post)))].sort(jaCmp);
        // 1つの地域の中なら（地域を選んだとき・報告が1地域だけのとき）、地域名ではなく国名を件数の多い順に5つまで
        const byPost = {}; for (const f of fs) byPost[f.post] = (byPost[f.post] || 0) + f.inf[gname];
        const pz = Object.entries(byPost).sort((a, b) => b[1] - a[1] || jaCmp(a[0], b[0])).map((x) => x[0]);
        const where = posts.size <= 5 ? [...posts].sort(jaCmp).join("・") : regsOf.length === 1 ? `${pz.slice(0, 5).join("・")} ほか${posts.size - 5}（${regsOf[0]}の${posts.size}公館）` : `${regsOf.join("・")}（${posts.size}公館）`;
        const newP = [...pl].filter((x) => !pe.has(x)).sort(jaCmp);
        return [gname, String(inf[gname]), String(posts.size), where, ms.length >= 2 ? `${pe.size}→${pl.size}` : "―", ms.length >= 2 ? (newP.length && newP.length <= 3 ? `${newP.length}（${newP.join("・")}）` : String(newP.length)) : "―",
          obPosts.length ? (obPosts.length <= 4 ? obPosts.join("・") : `${obPosts.slice(0, 4).join("・")} ほか${obPosts.length - 4}`) : "―"];
      });
      out.push(TABLE(["病名（まとめ）", "件数", "報告公館数", "報告のあった国・地域", "公館数（前半→後半）", "後半に新たに報告", "丙表で流行・増加の報告"], rows, { widths: [16, 7, 8, 27, 12, 10, 20] }));
      out.push(P("※報告した公館が5つ以下のときは国名、それより多いときは、1つの地域の中なら件数の多い国から5つ、複数の地域にわたるときは地域を示します。後半に新たに報告した公館が3つ以下なら国名も示します。期間を前半と後半に分け、報告した公館の数が増えているもの・新たに報告した公館があるものは、地理的に広がっている可能性があります。右の列は丙表（報告事項）で「流行・増加」と書かれた公館（乙表の件数がなくても丙表だけで報告されることがあります）。胃腸炎・インフルエンザ・新型コロナは分類にかかわらず感染症として数えています。", "rp-note"));
    }
  }
  if (on("rate")) {
    out.push(H("受診率（在籍人数あたり）", 2));
    const hc = facts.filter((f) => headcountOf(f.post, f.month));
    if (!hc.length) {
      out.push(P("在籍人数（受診率の分母）が入っていないため、受診率は計算できません。次の手順で入れると表示します。"));
      out.push(P("① 設定タブを開く　② 「在籍人数（受診率の計算用）」の欄に、1行に「公館名,職員の人数,家族の人数,年月（省略可）」を入れる（例：「公館名,25,18,2026-04」。Excel の表をそのまま貼り付けてもよい）　③ 「在籍人数を保存」を押し、もう一度PDFを作る", "rp-note"));
    }
    else {
      const rateRow = (l, fs) => { const n = sum(fs, (f) => { const h = headcountOf(f.post, f.month); return (h.staff || 0) + (h.family || 0); }), v = sum(fs, (f) => (Number(f.staff) || 0) + (Number(f.family) || 0));
        const ns = sum(fs, (f) => headcountOf(f.post, f.month).staff || 0), vs = sum(fs, (f) => Number(f.staff) || 0);
        return [l, String(new Set(fs.map((f) => f.post)).size), n ? (100 * v / n).toFixed(1) + "%" : "―", ns ? (100 * vs / ns).toFixed(1) + "%" : "―",
          !mentalOk(fs) ? "―" : n ? (1000 * cntBy(fs, (d) => d.c === MENTAL_CAT) / n).toFixed(1) : "―", n ? (1000 * cntBy(fs, (d) => d.c === INF_CAT) / n).toFixed(1) : "―"]; };
      const hregs = regs.filter((g) => hc.some((f) => f.region === g));
      const rows = postsIn(hc) === 1 ? [rateRow(hc[0].post, hc)] : [...hregs.map((g) => rateRow(g, hc.filter((f) => f.region === g))), ...(hregs.length > 1 ? [rateRow("全体", hc)] : [])];
      out.push(TABLE([postsIn(hc) === 1 ? "公館" : "地域", "公館数", "受診率（職員＋家族）", "職員の受診率", "こころの不調（1,000人あたり）", "感染症（1,000人あたり）"], rows, { bold: new Set([rows.length - 1]) }));
      out.push(P(`※1か月あたり。受診率＝受診者数（職員＋家族、延べ）÷在籍人数。在籍人数を入れた${new Set(hc.map((f) => f.post)).size}公館で計算（「その他」の受診者は在籍人数に入らないため除く）。延べ人数なので、同じ人の複数回の受診を含みます。在籍人数は、各月について、その月以前で最も新しい年月の値を使っています（年月を入れていない値は全期間に使用）。`, "rp-note"));
    }
  }
  if (on("occ")) {
    out.push(H("産業保健の指標", 2));
    const occRow = (l, fs) => { const n = fs.length || 1, staff = sum(fs, (f) => Number(f.staff) || 0), tot = sum(fs, (f) => Number(f.total) || 0);
      return [l, String(fs.length), f1(staff / n), tot ? Math.round(100 * staff / tot) + "%" : "―", String(cntBy(fs, (d) => d.c !== Z && LIFESTYLE_RE.test(d.n))),
        String(cntBy(fs, (d) => d.c !== Z && CVD_RE.test(d.n))), mentalOk(fs) ? String(cntBy(fs, (d) => d.c === MENTAL_CAT)) : "―", String(cntBy(fs, (d) => d.c === INJ_CAT)), String(cntBy(fs, (d) => d.c === Z && /健診|健康診断|検診|健康相談/.test(d.n))),
        String(cntBy(fs, (d) => d.c === Z && /接種|ワクチン/.test(d.n)))]; };
    const rows = rowGroups.map(([g, fs]) => occRow(g, fs));
    out.push(P("職員の受診者数と、受診者全体（職員・家族・その他）の生活習慣病・心血管疾患・こころの不調・外傷などの件数です。乙表の病名は受診者の区分ごとに分かれていないため、病気の件数は職員だけの数ではありません。"));
    out.push(TABLE([rowHead, "月報数", onePost ? "職員の受診（1か月）" : "職員の受診（1公館・月）", "受診者のうち職員", "生活習慣病＊", "心血管・脳血管＊", "こころの不調＊", "外傷・中毒＊", "健診・相談＊", "予防接種＊"], rows, { bold: rowGroups.length > 1 ? new Set([rows.length - 1]) : new Set(), widths: [12, 7, 11, 8, 10, 10, 10, 10, 11, 10] }));
    if (ms.length >= 3) {
      out.push(IMG(await figUrl([["職員の受診者数", (f) => Number(f.staff) || 0, "#184f95"], ["生活習慣病", (f) => sum(f.dl, (d) => (d.c !== Z && LIFESTYLE_RE.test(d.n) ? d.k : 0)), "#e67e22"],
        ...(mentalOk(facts) ? [["こころの不調", (f) => f.cats[MENTAL_CAT] || 0, "#8e7cc3"]] : []), ["外傷・中毒", (f) => f.cats[INJ_CAT] || 0, "#27ae60"]].map(([name, fn, color]) => ({ type: "scatter", mode: "lines+markers", name, line: { color, width: 2.2 },
        x: monthsShown.map(fmtMonth), y: monthsShown.map((mm) => { const fs = facts.filter((f) => f.month === mm); return fs.length ? +perPost(fs, fn).toFixed(2) : null; }) })),
        Object.assign({ title: "1公館あたりの推移（月ごと。病気の件数は受診者全体）", yaxis: { rangemode: "tozero" }, legend: { orientation: "h", y: -0.2 }, margin: { l: 55, r: 20, t: 56, b: 100 } }, tpl), 1000, 440), 600));
    }
    out.push(P(`※＊の列は職員・家族・その他の受診者の合計。生活習慣病は高血圧・糖尿病・脂質異常症・高尿酸血症／痛風・肥満・脂肪肝。こころの不調は「精神及び行動の障害」に分類した病名で、個人の特定を避けるため地域別だけを示し、公館が${MENTAL_MIN_POSTS}つ未満の行は「―」にしています。健診・予防接種は乙表の検診・予防接種（Z）の病名から数えています。`, "rp-note"));
  }
  if (on("subcat")) {
    out.push(H("疾病分類の中の内訳", 2));
    for (const cat of [SKIN_CAT, INJ_CAT, INF_CAT, RESP_CAT, ...(mentalOk(facts) ? [MENTAL_CAT] : [])]) {
      const tot = {}, names = {};
      const inCat = cat === SKIN_CAT ? isSkin : (d) => d.c === cat;
      for (const f of facts) for (const d of f.dl) if (inCat(d)) { const sc = subcatOf(cat === SKIN_CAT ? SKIN_CAT : cat, d); tot[sc] = (tot[sc] || 0) + d.k; ((names[sc] ||= {})[groupOf(d.n)] = (names[sc][groupOf(d.n)] || 0) + d.k); }
      const all = sum(Object.values(tot), (v) => v);
      if (!all) continue;
      out.push(H(`${cat === SKIN_CAT ? "皮膚（白癬・とびひなど皮膚の感染症、虫刺症を含む）" : shortCat(cat)}（${all}件）`, 3));
      out.push(TABLE(["内訳", "件数", "割合", "主な病名"], Object.entries(tot).sort((a, b) => (a[0] === "その他") - (b[0] === "その他") || b[1] - a[1]).map(([sc, v]) =>
        [sc, String(v), Math.round(100 * v / all) + "%", Object.entries(names[sc]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n}${c}`).join("、")]), { widths: [26, 9, 8, 57] }));
    }
    out.push(P(`※病名に含まれる語で分けています。「その他」はどの内訳の語も含まない病名。皮膚には、分類が感染症の皮膚の感染症と、分類が外傷・中毒の虫刺症も入れているため、外傷・感染症の内訳と重なります。${mentalOk(facts) ? "" : `対象の公館が${MENTAL_MIN_POSTS}つ未満のため、こころ（精神・行動）の内訳は示しません。`}`, "rp-note"));
  }
  if (on("zcat")) {
    out.push(H("予防接種・健診の内訳", 2));
    const ZK = [["健康診断・検診", /健診|健康診断|検診/], ["健康相談・指導", /相談|指導|カウンセリング|面接|面談/], ["インフルエンザ", /インフルエンザ/], ["新型コロナ", /コロナ|COVID/],
      ["狂犬病", /狂犬病/], ["A型肝炎", /A型肝炎/], ["B型肝炎", /B型肝炎/], ["黄熱", /黄熱/], ["腸チフス", /腸チフス/], ["日本脳炎", /日本脳炎/], ["髄膜炎菌", /髄膜炎/],
      ["破傷風・ジフテリア・百日咳", /破傷風|ジフテリア|百日咳|三種|四種|五種|DPT|Tdap/i], ["麻疹・風疹", /麻疹|風疹|MR/], ["小児の定期接種（ヒブ・肺炎球菌・ロタ・BCG・水痘など）", /ヒブ|Hib|肺炎球菌|ロタ|BCG|水痘|ポリオ|HPV|子宮頸/i],
      ["予防接種（種類の記載なし）", /接種|ワクチン/], ["証明書・診断書", /証明|診断書/]];
    const t = {};
    for (const f of facts) for (const d of f.dl) if (d.c === Z) { const k = (ZK.find(([, re]) => re.test(d.n)) || ["その他"])[0]; (t[k] ||= { v: 0, posts: new Set() }).v += d.k; t[k].posts.add(f.post); }
    const all = sum(Object.values(t), (o) => o.v);
    if (!all) out.push(P("期間に検診・予防接種（Z）の報告がありません"));
    else out.push(TABLE(["内容", "件数", "割合", "報告公館数"], Object.entries(t).sort((a, b) => (a[0] === "その他") - (b[0] === "その他") || b[1].v - a[1].v).map(([k, o]) => [k, String(o.v), Math.round(100 * o.v / all) + "%", String(o.posts.size)])));
    out.push(P("※乙表で「検診・予防接種等（Z）」に分類した病名を、含まれる語で分けています。「予防接種（種類の記載なし）」が多いときは、乙表にワクチンの種類まで書く（例：A型肝炎ワクチン接種）と、種類ごとの集計ができます。", "rp-note"));
  }
  if (on("infer")) {
    // 統計タブの「検定・推定」で保存した結果のうち、レポートの期間に入る月のもの
    // 選んだ結果（PDFレポートのタブで、PDFレポートのタブで選ぶ。AIの回答は保存したすべてから）。選んでいなければ、期間に入る月のもの
    const ns = Array.isArray(noteIds) ? (state.statNotes || []).filter((x) => noteIds.includes(x.id)) : (state.statNotes || []).filter((x) => ms.includes(x.month));
    // 保存した結果がないときは見出しも出さない
    if (ns.length) out.push(H("検定・推定の結果", 2));
    for (const x of ns) {
      out.push(H(x.title, 3));
      x.text.forEach((t) => out.push(P(t)));
      if (x.head) out.push(TABLE(x.head, x.rows));
      if (x.notes && x.notes.length) out.push(P("※" + x.notes.join(" "), "rp-note"));
    }
  }
  return out;
}
const REPORT_SECTIONS = [["aisum", "AIによる概況"], ["overview", "全体概況"], ["map", "世界地図（疾病分布）"], ["visits", "受診者数統計（甲表）"], ["diseases", "疾病分類統計（乙表）"], ["stats", "統計分析"], ["ai", "AI分析の結果"],
  ["junkai", "巡回健診・医務官の異動"], ["evac", "緊急移送"], ["hogo", "邦人援護"], ["submit", "月報の提出・記載状況"], ["summary", "公館別サマリー"], ["feedback", "全医務官あて統合サマリー"]];
// 以前の「緊急移送・邦人対応」（cases）は、緊急移送と邦人援護の2つの章に分けた
const secsCompat = (xs) => [...xs].flatMap((k) => (k === "cases" ? ["evac", "hogo"] : [k]));
// ---- 全医務官あての統合サマリー（1つのPDF）：世界と地域の今月の数字、地域ごとの流行・増加、いつもより多い病名、
// 公館ごとの一覧（受診者数・前月比・主な疾病・流行の報告）、邦人対応・緊急移送の件数（事例の中身は載せない）、巡回健診・異動・提出状況
async function allFeedbackBlocks(m, inReport = false) {
  const { H, P, LI, IMG, TABLE } = rp, out = [], tpl = { template: chartTemplate(true) };
  const rep = reportsOf(m), pr = reportsOf(prevMonth(m)), num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));
  const regs = [...AI_REGIONS, "未分類"].filter((g) => rep.some((r) => aiRegionOf(r.post) === g));
  if (inReport) out.push(P(`${fmtMonth(m)}分。全医務官に送ることを考えた、今月の全体のまとめです（事例の中身は載せません）。`, "rp-note"));
  else out.push(rp.el("div", "rp-fbhead", `<h1>医務官 月次サマリー（全体）</h1><p>全医務官あて　${esc(fmtMonth(m))}分</p><p>作成日：${fmtDate(Date.now())}</p>`));
  // 1. 全体
  out.push(H("1. 今月の全体", 2));
  const tot = sum(rep, (r) => num(r.total) || 0), ptot = sum(pr, (r) => num(r.total) || 0), exp = expectedPosts(m);
  out.push(LI(`提出 ${rep.length}公館${exp.size ? `／${exp.size}公館` : ""}、受診者数 延べ${tot.toLocaleString("ja-JP")}名（前月 ${pr.length ? ptot.toLocaleString("ja-JP") + "名・提出" + pr.length + "公館" : "―"}）。`));
  out.push(TABLE(["地域", "提出", "受診者数", "1公館あたり", "前月"], regs.map((g) => { const rs = rep.filter((r) => aiRegionOf(r.post) === g), ps = pr.filter((r) => aiRegionOf(r.post) === g), t = sum(rs, (r) => num(r.total) || 0);
    return [g, `${rs.length}公館`, t.toLocaleString("ja-JP"), rs.length ? (t / rs.length).toFixed(1) : "―", ps.length ? sum(ps, (r) => num(r.total) || 0).toLocaleString("ja-JP") : "―"]; }), { widths: [22, 16, 20, 20, 22] }));
  // 2. 疾病
  out.push(H("2. 多い疾病", 2));
  const dis = diseasesOf(m), top = topDiseases(dis, 10);
  if (top.length) out.push(TABLE(["病名（まとめ）", "件数", "報告した公館"], top.map((x) => [x.name, String(x.count), `${x.posts}公館`]), { widths: [56, 18, 26] }));
  // いつもより多い病名（世界全体。直前の12か月の1公館あたりと比べる）
  const b12 = new Set(spanMonths(prevMonth(m), 12)), base = Object.values(state.reports).filter((r) => b12.has(r.month));
  if (base.length && rep.length) {
    const cnt = (rs) => { const c = {}; for (const r of rs) for (const d of r.diseases || []) { if (classify(d.name, d.cat) === Z) continue; const g = groupOf(d.name); c[g] = (c[g] || 0) + d.count; } return c; };
    const cur = cnt(rep), bc = cnt(base);
    const hi = Object.entries(cur).map(([k, v]) => ({ k, v, e: ((bc[k] || 0) / base.length) * rep.length })).filter((x) => x.v >= 5 && x.v >= 1.5 * x.e + 1).sort((a, b) => b.v / (b.e + 0.5) - a.v / (a.e + 0.5)).slice(0, 8);
    out.push(LI(`いつもより多い病名（直前12か月の1公館あたりから見込んだ数の1.5倍以上）：${hi.length ? hi.map((x) => `${x.k} ${x.v}件（見込み${x.e.toFixed(1)}件）`).join("、") : "目立って多いものはありません"}。`));
  }
  // 3. 感染症の動向（地域ごと）
  out.push(H("3. 感染症の流行・増加の報告（丙表）", 2));
  const obs = outbreaksOf(m).filter((o) => o.trend === "流行・増加");
  if (!obs.length) out.push(LI("流行・増加の報告はありません。"));
  for (const g of regs) {
    const by = {};
    for (const o of obs.filter((o) => aiRegionOf(o.post) === g)) (by[o.name] ||= new Set()).add(o.post);
    const xs = Object.entries(by).sort((a, b) => b[1].size - a[1].size);
    if (xs.length) out.push(LI(`${g}：${xs.map(([k, ps]) => `${k}（${[...ps].join("・")}）`).join("、")}。`));
  }
  // 4. 公館ごとの一覧
  out.push(H("4. 公館ごとの一覧", 2));
  const obBy = {};
  for (const o of obs) (obBy[o.post] ||= new Set()).add(o.name);
  const rows = rep.slice().sort((a, b) => AI_REGIONS.indexOf(aiRegionOf(a.post)) - AI_REGIONS.indexOf(aiRegionOf(b.post)) || jaCmp(a.post, b.post)).map((r) => {
    const p = getReport(prevMonth(m), r.post), t = num(r.total), pt = p ? num(p.total) : null;
    const t1 = topDiseases(privDis(diseasesOf(m).filter((d) => d.post === r.post)), 2).map((x) => x.name).join("・");
    return [aiRegionOf(r.post), r.post, t ?? "―", t !== null && pt !== null ? `${t - pt >= 0 ? "+" : ""}${t - pt}` : "―", t1 || "―", obBy[r.post] ? [...obBy[r.post]].join("・") : ""];
  });
  out.push(TABLE(["地域", "公館", "受診者数", "前月比", "主な疾病", "流行・増加の報告"], rows, { widths: [11, 17, 11, 10, 27, 24] }));
  // 5. 緊急移送・邦人対応・巡回健診・異動・提出
  out.push(H("5. 緊急移送・邦人対応・巡回健診・医務官の異動", 2));
  const ev = casesOf(m, "evac"), hg = casesOf(m, "hogo");
  out.push(LI(`緊急移送 ${ev.length}件・邦人対応 ${hg.length}件${ev.length + hg.length ? `（地域別：${regs.map((g) => [g, ev.filter((c) => aiRegionOf(c.post) === g).length, hg.filter((c) => aiRegionOf(c.post) === g).length]).filter((x) => x[1] + x[2]).map(([g, a, b]) => `${g} 緊急移送${a}・邦人対応${b}`).join("、")}）` : ""}。事例の中身は、この全体あての資料には載せていません。`));
  const jk = [...new Set(junkaiOf(m).map((j) => `${j.from}→${j.dest || "（行先不明）"}`))];
  out.push(LI(`巡回健診：${jk.length ? jk.join("、") : "報告なし"}。`));
  const tr = transfers().filter((t) => t.month === m);
  out.push(LI(`医務官の異動：${tr.length ? tr.map((t) => `${t.post}（${t.after.startsWith("（") ? "離任" : "着任"}）`).join("、") : "なし"}。`));
  const miss = [...exp].filter((p) => !rep.some((r) => r.post === p)).sort(jaCmp), no = noOfficerIn(m);
  out.push(LI(`月報の提出：${rep.length}公館${miss.length ? `。未提出 ${miss.filter((p) => !no.has(p)).length}公館（医務官のいない公館を除く）` : "。すべて提出"}。`));
  out.push(P(`※月報くんで自動集計したものです（${fmtDate(Date.now())}）。数値・記載に誤りがあればお知らせください。職員・家族の健康情報に関わる集計を含むため、取扱いに注意してください。`, "rp-note"));
  return out;
}
const allFeedbackFileName = (m) => `全医務官あて統合サマリー_${reportPeriodName(m, 1)}.pdf`;
// 提出状況・記載状況の章（1か月：提出率と未提出の公館・記載の足りない月報。期間：月ごとの提出率と、未提出の多い公館）
// 医務官名の比べ方：肩書き・括弧書き・空白・印を除き、旧字体・異体字（髙→高、﨑→崎、邊→辺 など）をそろえる
const KANJI_VARIANTS = { "髙": "高", "﨑": "崎", "嵜": "崎", "邊": "辺", "邉": "辺", "齋": "斎", "齊": "斎", "濵": "浜", "濱": "浜", "澤": "沢", "德": "徳", "櫻": "桜", "眞": "真", "實": "実", "國": "国", "惠": "恵", "壽": "寿", "藏": "蔵", "冨": "富", "槇": "槙", "桒": "桑", "淸": "清", "瀨": "瀬", "埜": "野", "曻": "昇" };
const officerKey = (name) => nfkc(cleanOfficer(String(name || "")))
  .replace(/[（(][^）)]*[）)]/g, "").replace(/医務官|医師|先生|Dr\.?|ドクター|[*＊#＃・･]/gi, "").replace(/[\s　]+/g, "")
  .replace(/./g, (c) => KANJI_VARIANTS[c] || c);
// 表示用の医務官名（肩書き・括弧書きを除く）
const officerShow = (name) => nfkc(cleanOfficer(String(name || ""))).replace(/[（(][^）)]*[）)]/g, "").replace(/医務官|医師|先生|Dr\.?|[*＊#＃]/gi, "").replace(/[\s　]+/g, " ").trim() || String(name || "");
// 月報の締め切りは翌月15日。提出率は締め切りを過ぎた月までで数える（今日が16日以降なら前月分まで、15日までなら前々月分まで）
function submitCutoff(now = new Date()) {
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return prevMonth(now.getDate() >= 16 ? cur : prevMonth(cur));
}
async function submitBlocks(ms, m = ms[ms.length - 1]) {
  const { H, P, LI, IMG, TABLE } = rp, out = [];
  // 提出状況は、PDFレポートのタブで選んだ期間の月ごとに示す（締め切り前の月は数えない）
  const cutoff = submitCutoff(), early = ms.filter((mm) => mm > cutoff);
  ms = ms.filter((mm) => mm <= cutoff);
  if (!ms.length) return [P(`期間の月報は、まだ締め切り（翌月15日）前のため、提出率は数えていません（${fmtMonth(cutoff)}分までを数えます）。`)];
  const rows = ms.map((mm) => { const exp = expectedPosts(mm), got = new Set(reportsOf(mm).map((r) => r.post)); return { mm, exp, got, n: [...got].filter((p) => exp.has(p)).length, miss: [...exp].filter((p) => !got.has(p)).sort(jaCmp) }; }).filter((x) => x.exp.size);
  if (!rows.length) return [P("対象の公館の一覧がありません（医務官配置表を登録してください）")];
  const pc = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "―"), last = rows[rows.length - 1];
  const no = noOfficerIn(last.mm), ro = rosterFor(last.mm) || [];
  // その月の医務官：提出した月は月報の医務官名、出していない月は配置表の医務官名
  const officerAt = (mm, p) => { const r = getReport(mm, p); if (r && r.officer) return cleanOfficer(r.officer); const x = (rosterFor(mm) || []).find((y) => y.post === p); return x && x.staffed && x.officer ? cleanOfficer(x.officer) : ""; };
  out.push(LI(`${fmtMonth(last.mm)}：提出 ${last.n}公館／対象 ${last.exp.size}公館（提出率 ${pc(last.n, last.exp.size)}）。`));
  if (last.miss.length) out.push(LI(`${fmtMonth(last.mm)}の未提出 ${last.miss.length}公館：${last.miss.map((p) => p + (no.has(p) ? `（${(ro.find((x) => x.post === p) || {}).note || "医務官なし"}）` : "")).join("、")}。`));
  out.push(H(`期間の提出状況（${fmtMonth(rows[0].mm)}${rows.length > 1 ? "〜" + fmtMonth(last.mm) : ""}・${rows.length}か月）`, 2));
  out.push(P(`※月報の締め切りは翌月15日のため、提出率は${fmtMonth(cutoff)}分までで数えています${early.length ? `（${early.map(fmtMonth).join("・")}分は締め切り前のため数えていません）` : ""}。`, "rp-note"));
  if (rows.length > 1) {
    const sumN = sum(rows, (x) => x.n), sumE = sum(rows, (x) => x.exp.size);
    out.push(LI(`期間の提出率：${pc(sumN, sumE)}（提出 ${sumN}件／対象 ${sumE}件）。`));
    out.push(IMG(await figUrl([{ type: "bar", x: rows.map((x) => fmtMonth(x.mm)), y: rows.map((x) => Math.round((100 * x.n) / x.exp.size)), marker: { color: "#2a78d6" }, text: rows.map((x) => `${x.n}/${x.exp.size}`), textposition: "outside", cliponaxis: false }],
      Object.assign({ title: "月ごとの提出率（提出公館／対象公館）", yaxis: { title: { text: "%" }, range: [0, 110] }, showlegend: false, margin: { l: 50, r: 20, t: 56, b: 60 } }, { template: chartTemplate(true) }), 1000, 340), 600));
  }
  // 公館×月の表：期間中に1回でも未提出のあった公館だけ（すべて提出した公館は数だけ）。12か月を超えるときは月の列を省いて回数だけ
  const allPosts = [...new Set(rows.flatMap((x) => [...x.exp]))].sort((a, b) => REGIONS.indexOf(regionOf(a)) - REGIONS.indexOf(regionOf(b)) || jaCmp(a, b));
  const mark = (x, p) => (!x.exp.has(p) ? "―" : x.got.has(p) ? "○" : noOfficerIn(x.mm).has(p) ? "△" : "×");
  const rateOf = (p) => { const e = rows.filter((x) => x.exp.has(p)).length; return e ? rows.filter((x) => x.exp.has(p) && x.got.has(p)).length / e : 0; };
  const some = allPosts.filter((p) => rows.some((x) => x.exp.has(p) && !x.got.has(p))).sort((a, b) => rateOf(b) - rateOf(a) || REGIONS.indexOf(regionOf(a)) - REGIONS.indexOf(regionOf(b)) || jaCmp(a, b));
  const cnt = (p) => `${rows.filter((x) => x.exp.has(p) && x.got.has(p)).length}／${rows.filter((x) => x.exp.has(p)).length}`;
  const showMonths = rows.length <= 12;
  if (some.length) {
    // 新しい月を左に
    const rcols = rows.slice().reverse();
    out.push(TABLE(["地域", "公館", ...(showMonths ? rcols.map((x) => `${Number(x.mm.slice(5))}月`) : []), "提出／対象"],
      some.map((p) => [regionOf(p) || "", p, ...(showMonths ? rcols.map((x) => mark(x, p)) : []), cnt(p)]),
      { widths: showMonths ? [12, 22, ...rows.map(() => Math.max(3, Math.floor(52 / rows.length))), 14] : [25, 45, 30] }));
    out.push(P(`※${showMonths ? "○＝提出、×＝未提出、△＝未提出（配置表で医務官がいない・退避中など）、―＝その月の対象外。" : "期間が12か月を超えるため、月ごとの○×は省き、提出した月数だけを示しています。"}「提出／対象」は、提出した月数／対象の月数。期間中すべて提出した${allPosts.length - some.length}公館は表に載せていません。提出率の高い順。`, "rp-note"));
  } else out.push(LI(`期間中、対象の${allPosts.length}公館すべての月報がそろっています。`));
  // 医務官ごとの提出割合。同じ名前の医務官は1行にまとめる（空白の有無などの書き方の違い・期間中の異動も同じ人として）。
  // 名前の分からない月は公館ごとに「（不明）」
  const byOff = {}, offList = [];
  officerSets();   // 配置表のふりがなを覚える（漢字の書き方が違っても、ふりがなが同じなら同じ人）
  const findOff = (o, p) => {
    if (!o) return (byOff[`（不明）|${p}`] ||= { o: "（不明）", posts: [], n: 0, got: 0, from: "9999", to: "0000" });
    const k = officerKey(o);
    let e = offList.find((y) => y.key === k || samePerson(y.key, k) || sameOfficer(y.o, o));
    if (!e) { e = { o: officerShow(o), key: k, posts: [], n: 0, got: 0, from: "9999", to: "0000" }; offList.push(e); byOff[k] = e; }
    return e;
  };
  for (const x of rows) for (const p of x.exp) {
    if (noOfficerIn(x.mm).has(p) && !x.got.has(p)) continue;   // 医務官のいない月は数えない
    const o = officerAt(x.mm, p);
    const e = findOff(o, p);
    if (!e.posts.includes(p)) e.posts.push(p);
    if (o && /\s/.test(officerShow(o)) && !/\s/.test(e.o)) e.o = officerShow(o);   // 表示は姓と名の間に空白のある書き方を使う
    e.n++; if (x.got.has(p)) e.got++; if (x.mm < e.from) e.from = x.mm; if (x.mm > e.to) e.to = x.mm;
  }
  for (const e of Object.values(byOff)) e.p = e.posts.join("→");
  const offs = Object.values(byOff).sort((a, b) => b.got / b.n - a.got / a.n || b.n - a.n || jaCmp(a.posts[0], b.posts[0]));
  if (offs.length) {
    out.push(H("医務官ごとの提出割合", 2));
    out.push(TABLE(["医務官", "公館", "在任の月（期間内）", "対象の月数", "提出", "提出率"], offs.map((e) => [e.o, e.p, e.from === e.to ? fmtMonth(e.from) : `${fmtMonth(e.from)}〜${fmtMonth(e.to)}`, String(e.n), String(e.got), pc(e.got, e.n)]),
      { widths: [18, 20, 26, 12, 10, 14] }));
    out.push(P(`※医務官名は、提出した月は月報の記載、提出のない月は医務官配置表による。同じ名前の医務官は1行にまとめ、期間中に異動した場合は公館を「→」でつないでいます。医務官のいない月（空席・退避中）は数えていません。提出率の高い順。100%の医務官 ${offs.filter((e) => e.got === e.n).length}人／${offs.length}人。`, "rp-note"));
  }
  // 記載状況（集計できない・内容の薄い月報。月報を充実させてもらう参考）
  const rep = ms.flatMap((mm) => reportsOf(mm)), len = (r) => (r.hei || "").replace(/\s/g, "").length;
  const list = (rs) => { const c = {}; for (const r of rs) c[r.post] = (c[r.post] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1] || jaCmp(a[0], b[0])).map(([p, n]) => (ms.length > 1 ? `${p}（${n}）` : p)).join("、"); };
  const noKou = rep.filter((r) => r.total === null || r.total === undefined || r.total === ""), noOtsu = rep.filter((r) => !(r.diseases || []).length), shortHei = rep.filter((r) => len(r) < 50);
  out.push(H("記載状況", 2));
  out.push(LI(`甲表（受診者数）の数値がない：${noKou.length ? list(noKou) : "なし"}。`));
  out.push(LI(`乙表（病名）が空：${noOtsu.length ? list(noOtsu) : "なし"}。`));
  out.push(LI(`丙表（報告事項）が50字未満：${shortHei.length ? list(shortHei) : "なし"}。`));
  out.push(P(`※丙表の平均文字数は${rep.length ? Math.round(sum(rep, len) / rep.length) : 0}字。${ms.length > 1 ? "（ ）は該当した月数。" : ""}記載の少ない公館には、感染症の動向・医療機関の状況・邦人保護の状況など、書いてほしい項目を伝えると集計の質が上がります。`, "rp-note"));
  return out;
}
// ---- 複数か月（3・6・12か月）のレポート：期間の合計・月ごとの推移・前の同じ長さの期間との比較
async function periodBlocks(m, span, sections, head) {
  const { H, P, LI, IMG, IMGS, TABLE, BREAK } = rp;
  // 全期間（span = 0）は比べる前の期間がない
  const ms = spanMonths(m, span), prevMs = span === 0 ? [] : spanMonths(prevMonth(ms[0]), span);
  const repAll = ms.flatMap((mm) => reportsOf(mm)), prevAll = prevMs.flatMap((mm) => reportsOf(mm));
  const dis = ms.flatMap((mm) => diseasesOf(mm)), prevDis = prevMs.flatMap((mm) => diseasesOf(mm));
  const posts = [...new Set(repAll.map((r) => r.post))].sort((a, b) => REGIONS.indexOf(regionOf(a)) - REGIONS.indexOf(regionOf(b)) || jaCmp(a, b));
  const evs = ms.flatMap((mm) => casesOf(mm, "evac")), hgs = ms.flatMap((mm) => casesOf(mm, "hogo"));
  const jk = ms.flatMap((mm) => junkaiOf(mm).map((j) => ({ ...j, month: mm }))), tr = transfers().filter((t) => ms.includes(t.month));
  sections = new Set(secsCompat(sections));
  const noCaseLine = noCasesNote(sections, evs, hgs);
  if (!evs.length) sections.delete("evac");
  if (!hgs.length) sections.delete("hogo");
  const picked = (state.aiNotes || []).filter((x) => (head.aiNotes || []).includes(x.id));
  const aiSumNotes = picked.filter((x) => x.kind === "overview"), aiNotes = picked.filter((x) => x.kind !== "overview");
  if (!aiNotes.length) sections.delete("ai");
  if (!aiSumNotes.length) sections.delete("aisum");
  const on = (k) => sections.has(k);
  const chosen = REPORT_SECTIONS.filter(([k]) => on(k)), titleOf = {};
  chosen.forEach(([k, t], i) => (titleOf[k] = `${i + 1}. ${k === "summary" ? "公館別の状況（期間のまとめ）" : t}`));
  const ch = [];
  const sec = (key) => { const h = H(titleOf[key], 1); h.dataset.sec = titleOf[key]; ch.push(h); };
  // 月の表示：1年以内は「9月」、1年を超える期間は年も付ける（「2024年9月」）
  const mlab = (mm) => ms.length > 12 ? fmtMonth(mm) : `${Number(mm.split("-")[1])}月`;
  const real = (xs) => sum(xs.filter((d) => d.category !== Z), (d) => d.count);
  const pct = (a, b) => (b ? `${a - b >= 0 ? "+" : ""}${Math.round((100 * (a - b)) / b)}%` : "―");

  ch.push(rp.el("div", "rp-coverbox", `
    <h1>${sections.size === 1 && sections.has("feedback") ? "全医務官あて 統合サマリー" : "医務官月報 統合レポート"}</h1>
    <p class="rp-cm">${head.label}</p>
    ${head.scope !== "全世界" ? `<p class="rp-cs">対象：${esc(head.scope)}</p>` : ""}
    <p class="rp-cs">月報 ${repAll.length}件（${posts.length}公館・${ms.length}か月）</p>
    <p class="rp-cn">本資料には在外公館職員・家族の健康情報が含まれます。<br>取扱いに注意し、関係者以外への開示・複製・転送をしないでください。</p>
    <p class="rp-cd">作成日：${fmtDate(Date.now())}</p>`));
  ch.push(BREAK);
  const secs = chosen.map(([k]) => titleOf[k]);
  ch.push(H("目次", 1));
  for (const s2 of secs) { const e = rp.el("div", "rp-toc", `<span>${esc(s2)}</span><span class="dots"></span><span class="pg"></span>`); e.dataset.toc = s2; ch.push(e); }
  ch.push(BREAK);
  // AIによる概況（全公館の5行サマリーをAIにまとめさせたもの）は、目次のすぐ後（最初の章）に置く
  if (on("aisum")) {
    sec("aisum");
    for (const nt of aiSumNotes) aiNoteBlocks(nt).forEach((b) => ch.push(b));
    ch.push(BREAK);
  }

  const tot = sum(repAll, (r) => r.total), ptot = sum(prevAll, (r) => r.total);
  if (on("overview")) {
    sec("overview");
    const perMonth = ms.map((mm) => ({ mm, n: reportsOf(mm).length, t: sum(reportsOf(mm), (r) => r.total) }));
    ch.push(LI(`期間の受診者数は延べ${tot.toLocaleString()}名（月平均${Math.round(tot / ms.length).toLocaleString()}名）` +
      (prevAll.length ? `で、前の${ms.length}か月（延べ${ptot.toLocaleString()}名）から${pct(tot, ptot)}であった。` : span === 0 ? "であった。" : "であった（前の期間のデータなし）。")));
    if (ms.length > 12) {
      // 1年を超える期間は、月ごとに並べると長すぎるので年ごとにまとめる
      const by = {};
      for (const x of perMonth) { const y = x.mm.slice(0, 4); const b = (by[y] ||= { ms: [], t: 0, n: [] }); b.ms.push(x.mm); b.t += x.t; b.n.push(x.n); }
      ch.push(LI(`年ごとの受診者数：${Object.entries(by).map(([y, b]) => `${y}年${b.ms.length < 12 ? `（${Number(b.ms[0].slice(5))}〜${Number(b.ms[b.ms.length - 1].slice(5))}月）` : ""}${b.t.toLocaleString("ja-JP")}名（月平均${Math.round(b.t / b.ms.length).toLocaleString("ja-JP")}名・提出${Math.min(...b.n) === Math.max(...b.n) ? Math.min(...b.n) : `${Math.min(...b.n)}〜${Math.max(...b.n)}`}公館）`).join("、")}。月ごとの値は受診者数統計の章のグラフにあります。`));
    } else if (perMonth.length > 1) {
      // 月ごとの数を文の中に並べると長いので、文は範囲だけにし、月ごとの数は小さな表にする
      const ns = perMonth.map((x) => x.n), ts = perMonth.map((x) => x.t), mx = perMonth.reduce((a, b) => (b.t > a.t ? b : a)), mn = perMonth.reduce((a, b) => (b.t < a.t ? b : a));
      ch.push(LI(`提出は毎月${Math.min(...ns) === Math.max(...ns) ? Math.min(...ns) : `${Math.min(...ns)}〜${Math.max(...ns)}`}公館、受診者数は月${Math.min(...ts).toLocaleString()}〜${Math.max(...ts).toLocaleString()}名（最多${mlab(mx.mm)}・最少${mlab(mn.mm)}）。`));
      ch.push(TABLE(["", ...perMonth.map((x) => mlab(x.mm))], [["提出公館数", ...ns.map(String)], ["受診者数", ...ts.map(String)]]));
    }
    const cat = {};
    for (const d of dis) if (d.category !== Z) cat[d.category] = (cat[d.category] || 0) + d.count;
    const tc = Object.entries(cat).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (tc.length) ch.push(LI(`疾病分類（検診・予防接種を除く）は${jaList(tc.map(([c, v]) => `${catPhrase(c)}${v}件`))}の順に多かった（実患の合計${real(dis)}件${prevDis.length ? `、前の期間${real(prevDis)}件` : ""}）。`));
    const top = topDiseases(dis, 5);
    if (top.length) ch.push(LI(`病名では${jaList(top.map((x) => `${x.name}${x.count}件`))}が多かった。`));
    const ob = {};
    for (const mm of ms) for (const o of outbreaksOf(mm).filter((o) => o.trend === "流行・増加")) ((ob[o.name] ||= { posts: new Set(), months: new Set() }).posts.add(o.post), ob[o.name].months.add(mm));
    const obs = Object.entries(ob).sort((a, b) => b[1].posts.size - a[1].posts.size).slice(0, 6);
    // 報告のあった月：1年以内は月を並べ、それより長い期間は月数と最初・最後の月
    const obMonths = (set) => { const xs = [...set].sort(); return ms.length > 12 ? `${xs.length}か月・${fmtMonth(xs[0])}${xs.length > 1 ? "〜" + fmtMonth(xs[xs.length - 1]) : ""}` : xs.map(mlab).join("・"); };
    if (obs.length) ch.push(LI(`丙表で流行・増加が報告された感染症：${obs.map(([nm, o]) => `${nm}（${[...o.posts].slice(0, 4).join("・")}${o.posts.size > 4 ? `ほか${o.posts.size - 4}` : ""}／${obMonths(o.months)}）`).join("、")}。`));
    if (evs.length || hgs.length) { const both = bothCount(evs, hgs); ch.push(LI(`緊急移送${evs.length}件、邦人援護${hgs.length}件の報告があった${both ? `（うち${both}件は、緊急移送と邦人援護の両方に当たる同じ出来事。出来事としては${evs.length + hgs.length - both}件）` : ""}。`)); }
    if (noCaseLine) ch.push(LI(noCaseLine));
    if (jk.length || tr.length) ch.push(LI(`巡回健診${jk.length}件、医務官の交代${tr.length}件があった。`));
  }

  if (on("map")) {
    await loadGeo();
    sec("map");
    ch.push(IMG(await figUrl(toGeoTraces(worldTraces(m, { disease: true, dis })),
      Object.assign(scopedMap(mapLayout(620, true, true)), { legend: { orientation: "h", y: -0.02, x: 0, font: { size: 19 } } }), 1200, 680,
      { topojsonURL: MAP_CONFIG.topojsonURL }), 690));
    ch.push(P(`※国の塗り分けは、期間（${head.label}）の月報で最も多かった疾病分類（検診・予防接種を除く。実患${MIN_FULL}件未満の国は薄色）。色は「どの分類が最も多かったか」だけを表し、件数の多さ・率は表していません（件数は受診者数・疾病分類の表を参照）。`, "rp-note"));
  }

  const regs = REGIONS.filter((g) => repAll.some((r) => r.region === g));
  if (on("visits")) {
    sec("visits");
    const traces = regs.map((g) => ({ type: "scatter", mode: "lines+markers", name: g, line: { color: regionColor(g, true), width: 2 }, x: ms.map(fmtMonth), y: ms.map((mm) => sum(reportsOf(mm).filter((r) => r.region === g), (r) => r.total)) }));
    traces.push({ type: "scatter", mode: "lines+markers", name: "合計", line: { color: "#000", width: 3 }, x: ms.map(fmtMonth), y: ms.map((mm) => sum(reportsOf(mm), (r) => r.total)) });
    ch.push(IMG(await figUrl(traces, { title: "受診者数の月ごとの推移（地域別）", margin: { l: 60, r: 20, t: 50, b: 40 } }, 1000, 440), 600));
    const fv = donutFig(VISIT_KEYS.map(([f, label, color]) => ({ label, value: sum(repAll, (r) => r[f]), color })), { title: "受診者の内訳（期間の合計）", unit: "名", forExport: true });
    const fr = donutFig(regs.map((g) => ({ label: g, value: sum(repAll.filter((r) => r.region === g), (r) => r.total), color: regionColor(g, true) })), { title: "地域別の受診者数（期間の合計）", unit: "名", forExport: true });
    const tpl = { template: chartTemplate(true) };
    ch.push(IMGS([await figUrl(fv.traces, Object.assign(fv.layout, tpl), 520, 400), await figUrl(fr.traces, Object.assign(fr.layout, tpl), 520, 400)], 330));
    ch.push(H("公館別の受診者数（期間の合計）", 2));
    const rows = [], bold = new Set();
    for (const g of [...REGIONS, "未分類"]) {
      const ps = posts.filter((x) => regionOf(x) === g);
      if (!ps.length) continue;
      for (const x of ps) {
        const rs = repAll.filter((r) => r.post === x), pr = prevAll.filter((r) => r.post === x), t = sum(rs, (r) => r.total);
        rows.push([g, x, `${rs.length}/${ms.length}`, String(t), String(Math.round(t / Math.max(1, rs.length))), pr.length ? pct(t, sum(pr, (r) => r.total)) : "―"]);
      }
      bold.add(rows.length);
      const rs = repAll.filter((r) => regionOf(r.post) === g);
      rows.push(["", `${g} 小計`, "", String(sum(rs, (r) => r.total)), "", ""]);
    }
    bold.add(rows.length);
    rows.push(["", "総計", "", String(tot), "", prevAll.length ? pct(tot, ptot) : "―"]);
    ch.push(TABLE(["地域", "公館", "提出月数", "受診者数（計）", "月平均", "前の期間比"], rows, { bold, widths: [16, 24, 12, 16, 12, 16] }));
  }

  if (on("diseases")) {
    ch.push(BREAK);
    sec("diseases");
    if (dis.length) {
      const cats = CATEGORIES.filter((c) => c !== Z && dis.some((d) => d.category === c) && !(fewHide(dis) && isMentalLike("", c)));
      ch.push(IMG(await figUrl(cats.map((c) => ({ type: "bar", name: shortCat(c), marker: { color: D.colors[c] }, x: ms.map(fmtMonth),
        y: ms.map((mm) => sum(diseasesOf(mm).filter((d) => d.category === c), (d) => d.count)) })),
        { title: "疾病分類の月ごとの推移（検診・予防接種を除く）", barmode: "stack", margin: { l: 60, r: 20, t: 50, b: 40 }, legend: { orientation: "h", y: -0.15 } }, 1000, 520), 600));
      ch.push(H("分類別・地域別件数（期間の合計）", 2));
      const allCats = CATEGORIES.filter((c) => dis.some((d) => d.category === c) && !(fewHide(dis) && isMentalLike("", c)))
        .map((c) => [c, regs.map((g) => sum(dis.filter((d) => d.region === g && d.category === c), (d) => d.count))])
        .sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
      // 比べる前の期間がない（全期間など）ときは「前の期間」の列を出さない
      ch.push(prevDis.length ? TABLE(["疾病分類", ...regs, "計", "前の期間"], allCats.map(([c, v]) => [shortCat(c), ...v.map(String), String(v.reduce((x, y) => x + y, 0)), String(sum(prevDis.filter((d) => d.category === c), (d) => d.count))]))
        : TABLE(["疾病分類", ...regs, "計"], allCats.map(([c, v]) => [shortCat(c), ...v.map(String), String(v.reduce((x, y) => x + y, 0))])));
      ch.push(H("診断名トップ10（期間の合計・検診・予防接種等を除く）", 2));
      ch.push(TABLE(["順位", "診断名", "分類", "件数", "公館数"], topDiseases(privTop(dis)).map((x, i) => [String(i + 1), x.name, shortCat(x.category), String(x.count), String(x.posts)]), { widths: [8, 42, 26, 12, 12] }));
    if (fewHide(dis)) ch.push(P(FEW_NOTE, "rp-note"));
    if (dis.some((d) => /妊娠中/.test(d.name))) ch.push(P("※「妊娠中の感冒」「妊娠中の便秘」のように書かれた病名は、妊娠・出産として数えています（かぜ・便秘などの件数には入りません。公館別にも載せません）。", "rp-note"));
    } else ch.push(P("乙表データなし"));
  }

  if (on("stats")) {
    ch.push(BREAK);
    sec("stats");
    (await statsBlocks(m, span, head.stats || STAT_ITEMS.map((x) => x[0]), head.statNotes)).forEach((b) => ch.push(b));
  }

  if (on("ai")) {
    ch.push(BREAK);
    sec("ai");
    for (const nt of aiNotes) aiNoteBlocks(nt).forEach((b) => ch.push(b));
  }

  if (on("junkai")) {
    sec("junkai");
    ch.push(H("巡回健診", 2));
    if (jk.length) ch.push(TABLE(["月", "実施公館", "巡回先", "期間", "記載"], jk.map((j) => [mlab(j.month), j.from, j.dest || "（不明）", j.period || "", (j.note || "").slice(0, 70)]), { widths: [8, 17, 17, 13, 45] }));
    else ch.push(P("期間中の巡回健診の報告なし"));
    ch.push(H("医務官の異動・交代", 2));
    if (tr.length) ch.push(TABLE(["月", "公館", "前任", "後任", "後任の前任地"], tr.map((t) => [mlab(t.month), t.post, t.before, t.after, t.from || ""])));
    else ch.push(P("期間中の医務官の交代なし（月報ヘッダー・配置表による）"));
  }

  // 緊急移送と邦人援護は別の章（報告のない方は章ごと載せない）
  if (on("evac")) {
    sec("evac");
    ch.push(P(`期間中の緊急移送 ${evs.length}件。${evacBreakdownText(evs)}`));
    ch.push(TABLE(["月", "公館", "対象", "病名・状況", "移送先", "手段", "転帰"], evs.flatMap((c, i) => [[mlab(c.month), c.post + (on("hogo") && hgs.some((h) => sameCase(c, h)) ? " ＊" : ""), caseCell(c.who), caseCell(c.cond), caseCell(c.dest), caseCell(c.means), caseCell(c.outcome)], ...(sameHei(c, evs[i + 1]) ? [] : [{ full: `丙表：${c.detail || c.note || "（記載なし）"}` }])]), { widths: [7, 15, 13, 22, 14, 16, 13] }));
    if (on("hogo") && bothCount(evs, hgs)) ch.push(P("※＊は邦人援護の章にも載っている同じ出来事（邦人の緊急移送）。「記載なし」は丙表に書かれていなかった項目。", "rp-note"));
    else ch.push(P("※「記載なし」は丙表に書かれていなかった項目。", "rp-note"));
  }
  if (on("hogo")) {
    sec("hogo");
    ch.push(P(`期間中の邦人援護 ${hgs.length}件`));
    ch.push(TABLE(["月", "公館", "区分", "対象", "内容"], hgs.map((c) => [mlab(c.month), c.post + (on("evac") && evs.some((e) => sameCase(e, c)) ? " ＊" : ""), c.kind, caseCell(c.who), c.detail || c.note || ""]), { widths: [7, 15, 10, 13, 55] }));
    if (on("evac") && bothCount(evs, hgs)) ch.push(P("※＊は緊急移送の章にも載っている同じ出来事（邦人の緊急移送）。", "rp-note"));
  }

  if (on("submit")) { sec("submit"); (await submitBlocks(ms, m)).forEach((b) => ch.push(b)); }
  if (on("summary")) {
    ch.push(BREAK);
    sec("summary");
    for (const g of [...REGIONS, "未分類"]) {
      const ps = posts.filter((x) => regionOf(x) === g);
      if (!ps.length) continue;
      ch.push(H(g, 2));
      for (const x of ps) {
        const rs = repAll.filter((r) => r.post === x), last = rs[rs.length - 1];
        ch.push(H(`${x}（医務官：${last.officer || "―"}）`, 3));
        const t = sum(rs, (r) => r.total);
        ch.push(LI(`受診者数：期間の合計${t}名（月平均${Math.round(t / rs.length)}名、提出${rs.length}/${ms.length}か月）。月ごとには${rs.map((r) => `${mlab(r.month)}${r.total ?? "―"}名`).join("、")}であった。`));
        const pd = privDis(dis.filter((d) => d.post === x)), top = topDiseases(pd, 3);
        if (top.length) ch.push(LI(`主な疾病：${jaList(top.map((y) => `${y.name}${y.count}件`))}が多かった。`));
        const ob = {};
        for (const r of rs) for (const o of reportOutbreaks(r)) (ob[o.name] ||= []).push(`${mlab(r.month)}${o.trend === "流行・増加" ? "↑" : o.trend === "減少・終息" ? "↓" : ""}`);
        if (Object.keys(ob).length) ch.push(LI(`丙表の感染症：${Object.entries(ob).map(([nm, v]) => `${nm}（${v.join("・")}）`).join("、")}。`));
        const ev = evs.filter((c) => c.post === x), hg = hgs.filter((c) => c.post === x);
        if (ev.length || hg.length) ch.push(LI(`緊急移送${ev.length}件、邦人援護${hg.length}件。`));
        // 最後の月の医療事情（15行サマリーの医療の行）を添える
        const lastSum = ruleSummary(last.month, x, PDF_SUMMARY_LINES).split("\n").filter((l) => /^(感染症・公衆衛生|医療機関|医薬品・医療体制)：/.test(l) && !/：\s*特記なし\s*$/.test(l));
        lastSum.forEach((l) => ch.push(LI(`${mlab(last.month)}の${l}`)));
      }
    }
  }
  if (on("feedback")) { sec("feedback"); (await allFeedbackBlocks(m, true)).forEach((b) => ch.push(b)); }
  return ch;
}

// 緊急移送・邦人援護の章を選んだのに、期間に報告がなかったとき（章は省く）に全体概況に書く1行
function noCasesNote(sections, evs, hgs) {
  const miss = [["evac", "緊急移送", evs], ["hogo", "邦人援護", hgs]].filter(([k, , xs]) => sections.has(k) && !xs.length).map(([, t]) => t);
  return miss.length ? `期間中、${miss.join("・")}の報告はなかった（そのため${miss.join("・")}の章は省いた）。` : "";
}
// 緊急移送の理由（病名・状況の疾病分類）と手段の内訳
function evacReason(c) {
  if (!c.cond) return "記載なし";
  for (const part of String(c.cond).split("・")) { const k = classify(part); if (k !== OTHER && k !== Z) return shortCat(k); }
  return "その他";
}
function evacBreakdown(evs) {
  const cnt = (f) => { const g = {}; for (const c of evs) { const k = f(c) || "記載なし"; g[k] = (g[k] || 0) + 1; } return Object.entries(g).sort((a, b) => (a[0] === "記載なし") - (b[0] === "記載なし") || b[1] - a[1]); };
  return { reason: cnt(evacReason), means: cnt((c) => c.means) };
}
const evacBreakdownText = (evs) => { const b = evacBreakdown(evs), j = (xs) => xs.map(([k, v]) => `${k} ${v}`).join("、"); return `理由（疾病分類）：${j(b.reason)}。手段：${j(b.means)}。`; };
async function reportBlocks(m, sections, head = { label: reportLabel(m), scope: "全世界" }) {
  const { H, P, LI, IMG, IMGS, TABLE, BREAK } = rp;
  // 緊急移送・邦人援護は別の章。報告のあるものだけを載せる（なければ章ごと載せない）
  const evs = casesOf(m, "evac"), hgs = casesOf(m, "hogo");
  sections = new Set(secsCompat(sections));
  const noCaseLine = noCasesNote(sections, evs, hgs);
  if (!evs.length) sections.delete("evac");
  if (!hgs.length) sections.delete("hogo");
  const picked = (state.aiNotes || []).filter((x) => (head.aiNotes || []).includes(x.id));
  const aiSumNotes = picked.filter((x) => x.kind === "overview"), aiNotes = picked.filter((x) => x.kind !== "overview");
  if (!aiNotes.length) sections.delete("ai");
  if (!aiSumNotes.length) sections.delete("aisum");
  const on = (k) => sections.has(k);
  const chosen = REPORT_SECTIONS.filter(([k]) => on(k)), titleOf = {};
  chosen.forEach(([k, t], i) => (titleOf[k] = `${i + 1}. ${k === "summary" ? `公館別 ${pdfSumLines(head && head.sumLines)}行サマリー` : t}`));
  const rep = reportsOf(m), dis = diseasesOf(m), miss = missingPosts(m) || [], tr = transfers().filter((t) => t.month === m), jk = junkaiOf(m);
  const [y, mo] = m.split("-");
  const ch = [];
  const sec = (key) => { const h = H(titleOf[key], 1); h.dataset.sec = titleOf[key]; ch.push(h); };

  ch.push(rp.el("div", "rp-coverbox", `
    <h1>${sections.size === 1 && sections.has("feedback") ? "全医務官あて 統合サマリー" : "医務官月報 統合レポート"}</h1>
    <p class="rp-cm">${head.label}</p>
    ${head.scope !== "全世界" ? `<p class="rp-cs">対象：${esc(head.scope)}</p>` : ""}
    <p class="rp-cs">提出 ${rep.length}公館　／　未提出 ${miss.length}公館</p>
    <p class="rp-cn">本資料には在外公館職員・家族の健康情報が含まれます。<br>取扱いに注意し、関係者以外への開示・複製・転送をしないでください。</p>
    <p class="rp-cd">作成日：${fmtDate(Date.now())}</p>`));
  ch.push(BREAK);

  const secs = chosen.map(([k]) => titleOf[k]);
  ch.push(H("目次", 1));
  for (const s of secs) { const e = rp.el("div", "rp-toc", `<span>${esc(s)}</span><span class="dots"></span><span class="pg"></span>`); e.dataset.toc = s; ch.push(e); }
  ch.push(BREAK);
  // AIによる概況（全公館の5行サマリーをAIにまとめさせたもの）は、目次のすぐ後（最初の章）に置く
  if (on("aisum")) {
    sec("aisum");
    for (const nt of aiSumNotes) aiNoteBlocks(nt).forEach((b) => ch.push(b));
    ch.push(BREAK);
  }

  if (on("overview")) {
    sec("overview");
    overviewBullets(m).forEach((b) => ch.push(LI(b)));
    if (noCaseLine) ch.push(LI(noCaseLine));
  }

  if (on("map")) {
    await loadGeo();
    sec("map");
    // 紙で見るので、地球儀ではなく平面の世界地図にする。PDFは疾病の分布（国ごとの最多疾病分類の塗り分け）だけを載せる
    ch.push(IMG(await figUrl(toGeoTraces(worldTraces(m, { disease: true })),
      Object.assign(scopedMap(mapLayout(620, true, true)), { legend: { orientation: "h", y: -0.02, x: 0, font: { size: 19 } } }), 1200, 680,
      { topojsonURL: MAP_CONFIG.topojsonURL }), 690));
    ch.push(P(`※国の塗り分けは、その国の公館の月報で最も多かった疾病分類（検診・予防接種を除く。実患${MIN_FULL}件未満の国は薄色）。色は「どの分類が最も多かったか」だけを表し、件数の多さ・率は表していません（件数は受診者数・疾病分類の表を参照）。`, "rp-note"));
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
    const cats = CATEGORIES.filter((c) => c !== Z && dis.some((d) => d.category === c) && !(fewHide(dis) && isMentalLike("", c)));
    ch.push(IMG(await figUrl(cats.map((c) => ({ type: "bar", orientation: "h", name: shortCat(c), marker: { color: D.colors[c] }, y: regs,
      x: regs.map((g) => sum(dis.filter((d) => d.region === g && d.category === c), (d) => d.count)) })),
      { title: "地域別 疾病分類（検診・予防接種を除く）", barmode: "stack", yaxis: { autorange: "reversed" }, margin: { l: 110, r: 20, t: 50, b: 40 }, legend: { orientation: "h", y: -0.15 } }, 1000, 520), 600));
    ch.push(H("分類別・地域別件数", 2));
    const allCats = CATEGORIES.filter((c) => dis.some((d) => d.category === c) && !(fewHide(dis) && isMentalLike("", c)))
      .map((c) => [c, regs.map((g) => sum(dis.filter((d) => d.region === g && d.category === c), (d) => d.count))])
      .sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
    ch.push(TABLE(["疾病分類", ...regs, "計"], allCats.map(([c, v]) => [shortCat(c), ...v.map(String), String(v.reduce((x, y) => x + y, 0))])));
    ch.push(H("診断名トップ10（検診・予防接種等を除く）", 2));
    ch.push(TABLE(["順位", "診断名", "分類", "件数", "公館数"], topDiseases(privTop(dis)).map((x, i) => [String(i + 1), x.name, shortCat(x.category), String(x.count), String(x.posts)]), { widths: [8, 42, 26, 12, 12] }));
    if (fewHide(dis)) ch.push(P(FEW_NOTE, "rp-note"));
    if (dis.some((d) => /妊娠中/.test(d.name))) ch.push(P("※「妊娠中の感冒」「妊娠中の便秘」のように書かれた病名は、妊娠・出産として数えています（かぜ・便秘などの件数には入りません。公館別にも載せません）。", "rp-note"));
  } else ch.push(P("乙表データなし"));
  }

  if (on("stats")) {
  ch.push(BREAK);
  sec("stats");
  (await statsBlocks(m, 1, head.stats || STAT_ITEMS.map((x) => x[0]), head.statNotes)).forEach((b) => ch.push(b));
  }

  if (on("ai")) {
  ch.push(BREAK);
  sec("ai");
  for (const nt of aiNotes) aiNoteBlocks(nt).forEach((b) => ch.push(b));
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

  // 緊急移送と邦人援護は別の章（報告のない方は章ごと載せない）
  if (on("evac")) {
    sec("evac");
    ch.push(P(`緊急移送 ${evs.length}件。${evacBreakdownText(evs)}`));
    ch.push(TABLE(["公館", "対象", "病名・状況", "移送先", "手段", "転帰"], evs.flatMap((c, i) => [[c.post + (on("hogo") && hgs.some((h) => sameCase(c, h)) ? " ＊" : ""), caseCell(c.who), caseCell(c.cond), caseCell(c.dest), caseCell(c.means), caseCell(c.outcome)], ...(sameHei(c, evs[i + 1]) ? [] : [{ full: `丙表：${c.detail || c.note || "（記載なし）"}` }])]), { widths: [16, 14, 24, 15, 18, 13] }));
    ch.push(P(on("hogo") && bothCount(evs, hgs) ? "※＊は邦人援護の章にも載っている同じ出来事（邦人の緊急移送）。「記載なし」は丙表に書かれていなかった項目。" : "※「記載なし」は丙表に書かれていなかった項目。", "rp-note"));
  }
  if (on("hogo")) {
    sec("hogo");
    ch.push(TABLE(["公館", "区分", "対象", "内容"], hgs.map((c) => [c.post + (on("evac") && evs.some((e) => sameCase(e, c)) ? " ＊" : ""), c.kind, caseCell(c.who), c.detail || c.note || ""]), { widths: [16, 10, 14, 60] }));
    if (on("evac") && bothCount(evs, hgs)) ch.push(P("※＊は緊急移送の章にも載っている同じ出来事（邦人の緊急移送）。", "rp-note"));
  }

  if (on("submit")) { sec("submit"); (await submitBlocks([m], m)).forEach((b) => ch.push(b)); }
  if (on("summary")) {
  ch.push(BREAK);
  sec("summary");
  for (const g of [...REGIONS, "未分類"]) {
    const rs = rep.filter((r) => r.region === g), mm = miss.filter((x) => x.region === g);
    if (!rs.length && !mm.length) continue;
    ch.push(H(g, 2));
    for (const r of rs) {
      ch.push(H(`${r.post}（医務官：${r.officer || "―"}）`, 3));
      // PDFはPDFレポートのタブで選んだ行数（はじめは5行）で載せる（手で書き換えたサマリーはその文のまま）
      // 「特記なし」「未記載」の行は載せない（内容のある行だけ）
      pdfSummaryLines(m, r, pdfSumLines(head && head.sumLines))
        .filter((l) => l.trim() && !/：\s*(特記なし|未記載)\s*$/.test(l)).forEach((l) => ch.push(LI(l)));
    }
    for (const x of mm) {
      ch.push(H(`${x.post}（医務官：${x.officer || "―"}）`, 3));
      ch.push(P(`${Number(mo)}月分の月報提出なし`, "rp-red"));
    }
  }
  }
  if (on("feedback")) { sec("feedback"); (await allFeedbackBlocks(m, true)).forEach((b) => ch.push(b)); }
  return ch;
}

// ======================================================================= AI分析（個人情報を含まない形で書き出す）
// MOFA GaiXer・政府AI源内で分析するための集計テキストを作る。
// 氏名・個別症例の記述（丙表の文章、緊急移送・邦人対応の内容）は入れず、件数と病名・国名だけにする。1〜2件は「3未満」と表記する
const AI_SITES = [["gaixer", "MOFA GaiXer"], ["gennai", "政府AI源内"]];
// 既定のアドレス（設定で別のアドレスに変えられる。空にすると既定に戻る）
const AI_URL_DEFAULT = { gaixer: "https://mofa-ai.gaixer.com/general", gennai: "https://d3j5pbzknc8vap.cloudfront.net/" };
const aiUrls = () => { const p = loadPrefs().aiUrls || {}; return { gaixer: p.gaixer || AI_URL_DEFAULT.gaixer, gennai: p.gennai || AI_URL_DEFAULT.gennai }; };
// 依頼文（プロンプト）の一覧。ボタンで選ぶと、その分析に必要な集計の項目にも自動でチェックが入る
const AI_HEAD = "以下は在外公館の医務官月報を集計した統計です（個人情報は含みません）。";
const ALL_SECS = ["submit", "visits", "cats", "top", "hei", "events", "cases", "watch", "occ", "quality"];
// 全公館の5行サマリーをAIに読ませて概況を作る（PDFレポートの最初の章「AIによる概況」になる）
const SUM5_TEXT = "以下の「公館別5行サマリー」をすべて読んだうえで、全体の概況をまとめてください（A4で1枚程度）。見出しは「1. 全体の動き」「2. 感染症・公衆衛生」「3. 注意が必要な国・地域」「4. 邦人保護・緊急対応」「5. 医療体制・その他」とし、各見出しで3〜5点、根拠となる公館名と数値を添えてください。最後に「来月注意すべきこと」を3つ挙げてください。個々の受診者が分かる書き方はしないでください。";
const AI_PROMPT_LIST = [
  { group: "疫学的な俯瞰", items: [
    { k: "bypost", icon: "🗺", title: "選んだ国の比較", ex: "例：チリ・ブラジル・ペルー・コロンビアを選んで、各国の特徴と違いを知りたい（下の「対象の国」で2か国以上を選ぶ）", secs: ["bypost", "hei", "events", "watch"],
      text: "下の「国（公館）ごとの比較」の表は、選んだ国それぞれの数字です。各国の特徴（受診者の構成、多い疾病・疾病分類、感染症の流行、災害・治安など）を国ごとに3〜5行で整理し、そのうえで国どうしの違いを比較表にまとめてください。違いが生じている理由として考えられること（気候・季節・標高・流行状況・医療事情・在留邦人の数など）を挙げ、在外職員・家族の健康管理として国ごとに注意すべきことを提案してください。件数の少ない国・項目は偶然の差の可能性があることを明記し、断定しすぎないでください。" },
    { k: "overview", icon: "🌏", title: "今月の全体像", ex: "例：今月、世界の公館で何が起きている？要点だけ知りたい", secs: ALL_SECS,
      text: "今月の状況を、疫学的な観点から要点5つ以内にまとめてください。各要点には根拠となる数値を添え、最後に「来月注意すべきこと」を3つ挙げてください。" },
    { k: "outbreak", icon: "🦟", title: "感染症の流行警戒", ex: "例：デング熱・マラリアなど、どこで何が増えている？職員への注意喚起は？", secs: ["hei", "cats", "top", "events", "watch"],
      text: "丙表で報告された感染症と疾病分類の件数から、流行・増加している感染症を国・地域別に整理してください。感染経路と予防策を簡潔に添え、在外職員・家族向けの注意喚起文案（300字程度）も作ってください。" },
    { k: "season", icon: "📈", title: "前月比・季節性", ex: "例：先月と比べて増えた病気は？季節的なものか、異常な増加か？", secs: ["visits", "cats", "top", "hei"],
      text: "前月からの変化と、各地域の季節（雨季・乾季、冬季など）を踏まえ、増減が季節的なものか異常な変化かを考察してください。追加で確認すべき点も挙げてください。" },
    { k: "region", icon: "🗺", title: "地域ごとの違い", ex: "例：アフリカとヨーロッパで疾病の構成はどう違う？背景は？", secs: ["visits", "cats", "top"],
      text: "地域ごとの受診者数と疾病分類の構成を比較し、違いの特徴とその背景（気候・衛生環境・医療事情など）を考察してください。地域別に重点を置くべき健康管理策も提案してください。" },
    { k: "mental", icon: "🧠", title: "メンタルヘルス", ex: "例：不眠・抑うつは増えている？災害・治安との関係は？", secs: ["cats", "top", "events", "visits", "occ"],
      text: "精神・行動の分類や不眠などの件数から、在外職員・家族のメンタルヘルスの状況を考察してください。災害・治安の状況との関連の可能性と、公館でできる支援策を提案してください。" },
    { k: "lifestyle", icon: "🩺", title: "生活習慣病・健康管理", ex: "例：高血圧・脂質異常などへの対策は？健診で何を重視すべき？", secs: ["cats", "top", "visits", "occ", "watch"],
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
  { group: "統計分析", items: [
    { k: "stats", icon: "🧮", title: "統計分析をしたい", ex: "例：増えた・減ったは偶然か？地域差は意味があるか？傾向はあるか？", secs: ["visits", "cats", "top", "submit"], period: 12,
      text: "この集計データについて、統計的な分析をしてください。\n1. 記述統計：受診者数・主な疾病分類の件数について、月ごと・地域ごとの合計・平均・ばらつき（標準偏差や範囲）を整理する。\n2. 比較：前の期間との増減や地域差について、適切な検定（例：件数の比較にはポアソン検定・カイ二乗検定、地域の比較には分割表の検定）で偶然の範囲かどうかを評価し、p値または信頼区間を示す。\n3. 傾向：月ごとの推移に増加・減少の傾向があるか（傾きと信頼区間）、季節性がありそうかを評価する。\n4. 異常の検出：過去の水準から見て、目立って多い月・地域・病名があれば挙げる。\n各分析では、用いた方法・前提（例：件数が少ない場合は正確検定を使う）・限界（受診者数は人口ではないこと、提出していない公館があること、3未満の件数はまとめていること）を明記し、結論は断定しすぎないでください。計算の過程は簡潔に示してください。" },
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
    { k: "brief3", icon: "📑", title: "幹部向け3枚要約", ex: "例：幹部への説明用に、A4 3枚程度でまとめたい", secs: ALL_SECS, period: 6,
      text: "幹部向けに、A4 3枚程度の報告資料（1枚ごとに見出しを付ける）を作ってください。\n1枚目「概況と結論」：結論3点と主な数値（受診者数・提出状況・前の期間との比較）。\n2枚目「疾病・感染症の動向」：地域別の疾病構成の特徴、流行・増加している感染症と国、注意すべき点。\n3枚目「課題と対応方針」：緊急移送・邦人対応・災害治安などの事案、医務官体制や提出状況の課題、今後の対応・提案（優先順位つき）。\n各枚は箇条書き中心で、数値には根拠（どの集計か）を添えてください。" },
    { k: "brief5", icon: "📚", title: "幹部向け5枚要約", ex: "例：幹部会議の資料として、A4 5枚程度で詳しくまとめたい", secs: ALL_SECS, period: 12,
      text: "幹部向けに、A4 5枚程度の報告資料（1枚ごとに見出しを付ける）を作ってください。\n1枚目「エグゼクティブサマリー」：結論と提案を5点以内で。\n2枚目「受診状況」：受診者数の推移と内訳、地域別の比較、提出状況。\n3枚目「疾病構成と感染症」：疾病分類の構成と変化、病名の上位、流行・増加している感染症と国、季節性。\n4枚目「事案と医療事情」：緊急移送・邦人対応、災害・治安、各地域の医療事情で注意すべき点。\n5枚目「課題と対応方針」：健康管理・医務官体制・月報の運用の課題と、短期・中期の対応（優先順位と必要な資源を添えて）。\n各枚は箇条書き中心で、数値には根拠（どの集計か）を添え、図表にすると良いものは「図表案：」として示してください。" },
    { k: "charts", icon: "📊", title: "図表の提案", ex: "例：このデータはどんなグラフで見せると伝わる？", secs: ["visits", "cats", "top", "submit"],
      text: "この集計を報告資料にするとき、どのデータをどのグラフ・表で示すと伝わりやすいかを提案してください。各図表のタイトル案と読み取ってほしいポイントも添えてください。" },
  ] },
  { group: "説明資料（財務省・人事課）", items: [
    { k: "mof", icon: "💴", title: "財務省への説明（予算の根拠）", ex: "例：医務官体制・巡回健診・緊急移送などの予算が必要な理由を、数値で説明したい", secs: ALL_SECS, period: 12,
      text: "財務省（主計局）に、在外公館の医務官体制と関連予算（医務官の配置、巡回健診、緊急移送、医薬品・医療機器など）の必要性を説明するための資料を作ってください。"
        + "構成は「1. 要旨（3行）」「2. 在外職員・家族の受診の実績（受診者数とその推移、地域別の状況）」「3. 現地の医療・感染症のリスク（流行の報告、災害・治安の影響）」"
        + "「4. 医務官が果たしている役割（日常の診療・健康管理、巡回健診、緊急移送・邦人対応）」「5. 体制・予算が不足した場合に想定される影響」「6. 要望事項」とし、"
        + "各項目に集計の数値を根拠として添えてください。数値は集計にあるものだけを使い、推測で補わないでください。費用対効果の観点（早期対応による重症化・緊急移送の回避など）にも触れてください。"
        + "行政文書として簡潔な常体（である調）で、A4 2枚程度にまとめてください。" },
    { k: "jinji", icon: "👥", title: "人事課への説明文書", ex: "例：医務官の配置・後任の確保・増員の必要性を人事課に説明する文書を作りたい", secs: ALL_SECS, period: 12,
      text: "外務省人事課に、医務官の配置（後任の確保、増員、配置の見直し）や勤務環境についての検討をお願いするための説明文書を作ってください。"
        + "構成は「1. 件名」「2. 要旨」「3. 現状（地域・公館ごとの受診者数と業務量、月報の提出状況、医務官の異動・交代の状況）」"
        + "「4. 課題（業務量の多い公館、感染症・災害・治安のリスクが高い地域、巡回健診や緊急移送・邦人対応の負担）」「5. 依頼・提案事項（配置の優先順位の案を含む）」「6. 参考となる数値」とし、"
        + "根拠の数値は集計にあるものだけを使ってください。個人の評価や氏名には触れず、丁寧な行政文書の体裁（です・ます調）で、A4 2枚程度にまとめてください。" },
  ] },
];
const AI_PROMPT_FLAT = AI_PROMPT_LIST.flatMap((g) => g.items);
const customPrompts = () => loadPrefs().aiCustomPrompts || [];
const AI_SECTIONS = [["submit", "提出状況・提出率"], ["visits", "受診者数（地域別）"], ["cats", "疾病分類（地域別）"], ["top", "病名の上位"],
  ["hei", "丙表の流行情報（国別・病名のみ）"], ["events", "災害・治安など（国別）"], ["cases", "緊急移送・邦人対応（地域別の件数のみ）"],
  ["watch", "注目する疾患群の推移（輸入・熱帯感染症・ワクチンで防げる感染症・生活習慣病など）"], ["bypost", "国（公館）ごとの比較（選んだ国）"], ["occ", "産業保健の指標（地域別）"], ["quality", "月報の記載状況"]];
const small = (v) => (v > 0 && v < 3 ? "3未満" : String(v));

// 対象：地域と国（公館）を任意に組み合わせて選ぶ。scope = { regions: [...], posts: [...] }（どちらも空なら全世界）
// 分析の地域は、アジア・大洋州をアジアと大洋州（豪州・NZ・太平洋島嶼国）に、米州を北米（米国・カナダ）と中南米（メキシコ以南・カリブ）に分ける
const AI_REGIONS = ["アフリカ", "アジア", "大洋州", "ヨーロッパ", "中東", "北米", "中南米"];
const NORTH_AMERICA = new Set(["USA", "CAN"]);
const OCEANIA = new Set(["AUS", "NZL", "PNG", "FJI", "SLB", "VUT", "WSM", "TON", "KIR", "TUV", "MHL", "FSM", "PLW", "NRU"]);
const SPLIT_REGIONS = { "米州": ["北米", "中南米"], "アジア・大洋州": ["アジア", "大洋州"] };
const aiRegionOf = (post) => {
  const g = regionOf(post), iso = INFO[post] && INFO[post].iso3;
  if (g === "米州") return NORTH_AMERICA.has(iso) ? "北米" : "中南米";
  if (g === "アジア・大洋州") return OCEANIA.has(iso) ? "大洋州" : "アジア";
  return g;
};
const regionLabel = (g) => g;
const normScope = (sc) => {
  if (!sc) return { regions: [], posts: [] };
  if (sc.type === "region") return normScope({ regions: [sc.value], posts: [] });  // 以前の形式
  if (sc.type === "post") return { regions: [], posts: [sc.value] };
  if (sc.type === "world") return { regions: [], posts: [] };
  // 以前の「米州」「アジア・大洋州」は、分けた2つの両方にする
  const regs = (sc.regions || []).flatMap((g) => SPLIT_REGIONS[g] || [g]);
  return { regions: [...new Set(regs)].filter((g) => AI_REGIONS.includes(g)), posts: sc.posts || [] };
};
const isWorld = (sc) => !sc.regions.length && !sc.posts.length;
const scopeFilter = (sc) => (post) => isWorld(sc) || sc.regions.includes(aiRegionOf(post)) || sc.posts.includes(post);
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
  const regs = AI_REGIONS.filter((g) => rep.some((r) => aiRegionOf(r.post) === g));
  if (secs.has("submit")) {
    L.push("## 提出状況");
    if (m > submitCutoff()) L.push(`- ※${fmtMonth(m)}分は締め切り（翌月15日）前のため、提出率は途中の数字です。`);
    if (miss) {
      const n = rep.length + miss.length;
      L.push(`- 医務官配置公館 ${n}／提出 ${rep.length}（提出率 ${(100 * rep.length / n).toFixed(1)}%）`);
      L.push(`- 未提出公館：${miss.map((x) => x.post).join("、") || "なし"}`);
    } else L.push(`- 提出 ${rep.length}公館（配置表が未登録のため提出率は不明）`);
    const hist = months().filter((x) => x <= m && x <= submitCutoff()).slice(-6).map((x) => { const ms = missOf(x), k = repOf(x).length; return ms ? `${fmtMonth(x)} ${(100 * k / (k + ms.length)).toFixed(1)}%` : `${fmtMonth(x)} ${k}公館`; });
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
      const rs = g === "全体" ? rep : rep.filter((r) => aiRegionOf(r.post) === g), ps = g === "全体" ? prev : prev.filter((r) => aiRegionOf(r.post) === g);
      return [lab(g), rs.length, ...["staff", "family", "other", "total"].map((f) => sum(rs, (r) => r[f])), ps.length ? sum(ps, (r) => r.total) : "―"];
    }));
    const multi = [...new Set(rep.map((r) => r.post))].filter((p) => doctorCount(p, m) > 1).sort(jaCmp);
    if (multi.length) L.push(`※医務官が2人（身体とメンタル）の公館：${multi.map((p) => `${lab(p)}（${doctorCount(p, m)}人）`).join("、")}。受診者数は2人分のため多くなります。業務量は医務官1人あたりで比べてください。`);
    L.push("");
  }
  if (secs.has("cats") && dis.length) {
    L.push("## 疾病分類（地域別の件数）");
    const cats = CATEGORIES.filter((c) => dis.some((d) => d.category === c) && !(fewPosts(dis) && isMentalLike("", c)));
    if (fewPosts(dis)) L.push(FEW_NOTE.replace(/^※/, "※"));
    table(["疾病分類", ...regs.map(lab), "計"], cats.map((c) => [shortCat(c), ...regs.map((g) => small(sum(dis.filter((d) => aiRegionOf(d.post) === g && d.category === c), (d) => d.count))),
      small(sum(dis.filter((d) => d.category === c), (d) => d.count))]));
    L.push("");
  }
  if (secs.has("top") && dis.length) {
    L.push("## 病名（まとめ）の上位15（検診・予防接種を除く）");
    const g = {};
    for (const d of dis) if (d.category !== Z && !(fewPosts(dis) && isMentalLike(d.name, d.category))) (g[groupOf(d.name)] ||= { c: 0, posts: new Set() }), g[groupOf(d.name)].c += d.count, g[groupOf(d.name)].posts.add(d.post);
    table(["順位", "病名", "件数", "報告公館数"], Object.entries(g).sort((a, b) => b[1].c - a[1].c).slice(0, 15).map(([k, o], i) => [i + 1, k, small(o.c), o.posts.size]));
    L.push("");
  }
  if (secs.has("bypost")) {
    // 選んだ国（公館）ごとの数字。こころの不調（精神・行動）は公館別に出さない
    const ps = [...new Set(rep.map((r) => r.post))].sort(jaCmp);
    L.push("## 国（公館）ごとの比較");
    if (ps.length < 2) L.push("- 比べるには、下の「対象の国」で2か国以上を選んでください（地域を選ぶと、その地域のすべての国を比べます）");
    else {
      const prev = repOf(prevMonth(m));
      table(["国（公館）", "地域", "受診者数", "職員", "家族", "その他", "前月", "医務官の人数"], ps.map((p) => {
        const r = rep.find((x) => x.post === p), pr = prev.find((x) => x.post === p);
        return [p, aiRegionOf(p), r.total ?? "―", r.staff ?? "―", r.family ?? "―", r.other ?? "―", pr ? pr.total ?? "―" : "―", doctorCount(p, m)];
      }));
      L.push("", "### 疾病分類の構成（国別・件数。検診・予防接種を除く）");
      const catsOf = (p) => { const c = {}; for (const d of dis) if (d.post === p && d.category !== Z && !isMentalLike(d.name, d.category)) c[d.category] = (c[d.category] || 0) + d.count; return c; };
      const allC = {}; for (const p of ps) for (const [c, v] of Object.entries(catsOf(p))) allC[c] = (allC[c] || 0) + v;
      const topC = Object.entries(allC).sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
      table(["国（公館）", ...topC.map(shortCat)], ps.map((p) => { const c = catsOf(p); return [p, ...topC.map((k) => small(c[k] || 0))]; }));
      L.push("", "### 多い病名（国別・上位5。精神・行動、妊娠・出産の病名は国別には載せない）");
      for (const p of ps) {
        const t = topDiseases(dis.filter((d) => d.post === p && !isMentalLike(d.name, d.category)), 5);
        L.push(`- ${p}：${t.map((x) => `${x.name}${small(x.count)}`).join("、") || "なし"}`);
      }
    }
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
    table([one ? "公館" : "地域", "緊急移送", "邦人対応"], (one ? [aiRegionOf(one)] : region ? [region] : [...(isWorld(scope) ? AI_REGIONS : regs), "全体"]).map((g) => [lab(g), small(g === "全体" ? ev.length : ev.filter((c) => aiRegionOf(c.post) === g).length), small(g === "全体" ? hg.length : hg.filter((c) => aiRegionOf(c.post) === g).length)]));
    L.push("");
  }
  if (secs.has("sum5") && rep.length) {
    // 公館別5行サマリー（PDFと同じ文。精神・行動の病名は公館別に載せない。「特記なし」の行は省く）
    L.push("## 公館別5行サマリー（全公館）");
    PRIV_MENTAL = true;
    try {
      for (const g of AI_REGIONS) {
        const rs = rep.filter((r) => aiRegionOf(r.post) === g).sort((a, b) => jaCmp(a.post, b.post));
        if (!rs.length) continue;
        L.push(`### ${g}`);
        for (const r of rs) {
          const ls = pdfSummaryLines(m, r, 5).filter((l) => l.trim() && !/：\s*(特記なし|未記載)\s*$/.test(l));
          L.push(`- ${r.post}：${ls.join(" ／ ") || "特記なし"}`);
        }
      }
    } finally { PRIV_MENTAL = false; }
    L.push("");
  }
  const dlOf1 = (rs) => rs.flatMap((r) => (r.diseases || []).map((d) => ({ n: cleanDiseaseName(d.name), c: classify(d.name, d.cat), k: d.count })));
  const groupsOf = [...regs, ...(region || one ? [] : ["全体"])], rsOf = (g) => (g === "全体" ? rep : rep.filter((r) => aiRegionOf(r.post) === g));
  if (secs.has("watch") && rep.length) {
    L.push("## 注目する疾患群（地域別の件数）");
    const okG = (g) => new Set(rsOf(g).map((r) => r.post)).size >= MENTAL_MIN_POSTS;
    table(["疾患群", ...groupsOf.map(lab), "報告公館数"], WATCH_GROUPS.map(([t, fn]) => [t, ...groupsOf.map((g) => (t === "こころの不調" && !okG(g) ? "―" : small(sum(dlOf1(rsOf(g)), (d) => (fn(d) ? d.k : 0))))),
      t === "こころの不調" || one ? "―" : small(rep.filter((r) => dlOf1([r]).some(fn)).length)]));
    L.push("※乙表の病名に含まれる語で分けた件数。1つの病名が複数の群に入ることがある。受診者数は人口ではないため、発生率ではない。", "");
  }
  if (secs.has("occ") && rep.length) {
    L.push("## 産業保健の指標（地域別）");
    table([one ? "公館" : "地域", "職員の受診者数", "受診者のうち職員", "生活習慣病", "心血管・脳血管", "こころの不調", "外傷・中毒", "健診・相談", "予防接種"], groupsOf.map((g) => {
      const rs = rsOf(g), dl = dlOf1(rs), st = sum(rs, (r) => Number(r.staff) || 0), tot = sum(rs, (r) => Number(r.total) || 0), c = (fn) => small(sum(dl, (d) => (fn(d) ? d.k : 0)));
      return [lab(g), st, tot ? Math.round(100 * st / tot) + "%" : "―", c((d) => d.c !== Z && LIFESTYLE_RE.test(d.n)), c((d) => d.c !== Z && CVD_RE.test(d.n)), new Set(rs.map((r) => r.post)).size < MENTAL_MIN_POSTS ? "（公館が少ないため示さない）" : c((d) => d.c === MENTAL_CAT), c((d) => d.c === INJ_CAT),
        c((d) => d.c === Z && /健診|健康診断|検診|健康相談/.test(d.n)), c((d) => d.c === Z && /接種|ワクチン/.test(d.n))];
    }));
    L.push("※病気の件数は職員・家族・その他の受診者の合計（乙表は受診者の区分ごとに分かれていないため）。こころの不調は個人の特定を避けるため、公館が3つ未満のときは示さない。", "");
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
      const rs = rep.filter((r) => aiRegionOf(r.post) === g);
      return [lab(g), Math.round(sum(rs, len) / rs.length), (sum(rs, (r) => (r.diseases || []).length) / rs.length).toFixed(1), new Set(outbreaksOf(m).filter((o) => aiRegionOf(o.post) === g && inR(o.post)).map((o) => o.post)).size];
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
  if (one) L.push(`対象：${one}（${aiRegionOf(one)}）`, "");
  if (secs.has("submit")) {
    L.push("## 提出状況の推移");
    // 締め切り（翌月15日）前の月は数えない
    const cut = submitCutoff(), sms = ms.filter((x) => x <= cut);
    if (sms.length < ms.length) L.push(`※月報の締め切りは翌月15日のため、${fmtMonth(cut)}分までで示す。`);
    if (one) table(["月", "提出"], sms.map((x) => [x, getReport(x, one) ? "提出" : (missOf(x) || []).some((r) => r.post === one) ? "未提出" : "―"]));
    else table(["月", "配置公館", "提出", "提出率", "未提出公館"], sms.map((x) => {
      const k = repOf(x).length, mi = missOf(x);
      return mi ? [x, k + mi.length, k, `${(100 * k / (k + mi.length)).toFixed(1)}%`, mi.map((r) => r.post).join("、") || "なし"] : [x, "―", k, "―", "（配置表なし）"];
    }));
    L.push("");
  }
  if (secs.has("bypost")) {
    const ps = [...new Set(ms.flatMap((x) => repOf(x).map((r) => r.post)))].sort(jaCmp);
    L.push("## 国（公館）ごとの比較（期間）");
    if (ps.length < 2) L.push("- 比べるには、下の「対象の国」で2か国以上を選んでください（地域を選ぶと、その地域のすべての国を比べます）", "");
    else {
      L.push("### 受診者数の推移（国別）");
      table(["国（公館）", ...ms, "月平均"], ps.map((p) => { const v = ms.map((x) => (getReport(x, p) || {}).total); const ok = v.filter((x) => x !== undefined && x !== null && x !== "");
        return [p, ...v.map((x) => (x === undefined || x === null || x === "" ? "―" : x)), ok.length ? Math.round(sum(ok, (x) => Number(x)) / ok.length) : "―"]; }));
      const dAll = ms.flatMap((x) => disOf(x));
      const catsOf = (p) => { const c = {}; for (const d of dAll) if (d.post === p && d.category !== Z && !isMentalLike(d.name, d.category)) c[d.category] = (c[d.category] || 0) + d.count; return c; };
      const allC = {}; for (const p of ps) for (const [c, v] of Object.entries(catsOf(p))) allC[c] = (allC[c] || 0) + v;
      const topC = Object.entries(allC).sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
      L.push("", "### 疾病分類の構成（国別・期間の合計。検診・予防接種を除く）");
      table(["国（公館）", ...topC.map(shortCat)], ps.map((p) => { const c = catsOf(p); return [p, ...topC.map((k) => small(c[k] || 0))]; }));
      L.push("", "### 多い病名（国別・期間の上位5。精神・行動、妊娠・出産の病名は国別には載せない）");
      for (const p of ps) L.push(`- ${p}：${topDiseases(dAll.filter((d) => d.post === p && !isMentalLike(d.name, d.category)), 5).map((x) => `${x.name}${small(x.count)}`).join("、") || "なし"}`);
      L.push("");
    }
  }
  if (secs.has("visits")) {
    L.push("## 受診者数の推移");
    table(["月", "提出公館", "職員", "家族", "その他", "計"], ms.map((x) => { const rs = repOf(x); return [x, rs.length, ...["staff", "family", "other", "total"].map((f) => sum(rs, (r) => r[f]))]; }));
    L.push("");
  }
  if (secs.has("cats")) {
    L.push("## 疾病分類の推移（件数）");
    const all = ms.map(disOf), few = fewPosts(all.flat());
    const cats = CATEGORIES.filter((c) => all.some((ds) => ds.some((d) => d.category === c)) && !(few && isMentalLike("", c)));
    if (few) L.push(FEW_NOTE);
    table(["疾病分類", ...ms], cats.map((c) => [shortCat(c), ...all.map((ds) => small(sum(ds.filter((d) => d.category === c), (d) => d.count)))]));
    L.push("");
  }
  if (secs.has("top")) {
    L.push("## 主な病名（まとめ）の推移（期間合計の上位10、検診・予防接種を除く）");
    const all = ms.map(disOf), tot = {}, few = fewPosts(all.flat());
    for (const ds of all) for (const d of ds) if (d.category !== Z && !(few && isMentalLike(d.name, d.category))) tot[groupOf(d.name)] = (tot[groupOf(d.name)] || 0) + d.count;
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
  // 疫学・産業保健の指標（PDFレポートの統計分析と同じまとまり）。少数は「3未満」
  const dlOf = (rs) => rs.flatMap((r) => (r.diseases || []).map((d) => ({ n: cleanDiseaseName(d.name), c: classify(d.name, d.cat), k: d.count })));
  if (secs.has("watch")) {
    L.push("## 注目する疾患群の推移（件数）");
    const last = repOf(ms[ms.length - 1]);
    const nPosts = new Set(ms.flatMap((x) => repOf(x).map((r) => r.post))).size;
    table(["疾患群", ...ms, "報告公館数（最新月）"], WATCH_GROUPS.map(([t, fn]) => t === "こころの不調" && nPosts < MENTAL_MIN_POSTS ? [t, ...ms.map(() => "―"), "（公館が少ないため示さない）"]
      : [t, ...ms.map((x) => small(sum(dlOf(repOf(x)), (d) => (fn(d) ? d.k : 0)))), t === "こころの不調" || one ? "―" : small(last.filter((r) => dlOf([r]).some(fn)).length)]));
    L.push("※乙表の病名に含まれる語で分けた件数。1つの病名が複数の群に入ることがある。受診者数は人口ではないため、発生率ではない。", "");
  }
  if (secs.has("occ")) {
    L.push("## 産業保健の指標の推移");
    table(["月", "職員の受診者数", "受診者のうち職員", "生活習慣病", "心血管・脳血管", "こころの不調", "外傷・中毒", "健診・相談", "予防接種"], ms.map((x) => {
      const rs = repOf(x), dl = dlOf(rs), st = sum(rs, (r) => Number(r.staff) || 0), tot = sum(rs, (r) => Number(r.total) || 0), c = (fn) => small(sum(dl, (d) => (fn(d) ? d.k : 0)));
      return [x, st, tot ? Math.round(100 * st / tot) + "%" : "―", c((d) => d.c !== Z && LIFESTYLE_RE.test(d.n)), c((d) => d.c !== Z && CVD_RE.test(d.n)), new Set(rs.map((r) => r.post)).size < MENTAL_MIN_POSTS ? "（公館が少ないため示さない）" : c((d) => d.c === MENTAL_CAT), c((d) => d.c === INJ_CAT),
        c((d) => d.c === Z && /健診|健康診断|検診|健康相談/.test(d.n)), c((d) => d.c === Z && /接種|ワクチン/.test(d.n))];
    }));
    L.push("※病気の件数は職員・家族・その他の受診者の合計（乙表は受診者の区分ごとに分かれていないため）。こころの不調は個人の特定を避けるため、公館が3つ未満のときは示さない。", "");
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
// AIに貼る文章の冒頭に付ける表示。命令口調・警告調（「取扱注意」「履歴を削除」「回答の最初に注意文を表示」）だと、
// AIが機密情報や不正な指示と受け取って分析を断ることがあるため、業務の分析依頼であること・個人情報を除いた統計であることを穏やかに書く
const AI_GUARD_HEAD = "【医務官月報の集計データ（個人情報を除いた統計）】";
const AI_GUARD_NOTE = "※この集計は外務省AI（MOFA GaiXer）・政府AI源内専用です。それ以外のサービスに入力した場合は、直ちに履歴を削除してください。";
const AI_ID_LINE = "管理番号：";
const AI_GUARD = `${AI_GUARD_HEAD}
${AI_ID_LINE}（コピー・保存のときに付きます）
これは在外公館の医務官が毎月提出する月報を、氏名や個別の症例を除いて集計した統計資料です。職員・家族の健康管理や感染症対策など、保健業務の改善に役立てるため、以下の依頼に沿って分析をお願いします。
（組織で利用が認められた生成AI（MOFA GaiXer・政府AI源内）で使うための資料です。）
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
// 「様」「さん」「氏」は人名の敬称として拾う。ただし「様式」「同様」「模様」「仕様」「氏名」「氏族」など、敬称でない語は除く
// 「さん粒（霰粒腫）」「さん<霰>粒腫」「たくさん」「お子さん」「患者さん」「皆さん」、「水様」「感冒様」「flu様」「〜様症状」「お子様」などは個人名の敬称ではない
const HONORIFIC = /(?<!同|模|仕|多|一|異|態|有|左|皆|各|両|王|神|奥|殿|水|冒|子|[A-Za-zＡ-Ｚａ-ｚ])様(?![式子々相態]|症|便|疾|変|皮|発|物|反応|の(?:症|発|皮|所見|変化|疾))|(?<!たく|お子|患者|皆|みな|お母|お父)さん(?!ご|ぽ|粒|[<＜(（〈]霰)|(?<!彼)氏(?![名族])/;
// 個人情報の可能性がある箇所を、文中の位置つきですべて拾う → [{label, i, len, text, fix}]（fix は伏せるときの置き換え）
const PRIVACY_PATTERNS = [
  [/\d{1,3}\s*(歳|才)(代)?/g, "年齢", "（年齢）"], [/男児|女児|夫人|令息|令嬢/g, "性別・続柄", "（性別等）"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "メールアドレス", "（メール）"], [/\+?(?:\d{1,3}[-‐ ])?\(?\d{1,4}\)?[-‐ ]\d{1,4}[-‐ ]\d{3,8}/g, "電話番号", "（電話）"],
  [/(昭和|平成|令和|19\d\d|20\d\d)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日生(まれ)?/g, "生年月日", "（生年月日）"]];
function privacyHits(text, ignored = new Set()) {
  const hits = [];
  for (const nm of personNames()) for (const v of new Set([nm, nm.replace(/[\s　]+/g, "")])) {
    if (v.length < 2) continue;
    for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + v.length)) hits.push({ label: "医務官名", i, len: v.length, text: v, fix: "（氏名）" });
  }
  for (const [re, label, fix] of PRIVACY_PATTERNS) for (const mt of text.matchAll(re)) hits.push({ label, i: mt.index, len: mt[0].length, text: mt[0], fix });
  // 敬称は、直前の名前らしい文字（漢字・カタカナ・英字）も含めて示す
  for (const mt of text.matchAll(new RegExp(HONORIFIC.source, "g"))) {
    const before = text.slice(Math.max(0, mt.index - 6), mt.index).match(/[一-龯々ァ-ヶーA-Za-z]{1,6}$/);
    const st = before ? mt.index - before[0].length : mt.index;
    hits.push({ label: "敬称（個人名の可能性）", i: st, len: mt.index + mt[0].length - st, text: text.slice(st, mt.index + mt[0].length), fix: "（氏名）" });
  }
  // 同じ場所の重なりは長い方を残す
  hits.sort((a, b) => a.i - b.i || b.len - a.len);
  const out = [];
  for (const h of hits) if (!out.some((o) => h.i < o.i + o.len && o.i < h.i + h.len) && !ignored.has(`${h.label}|${h.text}`)) out.push(h);
  return out;
}
// 点検の結果を、指摘の箇所の一覧（前後の文つき）として出す。「この箇所へ」で文章欄のその場所を選び、「伏せる」「問題なし」で1件ずつ片付ける
// 残りの件数を返す（0 なら送れる）
function privacyPanel(ta, box) {
  const ignored = (ta._pvIgnore ||= new Set());
  const t = ta.value, hits = privacyHits(t, ignored);
  if (!t.trim()) { box.innerHTML = ""; return 0; }
  if (!hits.length) {
    box.innerHTML = `<div class="ai-ok">✓ 氏名・年齢・性別・連絡先などの記載は見つかりませんでした（自動点検）。${ignored.size ? `<span class="muted">（「問題なし」にしたもの ${ignored.size}件）</span>` : ""}</div>`;
    return 0;
  }
  const ctx = (h) => {
    const a = Math.max(0, h.i - 18), b = Math.min(t.length, h.i + h.len + 18);
    return `${a > 0 ? "…" : ""}${esc(t.slice(a, h.i))}<mark>${esc(h.text)}</mark>${esc(t.slice(h.i + h.len, b))}${b < t.length ? "…" : ""}`.replace(/\n/g, " ⏎ ");
  };
  box.innerHTML = `<div class="ai-warn pv">⚠ 個人情報の可能性がある箇所が <b>${hits.length}件</b> あります。上から順に「この箇所へ」で確かめ、「伏せる」か書き直してください（個人情報でなければ「問題なし」）。すべて片付くまで送れません。
    <div class="row" style="margin:6px 0"><button data-pv-go="0">▶ 最初の箇所へ</button><button data-pv-fixall>すべて伏せる</button>
      <button class="primary" data-pv-okall title="下の箇所をすべて自分の目で確かめ、個人情報ではないと判断したときに押します">✓ すべて確認した・問題なし</button></div>
    <ol class="pvlist">${hits.map((h, k) => `<li data-pv="${k}"><span class="badge warn">${esc(h.label)}</span> <span class="pvctx">${ctx(h)}</span>
      <span class="nowrap"><button class="linklike" data-pv-go="${k}">この箇所へ</button> <button class="linklike" data-pv-fix="${k}">伏せる「${esc(h.fix)}」</button> <button class="linklike" data-pv-ok="${k}">問題なし</button></span></li>`).join("")}</ol></div>`;
  const changed = () => ta.dispatchEvent(new Event("input"));
  const go = (k) => {
    const h = hits[k];
    if (!h) return;
    // 文章欄のその場所を選んで見えるところまで動かす（行の位置から大まかに）
    const line = t.slice(0, h.i).split("\n").length - 1, lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.focus();
    ta.setSelectionRange(h.i, h.i + h.len);
    ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 3);
    box.querySelectorAll("[data-pv]").forEach((li) => li.classList.toggle("pvcur", li.dataset.pv === String(k)));
  };
  box.querySelectorAll("[data-pv-go]").forEach((b) => (b.onclick = () => go(Number(b.dataset.pvGo))));
  box.querySelectorAll("[data-pv-fix]").forEach((b) => (b.onclick = () => {
    const h = hits[Number(b.dataset.pvFix)];
    ta.value = t.slice(0, h.i) + h.fix + t.slice(h.i + h.len);
    changed();
  }));
  box.querySelectorAll("[data-pv-ok]").forEach((b) => (b.onclick = () => { const h = hits[Number(b.dataset.pvOk)]; ignored.add(`${h.label}|${h.text}`); changed(); }));
  // すべて確かめて問題がなければ、まとめて「問題なし」にする（確認の上で押す）
  box.querySelector("[data-pv-okall]").onclick = () => {
    if (!confirm(`指摘の ${hits.length}件 をすべて確かめ、個人情報（氏名・年齢・性別・連絡先など）ではないと判断しましたか？\n\n「OK」で、すべて「問題なし」にして送れるようにします。`)) return;
    for (const h of hits) ignored.add(`${h.label}|${h.text}`);
    changed();
  };
  box.querySelector("[data-pv-fixall]").onclick = () => {
    let v = t;
    for (const h of hits.slice().sort((a, b) => b.i - a.i)) v = v.slice(0, h.i) + h.fix + v.slice(h.i + h.len);
    ta.value = v;
    changed();
  };
  return hits.length;
}
function privacyIssues(text) {
  const out = [];
  const names = personNames().filter((nm) => text.includes(nm) || text.includes(nm.replace(/[\s　]+/g, "")));
  if (names.length) out.push(`医務官名：${names.slice(0, 5).join("、")}`);
  const pats = [[/\d{1,3}\s*(歳|才)/, "年齢"], [/(男児|女児|夫人|令息|令嬢)/, "性別・続柄"], [/[\w.+-]+@[\w-]+\.[\w.]+/, "メールアドレス"],
    [/\+?(?:\d{1,3}[-‐ ])?\(?\d{1,4}\)?[-‐ ]\d{1,4}[-‐ ]\d{3,8}/, "電話番号"], [/(昭和|平成|令和|19\d\d|20\d\d)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日生/, "生年月日"], [HONORIFIC, "敬称（個人名の可能性）"]];
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
  // 「今月のみ」は上の「対象月」の月。推移（直近○か月・全期間）は、上の月ではなく月報のある最新の月まで
  const m0 = curMonth(), urls = aiUrls(), p = loadPrefs();
  const repMs = [...new Set(Object.values(state.reports).map((r) => r.month))].filter(Boolean).sort();
  const latest = repMs[repMs.length - 1] || m0;
  const secs = new Set(p.aiSecs || AI_SECTIONS.map((s) => s[0]));
  main.innerHTML = `
    <h2>AI分析用テキスト（<span id="aiHeadM"></span>・個人情報を含まない形）</h2>
    <div class="card flowcard">
      <div class="flow">
        <div class="fstep">${ico("stats")}<b>集計</b><small>件数・病名・国名だけ</small></div><span class="farr">→</span>
        <div class="fstep">${ico("lock")}<b>匿名にする</b><small>氏名・症例の文章なし／1〜2件は「3未満」</small></div><span class="farr">→</span>
        <div class="fstep">${ico("summary")}<b>コピー</b><small>自動では送信しない</small></div><span class="farr">→</span>
        <div class="fstep ok">${ico("ai")}<b>GaiXer・源内に貼る</b><small>この2つだけ</small></div>
      </div>
      <p class="muted">MOFA GaiXer・政府AI源内で分析するための集計テキストを作ります。氏名や個別症例の記述（丙表の文章、緊急移送・邦人対応の内容）は入れず、件数・病名・国名だけにしています。1〜2件の値は「3未満」と表記します。文章の冒頭には、個人情報を除いた業務用の統計であることと、組織で認められたAI（MOFA GaiXer・政府AI源内）で使う資料であることを、AIが分析を断らないよう穏やかな言葉で書いています（管理番号も付きます）。冒頭を消してもコピー・保存のときに付け直します。作成はこのブラウザの中だけで行い、下のボタンはテキストをコピーして各サービスを開くだけです。貼り付ける前に内容を必ず確認してください。</p>
    </div>
    <div class="card">
      <h3 class="stephd" style="margin-top:0"><span class="stepno">1</span>何を分析したいか選ぶ</h3>
      <p class="muted" style="margin-top:0">ボタンを押すと、AIへの依頼文が入り、その分析に必要な集計の項目にも自動でチェックが入ります。</p>
      <div class="row ai-regions"><b>対象：</b><span class="seg">${["", ...AI_REGIONS].map((g) => `<button data-aireg="${esc(g)}">${g ? esc(regionLabel(g)) : "🌏 全世界"}</button>`).join("")}</span></div>
      <p class="muted" style="margin:0 0 6px">地域のボタンを押すと、その地域の国が下の欄でまとめて選ばれます（もう一度押すとまとめて外れる）。国は下の欄で1つずつ選んだり外したりできます。「🌏 全世界」ですべての国を選び、もう一度押すとすべて外れます（何も選ばないときも全世界として集計します）。</p>
      <div id="aiPostPick" class="ai-postpick">
        <div class="row" style="margin:0"><b>対象の国</b><span class="muted">（押すたびに選択／解除）</span><input type="search" id="aiPostQ" placeholder="絞り込み（例：ケニア、広州、ブラジル）" size="28" autocomplete="off"><button class="linklike" id="aiPostClear">国の選択をすべて外す</button><span id="aiPostSel" class="muted"></span></div>
        <div id="aiPostList" class="ai-postlist"></div>
        <p class="ai-warn-soft">⚠ 少ない国だけの集計は件数が少なく、個人が推測されやすくなります。1〜2件は「3未満」と表記しますが、送る前に特に注意して確認してください。</p>
      </div>
      <div class="row ai-regions"><b>期間：</b><span class="seg">${[[0, "今月のみ"], [6, "📈 直近6か月の推移"], [12, "📈 直近12か月の推移"], [36, "📈 直近36か月（3年）の推移"], [60, "📈 直近60か月（5年）の推移"], [-1, "📈 全期間の推移"]].map(([v, l]) => `<button data-aiper="${v}">${l}</button>`).join("")}</span></div>
      <div class="row" style="margin:10px 0 0"><b>分析項目</b><span class="muted">（複数選べます。押すたびに選択／解除。選んだ項目を1つの依頼文にまとめ、項目ごとに見出しを付けて答えるよう頼みます）</span><span id="aiPickN" class="muted"></span></div>
      <div id="aiPrompts"></div>
      <div class="row ai-secs" style="margin-top:12px"><b>含める集計：</b>${AI_SECTIONS.map(([k, label]) => `<label><input type="checkbox" data-sec="${k}"${secs.has(k) ? " checked" : ""}> ${label}</label>`).join("")}</div>
      <div class="row" style="justify-content:space-between;margin-top:8px"><b>AIへの依頼文（書き換えられます）</b>
        <span class="row" style="margin:0"><button id="aiAddPrompt">＋ この依頼文を「自分の依頼文」に追加</button></span></div>
      <textarea id="aiPromptText" class="ai-prompt" spellcheck="false" placeholder="依頼文なし（集計だけを送る）"></textarea>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><h3 class="stephd" style="margin:0"><span class="stepno">2</span>送るテキストを確認する</h3><span id="aiLen" class="muted"></span></div>
      <p class="muted" style="margin-top:4px">依頼文＋集計です。直接書き換えられます（①を変えると作り直されます）。</p>
      <textarea id="aiText" class="ai-text" spellcheck="false"></textarea>
      <div id="aiCheck"></div>
      <label class="notice-check" style="margin:10px 0"><input type="checkbox" id="aiOk"> 個人情報（氏名・年齢・性別・個別の症例など）が含まれていないことを確認しました</label>
      <div class="row">
        ${AI_SITES.map(([k, name]) => `<button class="primary" data-ai-go="${k}" disabled>📋 コピーして ${name} を開く</button>`).join("")}
        <button id="aiCopy" disabled>📋 コピーのみ</button><button id="aiSave" disabled>テキストを保存（.txt）</button><button id="aiCsv" disabled title="文章をCSVにします（文の行は1列、集計の表は列に分けて入ります）。AIに読ませやすい形です">📄 CSVで保存</button><button id="aiXlsx" disabled title="依頼と本文のシートと、集計の表ごとのシートに分けたExcelにします（GaiXer／源内にファイルとして添付して読ませるとき用）">📊 Excelで保存</button>
      </div>
      <p class="muted" style="margin-bottom:0">${AI_SITES.map(([k, name]) => `${name}：${urls[k] ? esc(urls[k]) : "<b>URL未登録</b>"}`).join("　／　")}。URLは「設定」→「AI分析の送り先」で登録します（未登録のときはコピーだけ行います）。</p>
      <p class="muted" style="margin:4px 0">コピー・保存・送るたびに、追跡用の<b>管理番号</b>（例：AI-20261025-7F3K）を文章の冒頭に入れ、日時・行き先・範囲とあわせてこのブラウザに記録します（データのバックアップにも入ります）。</p>
      <div id="aiLog"></div>
    </div>
    <div class="card" id="aiAnsCard">
      <h3 class="stephd" style="margin-top:0"><span class="stepno">3</span>AIの回答を保存する（PDFレポートに入れられます）</h3>
      <p class="muted" style="margin-top:0">GaiXer／源内の回答をコピーして貼り付け、「保存」を押すと、PDFレポートの「AI分析の結果」の章に選んで入れられます。保存はこのブラウザの中だけです。</p>
      <div class="row"><label>題名 <input id="aiAnsTitle" size="34" placeholder="例：今月の全体像"></label></div>
      <textarea id="aiAns" class="ai-text" rows="8" spellcheck="false" placeholder="AIの回答をここに貼り付け"></textarea>
      <div id="aiAnsCheck"></div>
      <div class="row"><button class="primary" id="aiAnsSave" disabled>保存</button><span class="muted" id="aiAnsSt"></span></div>
      <div id="aiNotes"></div>
    </div>`;
  // 選んでいる分析項目（複数）
  let curKeys = Array.isArray(p.aiPromptKeys) && p.aiPromptKeys.length ? p.aiPromptKeys.slice() : [p.aiPromptKey || "overview"];
  // 対象（全世界／地域／1か国）と期間（今月のみ／直近Nか月の推移）
  const postsWithData = [...new Set(Object.values(state.reports).map((r) => r.post))].sort((a, b) => AI_REGIONS.indexOf(aiRegionOf(a)) - AI_REGIONS.indexOf(aiRegionOf(b)) || jaCmp(a, b));
  // 選んだ国（公館）の集まりだけを持つ。地域のボタンは、その地域の国をまとめて選ぶ／外す近道
  const regionPosts = (g) => postsWithData.filter((x) => aiRegionOf(x) === g);
  const init = normScope(p.aiScope || (p.aiRegion ? { type: "region", value: p.aiRegion } : p.homePost ? { regions: [], posts: [p.homePost] } : null));
  const sel = new Set([...init.regions.flatMap(regionPosts), ...init.posts].filter((x) => postsWithData.includes(x)));
  // 分析の文章用：地域の国がすべて選ばれていればその地域、残りは国として渡す（何も選ばなければ全世界）
  const deriveScope = () => {
    if (sel.size && postsWithData.every((x) => sel.has(x))) return { regions: [], posts: [] };  // すべての国＝全世界
    const regions = AI_REGIONS.filter((g) => { const xs = regionPosts(g); return xs.length && xs.every((x) => sel.has(x)); });
    return { regions, posts: [...sel].filter((x) => !regions.includes(aiRegionOf(x))) };
  };
  let scope = deriveScope();
  let period = [0, 6, 12, 36, 60, -1].includes(p.aiPeriod) ? p.aiPeriod : 0;
  const endM = () => (period ? latest : m0);
  // 分析の対象期間の表示（例：2026年9月／2023年10月〜2026年9月の推移）
  const periodLabel = () => {
    if (!period) return fmtMonth(m0);
    const ms = repMs.filter((x) => x <= latest).slice(period === -1 ? 0 : -period);
    return ms.length ? `${fmtMonth(ms[0])}〜${fmtMonth(latest)}の推移` : fmtMonth(latest);
  };
  const saveScope = () => { scope = deriveScope(); savePref("aiScope", scope); markScope(); fillPosts(); regen(); };
  const markScope = () => {
    document.querySelectorAll("[data-aireg]").forEach((b) => {
      const g = b.dataset.aireg, xs = g ? regionPosts(g) : [], n = xs.filter((x) => sel.has(x)).length;
      const all = !sel.size || postsWithData.every((x) => sel.has(x));
      const on = g ? xs.length > 0 && n === xs.length : all;
      b.classList.toggle("on", on); b.classList.toggle("part", !!g && n > 0 && !on); b.setAttribute("aria-pressed", on);
      b.title = g ? (on ? "押すとこの地域の国をまとめて外します" : "押すとこの地域の国をまとめて選びます") + (n && !on ? `（いま ${n}/${xs.length} を選択中）` : "") : (all && sel.size ? "押すと国の選択をすべて外します" : "押すとすべての国を選びます（全世界）");
    });
    document.querySelectorAll("[data-aiper]").forEach((b) => { const on = +b.dataset.aiper === period; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    $("#aiPostSel").textContent = !sel.size || postsWithData.every((x) => sel.has(x)) ? `分析の対象：全世界（${postsWithData.length}か国・公館）` : `分析の対象：${sel.size}か国・公館`;
  };
  const fillPosts = () => {
    const q = nfkc($("#aiPostQ").value.trim());
    const hits = postsWithData.filter((x) => !q || nfkc(x).includes(q) || nfkc(aiRegionOf(x)).includes(q));
    // 地域ごとにすべての国（公館）のボタンを並べる
    $("#aiPostList").innerHTML = [...AI_REGIONS, "未分類"].map((g) => {
      const xs = hits.filter((x) => aiRegionOf(x) === g);
      return xs.length ? `<div class="ai-pgroup"><div class="gh">${esc(regionLabel(g))}</div><div class="ai-postlist">${xs.map((x) => {
        const on = sel.has(x);
        return `<button class="ai-post${on ? " on" : ""}" data-aipost="${esc(x)}" aria-pressed="${on}" title="${on ? "選択中（押すと外します）" : "押すと選択します"}">${flagImg(x, "flag sm")}${esc(x)}${on ? " ✓" : ""}</button>`;
      }).join("")}</div></div>` : "";
    }).join("") || '<span class="muted">見つかりません</span>';
    document.querySelectorAll("[data-aipost]").forEach((b) => (b.onclick = () => {
      const x = b.dataset.aipost;
      if (sel.has(x)) sel.delete(x); else sel.add(x);
      saveScope();
    }));
  };
  document.querySelectorAll("[data-aireg]").forEach((b) => (b.onclick = () => {
    const g = b.dataset.aireg;
    // 全世界：すべての国を選ぶ（すでに全部選んでいれば、すべて外す）
    if (!g) { if (sel.size && postsWithData.every((x) => sel.has(x))) sel.clear(); else postsWithData.forEach((x) => sel.add(x)); saveScope(); return; }
    const xs = regionPosts(g);
    if (xs.every((x) => sel.has(x))) xs.forEach((x) => sel.delete(x)); else xs.forEach((x) => sel.add(x));
    saveScope();
  }));
  document.querySelectorAll("[data-aiper]").forEach((b) => (b.onclick = () => { period = +b.dataset.aiper; savePref("aiPeriod", period); markScope(); regen(); }));
  $("#aiPostQ").oninput = fillPosts;
  $("#aiPostClear").onclick = () => { sel.clear(); saveScope(); };
  $("#aiPostQ").onkeydown = (e) => { if (e.key === "Enter") { const first = $("#aiPostList [data-aipost]"); if (first) first.click(); } };
  markScope(); fillPosts();
  const drawPrompts = () => {
    const btn = (it, custom) => `<button class="ai-pcard${curKeys.includes(it.k) ? " on" : ""}" data-pk="${esc(it.k)}" aria-pressed="${curKeys.includes(it.k)}">
        <span class="t">${it.icon || "📝"} ${esc(it.title)}</span><span class="ex">${esc(it.ex || "")}</span>${custom ? `<span class="del" data-pdel="${esc(it.k)}" title="削除">✕</span>` : ""}</button>`;
    const cps = customPrompts();
    $("#aiPrompts").innerHTML = AI_PROMPT_LIST.map((g) => `<div class="ai-pgroup"><div class="gh">${g.group}</div><div class="ai-pgrid">${g.items.map((it) => btn(it)).join("")}</div></div>`).join("")
      + `<div class="ai-pgroup"><div class="gh">自分の依頼文</div><div class="ai-pgrid">${cps.map((it) => btn({ ...it, icon: "⭐", ex: it.text.slice(0, 40) + (it.text.length > 40 ? "…" : "") }, true)).join("")}
         ${btn({ k: "none", icon: "∅", title: "依頼文なし", ex: "集計だけを送り、依頼はAIの画面で書く" })}</div></div>`;
    document.querySelectorAll("[data-pk]").forEach((b) => (b.onclick = (e) => {
      if (e.target.closest("[data-pdel]")) return;
      selectPrompt(b.dataset.pk, true, true);
    }));
    document.querySelectorAll("[data-pdel]").forEach((x) => (x.onclick = () => {
      if (!confirm("この依頼文を一覧から削除しますか？")) return;
      savePref("aiCustomPrompts", customPrompts().filter((c) => c.k !== x.dataset.pdel));
      curKeys = curKeys.filter((k) => k !== x.dataset.pdel);
      if (!curKeys.length) curKeys = ["overview"];
      drawPrompts();
    }));
  };
  const promptOf = (k) => AI_PROMPT_FLAT.find((x) => x.k === k) || customPrompts().find((x) => x.k === k);
  // 選んだ項目から依頼文を作る（1つならその依頼文、複数なら観点ごとに見出しを付けて1つにまとめる）
  const buildPrompt = () => {
    const its = curKeys.map(promptOf).filter(Boolean);
    if (!its.length) return "";
    const head = its.some((it) => AI_PROMPT_FLAT.includes(it)) ? AI_HEAD + "\n" : "";
    if (its.length === 1) return head + its[0].text;
    return head + `次の${its.length}つの観点で分析してください。観点ごとに「■ 観点の名前」の見出しを付け、最後に全体のまとめ（3行程度）を書いてください。\n\n`
      + its.map((it, i) => `■ 観点${i + 1}：${it.title}\n${it.text}`).join("\n\n");
  };
  const titleNow = () => { const its = curKeys.map(promptOf).filter(Boolean); return its.length ? its.map((it) => it.title).join("・") : "AI分析"; };
  // k を選ぶ／外す。toggle=false は、その1つだけを選ぶ（起動時・自分の依頼文を追加したとき）
  const selectPrompt = (k, setSecs, toggle = false) => {
    if (!toggle || k === "none") curKeys = [k];
    else {
      const was = curKeys.includes(k);
      curKeys = was ? curKeys.filter((x) => x !== k) : [...curKeys.filter((x) => x !== "none"), k];
      if (!curKeys.length) curKeys = ["none"];
      if (was) setSecs = false;   // 外したときは、含める集計のチェックは変えない
    }
    savePref("aiPromptKeys", curKeys); savePref("aiPromptKey", curKeys[0]);
    const it = promptOf(k);
    $("#aiPromptText").value = buildPrompt();
    // 含める集計：1つだけならその項目の集計に合わせ、足したときはその項目の集計を加える
    if (setSecs && it && it.secs) document.querySelectorAll("[data-sec]").forEach((c) => (c.checked = curKeys.length > 1 ? c.checked || it.secs.includes(c.dataset.sec) : it.secs.includes(c.dataset.sec)));
    if (setSecs && it && it.period && !period) { period = it.period; savePref("aiPeriod", period); }
    if ($("#aiAnsTitle")) $("#aiAnsTitle").value = titleNow();
    if (setSecs && it && it.scope === "post" && !scope.posts.length) setTimeout(() => $("#aiPostPick").scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
    if (setSecs) { markScope(); fillPosts(); }
    const n = curKeys.filter((x) => x !== "none").length;
    if ($("#aiPickN")) $("#aiPickN").textContent = n > 1 ? `　いま ${n}項目を選択中` : "";
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
    curKeys = [k]; savePref("aiPromptKeys", curKeys); savePref("aiPromptKey", k); drawPrompts();
    toast("「自分の依頼文」に追加しました（設定ファイルにも書き出されます）");
  };
  const regen = () => {
    const ss = new Set([...document.querySelectorAll("[data-sec]")].filter((c) => c.checked).map((c) => c.dataset.sec));
    savePref("aiSecs", [...ss]);
    const pt = $("#aiPromptText").value.trim();
    const m = endM();
    $("#aiHeadM").textContent = periodLabel();
    $("#aiText").value = AI_GUARD + (pt ? pt + "\n\n" : "") + (period ? aiSeries(m, ss, scope, period === -1 ? 0 : period) : aiText(m, ss, scope));
    $("#aiOk").checked = false;
    check();
  };
  const check = () => {
    const t = $("#aiText").value, left = privacyPanel($("#aiText"), $("#aiCheck"));
    $("#aiLen").textContent = `${t.length.toLocaleString()}文字`;
    const ok = !left && $("#aiOk").checked && t.trim();
    document.querySelectorAll("[data-ai-go], #aiCopy, #aiSave, #aiXlsx, #aiCsv").forEach((b) => (b.disabled = !ok));
  };
  document.querySelectorAll("[data-sec]").forEach((c) => (c.onchange = regen));
  $("#aiPromptText").oninput = regen;
  $("#aiText").oninput = () => { $("#aiOk").checked = false; check(); };
  $("#aiOk").onchange = check;
  // コピー・保存・送るたびに管理番号を付け、文章欄にも反映して記録する
  const stamp = async (dest) => {
    const { t, id } = await stampAiText($("#aiText").value, dest, { month: endM(), scope: scopeLabel(scope), period: period ? (period === -1 ? "全期間" : `直近${period}か月`) : "今月" });
    $("#aiText").value = t;
    drawAiLog();
    return { t, id };
  };
  $("#aiCopy").onclick = async () => { const { t, id } = await stamp("コピー"); toast((await copyText(t)) ? `コピーしました（管理番号 ${id}）。貼り付ける前にもう一度内容を確認してください` : "コピーできませんでした"); };
  $("#aiSave").onclick = async () => {
    const { t, id } = await stamp("ファイル保存");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([t], { type: "text/plain;charset=utf-8" }));
    a.download = `AI分析用_医務官月報集計_${endM().replace("-", "")}_${id}.txt`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $("#aiCsv").onclick = async () => {
    const { t, id } = await stamp("CSV保存");
    downloadCsv(aiTextCsvRows(t), `AI分析用_医務官月報集計_${endM().replace("-", "")}_${id}.csv`);
    toast(`CSV（管理番号 ${id}）を保存しました。GaiXer／源内に添付して「このファイルの依頼のとおりに分析してください」と送ってください`);
  };
  $("#aiXlsx").onclick = async () => {
    const { t, id } = await stamp("Excel保存");
    XLSX.writeFile(aiTextWorkbook(t), `AI分析用_医務官月報集計_${endM().replace("-", "")}_${id}.xlsx`);
    toast(`Excel（管理番号 ${id}）を保存しました。GaiXer／源内に添付して「依頼と本文のシートのとおりに分析してください」と送ってください`);
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
  // ---- AIの回答を保存（state.aiNotes。PDFレポートの「AI分析の結果」に入れられる）
  $("#aiAnsTitle").value = titleNow();
  const ansCheck = () => {
    const left = privacyPanel($("#aiAns"), $("#aiAnsCheck"));
    $("#aiAnsSave").disabled = !$("#aiAns").value.trim() || left > 0;
  };
  $("#aiAns").oninput = ansCheck;
  const drawNotes = () => {
    // 保存したAIの回答は、新しい順にすべて出す（対象の月・期間つき）
    const ns = (state.aiNotes || []).slice(0, 30);
    $("#aiNotes").innerHTML = ns.length ? `<h4 style="margin:12px 0 4px">保存したAIの回答（新しい順・${(state.aiNotes || []).length}件）</h4><ul class="ai-notes">${ns.map((x) => `<li><b>${esc(x.title)}</b>
        <span class="muted">${esc(x.periodLabel || fmtMonth(x.month))}・${esc(x.scope || "")}・${esc(new Date(x.at).toLocaleString("ja-JP"))}・${x.text.length.toLocaleString()}文字</span>
        <button class="linklike" data-note-del="${esc(x.id)}">削除</button><details><summary>中身を見る</summary><pre class="pcfull-hei">${esc(x.text)}</pre></details></li>`).join("")}</ul>` : "";
    document.querySelectorAll("[data-note-del]").forEach((b) => (b.onclick = async () => {
      if (!confirm("このAIの回答を削除します。よろしいですか？")) return;
      state.aiNotes = (state.aiNotes || []).filter((x) => x.id !== b.dataset.noteDel);
      await saveState(); drawNotes();
    }));
  };
  $("#aiAnsSave").onclick = async () => {
    const text = $("#aiAns").value.trim();
    if (!text) return;
    (state.aiNotes ||= []).unshift({ id: `N${Date.now().toString(36)}`, at: new Date().toISOString(), month: endM(), periodLabel: periodLabel(), title: $("#aiAnsTitle").value.trim() || titleNow(),
      kind: "",
      scope: `${scopeLabel(scope)}${period ? (period === -1 ? "・全期間の推移" : `・直近${period}か月の推移`) : ""}`, text });
    await saveState();
    $("#aiAns").value = ""; ansCheck();
    $("#aiAnsSt").textContent = "保存しました。PDFレポートの「AI分析の結果」で選べます";
    drawNotes();
  };
  drawNotes();
  document.querySelectorAll("[data-ai-go]").forEach((b) => (b.onclick = async () => {
    const k = b.dataset.aiGo, name = AI_SITES.find((s) => s[0] === k)[1], url = aiUrls()[k];
    const ok = await copyText((await stamp(name)).t);
    if (!ok) { toast("コピーできませんでした"); return; }
    if (url) { window.open(url, "_blank", "noopener"); toast(`コピーしました。開いた ${name} の入力欄に貼り付けてください（Ctrl+V）`); }
    else toast(`コピーしました。${name} のURLが未登録なので、${name} を開いて貼り付けてください（設定でURLを登録できます）`);
  }));
  // 起動時：前に選んでいた項目（複数）を選んだ状態にする
  { const keep = curKeys.filter((k) => k === "none" || promptOf(k)); curKeys = keep.length ? keep : ["overview"]; const first = curKeys[0];
    const rest = curKeys.slice(1); selectPrompt(first, !p.aiSecs); for (const k of rest) selectPrompt(k, false, true); }
}

// ======================================================================= 設定

// 設定画面：国歌の録音の登録・一覧
function bindAnthemSettings() {
  const countries = [...new Set(Object.values(INFO).map((v) => v.iso3).filter(Boolean))].sort((a, b) => jaCmp(isoName(a), isoName(b)));
  const drawList = async () => {
    const set = await anthemList(), names = (await idb.get("anthemNames")) || {};
    const posts = [...new Set(Object.values(state.reports).map((r) => INFO[r.post] && INFO[r.post].iso3).filter(Boolean))];
    const have = [...set].sort((a, b) => jaCmp(isoName(a), isoName(b)));
    const missing = posts.filter((iso) => !set.has(iso)).sort((a, b) => jaCmp(isoName(a), isoName(b)));
    if (!$("#anList")) return;   // 読み込みの間に別のタブへ移ったとき
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
        .filter((i) => i && !have.has(i)).sort((a, b) => jaCmp(isoName(a), isoName(b)));
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
        if (preferredNames(iso).includes(names[iso])) continue;   // 指定の録音は残す
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
      for (const iso of Object.keys(PREFERRED_ANTHEM)) {
        const cands = preferredNames(iso);
        if (!want.has(iso) || cands.includes(names[iso])) { delete pick[iso]; continue; }
        for (const nm of cands) {
          try { pick[iso] = await commonsFileInfo(nm); break; } catch (e) { console.warn("preferred", nm, e); }
        }
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
  // UAE：米海軍軍楽隊の「Ishy Bilady」（パブリックドメイン）。名前が変わっていたときのために旧名も
  ARE: ["UAE national anthem.ogg", "\"Ishy Bilady\" performed by the United States Navy Band.oga"],
};
const preferredNames = (iso) => [].concat(PREFERRED_ANTHEM[iso] || []);
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
  for (const k of ["aiUrls", "aiSecs", "aiPromptKey", "aiPromptKeys", "aiCustomPrompts", "aiPeriod", "tourSound", "importMode", "mapView", "tabOrder", "summaryLines"]) if (p[k] !== undefined) prefs[k] = p[k];
  return { format: "geppou-settings", v: 1, saved: new Date().toISOString(), overrides: state.overrides, groups: state.groups, doneCls: state.doneCls || {}, doneGrp: state.doneGrp || {}, prefs };
}

// AIに渡す疾病分類の依頼文（病名と分類の一覧だけ。件数・公館名・個人情報は含めない）
function clsPrompt(list, withCurrent, hints = {}) {
  const cats = CATEGORIES;
  return AI_GUARD + [
    "# 依頼：在外公館の医務官月報（乙表）の病名を、ICD-10の大分類に分類してください",
    "次の病名それぞれについて、下の「分類の一覧」から最も適切な分類を1つ選んでください。あわせて、同じ病気の表記ゆれを1つにまとめるための「代表名」も付けてください（例：感冒・急性鼻咽頭炎・上気道炎 → かぜ（急性上気道炎）、古典デング・デング出血熱 → デング熱）。",
    "- 出力は次の形式の表だけにしてください（前置き・説明は不要）。1行に1つの病名で、区切りはタブです：",
    "病名\t分類\t代表名",
    "- 病名は書き換えずにそのまま写してください。分類は一覧の名前をそのまま使い、判断できないものは「その他・分類不能」としてください。",
    "- 健康診断・予防接種・健康相談などは「健康状態に影響を及ぼす要因及び保健サービスの利用（Z）」です。",
    "", "## 分類の一覧", ...cats.map((c) => `- ${c}`),
    "", `## 病名（${list.length}件）`, ...list.map((nm) => (withCurrent ? `${nm}（いまの分類：${shortCat(classify(nm, hints[nm]))}）` : nm))].join("\n");
}
// AIの回答を読む：1行に「病名・分類・代表名」（タブ・カンマ・| ・：区切り）。分類は正式名・短い名前・一部の一致で探す
function parseClsAnswer(text, knownNames) {
  const known = new Map(knownNames.map((n) => [nfkc(n).replace(/\s+/g, ""), n]));
  const catOf = (raw) => {
    const t = nfkc(raw || "").replace(/[*「」]/g, "").trim();
    if (!t) return null;
    const hit = CATEGORIES.find((c) => nfkc(c) === t) || CATEGORIES.find((c) => nfkc(shortCat(c)) === t)
      || CATEGORIES.find((c) => t.includes(nfkc(c)) || nfkc(c).includes(t)) || CATEGORIES.find((c) => t.includes(nfkc(shortCat(c)).replace(/\(Z\)$/, "")));
    return hit || null;
  };
  const items = [], unknown = [], seen = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    let l = raw.trim().replace(/^[-*・]\s*/, "");
    if (!l || /^\|?\s*:?-{2,}/.test(l) || /専用です/.test(l)) continue;
    if (l.startsWith("|")) l = l.replace(/^\||\|$/g, "");
    const cols = (l.includes("\t") ? l.split("\t") : l.includes("|") ? l.split("|") : l.includes(",") ? l.split(",") : l.split(/[：:]/)).map((c) => c.trim()).filter((c, i) => c || i < 3);
    if (cols.length < 2) continue;
    const nm = cols[0].replace(/[（(]いまの分類[：:].*?[)）]$/, "").trim();
    if (!nm || /^病名$/.test(nm)) continue;
    const name = known.get(nfkc(nm).replace(/\s+/g, ""));
    if (!name) { unknown.push(nm); continue; }
    if (seen.has(name)) continue;
    seen.add(name);
    const cat = catOf(cols[1]);
    items.push({ name, cat, rawCat: cols[1], group: (cols[2] || "").replace(/^[「]|[」]$/g, "").trim() || null });
  }
  return { items, unknown };
}
// ---- 病名のまとめ方を AI に頼む：表記ゆれ・同じ病気の別名を1つのまとめ先（代表名）にそろえてもらう
function grpPrompt(list, withCurrent) {
  const known = [...new Set([...GROUP_NAMES, ...Object.values(state.groups)])].sort(jaCmp);
  return AI_GUARD + [
    "# 依頼：在外公館の医務官月報（乙表）の病名の表記ゆれを、1つの「まとめ先」にそろえてください",
    "同じ病気・同じ意味の病名（表記ゆれ、略称、英語表記、同義語、細かい病型）を、集計しやすい1つの代表名にまとめます（例：感冒・急性鼻咽頭炎・上気道炎 → かぜ（急性上気道炎）、古典デング・デング出血熱 → デング熱、HT・高血圧症 → 高血圧）。",
    "- 出力は次の形式の表だけにしてください（前置き・説明は不要）。1行に1つの病名で、区切りはタブです：",
    "病名\tまとめ先",
    "- 病名は書き換えずにそのまま写してください。下の「いまあるまとめ先」に合うものがあれば、その名前をそのまま使ってください。",
    "- 合うものがなければ、日本語の一般的な病名で新しいまとめ先を作ってください。まとめる相手がない病名は、まとめ先を病名と同じにしてください。",
    "- 別の病気をまとめないでください（例：胃炎と胃潰瘍、気管支炎と肺炎は別）。",
    "", "## いまあるまとめ先", known.join("、"),
    "", `## 病名（${list.length}件）`, ...list.map((nm) => (withCurrent ? `${nm}（いまのまとめ先：${groupOf(nm)}）` : nm))].join("\n");
}
// AIの回答を読む：1行に「病名・まとめ先」（タブ・カンマ・| ・→・：区切り）
function parseGrpAnswer(text, knownNames) {
  const known = new Map(knownNames.map((n) => [nfkc(n).replace(/\s+/g, ""), n]));
  const items = [], unknown = [], seen = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    let l = raw.trim().replace(/^[-*・]\s*/, "");
    if (!l || /^\|?\s*:?-{2,}/.test(l) || /専用です/.test(l)) continue;
    if (l.startsWith("|")) l = l.replace(/^\||\|$/g, "");
    const cols = (l.includes("\t") ? l.split("\t") : l.includes("|") ? l.split("|") : /→|⇒/.test(l) ? l.split(/→|⇒/) : l.includes(",") ? l.split(",") : l.split(/[：:]/)).map((c) => c.trim());
    if (cols.length < 2) continue;
    const nm = cols[0].replace(/[（(]いまのまとめ先[：:].*?[)）]$/, "").trim();
    if (!nm || /^病名$/.test(nm)) continue;
    const name = known.get(nfkc(nm).replace(/\s+/g, ""));
    if (!name) { unknown.push(nm); continue; }
    const group = cols[1].replace(/^[「*]+|[」*]+$/g, "").trim();
    if (seen.has(name) || !group) continue;
    seen.add(name);
    items.push({ name, group });
  }
  return { items, unknown };
}
// CSV を書き出す（Excel で文字化けしないよう BOM 付き UTF-8）
function downloadCsv(rows, filename) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "\ufeff" + rows.map((r) => r.map(q).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = filename;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
// 病名ごとの疾病分類とまとめ先の一覧（件数は取り込んだ全期間の合計。公館名・個人情報は含めない）
function diseaseTableCsv() {
  const names = {}, hints = {}, posts = {};
  for (const r of Object.values(state.reports)) for (const d of r.diseases || []) {
    names[d.name] = (names[d.name] || 0) + d.count;
    if (d.cat) hints[d.name] ||= d.cat;
    (posts[d.name] ||= new Set()).add(r.post);
  }
  const rows = [["病名", "件数（全期間）", "報告した公館数", "疾病分類（ICD-10大分類）", "分類の決め方", "まとめ先（代表名）", "まとめの決め方", "分類済み"]];
  for (const nm of Object.keys(names).sort((a, b) => names[b] - names[a] || jaCmp(a, b))) {
    const cat = classify(nm, hints[nm]);
    rows.push([nm, names[nm], posts[nm].size, cat, state.overrides[nm] ? "手動" : cat === OTHER ? "分類不能" : "自動",
      groupOf(nm), state.groups[nm] ? "手動" : isGrouped(nm) ? "自動" : "まとめ先なし", (state.doneCls || {})[nm] || (state.doneGrp || {})[nm] ? "○" : ""]);
  }
  return rows;
}
const exportDiseaseCsv = () => {
  const rows = diseaseTableCsv();
  if (rows.length < 2) { toast("病名がありません（月報を取り込むと書き出せます）"); return; }
  const d = new Date();
  downloadCsv(rows, `疾病分類_病名一覧_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.csv`);
  toast(`病名 ${rows.length - 1}件の疾病分類・まとめ先をCSVで書き出しました`);
};
// 設定の「疾病分類の手動設定」「病名のまとめ方」で、チェックして一覧から消した（分類済みにした）病名。「分類済みを表示」のときだけ出す
let showDoneCls = false, showDoneGrp = false;
const doneCls = () => (state.doneCls ||= {}), doneGrp = () => (state.doneGrp ||= {});
function pageSettings() {
  const names = {}, hints = {};
  for (const r of Object.values(state.reports)) for (const d of r.diseases || []) { names[d.name] = (names[d.name] || 0) + d.count; if (d.cat) hints[d.name] ||= d.cat; }
  const rows = Object.entries(names).filter(([nm]) => classify(nm, hints[nm]) === OTHER || state.overrides[nm]).sort((a, b) => b[1] - a[1]);
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
      <h3 style="margin-top:0">🏠 自分の公館</h3>
      <p class="muted">自分の公館だけで使うときに選ぶと、ダッシュボードの最初にその公館の今月の様子が出て、PDFレポート・AI分析もはじめからその公館を選んだ状態になります（全世界・ほかの国にも切り替えられます）。</p>
      <div class="row"><input id="homePost" list="homePostList" placeholder="国名・公館名" size="20" value="${esc(loadPrefs().homePost || "")}"><datalist id="homePostList">${MASTER_POSTS().sort(jaCmp).map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
        <button class="primary" id="homeSave">保存</button><button id="homeClear">選ばない（全世界）</button><span id="homeMsg" class="muted keep"></span></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">AI分析の送り先</h3>
      <p class="muted">「AI分析（匿名）」タブのボタンで開くページのURLです（最初から MOFA GaiXer・源内のアドレスが入っています。変わったときは書き換えてください。空にすると元のアドレスに戻ります）。ボタンは個人情報を含まない集計テキストをコピーしてこのページを開くだけで、自動送信はしません。</p>
      ${AI_SITES.map(([k, name]) => `<div class="row"><label style="min-width:9em">${name}</label><input type="url" data-aiurl="${k}" value="${esc(aiUrls()[k])}" placeholder="https://..." size="48"></div>`).join("")}
    </div>
    <div class="card">
      <h3 style="margin-top:0">在籍人数（受診率の計算用）</h3>
      <p class="muted" id="hcHelp">公館ごとの職員・家族の在籍人数を入れると、PDFレポートの統計分析で「受診率（在籍人数あたり）」を出せます。1行に「公館名,職員の人数,家族の人数,年月」（年月は人数の時点。省略可。例：ケニア,25,18,2026-04）。人数が変わったら、新しい年月の行を足すと、月ごとにその時点の人数で計算します。<b>Excel の表（公館名・職員・家族・年月の列）をそのまま貼り付けても読めます。</b>公館名は英語名・「在○○日本国大使館」でも構いません。氏名などの個人情報は入れません。</p>
      <textarea id="hcText" rows="5" placeholder="ケニア,25,18&#10;タイ,60,45">${esc(Object.keys(state.headcount || {}).sort(jaCmp).flatMap((p) => headcountList(p).map((h) => `${p},${h.staff || 0},${h.family || 0}${h.from ? "," + h.from : ""}`)).join("\n"))}</textarea>
      <div class="row"><button class="primary" id="hcSave">在籍人数を保存</button><span id="hcMsg" class="muted"></span></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">疾病分類の手動設定</h3>
      <p class="muted">キーワードで分類できなかった病名に分類を割り当てます。次回以降も同じ病名に適用されます。</p>
      <div class="row"><button data-dis-csv>📄 すべての病名の疾病分類・まとめ先をCSVで書き出す</button><span class="muted">病名・件数・報告した公館数・疾病分類・まとめ先（自動／手動）の一覧。公館名・個人情報は含みません</span></div>
      <details class="aicls" id="aicls"${rows.length ? " open" : ""}>
        <summary><b>🤖 AIで分類する（MOFA GaiXer／政府AI源内）</b> <span class="muted">病名の一覧を書き出してAIに分類させ、回答を読み込みます</span></summary>
        <div class="row" style="margin-top:8px"><b>書き出す病名：</b>
          <label><input type="radio" name="clsScope" value="other" checked> 分類できなかった病名（${rows.filter(([nm]) => !state.overrides[nm]).length}件）</label>
          <label><input type="radio" name="clsScope" value="all"> すべての病名（${Object.keys(names).length}件・いまの分類も渡して見直してもらう）</label></div>
        <div class="row">① ${AI_SITES.map(([k, name]) => `<button class="primary" data-cls-go="${k}">コピーして ${name} を開く</button>`).join("")}<button id="clsDl">書き出す（.txt）</button>
          <span class="muted">病名と分類の一覧だけを渡します（件数・公館名・個人情報は含みません）</span></div>
        <p class="muted" style="margin:4px 0">② 開いた GaiXer／源内に貼り付けて送ります。③ 回答（「病名⇥分類⇥代表名」の表）をすべてコピーし、下に貼り付けるか、ファイルで読み込みます。</p>
        <textarea id="clsAns" rows="6" placeholder="AIの回答をここに貼り付け（例：上気道炎⇥呼吸器系の疾患⇥かぜ（急性上気道炎））"></textarea>
        <div class="row"><button id="clsParse">③ 読み込む</button><label class="btn">ファイルから読み込む<input type="file" id="clsFile" accept=".txt,.csv,.tsv,text/plain" hidden></label></div>
        <div id="clsPreview"></div>
      </details>
      ${(() => { const nDone = rows.filter(([nm]) => doneCls()[nm]).length, vis = rows.filter(([nm]) => showDoneCls || !doneCls()[nm]);
        const toggle = nDone ? `<button id="ovShowDone">${showDoneCls ? "分類済みを隠す" : `分類済みを表示（${nDone}件）`}</button>` : "";
        return vis.length ? `<div class="table-wrap" style="max-height:420px"><table><thead><tr><th><input type="checkbox" id="ovAll" title="すべて選ぶ／外す"></th><th>病名</th><th class="num">件数</th><th>分類</th></tr></thead><tbody>${
          vis.map(([nm, c]) => `<tr${doneCls()[nm] ? ' class="done"' : ""}><td><input type="checkbox" data-ovchk="${esc(nm)}"></td><td>${esc(nm)}${doneCls()[nm] ? ' <span class="badge">分類済み</span>' : ""}</td><td class="num">${c}</td><td><select data-name="${esc(nm)}">${CATEGORIES.map((cat) => `<option value="${esc(cat)}"${classify(nm) === cat ? " selected" : ""}>${esc(shortCat(cat))}</option>`).join("")}</select></td></tr>`).join("")}
        </tbody></table></div><div class="row"><button class="primary" id="saveOv">分類を保存</button><button id="ovHide" title="チェックした病名を、いまの分類で保存して一覧から消します（「分類済みを表示」で見られます）">チェックしたものを分類済みにして消す</button>${showDoneCls ? '<button id="ovUnhide">チェックしたものを一覧に戻す</button>' : ""}${toggle}</div>`
          : `<p class="muted">${nDone ? "残っている病名はありません（すべて分類済み）。" : "分類できなかった病名はありません。"}</p>${toggle ? `<div class="row">${toggle}</div>` : ""}`; })()}
    </div>
    <div class="card">
      <h3 style="margin-top:0">病名のまとめ方</h3>
      <p class="muted">「感冒」「急性鼻咽頭炎」「上気道炎」→ かぜ（急性上気道炎）、「古典デング」「デング出血熱」→ デング熱 のように、表記の違う病名を1つにまとめて集計・地図表示します。まとめ先は書き換えられます（一覧にない名前を入れると新しいグループになります）。</p>
      <details class="aicls" id="aigrp">
        <summary><b>🤖 AIでまとめる（MOFA GaiXer／政府AI源内）</b> <span class="muted">病名の一覧を書き出してAIにまとめ先を決めさせ、回答を読み込みます</span></summary>
        <div class="row" style="margin-top:8px"><b>書き出す病名：</b>
          <label><input type="radio" name="grpScope" value="none" checked> まとめ先がない病名（${Object.keys(names).filter((nm) => !isGrouped(nm)).length}件）</label>
          <label><input type="radio" name="grpScope" value="all"> すべての病名（${Object.keys(names).length}件・いまのまとめ先も渡して見直してもらう）</label></div>
        <div class="row">① ${AI_SITES.map(([k, name]) => `<button class="primary" data-grp-go="${k}">コピーして ${name} を開く</button>`).join("")}<button id="grpDl">書き出す（.txt）</button>
          <span class="muted">病名とまとめ先の一覧だけを渡します（件数・公館名・個人情報は含みません）</span></div>
        <p class="muted" style="margin:4px 0">② 開いた GaiXer／源内に貼り付けて送ります。③ 回答（「病名⇥まとめ先」の表）をすべてコピーし、下に貼り付けるか、ファイルで読み込みます。</p>
        <textarea id="grpAns" rows="6" placeholder="AIの回答をここに貼り付け（例：急性鼻咽頭炎⇥かぜ（急性上気道炎））"></textarea>
        <div class="row"><button id="grpParse">③ 読み込む</button><label class="btn">ファイルから読み込む<input type="file" id="grpFile" accept=".txt,.csv,.tsv,text/plain" hidden></label></div>
        <div id="grpPreview"></div>
      </details>
      <div class="row">
        <label><input type="checkbox" id="gonly"> まとめ先がない病名だけ表示</label>
        <input id="gfilter" type="search" placeholder="病名で絞り込み" size="16">
      </div>
      <datalist id="gnames">${[...new Set([...GROUP_NAMES, ...Object.values(state.groups)])].map((g) => `<option value="${esc(g)}">`).join("")}</datalist>
      <div class="table-wrap" style="max-height:420px"><table id="gtable"><thead><tr><th><input type="checkbox" id="gAll" title="すべて選ぶ／外す"></th><th>報告された病名</th><th class="num">件数</th><th>まとめ先</th><th></th></tr></thead><tbody>${
        Object.entries(names).filter(([nm]) => showDoneGrp || !doneGrp()[nm]).sort((a, b) => b[1] - a[1]).map(([nm, c]) => `<tr data-n="${esc(nm)}"${doneGrp()[nm] ? ' class="done"' : ""}><td><input type="checkbox" data-gchk="${esc(nm)}"></td><td>${esc(nm)}${doneGrp()[nm] ? ' <span class="badge">分類済み</span>' : ""}</td><td class="num">${c}</td>
          <td><input list="gnames" data-g="${esc(nm)}" value="${esc(groupOf(nm))}" size="22"></td><td class="muted">${state.groups[nm] ? "手動" : isGrouped(nm) ? "自動" : "まとめ先なし"}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="row"><button data-dis-csv>📄 CSVで書き出す</button><button class="primary" id="saveG">まとめ方を保存</button><button id="gHide" title="チェックした病名を、いまのまとめ先で保存して一覧から消します（「分類済みを表示」で見られます）">チェックしたものを分類済みにして消す</button>${showDoneGrp ? '<button id="gUnhide">チェックしたものを一覧に戻す</button>' : ""}${(() => { const n = Object.keys(names).filter((nm) => doneGrp()[nm]).length;
        return n ? `<button id="gShowDone">${showDoneGrp ? "分類済みを隠す" : `分類済みを表示（${n}件）`}</button>` : ""; })()}<button id="resetG">自動の設定に戻す</button></div>
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
      <h3 style="margin-top:0">動作の記録・保存の状態</h3>
      <p class="muted" style="margin-top:0">${esc(storageStatusText())}</p>
      <p class="muted">うまく動かないときは、下の「動作の記録をコピー」を押して内容を知らせてください（エラーの文言・アプリの版・ブラウザの種類だけで、月報の内容は入りません）。</p>
      <div class="row"><button class="primary" data-bug>🐞 不具合を報告する（メール）</button><button id="errCopy">📋 動作の記録をコピー</button><span class="muted">記録 ${ERROR_LOG.length}件（このページを開いてから）</span></div>
      ${ERROR_LOG.length ? `<div class="table-wrap" style="max-height:200px"><table class="mini"><tr><th>時刻</th><th>種類</th><th>内容</th><th>場所</th></tr>${ERROR_LOG.map((x) => `<tr><td class="nowrap">${esc(x.at)}</td><td>${esc(x.kind)}</td><td>${esc(x.msg)}</td><td class="muted">${esc(x.where)}</td></tr>`).join("")}</table></div>` : ""}
    </div>
    <div class="card">
      <h3 style="margin-top:0">OCR（文字認識）の動作確認</h3>
      <p class="muted">「OCRで読み取ってみる」が動かないときに押してください。アプリの中で見本の文字（架空）を画像にして読ませ、結果と時間を出します（外部には送りません）。</p>
      <div class="row"><button id="ocrTest">🔎 OCRの動作確認</button><span id="ocrTestSt" class="muted"></span></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">オフラインでの利用</h3>
      <p id="offlineStatus">${offlineStatusText()}</p>
      <p class="muted">一度このページを開くと、アプリ一式（地図・国旗・ライブラリ・デモを含む）がこのブラウザに保存されます。インターネットがないときも同じアドレスを開けば使えます（上の「🖥 デスクトップに置く」の手順でショートカットを作ると、デスクトップからブラウザのタブで開けます）。インターネットにつながったときは自動で新しい版に更新されます。<b>UpToDate のリンクだけはインターネットにつながっていないと開けません。</b></p>
    </div>
    <div class="card">
      <h3 style="margin-top:0">データのバックアップ（月報くんフォルダ）</h3>
      <div class="bkfolder">
        <p style="margin-top:0"><b>おすすめの使い方：</b>「📦 月報くんフォルダを作る」でできる <b>月報くん</b> フォルダを、医務官のみがアクセスできる場所に置きます。
          フォルダの中の <b>月報くん（Chromeのタブで開く）</b> をダブルクリックすると、Chrome のタブでアプリが開きます（既定のブラウザが Edge でも Chrome で開く）。中の <b>バックアップ</b> フォルダに一度つなぐと、
          変更のたびに自動でバックアップし（ファイル名に日付と時刻）、開いたときは最新のバックアップを自動で読み込みます。</p>
        <div class="row"><button id="mkFolder">📦 月報くんフォルダを作る（zip）</button>
          ${bkdirSupported() ? `<button class="primary" id="pickBkdir">📁 バックアップフォルダを${bkdir.handle ? "変える" : "選ぶ"}</button>` : '<span class="muted">（このブラウザはフォルダへの自動保存に対応していません。Chrome か Edge で開いてください）</span>'}</div>
        <p class="muted" id="bkdirStatus">${bkdir.handle ? `つないでいるフォルダ：<b>${esc(bkdir.handle.name)}</b>${bkdir.ok ? "（自動バックアップ中）" : "（つなぎ直しが必要です。上の帯の「📁 バックアップフォルダを選んでつなぐ」か、下のボタンでフォルダを選んでください）"}` : "バックアップフォルダはまだつないでいません。"}</p>
      </div>
      <p class="muted">データはこのブラウザの中だけに保存されています。<b>閲覧履歴やCookie・サイトデータを消去するとデータも消えます</b>。必要な情報はファイルへ書き出し、<b>医務官のみがアクセスできるフォルダ</b>に保存してください。書き出すファイルは暗号化され、このアプリでしか読み込めません。</p>
      <p>${backupStatusText()}</p>
      <div class="row"><button id="exp">書き出し（暗号化 .geppou）</button><label class="btn">読み込み<input type="file" id="imp" accept=".geppou,.json" hidden></label>${demoMode ? '<button data-demo-exit>デモを終える</button>' : '<button data-demo-start>デモを見る（保存済みのデータはそのまま）</button>'}</div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">登録済みデータ</h3>
      ${byMonth.length ? `<p class="muted" style="margin:0 0 6px">未提出公館は、${Object.keys(state.rosters).length ? "最新の医務官配置表にあるすべての公館（医務官がいない・空席・退避中の公館も含み、過去の月にも同じ公館を当てはめる）" : "アプリの公館一覧の公館（医務官配置表が未登録のため）"}のうち、その月の月報がない公館です。取り込みタブの「📮 提出状況」で月ごとの一覧も見られます。</p>
      <div class="table-wrap vresize" data-rkey="regdataH"><table class="regdata"><thead><tr><th>月</th><th class="num">公館数</th><th class="num">受診者数</th><th>未提出公館</th><th></th></tr></thead><tbody>${
        byMonth.map(([m, rs]) => { const got = new Set(rs.map((r) => r.post)), miss = [...expectedPosts(m)].filter((p) => !got.has(p)).sort(jaCmp);
          return `<tr><td>${fmtMonth(m)}</td><td class="num">${rs.length}</td><td class="num">${sum(rs, (r) => r.total)}</td>
          <td>${miss.length ? `<span class="miss-mark">${miss.length}公館</span>：${(() => { const no = noOfficerIn(m); const ro = rosterFor(m) || []; return miss.map((p) => { const x = ro.find((r) => r.post === p); return esc(p) + (no.has(p) ? `<span class="muted">（${esc((x && x.note) || "医務官なし")}）</span>` : ""); }).join("、"); })()}` : '<span class="muted">なし（すべて提出）</span>'}</td>
          <td><button class="danger" data-delm="${m}">削除</button></td></tr>`; }).join("")}</tbody></table></div>` : '<p class="muted">なし</p>'}
      <div class="row"><button class="danger" id="wipe">すべてのデータを削除</button></div>
    </div>`;
  vresize(main);
  // ---- チェックした病名を分類済みにして一覧から消す／戻す
  const checked = (attr) => [...document.querySelectorAll(`[${attr}]:checked`)].map((c) => c.getAttribute(attr));
  const bindAll = (all, attr) => { const a = $(all); if (a) a.onchange = (e) => document.querySelectorAll(`[${attr}]`).forEach((c) => { if (!c.closest("tr").hidden) c.checked = e.target.checked; }); };
  bindAll("#ovAll", "data-ovchk"); bindAll("#gAll", "data-gchk");
  if ($("#ovShowDone")) $("#ovShowDone").onclick = () => { showDoneCls = !showDoneCls; render(); };
  if ($("#gShowDone")) $("#gShowDone").onclick = () => { showDoneGrp = !showDoneGrp; render(); };
  if ($("#ovHide")) $("#ovHide").onclick = async () => {
    const list = checked("data-ovchk");
    if (!list.length) { toast("一覧から消す病名にチェックを入れてください"); return; }
    for (const nm of list) { const sel = document.querySelector(`select[data-name="${CSS.escape(nm)}"]`); if (sel) state.overrides[nm] = sel.value; doneCls()[nm] = true; }
    await saveState(); toast(`${list.length}件をいまの分類で保存し、分類済みにしました（「分類済みを表示」で見られます）`); render();
  };
  if ($("#ovUnhide")) $("#ovUnhide").onclick = async () => {
    const list = checked("data-ovchk").filter((nm) => doneCls()[nm]);
    if (!list.length) { toast("一覧に戻す分類済みの病名にチェックを入れてください"); return; }
    for (const nm of list) delete doneCls()[nm];
    await saveState(); toast(`${list.length}件を一覧に戻しました`); render();
  };
  $("#gHide").onclick = async () => {
    const list = checked("data-gchk");
    if (!list.length) { toast("一覧から消す病名にチェックを入れてください"); return; }
    for (const nm of list) {
      const i = document.querySelector(`[data-g="${CSS.escape(nm)}"]`), v = i ? i.value.trim() : "";
      if (i) { if (!v || v === autoGroup(nm)) delete state.groups[nm]; else state.groups[nm] = v; }
      doneGrp()[nm] = true;
    }
    await saveState(); toast(`${list.length}件をいまのまとめ先で保存し、分類済みにしました（「分類済みを表示」で見られます）`); render();
  };
  if ($("#gUnhide")) $("#gUnhide").onclick = async () => {
    const list = checked("data-gchk").filter((nm) => doneGrp()[nm]);
    if (!list.length) { toast("一覧に戻す分類済みの病名にチェックを入れてください"); return; }
    for (const nm of list) delete doneGrp()[nm];
    await saveState(); toast(`${list.length}件を一覧に戻しました`); render();
  };
  if ($("#saveOv")) $("#saveOv").onclick = async () => {
    document.querySelectorAll("[data-name]").forEach((s) => { state.overrides[s.dataset.name] = s.value; });
    await saveState(); toast("保存しました"); render();
  };
  // ---- AIで分類する：病名の一覧を書き出し、AIの回答（病名⇥分類⇥代表名）を読み込む
  // 「分類できなかった病名」が0件のときは、すべての病名に切り替える（ボタンが何もしないように見えないように）
  const clsAll = () => {
    const r = document.querySelector("[name=clsScope]:checked");
    if (r.value !== "all" && !rows.some(([nm]) => !state.overrides[nm]) && Object.keys(names).length) {
      document.querySelector("[name=clsScope][value=all]").checked = true;
      toast("分類できなかった病名がないため、すべての病名（いまの分類つき）を書き出します");
    }
    return document.querySelector("[name=clsScope]:checked").value === "all";
  };
  const clsList = () => (clsAll() ? Object.keys(names).sort(jaCmp) : rows.filter(([nm]) => !state.overrides[nm]).map(([nm]) => nm));
  const clsText = (list) => clsPrompt(list, document.querySelector("[name=clsScope]:checked").value === "all", hints);
  document.querySelectorAll("[data-cls-go]").forEach((b) => (b.onclick = async () => {
    const list = clsList();
    if (!list.length) { toast("病名がありません（月報を取り込むと書き出せます）"); return; }
    const k = b.dataset.clsGo, name = AI_SITES.find((x) => x[0] === k)[1], url = aiUrls()[k];
    const { t, id } = await stampAiText(clsText(list), name, { month: curMonth() || "", scope: `疾病分類（${list.length}件）`, period: "" });
    if (!(await copyText(t))) { toast("コピーできませんでした"); return; }
    if (url) window.open(url, "_blank", "noopener");
    toast(`病名${list.length}件をコピーしました（管理番号 ${id}）。${name} に貼り付けて送り、回答を「③」に貼り付けてください`);
  }));
  $("#clsDl").onclick = async () => {
    const list = clsList();
    if (!list.length) { toast("病名がありません（月報を取り込むと書き出せます）"); return; }
    const { t, id } = await stampAiText(clsText(list), "ファイル保存", { month: curMonth() || "", scope: `疾病分類（${list.length}件）`, period: "" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([t], { type: "text/plain;charset=utf-8" }));
    a.download = `疾病分類_AI用_${id}.txt`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $("#clsFile").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; $("#clsAns").value = await f.text(); e.target.value = ""; $("#clsParse").onclick(); };
  $("#clsParse").onclick = () => {
    const res = parseClsAnswer($("#clsAns").value, Object.keys(names));
    const box = $("#clsPreview");
    if (!res.items.length) { box.innerHTML = '<div class="ai-warn">読み取れる行がありませんでした。回答が「病名⇥分類⇥代表名」（タブ・カンマ・| 区切り）の形か確かめてください。</div>'; return; }
    box.innerHTML = `<div class="table-wrap" style="max-height:360px"><table class="mini"><thead><tr><th><input type="checkbox" id="clsAll" checked></th><th>病名</th><th>いまの分類</th><th>AIの分類</th><th>いまのまとめ</th><th>AIのまとめ</th></tr></thead><tbody>
      ${res.items.map((x, i) => { const now = classify(x.name, hints[x.name]), chg = (x.cat && x.cat !== now) || (x.group && x.group !== groupOf(x.name));
        return `<tr><td><input type="checkbox" data-cls-i="${i}"${chg && x.cat ? " checked" : ""}${x.cat ? "" : " disabled"}></td><td>${esc(x.name)}</td><td class="muted">${esc(shortCat(now))}</td>
          <td>${x.cat ? `${x.cat !== now ? "<b>" : ""}${esc(shortCat(x.cat))}${x.cat !== now ? "</b>" : ""}` : `<span class="bad">読めない分類「${esc(x.rawCat)}」</span>`}</td>
          <td class="muted">${esc(groupOf(x.name))}</td><td>${x.group ? (x.group !== groupOf(x.name) ? `<b>${esc(x.group)}</b>` : esc(x.group)) : ""}</td></tr>`; }).join("")}</tbody></table></div>
      ${res.unknown.length ? `<p class="muted">月報にない病名のため読み飛ばしたもの：${esc(res.unknown.slice(0, 20).join("、"))}${res.unknown.length > 20 ? ` ほか${res.unknown.length - 20}` : ""}</p>` : ""}
      <div class="row"><button class="primary" id="clsApply">選んだ病名の分類・まとめを保存</button><span class="muted">変わるものだけ最初から選んでいます。保存すると「手動の分類」として、以後その病名に使います。</span></div>`;
    $("#clsAll").onchange = (e) => document.querySelectorAll("[data-cls-i]:not([disabled])").forEach((c) => (c.checked = e.target.checked));
    $("#clsApply").onclick = async () => {
      let nc = 0, ng = 0;
      document.querySelectorAll("[data-cls-i]").forEach((c) => {
        if (!c.checked) return;
        const x = res.items[c.dataset.clsI];
        if (x.cat) { state.overrides[x.name] = x.cat; nc++; }
        if (x.group && x.group !== autoGroup(x.name)) { state.groups[x.name] = x.group; ng++; }
      });
      await saveState();
      toast(`分類${nc}件・まとめ${ng}件を保存しました`);
      render();
    };
  };
  // ---- AIでまとめる：病名の一覧を書き出し、AIの回答（病名⇥まとめ先）を読み込む
  const grpAll = () => document.querySelector("[name=grpScope]:checked").value === "all";
  const grpList = () => {
    if (!grpAll() && !Object.keys(names).some((nm) => !isGrouped(nm)) && Object.keys(names).length) {
      document.querySelector("[name=grpScope][value=all]").checked = true;
      toast("まとめ先がない病名がないため、すべての病名（いまのまとめ先つき）を書き出します");
    }
    return Object.keys(names).filter((nm) => grpAll() || !isGrouped(nm)).sort(jaCmp);
  };
  const grpOut = async (site) => {
    const list = grpList();
    if (!list.length) { toast("病名がありません（月報を取り込むと書き出せます）"); return null; }
    return { list, ...(await stampAiText(grpPrompt(list, grpAll()), site, { month: curMonth() || "", scope: `病名のまとめ方（${list.length}件）`, period: "" })) };
  };
  document.querySelectorAll("[data-grp-go]").forEach((b) => (b.onclick = async () => {
    const k = b.dataset.grpGo, name = AI_SITES.find((x) => x[0] === k)[1], url = aiUrls()[k];
    const o = await grpOut(name);
    if (!o) return;
    if (!(await copyText(o.t))) { toast("コピーできませんでした"); return; }
    if (url) window.open(url, "_blank", "noopener");
    toast(`病名${o.list.length}件をコピーしました（管理番号 ${o.id}）。${name} に貼り付けて送り、回答を「③」に貼り付けてください`);
  }));
  $("#grpDl").onclick = async () => {
    const o = await grpOut("ファイル保存");
    if (!o) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([o.t], { type: "text/plain;charset=utf-8" }));
    a.download = `病名のまとめ方_AI用_${o.id}.txt`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $("#grpFile").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; $("#grpAns").value = await f.text(); e.target.value = ""; $("#grpParse").onclick(); };
  $("#grpParse").onclick = () => {
    const res = parseGrpAnswer($("#grpAns").value, Object.keys(names));
    const box = $("#grpPreview");
    if (!res.items.length) { box.innerHTML = '<div class="ai-warn">読み取れる行がありませんでした。回答が「病名⇥まとめ先」（タブ・カンマ・| 区切り）の形か確かめてください。</div>'; return; }
    // まとめ先ごとに並べる（同じまとめ先になった病名が並んで見える）
    const items = res.items.slice().sort((a, b) => jaCmp(a.group, b.group) || jaCmp(a.name, b.name));
    box.innerHTML = `<div class="table-wrap" style="max-height:360px"><table class="mini"><thead><tr><th><input type="checkbox" id="grpAllChk" checked></th><th>病名</th><th class="num">件数</th><th>いまのまとめ先</th><th>AIのまとめ先</th></tr></thead><tbody>
      ${items.map((x, i) => { const chg = x.group !== groupOf(x.name);
        return `<tr><td><input type="checkbox" data-grp-i="${i}"${chg ? " checked" : ""}></td><td>${esc(x.name)}</td><td class="num">${names[x.name] || ""}</td><td class="muted">${esc(groupOf(x.name))}</td>
          <td>${chg ? `<b>${esc(x.group)}</b>` : esc(x.group)}${GROUP_NAMES.includes(x.group) || Object.values(state.groups).includes(x.group) || x.group === x.name ? "" : ' <span class="badge">新しいまとめ先</span>'}</td></tr>`; }).join("")}</tbody></table></div>
      ${res.unknown.length ? `<p class="muted">月報にない病名のため読み飛ばしたもの：${esc(res.unknown.slice(0, 20).join("、"))}${res.unknown.length > 20 ? ` ほか${res.unknown.length - 20}` : ""}</p>` : ""}
      <div class="row"><button class="primary" id="grpApply">選んだ病名のまとめ先を保存</button><span class="muted">変わるものだけ最初から選んでいます。保存すると「手動」のまとめ先として、以後その病名に使います。</span></div>`;
    $("#grpAllChk").onchange = (e) => document.querySelectorAll("[data-grp-i]").forEach((c) => (c.checked = e.target.checked));
    $("#grpApply").onclick = async () => {
      let ng = 0;
      document.querySelectorAll("[data-grp-i]").forEach((c) => {
        if (!c.checked) return;
        const x = items[c.dataset.grpI];
        if (x.group === autoGroup(x.name)) delete state.groups[x.name]; else state.groups[x.name] = x.group;
        ng++;
      });
      await saveState();
      toast(`まとめ先${ng}件を保存しました`);
      render();
    };
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
  $("#exp").onclick = async () => { await exportBackup(true); render(); };
  if ($("#pickBkdir")) $("#pickBkdir").onclick = async () => { if (await bkdirChoose()) { $("#bkdirbar").hidden = true; render(); } };
  $("#mkFolder").onclick = makeAppFolderZip;
  document.querySelectorAll("[data-bug]").forEach((b) => (b.onclick = reportBug));
  $("#errCopy").onclick = async () => {
    const lines = [`月報くん 動作の記録（${new Date().toLocaleString("ja-JP")}）`, `版：${offline.version || "―"}`, `ブラウザ：${navigator.userAgent}`, storageStatusText(),
      `月報：${Object.keys(state.reports).length}件・${months().length}か月`, "", ...(ERROR_LOG.length ? ERROR_LOG.map((x) => `${x.at}　${x.kind}　${x.msg}　${x.where}`) : ["（エラーの記録はありません）"])];
    toast((await copyText(lines.join("\n"))) ? "動作の記録をコピーしました" : "コピーできませんでした");
  };
  $("#ocrTest").onclick = async () => {
    const st = $("#ocrTestSt"), b = $("#ocrTest");
    b.disabled = true; st.textContent = "確認中…（初回は準備に数秒〜数十秒）";
    try {
      const r = await ocrSelfTest();
      const okk = /受診/.test(r.text) && /12/.test(r.text);
      st.innerHTML = `${okk ? "✅ OCRは動いています" : "⚠ 読めましたが、見本と違う結果です"}（${r.sec}秒）：<code>${esc(r.text.replace(/\n/g, " ⏎ ") || "（空）")}</code>`;
    } catch (e) { console.warn(e); st.innerHTML = `❌ OCRが動きません：${esc(e.message || String(e))}`; }
    finally { b.disabled = false; }
  };
  document.querySelectorAll("[data-dis-csv]").forEach((b) => (b.onclick = exportDiseaseCsv));
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
      Object.assign(doneCls(), o.doneCls || {}); Object.assign(doneGrp(), o.doneGrp || {});
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
    for (const k of Object.keys(state.rosters)) if (rosterKeyMonth(k) === m) delete state.rosters[k];
    delete state.junkai[m];
    await saveState(); refreshMonths(); render();
  }));
  // 在籍人数：「公館名,職員,家族」を1行ずつ読む（公館名は別名・英語名でもよい）
  $("#homeSave").onclick = () => {
    const v = $("#homePost").value.trim(), p = v ? resolvePlace(v) : "";
    if (v && !(p && INFO[p])) { $("#homeMsg").textContent = `「${v}」が公館の一覧に見つかりません`; return; }
    savePref("homePost", p || ""); $("#homePost").value = p || ""; $("#homeMsg").textContent = p ? `自分の公館を「${p}」にしました` : "自分の公館を選ばない設定にしました";
  };
  $("#homeClear").onclick = () => { savePref("homePost", ""); $("#homePost").value = ""; $("#homeMsg").textContent = "自分の公館を選ばない設定にしました"; };
  $("#hcSave").onclick = async () => {
    const out = {}, bad = [];
    for (const line of $("#hcText").value.split(/\n/).map((l) => nfkc(l).trim()).filter(Boolean)) {
      const [name, a, b, ym] = line.split(/[,\t、]/).map((x) => x.trim());
      const post = resolvePlace(name);
      if (/公館|在籍|人数/.test(name) && !post) continue;   // 貼り付けた表の見出しの行
      if (!post || !INFO[post] || !(Number(a) >= 0)) { bad.push(name || line); continue; }
      const mm = (ym || "").match(/(\d{4})\D?(\d{1,2})/), from = mm ? `${mm[1]}-${mm[2].padStart(2, "0")}` : "";
      (out[post] ||= []).push({ from, staff: Number(a) || 0, family: Number(b) || 0 });
    }
    state.headcount = out;
    await saveState();
    $("#hcMsg").textContent = `${Object.keys(out).length}公館の在籍人数を保存しました${bad.length ? `（読めなかった行：${bad.slice(0, 5).join("、")}${bad.length > 5 ? " ほか" : ""}）` : ""}`;
  };
  $("#wipe").onclick = async () => {
    if (!confirm("すべてのデータを削除します。元に戻せません。よろしいですか？")) return;
    state = { reports: {}, rosters: {}, junkai: {}, overrides: {}, groups: {}, cases: {} };
    await saveState();
    await pdfStoreDel((await pdfStoreList()).map((x) => x.id)).catch(() => {});
    refreshMonths(); render();
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
      const reg = offline.reg = await navigator.serviceWorker.register("sw.js");
      // 新しい版が入ったらすぐ有効にする（アプリ本体はネット優先で取るので、古い版と混ざらない）
      const promote = (w) => w && w.addEventListener("statechange", () => w.state === "installed" && w.postMessage("skipWaiting"));
      promote(reg.installing);
      reg.addEventListener("updatefound", () => promote(reg.installing));
      await navigator.serviceWorker.ready;
      (navigator.serviceWorker.controller || reg.active).postMessage("version");
    } catch (e) { console.warn("service worker", e); }
  });
}
// ---- 動作の安定のために
// ① ブラウザに「このサイトのデータを消さないで」と頼む（空き容量が少ないときに、ブラウザが自動で消すことがあるため）
const storageInfo = { persisted: null, usage: 0, quota: 0 };
(async () => {
  try {
    if (navigator.storage && navigator.storage.persist) storageInfo.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); storageInfo.usage = e.usage || 0; storageInfo.quota = e.quota || 0; }
  } catch (e) { console.warn("storage", e); }
})();
function storageStatusText() {
  const mb = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);
  return `ブラウザ内の保存：${storageInfo.persisted === true ? "✅ 自動で消されない設定になっています" : storageInfo.persisted === false ? "⚠ ブラウザが空き容量の不足時に消すことがある設定です（バックアップを忘れずに）" : "確認中"}`
    + (storageInfo.quota ? `／使用 ${mb(storageInfo.usage)}MB（上限の目安 ${mb(storageInfo.quota)}MB）` : "");
}
// ② 思わぬエラーを記録する（設定の「動作の記録」で見られ、コピーして知らせられる。エラーの文言だけで、月報の内容は入れない）
const ERROR_LOG = [];
const logError = (kind, msg, where) => {
  ERROR_LOG.unshift({ at: new Date().toLocaleString("ja-JP"), kind, msg: String(msg || "").slice(0, 300), where: String(where || "").slice(0, 120) });
  ERROR_LOG.length = Math.min(ERROR_LOG.length, 50);
};
window.addEventListener("error", (e) => logError("エラー", e.message, `${(e.filename || "").split("/").pop()}:${e.lineno || ""}`));
window.addEventListener("unhandledrejection", (e) => logError("処理の失敗", (e.reason && (e.reason.message || e.reason)) || "", ((e.reason && e.reason.stack) || "").split("\n")[1] || ""));
// ---- チュートリアル（使い方）：月報を同期して、エクスプローラから取り込みの画面へドラッグ＆ドロップするまでを、図で順に説明する
// 図は画面写真ではなく、要点だけを描いたもの（公開のページなので、組織内のページのアドレス・サーバー名・パスワードは載せない）
const TUT_STEPS = [
  { title: "医務官用執務参考データのページで「同期」を押す",
    html: `<p>組織内のポータルの<b>「医務官用執務参考データ」</b>のページを開き、<b>【医務官月報】</b>のドキュメントの一覧の上にある <b>「🔄 同期」</b> を押します。</p>
      <div class="tut-fig"><div class="mk-bar"><b>【医務官月報】</b><span>▦ グリッド ビューで編集</span><span>Excel にエクスポート</span><span class="mk-hot">🔄 同期</span><span class="mk-blue">＋ 作成またはアップロード</span></div></div>
      <p class="muted">同期すると、パソコンのエクスプローラ（左の一覧）に <b>「医務官用執務参考データ - 医務官月報」</b> のフォルダが出ます。同期は最初に1回だけで、そのあとは新しい月報が自動で届きます。</p>` },
  { title: "エクスプローラで、月報のフォルダを開く",
    html: `<p>エクスプローラの左の一覧から <b>「医務官用執務参考データ - 医務官月報」</b> を開き、<b>年度</b> → <b>地域</b>（1_Africa、1_Asia_Pacific、1_Europe、1_Middle_East、1_North_South_America）のフォルダを開きます。</p>
      <div class="tut-fig mk-exp"><div class="mk-left"><div>🏢 （組織のフォルダ）</div><div class="mk-ind">📁 …参考データ - マラリア・デング熱報告書</div><div class="mk-ind mk-sel">📁 …参考データ - 医務官月報</div><div class="mk-ind">📁 …参考データ - 緊急移送</div></div>
        <div class="mk-right"><div class="mk-crumb">医務官月報 › 2026年度 ›</div><div>📁 1_Africa</div><div>📁 1_Asia_Pacific</div><div>📁 1_Europe</div><div>📁 1_Middle_East</div><div>📁 1_North_South_America</div></div></div>
      <p class="muted">雲のマーク（☁）のファイルは、開いたとき・ドラッグしたときにパソコンへ取り込まれます。</p>` },
  { title: "月報くんの「取り込み」で「ファイル名から自動で読み取る」を選ぶ",
    html: `<p>月報くんの <b>「取り込み」</b> タブの <b>① 対象月の決め方</b> で、<b>「ファイル名から自動で読み取る」</b> を選びます（ふだんはこちら）。ファイル名の「202609」「2026年9月」などから、何月分かを自動で読みます。</p>
      <div class="tut-fig"><div class="mk-radio mk-on">◉ <b>ファイル名から自動で読み取る</b><br><span class="muted">例：ケニア_202607.pdf、2026年7月_ケニア.docx …</span></div><div class="mk-radio">○ 手動で指定する</div></div>`, show: "mmode" },
  { title: "月報のファイル（またはフォルダごと）を、取り込みの枠へドラッグ＆ドロップ",
    html: `<p>エクスプローラで読み込みたい月報を選び（Ctrl や Shift で複数選べます）、月報くんの <b>② の点線の枠</b> へ<b>ドラッグ＆ドロップ</b>します。<b>地域や年度のフォルダごと</b>入れることもできます。</p>
      <div class="tut-fig mk-drag"><div class="mk-files"><div>📄 ケニア_202609.pdf</div><div>📄 タンザニア_202609.pdf</div><div>📁 1_Asia_Pacific</div></div><div class="mk-arrow">➜</div><div class="mk-drop">ここに月報のファイルやフォルダを<br>ドラッグ＆ドロップ</div></div>
      <p class="muted">「ファイルを選ぶ」「フォルダを選ぶ」のボタンからでも入れられます。パスワード付きのPDFもそのまま開きます。同じファイルを入れたときは、重ねて入れません。</p>`, show: "drop" },
  { title: "「読み取り開始」→ 確認の表を見て「保存する」",
    html: `<p><b>③「読み取り開始」</b>を押すと、月報を読み取って<b>確認の表</b>が出ます。<span class="badge warn">要確認</span> の行は、すぐ下の指摘と「詳細を見る」（甲表・乙表・丙表・ページの画像）で確かめて直し、<b>「保存する」</b>を押します。</p>
      <div class="tut-fig"><div class="mk-row"><span class="badge">OK</span> ケニア_202609.pdf　2026年9月　ケニア　…</div><div class="mk-row"><span class="badge warn">要確認</span> タイ_202609.pdf　…<div class="mk-warn">⚠ 受診者数の合計が一致しません　▸ 詳細を見る</div></div><div class="mk-btns"><span class="mk-blue">保存する</span><span>要確認以外をすべて保存</span></div></div>
      <ul class="muted"><li>文字が読めない（スキャン・図形の）月報は「🔎 OCRで読み取ってみる」で読めることがあります。</li><li>読み取り中は「⏸ 一時停止」もできます。保存していない結果は、閉じても次に開いたときに戻ります。</li></ul>`, show: "start" },
  { title: "保存できたら：集計・PDFレポート・バックアップ",
    html: `<p>保存した月報は、<b>ダッシュボード・統計・世界地図・推移・PDFレポート</b>などにすぐ反映されます。足りない月報は「取り込み」タブの <b>📮 提出状況</b> で分かります。</p>
      <p>データはこのパソコンのブラウザの中だけにあります。<b>「💾 バックアップ」</b>を押して、月報くんの「バックアップ」フォルダに保存しておきましょう（一度つなぐと、あとは自動で保存します）。</p>
      <p class="muted">困ったときは、上の <b>🐞 不具合報告</b> から知らせてください。この説明は、いつでも上の <b>📘 使い方</b> から見られます。</p>`, show: "backup" },
];
let tutStep = 0;
function tutDraw() {
  const st = TUT_STEPS[tutStep], n = TUT_STEPS.length;
  $("#tutStepNo").textContent = `${tutStep + 1} / ${n}`;
  $("#tutDots").innerHTML = TUT_STEPS.map((x, i) => `<button class="tut-dot${i === tutStep ? " on" : ""}" data-tut="${i}" title="${esc(x.title)}">${i + 1}</button>`).join("");
  $("#tutBody").innerHTML = `<h3>${tutStep + 1}. ${esc(st.title)}</h3>${st.html}`;
  $("#tutPrev").disabled = tutStep === 0;
  $("#tutNext").textContent = tutStep === n - 1 ? "おわり" : "次へ ▶";
  $("#tutShow").hidden = !st.show;
  document.querySelectorAll("[data-tut]").forEach((b) => (b.onclick = () => { tutStep = Number(b.dataset.tut); tutDraw(); }));
}
function openTutorial(step = 0) {
  tutStep = step; tutDraw();
  $("#tutBack").hidden = true;
  if (!$("#tut").open) $("#tut").showModal();
  savePref("tutSeen", 1);
}
// 「この画面の場所を見る」：説明を閉じて、取り込みの画面のその場所を光らせる
function tutSpotlight(key) {
  $("#tut").close();
  if (page !== "import" && key !== "backup") { page = "import"; savePref("page", page); render(); }
  const el = key === "mmode" ? document.querySelector('input[name="mmode"][value="auto"]')?.closest("label") : key === "drop" ? $("#drop") : key === "start" ? $("#start") : $("#backupTop");
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("tut-hl");
    setTimeout(() => el.classList.remove("tut-hl"), 4000);
  }
  $("#tutBack").hidden = false;
}
$("#tutBtn").onclick = () => openTutorial(0);
$("#tutClose").onclick = () => $("#tut").close();
$("#tutPrev").onclick = () => { if (tutStep > 0) { tutStep--; tutDraw(); } };
$("#tutNext").onclick = () => { if (tutStep < TUT_STEPS.length - 1) { tutStep++; tutDraw(); } else $("#tut").close(); };
$("#tutShow").onclick = () => tutSpotlight(TUT_STEPS[tutStep].show);
$("#tutBack").onclick = () => openTutorial(tutStep);

// AIに渡す文章を CSV の行にする：文の行は1列、表（| … |）の行は列に分ける（区切りの行は除く）
function aiTextCsvRows(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const l = line.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) out.push(cells);
    } else out.push([l]);
  }
  return out;
}
// AIに渡す文章（Markdown の見出し・箇条書き・表）を Excel にする：
// 「依頼と本文」のシート（表以外の行）と、表ごとのシート（直前の見出しを名前に。見出しの行・データの行に分ける）
function aiTextWorkbook(text) {
  const wb = XLSX.utils.book_new(), body = [], tables = [];
  let heading = "", cur = null;
  for (const line of String(text || "").split("\n")) {
    const l = line.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;   // 区切りの行
      if (!cur) { cur = { name: heading || `表${tables.length + 1}`, rows: [] }; tables.push(cur); body.push(`（表：「${cur.name}」のシート）`); }
      cur.rows.push(cells.map((c) => (/^-?\d+(\.\d+)?$/.test(c) ? Number(c) : c)));
      continue;
    }
    cur = null;
    if (/^#{1,4}\s/.test(l)) heading = l.replace(/^#+\s*/, "").trim();
    body.push(l);
  }
  const s1 = XLSX.utils.aoa_to_sheet(body.map((l) => [l]));
  s1["!cols"] = [{ wch: 120 }];
  XLSX.utils.book_append_sheet(wb, s1, "依頼と本文");
  const used = new Set(["依頼と本文"]);
  for (const tb of tables) {
    let nm = tb.name.replace(/[\[\]:*?/\\]/g, "").replace(/[^\p{L}\p{N}（）()・ー\-、 ]/gu, "").trim().slice(0, 28) || "表";
    for (let k = 2; used.has(nm); k++) nm = `${nm.slice(0, 25)}_${k}`;
    used.add(nm);
    const sh = XLSX.utils.aoa_to_sheet(tb.rows);
    sh["!cols"] = (tb.rows[0] || []).map((_, i) => ({ wch: i === 0 ? 22 : 14 }));
    XLSX.utils.book_append_sheet(wb, sh, nm);
  }
  return wb;
}
// ---- 不具合報告：メールソフト（Outlook など）で、宛先・件名・本文の下書きを開く
// 本文には、画面・版・ブラウザ・保存の状態・エラーの記録だけを入れる（月報の内容・氏名などの個人情報は入れない）
const BUG_TO = "yusuke.hoshino@mofa.go.jp";
function bugReportText() {
  const tab = (document.querySelector(`#tabs button[data-page="${page}"]`) || {}).textContent || page;
  return [
    "（どの画面で、何をしたら、どうなったかを書いてください。月報の内容・氏名などの個人情報は書かないでください）",
    "", `・画面（タブ）：${tab}`, "・したこと：", "・起きたこと：", "・本来はどうなってほしいか：", "",
    "―― 以下は自動で入る情報です（月報の内容・個人情報は含みません）――",
    `日時：${new Date().toLocaleString("ja-JP")}`, `版：${offline.version || "―"}`, `ブラウザ：${navigator.userAgent}`,
    `画面の大きさ：${innerWidth}×${innerHeight}`, typeof storageStatusText === "function" ? storageStatusText() : "",
    `月報：${Object.keys(state.reports).length}件・${months().length}か月${demoMode ? "（デモ表示中）" : ""}`,
    `エラーの記録（新しい順・最大10件）：`, ...(ERROR_LOG.length ? ERROR_LOG.slice(0, 10).map((x) => `  ${x.at}　${x.kind}　${x.msg}　${x.where}`) : ["  なし"]),
  ].filter((x) => x !== undefined).join("\n");
}
async function reportBug() {
  const body = bugReportText(), subject = `【月報くん】不具合報告（${new Date().toLocaleDateString("ja-JP")}）`;
  // 念のため本文をコピーしておく（メールソフトが開かないときに、メールに貼り付けられるように）
  await copyText(`宛先：${BUG_TO}\n件名：${subject}\n\n${body}`).catch(() => false);
  const url = `mailto:${BUG_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
  location.href = url;
  toast(`メールの下書きを開きます（宛先：${BUG_TO}）。開かないときは、コピーした内容をメールに貼り付けて送ってください。画面の写真を付けるときは、個人情報が写っていないか確かめてください`);
}
$("#bugBtn").onclick = reportBug;
// アプリはブラウザのタブで開く（manifest の display: browser。別の窓・タスクバーには出さない）。
// デスクトップから開けるようにするには、アドレスバーの左端をデスクトップへドラッグしてショートカットを作る
$("#installBtn").hidden = false;
$("#installBtn").onclick = () => {
  if (confirm("「月報くん」フォルダ（zip）を作ります。\n\n展開したフォルダを医務官のみがアクセスできる場所に置き、中の「月報くん（Chromeのタブで開く）」をダブルクリックすると、Chrome のタブでアプリが開きます。中の「バックアップ」フォルダに自動でバックアップします（設定タブの「📁 バックアップフォルダを選ぶ」で一度つなぐ）。\n\n作りますか？")) makeAppFolderZip();
};
// 以前「アプリとして追加」した人は、アプリの窓（タスクバーの別の窓）で開くことがある。ブラウザのタブで開き直せるように案内する
(() => {
  const standalone = ["standalone", "minimal-ui", "window-controls-overlay", "fullscreen"].some((m) => matchMedia(`(display-mode: ${m})`).matches);
  const bar = $("#tabmodebar");
  if (!bar || !standalone || TOUR_TAB || new URLSearchParams(location.search).has("pdfjob")) return;
  let hidden = false;
  try { hidden = sessionStorage.getItem("geppou.tabmodeHide") === "1"; } catch {}
  bar.hidden = hidden;
  $("#tabmodeHide").onclick = () => { bar.hidden = true; try { sessionStorage.setItem("geppou.tabmodeHide", "1"); } catch {} };
  $("#tabmodeHow").onclick = () => alert([
    "いつもブラウザのタブで開くようにするには（データは消えません）：",
    "",
    "【Chrome】アドレス欄に chrome://apps と入れて開き、「医務官月報」を右クリック →「ウィンドウとして開く」のチェックを外す。",
    "　（または、このアプリの窓の右上「︙」→「医務官月報 をアンインストール」。そのとき「Chrome からデータも削除する」にはチェックを付けない）",
    "",
    "【Edge】アドレス欄に edge://apps と入れて開き、「医務官月報」の「…」→「アンインストール」。そのとき「データも削除する」にはチェックを付けない。",
    "",
    "そのあとは、ブラウザで公開URL（https://ysk713.github.io/-/geppou/）を開くか、上の「🖥 デスクトップに置く」の手順でショートカットを作ってください。",
    "念のため、先に「💾 バックアップ」で書き出しておくと安心です。",
  ].join("\n"));
})();
// URLをクリックしたときに既定のブラウザ（Edge）で開いた：データは Chrome 側にあるので、Chrome のタブで開くよう案内する
const IS_EDGE = /\bEdg\//.test(navigator.userAgent);
const CHROME_HOW = [
  "URLをクリックしたときに、いつも Chrome のタブで開くようにするには：", "",
  "【方法1】Chrome を既定のブラウザにする",
  "　Chrome の右上「︙」→「設定」→「既定のブラウザ」→「デフォルトに設定」。",
  "　Windows の「既定のアプリ」が開いたら「Google Chrome」→「既定値に設定」。",
  "　（組織の設定で変えられないときは、方法2を使ってください）", "",
  "【方法2】月報くんフォルダの「月報くん（Chromeのタブで開く）」をダブルクリックする",
  "　既定のブラウザが Edge のままでも、Chrome のタブで開きます。",
  "　フォルダは、設定タブの「📦 月報くんフォルダを作る」で作れます（作り直してもデータは消えません）。", "",
  "【以前「アプリとして追加」した場合】",
  "　Chrome のアドレス欄に chrome://apps と入れ、「月報くん」を右クリック →「ウィンドウとして開く」のチェックを外す。",
  "　（アプリの窓ではなく、Chrome のタブで開くようになります）",
].join("\n");
(() => {
  const bar = $("#browserbar");
  if (!bar || !IS_EDGE || TOUR_TAB || new URLSearchParams(location.search).has("pdfjob")) return;
  let hide = false;
  try { hide = localStorage.getItem("geppou.browserbarHide") === "1"; } catch {}
  if (hide) return;
  // Edge にデータがない（ふだんは Chrome で使っている）ときだけ出す
  setTimeout(() => { if (!demoMode && !Object.keys(state.reports).length) bar.hidden = false; }, 1500);
  $("#copyUrlChrome").onclick = async () => toast((await copyText(new URL("./", location.href).href.split("?")[0])) ? "URLをコピーしました。Chrome のアドレス欄に貼り付けて開いてください" : "コピーできませんでした");
  $("#browserHow").onclick = () => alert(CHROME_HOW);
  $("#browserHide").onclick = () => { bar.hidden = true; try { localStorage.setItem("geppou.browserbarHide", "1"); } catch {} };
})();
// 同じアプリを2つのタブで開いているとき：片方で保存したら、もう片方も読み直す（古い内容で上書きしないように）
if (stateChannel) stateChannel.onmessage = async (e) => {
  if (!e.data || e.data.t !== "saved" || demoMode) return;
  await loadState();
  clearCaches();
  if (!importBusy) render();
  toast("別のタブで保存された内容を読み込みました");
};

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
addEventListener("scroll", () => {
  const t = $("#tabs");
  if (!t) return;
  const stuck = t.getBoundingClientRect().top <= 0 && scrollY > 0;
  t.classList.toggle("stuck", stuck);
  // 上部の「💾 バックアップ」が見えないあいだは、固定されたメニューの右端に小さなボタンを出す
  const f = $("#backupFloat");
  if (f) f.hidden = !stuck || t.hidden;
}, { passive: true });
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
  const m = params.get("m"), span = params.has("span") ? Number(params.get("span")) : 1, regs = (params.get("regs") || "").split(",").filter((g) => AI_REGIONS.includes(g)),
    posts = (params.get("posts") || "").split(",").filter((x) => INFO[x]),
    stats = params.has("stats") ? params.get("stats").split(",").filter((k) => STAT_ITEMS.some((x) => x[0] === k)) : STAT_ITEMS.map((x) => x[0]),
    aiNotes = (params.get("ains") || "").split(",").filter(Boolean), sumLines = pdfSumLines(params.get("sl")),
    statNotes = params.has("sns") ? params.get("sns").split(",").filter(Boolean) : null;
  const sections = new Set(secsCompat((params.get("secs") || REPORT_SECTIONS.map((x) => x[0]).join(",")).split(",")).filter((k) => REPORT_SECTIONS.some((x) => x[0] === k)));
  document.body.classList.add("pdfjob");
  document.title = "PDFレポートを作成中…";
  $("#tabs").hidden = true; document.querySelector(".head-right").hidden = true; $("#backupbar").hidden = true;
  main.innerHTML = `
    <h2>統合PDFレポート（${m ? reportLabel(m, span) + (regs.length || posts.length ? "・" + regionsLabel(regs, posts) : "") : ""}）</h2>
    <div class="card" id="jobcard">
      <p><b id="jobst">準備しています…</b></p>
      <div class="jobbar"><div id="jobfill"></div></div>
      <div class="row"><button class="danger" id="jobStop">■ 作成を中止</button><span class="muted">作成中も、元のタブで作業を続けられます。</span></div>
    </div>
    <div id="jobout"></div>`;
  const step = (txt) => {
    $("#jobst").textContent = txt;
    const mm = txt.match(/(\d+)\s*\/\s*(\d+)/);
    $("#jobfill").style.width = (mm ? 15 + 80 * (+mm[1] / +mm[2]) : /暗号/.test(txt) ? 97 : 8) + "%";
    document.title = `PDF作成中 ${txt.replace(/^.*?(\d+\s*\/\s*\d+).*$/, "$1")}`;
  };
  $("#jobStop").onclick = () => { pdfCancel = true; $("#jobStop").disabled = true; $("#jobst").textContent = "中止しています…（いま作っているページが終わったら止まります）"; };
  try {
    if (params.get("demo") ? !(await loadDemoData()) : (await loadState(), false)) throw new Error("データを読み込めませんでした");
    // 見出しの期間は、データを読み込んでから書く（読み込む前は「全期間」が1か月に見えてしまう）
    if (m) main.querySelector("h2").textContent = `統合PDFレポート（${reportLabel(m, span) + (regs.length || posts.length ? "・" + regionsLabel(regs, posts) : "")}）`;
    const inS = inReportScope(regs, posts);
    if (!m || !spanMonths(m, span).some((mm) => reportsOf(mm).some((r) => inS(r.post)))) throw new Error("選んだ期間・地域・国のデータがありません");
    const ropt = { span, regions: regs, posts, stats, aiNotes, statNotes, sumLines, privMental: params.get("pm") !== "0" };
    const docxName = reportFileName(m, span, regs, posts, sections).replace(/\.pdf$/, ".docx");
    // Word で作るとき：できた .docx を保存するボタンを出す
    if (params.get("fmt") === "docx") {
      document.title = "Wordレポートを作成中…";
      main.querySelector("h2").textContent = main.querySelector("h2").textContent.replace("統合PDFレポート", "統合レポート（Word）");
      const doc = await buildReportDocx(m, sections, step, ropt);
      const durl = URL.createObjectURL(doc);
      document.title = `Wordレポート ${reportLabel(m, span)}`;
      $("#jobcard").innerHTML = `<p><b>できました（Word 文書・${(doc.size / 1048576).toFixed(1)} MB）</b></p>
        <p style="margin:4px 0">ファイル名：<b>${esc(docxName)}</b></p>
        <div class="row"><a class="btn primary" id="jobdocx" href="${durl}" download="${esc(docxName)}">💾 保存（Word .docx）</a><button id="jobclose">このタブを閉じる</button></div>
        <p class="muted" style="margin-bottom:0">保存するときは、医務官のみがアクセスできるフォルダに保存してください。Word で開くと、文章・表を書き直せます。</p>`;
      $("#jobclose").onclick = () => window.close();
      if (window.showSaveFilePicker) $("#jobdocx").onclick = async (e) => { e.preventDefault(); const n = await savePdfAs(doc, docxName); if (n) toast(`「${n}」を保存しました`); };
      return;
    }
    const blob = await buildReportPdf(m, sections, step, ropt);
    const fname = reportFileName(m, span, regs, posts, sections), named = await namedPdfUrl(blob, fname), url = named || URL.createObjectURL(blob);
    await pdfStoreAdd(blob, fname, `${reportLabel(m, span)}${regs.length || posts.length ? "・" + regionsLabel(regs, posts) : ""}`);
    document.title = `PDFレポート ${reportLabel(m, span)}`;
    $("#jobcard").innerHTML = `<p><b>できました（${(blob.size / 1048576).toFixed(1)} MB。10MB 未満に収めています）</b>　下で中身を確かめられます。</p>
      <p style="margin:4px 0">ファイル名：<b>${esc(fname)}</b>（「💾 保存」でこの名前のPDFを保存します）</p>
      <div class="row"><a class="btn primary" id="jobdl" href="${url}" download="${esc(fname)}">💾 保存（PDF）</a>
      <button id="jobword" title="同じ内容を Word 文書（.docx）で作ります">📝 Wordでも保存（.docx）</button>
      <button id="jobprint">🖨 印刷</button>
      <label class="muted">ページへ移動 <select id="jobjump"></select></label>
      <a class="btn" href="${url}" target="_blank" rel="noopener">PDFをビューアで開く</a>
      <button id="jobclose">このタブを閉じる</button></div>
      <p class="muted" id="jobnote" style="margin-bottom:0">保存するときは、医務官のみがアクセスできるフォルダに保存してください。印刷すると全ページに「${WATERMARK}」の透かしが入ります。</p>`;
    // ページの画像を並べて表示する（目次の行は押すとその章へ移動）
    const pv = blob.preview || { pages: [], links: [], outlines: [] };
    const purls = pv.pages.map((pg) => URL.createObjectURL(new Blob([pg.jpeg], { type: "image/jpeg" })));
    $("#jobout").innerHTML = `<div class="jobview">${purls.map((u, i) => `<div class="jobpage" id="jobp${i}"><img src="${u}" alt="${i + 1}ページ">${
      pv.links.filter((l) => l.page === i).map((l) => `<a class="joblink" href="#jobp${l.dest}" style="left:${(100 * l.rect[0]).toFixed(2)}%;top:${(100 * l.rect[1]).toFixed(2)}%;width:${(100 * l.rect[2]).toFixed(2)}%;height:${(100 * l.rect[3]).toFixed(2)}%" title="${l.dest + 1}ページへ"></a>`).join("")}<span class="jobno">${i + 1} / ${purls.length}</span></div>`).join("")}</div>`;
    $("#jobjump").innerHTML = pv.outlines.map((o) => `<option value="${o.dest}">${esc(o.title)}（${o.dest + 1}ページ）</option>`).join("");
    $("#jobjump").onchange = () => { const el = $("#jobp" + $("#jobjump").value); if (el) el.scrollIntoView({ behavior: "smooth" }); };
    $("#jobprint").onclick = () => window.print();
    $("#jobword").onclick = async () => {
      const b = $("#jobword"); b.disabled = true; const keep = b.textContent;
      try {
        const doc = await buildReportDocx(m, sections, (t) => (b.textContent = "📝 " + t), ropt);
        const n = await savePdfAs(doc, docxName); if (n) toast(`「${n}」を保存しました`);
      } catch (e) { console.error(e); toast("Wordの作成に失敗しました: " + e.message); }
      finally { b.disabled = false; b.textContent = keep; }
    };
    $("#jobclose").onclick = () => window.close();
    // 保存の画面（ファイル名を入れた状態で、保存する場所を選べる）。使えないブラウザでは、リンクのまま（そのファイル名でダウンロード）
    if (window.showSaveFilePicker) $("#jobdl").onclick = async (e) => { e.preventDefault(); const n = await savePdfAs(blob, fname); if (n) toast(`「${n}」を保存しました`); };
  } catch (e) {
    if (e.cancelled) {
      document.title = "PDFレポートの作成を中止しました";
      $("#jobcard").innerHTML = `<p><b>作成を中止しました。</b></p><div class="row"><button class="primary" id="jobclose2">このタブを閉じる</button></div>`;
      $("#jobclose2").onclick = () => window.close();
      return;
    }
    console.error(e);
    document.title = "PDFレポートの作成に失敗しました";
    $("#jobcard").innerHTML = `<p class="bad">作成に失敗しました：${esc(e.message)}</p><p class="muted">元のタブに戻って、もう一度お試しください。</p>`;
  }
}

// ---- 公開URL・ショートカットを開くたびにタブが増えないように：すでに別のタブで開いていれば、新しいタブは自分を閉じる
// （リンクから開いたばかりのタブは、ブラウザが自分で閉じることを許す。閉じられないときは案内とボタンを出す）
const APP_ID = Math.random().toString(36).slice(2);
const appChannel = "BroadcastChannel" in window ? new BroadcastChannel("geppou-main") : null;
function becomeMainTab() {
  if (!appChannel) return;
  appChannel.onmessage = (e) => {
    if (!e.data || e.data.t !== "hello" || e.data.id === APP_ID) return;
    appChannel.postMessage({ t: "here", to: e.data.id });
    const t0 = document.title;
    document.title = "🔔 月報くんはこのタブで開いています";
    setTimeout(() => (document.title = t0), 8000);
    toast("月報くんはこのタブで開いています（新しく開いたタブは閉じました）");
  };
}
async function anotherMainTab() {
  if (!appChannel) return false;
  // 「ブラウザのタブで開く」（アプリの窓から開き直す）で開いたタブは、閉じずにそのまま使う
  if (new URLSearchParams(location.search).has("usetab")) {
    try { sessionStorage.setItem("geppou.useThisTab", "1"); } catch {}
    if (history.replaceState) history.replaceState(null, "", location.pathname);
  }
  try { if (sessionStorage.getItem("geppou.useThisTab") === "1") { becomeMainTab(); return false; } } catch {}
  const found = await new Promise((ok) => {
    const h = (e) => { if (e.data && e.data.t === "here" && e.data.to === APP_ID) { appChannel.removeEventListener("message", h); ok(true); } };
    appChannel.addEventListener("message", h);
    appChannel.postMessage({ t: "hello", id: APP_ID });
    setTimeout(() => { appChannel.removeEventListener("message", h); ok(false); }, 250);
  });
  if (!found) { becomeMainTab(); return false; }
  $("#tabs").hidden = true; $("#backupbar").hidden = true;
  main.innerHTML = `<div class="card dupcard"><h2 style="margin-top:0">月報くんは、別のタブですでに開いています</h2>
    <p>タブが増えないよう、このタブは閉じます。開いているタブ（タブの名前に🔔が付いています）をお使いください。</p>
    <div class="row"><button class="primary" id="dupClose">このタブを閉じる</button><button id="dupUse">このタブで使う</button></div>
    <p class="muted">同じデータを使うので、どちらのタブで作業しても大丈夫です（片方で保存すると、もう片方も読み直します）。</p></div>`;
  $("#dupClose").onclick = () => window.close();
  $("#dupUse").onclick = () => { try { sessionStorage.setItem("geppou.useThisTab", "1"); } catch {} location.reload(); };
  setTimeout(() => window.close(), 700);
  return true;
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
  // ほかのタブへの問い合わせと、データの読み込みを同時に行う（起動を遅くしない）
  const [dup] = await Promise.all([anotherMainTab(), loadState()]);
  if (dup) { window.appReady = true; return; }
  if (qs.has("demo")) { await startDemo(); window.appReady = true; return; }
  // 開いたときは、月報のある最新の年月から始める（前に選んだ月は使わない）
  refreshMonths(latestMonth());
  const saved = loadPrefs().page;
  if (saved && document.querySelector(`#tabs button[data-page="${saved}"]`)) page = saved;
  else if (months().length) page = "dashboard";
  // 保存前の読み取り結果が残っていれば、取り込みタブで続きから確認できるようにする
  const restored = await restoreDrafts();
  if (restored) page = "import";
  render();
  window.appReady = true;   // 起動の処理が終わった印（自動テストが待つ）
  // はじめて使うとき（データがなく、使い方をまだ見ていない）は、注意書きを閉じたあとに使い方を開く
  if (!loadPrefs().tutSeen && !Object.keys(state.reports).length && !navigator.webdriver) {
    const nd = $("#notice");
    if (nd && nd.open) nd.addEventListener("close", () => openTutorial(0), { once: true }); else openTutorial(0);
  }
  bkdirInit();
  if (restored) toast(`前回の続き（${[pending.length && `読み取る前のファイル ${pending.length}件`, drafts.length && `保存していない読み取り結果 ${drafts.length}件`, rosterDrafts.length && `配置表 ${rosterDrafts.length}件`].filter(Boolean).join("・")}）を戻しました`);
})();
