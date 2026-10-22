"""公館マスタ：公館名の正規化・地域区分・地図座標。

POSTS の各行: (正式名, 地域, ISO3, 緯度, 経度, 別名リスト)
総領事館は「広州総領事館」のように「総領事館」を付けた名前を正式名とし、
ISO3 はホスト国のものを使う（地図で国単位に集計するため）。

EXTRA_PLACES は医務官は駐在していないが巡回健診の行き先になりうる国。
新しい公館・巡回先が出てきたらここに追記する。
"""
import re
import unicodedata

REGIONS = ["アフリカ", "アジア・大洋州", "ヨーロッパ", "中東", "米州"]

POSTS = [
    # --- アフリカ ---
    ("アルジェリア", "アフリカ", "DZA", 36.75, 3.06, ["Algeria"]),
    ("アンゴラ", "アフリカ", "AGO", -8.84, 13.23, ["Angola"]),
    ("ウガンダ", "アフリカ", "UGA", 0.35, 32.58, ["Uganda"]),
    ("エジプト", "アフリカ", "EGY", 30.04, 31.24, ["Egypt"]),
    ("エチオピア", "アフリカ", "ETH", 9.03, 38.74, ["Ethiopia"]),
    ("ガーナ", "アフリカ", "GHA", 5.60, -0.19, ["Ghana"]),
    ("ガボン", "アフリカ", "GAB", 0.39, 9.45, ["Gabon"]),
    ("カメルーン", "アフリカ", "CMR", 3.85, 11.50, ["Cameroon"]),
    ("ギニア", "アフリカ", "GIN", 9.64, -13.58, ["Guinea"]),
    ("ケニア", "アフリカ", "KEN", -1.29, 36.82, ["Kenya"]),
    ("コートジボワール", "アフリカ", "CIV", 5.36, -4.01, ["CotedIvoire", "Cote d'Ivoire", "IvoryCoast"]),
    ("コンゴ民主共和国", "アフリカ", "COD", -4.44, 15.27, ["コンゴ（民）", "コンゴ(民)", "DRC", "DRCongo", "Congo DR"]),
    ("ザンビア", "アフリカ", "ZMB", -15.39, 28.32, ["Zambia"]),
    ("ジブチ", "アフリカ", "DJI", 11.59, 43.15, ["Djibouti"]),
    ("ジンバブエ", "アフリカ", "ZWE", -17.83, 31.05, ["Zimbabwe"]),
    ("スーダン", "アフリカ", "SDN", 15.50, 32.56, ["Sudan"]),
    ("セネガル", "アフリカ", "SEN", 14.72, -17.47, ["Senegal"]),
    ("タンザニア", "アフリカ", "TZA", -6.79, 39.21, ["Tanzania"]),
    ("チュニジア", "アフリカ", "TUN", 36.81, 10.18, ["Tunisia"]),
    ("ナイジェリア", "アフリカ", "NGA", 9.08, 7.40, ["Nigeria"]),
    ("ナミビア", "アフリカ", "NAM", -22.56, 17.08, ["Namibia"]),
    ("ブルキナファソ", "アフリカ", "BFA", 12.37, -1.52, ["BurkinaFaso"]),
    ("ベナン", "アフリカ", "BEN", 6.37, 2.39, ["Benin"]),
    ("ボツワナ", "アフリカ", "BWA", -24.65, 25.91, ["Botswana"]),
    ("マダガスカル", "アフリカ", "MDG", -18.88, 47.51, ["Madagascar"]),
    ("マラウイ", "アフリカ", "MWI", -13.96, 33.79, ["Malawi"]),
    ("マリ", "アフリカ", "MLI", 12.64, -8.00, ["Mali"]),
    ("南アフリカ共和国", "アフリカ", "ZAF", -25.75, 28.19, ["南アフリカ", "南ア", "SouthAfrica"]),
    ("南スーダン", "アフリカ", "SSD", 4.86, 31.57, ["SouthSudan"]),
    ("モザンビーク", "アフリカ", "MOZ", -25.97, 32.57, ["Mozambique"]),
    ("モーリタニア", "アフリカ", "MRT", 18.09, -15.98, ["Mauritania"]),
    ("モロッコ", "アフリカ", "MAR", 34.02, -6.84, ["Morocco"]),
    ("ルワンダ", "アフリカ", "RWA", -1.95, 30.06, ["Rwanda"]),
    # --- アジア・大洋州 ---
    ("アフガニスタン", "アジア・大洋州", "AFG", 34.53, 69.17, ["Afghanistan"]),
    ("インド", "アジア・大洋州", "IND", 28.61, 77.21, ["India"]),
    ("インドネシア", "アジア・大洋州", "IDN", -6.21, 106.85, ["Indonesia"]),
    ("オーストラリア", "アジア・大洋州", "AUS", -35.28, 149.13, ["Australia", "豪州"]),
    ("カンボジア", "アジア・大洋州", "KHM", 11.56, 104.92, ["Cambodia"]),
    ("韓国", "アジア・大洋州", "KOR", 37.57, 126.98, ["大韓民国", "Korea"]),
    ("シンガポール", "アジア・大洋州", "SGP", 1.29, 103.85, ["Singapore"]),
    ("スリランカ", "アジア・大洋州", "LKA", 6.93, 79.86, ["SriLanka"]),
    ("タイ", "アジア・大洋州", "THA", 13.76, 100.50, ["Thailand"]),
    ("中国", "アジア・大洋州", "CHN", 39.90, 116.41, ["中華人民共和国", "北京", "China", "Beijing"]),
    ("広州総領事館", "アジア・大洋州", "CHN", 23.13, 113.26, ["広州", "Guangzhou"]),
    ("上海総領事館", "アジア・大洋州", "CHN", 31.23, 121.47, ["上海", "Shanghai"]),
    ("瀋陽総領事館", "アジア・大洋州", "CHN", 41.80, 123.43, ["瀋陽", "Shenyang"]),
    ("香港総領事館", "アジア・大洋州", "CHN", 22.32, 114.17, ["香港", "HongKong"]),
    ("ネパール", "アジア・大洋州", "NPL", 27.72, 85.32, ["Nepal"]),
    ("パキスタン", "アジア・大洋州", "PAK", 33.69, 73.05, ["Pakistan"]),
    ("バングラデシュ", "アジア・大洋州", "BGD", 23.81, 90.41, ["Bangladesh"]),
    ("パプアニューギニア", "アジア・大洋州", "PNG", -9.44, 147.18, ["PapuaNewGuinea", "PNG"]),
    ("東ティモール", "アジア・大洋州", "TLS", -8.56, 125.57, ["TimorLeste", "EastTimor"]),
    ("フィジー", "アジア・大洋州", "FJI", -18.14, 178.44, ["Fiji"]),
    ("フィリピン", "アジア・大洋州", "PHL", 14.60, 120.98, ["Philippines"]),
    ("ベトナム", "アジア・大洋州", "VNM", 21.03, 105.85, ["Vietnam", "VietNam"]),
    ("ホーチミン総領事館", "アジア・大洋州", "VNM", 10.82, 106.63, ["ホーチミン", "HoChiMinh"]),
    ("マレーシア", "アジア・大洋州", "MYS", 3.14, 101.69, ["Malaysia"]),
    ("ミャンマー", "アジア・大洋州", "MMR", 16.87, 96.20, ["Myanmar"]),
    ("モンゴル", "アジア・大洋州", "MNG", 47.92, 106.92, ["Mongolia"]),
    ("ラオス", "アジア・大洋州", "LAO", 17.97, 102.63, ["Laos"]),
    # --- ヨーロッパ（中央アジア・ロシアを含む） ---
    ("アゼルバイジャン", "ヨーロッパ", "AZE", 40.41, 49.87, ["Azerbaijan"]),
    ("イタリア", "ヨーロッパ", "ITA", 41.90, 12.50, ["Italy"]),
    ("ウクライナ", "ヨーロッパ", "UKR", 50.45, 30.52, ["Ukraine"]),
    ("ウズベキスタン", "ヨーロッパ", "UZB", 41.30, 69.24, ["Uzbekistan"]),
    ("英国", "ヨーロッパ", "GBR", 51.51, -0.13, ["イギリス", "連合王国", "UK", "UnitedKingdom"]),
    ("オーストリア", "ヨーロッパ", "AUT", 48.21, 16.37, ["Austria"]),
    ("カザフスタン", "ヨーロッパ", "KAZ", 51.17, 71.45, ["Kazakhstan"]),
    ("キルギス", "ヨーロッパ", "KGZ", 42.87, 74.59, ["キルギス共和国", "Kyrgyz", "KyrgyzRepublic", "Kyrgyzstan"]),
    ("スウェーデン", "ヨーロッパ", "SWE", 59.33, 18.07, ["Sweden"]),
    ("セルビア", "ヨーロッパ", "SRB", 44.79, 20.45, ["Serbia"]),
    ("タジキスタン", "ヨーロッパ", "TJK", 38.56, 68.79, ["Tajikistan"]),
    ("ドイツ", "ヨーロッパ", "DEU", 52.52, 13.40, ["Germany"]),
    ("トルクメニスタン", "ヨーロッパ", "TKM", 37.96, 58.33, ["Turkmenistan"]),
    ("フランス", "ヨーロッパ", "FRA", 48.86, 2.35, ["France"]),
    ("ポーランド", "ヨーロッパ", "POL", 52.23, 21.01, ["Poland"]),
    ("ルーマニア", "ヨーロッパ", "ROU", 44.43, 26.10, ["Romania"]),
    ("ロシア", "ヨーロッパ", "RUS", 55.76, 37.62, ["ロシア連邦", "Russia"]),
    ("ウラジオストク総領事館", "ヨーロッパ", "RUS", 43.12, 131.89, ["ウラジオストク", "Vladivostok"]),
    # --- 中東（トルコを含む） ---
    ("アラブ首長国連邦", "中東", "ARE", 24.45, 54.38, ["UAE", "アブダビ"]),
    ("ドバイ総領事館", "中東", "ARE", 25.20, 55.27, ["ドバイ", "Dubai"]),
    ("イエメン", "中東", "YEM", 15.37, 44.19, ["Yemen"]),
    ("イスラエル", "中東", "ISR", 32.08, 34.78, ["Israel"]),
    ("イラク", "中東", "IRQ", 33.31, 44.36, ["Iraq"]),
    ("イラン", "中東", "IRN", 35.69, 51.39, ["Iran"]),
    ("オマーン", "中東", "OMN", 23.59, 58.41, ["Oman"]),
    ("カタール", "中東", "QAT", 25.29, 51.53, ["Qatar"]),
    ("クウェート", "中東", "KWT", 29.38, 47.99, ["Kuwait"]),
    ("サウジアラビア", "中東", "SAU", 24.71, 46.68, ["SaudiArabia", "リヤド"]),
    ("ジッダ総領事館", "中東", "SAU", 21.49, 39.19, ["ジッダ", "Jeddah"]),
    ("シリア", "中東", "SYR", 33.51, 36.29, ["Syria"]),
    ("トルコ", "中東", "TUR", 39.93, 32.86, ["トルコ共和国", "テュルキエ", "Turkey", "Turkiye"]),
    ("ヨルダン", "中東", "JOR", 31.95, 35.93, ["Jordan"]),
    ("レバノン", "中東", "LBN", 33.89, 35.50, ["Lebanon"]),
    # --- 米州 ---
    ("アメリカ合衆国", "米州", "USA", 38.91, -77.04, ["米国", "アメリカ", "ワシントン", "USA", "UnitedStates"]),
    ("ニューヨーク総領事館", "米州", "USA", 40.71, -74.01, ["ニューヨーク", "NewYork", "NY"]),
    ("ロサンゼルス総領事館", "米州", "USA", 34.05, -118.24, ["ロサンゼルス", "LosAngeles", "LA"]),
    ("マイアミ総領事館", "米州", "USA", 25.76, -80.19, ["マイアミ", "Miami"]),
    ("アルゼンチン", "米州", "ARG", -34.60, -58.38, ["Argentina"]),
    ("エクアドル", "米州", "ECU", -0.18, -78.47, ["Ecuador"]),
    ("カナダ", "米州", "CAN", 45.42, -75.70, ["Canada"]),
    ("キューバ", "米州", "CUB", 23.11, -82.37, ["Cuba"]),
    ("グアテマラ", "米州", "GTM", 14.63, -90.51, ["Guatemala"]),
    ("コロンビア", "米州", "COL", 4.71, -74.07, ["Colombia"]),
    ("チリ", "米州", "CHL", -33.45, -70.67, ["Chile"]),
    ("ドミニカ共和国", "米州", "DOM", 18.49, -69.93, ["DominicanRepublic"]),
    ("ニカラグア", "米州", "NIC", 12.11, -86.24, ["Nicaragua"]),
    ("ハイチ", "米州", "HTI", 18.59, -72.31, ["Haiti"]),
    ("パナマ", "米州", "PAN", 8.98, -79.52, ["Panama"]),
    ("パラグアイ", "米州", "PRY", -25.26, -57.58, ["Paraguay"]),
    ("ブラジル", "米州", "BRA", -15.79, -47.88, ["ブラジリア", "Brazil"]),
    ("サンパウロ総領事館", "米州", "BRA", -23.55, -46.63, ["サンパウロ", "SaoPaulo"]),
    ("ベネズエラ", "米州", "VEN", 10.49, -66.88, ["Venezuela"]),
    ("ペルー", "米州", "PER", -12.05, -77.04, ["Peru"]),
    ("ボリビア", "米州", "BOL", -16.50, -68.15, ["Bolivia"]),
    ("メキシコ", "米州", "MEX", 19.43, -99.13, ["Mexico"]),
]

# 巡回健診先になりうる非駐在国 (名前, 地域, ISO3, 緯度, 経度)
EXTRA_PLACES = [
    ("ブルンジ", "アフリカ", "BDI", -3.38, 29.36), ("エリトリア", "アフリカ", "ERI", 15.32, 38.93),
    ("ソマリア", "アフリカ", "SOM", 2.05, 45.32), ("チャド", "アフリカ", "TCD", 12.13, 15.06),
    ("ニジェール", "アフリカ", "NER", 13.51, 2.11), ("トーゴ", "アフリカ", "TGO", 6.13, 1.22),
    ("シエラレオネ", "アフリカ", "SLE", 8.48, -13.23), ("リベリア", "アフリカ", "LBR", 6.30, -10.80),
    ("ガンビア", "アフリカ", "GMB", 13.45, -16.58), ("ギニアビサウ", "アフリカ", "GNB", 11.86, -15.60),
    ("カーボベルデ", "アフリカ", "CPV", 14.93, -23.51), ("レソト", "アフリカ", "LSO", -29.31, 27.48),
    ("エスワティニ", "アフリカ", "SWZ", -26.31, 31.14), ("モーリシャス", "アフリカ", "MUS", -20.16, 57.50),
    ("セーシェル", "アフリカ", "SYC", -4.62, 55.45), ("コモロ", "アフリカ", "COM", -11.70, 43.26),
    ("中央アフリカ", "アフリカ", "CAF", 4.39, 18.56), ("コンゴ共和国", "アフリカ", "COG", -4.27, 15.28),
    ("赤道ギニア", "アフリカ", "GNQ", 3.75, 8.78), ("リビア", "アフリカ", "LBY", 32.89, 13.19),
    ("ブータン", "アジア・大洋州", "BTN", 27.47, 89.64), ("モルディブ", "アジア・大洋州", "MDV", 4.18, 73.51),
    ("ブルネイ", "アジア・大洋州", "BRN", 4.90, 114.94), ("ソロモン", "アジア・大洋州", "SLB", -9.43, 159.95),
    ("バヌアツ", "アジア・大洋州", "VUT", -17.73, 168.32), ("サモア", "アジア・大洋州", "WSM", -13.83, -171.76),
    ("トンガ", "アジア・大洋州", "TON", -21.14, -175.20), ("キリバス", "アジア・大洋州", "KIR", 1.45, 172.97),
    ("ツバル", "アジア・大洋州", "TUV", -8.52, 179.20), ("マーシャル", "アジア・大洋州", "MHL", 7.12, 171.18),
    ("ミクロネシア", "アジア・大洋州", "FSM", 6.92, 158.16), ("パラオ", "アジア・大洋州", "PLW", 7.50, 134.62),
    ("ナウル", "アジア・大洋州", "NRU", -0.55, 166.92), ("ニュージーランド", "アジア・大洋州", "NZL", -41.29, 174.78),
    ("ジョージア", "ヨーロッパ", "GEO", 41.72, 44.79), ("アルメニア", "ヨーロッパ", "ARM", 40.18, 44.51),
    ("ベラルーシ", "ヨーロッパ", "BLR", 53.90, 27.56), ("モルドバ", "ヨーロッパ", "MDA", 47.01, 28.86),
    ("バーレーン", "中東", "BHR", 26.23, 50.59), ("パレスチナ", "中東", "PSE", 31.90, 35.20),
    ("ホンジュラス", "米州", "HND", 14.07, -87.19), ("エルサルバドル", "米州", "SLV", 13.69, -89.22),
    ("コスタリカ", "米州", "CRI", 9.93, -84.08), ("ジャマイカ", "米州", "JAM", 18.02, -76.80),
    ("トリニダードトバゴ", "米州", "TTO", 10.66, -61.51), ("ウルグアイ", "米州", "URY", -34.90, -56.16),
    ("ガイアナ", "米州", "GUY", 6.80, -58.16), ("スリナム", "米州", "SUR", 5.85, -55.20),
    ("バハマ", "米州", "BHS", 25.05, -77.35), ("ベリーズ", "米州", "BLZ", 17.25, -88.77),
    # 緊急移送の行き先として使う
    ("日本", "アジア・大洋州", "JPN", 35.68, 139.69),
]


# ISO 3166 alpha-3 -> alpha-2（国旗画像のファイル名に使う）
ISO2 = {
    "AFG": "af",
    "AGO": "ao",
    "ARE": "ae",
    "ARG": "ar",
    "ARM": "am",
    "AUS": "au",
    "AUT": "at",
    "AZE": "az",
    "BDI": "bi",
    "BEN": "bj",
    "BFA": "bf",
    "BGD": "bd",
    "BHR": "bh",
    "BHS": "bs",
    "BLR": "by",
    "BLZ": "bz",
    "BOL": "bo",
    "BRA": "br",
    "BRN": "bn",
    "BTN": "bt",
    "BWA": "bw",
    "CAF": "cf",
    "CAN": "ca",
    "CHL": "cl",
    "CHN": "cn",
    "CIV": "ci",
    "CMR": "cm",
    "COD": "cd",
    "COG": "cg",
    "COL": "co",
    "COM": "km",
    "CPV": "cv",
    "CRI": "cr",
    "CUB": "cu",
    "DEU": "de",
    "DJI": "dj",
    "DOM": "do",
    "DZA": "dz",
    "ECU": "ec",
    "EGY": "eg",
    "ERI": "er",
    "ETH": "et",
    "FJI": "fj",
    "FRA": "fr",
    "FSM": "fm",
    "GAB": "ga",
    "GBR": "gb",
    "GEO": "ge",
    "GHA": "gh",
    "GIN": "gn",
    "GMB": "gm",
    "GNB": "gw",
    "GNQ": "gq",
    "GTM": "gt",
    "GUY": "gy",
    "HND": "hn",
    "HTI": "ht",
    "IDN": "id",
    "IND": "in",
    "IRN": "ir",
    "IRQ": "iq",
    "ISR": "il",
    "ITA": "it",
    "JAM": "jm",
    "JOR": "jo",
    "JPN": "jp",
    "KAZ": "kz",
    "KEN": "ke",
    "KGZ": "kg",
    "KHM": "kh",
    "KIR": "ki",
    "KOR": "kr",
    "KWT": "kw",
    "LAO": "la",
    "LBN": "lb",
    "LBR": "lr",
    "LBY": "ly",
    "LKA": "lk",
    "LSO": "ls",
    "MAR": "ma",
    "MDA": "md",
    "MDG": "mg",
    "MDV": "mv",
    "MEX": "mx",
    "MHL": "mh",
    "MLI": "ml",
    "MMR": "mm",
    "MNG": "mn",
    "MOZ": "mz",
    "MRT": "mr",
    "MUS": "mu",
    "MWI": "mw",
    "MYS": "my",
    "NAM": "na",
    "NER": "ne",
    "NGA": "ng",
    "NIC": "ni",
    "NPL": "np",
    "NRU": "nr",
    "NZL": "nz",
    "OMN": "om",
    "PAK": "pk",
    "PAN": "pa",
    "PER": "pe",
    "PHL": "ph",
    "PLW": "pw",
    "PNG": "pg",
    "POL": "pl",
    "PRY": "py",
    "PSE": "ps",
    "QAT": "qa",
    "ROU": "ro",
    "RUS": "ru",
    "RWA": "rw",
    "SAU": "sa",
    "SDN": "sd",
    "SEN": "sn",
    "SGP": "sg",
    "SLB": "sb",
    "SLE": "sl",
    "SLV": "sv",
    "SOM": "so",
    "SRB": "rs",
    "SSD": "ss",
    "SUR": "sr",
    "SWE": "se",
    "SWZ": "sz",
    "SYC": "sc",
    "SYR": "sy",
    "TCD": "td",
    "TGO": "tg",
    "THA": "th",
    "TJK": "tj",
    "TKM": "tm",
    "TLS": "tl",
    "TON": "to",
    "TTO": "tt",
    "TUN": "tn",
    "TUR": "tr",
    "TUV": "tv",
    "TZA": "tz",
    "UGA": "ug",
    "UKR": "ua",
    "URY": "uy",
    "USA": "us",
    "UZB": "uz",
    "VEN": "ve",
    "VNM": "vn",
    "VUT": "vu",
    "WSM": "ws",
    "YEM": "ye",
    "ZAF": "za",
    "ZMB": "zm",
    "ZWE": "zw",
}


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r"[\s・\-_'’]", "", s)
    return s.lower()


INFO = {}      # 正式名 -> dict(region, iso3, lat, lon, is_post)
_ALIASES = {}  # 正規化済み別名 -> 正式名
for name, region, iso3, lat, lon, aliases in POSTS:
    INFO[name] = dict(region=region, iso3=iso3, iso2=None, lat=lat, lon=lon, is_post=True)
    for a in [name, *aliases]:
        _ALIASES[_norm(a)] = name
for name, region, iso3, lat, lon in EXTRA_PLACES:
    INFO[name] = dict(region=region, iso3=iso3, iso2=None, lat=lat, lon=lon, is_post=False)
    _ALIASES.setdefault(_norm(name), name)

for _v in INFO.values():
    _v["iso2"] = ISO2.get(_v["iso3"])

# 長い別名から先にマッチさせる（「ギニア」が「パプアニューギニア」に誤マッチしないように）
_ALIAS_SORTED = sorted(_ALIASES.items(), key=lambda kv: -len(kv[0]))


def canonical(raw: str):
    """「在フランス日本国大使館」「France」「在広州総領事館」などから正式名を返す。不明なら None。"""
    if not raw:
        return None
    s = unicodedata.normalize("NFKC", raw)
    s = re.sub(r"^在", "", s.strip())
    s = s.replace("日本国", "").replace("日本", "")
    is_consulate = "総領事館" in s
    s = re.sub(r"(大使館|総領事館|領事事務所|政府代表部|代表部)$", "", s)
    key = _norm(s)
    if is_consulate and _norm(s + "総領事館") in _ALIASES:
        return _ALIASES[_norm(s + "総領事館")]
    if key in _ALIASES:
        return _ALIASES[key]
    return None


_KATA = re.compile(r"[\u30A0-\u30FF]")


def find_in_text(text: str):
    """テキスト中に出てくる公館名・国名を（重複なく、出現順に）返す。

    カタカナだけの国名（タイ・マリ等）は前後がカタカナでない場合のみ一致とみなす
    （「タイミング」「サマリー」への誤マッチ防止）。
    """
    t = unicodedata.normalize("NFKC", text or "").lower()
    t = re.sub(r"[\s・]+", "|", t)
    t = t.replace("トリニダード|トバゴ", "トリニダードトバゴ")
    used = [False] * len(t)
    hits = []
    for alias, name in _ALIAS_SORTED:
        if len(alias) < 2:
            continue
        kata = all(_KATA.match(c) for c in alias)
        ascii_ = alias.isascii()
        start = 0
        while True:
            i = t.find(alias, start)
            if i < 0:
                break
            j = i + len(alias)
            before = t[i - 1] if i > 0 else ""
            after = t[j] if j < len(t) else ""
            ok = not any(used[i:j])
            if kata and ((before and _KATA.match(before)) or (after and _KATA.match(after))):
                ok = False
            if ascii_ and ((before and before.isascii() and before.isalnum()) or (after and after.isascii() and after.isalnum())):
                ok = False
            if ok:
                for k in range(i, j):
                    used[k] = True
                hits.append((i, name))
            start = i + 1
    found = []
    for _, name in sorted(hits):
        if name not in found:
            found.append(name)
    return found


def region_of(name: str) -> str:
    return INFO.get(name, {}).get("region", "未分類")


def all_post_names():
    return [p[0] for p in POSTS]
