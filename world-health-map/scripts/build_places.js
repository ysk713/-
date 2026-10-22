// 国内ツアー用の地名データ（data/places/XX.json）を全ての国について作る。
// 日本（JP）と中国（CN）は手作りの都道府県・省のデータを使うので作らない。
//
// 使い方（ふだんの収集では使わない。地名を作り直すときだけ手で実行する）:
//   npm install all-the-cities@3.1.0
//   node scripts/build_places.js path/to/node_modules/all-the-cities
//
// 都市の名前・位置・人口は GeoNames（https://www.geonames.org/、CC BY 4.0）を
// all-the-cities パッケージ（MIT）経由で使っている。
const fs = require("fs");
const path = require("path");

const cities = require(path.resolve(process.argv[2] || "all-the-cities"));
const root = path.join(__dirname, "..");
const countries = JSON.parse(fs.readFileSync(path.join(root, "data/countries.json"), "utf8"));
const outDir = path.join(root, "data/places");
const HANDMADE = new Set(["JP", "CN"]);
const MAX_PLACES = 24;
// 英語の普通の単語と同じで、見出しを取り違えやすい都市名
const AMBIGUOUS = new Set(["Nice", "Mobile", "Reading", "Split", "Bath", "Orange", "Union", "Of", "Mission", "Victoria", "Independence",
  "Liberty", "Florence", "Normal", "Hope", "Opportunity", "Bay", "Delta", "Paradise", "Spring", "Enterprise", "Lancaster", "Phoenix"]);
// アメリカは州の名前でニュースに出ることが多いので、州ごとにまとめる（GeoNames の adminCode は州の略号）
const US_STATES = {
  AL: ["アラバマ州", "Alabama"], AK: ["アラスカ州", "Alaska"], AZ: ["アリゾナ州", "Arizona"], AR: ["アーカンソー州", "Arkansas"],
  CA: ["カリフォルニア州", "California"], CO: ["コロラド州", "Colorado"], CT: ["コネチカット州", "Connecticut"], DE: ["デラウェア州", "Delaware"],
  DC: ["ワシントンD.C.", "Washington, D.C."], FL: ["フロリダ州", "Florida"], GA: ["ジョージア州", "Georgia"], HI: ["ハワイ州", "Hawaii"],
  ID: ["アイダホ州", "Idaho"], IL: ["イリノイ州", "Illinois"], IN: ["インディアナ州", "Indiana"], IA: ["アイオワ州", "Iowa"],
  KS: ["カンザス州", "Kansas"], KY: ["ケンタッキー州", "Kentucky"], LA: ["ルイジアナ州", "Louisiana"], ME: ["メイン州", "Maine"],
  MD: ["メリーランド州", "Maryland"], MA: ["マサチューセッツ州", "Massachusetts"], MI: ["ミシガン州", "Michigan"], MN: ["ミネソタ州", "Minnesota"],
  MS: ["ミシシッピ州", "Mississippi"], MO: ["ミズーリ州", "Missouri"], MT: ["モンタナ州", "Montana"], NE: ["ネブラスカ州", "Nebraska"],
  NV: ["ネバダ州", "Nevada"], NH: ["ニューハンプシャー州", "New Hampshire"], NJ: ["ニュージャージー州", "New Jersey"], NM: ["ニューメキシコ州", "New Mexico"],
  NY: ["ニューヨーク州", "New York"], NC: ["ノースカロライナ州", "North Carolina"], ND: ["ノースダコタ州", "North Dakota"], OH: ["オハイオ州", "Ohio"],
  OK: ["オクラホマ州", "Oklahoma"], OR: ["オレゴン州", "Oregon"], PA: ["ペンシルベニア州", "Pennsylvania"], RI: ["ロードアイランド州", "Rhode Island"],
  SC: ["サウスカロライナ州", "South Carolina"], SD: ["サウスダコタ州", "South Dakota"], TN: ["テネシー州", "Tennessee"], TX: ["テキサス州", "Texas"],
  UT: ["ユタ州", "Utah"], VT: ["バーモント州", "Vermont"], VA: ["バージニア州", "Virginia"], WA: ["ワシントン州", "Washington"],
  WV: ["ウェストバージニア州", "West Virginia"], WI: ["ウィスコンシン州", "Wisconsin"], WY: ["ワイオミング州", "Wyoming"],
};
// 州と同じ名前の都市・州名だけでは別の意味になるもの（Georgia は国名、Washington は首都）を見分ける別名
const US_EXTRA = { NY: ["New York State", "NYC", "New York City"], GA: ["Atlanta"], WA: ["Washington State", "Seattle"], DC: ["Washington, D.C.", "D.C."] };

const km = (a, b) => {
  const r = Math.PI / 180;
  const [lon1, lat1] = a.loc.coordinates, [lon2, lat2] = b.loc.coordinates;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const round = (x) => Math.round(x * 100) / 100;

const byCountry = new Map();
for (const c of cities) {
  if (["PPLX", "PPLH", "PPLQ", "PPLW"].includes(c.featureCode)) continue;
  if (!byCountry.has(c.country)) byCountry.set(c.country, []);
  byCountry.get(c.country).push(c);
}

// 人口の多い順に、近すぎる都市（大都市の区など）を除いて選ぶ
function pick(list, gap) {
  const chosen = [];
  for (const c of list) {
    if (chosen.length >= MAX_PLACES) break;
    if (chosen.some((x) => km(x, c) < gap)) continue;
    chosen.push(c);
  }
  return chosen;
}

function cityPlaces(a2, country) {
  const list = (byCountry.get(a2) || []).slice().sort((a, b) => b.population - a.population);
  if (!list.length) return null;
  const capital = list.find((c) => c.featureCode === "PPLC") || list[0];
  let chosen = pick([capital, ...list.filter((c) => c !== capital)], 20);
  if (chosen.length < 4) chosen = pick([capital, ...list.filter((c) => c !== capital)], 3);
  const countryNames = new Set([country.en, ...country.aliases_en].map((s) => s.toLowerCase()));
  const places = chosen.map((c) => {
    const names = [...new Set([c.name, fold(c.name)])]
      .filter((n) => n.length > 2 && !AMBIGUOUS.has(n) && !countryNames.has(n.toLowerCase()));
    return { id: String(c.cityId), ja: c.name, en: c.name, lat: round(c.loc.coordinates[1]), lon: round(c.loc.coordinates[0]),
      pop: c.population, aliases_ja: [], aliases_en: names };
  });
  return { home: String(capital.cityId), places };
}

function usPlaces() {
  const list = (byCountry.get("US") || []).slice().sort((a, b) => b.population - a.population);
  const places = [];
  for (const [code, [ja, en]] of Object.entries(US_STATES)) {
    const inState = list.filter((c) => c.adminCode === code && !["Brooklyn", "Queens", "Manhattan", "The Bronx", "Staten Island"].includes(c.name));
    if (!inState.length) continue;
    const top = inState[0];
    const bigCities = inState.slice(0, 3).map((c) => c.name).filter((n) => n.length > 2 && !AMBIGUOUS.has(n));
    // Georgia（国名）と Washington（首都）は州名だけでは数えない
    const own = code === "GA" || code === "WA" ? [] : [en];
    const pop = inState.reduce((s, c) => s + c.population, 0);
    places.push({ id: code, ja, en, lat: round(top.loc.coordinates[1]), lon: round(top.loc.coordinates[0]), pop,
      aliases_ja: [ja], aliases_en: [...new Set([...own, ...(US_EXTRA[code] || []), ...bigCities.filter((n) => n !== "Washington")])] });
  }
  return { home: "DC", places };
}

let n = 0;
const done = new Set();
for (const c of countries) {
  if (HANDMADE.has(c.a2) || c.a2 === "AQ" || done.has(c.a2)) continue;
  done.add(c.a2);
  const data = c.a2 === "US" ? usPlaces() : cityPlaces(c.a2, c);
  if (!data || !data.places.length) continue;
  data.source = "GeoNames (CC BY 4.0) via all-the-cities";
  fs.writeFileSync(path.join(outDir, `${c.a2}.json`), JSON.stringify(data) + "\n");
  n++;
}
console.log(`wrote ${n} files to ${outDir}`);
