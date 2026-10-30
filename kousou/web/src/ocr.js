/* OCR（文字認識）：スキャン画像の文字を読み取り、申込書・診断書・指示書の項目の候補を取り出す。
   エンジンは月報アプリに同梱の Tesseract.js と日本語学習データ（../geppou/lib/tesseract/）をそのまま使う。
   ブラウザの中だけで動き、画像や文字を外部へ送らない。項目を取り出す関数はNode（テスト）でも動く。 */
(function (root) {
  "use strict";
  const R = (typeof module !== "undefined" && module.exports) ? require("./rules.js") : root.KousouRules;
  const nf = s => String(s ?? "").normalize("NFKC");

  // OCRの文字の整形：日本語の間の空白を詰め、数字の間の空白（「2 0 2 6」）も詰める
  function clean(t) {
    return nf(t)
      .replace(/[念信合今余冷怜玲]和(?=\s*(\d|元))/g, "令和")                 // 「令和」の誤読
      .replace(/([(（])\s+/g, "$1").replace(/\s+([)）])/g, "$1")          // 「( 1 )」→「(1)」
      .replace(/(\d)[ \t]+(?=(mg|μg|µg|g|mL)\b)/gi, "$1")                 // 「5 mg」→「5mg」
      .replace(/(\d)[ \t]+(?=[^\x00-\x7F])/g, "$1")                         // 「1 回」→「1回」
      .replace(/(\d)\s+\.(?=\s)/g, "$1.")                                   // 「1 . 病名」→「1. 病名」
      .replace(/([^\x00-\x7F])[ \t]+(?=[^\x00-\x7F])/g, "$1").replace(/(\d)[ \t]+(?=\d)/g, "$1")
      .replace(/([^\x00-\x7F])[ \t]+(?=\d)/g, "$1").replace(/(\d)[ \t]+(?=[年月日])/g, "$1").replace(/[ \t]+\n/g, "\n").trim();
  }

  // 文中の日付をすべて（位置つき）。令和・R・西暦・平成
  function findDates(text) {
    const t = clean(text), out = [];
    const re = /(令和|R|平成|H)\s*(\d{1,2}|元)\s*[年.\/]\s*(\d{1,2})\s*[月.\/]\s*(\d{1,2})\s*日?|(20\d{2})\s*[年.\/-]\s*(\d{1,2})\s*[月.\/-]\s*(\d{1,2})\s*日?/gi;
    let m;
    while ((m = re.exec(t))) {
      const iso = m[1] ? R.pdate(`${m[1]}${m[2]}.${m[3]}.${m[4]}`) : R.pdate(`${m[5]}/${m[6]}/${m[7]}`);
      if (iso) out.push({ iso, index: m.index, raw: m[0] });
    }
    return out;
  }
  // ラベル（「申込日」等）の後ろで最初の日付。無ければ null
  function dateAfter(text, labels) {
    const t = clean(text), ds = findDates(t);
    for (const l of labels) {
      const i = t.search(l);
      if (i >= 0) { const d = ds.find(x => x.index >= i && x.index - i < 80); if (d) return d.iso; }
    }
    return null;
  }
  // ラベルの後ろ（同じ行、空なら次の行）の文字
  function valueAfter(text, labels, max = 40) {
    const lines = clean(text).split(/\n/);
    for (const l of labels) {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(l); if (!m) continue;
        let v = lines[i].slice(m.index + m[0].length).replace(/^[\s:：()（）]+/, "").trim();
        if (!v && i + 1 < lines.length) v = lines[i + 1].trim();
        if (v) return v.slice(0, max);
      }
    }
    return "";
  }
  const STAFF = /職員(?:コード|番号|code)|職員ｺｰﾄﾞ/i;
  function staffCode(text) {
    const t = clean(text), i = t.search(STAFF); if (i < 0) return "";
    const m = t.slice(i, i + 60).replace(STAFF, "").match(/[Aa]?\s*\d[\d\s-]{3,10}\d/);
    return m ? m[0].replace(/[\s-]/g, "") : "";
  }
  function missionName(text) {
    const t = clean(text), END = "(?:日本国)?(?:大使館|総領事館|領事事務所|政府代表部|代表部)";
    const m = t.match(new RegExp(`在[^\\s、。,:：()（）0-9]{1,16}?${END}`)) || t.match(new RegExp(`[^\\s、。,:：()（）0-9]{1,20}?${END}`));
    return m ? m[0].replace(/^.*?(所属公館名|送付先公館名|公館名|所属)[:：]?/, "") : "";
  }
  // 「１．病名（慢性疾患）：」の下の行から「２．服用薬・処方」の前まで。複数の病名は「、」でつなぐ
  function diseases(text) {
    const lines = clean(text).split(/\n/), i = lines.findIndex(l => /病\s*名|傷病名|診断名/.test(l));
    if (i < 0) return "";
    const out = [];
    const first = lines[i].replace(/^.*?(病\s*名|傷病名|診断名)\s*([(（]慢性疾患[)）])?\s*[:：]?/, "").trim();
    if (first) out.push(first);
    for (let j = i + 1; j < lines.length && out.length < 6; j++) {
      if (/^\s*(2|２)\s*[.．]|服用薬|処方|生年月日|所\s*属/.test(lines[j])) break;
      const v = lines[j].replace(/^[\s(（]*\d+[)）.]\s*/, "").trim(); if (v) out.push(v);
    }
    return out.join("、").slice(0, 80);
  }
  const personName = v => (v.match(/^[一-龠々〆ヵヶぁ-んァ-ヶー・\s]{2,12}/) || [""])[0].replace(/\s+/g, " ").replace(/(殿|様|印|㊞)$/, "").trim();

  // 書類の種類ごとに項目の候補を取り出す（読めたものだけ）
  function extract(type, text) {
    const t = clean(text), f = {};
    const lastDate = (findDates(t).slice(-1)[0] || {}).iso;
    if (type === "申込書") {
      f["app.apply_date"] = dateAfter(t, [/申込(?:年月)?日/, /記入日/, /申込/]) || (findDates(t)[0] || {}).iso;
      f["app.applicant_name"] = personName(valueAfter(t, [/申込者\s*氏名/, /氏\s*名/]));
      f["app.staff_code"] = staffCode(t);
      f["app.mission_name"] = missionName(t);
      const mc = t.match(/公館(?:コード|番号)[^\d]{0,6}(\d{3,8})/); if (mc) f["app.mission_code"] = mc[1];
    } else if (type === "診断書") {
      f["diag.issue_date"] = dateAfter(t, [/発行(?:年月)?日/, /診断(?:年月)?日/]) || lastDate;
      f["diag.staff_code"] = staffCode(t);
      f["diag.patient_name"] = personName(valueAfter(t, [/(?:患者|療養者)?\s*氏\s*名/]));
      f["diag.disease"] = diseases(t);
      f["diag.doctor_name"] = personName(valueAfter(t, [/(?:医師|医務官)\s*(?:氏\s*名|名)\s*[:：]?/]));
    } else if (type === "指示書") {
      f["inst.issue_date"] = dateAfter(t, [/発行(?:年月)?日/, /指示(?:年月)?日/]) || lastDate;
      f["inst.doctor_name"] = personName(valueAfter(t, [/(?:医師|医務官|健康管理医)\s*(?:氏\s*名|名)?/]));
    }
    for (const k of Object.keys(f)) if (!f[k]) delete f[k];
    return f;
  }

  // 薬の行：「アムロジピン錠5mg 1回1錠 1日1回 朝食後 30日分」→ {name, strength, unit, perDay, days}
  // isDrug(name) が真になる名前だけ採る（薬品マスタ・薬価基準リストで確かめる）
  function extractDrugs(text, isDrug) {
    const out = [], lines = clean(text).split(/\n/);
    const NAME = /([ァ-ヶー一-龠A-Za-z・]{2,30}?(?:OD錠|口腔内崩壊錠|徐放錠|配合錠|錠|カプセル|顆粒|細粒|散|テープ|パップ))\s*([0-9.]+)?\s*(mg|μg|µg|ug|g|ミリグラム)?/g;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      while ((m = NAME.exec(line))) {
        const name = m[1] + (m[2] ? m[2] + (m[3] || "") : "");
        if (!isDrug(m[1])) continue;
        const near = line.slice(m.index) + " " + (lines[i + 1] || "");   // 用法・日数が次の行に書かれることもある
        const rest = line.slice(m.index + m[0].length);
        const perDay = dailyUnits(rest) || dailyUnits(lines[i + 1] || "");
        const DAYS = /([0-9]{1,3})\s*日分(?!使用)/;   // 見出しの「１日分使用量」は日数ではない
        const days = (near.match(DAYS) || clean(text).match(DAYS) || [])[1];
        out.push({ name, strength: m[2] || "", unit: (m[3] || "mg").replace(/µg|ug/, "μg").replace("ミリグラム", "mg"), perDay: perDay || "", days: days || "" });
      }
    }
    const seen = new Set();
    return out.filter(d => { const k = nf(d.name); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // 1日の使用量。優先順：「1日分使用量」の列（行末の「2錠」）＞「1日2錠」＞「2錠 分2」＞「1回1錠 1日2回」
  function dailyUnits(s) {
    const U = "(?:錠|T|カプセル|C|包|枚)";
    let m;
    if ((m = s.match(new RegExp(`([0-9.]+)\\s*${U}\\s*$`)))) return m[1];
    if ((m = s.match(new RegExp(`1日\\s*([0-9.]+)\\s*${U}`)))) return m[1];
    if ((m = s.match(new RegExp(`([0-9.]+)\\s*${U}\\s*(?:分|×)\\s*\\d`)))) return m[1];
    if ((m = s.match(new RegExp(`1回\\s*([0-9.]+)\\s*${U}.*?1日\\s*([0-9])\\s*回`)))) return String(+m[1] * +m[2]);
    return "";
  }

  // ---- エンジン（ブラウザのみ）
  let workerP = null;
  const loadScript = src => new Promise((ok, ng) => { const el = document.createElement("script"); el.src = src; el.onload = ok; el.onerror = () => ng(new Error(src + " を読み込めません")); document.head.appendChild(el); });
  const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, ng) => setTimeout(() => ng(new Error(msg)), ms))]);
  function worker(onLog) {
    workerP ||= (async () => {
      if (location.protocol === "file:") throw new Error("OCRはWeb版（https://ysk713.github.io/-/kousou/）で使えます。保存したHTMLファイルからは使えません");
      const base = new URL("../geppou/lib/tesseract/", location.href).href;
      if (!root.Tesseract) await loadScript(base + "tesseract.min.js");
      const r = await fetch(base + "lang/jpn.traineddata.gz").catch(e => { throw new Error("日本語の学習データを読み込めません（" + e.message + "）"); });
      if (!r.ok) throw new Error(`日本語の学習データを読み込めません（${r.status}）`);
      const opts = blob => ({ workerPath: base + "worker.min.js", corePath: base, langPath: base + "lang", gzip: true, workerBlobURL: blob,
        cacheMethod: "none", logger: m => onLog && onLog(m), errorHandler: e => console.warn("ocr", e) });
      try { return await withTimeout(root.Tesseract.createWorker("jpn", 1, opts(true)), 90000, "OCRの準備が90秒で終わりませんでした"); }
      catch (e) { console.warn("ocr worker (blob)", e); return await withTimeout(root.Tesseract.createWorker("jpn", 1, opts(false)), 90000, "OCRの準備が90秒で終わりませんでした"); }
    })().catch(e => { workerP = null; throw e; });
    return workerP;
  }
  async function recognize(canvas, onLog) {
    const w = await worker(onLog);
    const { data } = await withTimeout(w.recognize(canvas), 180000, "読み取りが3分で終わりませんでした");
    return clean(data.text);
  }

  const api = { clean, findDates, dateAfter, valueAfter, staffCode, missionName, diseases, dailyUnits, extract, extractDrugs, recognize };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KousouOCR = api;
})(typeof window !== "undefined" ? window : globalThis);
