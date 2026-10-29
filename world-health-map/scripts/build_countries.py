"""国マスタ (data/countries.json) を生成する補助スクリプト。

通常は実行不要（生成済みの countries.json をリポジトリに含めている）。
再生成する場合:
    pip install babel pycountry pycountry-convert
    npm pack world-atlas@2.0.2 && tar xzf world-atlas-2.0.2.tgz
    python3 scripts/build_countries.py package/countries-50m.json
"""
import json
import sys
from pathlib import Path

import pycountry
import pycountry_convert as pc
from babel import Locale

# 中東は医療情報の文脈でまとめて見たいことが多いので独立させる
MIDDLE_EAST = {"AE", "BH", "IQ", "IR", "IL", "JO", "KW", "LB", "OM", "QA", "SA", "SY", "YE", "PS", "TR", "CY"}
CONTINENT = {"AF": "africa", "AS": "asia", "EU": "europe", "NA": "north_america", "SA": "south_america", "OC": "oceania", "AN": "oceania"}

# 報道でよく使われる別名（英語）
EXTRA_EN = {
    "US": ["United States", "U.S.", "USA"], "HK": ["Hong Kong"], "MO": ["Macau", "Macao"],
    "GB": ["United Kingdom", "UK", "Britain", "England", "Scotland", "Wales"],
    "KR": ["South Korea"], "KP": ["North Korea"], "RU": ["Russia"], "IR": ["Iran"],
    "SY": ["Syria"], "VN": ["Vietnam"], "LA": ["Laos"], "TZ": ["Tanzania"],
    "CD": ["DR Congo", "DRC", "Democratic Republic of the Congo", "Congo-Kinshasa"],
    "CG": ["Republic of the Congo", "Congo-Brazzaville"], "BO": ["Bolivia"], "VE": ["Venezuela"],
    "MD": ["Moldova"], "TW": ["Taiwan"], "CI": ["Ivory Coast", "Côte d'Ivoire", "Cote d'Ivoire"],
    "CZ": ["Czechia", "Czech Republic"], "TR": ["Turkey", "Türkiye", "Turkiye"], "PS": ["Palestine", "Gaza", "West Bank"],
    "MM": ["Myanmar", "Burma"], "CV": ["Cape Verde", "Cabo Verde"], "SZ": ["Eswatini", "Swaziland"],
    "MK": ["North Macedonia"], "BN": ["Brunei"], "FM": ["Micronesia"], "VA": ["Vatican"], "XK": ["Kosovo"],
}
# 日本語の略称・通称
EXTRA_JA = {
    "US": ["米国", "アメリカ"], "GB": ["英国"], "HK": ["香港"], "MO": ["マカオ"], "CN": ["中国"], "KR": ["韓国"], "KP": ["北朝鮮"],
    "RU": ["ロシア"], "CD": ["コンゴ民主共和国"], "CG": ["コンゴ共和国"], "TW": ["台湾"],
    "PS": ["パレスチナ", "ガザ", "パレスチナ自治区"], "TR": ["トルコ", "トルコ共和国"], "CI": ["コートジボワール"],
    "SZ": ["エスワティニ"], "MM": ["ミャンマー"], "XK": ["コソボ"],
}


def main(topo_path: str) -> None:
    topo = json.loads(Path(topo_path).read_text())
    ja = Locale("ja").territories
    out = []
    for geo in topo["objects"]["countries"]["geometries"]:
        topo_name = geo["properties"]["name"]
        if "id" in geo:
            c = pycountry.countries.get(numeric=geo["id"])
            if c is None:
                continue
            a2, a3 = c.alpha_2, c.alpha_3
            names = [c.name, getattr(c, "common_name", None), getattr(c, "official_name", None)]
        elif topo_name == "Kosovo":
            a2, a3, names = "XK", "XKX", ["Kosovo"]
        else:
            continue  # Somaliland 等の未承認地域は親国に含めず表示のみ
        en_name = (EXTRA_EN.get(a2) or [n for n in names[1:2] + names[:1] if n])[0]
        # "Korea, Republic of" のような倒置形は報道に出ないので除く
        names = [n.removeprefix("the ") for n in [en_name] + names + EXTRA_EN.get(a2, []) if n and "," not in n]
        try:
            region = "middle_east" if a2 in MIDDLE_EAST else CONTINENT[pc.country_alpha2_to_continent_code(a2)]
        except KeyError:
            region = "europe" if a2 == "XK" else "oceania"
        ja_name = EXTRA_JA[a2][0] if a2 in EXTRA_JA else ja.get(a2, topo_name)
        out.append({
            "id": geo.get("id", "name:" + topo_name),
            "a2": a2, "a3": a3,
            "en": en_name,
            "ja": ja_name,
            "region": region,
            "aliases_en": sorted(set(names), key=len, reverse=True),
            "aliases_ja": sorted({ja_name, ja.get(a2, ja_name), *EXTRA_JA.get(a2, [])}, key=len, reverse=True),
        })
    out.sort(key=lambda x: x["a2"])
    dest = Path(__file__).resolve().parent.parent / "data" / "countries.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(f"{len(out)} countries -> {dest}")


if __name__ == "__main__":
    main(sys.argv[1])
