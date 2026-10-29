/* 薬価基準収載品目リスト（kousou/data/yakka.json）の検索。薬品名の実在・規格の実在・新薬（収載1年以内）の判定に使う。
   ブラウザでもNode（テスト）でも動く。 */
(function (root) {
  "use strict";
  const nf = s => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const FORM = /(od錠|口腔内崩壊錠|徐放錠|腸溶錠|配合錠|錠|カプセル|細粒|顆粒|散|ドライシロップ|シロップ|テープ|パップ|貼付剤|内用液|液)$/;
  const UNIT = "(mg|μg|µg|g|%|ml|単位)";

  // 「アムロジピン錠5mg「サワイ」」「ノルバスクOD錠5mg」→「アムロジピン」「ノルバスク」
  function familyKey(name) {
    let s = nf(name).replace(/「.*?」|『.*?』|\(.*?\)|（.*?）/g, "");
    s = s.replace(new RegExp(`[0-9.]+${UNIT}.*$`), "");   // 含有量以降を落とす
    for (let i = 0; i < 2; i++) s = s.replace(FORM, "").replace(/[0-9.]+$/, "");
    return s;
  }
  // 「5mg1錠」→ {value:5, unit:"mg"}（「1錠」だけの配合剤は null）
  function parseSpec(spec) {
    const m = nf(spec).replace("µ", "μ").match(new RegExp(`^([0-9.]+)${UNIT}`));
    return m ? { value: parseFloat(m[1]), unit: m[2] } : null;
  }

  class Yakka {
    constructor(data) {
      this.data = data || null;
      this.byFamily = new Map();
      this.firstSeen = (data && data.first_seen) || {};
      for (const [name, ingredient, spec, kind, sp, listed] of (data ? data.items : [])) {
        const e = { name, ingredient, spec, kind, senpatsu: sp === 1, listed };
        for (const k of new Set([familyKey(name), familyKey(ingredient)])) {
          if (k.length < 2) continue;
          if (!this.byFamily.has(k)) this.byFamily.set(k, []);
          this.byFamily.get(k).push(e);
        }
      }
    }
    get loaded() { return !!this.data; }

    // 入力された薬品名に当たる品目群。完全一致 → 前方一致の順に探す。
    // 前方一致は「入力が短い」場合だけ（ロメリジン→ロメリジン塩酸塩）。入力が長い場合（ミグシスト→ミグシス）は誤記の可能性があるので当てない
    find(...names) {
      for (const n of names) {
        const k = familyKey(n); if (k.length < 2) continue;
        if (this.byFamily.has(k)) return { key: k, entries: this.byFamily.get(k) };
      }
      for (const n of names) {
        const k = familyKey(n); if (k.length < 4) continue;
        let best = null;
        for (const fk of this.byFamily.keys()) if (fk.length >= 4 && fk.startsWith(k) && (!best || fk.length > best.length)) best = fk;
        if (best) return { key: best, entries: this.byFamily.get(best) };
      }
      return null;
    }
    // 入力の剤形（錠・カプセル等）に合う品目に絞った規格一覧
    strengths(hit, inputName) {
      const form = (nf(inputName).match(/(od錠|錠|カプセル|細粒|顆粒|散|テープ|パップ)/) || [])[1];
      const pick = form ? hit.entries.filter(e => nf(e.name).includes(form)) : hit.entries;
      const list = (pick.length ? pick : hit.entries).map(e => parseSpec(e.spec)).filter(Boolean);
      const seen = new Set(); return list.filter(s => { const k = s.value + s.unit; if (seen.has(k)) return false; seen.add(k); return true; });
    }
    // 新薬14日制限が外れる日（収載日 or 成分が初めてリストに現れた月の1年後）。不明・以前からなら null
    newDrugUntil(hit) {
      const dates = hit.entries.map(e => e.listed).filter(Boolean).sort();
      let since = dates[0];
      if (!since) {
        // キーは fetch_yakka.py の ingredient_key（NFKC＋空白除去）と同じ作り方
        const ms = hit.entries.map(e => this.firstSeen[String(e.ingredient || e.name).normalize("NFKC").replace(/\s+/g, "")]).filter(Boolean).sort();
        if (ms[0]) since = ms[0] + "-01";
      }
      if (!since) return null;
      const [y, m, d] = since.split("-").map(Number);
      return `${y + 1}-${String(m).padStart(2, "0")}-${String(d || 1).padStart(2, "0")}`;
    }
  }

  const api = { Yakka, familyKey, parseSpec };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KousouYakka = api;
})(typeof window !== "undefined" ? window : globalThis);
