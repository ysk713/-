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
      .replace(/(\d)\.[ \t]+(?=\d)/g, "$1.")                                    // 「2. 5mg」→「2.5mg」
      .replace(/(\d)[ \t]*[OoＯ][ \t]*n?(?=mg)/g, "$10")                         // 「5 Onmg」→「50mg」（0をOと読み違い）
      .replace(/(?<=[ァ-ヶー酸塩])[ \t]*[0O]{1,3}D(?=錠)/g, "OD")                          // 「0D錠」「0OD錠」→「OD錠」
      .replace(/カブセル/g, "カプセル")
      .replace(/(\d)[、,](\d)(?=[ \t]*mg)/g, "$1.$2")                                   // 「2、5mg」→「2.5mg」
      .replace(/([ァ-ヶー])[ \t_＿。、.]+(?=\d+(?:\.\d+)?[ \t]*mg)/g, "$1")                // 「クレストール _。2.5mg」→「クレストール2.5mg」
      .replace(/([ァ-ヶー])[ \t]+([A-Z]{1,3})[ \t]*(?=細粒|顆粒|散|錠)/g, "$1$2")            // 「ミヤ BM 細粒」→「ミヤBM細粒」
      .replace(/([ァ-ヶー])[ \t]*CP(?=[ \t]*\d)/g, "$1カプセル")                            // 「エソメプラゾール CP 20mg」→「エソメプラゾールカプセル20mg」
      .replace(/([A-Za-z])[ \t]+(?=錠)/g, "$1")                                   // 「OD 錠」→「OD錠」
      .replace(/([ァ-ヶー酸塩])[ \t]+(?=(?:OD|CR|SR|LA|XR|ER|L|R)錠)/g, "$1")          // 「ゾルミトリプタン OD錠」→「ゾルミトリプタンOD錠」
      .replace(/(\d)[ \t_＿]+(?=[日回]分)/g, "$1")
      .replace(/(?<![\d.])([2-9])1[ \t]*(?=[TＴ](?![a-zA-Z]))/g, "$1")              // 「2T」の T の縦線を1と読んだ「21T」→「2T」
      .replace(/(\d)meg\b/gi, "$1mg")                                            // 「5meg」→「5mg」
      .replace(/([ァ-ヶー])[ \t]+(?=Ca錠|Ca\b)/g, "$1")                              // 「ピタバスタチン Ca錠」→「ピタバスタチンCa錠」
      .replace(/(錠|カプセル)[ \t]*[.・,][ \t]*(?=\d)/g, "$1")                         // 「バイアスピリン錠 . 100mg」→「バイアスピリン錠100mg」                                  // 「100 _ 日分」→「100日分」
      .replace(/(\d)[ \t]+(?=[^\x00-\x7F])/g, "$1")                         // 「1 回」→「1回」
      .replace(/(\d)\s+\.(?=\s)/g, "$1.")                                   // 「1 . 病名」→「1. 病名」
      .replace(/([^\x00-\x7F])[ \t]+(?=[^\x00-\x7F])/g, "$1").replace(/(\d)[ \t]+(?=\d)/g, "$1")
      .replace(/([^\x00-\x7F])[ \t]+(?=\d)/g, "$1").replace(/(\d)[ \t]+(?=[年月日])/g, "$1").replace(/[ \t]+\n/g, "\n").trim();
  }

  // 文中の日付をすべて（位置つき）。令和・R・西暦・平成
  function findDates(text) {
    // 西暦の年の1桁の読み違い（2926年・2O26年）を今年前後に直す
    const t = clean(text).replace(/(?<!\d)([2Z])([0-9OoQD])([2Z])([0-9OoQD])(?=\s*年)/g, (m0) => { const y = m0.replace(/[Z]/g, "2").replace(/[OoQD]/g, "0"); return y; })
      .replace(/(?<!\d)(\d{4})(?=\s*年\s*\d{1,2}\s*月)/g, y => { const now = new Date().getFullYear(); if (+y === now || +y === now - 1) return y; const diff = [...y].filter((c, i) => c !== String(now)[i]).length; return diff === 1 ? String(now) : y; }), out = [];   // 申込日・発行日は未来にならないので、1桁違いの未来の年（2028）は今年に
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
      if (i < 0) continue;
      const d = ds.find(x => x.index >= i && x.index - i < 80); if (d) return d.iso;
      // 年が崩れて読めないとき（「ドー2年10月16昌」）：見出しの後ろの「月日」を今年の日付として読む
      const md = t.slice(i, i + 80).match(/(\d{1,2})\s*[月朋]\s*(\d{1,2})\s*[日昌曰]/);
      if (md) { const iso = R.pdate(`${new Date().getFullYear()}/${md[1]}/${md[2]}`); if (iso) return iso; }
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
    const m = t.slice(i, i + 60).split("\n")[0].replace(STAFF, "").match(/[Aa]?[ \t]*[\dODQ][\dODQIl| \t-]{2,10}\d/);   // 4桁のコードもある   // 次の行（「1. 病名」の1など）を付けない
    return m ? m[0].replace(/[\s-]/g, "").replace(/^([Aa]?)(.*)$/, (_, a, rest) => a + rest.replace(/[ODQ]/g, "0").replace(/[Il|]/g, "1")) : "";
  }
  function missionName(text) {
    const raw = missionNameRaw(text);
    if (!raw || !VOCAB.posts.length) return raw;
    const hit = snap(raw, VOCAB.posts.map(p => p[1]), 0.7) || snap(raw.replace(/日本国/, ""), VOCAB.posts.map(p => p[1]), 0.7);
    return hit || raw;
  }
  // 公館コード（例 705A）。公式の一覧にあるものだけ。O→0 の読み違いも直す
  function missionCode(text) {
    const t = clean(text), i = t.search(/[公会人]?館コ.?ド|公館番号/); if (i < 0) return "";
    for (const m of t.slice(i, i + 80).matchAll(/(?<![0-9A-Za-z])([0-9OoQD]{3}[A-Za-z])(?![0-9A-Za-z])/g)) {
      const c = m[1].toUpperCase().replace(/[OoQD](?=.*[A-Z]$)/g, "0");
      if (!VOCAB.posts.length || VOCAB.posts.some(p => p[0] === c)) return c;
    }
    return "";
  }
  // 公館コードの1文字の読み違い（619A→519A）：コードの公館名と、読めた公館名が違い、1文字違いのコードがその公館なら直す
  function codeByMission(code, name) {
    if (!code || !name || !VOCAB.posts.length) return code;
    const nn = s => nf(s).replace(/日本国|日本|\s/g, ""), own = (VOCAB.posts.find(p => p[0] === code) || [])[1];
    if (own && nn(own) === nn(name)) return code;
    const alt = VOCAB.posts.filter(p => nn(p[1]) === nn(name) && p[0].length === code.length && [...p[0]].filter((ch, k) => ch !== code[k]).length === 1);
    return alt.length === 1 ? alt[0][0] : code;
  }
  const postName = code => (VOCAB.posts.find(p => p[0] === code) || [])[1] || "";
  function missionNameRaw(text) {
    const t0 = clean(text).replace(/[|｜]/g, " ");
    const m0 = t0.match(/在([^\s:：()（）。、・]{1,10}?)(.本[国還貫]|日本)?([大犬太]使|総領事|領事事務|政府代表|代表)./);   // 「犬使館」「太使館」は大使館の読み違い
    if (m0) return `在${m0[1]}${m0[2] ? "日本国" : ""}${{ 総領事: "総領事館", 領事事務: "領事事務所", 政府代表: "政府代表部", 代表: "代表部" }[m0[3]] || "大使館"}`;
    const t = clean(text), END = "(?:日本国)?(?:大使館|総領事館|領事事務所|政府代表部|代表部)";
    const m = t.match(new RegExp(`在[^\\s、。,:：()（）0-9]{1,16}?${END}`)) || t.match(new RegExp(`[^\\s、。,:：()（）0-9]{1,20}?${END}`));
    return m ? m[0].replace(/^.*?(所属公館名|送付先公館名|公館名|所属)[:：]?/, "") : "";
  }
  // ---- 語彙（病名・薬品名）で、OCRの1〜2文字の読み違いを直す。app.js から setVocab で渡す
  let VOCAB = { diseases: [], drugs: [], drugsMaster: [], posts: [], isDrug: () => false };
  const COMMON_DISEASES = ["高血圧症", "脂質異常症", "高コレステロール血症", "2型糖尿病", "糖尿病", "高尿酸血症", "痛風", "甲状腺機能低下症", "甲状腺機能亢進症", "逆流性食道炎",
    "慢性胃炎", "胃潰瘍", "アレルギー性鼻炎", "花粉症", "気管支喘息", "アトピー性皮膚炎", "不眠症", "うつ病", "不安障害", "片頭痛", "てんかん", "狭心症", "心房細動",
    "慢性心不全", "慢性腎臓病", "骨粗鬆症", "前立腺肥大症", "過活動膀胱", "月経困難症", "子宮内膜症", "便秘症", "関節リウマチ", "変形性関節症", "緑内障"];
  function setVocab(v) { VOCAB = Object.assign({ diseases: [], drugs: [], drugsMaster: [], posts: [], isDrug: () => false }, v); VOCAB.diseases = [...new Set(COMMON_DISEASES.concat(VOCAB.diseases))]; }
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
    const SUF = /(症|病|炎|障害|害|疾患|腫|沈着|膨満|術後|低下|不全|欠乏|過多|発作|結石|潰瘍)$/;
    // 病名の欄の行を集める。行の終わりが病名の終わりでなければ（「高コレ」＋改行＋「ステロール血症」）次の行とつなぐ
    const rows = [lines[i].replace(/^.*?(病\s*名|傷病名|診断名)\s*([(（][^)）]{0,6}[)）])?\s*[:：_]*/, "").trim()];
    for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
      if (/^\s*(2|２)\s*[.．]|服用薬|処方|生年月日|所\s*属|上記/.test(lines[j])) break;
      const v = lines[j].replace(/^[\s|.・,:：_]+/, "").trim(); if (!v || /慢性疾患|性疾/.test(v)) continue;
      const last = rows[rows.length - 1];
      if (last && !SUF.test(trimJunk(last.split(/[、,，]/).pop().trim())) && /^[ァ-ヶー一-龠]/.test(v)) rows[rows.length - 1] = last + v; else rows.push(v);
    }
    const out = [];
    for (const part of rows.join("、").split(/[、,，\/]|\(\d\)|（\d）/)) {
      const w = trimJunk(part.replace(/^[\s.・|(（\[{]*\d*\s*[)）\]}.]\s*/, "").trim()); if (!w || w.length < 2) continue;
      const hit = snap(w, VOCAB.diseases);
      if (hit) { if (!out.includes(hit)) out.push(hit); }
      else if (SUF.test(w) && w.length <= 15) out.push(w.replace(/^[^ぁ-んァ-ヶ一-龠]+/, ""));   // 語彙に無い病名は、病名らしい形のときだけ
      if (out.length >= 8) break;
    }
    return out.join("、").slice(0, 100);
  }
  // 氏名：先頭の漢字・かなの並び（雑音の記号で止める）。長すぎるものは雑音が付いているので8文字までにする
  const personName = v => (v.replace(/[(（]\s*旧\s*姓[^)）]{0,8}[)）]/g, "").replace(/^[\s|｜:：.・\[\]「」。、,，ー]+/, "").match(/^[一-龠々〆ヵヶぁ-んァ-ヶ・\s]{2,12}/) || [""])[0].replace(/\s+/g, "").replace(/(殿|様|印|㊞)$/, "").replace(/[ぁ-ん]{0,4}(受領|適用|利用|手引|規約|共済|制度|同意).*$/, "").slice(0, 8);   // 2枚分を1ページに縮小した申込書で、右側の文章が名前の後ろに付く（〇〇花子いて受領）

  // 書類の種類ごとに項目の候補を取り出す（読めたものだけ）
  function extract(type, text) {
    const t = clean(text), f = {};
    const lastDate = (findDates(t).slice(-1)[0] || {}).iso;
    if (type === "申込書") {
      f["app.apply_date"] = dateAfter(t, [/申込(?:年月)?日/, /込日付/, /記入日/, /申込/]) || (findDates(t)[0] || {}).iso;
      if (!f["app.apply_date"]) {   // 年と月だけ読めたとき（「2028年5月和れ目」）：年月を残し、発行日より前なら要確認にする
        const i0 = t.search(/申込(?:年月)?日|込日付/), ym = i0 >= 0 && t.slice(i0, i0 + 60).match(/(20\d{2})\s*年\s*(\d{1,2})\s*月/);
        if (ym) { const now = new Date().getFullYear(); const y = [...ym[1]].filter((c, k) => c !== String(now)[k]).length <= 1 ? now : +ym[1]; f["app.apply_month"] = `${y}-${String(+ym[2]).padStart(2, "0")}`; }
      }
      if (!f["app.apply_date"]) {   // 見出しも年も崩れたとき：申込書の上の方（申込日の欄のあたり）の「〇月〇日」を今年の日付として読む
        const md = t.slice(0, 500).match(/(\d{1,2})\s*[月朋]\s*(\d{1,2})\s*[日昌曰]/);
        if (md) f["app.apply_date"] = R.pdate(`${new Date().getFullYear()}/${md[1]}/${md[2]}`);
      }
      const an = personName(valueAfter(t, ["申込者氏名"], 40, DOCTOR)), pn = personName(valueAfter(t, ["療養者氏名", /養者.{0,5}氏\s*名/, /^[^申込\n]{0,7}氏\s*名/m, "患者氏名"], 40, DOCTOR));
      if (looksName(an)) f["app.applicant_name"] = an;
      if (looksName(pn)) f["app.patient_name"] = pn;
      f["app.staff_code"] = staffCode(t);
      f["app.mission_name"] = missionName(t);
      let mc = codeByMission(missionCode(t), missionName(t));
      if (!mc && missionName(t) && VOCAB.posts.length) {   // コードが読めず、公館名が読めた：公館名からコードを引く（公館名はコードから自動入力される欄）
        const nn = s => nf(s).replace(/日本国|日本|\s/g, ""), hit = VOCAB.posts.filter(p => nn(p[1]) === nn(missionName(t)));
        if (hit.length === 1) mc = hit[0][0];
      }
      if (mc) { f["app.mission_code"] = mc; if (postName(mc)) f["app.mission_name"] = postName(mc); }   // 申込書の公館名は公館コードから自動入力される
      else { const mc2 = t.match(/公館(?:コード|番号)[^\d]{0,6}(\d{3,8}[A-Z]?)/); if (mc2) f["app.mission_code"] = mc2[1]; }
      // 続柄（本人なら療養者＝申込者）
      const rel = valueAfter(t, ["申込者との続柄", /続\s*柄/, /者との続./], 14).replace(/[\s|ー・。]/g, "");
      const relHit = ["本人", "配偶者", "妻", "夫", "子", "長男", "長女", "次男", "次女", "父", "母"].find(r => rel.includes(r));
      if (relHit) f["app.patient_relation"] = relHit === "本人" ? "本人" : /妻|夫|配偶者/.test(relHit) ? "配偶者" : /子|男|女/.test(relHit) ? "子" : "その他";
      Object.assign(f, consentInfo(t));
    } else if (type === "診断書") {
      f["diag.issue_date"] = dateAfter(t, [/発行(?:年月)?日/, /診断(?:年月)?日/]) || lastDate;
      f["diag.staff_code"] = staffCode(t);
      f["diag.patient_name"] = pageNames("診断書", t)[0];
      // 氏名欄と職員コード欄の取り違え：氏名欄に数字、職員コード欄に人名
      const nameLine = valueAfter(t, [/^[\s|.・]*氏\s*名\s*[:：]?/m], 40, DOCTOR), codeLine = valueAfter(t, [STAFF], 40);
      if (/\d{4,}/.test(nameLine) && codeLine && !/\d{3,}/.test(codeLine) && looksName(personName(codeLine))) f["diag.name_code_swapped"] = true;
      f["diag.disease"] = diseases(t);
      // 医師名は自筆署名で、OCRでは読めないので自動では入れない
    } else if (type === "指示書") {
      f["inst.issue_date"] = dateAfter(t, [/発行(?:年月)?日/, /指示(?:年月)?日/]) || lastDate;
      f["inst.patient_name"] = pageNames("指示書", t)[0];

    }
    for (const k of Object.keys(f)) if (!f[k]) delete f[k];
    return f;
  }

  // 薬の行：「アムロジピン錠5mg 1回1錠 1日1回 朝食後 30日分」→ {name, strength, unit, perDay, days}
  // isDrug(name) が真になる名前だけ採る（薬品マスタ・薬価基準リストで確かめる）
  function extractDrugs(text, isDrug) {
    const out = [], lines = clean(text).split(/\n/);
    const NAME = /([ァ-ヶー一-龠A-Za-z・]{2,30}?(?:OD錠|口腔内崩壊錠|徐放錠|配合錠|錠|カプセル|顆粒|細粒|散|テープ|パップ))[\s|｜\[\]]*(?:([0-9.]+)\s*(mg|μg|µg|ug|g|ミリグラム))?/g;   // 含有量は単位があるときだけ（「配合錠1日1回」の1を含有量にしない）
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      while ((m = NAME.exec(line))) {
        const name = m[1] + (m[2] ? m[2] + (m[3] || "") : "");
        if (!isDrug(m[1])) continue;
        const near = line.slice(m.index) + " " + (lines[i + 1] || "");   // 用法・日数が次の行に書かれることもある
        const rest = line.slice(m.index + m[0].length);
        const perDay = dailyUnits(rest) || dailyUnits(lines[i + 1] || "");
        const DAYS = /([0-9]{1,3})\s*(?:日|回)分(?!使用)/;   // 見出しの「１日分使用量」は日数ではない。頓用は「24回分」
        const days = (near.match(DAYS) || clean(text).match(DAYS) || [])[1];
        const prn = /頓用|頓服|時頓/.test(near);
        out.push({ name, strength: m[2] || "", unit: (m[3] || "mg").replace(/µg|ug/, "μg").replace("ミリグラム", "mg"), perDay: perDay || (prn ? onceUnits(rest) : ""), days: prn ? (days || "") : fixDays(days), prn });
      }
    }
    // 漢方（ツムラ43 六君子湯 1回1包 1日3回）
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/(ツムラ|クラシエ|コタロー|オースギ|ジュンコウ|ツムラ)\s*(?:の)?\s*([0-9]{1,3})?\s*(?:番)?\s*([一-龠]{2,8}(?:湯|散|丸|飲|膏))?/);
      if (!m || (!m[2] && !m[3])) continue;
      const rest = lines[i].slice(m.index + m[0].length) + " " + (lines[i + 1] || "");
      const t1 = rest.match(/1回\s*([0-9.]+)\s*包.*?1日\s*([0-9])\s*回/), t2 = rest.match(/1日\s*([0-9.]+)\s*包/), t3 = rest.match(/([0-9.]+)\s*包\s*(?:分|×)\s*\d/);
      const DAYS = /([0-9]{1,3})\s*(?:日|回)分(?!使用)/;
      out.push({ name: `${m[1]}${m[2] || ""}${m[3] ? " " + m[3] : ""}`.trim(), strength: "", unit: "包",
        perDay: t1 ? String(+t1[1] * +t1[2]) : (t2 || t3 || [])[1] || "", days: fixDays(((rest.match(DAYS) || clean(text).match(DAYS)) || [])[1]) });
    }
    // 薬品名が崩れて「錠」が読めないとき：「〇〇〇（崩れ）50mg」の形から、語彙で一番近い薬品名に直して拾う
    if (VOCAB.drugs.length) {
      const LOOSE = /([ァ-ヶー一-龠・]{3,16})[^\d\s|｜]{0,3}[\s|｜\[\]]*([0-9.]+)\s*(mg|μg|µg|ug)/g;
      for (let i = 0; i < lines.length; i++) {
        let m;
        while ((m = LOOSE.exec(lines[i]))) {
          // 前の行で薬が見つかっていて、この行に用法（回・日・食・朝・錠など）が無ければ、成分名の説明の行（ヤーズフレックスの下の「エチニルエストラジオール0.02mg」など）
          if (/\d\s*mg\s*[・,、]\s*[ァ-ヶー一-龠]+.*\d\s*mg/.test(lines[i]) && !/錠|カプセル|[回日食朝昼夕]/.test(lines[i])) continue;   // 配合剤の成分の行（アスコルビン酸200mg・パントテン酸カルシウム3mg）
          if (out.length && !/[回日食朝昼夕錠TC包]|就寝|頓/.test(lines[i].slice(m.index + m[0].length) + lines[i].slice(0, m.index).replace(/^\D*\(?\d\)?\s*/, ""))) continue;
          const raw = m[1].replace(/(錠|カプセル|.)$/, "");
          // まず薬品マスタ（継続処方の多い薬）で直し、薬価基準の全品目（約9千）はかなり近いときだけ（ロスバスタチン→ゾスパタのような取り違えを防ぐ）
          const hit = snap(raw, VOCAB.drugsMaster, 0.72) || snap(raw.slice(1), VOCAB.drugsMaster, 0.72) || snap(raw, VOCAB.drugs, 0.85) || snap(raw.slice(1), VOCAB.drugs, 0.85);
          const core = x => nf(x).replace(/(塩|OD錠|錠|カプセル).*$/, "");
          if (!hit || out.some(d => nf(d.name).startsWith(nf(hit)) || (core(hit).length >= 5 && core(d.name).startsWith(core(hit).slice(0, 6))))) continue;
          const rest = lines[i].slice(m.index + m[0].length), DAYS = /([0-9]{1,3})\s*(?:日|回)分(?!使用)/;
          const prn = /頓用|頓服|時頓/.test(rest), dm = ((rest.match(DAYS) || clean(text).match(DAYS)) || [])[1];
          out.push({ name: hit + "錠" + m[2] + m[3].replace(/µg|ug/, "μg"), strength: m[2], unit: m[3].replace(/µg|ug/, "μg"),
            perDay: dailyUnits(rest) || (prn ? onceUnits(rest) : ""), days: prn ? (dm || "") : fixDays(dm), prn });
        }
      }
    }
    for (const d of out) {
      const real = (VOCAB.strengths || (() => []))(d.name);
      if (real.length && d.unit === "g" && real.includes(+d.strength) && (VOCAB.unitOf || (() => ""))(d.name) === "μg") { d.unit = "μg"; d.name = d.name.replace(/g$/, "μg"); }   // 「50μg」の μ が読めず「50g」
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
  // 頓用の1回量（「1回1錠」「1錠 頭痛時」）
  function onceUnits(s) { const m = String(s).match(/1回\s*([0-9.]+)\s*(?:錠|T|カプセル|C|包|枚)/) || String(s).match(/^[^0-9]{0,6}([0-9.]+)\s*(?:錠|T)/); return m ? m[1] : ""; }
  function dailyUnits(s0) {
    const U = "(?:錠|T|カプセル|C|包|枚)", s = String(s0).replace(/[\s|｜。.、ー・_\]\[]+$/, "");
    let m;
    if ((m = s.match(new RegExp(`([0-9.]+)\\s*${U}\\s*$`)))) return m[1];
    if ((m = s.match(/(?:食後|食前|時|前|後)\s*([1-9](?:\.5)?)$/))) return m[1];   // 「1x夕食後 2T」のTが読めなかったとき
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
    // 3つ以上の候補があれば、ほかの候補との近さの合計が一番大きい候補（例：等井花子・架井花項・穫井花項・架井花子 → 架井花子）
    if (c.length >= 3) {
      const score = x => c.reduce((s2, y) => s2 + R.nameSim(x, y), 0) - 1 - (x.length > 6 ? 0.5 : 0);   // 同じ読みが複数の書類にあれば、その分の票になる
      const med = [...c].sort((a, b) => score(b) - score(a) || a.length - b.length)[0];
      if (score(med) / (c.length - 1) >= 0.6) return med;
    }
    const subs = new Map();
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
      const a = c[i], b = c[j];
      for (let s = 0; s < a.length; s++) for (let e = s + 2; e <= a.length; e++) { const sub = a.slice(s, e); if (b.includes(sub)) subs.set(sub, (subs.get(sub) || 0) + 1); }
    }
    let best = ""; for (const [sub, n] of subs) if (sub.length > best.length || (sub.length === best.length && n > subs.get(best))) best = sub;
    if (best.length >= 3) return best;
    const withBest = best ? c.filter(x => x.includes(best) && x.length <= 6).sort((a, b) => b.length - a.length) : [];
    return withBest[0] || c.sort((a, b) => a.length - b.length)[0];   // 「見本綾」と「見本」→「見本綾」
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
  // 裏面（両面スキャンの裏）：申込書の「利用の手引き」や、注意事項だけのページ。氏名・日付・書類の見出しが無い
  function isBackSide(text) {
    const flat = clean(text).replace(/[\s　]/g, "");
    if (flat.length < 15) return false;
    // 表の書類の見出し（ゆるい一致だと「医薬品」が「薬品名」に当たるので、ここは完全一致で数える）
    const fronts = ["申込日", "職員番号", "療養者", "公館コード", "病名", "服用薬", "薬品名", "含有量", "患者氏名", "医務官氏名", "健康管理医", "委任状", "同意チェック"].filter(w => flat.includes(w)).length;
    const dated = findDates(text).length > 0;
    if (fuzzy("利用の手引き").test(flat) && fronts <= 1 && !dated) return true;
    // 診断書・指示書の裏の「注意事項 患者・医師共通 ※必読※」：本文に病名・診断書などの語は出るが、記入欄（氏名・番号・日付）は無い
    if (fuzzy("注意事項").test(flat) && (fuzzy("必読").test(flat) || fuzzy("医師共通").test(flat)) && !dated
      && !["患者氏名", "職員コード", "職員番号", "申込日", "医師氏名", "医務官氏名", "健康管理医", "薬品名", "含有量"].some(w => flat.includes(w))) return true;
    return fronts === 0 && !dated && /注意事項|手引|裏面|記入例/.test(flat);
  }
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
    if (isBackSide(t)) return "裏面";
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
  const looksName = n => n && n.length >= 2 && n.length <= 8 && !/^(シメイ|フリガナ|ふりがな|氏名|申込者|療養者|続柄)/.test(n) && !/(症|病|炎|書|館|錠|薬|用|間|日|号|番|記|医|官|欄|込|式)/.test(n.slice(2)) && !DOCTOR.test(n);
  function pageNames(type, text) {
    const t = clean(text), v = labels => personName(valueAfter(t, labels, 40, DOCTOR));
    const names = type === "申込書" ? [v(["療養者氏名", /養者.{0,2}氏\s*名/, /^[^申込\n]{0,4}氏\s*名/m, "患者氏名"]), v(["申込者氏名"])]
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
    // 療養者の氏名（names[0]）を優先。家族の申込書の「申込者」欄にある職員本人の名前に引っぱられないよう、申込者名は少し軽く見る
    const scoreOf = (names, g) => Math.max(0, ...names.map(a => g.names.length ? Math.max(sim(a, g.names[0]), 0.85 * Math.max(0, ...g.names.slice(1).map(b => sim(a, b)))) : 0));
    const best = names => {
      let top = null, score = 0, second = 0;
      for (const g of people) {
        const sc = scoreOf(names, g);
        if (sc > score) { second = score; score = sc; top = g; } else if (sc > second) second = sc;
      }
      return score >= 0.6 && score - second >= 0.1 ? top : null;
    };
    // 同じ人が申込書を2回分出しているとき（氏名が同じ人が2人以上）：スキャン順で直前の、まだこの種類の書類が無い申込みへ
    const sameNameNearest = p => {
      const sc = people.map(g => [g, scoreOf(p.names, g)]).filter(([, v]) => v >= 0.6);
      if (sc.length < 2) return null;
      const top = Math.max(...sc.map(([, v]) => v)), tied = sc.filter(([, v]) => top - v < 0.1).map(([g]) => g);
      if (tied.length < 2) return null;
      const i = pages.indexOf(p), at = g => pages.findIndex(q => q.key === g.key);
      const lacks = g => !pages.some(q => gid[q.key] === g.key && q.type === p.type);
      const before = tied.filter(g => at(g) >= 0 && at(g) < i).sort((a, b) => at(b) - at(a));
      return before.find(lacks) || before[0] || null;
    };
    const join = (p, g) => { gid[p.key] = g.key; (g.drugs ||= new Set()); (p.drugs || []).forEach(d => g.drugs.add(d)); if (!g.code && code(p.code)) g.code = code(p.code); };
    // 裏面・その他（両面スキャンの裏など）は、最後に直前のページ（表）の人へ入れる
    const isBack = p => p.type === "裏面" || p.type === "その他" || !p.type;
    // 1回目：申込書で人を作る（2枚続きの申込書は同じ人）。申込書の裏面ははさまっていてもよい
    let prev = null;
    for (const p of pages) {
      if (isBack(p)) continue;
      if (p.type !== "申込書") { prev = null; continue; }
      const same = prev && (!p.names.length || p.names.some(a => prev.names.some(b => sim(a, b) >= 0.8)));
      if (same) { join(p, prev); prev.names.push(...p.names); continue; }
      prev = { key: p.key, names: [...p.names], code: code(p.code), app: true }; people.push(prev); join(p, prev);
    }
    // 2回目：氏名で決まるページ
    const rest = [];
    for (const p of pages) {
      if (gid[p.key] || isBack(p)) continue;
      const g = p.names.length ? (best(p.names) || sameNameNearest(p)) : null;
      if (g) join(p, g); else rest.push(p);
    }
    // 3回目：残り（氏名が読めない・合わない）→ 職員番号 → 薬の組み合わせ → 直前のページの人
    for (const p of rest) {
      const c = code(p.code);
      let g = p.names.length ? best(p.names) : null;   // 申込書の無い人（前のページで作られた人）とも氏名で照合する
      let byCode = false;
      if (!g && c.length >= 4) {
        let hit = people.filter(x => x.code === c);
        // 職員番号が完全に一致：家族の書類（療養者と申込者の氏名が違う）や改姓でも同じ申込みとみなす
        if (hit.length === 1) byCode = true;
        if (!hit.length) hit = people.filter(x => x.code && x.code.length === c.length && [...c].filter((ch, k) => ch !== x.code[k]).length <= 2);   // OCRで1〜2桁の読み違い
        if (hit.length === 1) g = hit[0];
      }
      if (!g && (p.drugs || []).length) {
        const sc = people.map(x => { const D = x.drugs || new Set(); const n = p.drugs.filter(d => D.has(d)).length; return [x, n / Math.max(p.drugs.length, D.size || 1)]; })
          .filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]);
        if (sc.length && (sc.length === 1 || sc[0][1] - sc[1][1] >= 0.2)) g = sc[0][0];
      }
      // 2部綴じ：同じ種類の書類が続いたら（裏面・白紙は飛ばして）同じ人の2部目とみなす（氏名がはっきり違うときは除く）
      if (!g) {
        const i = pages.indexOf(p), prevFront = [...pages.slice(0, i)].reverse().find(q => !isBack(q) && gid[q.key]);
        if (prevFront && prevFront.type === p.type) {
          const pg = people.find(x => x.key === gid[prevFront.key]);
          const nameOk = !p.names.length || !prevFront.names.length || Math.max(...p.names.flatMap(a => prevFront.names.map(b => sim(a, b)))) >= 0.5;
          if (pg && nameOk) g = pg;
        }
      }
      // 直前の書類の人と、処方が同じで姓の1文字目も同じ（氏名の読み崩れで、姓の1文字目だけ合う）なら、その人の書類とみなす
      let byAdj = false;
      if (g && (p.drugs || []).length) {
        const i = pages.indexOf(p), prevFront = [...pages.slice(0, i)].reverse().find(q => !isBack(q) && gid[q.key]);
        if (prevFront && gid[prevFront.key] === g.key && !pages.some(q => gid[q.key] === g.key && q.type === p.type)
          && p.names.some(a => g.names.some(b => a[0] && a[0] === b[0]))) byAdj = true;
      }
      // 読めた氏名が、その人の申込書の氏名とはっきり違う（近さ0.5未満）なら、職員番号・処方・近さだけでは同じ人にしない
      const solid = p.names.filter(n => n.length >= 3);
      if (g && !byCode && !byAdj && solid.length && g.names.length && Math.max(...solid.flatMap(a => g.names.map(b => sim(a, b)))) < 0.5) g = null;
      if (g && p.names.length && !(g.names.length && Math.max(...p.names.map(a => sim(a, g.names[0]))) >= 0.6))
        (warn[g.key] ||= []).push(`${p.type}の氏名「${p.names[0]}」が申込書の氏名と一致しません（職員番号・処方で同じ人と判断。OCRの読み違いか、別の人の書類の可能性）。`);
      if (!g) {
        // スキャン順で一番近く、まだこの種類の書類が無い人へ（直前の人を優先）。どの人にもあれば、申込書の無い人として分ける
        const i = pages.indexOf(p), lacks = x => !pages.some(q => gid[q.key] === x.key && q.type === p.type);
        const dist = x => Math.min(...pages.map((q, j) => gid[q.key] === x.key ? (j < i ? i - j : (j - i) + 0.5) : Infinity));
        const solid2 = p.names.filter(n => n.length >= 3);
        const cand = people.filter(lacks).filter(x => !(solid2.length && x.names.length && Math.max(...solid2.flatMap(a => x.names.map(b => sim(a, b)))) < 0.5)).sort((a, b) => dist(a) - dist(b))[0];
        if (cand && dist(cand) < Infinity) {
          g = cand;
          if (p.names.length) (warn[g.key] ||= []).push(`${p.type}の氏名「${p.names[0]}」が申込書の氏名と一致しません（OCRの読み違いか、別の人の書類の可能性）。`);
        } else {
          g = { key: p.key, names: [...p.names], app: false }; people.push(g);
          if (people.length > 1) (warn[g.key] ||= []).push("この人の申込書が見つかりません（氏名・職員番号で照合）。スキャン漏れか、読み違いの可能性があります。");
        }
      }
      if (byCode && g) g.names.push(...p.names.filter(n => n.length >= 3));   // 家族・改姓：以降のページはこの氏名でも照合する
      join(p, g);
    }
    pages.forEach((p, i) => {
      if (!isBack(p)) return;
      const front = [...pages.slice(0, i)].reverse().find(q => !isBack(q) && gid[q.key]) || pages.slice(i + 1).find(q => gid[q.key]);
      if (front) gid[p.key] = gid[front.key];
      else { people.push({ key: p.key, names: [], app: false }); gid[p.key] = p.key; }
    });
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
  // OCRの作業役（ワーカー）を、PCのCPUの数に合わせて複数（最大4）用意し、ページを並行して読む
  const poolSize = () => Math.max(1, Math.min(4, ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2) - 1));
  let poolP = null; const idle = [], waiting = [];
  function startPool(onLog) {
    poolP ||= (async () => {
      if (location.protocol === "file:") throw new Error("OCRはWeb版（https://ysk713.github.io/-/kousou/）で使えます。保存したHTMLファイルからは使えません");
      const base = new URL("../geppou/lib/tesseract/", location.href).href;
      if (!root.Tesseract) await loadScript(base + "tesseract.min.js");
      const r = await fetch(base + "lang/jpn.traineddata.gz").catch(e => { throw new Error("日本語の学習データを読み込めません（" + e.message + "）"); });
      if (!r.ok) throw new Error(`日本語の学習データを読み込めません（${r.status}）`);
      const opts = blob => ({ workerPath: base + "worker.min.js", corePath: base, langPath: base + "lang", gzip: true, workerBlobURL: blob,
        cacheMethod: "none", logger: m => onLog && onLog(m), errorHandler: e => console.warn("ocr", e) });
      const make = async () => {
        try { return await withTimeout(root.Tesseract.createWorker("jpn", 1, opts(true)), 90000, "OCRの準備が90秒で終わりませんでした"); }
        catch (e) { console.warn("ocr worker (blob)", e); return await withTimeout(root.Tesseract.createWorker("jpn", 1, opts(false)), 90000, "OCRの準備が90秒で終わりませんでした"); }
      };
      const first = await make(); idle.push(first);   // 1つ目ができたらすぐ使い始め、残りは後から加える
      for (let k = 1; k < poolSize(); k++) make().then(release).catch(e => console.warn("ocr worker (追加分)", e));
      return true;
    })().catch(e => { poolP = null; throw e; });
    return poolP;
  }
  async function acquire(onLog) {
    await startPool(onLog);
    return idle.length ? idle.pop() : new Promise(ok => waiting.push(ok));
  }
  function release(w) { const next = waiting.shift(); if (next) next(w); else idle.push(w); }
  // 並行して読める数（ページの並行処理の上限に使う）
  const parallel = () => poolSize();
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
    const w = await acquire(onLog);
    try { return await recognize1(w, canvas, opts); } finally { release(w); }
  }
  async function recognize1(w, canvas, opts) {
    const bw = opts.bin === "none" ? canvas : binarize(canvas); bw.__src = canvas;
    let best = { deg: 0, conf: -1 };
    const side = isSideways(bw), cands = side ? [90, 270] : [0, 180];   // 文字の行が縦に並んでいれば横向きのスキャン
    // 縦向き（ふつう）のページは、向きの下読みをせずに本番の読み取りをする（時間の短縮）。よく読めなかったときだけ下読みで向きを探す
    if (!side && opts.fast !== false) {
      const r0 = await quick(w, bw, opts);
      if (r0) return r0;
    }
    for (const deg of cands) {
      const { data } = await withTimeout(w.recognize(rotate(bw, deg, 1100)), 60000, "向きの判定が60秒で終わりませんでした");
      if (data.confidence > best.conf) best = { deg, conf: data.confidence };
      if (data.confidence >= 75) break;   // よく読めていれば、もう一方の向きは試さない
    }
    if (best.conf < 40) for (const deg of [0, 90, 180, 270].filter(d => !cands.includes(d))) {   // 縦横の判定が外れたとき（小さく印刷された用紙が横向きに入っている等）
      const { data } = await withTimeout(w.recognize(rotate(bw, deg, 1100)), 60000, "向きの判定が60秒で終わりませんでした");
      if (data.confidence > best.conf) best = { deg, conf: data.confidence };
    }
    return finish(w, canvas, bw, best, opts);
  }
  // 0°のまま本番の読み取り。信頼度が十分（60以上）ならそれを使う
  async function quick(w, bw, opts) {
    const r = await finish(w, null, bw, { deg: 0 }, Object.assign({}, opts, { noRetry: true }));
    return r.confidence >= 60 ? r : null;
  }
  async function finish(w, canvas, bw, best, opts) {
    canvas = canvas || bw.__src;
    let img = best.deg ? rotate(bw, best.deg) : bw;
    if (opts.lines !== false && opts.bin !== "none") img = removeLines(img === bw ? rotate(bw, 0) : img);
    const OUT = { text: true, blocks: true };
    let { data } = await withTimeout(w.recognize(img, {}, OUT), 180000, "読み取りが3分で終わりませんでした");
    let srcImg = img;
    if (data.confidence < 60 && opts.bin !== "none" && !opts.noRetry) {   // 粗い・ぼけたスキャンは白黒化しない方が読めることがある
      const raw = best.deg ? rotate(canvas, best.deg) : canvas;
      const r2 = (await withTimeout(w.recognize(raw, {}, OUT), 180000, "読み取りが3分で終わりませんでした")).data;
      if (r2.confidence > data.confidence) { data = r2; srcImg = raw; }
    }
    let text = data.text;
    try { text = await rereadDates(w, data, best.deg ? rotate(canvas, best.deg) : canvas, srcImg, text); } catch (e) { console.warn("reread", e); }
    return { text: clean(text), confidence: Math.round(data.confidence), rotation: best.deg };
  }
  // 日付の行の読み直し：申込書の「申込日付」欄は色付きの背景で、白黒化すると数字が欠けやすい（「10月28日」→「1月8日」）。
  // その行だけを切り出し、白黒化せず3倍に拡大してもう一度読む。年・月・日がそろって読めたら、その行を置き換える
  async function rereadDates(w, data, raw, used, text) {
    const lines = [];
    for (const b of data.blocks || []) for (const pa of b.paragraphs || []) for (const l of pa.lines || []) lines.push(l);
    const kx = raw.width / used.width, ky = raw.height / used.height;
    // 年・月・日がそろい、月が1〜12・日が1〜31のときだけ「読めた」とする（「10月0日」「19月19上」は読めていない）
    const digitsOf = s => { const m = clean(s).replace(/\s+/g, "").match(/(20\d\d|令和\d{1,2})年(\d{1,2})月(\d{1,2})日/); return m ? m[1] + m[2] + m[3] : ""; };
    const full = s => { const m = clean(s).replace(/\s+/g, "").match(/(20\d\d|令和\d{1,2})年(\d{1,2})月(\d{1,2})日/); return !!m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31; };
    for (const l of lines.filter(l => /申込日|日付/.test(l.text.replace(/\s+/g, "")) && /年/.test(l.text)).slice(0, 2)) {
      // 日付の部分（「20」や「年」を含む語から行末まで）だけを切り出す
      const ws = l.words || [], k0 = ws.findIndex(x => /20\d|年|令和/.test(x.text));
      const bb = k0 >= 0 ? ws.slice(Math.max(0, k0 - 1)).reduce((a, x) => ({ x0: Math.min(a.x0, x.bbox.x0), y0: Math.min(a.y0, x.bbox.y0), x1: Math.max(a.x1, x.bbox.x1), y1: Math.max(a.y1, x.bbox.y1) }), { x0: 1e9, y0: 1e9, x1: 0, y1: 0 }) : l.bbox;
      const pad = Math.round((bb.y1 - bb.y0) * 0.5);
      const sx = Math.max(0, Math.round(bb.x0 * kx) - pad), sy = Math.max(0, Math.round(bb.y0 * ky) - pad);
      const sw = Math.min(raw.width - sx, Math.round((bb.x1 - bb.x0) * kx) + 2 * pad), sh = Math.min(raw.height - sy, Math.round((bb.y1 - bb.y0) * ky) + 2 * pad);
      if (sw < 20 || sh < 10) continue;
      const old = l.text.replace(/\n/g, "");
      const cands = full(old) ? [{ t: null, conf: l.confidence, ds: digitsOf(old) }] : [];
      // 行全体（灰色のまま）、日付の部分を赤の成分で（色付きの背景はほぼ白になり、黒い数字が残る）、日付の部分を灰色のままで、の3通り
      const lb = l.bbox, lp = Math.round((lb.y1 - lb.y0) * 0.4);
      const boxes = [["gray", Math.max(0, Math.round(lb.x0 * kx) - lp), Math.max(0, Math.round(lb.y0 * ky) - lp), Math.round((lb.x1 - lb.x0) * kx) + 2 * lp, Math.round((lb.y1 - lb.y0) * ky) + 2 * lp], ["red", sx, sy, sw, sh], ["gray", sx, sy, sw, sh]];
      for (const [mode, bx, by, bw0, bh0] of boxes) {
        const bw = Math.min(raw.width - bx, bw0), bh = Math.min(raw.height - by, bh0); if (bw < 20 || bh < 10) continue;
        const c = document.createElement("canvas"); c.width = bw * 3; c.height = bh * 3;
        const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(raw, bx, by, bw, bh, 0, 0, c.width, c.height);
        if (mode === "red") { const im = x.getImageData(0, 0, c.width, c.height), d = im.data; for (let q = 0; q < d.length; q += 4) { const v = d[q] > 150 ? 255 : d[q] < 90 ? 0 : d[q]; d[q] = d[q + 1] = d[q + 2] = v; } x.putImageData(im, 0, 0); }
        const r = (await withTimeout(w.recognize(c), 30000, "日付の読み直しが30秒で終わりませんでした")).data;
        const t = (r.text || "").replace(/\n/g, " ").trim();
        if (full(t)) cands.push({ t, conf: r.confidence, ds: digitsOf(t) });
      }
      // 読み違いは数字が「抜ける」ことが多い（10月28日→10月8日）。数字を一番多く読めた候補を採り、同じなら確からしさで
      const best = cands.sort((a, b) => b.ds.length - a.ds.length || b.conf - a.conf)[0] || {};
      const dm = best.t && clean(best.t).replace(/\s+/g, "").match(/(20\d\d|令和\d{1,2})年(\d{1,2})月(\d{1,2})日/);
      if (dm) {   // 行の中の見出し（申込日付）の後ろを、読み直した日付だけにする
        const fixed = old.replace(/(申込日付?|[申中]込日付|日付)[\s\S]*$/, "$1") + " " + dm[0];
        text = text.includes(old) ? text.replace(old, fixed) : text + "\n" + fixed;
      }
    }
    return text;
  }


  const api = { parallel, missionCode, consentInfo, fixDays, setVocab, snap, seqSim, consensusName, docTypeOf, pageNames, assignByName, clean, findDates, dateAfter, valueAfter, staffCode, missionName, diseases, dailyUnits, extract, extractDrugs, recognize };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KousouOCR = api;
})(typeof window !== "undefined" ? window : globalThis);
