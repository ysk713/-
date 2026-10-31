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
      .replace(/([一-龠])[ \t]+和/g, "$1和")                                          // 「令 和」→「令和」（先に詰める）
      .replace(/[^\s\d昭平]和(?=\s*(\d{1,2}|元)\s*年)/g, "令和")                // 「令和」の誤読（念和・信和・含和・金和・る和…）。後ろに「8年」が続くものに限り、昭和・平成は除く
      .replace(/(^|[\s|:：])和(?=\s*\d{1,2}\s*年)/gm, "$1令和")                    // 「令」が抜けたもの
      .replace(/([(（])\s+/g, "$1").replace(/\s+([)）])/g, "$1")          // 「( 1 )」→「(1)」
      .replace(/(\d)[ \t]+(?=(mg|μg|µg|g|mL)\b)/gi, "$1")                 // 「5 mg」→「5mg」
      .replace(/(\d)[ \t]+(?=[^\x00-\x7F])/g, "$1")                         // 「1 回」→「1回」
      .replace(/(\d)\s+\.(?=\s)/g, "$1.")                                   // 「1 . 病名」→「1. 病名」
      .replace(/([^\x00-\x7F])[ \t]+(?=[^\x00-\x7F])/g, "$1").replace(/(\d)[ \t]+(?=\d)/g, "$1")
      .replace(/([^\x00-\x7F])[ \t]+(?=\d)/g, "$1").replace(/(\d)[ \t]+(?=[年月日])/g, "$1").replace(/[ \t]+\n/g, "\n").trim();
  }

  // 文中の日付をすべて（位置つき）。令和・R・西暦・平成
  function findDates(text) {
    // 西暦の年の1桁の読み違い（2926年・2O26年）を今年前後に直す
    const t = clean(text).replace(/(?<!\d)([2Z])([0-9OoQD])([2Z])([0-9OoQD])(?=\s*年)/g, (m0) => { const y = m0.replace(/[Z]/g, "2").replace(/[OoQD]/g, "0"); return y; })
      .replace(/(?<!\d)(\d{4})(?=\s*年\s*\d{1,2}\s*月)/g, y => { const now = new Date().getFullYear(); if (Math.abs(+y - now) <= 2) return y; const diff = [...y].filter((c, i) => c !== String(now)[i]).length; return diff === 1 ? String(now) : y; }), out = [];
    const re = /(令和|R|平成|H)\s*(\d{1,2}|元)\s*[年.\/]\s*(\d{1,2})\s*[月.\/]\s*(\d{1,2})\s*日?|(20\d{2,3})\s*[年.\/-]\s*(\d{1,2})\s*[月.\/-]\s*(\d{1,2})\s*日?/gi;
    let m;
    const now = new Date().getFullYear();
    const fixY = y => { if (y.length === 5) for (let i = 0; i < 5; i++) { const c = y.slice(0, i) + y.slice(i + 1); if (Math.abs(+c - now) <= 2) return c; } return y; };   // 20286年→2026年
    const fixM = mo => (+mo > 12 && +mo % 10 <= 2 && mo.length === 2) ? String(10 + (+mo % 10)) : mo;                                                            // 40月→10月（1を4と読み違い）
    while ((m = re.exec(t))) {
      const iso = m[1] ? R.pdate(`${m[1]}${m[2]}.${fixM(m[3])}.${m[4]}`) : R.pdate(`${fixY(m[5])}/${fixM(m[6])}/${m[7]}`);
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
  // ラベルの後ろ（同じ行、空なら次の行）の文字。ラベルは正規表現か文字列（文字列はOCRの1文字の読み違いを許す）
  function valueAfter(text, labels, max = 40, skip = null) {
    const lines = clean(text).split(/\n/);
    for (const l0 of labels) {
      const l = typeof l0 === "string" ? fuzzy(l0) : l0;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(l); if (!m) continue;
        if (skip && skip.test(lines[i].slice(0, m.index + m[0].length + 2))) continue;   // 例：医務官氏名の行は患者の氏名ではない
        let v = lines[i].slice(m.index + m[0].length).replace(/^[\s:：()（）]+/, "").trim();
        if (!v && i + 1 < lines.length) v = lines[i + 1].trim();
        if (v) return v.slice(0, max);
      }
    }
    return "";
  }
  const STAFF = /(?:職|識|織|陽|聡|戦).{0,2}(?:コード|番号|code)|員(?:コード|番号)/i;   // 「職遇コード」「陽身番号」のような誤読も拾う
  function staffCode(text) {
    const t = clean(text), i = t.search(STAFF);
    if (i < 0) {   // 見出しが読めないときは、日付・公館コード以外の5〜8桁の数字
      const u = t.replace(/\d{4}\s*年|\d+\s*[月日]|公館.{0,6}?\d+[A-Z]?|20[2-3]\d{3,5}/g, "");
      const m = u.match(/(?<![\d.])[Aa]?\d{5,6}(?![\d.])/) || u.match(/(?<![\d.])[Aa]?\d{7,8}(?![\d.])/);
      return m ? m[0] : "";
    }
    // 先頭のA以外の O・D・Q は 0、I・l・| は 1 の誤読として直す
    const m = t.slice(i, i + 60).replace(STAFF, "").match(/[Aa]?\s*[\dODQ][\dODQIl|\s-]{3,10}\d/);
    return m ? m[0].replace(/[\s-]/g, "").replace(/^([Aa]?)(.*)$/, (_, a, rest) => a + rest.replace(/[ODQ]/g, "0").replace(/[Il|]/g, "1")) : "";
  }
  function missionName(text) {
    const t0 = clean(text).replace(/[|｜]/g, " ");
    const m0 = t0.match(/在([^\s:：()（）。、・]{1,10}?)(.本[国還貫]|日本)?(大使|総領事|領事事務|政府代表|代表)./);
    if (m0) return `在${m0[1]}${m0[2] ? "日本国" : ""}${{ 大使: "大使館", 総領事: "総領事館", 領事事務: "領事事務所", 政府代表: "政府代表部", 代表: "代表部" }[m0[3]]}`;
    const t = clean(text), END = "(?:日本国)?(?:大使館|総領事館|領事事務所|政府代表部|代表部)";
    const m = t.match(new RegExp(`在[^\\s、。,:：()（）0-9]{1,16}?${END}`)) || t.match(new RegExp(`[^\\s、。,:：()（）0-9]{1,20}?${END}`));
    return m ? m[0].replace(/^.*?(所属公館名|送付先公館名|公館名|所属)[:：]?/, "") : "";
  }
  // ---- 語彙（病名・薬品名）で、OCRの1〜2文字の読み違いを直す。app.js から setVocab で渡す
  let VOCAB = { diseases: [], drugs: [], isDrug: () => false };
  const COMMON_DISEASES = ["高血圧症", "脂質異常症", "高コレステロール血症", "2型糖尿病", "糖尿病", "高尿酸血症", "痛風", "甲状腺機能低下症", "甲状腺機能亢進症", "逆流性食道炎",
    "慢性胃炎", "胃潰瘍", "アレルギー性鼻炎", "花粉症", "気管支喘息", "アトピー性皮膚炎", "不眠症", "うつ病", "不安障害", "片頭痛", "てんかん", "狭心症", "心房細動",
    "慢性心不全", "慢性腎臓病", "骨粗鬆症", "前立腺肥大症", "過活動膀胱", "月経困難症", "子宮内膜症", "便秘症", "関節リウマチ", "変形性関節症", "緑内障"];
  function setVocab(v) { VOCAB = Object.assign({ diseases: [], drugs: [], isDrug: () => false }, v); VOCAB.diseases = [...new Set(COMMON_DISEASES.concat(VOCAB.diseases))]; }
  // 文字の並びも見た近さ（共通部分列の長さ）。0〜1
  function seqSim(a, b) {
    const A = [...a], B = [...b], dp = Array(B.length + 1).fill(0);
    for (let i = 1; i <= A.length; i++) { let prev = 0; for (let j = 1; j <= B.length; j++) { const tmp = dp[j]; dp[j] = A[i - 1] === B[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = tmp; } }
    return 2 * dp[B.length] / (A.length + B.length || 1);
  }
  // 先頭が語彙のどれかに近ければ、その語に直す（後ろの雑音は落とす）
  function snap(s, list, th = 0.75) {
    let best = null, score = 0;
    for (const w of list) {
      const L = [...w].length; if (L < 2) continue;
      // 3文字以上の語は1文字の読み違いまで許す（不眼症→不眠症）
      const need = L >= 3 ? Math.min(th, (L - 1) / L - 0.001) : 1;
      for (const k of [L - 1, L, L + 1]) { const sc = seqSim(s.slice(0, k), w); if (sc >= need && (sc > score || (sc === score && best && L > [...best].length))) { score = sc; best = w; } }
    }
    return best;
  }
  const trimJunk = v => v.replace(/[ー\-ｰ・.,。、|｜\s()（）\[\]{}*'"]+$/g, "").replace(/[ンーｰ]+$/, "").trim();

  // 「１．病名（慢性疾患）：」の下の行から「２．服用薬・処方」の前まで。複数の病名は「、」でつなぐ
  function diseases(text) {
    const lines = clean(text).split(/\n/), i = lines.findIndex(l => /病\s*名|傷病名|診断名/.test(l));
    if (i < 0) return "";
    const out = [];
    const first = lines[i].replace(/^.*?(病\s*名|傷病名|診断名)\s*([(（]慢性疾患[)）])?\s*[:：]?/, "").trim();
    // 同じ行の残りは「（慢性疾患）：」の崩れであることが多いので、病名の語彙に当たるときだけ採る
    const f1 = first && snap(trimJunk(first.replace(/^[^)）]{0,10}[)）]\s*[:：_]*/, "")), VOCAB.diseases); if (f1) out.push(f1);
    for (let j = i + 1; j < lines.length && out.length < 6; j++) {
      if (/^\s*(2|２)\s*[.．]|服用薬|処方|生年月日|所\s*属/.test(lines[j])) break;
      let v = trimJunk(lines[j].replace(/^[\s.・|,(（\[{]*\d*\s*[)）\]}.]\s*/, "").replace(/^[\s|.・,)）:：_]+/, ""));
      if (!v || /慢性疾患|性疾/.test(v)) continue;
      const hit = snap(v, VOCAB.diseases);
      if (hit) out.push(hit); else if (/(症|病|炎|障害|疾患|腫)$/.test(v) && v.length <= 15) out.push(v);   // 語彙に無い病名は、病名らしい形のときだけ
    }
    return out.join("、").slice(0, 80);
  }
  // 氏名：先頭の漢字・かなの並び（雑音の記号で止める）。長すぎるものは雑音が付いているので8文字までにする
  const personName = v => (v.replace(/^[\s|｜:：.・\[\]「」]+/, "").match(/^[一-龠々〆ヵヶぁ-んァ-ヶ・\s]{2,12}/) || [""])[0].replace(/\s+/g, "").replace(/(殿|様|印|㊞)$/, "").slice(0, 8);

  // 書類の種類ごとに項目の候補を取り出す（読めたものだけ）
  function extract(type, text) {
    const t = clean(text), f = {};
    const lastDate = (findDates(t).slice(-1)[0] || {}).iso;
    if (type === "申込書") {
      f["app.apply_date"] = dateAfter(t, [/申込(?:年月)?日/, /記入日/, /申込/]) || (findDates(t)[0] || {}).iso;
      const an = personName(valueAfter(t, ["申込者氏名", /氏\s*名/], 40, DOCTOR)), pn = personName(valueAfter(t, ["療養者氏名", /療養者/, "患者氏名"], 40, DOCTOR));
      if (looksName(an)) f["app.applicant_name"] = an;
      if (looksName(pn)) f["app.patient_name"] = pn;
      f["app.staff_code"] = staffCode(t);
      f["app.mission_name"] = missionName(t);
      const mc = t.match(/公館(?:コード|番号)[^\d]{0,6}(\d{3,8}[A-Z]?)/); if (mc) f["app.mission_code"] = mc[1];
      Object.assign(f, consentInfo(t));
    } else if (type === "診断書") {
      f["diag.issue_date"] = dateAfter(t, [/発行(?:年月)?日/, /診断(?:年月)?日/]) || lastDate;
      f["diag.staff_code"] = staffCode(t);
      f["diag.patient_name"] = pageNames("診断書", t)[0];
      // 氏名欄と職員コード欄の取り違え：氏名欄に数字、職員コード欄に人名
      const nameLine = valueAfter(t, [/^[\s|.・]*氏\s*名\s*[:：]?/m], 40, DOCTOR), codeLine = valueAfter(t, [STAFF], 40);
      if (/\d{4,}/.test(nameLine) && codeLine && !/\d{3,}/.test(codeLine) && looksName(personName(codeLine))) f["diag.name_code_swapped"] = true;
      f["diag.disease"] = diseases(t);
      f["diag.doctor_name"] = personName(valueAfter(t, [/(?:医師|医務官)\s*(?:氏\s*名|名)\s*[:：]?/]));
    } else if (type === "指示書") {
      f["inst.issue_date"] = dateAfter(t, [/発行(?:年月)?日/, /指示(?:年月)?日/]) || lastDate;
      f["inst.patient_name"] = pageNames("指示書", t)[0];
      f["inst.doctor_name"] = personName(valueAfter(t, [/(?:医師|医務官|健康管理医)\s*(?:氏\s*名|名)?/]));
    }
    for (const k of Object.keys(f)) if (!f[k]) delete f[k];
    return f;
  }

  // 薬の行：「アムロジピン錠5mg 1回1錠 1日1回 朝食後 30日分」→ {name, strength, unit, perDay, days}
  // isDrug(name) が真になる名前だけ採る（薬品マスタ・薬価基準リストで確かめる）
  function extractDrugs(text, isDrug) {
    const out = [], lines = clean(text).split(/\n/);
    const NAME = /([ァ-ヶー一-龠A-Za-z・]{2,30}?(?:OD錠|口腔内崩壊錠|徐放錠|配合錠|錠|カプセル|顆粒|細粒|散|テープ|パップ))[\s|｜\[\]]*([0-9.]+)?\s*(mg|μg|µg|ug|g|ミリグラム)?/g;
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
        out.push({ name, strength: m[2] || "", unit: (m[3] || "mg").replace(/µg|ug/, "μg").replace("ミリグラム", "mg"), perDay: perDay || "", days: fixDays(days) });
      }
    }
    // 薬品名が崩れて「錠」が読めないとき：「〇〇〇（崩れ）50mg」の形から、語彙で一番近い薬品名に直して拾う
    if (VOCAB.drugs.length) {
      const LOOSE = /([ァ-ヶー一-龠・]{3,16})[^\d\s|｜]{0,3}[\s|｜\[\]]*([0-9.]+)\s*(mg|μg|µg|ug)/g;
      for (let i = 0; i < lines.length; i++) {
        let m;
        while ((m = LOOSE.exec(lines[i]))) {
          const raw = m[1].replace(/(錠|カプセル|.)$/, ""), hit = snap(raw, VOCAB.drugs, 0.72) || snap(raw.slice(1), VOCAB.drugs, 0.72);
          if (!hit || out.some(d => nf(d.name).startsWith(nf(hit)))) continue;
          const rest = lines[i].slice(m.index + m[0].length), DAYS = /([0-9]{1,3})\s*日分(?!使用)/;
          out.push({ name: hit + "錠" + m[2] + m[3].replace(/µg|ug/, "μg"), strength: m[2], unit: m[3].replace(/µg|ug/, "μg"),
            perDay: dailyUnits(rest) || "", days: fixDays(((rest.match(DAYS) || clean(text).match(DAYS)) || [])[1]) });
        }
      }
    }
    for (const d of out) {
      const real = (VOCAB.strengths || (() => []))(d.name);
      if (real.length && d.strength && !real.includes(+d.strength)) {
        const oneOff = real.map(String).find(r => r.length === d.strength.length && [...r].filter((c, i) => c !== d.strength[i]).length === 1);
        const fix = [d.strength.slice(1), d.strength.slice(0, -1), d.strength.replace(/^0/, ""), oneOff].find(v => v && real.includes(+v));
        if (fix) { d.name = d.name.replace(d.strength, fix); d.strength = fix; }
      }
    }
    const seen = new Set();
    return out.filter(d => { const k = nf(d.name); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // 1日の使用量。優先順：「1日分使用量」の列（行末の「2錠」）＞「1日2錠」＞「2錠 分2」＞「1回1錠 1日2回」
  function dailyUnits(s0) {
    const U = "(?:錠|T|カプセル|C|包|枚)", s = String(s0).replace(/[\s|｜。.、ー・_\]\[]+$/, "");
    let m;
    if ((m = s.match(new RegExp(`([0-9.]+)\\s*${U}\\s*$`)))) return m[1];
    if ((m = s.match(new RegExp(`1日\\s*([0-9.]+)\\s*${U}`)))) return m[1];
    if ((m = s.match(new RegExp(`([0-9.]+)\\s*${U}\\s*(?:分|×)\\s*\\d`)))) return m[1];
    if ((m = s.match(new RegExp(`1回\\s*([0-9.]+)\\s*${U}.*?1日\\s*([0-9])\\s*回`)))) return String(+m[1] * +m[2]);
    if ((m = s.match(new RegExp(`1回\\s*([0-9.]+)\\s*${U}\\D{0,2}([1-4])\\s*\\S?\\s*回`)))) return String(+m[1] * +m[2]);   // 「1日」が崩れたとき
    return "";
  }

  // 同じ人の複数の書類から読んだ氏名の候補 → 共通部分（2文字以上）。OCRで後ろに付いた雑音を落とす
  function consensusName(cands) {
    const c = cands.map(x => nf(x).replace(/\s/g, "")).filter(x => x.length >= 2);
    if (c.length < 2) return c[0] || "";
    const subs = new Map();
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
      const a = c[i], b = c[j];
      for (let s = 0; s < a.length; s++) for (let e = s + 2; e <= a.length; e++) { const sub = a.slice(s, e); if (b.includes(sub)) subs.set(sub, (subs.get(sub) || 0) + 1); }
    }
    let best = ""; for (const [sub, n] of subs) if (sub.length > best.length || (sub.length === best.length && n > subs.get(best))) best = sub;
    return best.length >= 3 ? best : c.sort((a, b) => a.length - b.length)[0];
  }

  // 同意チェック欄：項目の数（番号の最大）と、⑨の文言が旧版か（「医薬品・領収書の転送」の「・領収書」が無い）。レ点は見ない
  function consentInfo(text) {
    const t = clean(text), f = {}, i = t.search(fuzzy("同意チェック"));
    if (i < 0) return f;
    const nums = new Set();
    for (const line of t.slice(i).split(/\n/)) { const m = line.match(/^[\s|｜\[\]口ロ□☑✓レ・.]{0,6}(\d{1,2})\s*[.．)）]/); if (m && +m[1] >= 1 && +m[1] <= 13) nums.add(+m[1]); }
    const max = Math.max(0, ...nums);
    // 項目数：11まで読めれば現行版。旧版（9項目）は、OCRで行が抜けただけと区別がつかないので「送付先公館名」欄があるときだけ旧版とする
    if (max >= 11) f["app.consent_item_count"] = "11";
    else if (fuzzy("送付先公館名").test(t.replace(/\s/g, ""))) { f["app.consent_item_count"] = "9"; f["app.old_form_features"] = "「送付先公館名」欄あり"; }
    const transfer = t.slice(i).split(/\n/).find(l => /転送/.test(l) && /(異動|伴う|医薬品)/.test(l));
    // 旧文言と言えるのは「医薬品の転送」がはっきり読めたときだけ（「領収書」が読めなかっただけで旧文言としない）
    // ⑨は両方の版とも「領収書は…」で始まるので、「伴う」と「転送」の間だけを見る（新：医薬品・領収書の転送／旧：医薬品の転送）
    if (transfer) { const m = transfer.replace(/\s/g, "").match(/伴(.{0,10}?)転送/); if (m) f["app.consent9_old_wording"] = /品の?$/.test(m[1]) && !/領|収|書/.test(m[1]); }
    return f;
  }

  // ---- 分割：書類の種類（表題）と氏名を読み、氏名で人ごとにまとめる
  // 表題がOCRで崩れても判定できるよう、ページ全体に出てくる特徴的な語の数で決める
  const SIGNS = {
    申込書: ["購送申込", "申込日", "公館コード", "職員番号", "同意チェック", "療養者", "続柄", "シメイ", "注意事項", "福利厚生", "外務大臣", "申込者", "控除", "赤枠内", "今般", "申し込みます", "本人が記入"],
    診断書: ["診断書", "病名", "慢性疾患", "服用薬", "処方", "継続投与", "入手が困難", "医務官氏名", "購送依頼", "症状は安定", "患者保管"],
    指示書: ["指示書", "薬品名", "含有量", "用法", "使用量", "日分", "健康管理医", "フリガナ", "後発医薬品", "患者氏名", "服用を指示", "下記の医薬品"],
    委任状: ["委任状", "委任します", "受任者", "委任者", "代理人"],
  };
  // OCRの崩れを許す検索：3文字以上の語は、1文字の読み違い（置き換わり）か、文字の間に1文字はさまっても一致とする
  const esc = c => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fuzzyCache = new Map();
  function fuzzy(word) {
    if (fuzzyCache.has(word)) return fuzzyCache.get(word);
    const ch = [...word], alts = [ch.map(esc).join("")];
    if (ch.length >= 3) {
      ch.forEach((_, i) => alts.push(ch.map((c, j) => j === i ? "." : esc(c)).join("")));
      alts.push(ch.map(esc).join(".?"));
    }
    const re = new RegExp(alts.join("|"));
    fuzzyCache.set(word, re); return re;
  }
  function docTypeOf(text) {
    const t = clean(text), score = {};
    const flat = t.replace(/[\s　]/g, "");
    for (const [k, list] of Object.entries(SIGNS)) score[k] = list.filter(w => fuzzy(w).test(flat)).length;
    // 先頭（表題）にあれば重く見る。申込書の本文には「指示書」「診断書」の語も出るので、表題は先頭の数行だけで見る
    const head = flat.slice(0, 50).replace(/[「『][^」』]{0,8}[」』]/g, "");   // 「指示書」のようなかぎ括弧の中は本文の引用なので表題とみなさない
    if (fuzzy("指示書").test(head)) score.指示書 += 2;
    if (fuzzy("診断書").test(head)) score.診断書 += 2;
    if (fuzzy("医薬品購送申込書").test(flat.slice(0, 120))) score.申込書 += 2;
    const [best, n] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
    return n >= 2 ? best : null;
  }
  // そのページに書かれた療養者（患者）の氏名。申込書は申込者と療養者の両方
  const DOCTOR = /医務官|医師|健康管理|管理医|医療|担当医/;
  // 人名らしいか（OCRの雑音・病名・書類の語を除く）
  const looksName = n => n && n.length >= 2 && n.length <= 8 && !/(症|病|炎|書|館|錠|薬|用|間|日|号|番|記|医|官|欄|込|式)/.test(n.slice(2)) && !DOCTOR.test(n);
  function pageNames(type, text) {
    const t = clean(text), v = labels => personName(valueAfter(t, labels, 40, DOCTOR));
    const names = type === "申込書" ? [v(["療養者氏名", /療養者/, "患者氏名"]), v(["申込者氏名", /^\s*氏\s*名/m])]
      : type === "診断書" ? [v([/^[\s|.・]*氏\s*名\s*[:：]?/m, /(?:患者|療養者)\s*氏\s*名/, /氏\s*名\s*[:：]/])]
      : type === "指示書" ? [v(["患者氏名", /氏\s*名/])]
      : type === "委任状" ? [v([/委任者\s*(?:氏\s*名)?/])] : [];
    return [...new Set(names.filter(looksName))];
  }
  // pages: [{key, type, names, code, drugs}]（スキャン順）→ { gid: {ページkey: 人のkey}, warn: {人のkey: [..]} }
  // 申込書1枚＝1人。ほかの書類は「氏名」→「職員番号」→「薬の組み合わせ」→「直前のページ」の順で人を決める（スキャン順に関係なく）。
  // 同じ姓の家族を取り違えないよう、氏名の近さ0.6未満は同じ人としない
  function assignByName(pages) {
    const sim = R.nameSim, people = [], gid = {}, warn = {};
    const code = c => String(c || "").replace(/^[Aa]/, "").replace(/\D/g, "").replace(/^0+/, "");
    const best = names => {
      let top = null, score = 0, second = 0;
      for (const g of people) {
        // 療養者の氏名（names[0]）を優先。家族の申込書の「申込者」欄にある職員本人の名前に引っぱられないよう、申込者名は少し軽く見る
        const sc = Math.max(0, ...names.map(a => g.names.length ? Math.max(sim(a, g.names[0]), 0.85 * Math.max(0, ...g.names.slice(1).map(b => sim(a, b)))) : 0));
        if (sc > score) { second = score; score = sc; top = g; } else if (sc > second) second = sc;
      }
      return score >= 0.6 && score - second >= 0.1 ? top : null;
    };
    const join = (p, g) => { gid[p.key] = g.key; (g.drugs ||= new Set()); (p.drugs || []).forEach(d => g.drugs.add(d)); if (!g.code && code(p.code)) g.code = code(p.code); };
    // 1回目：申込書で人を作る（2枚続きの申込書は同じ人）
    let prev = null;
    for (const p of pages) {
      if (p.type !== "申込書") { prev = null; continue; }
      const same = prev && (!p.names.length || p.names.some(a => prev.names.some(b => sim(a, b) >= 0.8)));
      if (same) { join(p, prev); prev.names.push(...p.names); continue; }
      prev = { key: p.key, names: [...p.names], code: code(p.code), app: true }; people.push(prev); join(p, prev);
    }
    // 2回目：氏名で決まるページ
    const rest = [];
    for (const p of pages) {
      if (gid[p.key]) continue;
      const g = p.names.length ? best(p.names) : null;
      if (g) join(p, g); else rest.push(p);
    }
    // 3回目：残り（氏名が読めない・合わない）→ 職員番号 → 薬の組み合わせ → 直前のページの人
    for (const p of rest) {
      const c = code(p.code);
      let g = null;
      if (c.length >= 4) { const hit = people.filter(x => x.code === c); if (hit.length === 1) g = hit[0]; }
      if (!g && (p.drugs || []).length) {
        const sc = people.map(x => { const D = x.drugs || new Set(); const n = p.drugs.filter(d => D.has(d)).length; return [x, n / Math.max(p.drugs.length, D.size || 1)]; })
          .filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]);
        if (sc.length && (sc.length === 1 || sc[0][1] - sc[1][1] >= 0.2)) g = sc[0][0];
      }
      if (g && p.names.length) (warn[g.key] ||= []).push(`${p.type}の氏名「${p.names[0]}」が申込書の氏名と一致しません（職員番号・処方で同じ人と判断。OCRの読み違いか、別の人の書類の可能性）。`);
      if (!g) {
        // スキャン順で一番近く、まだこの種類の書類が無い人へ（直前の人を優先）。どの人にもあれば、申込書の無い人として分ける
        const i = pages.indexOf(p), lacks = x => !pages.some(q => gid[q.key] === x.key && q.type === p.type);
        const dist = x => Math.min(...pages.map((q, j) => gid[q.key] === x.key ? (j < i ? i - j : (j - i) + 0.5) : Infinity));
        const cand = people.filter(lacks).sort((a, b) => dist(a) - dist(b))[0];
        if (cand && dist(cand) < Infinity) {
          g = cand;
          if (p.names.length) (warn[g.key] ||= []).push(`${p.type}の氏名「${p.names[0]}」が申込書の氏名と一致しません（OCRの読み違いか、別の人の書類の可能性）。`);
        } else {
          g = { key: p.key, names: [...p.names], app: false }; people.push(g);
          if (people.length > 1) (warn[g.key] ||= []).push("この人の申込書が見つかりません（氏名・職員番号で照合）。スキャン漏れか、読み違いの可能性があります。");
        }
      }
      join(p, g);
    }
    return { gid, warn, people };
  }

  const DAY_SET = [7, 14, 21, 28, 30, 35, 42, 45, 56, 60, 63, 84, 90, 98, 100, 105, 112, 120];
  // 日数：よく使う日数に寄せる（OCRで余分な数字が付いた「606日分」→60）
  function fixDays(raw) {
    if (!raw) return "";
    const d = String(raw);
    if (DAY_SET.includes(+d)) return d;
    for (let len = 3; len >= 2; len--) for (let i = 0; i + len <= d.length; i++) if (DAY_SET.includes(+d.slice(i, i + len))) return String(+d.slice(i, i + len));
    return +d > 0 && +d <= 180 ? d : "";
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
  // 表の罫線を消す：横に長く続く黒（文字幅の数倍以上）と縦に長く続く黒を白にする。罫線に挟まれた行がOCRで落ちるのを防ぐ
  function removeLines(c) {
    const x = c.getContext("2d"), w = c.width, h = c.height, img = x.getImageData(0, 0, w, h), d = img.data;
    const black = (i) => d[i * 4] < 128, minH = Math.round(w * 0.06), minV = Math.round(h * 0.03);
    const kill = [];
    for (let y = 0; y < h; y++) { let run = 0; for (let x0 = 0; x0 <= w; x0++) { if (x0 < w && black(y * w + x0)) run++; else { if (run >= minH) for (let k = x0 - run; k < x0; k++) kill.push(y * w + k); run = 0; } } }
    for (let x0 = 0; x0 < w; x0++) { let run = 0; for (let y = 0; y <= h; y++) { if (y < h && black(y * w + x0)) run++; else { if (run >= minV) for (let k = y - run; k < y; k++) kill.push(k * w + x0); run = 0; } } }
    for (const i of kill) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
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
  // 横書きの文書は、行（横方向）ごとの黒画素の量の偏りが、列（縦方向）ごとより大きい。逆なら横向きに置かれている
  function isSideways(bw) {
    const k = Math.min(1, 500 / Math.max(bw.width, bw.height)), w = Math.round(bw.width * k), h = Math.round(bw.height * k);
    const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(bw, 0, 0, w, h);
    const d = c.getContext("2d").getImageData(0, 0, w, h).data, rows = new Float64Array(h), cols = new Float64Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = 255 - d[(y * w + x) * 4]; rows[y] += v; cols[x] += v; }
    const cv = a => { const m = a.reduce((s, v) => s + v, 0) / a.length || 1; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) / m; };
    return cv(cols) > cv(rows) * 1.15;
  }
  // 横向き・逆さのスキャンに対応：縮小画像を0/90/180/270度で試し、読み取りの信頼度が最も高い向きで本番の読み取りをする
  async function recognize(canvas, onLog, opts = {}) {
    const w = await worker(onLog);
    const bw = opts.bin === "none" ? canvas : binarize(canvas);
    let best = { deg: 0, conf: -1 };
    const cands = isSideways(bw) ? [90, 270] : [0, 180];   // 文字の行が縦に並んでいれば横向きのスキャン
    for (const deg of cands) {
      const { data } = await withTimeout(w.recognize(rotate(bw, deg, 1100)), 60000, "向きの判定が60秒で終わりませんでした");
      if (data.confidence > best.conf) best = { deg, conf: data.confidence };
      if (data.confidence >= 75) break;   // よく読めていれば、もう一方の向きは試さない
    }
    let img = best.deg ? rotate(bw, best.deg) : bw;
    if (opts.lines !== false && opts.bin !== "none") img = removeLines(img === bw ? rotate(bw, 0) : img);
    let { data } = await withTimeout(w.recognize(img), 180000, "読み取りが3分で終わりませんでした");
    if (data.confidence < 60 && opts.bin !== "none") {   // 粗い・ぼけたスキャンは白黒化しない方が読めることがある
      const r2 = (await withTimeout(w.recognize(best.deg ? rotate(canvas, best.deg) : canvas), 180000, "読み取りが3分で終わりませんでした")).data;
      if (r2.confidence > data.confidence) data = r2;
    }
    return { text: clean(data.text), confidence: Math.round(data.confidence), rotation: best.deg };
  }

  const api = { consentInfo, fixDays, setVocab, snap, seqSim, consensusName, docTypeOf, pageNames, assignByName, clean, findDates, dateAfter, valueAfter, staffCode, missionName, diseases, dailyUnits, extract, extractDrugs, recognize };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KousouOCR = api;
})(typeof window !== "undefined" ? window : globalThis);
