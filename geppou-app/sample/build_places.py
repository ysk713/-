"""地図に出す国名・首都・大きな都市のデータ（geppou/lib/places.json）を Natural Earth（パブリックドメイン）から作る。

    python3 geppou-app/sample/build_places.py <ne_110m_admin_0_countries.geojson> <ne_10m_populated_places.geojson>

入手先：https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
  - 国名：日本語名（NAME_JA）と、国名を置く位置（LABEL_X/LABEL_Y）、表示の優先度（LABELRANK）、国コード（ISO_A3）
  - 首都：FEATURECLA が「Admin-0 capital」の都市（日本語名・人口）
  - 大きな都市：人口（POP_MAX）が CITY_MIN 人以上の都市
"""
import json
import os
import sys

CITY_MIN = 3_000_000   # 点を付ける都市の人口の下限（300万人）
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "geppou", "lib", "places.json")


def main(countries_path, places_path):
    cs = json.load(open(countries_path, encoding="utf-8"))["features"]
    ps = [f["properties"] for f in json.load(open(places_path, encoding="utf-8"))["features"]]
    countries = []
    for f in cs:
        p = f["properties"]
        if not p.get("NAME_JA") or p.get("LABEL_X") is None:
            continue
        iso = p.get("ISO_A3") if p.get("ISO_A3") not in (None, "-99") else p.get("ADM0_A3")
        countries.append([p["NAME_JA"], round(p["LABEL_X"], 2), round(p["LABEL_Y"], 2), int(p.get("LABELRANK") or 9), iso or ""])
    capitals, cities = [], []
    for p in ps:
        name = p.get("NAME_JA") or p.get("NAME")
        row = [name, round(p["LONGITUDE"], 3), round(p["LATITUDE"], 3), int(p.get("POP_MAX") or 0), p.get("ADM0_A3") or ""]
        if p.get("FEATURECLA") == "Admin-0 capital":
            capitals.append(row)
        elif (p.get("POP_MAX") or 0) >= CITY_MIN:
            cities.append(row)
    cities.sort(key=lambda r: -r[3])
    out = {"source": "Natural Earth（パブリックドメイン） ne_110m_admin_0_countries / ne_10m_populated_places",
           "cityMin": CITY_MIN, "countries": countries, "capitals": capitals, "cities": cities}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"countries {len(countries)}, capitals {len(capitals)}, cities {len(cities)} -> {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
