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
      .replace(/(?!昭)[一-龠]和(?=\s*(\d{1,2}|元)\s*年)/g, "令和")                 // 「令和」の誤読（念和・信和・含和・金和…）。後ろに「8年」が続くものに限る
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
      // 書類の日付として考えられる範囲だけ（生年月日などを申込日・発行日と取り違えない）
      if (iso && iso >= "2019-05-01" && iso <= "2035-12-31") out.push({ iso, index: m.index, raw: m[0] });
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
  const STAFF = /職.{0,2}(?:コード|番号|code)/i;   // 「職遇コード」のような誤読も拾う
  function staffCode(text) {
    const t = clean(text), i = t.search(STAFF); if (i < 0) return "";
    // 先頭のA以外の O・D・Q は 0、I・l・| は 1 の誤読として直す
    const m = t.slice(i, i + 60).replace(STAFF, "").match(/[Aa]?\s*[\dODQ][\dODQIl|\s-]{3,10}\d/);
    return m ? m[0].replace(/[\s-]/g, "").replace(/^([Aa]?)(.*)$/, (_, a, rest) => a + rest.replace(/[ODQ]/g, "0").replace(/[Il|]/g, "1")) : "";
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
      f["inst.patient_name"] = personName(valueAfter(t, [/患者\s*氏\s*名/]));
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

  // ---- 分割：書類の種類（表題）と氏名を読み、氏名で人ごとにまとめる
  function docTypeOf(text) {
    const head = clean(text).slice(0, 160).replace(/[\s_\-・.。]/g, "");
    for (const t of ["申込書", "委任状", "診断書", "指示書"]) if (head.includes(t)) return t;
    if (/購送|同意チェック|様式A/.test(head)) return "申込書";
    return null;
  }
  // そのページに書かれた療養者（患者）の氏名。申込書は申込者と療養者の両方
  function pageNames(type, text) {
    const t = clean(text), v = labels => personName(valueAfter(t, labels));
    const names = type === "申込書" ? [v([/療養者\s*氏\s*名/, /患者\s*氏\s*名/]), v([/申込者\s*氏\s*名/, /^\s*氏\s*名/m])]
      : type === "診断書" ? [v([/(?:患者|療養者)?\s*氏\s*名\s*[:：]/, /^\s*氏\s*名/m])]
      : type === "指示書" ? [v([/患者\s*氏\s*名/])]
      : type === "委任状" ? [v([/委任者\s*(?:氏\s*名)?/])] : [];
    return [...new Set(names.filter(n => n && n.replace(/\s/g, "").length >= 2))];
  }
  // pages: [{key, type, names}]（スキャン順）→ { gid: {ページkey: 人のkey}, warn: {人のkey: [..]} }
  // 申込書1枚＝1人。診断書・指示書・委任状は氏名が最も近い申込書の人へ（スキャン順に関係なく）。
  // 氏名が読めないページは直前の人へ。同じ姓の家族を取り違えないよう、近さ0.6未満は同じ人としない
  function assignByName(pages) {
    const sim = R.nameSim, people = [], gid = {}, warn = {};
    const best = names => {
      let top = null, score = 0, second = 0;
      for (const g of people) {
        const sc = Math.max(0, ...names.flatMap(a => g.names.map(b => sim(a, b))));
        if (sc > score) { second = score; score = sc; top = g; } else if (sc > second) second = sc;
      }
      return score >= 0.6 && score - second >= 0.1 ? top : null;
    };
    let prev = null;
    for (const p of pages) {   // 1回目：申込書で人を作る（2枚続きの申込書は同じ人）
      if (p.type !== "申込書") { prev = null; continue; }
      const same = prev && (!p.names.length || p.names.some(a => prev.names.some(b => sim(a, b) >= 0.8)));
      if (same) { gid[p.key] = prev.key; prev.names.push(...p.names); continue; }
      prev = { key: p.key, names: [...p.names], app: true }; people.push(prev); gid[p.key] = prev.key;
    }
    let last = null;
    for (const p of pages) {   // 2回目：それ以外を氏名で振り分ける
      if (gid[p.key]) { last = gid[p.key]; continue; }
      let g = p.names.length ? best(p.names) : null;
      if (!g && p.names.length) {   // どの申込書とも合わない氏名 → 申込書なしの人として分ける
        g = { key: p.key, names: [...p.names], app: false }; people.push(g);
        (warn[g.key] ||= []).push("この人の申込書が見つかりません（氏名で照合）。スキャン漏れか、氏名の読み違いの可能性があります。");
      }
      gid[p.key] = g ? g.key : (last || (people[0] && people[0].key) || p.key);
      if (!g && !people.length) people.push({ key: p.key, names: [], app: false });
      last = gid[p.key];
    }
    return { gid, warn, people };
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
  // 画像の前処理：グレースケール → コントラストを広げる → 大津の方法で白黒にする（かすれた・薄いスキャン対策）
  function binarize(src) {
    const c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
    const x = c.getContext("2d"); x.drawImage(src, 0, 0);
    const img = x.getImageData(0, 0, c.width, c.height), d = img.data, n = d.length / 4, g = new Uint8Array(n), hist = new Array(256).fill(0);
    for (let i = 0; i < n; i++) { g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000; hist[g[i]]++; }
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, th = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break;
      sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > best) { best = v; th = t; }
    }
    for (let i = 0; i < n; i++) { const v = g[i] > th ? 255 : 0; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    x.putImageData(img, 0, 0); return c;
  }
  function rotate(src, deg, maxSide) {
    const k = maxSide ? Math.min(1, maxSide / Math.max(src.width, src.height)) : 1;
    const w = Math.round(src.width * k), h = Math.round(src.height * k), side = deg % 180 ? [h, w] : [w, h];
    const c = document.createElement("canvas"); [c.width, c.height] = side;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.translate(c.width / 2, c.height / 2); x.rotate(deg * Math.PI / 180); x.drawImage(src, -w / 2, -h / 2, w, h);
    return c;
  }
  // 横向き・逆さのスキャンに対応：縮小画像を0/90/180/270度で試し、読み取りの信頼度が最も高い向きで本番の読み取りをする
  async function recognize(canvas, onLog) {
    const w = await worker(onLog);
    const bw = binarize(canvas);
    let best = { deg: 0, conf: -1 };
    for (const deg of [0, 90, 270, 180]) {
      const { data } = await withTimeout(w.recognize(rotate(bw, deg, 1100)), 60000, "向きの判定が60秒で終わりませんでした");
      if (data.confidence > best.conf) best = { deg, conf: data.confidence };
      if (deg === 0 && data.confidence >= 70) break;   // 正しい向きでよく読めていれば、ほかの向きは試さない
    }
    const { data } = await withTimeout(w.recognize(best.deg ? rotate(bw, best.deg) : bw), 180000, "読み取りが3分で終わりませんでした");
    return { text: clean(data.text), confidence: Math.round(data.confidence), rotation: best.deg };
  }

  const api = { docTypeOf, pageNames, assignByName, clean, findDates, dateAfter, valueAfter, staffCode, missionName, diseases, dailyUnits, extract, extractDrugs, recognize };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KousouOCR = api;
})(typeof window !== "undefined" ? window : globalThis);
