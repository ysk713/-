/* 薬品マスタの組み立て。購送審査の drug_master.json を優先し、診断書アプリ（shindansho/drugs.js）の薬剤マスタで補う。
   画面で追加・上書きした分（ブラウザ保存）は最後に重ねる。ブラウザでもNode（テスト）でも動く。 */
(function (root) {
  "use strict";
  const R = (typeof module !== "undefined" && module.exports) ? require("./rules.js") : root.KousouRules;

  // 「アムロジピン錠」「ゾルピデム酒石酸塩錠」→「アムロジピン」「ゾルピデム」（OD錠や塩の違いでも当たるように）
  function stem(name) {
    if (/[（(]/.test(name)) return null;  // 「（連続投与）」等の区別がある品目は短縮しない
    const s = name.replace(/(OD錠|徐放錠|腸溶錠|配合錠|錠|カプセル|エキス顆粒|顆粒|細粒|散|テープ|パップ)$/, "")
      .replace(/(塩酸塩|酒石酸塩|硫酸塩|マレイン酸塩|臭化水素酸塩|ナトリウム|カリウム|カルシウム|水和物)$/, "");
    return s.length >= 3 && s !== name ? s : null;
  }
  // note の「肝斑は保険適応外」「避妊目的は保険適応外」→ 適応外キーワード
  function notIndicated(note) {
    const out = [];
    for (const m of String(note || "").matchAll(/([^。、；;]+?)は保険適応外/g))
      out.push(m[1].replace(/[（(].*?[）)]/g, "").replace(/(目的|等|など)$/, "").trim());
    return out.filter(Boolean);
  }

  function fromShindansho(list) {
    return (list || []).map(d => ({
      names: [...new Set([d.name, stem(d.name), ...String(d.brand || "").split(/[／/]/).flatMap(b => [b.trim(), stem(b.trim())])].filter(Boolean))],
      unit: d.unit, strengths: d.strengths || [], max_daily: d.max ?? null,
      psych: !!d.psych, old_limit: d.limit || 0, hormone28: !!d.cycle28,
      indications: d.ind || [], not_indicated: notIndicated(d.note),
      note: d.note || "", category: d.cat || "", source: "診断書アプリ",
    }));
  }

  // base を優先し、extra のうち base と同じ薬（名前が一致）は加えない。
  // 「含む」で判定すると、サクビトリルバルサルタンがバルサルタンと同じ扱いになるため完全一致で比べる。
  function sameDrug(a, b) { const A = new Set(a.names.map(R.norm)); return b.names.some(n => A.has(R.norm(n))); }
  function merge(base, extra) {
    const drugs = base.map(d => Object.assign({ source: d.source || "購送審査" }, d)), skipped = [];
    for (const e of extra) {
      const hit = base.find(b => sameDrug(b, e));
      if (hit) skipped.push({ name: e.names[0], kept: hit.names[0], max_extra: e.max_daily, max_kept: hit.max_daily });
      else drugs.push(e);
    }
    return { drugs, skipped };
  }

  // 画面で追加・上書きした品目を最優先にする（同じ薬の既定品目は外す）
  function overlay(drugs, custom) {
    if (!custom || !custom.length) return drugs;
    return custom.map(d => Object.assign({ source: "追加・上書き" }, d)).concat(drugs.filter(d => !custom.some(c => sameDrug(c, d))));
  }

  // 診断書アプリの BANNED_DRUGS → 法規制の判定用リスト
  function legalFrom(banned) {
    return (banned || []).map(b => ({ law: b.law, psych: !!b.allow, stems: b.stems || [], except: b.except || [] }));
  }

  function build(kousouDrugs, shindanshoDrugs, custom) {
    const { drugs, skipped } = merge(kousouDrugs, fromShindansho(shindanshoDrugs));
    return { drugs: overlay(drugs, custom), skipped, counts: { kousou: kousouDrugs.length, shindansho: drugs.length - kousouDrugs.length } };
  }

  const api = { build, fromShindansho, merge, overlay, legalFrom, stem, notIndicated };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KousouMaster = api;
})(typeof window !== "undefined" ? window : globalThis);
