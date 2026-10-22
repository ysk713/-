// ツアーで飛行機が降りる空港を決める（ふだんの収集では使わない。地名を作り直したあとに手で実行する）
//   - data/airports.json: 国ごとの玄関口の空港（首都に近い国際空港）
//   - data/places/XX.json: 各地点に、いちばん近い定期便のある空港（airport）を書き足す
//
// 使い方:
//   npm install airports-json@1.0.0
//   node scripts/build_places.js path/to/node_modules/all-the-cities   （地名を作り直すとき）
//   node scripts/build_airports.js path/to/node_modules/airports-json/data/airports.json
//
// 空港のデータは OurAirports（https://ourairports.com/data/ 、パブリックドメイン）。
const fs = require("fs");
const path = require("path");

const all = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), "utf8"));
const root = path.join(__dirname, "..");
const placesDir = path.join(root, "data/places");

// 日本語の名前（日本の空港と、よく使われる海外の空港）。ないものは画面側で「International Airport」→「国際空港」などと置き換える
const JA = {
  HND: "羽田空港", NRT: "成田国際空港", KIX: "関西国際空港", ITM: "伊丹空港", UKB: "神戸空港", NGO: "中部国際空港", NKM: "県営名古屋空港",
  CTS: "新千歳空港", OKD: "丘珠空港", HKD: "函館空港", AKJ: "旭川空港", KUH: "釧路空港", OBO: "帯広空港", MMB: "女満別空港", WKJ: "稚内空港",
  AOJ: "青森空港", MSJ: "三沢空港", HNA: "いわて花巻空港", SDJ: "仙台空港", AXT: "秋田空港", ONJ: "大館能代空港", GAJ: "山形空港", SYO: "庄内空港",
  FKS: "福島空港", IBR: "茨城空港", KIJ: "新潟空港", TOY: "富山空港", KMQ: "小松空港", NTQ: "能登空港", MMJ: "信州まつもと空港", FSZ: "富士山静岡空港",
  SHM: "南紀白浜空港", TTJ: "鳥取砂丘コナン空港", YGJ: "米子鬼太郎空港", IZO: "出雲縁結び空港", IWJ: "萩・石見空港", OKI: "隠岐世界ジオパーク空港",
  OKJ: "岡山桃太郎空港", HIJ: "広島空港", UBJ: "山口宇部空港", IWK: "岩国錦帯橋空港", TKS: "徳島阿波おどり空港", TAK: "高松空港", MYJ: "松山空港",
  KCZ: "高知龍馬空港", FUK: "福岡空港", KKJ: "北九州空港", HSG: "佐賀空港", NGS: "長崎空港", KMJ: "熊本空港", OIT: "大分空港", KMI: "宮崎空港",
  KOJ: "鹿児島空港", OKA: "那覇空港", ISG: "新石垣空港", MMY: "宮古空港", ASJ: "奄美空港", TSJ: "対馬空港", IKI: "壱岐空港", FUJ: "五島福江空港",
  SDS: "佐渡空港", HAC: "八丈島空港", OIM: "大島空港",
  PEK: "北京首都国際空港", PKX: "北京大興国際空港", PVG: "上海浦東国際空港", SHA: "上海虹橋国際空港", CAN: "広州白雲国際空港",
  SZX: "深圳宝安国際空港", CTU: "成都双流国際空港", TFU: "成都天府国際空港", HKG: "香港国際空港", MFM: "マカオ国際空港", TPE: "台湾桃園国際空港",
  ICN: "仁川国際空港", GMP: "金浦国際空港", PUS: "金海国際空港", SIN: "チャンギ国際空港", BKK: "スワンナプーム国際空港", DMK: "ドンムアン空港",
  KUL: "クアラルンプール国際空港", CGK: "スカルノ・ハッタ国際空港", MNL: "ニノイ・アキノ国際空港", SGN: "タンソンニャット国際空港",
  HAN: "ノイバイ国際空港", DEL: "インディラ・ガンディー国際空港", BOM: "チャトラパティ・シヴァージー国際空港", DAC: "シャージャラル国際空港",
  DXB: "ドバイ国際空港", DOH: "ハマド国際空港", AUH: "アブダビ国際空港", IST: "イスタンブール空港", LHR: "ヒースロー空港", LGW: "ガトウィック空港",
  CDG: "シャルル・ド・ゴール空港", ORY: "オルリー空港", FRA: "フランクフルト空港", BER: "ベルリン・ブランデンブルク空港", MUC: "ミュンヘン空港",
  AMS: "スキポール空港", MAD: "マドリード＝バラハス空港", FCO: "フィウミチーノ空港", ZRH: "チューリッヒ空港", VIE: "ウィーン国際空港",
  SVO: "シェレメーチエヴォ国際空港", JFK: "ジョン・F・ケネディ国際空港", IAD: "ワシントン・ダレス国際空港", LAX: "ロサンゼルス国際空港",
  SFO: "サンフランシスコ国際空港", ORD: "シカゴ・オヘア国際空港", YYZ: "トロント・ピアソン国際空港", YOW: "オタワ国際空港",
  MEX: "メキシコシティ国際空港", GRU: "グアルーリョス国際空港", BSB: "ブラジリア国際空港", EZE: "エセイサ国際空港", SCL: "サンティアゴ国際空港",
  LIM: "ホルヘ・チャベス国際空港", BOG: "エルドラド国際空港", SYD: "シドニー国際空港", CBR: "キャンベラ空港", AKL: "オークランド国際空港",
  NBO: "ジョモ・ケニヤッタ国際空港", ADD: "ボレ国際空港", JNB: "O・R・タンボ国際空港", CAI: "カイロ国際空港", LOS: "ムルタラ・モハンマド国際空港",
  ABV: "ナムディ・アジキウェ国際空港", ACC: "コトカ国際空港", FIH: "ンジリ国際空港", EBB: "エンテベ国際空港", KGL: "キガリ国際空港",
};
// 近さだけでは選びにくいところを手で決める（国の玄関口・日本の都道府県）
const GATEWAY = { KR: "ICN", AU: "SYD", NZ: "AKL", TR: "IST", CH: "ZRH", MA: "CMN" };
const PLACE_AIRPORT = { JP: { "01": "CTS", "07": "FKS", "21": "NGO", "23": "NGO", "34": "HIJ" } };
const byIata = new Map();
const scheduled = all.filter((a) => a.scheduled_service === "yes" && a.iata_code && a.type !== "closed");
const km = (lat1, lon1, lat2, lon2) => {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const short = (a) => {
  const o = { iata: a.iata_code, en: a.name.split(" / ")[0].trim(), lat: Math.round(+a.latitude_deg * 100) / 100, lon: Math.round(+a.longitude_deg * 100) / 100 };
  if (JA[a.iata_code]) o.ja = JA[a.iata_code];
  return o;
};
const byCountry = new Map();
for (const a of scheduled) {
  byIata.set(a.iata_code, a);
  if (!byCountry.has(a.iso_country)) byCountry.set(a.iso_country, []);
  byCountry.get(a.iso_country).push(a);
}

// 地点にいちばん近い空港（大きな空港を少し優先する）
function nearest(list, lat, lon, maxKm) {
  let best = null, bestScore = Infinity;
  for (const a of list) {
    const d = km(lat, lon, +a.latitude_deg, +a.longitude_deg);
    if (d > maxKm) continue;
    const score = d * (a.type === "large_airport" ? 0.5 : 1);
    if (score < bestScore) { bestScore = score; best = a; }
  }
  return best;
}

const gateways = {};
let placeCount = 0, withAirport = 0;
for (const file of fs.readdirSync(placesDir).filter((f) => f.endsWith(".json")).sort()) {
  const a2 = file.slice(0, 2);
  const fp = path.join(placesDir, file);
  const data = JSON.parse(fs.readFileSync(fp, "utf8"));
  const list = byCountry.get(a2) || [];
  for (const pl of data.places) {
    placeCount++;
    const a = byIata.get(PLACE_AIRPORT[a2]?.[pl.id]) || nearest(list, pl.lat, pl.lon, 120);
    if (a) { pl.airport = short(a); withAirport++; } else delete pl.airport;
  }
  // 玄関口: 首都の近くの国際空港（大きな空港 → 名前に International → 近さの順）
  const home = data.places.find((pl) => pl.id === data.home) || data.places[0];
  const near = list.map((a) => ({ a, d: km(home.lat, home.lon, +a.latitude_deg, +a.longitude_deg) })).filter((x) => x.d < 150);
  const pick = (near.length ? near : list.map((a) => ({ a, d: km(home.lat, home.lon, +a.latitude_deg, +a.longitude_deg) })))
    .sort((x, y) => (y.a.type === "large_airport") - (x.a.type === "large_airport")
      || /International/.test(y.a.name) - /International/.test(x.a.name) || x.d - y.d)[0];
  const gw = byIata.get(GATEWAY[a2]) || pick?.a;
  if (gw) gateways[a2] = short(gw);
  // 手作りの JP・CN は読みやすい形のまま書き戻す
  const pretty = fs.readFileSync(fp, "utf8").startsWith("{\n");
  fs.writeFileSync(fp, (pretty ? JSON.stringify(data, null, 1) : JSON.stringify(data)) + "\n");
}
gateways._source = "OurAirports (public domain)";
fs.writeFileSync(path.join(root, "data/airports.json"), JSON.stringify(gateways) + "\n");
console.log(`gateways: ${Object.keys(gateways).length - 1}, places with airport: ${withAirport}/${placeCount}`);
