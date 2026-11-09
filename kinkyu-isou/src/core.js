/* 緊急移送症例登録 取りまとめ ― 読み取り・チェック・集計・書き出しの中身（画面に依存しない部分）
 * ブラウザでは window.KinkyuCore、テストでは module.exports として使う。XLSX（SheetJS）が必要。 */
(function (root) {
  'use strict';

  // ---------- 登録フォームの項目 ----------
  // col: 集計表（Summary シート）の列。src: 登録フォーム（Default シート）で利用者が入力するセル。
  // フォームの3行目（AQ3〜DW3）には各項目が数式・コントロールのリンクで集まっているので、
  // 入力セルを優先して読み、空なら3行目の値を使う。
  const METHODS = ['自力', '救急車', '商用機', 'エアアンビュランス', 'その他', '不明'];
  const R = {
    confirm: ['実施', '中止', '不明'],
    involve: ['伝聞', '診療に立ち会い', '間接的に移送を支援', '主導的に移送をアレンジ'],
    sex: ['男', '女', '不明'],
    kubun: ['館員', '館員家族', '邦人旅行者', '現地職員（日本人）', '専門調査員', '派遣員', '在留邦人', 'その他'],
    method: METHODS,
    tenki: ['軽快', '不変', '死亡', '不明'],
    inout: ['内因性', '外因性', '不明'],
  };
  const NAIIN = ['呼吸器系', '循環器系', '消化器系', '神経系', '内分泌系', '腎尿路系', '血液造血器系', 'アレルギー膠原病系', '栄養・代謝系', '運動器系', '男性生殖器系', '小児科', '産婦人科', '眼科', '耳鼻咽喉科', '皮膚科', '精神科', '歯科', '腫瘍科', '感染症科', 'その他の内因'];
  const GAIIN = ['頭部・顔面外傷', '頸部外傷', '胸部外傷', '腹部外傷', '脊椎・骨盤外傷', '四肢外傷', '熱傷・凍傷', '中毒', '熱中症などの環境要因', 'その他の外因'];

  const F = [];
  function f(key, col, label, src, type, opts) { F.push({ key, col, label, src, type: type || 'text', opts }); }
  f('no', 'AQ', '症例番号', 'AB4', 'num');
  f('repPost', 'AR', '報告医務官 所属', 'E9');
  f('repName', 'AS', '報告医務官 氏名', 'Q9');
  f('repY', 'AT', '報告年', 'AE9', 'num');
  f('repM', 'AU', '報告月', 'AH9', 'num');
  f('repD', 'AV', '報告日', 'AJ9', 'num');
  f('chgPost', 'AW', '担当医務官 所属', 'E13');
  f('chgName', 'AX', '担当医務官 氏名', 'Q13');
  f('confirm', 'AY', '緊急移送の確認', null, 'radio', R.confirm);
  f('involve', 'AZ', '医務官の関与', null, 'radio', R.involve);
  f('occY', 'BA', '発生年', 'H19', 'num');
  f('occM', 'BB', '発生月', 'K19', 'num');
  f('occD', 'BC', '発生日', 'M19', 'num');
  f('occCity', 'BD', '発生都市（地域）', 'V19');
  f('occCountry', 'BE', '発生国', 'AH19');
  f('iniSei', 'BF', 'イニシャル（姓）', 'G21');
  f('iniMei', 'BG', 'イニシャル（名）', 'I21');
  f('ageY', 'BH', '年齢（歳）', 'O21', 'num');
  f('ageM', 'BI', '年齢（か月）', 'R21', 'num');
  f('sex', 'BJ', '性別', null, 'radio', R.sex);
  f('kubun', 'BK', '症例区分', null, 'radio', R.kubun);
  const LEGS = [
    { n: 0, name: '初診場所', cols: ['BL', 'BM', 'BN', 'BO', 'BP'], row: 25 },
    { n: 1, name: '移送先1', cols: ['BQ', 'BR', 'BS', 'BT', 'BU'], row: 29 },
    { n: 2, name: '移送先2', cols: ['BV', 'BW', 'BX', 'BY', 'BZ'], row: 33 },
    { n: 3, name: '移送先3', cols: ['CA', 'CB', 'CC', 'CD', 'CE'], row: 37 },
  ];
  LEGS.forEach(l => {
    const r = l.row;
    f('m' + l.n, l.cols[0], l.name + 'への移送方法', null, 'radio', METHODS);
    f('mo' + l.n, l.cols[1], l.name + 'への移送方法（その他の内容）', 'AD' + r);
    f('h' + l.n, l.cols[2], l.name + '（医療機関）', 'D' + (r + 2));
    f('c' + l.n, l.cols[3], l.name + '（都市・地域）', 'V' + (r + 2));
    f('k' + l.n, l.cols[4], l.name + '（国）', 'AH' + (r + 2));
  });
  f('outY', 'CF', '転帰年', 'F41', 'num');
  f('outM', 'CG', '転帰月', 'I41', 'num');
  f('outD', 'CH', '転帰日', 'K41', 'num');
  f('tenki', 'CI', '転帰', null, 'radio', R.tenki);
  f('tenkiDetail', 'CJ', '転帰の詳細', 'E43');
  f('diag', 'CK', '診断', 'C45');
  f('inout', 'CL', '内因性・外因性', null, 'radio', R.inout);
  const CHECK_COLS = colRange('CM', 'DQ');
  NAIIN.concat(GAIIN).forEach((name, i) => f('x' + i, CHECK_COLS[i], name, null, 'check'));
  f('keyword', 'DR', 'キーワード', 'E60');
  f('logi', 'DS', 'ロジスティックな問題点', 'E62');
  f('summary', 'DT', '要約', 'E66');
  f('content', 'DU', '内容', 'A72');
  f('imgFind', 'DV', '画像所見', 'E216');
  f('img', 'DW', '画像', 'Z216');
  const FK = {}; F.forEach(x => { FK[x.key] = x; });

  // 集計表（Summary シート）の見出し。福利厚生室の集計表と同じ並び・同じ文言にする。
  const SUMMARY_R1 = { AR: '1. 報告医務官情報', AW: '2. 担当医務官情報', BA: '3. 症例情報', BL: '移送方法（Default 0, 自力1, 医療搬送会社関与（救急車2, 商用機3, エアーアンビュランス4), その他5, 不明6）　：　移送その他と場所と地域と国　（Default 0)', CM: '病因　(Default False, 選択　True)（複数選択あり。）', DV: '画像情報' };
  const SUMMARY_R2 = { AQ: '症例番号(Default 0)', AR: '報告医務官所属(Default 0)', AS: '報告医務官(Default 0)', AT: '報告年(Default 0)', AU: '報告月(Default 0)', AV: '報告日(Default 0)', AW: '担当医務官所属(Default 0)', AX: '担当医務官(Default 0)', AY: '緊急移送の確認　(Default 0, 実施 1, 中止2, 不明3)', AZ: '医務官関与(Default 0, 伝聞 1, 立ち会い 2, 間接的 3, 主導的 4)', BA: '症例発生年(Default 0)', BB: '症例発生月(Default 0)', BC: '症例発生日(Default 0)', BD: '症例発生場所(Default 0)', BE: '症例発生国(Default 0)', BF: '症例イニシャル（姓）(Default 0)', BG: '症例イニシャル（名）(Default 0)', BH: '症例年齢（歳）(Default 0)', BI: '症例年齢（ヶ月）(Default 0)', BJ: '性別(Default 0, 男1, 女2, 不明3)', BK: '症例区分(Default 0, 館員1, 家族2, 旅行者3, 現地職員（日本人）4, 専門調査員5, 派遣員6, 在留邦人7, その他8)', BL: '初診場所への移送方法(Default 0)', BM: '初診場所への移送方法その他(Default 0)', BN: '初診場所(Default 0)', BO: '初診場所地域(Default 0)', BP: '初診場所国(Default 0)', BQ: '移送先１への移送方法(Default 0)', BR: '移送先1への移送方法その他(Default 0)', BS: '移送先１(Default 0)', BT: '移送先１地域(Default 0)', BU: '移送先１国(Default 0)', BV: '移送先2への移送方法(Default 0)', BW: '移送先2への移送方法その他(Default 0)', BX: '移送先2(Default 0)', BY: '移送先2地域(Default 0)', BZ: '移送先2国(Default 0)', CA: '移送先3への移送方法(Default 0)', CB: '移送先3への移送方法その他(Default 0)', CC: '移送先3(Default 0)', CD: '移送先3地域(Default 0)', CE: '移送先3国(Default 0)', CF: '転帰年(Default 0)', CG: '転帰月(Default 0)', CH: '転帰日(Default 0)', CI: '転帰(Default 0, 軽快1, 不変2, 死亡3, 不明4)', CJ: '転帰詳細(Default 0)', CK: '診断(Default 0)', CL: '内因性・外因性の区分(Default 0, 内因性1, 外因性2,　不明3)', DR: 'キーワード(Default 0)', DS: 'ロジスティック(Default 0)', DT: '要約(Default 0)', DU: '内容(Default 0)', DV: '画像所見(Default 0)', DW: '画像(Default 0)' };
  ['呼吸器系', '循環器系', '消化器系', '神経系', '内分泌系', '腎尿路系', '血液造血器系', 'アレルギー膠原病系', '栄養代謝系', '運動器系', '男性生殖器系', '小児科', '産婦人科', '眼科', '耳鼻咽喉科', '皮膚科', '精神科', '歯科', '腫瘍科', '感染症科', 'その他の内因', '頭部・顔面外傷', '頸部外傷', '胸部外傷', '腹部外傷', '脊椎・骨盤外傷', '四肢外傷', '熱傷・凍傷', '中毒', '熱中症などの環境要因', 'その他の外因']
    .forEach((n, i) => { SUMMARY_R2[CHECK_COLS[i]] = n + '(Default 0)'; });

  // 「内容」欄にはじめから入っている見出しだけの文（これだけなら空欄とみなす）
  // 緊急移送症例登録はこの年から（登録フォームは2018年作成）。報告年がこれより前なら入力間違いの可能性が高い
  // （症例の発生年は、さかのぼって登録された古い症例があるので、これより前でもかまわない）
  const FIRST_YEAR = 2018;
  const CONTENT_TEMPLATE = '①症例経過 \n\n②よかった点\n\n③反省点  \n\n④今後の改善のための提言・まとめ\n';

  // ---------- 小道具 ----------
  function colNum(c) { let n = 0; for (const ch of c) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
  function colName(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function colRange(a, b) { const out = []; for (let i = colNum(a); i <= colNum(b); i++) out.push(colName(i)); return out; }
  function z2h(s) { return String(s).replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' '); }
  function cleanText(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return '';
    let s = String(v).replace(/\r\n?/g, '\n').replace(/[ \t　]+$/gm, '').trim();
    if (s === '0' || s === '#REF!' || s === '#N/A') return '';
    return s;
  }
  function toNum(v) {
    if (v === undefined || v === null || v === '' || typeof v === 'boolean') return null;
    if (v instanceof Date) return null;
    const s = z2h(String(v)).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return n === 0 ? null : n;
  }
  function toBool(v) {
    if (v === true) return true;
    if (typeof v === 'number') return v !== 0;
    const s = String(v == null ? '' : v).trim().toUpperCase();
    return s === 'TRUE' || s === '1' || s === 'ON';
  }
  function cellVal(ws, addr) {
    const c = ws && ws[addr];
    if (!c) return undefined;
    if (c.v !== undefined) return c.v;
    return undefined;
  }
  const pad2 = n => String(n).padStart(2, '0');
  function ymd(y, m, d) {
    if (!y || !m || !d) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return { bad: true, s: y + '-' + m + '-' + d };
    return { bad: false, s: y + '-' + pad2(m) + '-' + pad2(d), t: dt.getTime() };
  }

  // 値を「中身」に直す（ラジオは 1,2,3… の番号、チェックは true/false、文字・数字はそのまま）
  function normalize(field, raw) {
    if (field.type === 'radio') {
      const n = toNum(raw);
      return n && n >= 1 && n <= field.opts.length ? Math.round(n) : 0;
    }
    if (field.type === 'check') return toBool(raw);
    if (field.type === 'num') return toNum(raw);
    let s = cleanText(raw);
    if (field.key === 'content' && s.replace(/\s+/g, '') === CONTENT_TEMPLATE.replace(/\s+/g, '')) s = '';
    if (field.key === 'iniSei' || field.key === 'iniMei') s = z2h(s).replace(/[.．。\s]/g, '').toUpperCase();
    return s;
  }

  // ---------- ファイルから読む ----------
  // 登録フォームの形のシートをすべて返す（空のひな形「Default」と記入済みの「症例１」が同じブックにあることがある）
  function findFormSheets(wb) {
    const out = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const t = cleanText(cellVal(ws, 'A4'));
      if (t.indexOf('緊急移送症例登録フォーム') >= 0) out.push({ name, ws });
    }
    return out;
  }
  function findTableSheets(wb) {
    const out = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const h = cleanText(cellVal(ws, 'AQ2'));
      if (h.indexOf('症例番号') === 0 && cleanText(cellVal(ws, 'CK2')).indexOf('診断') === 0) out.push({ name, ws });
    }
    return out;
  }
  function emptyCase() {
    const c = {};
    F.forEach(x => { c[x.key] = x.type === 'check' ? false : x.type === 'radio' ? 0 : x.type === 'num' ? null : ''; });
    return c;
  }
  function caseFromForm(ws) {
    const c = emptyCase();
    F.forEach(x => {
      let raw;
      // 3行目の数式（例：=+H19）が指しているセルを読む。フォームに行が足されて位置がずれていても、数式が正しいセルを指している
      let src = x.src;
      const f3 = ws[x.col + '3'] && ws[x.col + '3'].f;
      const m = f3 && String(f3).replace(/^=/, '').match(/^\+?\$?([A-Z]{1,3})\$?(\d{1,4})$/);
      if (m) src = m[1] + m[2];
      if (src) raw = cellVal(ws, src);
      let v = normalize(x, raw);
      const blank = v === '' || v === null || v === 0 || v === false;
      if (blank) v = normalize(x, cellVal(ws, x.col + '3'));
      c[x.key] = v;
    });
    return c;
  }
  function caseFromRow(ws, r) {
    const c = emptyCase();
    F.forEach(x => { c[x.key] = normalize(x, cellVal(ws, x.col + r)); });
    return c;
  }
  function isBlankCase(c) {
    return F.every(x => { const v = c[x.key]; return v === '' || v === null || v === 0 || v === false; });
  }
  function lastRow(ws) {
    if (!ws['!ref']) return 0;
    return XLSX().utils.decode_range(ws['!ref']).e.r + 1;
  }
  function XLSX() { return root.XLSX || (typeof require === 'function' ? require('xlsx') : null); }

  // ファイル名の先頭の数字を症例番号とみなす（例：0031_PapuaNewGuinea_20190326.xlsx → 31）
  function noFromFileName(fileName) {
    const base = String(fileName || '').split(/[\\/]/).pop();
    const m = z2h(base).match(/^\s*(\d{1,6})(?=[_\-\s.（(]|$)/);
    const n = m ? parseInt(m[1], 10) : 0;
    return n > 0 ? n : null;
  }

  /* ブック1冊を読む。戻り値 { kind: 'form'|'table'|'none', cases: [...] } */
  function readWorkbook(wb, fileName) {
    const forms = findFormSheets(wb);
    if (forms.length) {
      const cases = [];
      forms.forEach(fm => {
        const c = caseFromForm(fm.ws);
        if (isBlankCase(c)) return;
        cases.push(c);
        c.sheet = fm.name;
      });
      cases.forEach(c => { c.source = cases.length > 1 ? fileName + '（' + c.sheet + '）' : fileName; delete c.sheet; });
      if (!cases.length) return { kind: 'form', cases: [], blank: true };
      const fileNo = noFromFileName(fileName);
      if (fileNo) cases.forEach(c => { if (c.no && c.no !== fileNo) c.noForm = c.no; c.no = fileNo; });
      return { kind: 'form', cases };
    }
    const tables = findTableSheets(wb);
    if (tables.length) {
      const cases = [];
      tables.forEach(t => {
        const last = lastRow(t.ws);
        for (let r = 3; r <= last; r++) {
          const c = caseFromRow(t.ws, r);
          if (isBlankCase(c)) continue;
          c.source = fileName + '（' + t.name + ' ' + r + '行目）';
          cases.push(c);
        }
      });
      return { kind: 'table', cases };
    }
    return { kind: 'none', cases: [] };
  }

  // ---------- 表示用 ----------
  function label(c, key) {
    const x = FK[key];
    const v = c[key];
    if (x.type === 'radio') return v ? x.opts[v - 1] : '';
    if (x.type === 'check') return v ? '✓' : '';
    if (v === null || v === undefined) return '';
    return String(v);
  }
  function occDate(c) { const d = ymd(c.occY, c.occM, c.occD); return d ? d.s : (c.occY ? c.occY + '年' + (c.occM ? c.occM + '月' : '') : ''); }
  function repDate(c) { const d = ymd(c.repY, c.repM, c.repD); return d ? d.s : ''; }
  function outDate(c) { const d = ymd(c.outY, c.outM, c.outD); return d ? d.s : ''; }
  function initials(c) { return [c.iniSei, c.iniMei].filter(Boolean).join('.') + (c.iniSei || c.iniMei ? '.' : ''); }
  function ageText(c) {
    if (c.ageY) return c.ageY + '歳' + (c.ageM ? c.ageM + 'か月' : '');
    if (c.ageM) return c.ageM + 'か月';
    return '';
  }
  function naiinList(c) { return NAIIN.filter((n, i) => c['x' + i]); }
  function gaiinList(c) { return GAIIN.filter((n, i) => c['x' + (NAIIN.length + i)]); }
  function legs(c) {
    return LEGS.map(l => ({
      name: l.name,
      method: c['m' + l.n] ? METHODS[c['m' + l.n] - 1] + (c['m' + l.n] === 5 && c['mo' + l.n] ? '（' + c['mo' + l.n] + '）' : '') : '',
      methodNo: c['m' + l.n],
      hosp: c['h' + l.n], city: c['c' + l.n], country: c['k' + l.n],
    })).filter((l, i) => i === 0 || l.methodNo || l.hosp || l.city || l.country);
  }
  function finalDest(c) {
    for (let n = 3; n >= 1; n--) if (c['h' + n] || c['c' + n] || c['k' + n]) return { n, hosp: c['h' + n], city: c['c' + n], country: c['k' + n], method: c['m' + n] };
    return null;
  }
  function routeText(c) {
    const parts = [];
    const p0 = [c.c0, c.k0].filter(Boolean).join('・');
    if (p0) parts.push(p0);
    for (let n = 1; n <= 3; n++) {
      const p = [c['c' + n], c['k' + n]].filter(Boolean).join('・') || c['h' + n];
      if (p) parts.push((c['m' + n] ? '〔' + METHODS[c['m' + n] - 1] + '〕' : '') + p);
    }
    return parts.join(' → ');
  }

  // ---------- チェック ----------
  // level: 'err'＝入力漏れ・明らかな誤り、'chk'＝確かめてほしい点
  function checkCase(c, all, today) {
    const out = [];
    const add = (level, msg) => out.push({ level, msg });
    today = today || new Date();
    const need = [['repPost', '報告医務官の所属'], ['repName', '報告医務官の氏名'], ['occCountry', '症例発生国'], ['diag', '診断'], ['summary', '要約']];
    need.forEach(([k, n]) => { if (!c[k]) add('err', n + 'が空欄です'); });
    [['confirm', '緊急移送の確認（実施・中止・不明）'], ['involve', '医務官の関与度合い'], ['sex', '性別'], ['kubun', '症例区分'], ['tenki', '転帰'], ['inout', '内因性・外因性の区分']]
      .forEach(([k, n]) => { if (!c[k]) add('err', n + 'が選ばれていません'); });
    if (!c.iniSei && !c.iniMei) add('err', '症例イニシャルが空欄です');
    if (!c.ageY && !c.ageM) add('chk', '診断時年齢が空欄です（1歳未満なら月齢に入れてください）');

    const dates = [['報告年月日', 'rep', true], ['症例発生年月日', 'occ', true], ['転帰日', 'out', false]];
    const dt = {};
    dates.forEach(([n, p, req]) => {
      const y = c[p + 'Y'], m = c[p + 'M'], d = c[p + 'D'];
      if (!y && !m && !d) { if (req) add('err', n + 'が空欄です'); else if (c.tenki && c.tenki !== 4) add('chk', '転帰日が空欄です'); return; }
      const r = ymd(y, m, d);
      if (!r) { add('err', n + 'の年・月・日のどれかが空欄です'); return; }
      if (r.bad) { add('err', n + 'が日付として正しくありません（' + r.s + '）'); return; }
      if (p === 'rep' && y < FIRST_YEAR) add('chk', '報告年月日が' + y + '年になっています。登録は' + FIRST_YEAR + '年からなので、年の入れ間違いでないか確認してください');
      if (p !== 'rep' && y < 1990) add('chk', n + 'が' + y + '年になっています。古い症例をさかのぼって登録したものか、年の入れ間違いでないか確認してください');
      if (p === 'occ' && c.ageY && Math.abs((c.outY || c.repY || today.getFullYear()) - y - c.ageY) <= 1 && (c.outY || c.repY || today.getFullYear()) - y > 3) add('chk', '症例発生年（' + y + '年）が、年齢（' + c.ageY + '歳）から計算した生まれ年とほぼ同じです。生年月日を入れていないか確認してください');
      if (r.t > today.getTime()) add('err', n + 'が未来の日付です（' + r.s + '）');
      dt[p] = r.t;
    });
    if (dt.occ && dt.out && dt.out < dt.occ) add('err', '転帰日が症例発生日より前になっています');
    if (dt.occ && dt.out && dt.out - dt.occ > 365 * 86400000) add('chk', '症例発生年月日と転帰日が1年以上離れています。生年月日が入っていないか、年の入れ間違いがないか確認してください');
    if (dt.out && dt.rep && dt.out > dt.rep) add('chk', '転帰日（' + outDate(c) + '）が報告年月日（' + repDate(c) + '）より後になっています。年の入れ間違いでないか確認してください（転帰年で数えるため）');
    if (dt.occ && dt.rep && dt.rep < dt.occ) add('err', '報告年月日が症例発生日より前になっています');

    if (c.ageY > 110) add('err', '年齢が大きすぎます（' + c.ageY + '歳）');
    if (c.ageM > 11 && !c.ageY) add('chk', '月齢が12か月以上です（1歳以上なら「歳」に入れてください）');
    [['iniSei', '姓'], ['iniMei', '名']].forEach(([k, n]) => {
      const s = c[k];
      if (s && !/^[A-Z]$/.test(s)) add('chk', 'イニシャル（' + n + '）が「' + s + '」です。アルファベット1文字で入れてください' + (s.length > 2 ? '（名前そのものが入っていないか確認）' : ''));
    });

    const nai = naiinList(c).length, gai = gaiinList(c).length;
    if (c.inout === 1 && !nai) add('chk', '内因性ですが、内因性分類にチェックがありません');
    if (c.inout === 2 && !gai) add('chk', '外因性ですが、外因性分類にチェックがありません');
    if (c.inout === 1 && gai) add('chk', '内因性ですが、外因性分類にもチェックがあります');
    if (c.inout === 2 && nai) add('chk', '外因性ですが、内因性分類にもチェックがあります');

    LEGS.forEach(l => {
      const m = c['m' + l.n], place = c['h' + l.n] || c['c' + l.n] || c['k' + l.n];
      if (m === 5 && !c['mo' + l.n]) add('chk', l.name + 'への移送方法が「その他」ですが、内容が書かれていません');
      if (l.n > 0 && m && !place) add('chk', l.name + 'への移送方法が選ばれていますが、' + l.name + 'の場所が空欄です');
      if (l.n > 0 && place && !m) add('chk', l.name + 'の移送方法が選ばれていません');
      if (place && !c['k' + l.n]) add('chk', l.name + 'の国が空欄です');
    });
    for (let n = 2; n <= 3; n++) {
      const has = k => c['h' + k] || c['c' + k] || c['k' + k];
      if (has(n) && !has(n - 1)) add('chk', '移送先' + n + 'が入っていますが、移送先' + (n - 1) + 'が空欄です');
    }
    if (c.confirm === 1 && !finalDest(c)) add('chk', '緊急移送「実施」ですが、移送先1が空欄です');
    if (!c.h0 && !c.c0 && !c.k0) add('chk', '初診場所が空欄です');

    // 個人を特定できる情報が書かれていないか（登録は個人を特定できない形が前提）
    const free = ['tenkiDetail', 'diag', 'keyword', 'logi', 'summary', 'content', 'imgFind'].map(k => c[k]).join('\n');
    const pii = [];
    if (/[一-龥ぁ-んァ-ヶ]{1,6}(様|さん|氏|くん|ちゃん)(?![a-zA-Z])/.test(free.replace(/(医務官|主治医|担当医|医師|先生|皆|奥|お子|ご家族|家族|患者|本人|母|父|夫|妻|娘|息子)(様|さん|氏)/g, ''))) pii.push('人名');
    if (/旅券番号|パスポート番号|[A-Z]{2}\d{7}/.test(free)) pii.push('旅券番号');
    if (/生年月日|(19|20)\d{2}[年\/.-]\d{1,2}[月\/.-]\d{1,2}日?生/.test(free)) pii.push('生年月日');
    if (/省員番号|職員番号|証券番号|\d{3,4}-\d{3,4}-\d{4}|\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}/.test(free)) pii.push('番号・電話番号');
    if (pii.length) add('chk', '自由記載に個人を特定できる情報（' + pii.join('・') + '）が含まれていないか確認してください');

    if (c.noForm) add('chk', '症例番号はファイル名から ' + c.no + ' としましたが、フォームの症例番号欄には ' + c.noForm + ' と書かれています');
    if (all) {
      const k = dupKey(c);
      if (k && all.some(o => o !== c && dupKey(o) === k)) add('chk', '同じ症例（発生日・発生国・イニシャル・年齢・性別が同じ）がほかにもあります。二重登録でないか確認してください');
      if (c.no && all.some(o => o !== c && o.no === c.no)) add('err', '症例番号 ' + c.no + ' がほかの症例と重なっています');
    }
    return out;
  }
  function dupKey(c) {
    if (!c.occY || !c.occM || !c.occD) return '';
    return [c.occY, c.occM, c.occD, normCountry(c.occCountry), c.iniSei, c.iniMei, c.ageY || 0, c.ageM || 0, c.sex].join('|');
  }
  function normCountry(s) { return z2h(String(s || '')).replace(/\s+/g, '').toLowerCase(); }

  // ---------- 集計 ----------
  function tally(list, fn) {
    const m = new Map();
    list.forEach(c => { [].concat(fn(c)).forEach(k => { if (k === undefined || k === null || k === '') k = '（未記入）'; m.set(k, (m.get(k) || 0) + 1); }); });
    return m;
  }
  function ordered(m, order) {
    const rows = [];
    if (order) order.forEach(k => { if (m.has(k)) rows.push([k, m.get(k)]); });
    const rest = [...m.entries()].filter(([k]) => !order || order.indexOf(k) < 0).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ja'));
    rest.forEach(r => { if (r[0] !== '（未記入）') rows.push(r); });
    if (m.has('（未記入）') && !(order && order.indexOf('（未記入）') >= 0)) rows.push(['（未記入）', m.get('（未記入）')]);
    return rows;
  }
  function ageBand(c) {
    if (!c.ageY && !c.ageM) return '（未記入）';
    if (!c.ageY) return '1歳未満';
    if (c.ageY < 10) return '1〜9歳';
    const b = Math.floor(c.ageY / 10) * 10;
    return b >= 70 ? '70歳以上' : b + '代';
  }
  const AGE_ORDER = ['1歳未満', '1〜9歳', '10代', '20代', '30代', '40代', '50代', '60代', '70歳以上', '（未記入）'];
  function splitKeywords(s) { return String(s || '').split(/[、,，;；\/／\n　 ]+/).map(x => x.trim()).filter(Boolean); }

  function aggregate(list) {
    const lab = k => c => label(c, k);
    const years = tally(list, c => c.occY ? c.occY + '年' : '');
    const yearOrder = [...years.keys()].filter(k => k !== '（未記入）').sort();
    const t = [
      { title: '転帰年（転帰日の年）', rows: (() => { const m = tally(list, c => c.outY ? c.outY + '年' : ''); return ordered(m, [...m.keys()].filter(k => k !== '（未記入）').sort()); })() },
      { title: '報告年（登録した年）', rows: (() => { const m = tally(list, c => c.repY ? c.repY + '年' : ''); return ordered(m, [...m.keys()].filter(k => k !== '（未記入）').sort()); })() },
      { title: '発生年（参考。生年月日の入れ間違いがありうる）', rows: ordered(years, yearOrder) },
      { title: '緊急移送の確認', rows: ordered(tally(list, lab('confirm')), R.confirm) },
      { title: '症例区分', rows: ordered(tally(list, lab('kubun')), R.kubun) },
      { title: '性別', rows: ordered(tally(list, lab('sex')), R.sex) },
      { title: '年齢', rows: ordered(tally(list, ageBand), AGE_ORDER) },
      { title: '転帰', rows: ordered(tally(list, lab('tenki')), R.tenki) },
      { title: '内因性・外因性', rows: ordered(tally(list, lab('inout')), R.inout) },
      { title: '内因性分類（複数選択）', rows: ordered(tally(list, naiinList), NAIIN).filter(r => r[0] !== '（未記入）'), multi: true },
      { title: '外因性分類（複数選択）', rows: ordered(tally(list, gaiinList), GAIIN).filter(r => r[0] !== '（未記入）'), multi: true },
      { title: '医務官の関与', rows: ordered(tally(list, lab('involve')), R.involve) },
      { title: '最後の区間の移送方法', rows: ordered(tally(list.filter(finalDest), c => { const d = finalDest(c); return d.method ? METHODS[d.method - 1] : ''; }), METHODS) },
      { title: '移送方法（全区間・延べ）', rows: ordered(tally(list, c => [1, 2, 3].map(n => c['m' + n]).filter(Boolean).map(m => METHODS[m - 1])), METHODS).filter(r => r[0] !== '（未記入）'), multi: true },
      { title: '発生地域', rows: ordered(tally(list, c => regionOf(c.occCountry)), REGION_ORDER) },
      { title: '発生国', rows: ordered(tally(list, c => c.occCountry)) },
      { title: '最終移送先の国', rows: ordered(tally(list.filter(finalDest), c => finalDest(c).country)) },
      { title: '報告した公館（報告医務官の所属）', rows: ordered(tally(list, c => c.repPost)) },
      { title: 'キーワード', rows: ordered(tally(list, c => splitKeywords(c.keyword))).filter(r => r[0] !== '（未記入）'), multi: true },
    ];
    return { total: list.length, tables: t };
  }

  // ---------- 分析 ----------
  // 国名 → 地域（世界医療情報マップの国名一覧 world-health-map/data/countries.json を使う）
  const REGION_JA = { asia: 'アジア', oceania: '大洋州', middle_east: '中東', africa: 'アフリカ', europe: '欧州', north_america: '北米・中米・カリブ', south_america: '南米' };
  const REGION_ORDER = ['アジア', '大洋州', '中東', 'アフリカ', '欧州', '北米・中米・カリブ', '南米', '（国名から判定できず）'];
  let countryIndex = null;
  function normName(s) { return z2h(String(s || '')).toLowerCase().replace(/[\s・･.,，、()（）「」]/g, ''); }
  function buildCountryIndex() {
    const list = root.KINKYU_COUNTRIES || (typeof require === 'function' ? (() => { try { return require('../../world-health-map/data/countries.json'); } catch (e) { return []; } })() : []);
    const idx = new Map();
    list.forEach(c => {
      const names = [c.ja].concat(c.aliases_ja || [], c.en ? [c.en] : [], c.aliases_en || []);
      names.forEach(n => { const k = normName(n); if (k.length >= 2 && !idx.has(k)) idx.set(k, { ja: c.ja, region: REGION_JA[c.region] || '' }); });
    });
    // よく使う書き方
    [['米', '米国'], ['us', '米国'], ['usa', '米国'], ['uk', '英国'], ['png', 'パプアニューギニア'], ['uae', 'アラブ首長国連邦'], ['南ア', '南アフリカ'], ['豪州', 'オーストラリア'], ['中華人民共和国', '中国'], ['大韓民国', '韓国'], ['日本国', '日本'], ['本邦', '日本']]
      .forEach(([a, b]) => { const t = idx.get(normName(b)); if (t && !idx.has(normName(a))) idx.set(normName(a), t); });
    countryIndex = { idx, keys: [...idx.keys()].sort((a, b) => b.length - a.length) };
  }
  function countryInfo(name) {
    if (!countryIndex) buildCountryIndex();
    let k = normName(name).replace(/^在/, '').replace(/(日本国)?(大使館|総領事館|領事事務所)$/, '');
    if (!k) return null;
    if (countryIndex.idx.has(k)) return countryIndex.idx.get(k);
    const hit = countryIndex.keys.find(x => x.length >= 2 && k.indexOf(x) >= 0);
    return hit ? countryIndex.idx.get(hit) : null;
  }
  function regionOf(name) { if (!name) return ''; const i = countryInfo(name); return i && i.region ? i.region : '（国名から判定できず）'; }
  function isJapan(name) { const i = countryInfo(name); return !!(i && i.ja === '日本'); }
  function destKind(c) {
    const d = finalDest(c);
    if (!d) return c.confirm === 2 ? '移送中止' : '移送先の記入なし';
    if (isJapan(d.country)) return [1, 2, 3].some(n => n < d.n && isJapan(c['k' + n])) ? '日本' : d.n === 1 ? '日本（直接）' : '日本（第三国を経由）';
    return d.country && countryInfo(d.country) && countryInfo(d.country).ja === countryInfo(c.occCountry || '')?.ja ? '国内の別の都市' : '第三国';
  }
  function days(c, a, b) {
    const x = ymd(c[a + 'Y'], c[a + 'M'], c[a + 'D']), y = ymd(c[b + 'Y'], c[b + 'M'], c[b + 'D']);
    if (!x || !y || x.bad || y.bad) return null;
    const d = Math.round((y.t - x.t) / 86400000);
    return d >= 0 ? d : null;
  }

  // 分析に使う切り口（1症例で複数に当てはまるものは配列を返す）
  const VARS = [
    { key: 'outYear', label: '転帰年', fn: c => c.outY ? c.outY + '年' : '', sort: 'asc' },
    { key: 'year', label: '発生年（参考）', fn: c => c.occY ? c.occY + '年' : '', sort: 'asc' },
    { key: 'repYear', label: '報告年（登録した年）', fn: c => c.repY ? c.repY + '年' : '', sort: 'asc' },
    { key: 'region', label: '発生地域', fn: c => regionOf(c.occCountry), order: REGION_ORDER },
    { key: 'country', label: '発生国', fn: c => c.occCountry },
    { key: 'post', label: '報告した公館', fn: c => c.repPost },
    { key: 'kubun', label: '症例区分', fn: c => label(c, 'kubun'), order: R.kubun },
    { key: 'sex', label: '性別', fn: c => label(c, 'sex'), order: R.sex },
    { key: 'age', label: '年齢層', fn: ageBand, order: AGE_ORDER },
    { key: 'confirm', label: '緊急移送の確認', fn: c => label(c, 'confirm'), order: R.confirm },
    { key: 'involve', label: '医務官の関与', fn: c => label(c, 'involve'), order: R.involve },
    { key: 'inout', label: '内因性・外因性', fn: c => label(c, 'inout'), order: R.inout },
    { key: 'cause', label: '病因の分類（複数選択）', fn: c => naiinList(c).concat(gaiinList(c)), order: NAIIN.concat(GAIIN), multi: true },
    { key: 'tenki', label: '転帰', fn: c => label(c, 'tenki'), order: R.tenki },
    { key: 'lastMethod', label: '最後の区間の移送方法', fn: c => { const d = finalDest(c); return d ? (d.method ? METHODS[d.method - 1] : '') : '移送先なし'; }, order: METHODS.concat(['移送先なし']) },
    { key: 'legs', label: '移送の区間数', fn: c => { const d = finalDest(c); return d ? d.n + '区間' : '移送先なし'; }, order: ['1区間', '2区間', '3区間', '移送先なし'] },
    { key: 'dest', label: '最終移送先（日本・第三国）', fn: destKind, order: ['日本（直接）', '日本（第三国を経由）', '日本', '第三国', '国内の別の都市', '移送中止', '移送先の記入なし'] },
    { key: 'destCountry', label: '最終移送先の国', fn: c => { const d = finalDest(c); return d ? d.country : '移送先なし'; } },
    { key: 'destRegion', label: '最終移送先の地域', fn: c => { const d = finalDest(c); return d ? (isJapan(d.country) ? '日本' : regionOf(d.country)) : '移送先なし'; }, order: ['日本'].concat(REGION_ORDER, ['移送先なし']) },
  ];
  const VK = {}; VARS.forEach(v => { VK[v.key] = v; });
  function varValues(v, c) { const r = [].concat(v.fn(c)).filter(x => x !== null && x !== undefined && x !== ''); return r.length ? r : v.multi ? [] : ['（未記入）']; }
  function sortKeys(v, counts) {
    const keys = [...counts.keys()];
    if (v.sort === 'asc') return keys.sort((a, b) => (a === '（未記入）') - (b === '（未記入）') || (a > b ? 1 : -1));
    return ordered(counts, v.order).map(r => r[0]);
  }
  /* クロス集計。cells[i][j] は当てはまる症例の配列 */
  function crossTab(list, rowKey, colKey) {
    const rv = VK[rowKey], cv = VK[colKey];
    const rc = new Map(), cc = new Map(), cell = new Map();
    list.forEach(c => {
      const rs = varValues(rv, c), cs = varValues(cv, c);
      rs.forEach(r => { rc.set(r, (rc.get(r) || 0) + 1); });
      cs.forEach(x => { cc.set(x, (cc.get(x) || 0) + 1); });
      rs.forEach(r => cs.forEach(x => { const k = r + '\u0000' + x; if (!cell.has(k)) cell.set(k, []); cell.get(k).push(c); }));
    });
    const rows = sortKeys(rv, rc), cols = sortKeys(cv, cc);
    const cells = rows.map(r => cols.map(x => cell.get(r + '\u0000' + x) || []));
    const rowCases = rows.map(r => list.filter(c => varValues(rv, c).indexOf(r) >= 0));
    const colCases = cols.map(x => list.filter(c => varValues(cv, c).indexOf(x) >= 0));
    return { rowVar: rv, colVar: cv, rows, cols, cells, rowCases, colCases, total: list.length };
  }

  function summaryStats(nums) {
    const a = nums.filter(n => n !== null && n !== undefined).sort((x, y) => x - y);
    if (!a.length) return { n: 0 };
    const q = p => { const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
    return { n: a.length, median: q(0.5), q1: q(0.25), q3: q(0.75), min: a[0], max: a[a.length - 1], mean: a.reduce((s, x) => s + x, 0) / a.length };
  }
  const DAY_MEASURES = [
    { key: 'toOut', label: '発生から転帰まで（日）', fn: c => { const d = days(c, 'occ', 'out'); return d !== null && d <= 365 ? d : null; } },
    { key: 'outToRep', label: '転帰から報告まで（日）', fn: c => days(c, 'out', 'rep') },
  ];
  /* 日数の分析。groupKey を渡すとその切り口ごと */
  function dayStats(list, groupKey) {
    const groups = [{ name: '全体', cases: list }];
    if (groupKey) {
      const v = VK[groupKey], m = new Map();
      list.forEach(c => varValues(v, c).forEach(k => { if (!m.has(k)) m.set(k, []); m.get(k).push(c); }));
      const counts = new Map([...m.entries()].map(([k, a]) => [k, a.length]));
      sortKeys(v, counts).forEach(k => groups.push({ name: k, cases: m.get(k) }));
    }
    return groups.map(g => ({ name: g.name, n: g.cases.length, stats: DAY_MEASURES.map(d => summaryStats(g.cases.map(d.fn))) }));
  }

  // 主な指標（割合）。分母は「当てはまるかどうか判断できる症例」
  const INDICATORS = [
    { key: 'done', label: '緊急移送を実施した割合', base: c => c.confirm === 1 || c.confirm === 2, hit: c => c.confirm === 1 },
    { key: 'japan', label: '日本へ移送した割合（移送した症例のうち）', base: c => !!finalDest(c), hit: c => isJapan(finalDest(c).country) },
    { key: 'third', label: '第三国の医療機関へ移送した割合（移送した症例のうち）', base: c => !!finalDest(c), hit: c => !isJapan(finalDest(c).country) && destKind(c) === '第三国' },
    { key: 'multi', label: '2区間以上かけて移送した割合（移送した症例のうち）', base: c => !!finalDest(c), hit: c => finalDest(c).n >= 2 },
    { key: 'aa', label: 'エアアンビュランスを使った割合（移送した症例のうち）', base: c => !!finalDest(c), hit: c => [1, 2, 3].some(n => c['m' + n] === 4) },
    { key: 'death', label: '死亡の割合（転帰が分かる症例のうち）', base: c => c.tenki >= 1 && c.tenki <= 3, hit: c => c.tenki === 3 },
    { key: 'ext', label: '外因性（けが・中毒など）の割合', base: c => c.inout === 1 || c.inout === 2, hit: c => c.inout === 2 },
    { key: 'lead', label: '医務官が主導して移送をアレンジした割合', base: c => c.involve > 0, hit: c => c.involve === 4 },
  ];
  function indicators(list, groupKey) {
    const groups = [{ name: '全体', cases: list }];
    if (groupKey) {
      const v = VK[groupKey], m = new Map();
      list.forEach(c => varValues(v, c).forEach(k => { if (!m.has(k)) m.set(k, []); m.get(k).push(c); }));
      const counts = new Map([...m.entries()].map(([k, a]) => [k, a.length]));
      sortKeys(v, counts).forEach(k => groups.push({ name: k, cases: m.get(k) }));
    }
    return { indicators: INDICATORS, groups: groups.map(g => ({ name: g.name, n: g.cases.length, values: INDICATORS.map(ind => { const b = g.cases.filter(ind.base); const h = b.filter(ind.hit); return { hit: h.length, base: b.length, cases: h }; }) })) };
  }

  // 自由記載（ロジスティックな問題点・内容・要約など）から、よく出てくる話題を拾う
  const THEMES = [
    { name: '保険・保険会社', re: /保険|証券|免責|アシスタンス|三井住友|SOS/i },
    { name: '費用・支払い・デポジット', re: /費用|支払|デポジット|前払|立替|自己負担|請求|料金|現金|クレジット/ },
    { name: '旅券・ビザ・出入国', re: /旅券|パスポート|ビザ|査証|出国|入国|イミグレ|通関/ },
    { name: '空港・航空機の手配', re: /空港|航空|フライト|便|離陸|着陸|機内|エアアンビュ|チャーター|専用機|商用機|ストレッチャー/ },
    { name: '夜間・休日・時間がかかった', re: /夜間|深夜|休日|週末|土日|祝日|時間を要|時間がかか|遅れ|待たされ|待機/ },
    { name: '現地の医療水準・病院の受け入れ', re: /医療水準|設備|受け入れ|受入|転院|ICU|集中治療|検査ができ|専門医|輸血|酸素/ },
    { name: '言葉・通訳', re: /通訳|言語|言葉|英語|仏語|現地語|意思疎通/ },
    { name: '家族・付き添い', re: /家族|付き添|付添|同行|同伴|帰国後/ },
    { name: '連絡・情報共有', re: /連絡|報告|共有|電話|メール|公電|本省|調整/ },
    { name: '治安・政情・災害', re: /治安|政情|デモ|紛争|テロ|退避|災害|地震|洪水|台風|天候|悪天/ },
  ];
  const FREE_KEYS = [['logi', 'ロジスティックな問題点'], ['content', '内容'], ['summary', '要約'], ['tenkiDetail', '転帰の詳細'], ['keyword', 'キーワード']];
  function snippet(text, re, width) {
    width = width || 40;
    const m = re.exec(text); if (!m) return '';
    const s = Math.max(0, m.index - width), e = Math.min(text.length, m.index + m[0].length + width);
    return { before: (s > 0 ? '…' : '') + text.slice(s, m.index).replace(/\s+/g, ' '), hit: m[0], after: text.slice(m.index + m[0].length, e).replace(/\s+/g, ' ') + (e < text.length ? '…' : '') };
  }
  function findText(list, re) {
    const out = [];
    list.forEach(c => {
      for (const [k, name] of FREE_KEYS) {
        const t = c[k] || '';
        re.lastIndex = 0;
        if (re.test(t)) { re.lastIndex = 0; out.push({ c, field: name, snip: snippet(t, re) }); break; }
      }
    });
    return out;
  }
  function themes(list) { return THEMES.map(t => ({ name: t.name, re: t.re, hits: findText(list, t.re) })); }

  function crossTabSheet(ct, pct) {
    const X = XLSX();
    const head = [ct.rowVar.label + ' ＼ ' + ct.colVar.label].concat(ct.cols, ['計（症例数）']);
    const rows = [head];
    ct.rows.forEach((r, i) => {
      const n = ct.rowCases[i].length;
      rows.push([r].concat(ct.cells[i].map(a => pct ? (n ? Math.round(a.length / n * 1000) / 10 : 0) : a.length), [n]));
    });
    rows.push(['計（症例数）'].concat(ct.colCases.map(a => a.length), [ct.total]));
    if (pct) rows.push([], ['※ 各行の症例数に対する割合（%）']);
    if (ct.rowVar.multi || ct.colVar.multi) rows.push([], ['※ 複数選択の項目があるため、合計が症例数と一致しないことがあります']);
    const ws = X.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 24 }].concat(ct.cols.map(() => ({ wch: 10 })), [{ wch: 10 }]);
    return ws;
  }

  // ---------- 書き出し ----------
  function codeValue(x, v) {
    if (x.type === 'check') return !!v;
    if (x.type === 'radio') return v || 0;
    if (x.type === 'num') return v === null || v === undefined ? 0 : v;
    return v === '' || v === undefined ? 0 : v;
  }
  function summarySheet(list) {
    const X = XLSX();
    const ws = {};
    const set = (addr, v) => { ws[addr] = typeof v === 'number' ? { t: 'n', v } : typeof v === 'boolean' ? { t: 'b', v } : { t: 's', v: String(v) }; };
    Object.keys(SUMMARY_R1).forEach(c => set(c + '1', SUMMARY_R1[c]));
    Object.keys(SUMMARY_R2).forEach(c => set(c + '2', SUMMARY_R2[c]));
    list.forEach((c, i) => { F.forEach(x => set(x.col + (i + 3), codeValue(x, c[x.key]))); });
    ws['!ref'] = 'A1:' + 'DW' + Math.max(2, list.length + 2);
    ws['!cols'] = [];
    for (let i = 0; i < colNum('AQ') - 1; i++) ws['!cols'][i] = { wch: 2 };
    return ws;
  }
  const LIST_COLS = [
    ['症例番号', c => c.no || ''],
    ['報告医務官 所属', c => c.repPost], ['報告医務官 氏名', c => c.repName], ['報告年月日', repDate],
    ['担当医務官 所属', c => c.chgPost], ['担当医務官 氏名', c => c.chgName],
    ['緊急移送の確認', c => label(c, 'confirm')], ['医務官の関与', c => label(c, 'involve')],
    ['転帰日', outDate], ['発生年月日', occDate], ['発生都市（地域）', c => c.occCity], ['発生国', c => c.occCountry],
    ['イニシャル', initials], ['年齢', ageText], ['性別', c => label(c, 'sex')], ['症例区分', c => label(c, 'kubun')],
    ['初診場所への移送方法', c => legs(c)[0].method], ['初診場所', c => [c.h0, c.c0, c.k0].filter(Boolean).join(' / ')],
    ['移送先1への方法', c => label(c, 'm1') + (c.m1 === 5 && c.mo1 ? '（' + c.mo1 + '）' : '')], ['移送先1', c => [c.h1, c.c1, c.k1].filter(Boolean).join(' / ')],
    ['移送先2への方法', c => label(c, 'm2') + (c.m2 === 5 && c.mo2 ? '（' + c.mo2 + '）' : '')], ['移送先2', c => [c.h2, c.c2, c.k2].filter(Boolean).join(' / ')],
    ['移送先3への方法', c => label(c, 'm3') + (c.m3 === 5 && c.mo3 ? '（' + c.mo3 + '）' : '')], ['移送先3', c => [c.h3, c.c3, c.k3].filter(Boolean).join(' / ')],
    ['転帰', c => label(c, 'tenki')], ['転帰の詳細', c => c.tenkiDetail],
    ['診断', c => c.diag], ['内因性・外因性', c => label(c, 'inout')],
    ['内因性分類', c => naiinList(c).join('、')], ['外因性分類', c => gaiinList(c).join('、')],
    ['キーワード', c => c.keyword], ['ロジスティックな問題点', c => c.logi], ['要約', c => c.summary], ['内容', c => c.content],
    ['画像所見', c => c.imgFind],
  ];
  function buildExport(list, opts) {
    const X = XLSX();
    opts = opts || {};
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, summarySheet(list), 'Summary');
    const rows = [LIST_COLS.map(c => c[0]).concat(['チェック結果', '読み込んだファイル'])];
    list.forEach(c => {
      const chk = checkCase(c, list, opts.today).map(p => (p.level === 'err' ? '【要修正】' : '【要確認】') + p.msg).join('\n');
      rows.push(LIST_COLS.map(col => { const v = col[1](c); return v === null || v === undefined ? '' : v; }).concat([chk, c.source || '']));
    });
    const ws2 = X.utils.aoa_to_sheet(rows);
    ws2['!cols'] = rows[0].map((h, i) => ({ wch: /内容|要約|詳細|問題点|チェック/.test(h) ? 50 : /所見|診断|移送先|初診場所|キーワード/.test(h) ? 24 : 12 }));
    ws2['!autofilter'] = { ref: 'A1:' + colName(rows[0].length) + '1' };
    X.utils.book_append_sheet(wb, ws2, '一覧');
    const ag = aggregate(list);
    const arows = [['緊急移送症例の集計', '', ''], ['対象', ag.total + '件', opts.filterText || ''], []];
    ag.tables.forEach(t => {
      arows.push([t.title + (t.multi ? '' : ''), '件数', t.multi ? '（複数選択のため合計は件数と一致しません）' : '割合']);
      t.rows.forEach(([k, n]) => arows.push([k, n, t.multi ? '' : ag.total ? Math.round(n / ag.total * 1000) / 10 + '%' : '']));
      arows.push([]);
    });
    const ws3 = X.utils.aoa_to_sheet(arows);
    ws3['!cols'] = [{ wch: 30 }, { wch: 8 }, { wch: 12 }];
    X.utils.book_append_sheet(wb, ws3, '集計');
    const ind = indicators(list, 'outYear');
    const irows = [['主な指標（全体と転帰年ごと）。割合の分母は、その項目が記入されている症例'], [], ['転帰年', '症例数'].concat(...ind.indicators.map(x => [x.label, '該当/分母']))];
    ind.groups.forEach(g => irows.push([g.name, g.n].concat(...g.values.map(v => [v.base ? Math.round(v.hit / v.base * 1000) / 10 + '%' : '―', v.hit + '/' + v.base]))));
    const ws4 = X.utils.aoa_to_sheet(irows);
    ws4['!cols'] = [{ wch: 12 }, { wch: 8 }].concat(...ind.indicators.map(() => [{ wch: 18 }, { wch: 9 }]));
    X.utils.book_append_sheet(wb, ws4, '主な指標');
    return wb;
  }

  // ---------- 架空のデータ（試しに見る用） ----------
  function demoCases() {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const pick = a => a[Math.floor(rnd() * a.length)];
    const posts = [['ナイロビ', 'ケニア', 'ケニア大'], ['ラゴス', 'ナイジェリア', 'ラゴス総'], ['ダッカ', 'バングラデシュ', 'バングラデシュ大'], ['ウランバートル', 'モンゴル', 'モンゴル大'], ['ラパス', 'ボリビア', 'ボリビア大'], ['カブール', 'アフガニスタン', 'アフガニスタン大'], ['ポートモレスビー', 'パプアニューギニア', 'パプアニューギニア大'], ['アディスアベバ', 'エチオピア', 'エチオピア大'], ['ヤンゴン', 'ミャンマー', 'ミャンマー大'], ['キンシャサ', 'コンゴ民主共和国', 'コンゴ民主共和国大']];
    const dests = [['シンガポール', 'シンガポール', 'シンガポール総合病院（架空）'], ['バンコク', 'タイ', 'バンコク国際病院（架空）'], ['ヨハネスブルグ', '南アフリカ', 'ヨハネスブルグ医療センター（架空）'], ['ドバイ', 'アラブ首長国連邦', 'ドバイ中央病院（架空）'], ['東京', '日本', '都内の大学病院（架空）'], ['パリ', 'フランス', 'パリ市立病院（架空）'], ['マイアミ', '米国', 'マイアミ医療センター（架空）']];
    const cases = [
      ['急性心筋梗塞', 1, [1], '胸痛 PCI 心臓カテーテル'], ['くも膜下出血', 1, [3], '頭痛 意識障害 脳外科'], ['重症マラリア（熱帯熱）', 1, [19], 'マラリア 意識障害 輸血'], ['大腿骨骨折', 2, [5], '交通事故 手術'],
      ['急性虫垂炎（穿孔）', 1, [2], '腹痛 手術'], ['デング出血熱', 1, [19], 'デング 血小板減少'], ['うつ病（希死念慮）', 1, [16], '精神科 付き添い'], ['頭部外傷（交通事故）', 2, [0], '交通事故 CT'],
      ['切迫早産', 1, [12], '妊娠 産科'], ['腸チフス', 1, [19], '発熱 菌血症'], ['高山病（高地肺水腫）', 2, [8], '高地 酸素'], ['脳梗塞', 1, [3], '麻痺 血栓溶解'],
      ['熱傷（Ⅱ度30%）', 2, [6], '熱傷 植皮'], ['肺炎（重症）', 1, [0], '呼吸不全 人工呼吸'], ['消化管出血', 1, [2], '吐血 内視鏡'], ['腰椎圧迫骨折', 2, [4], '転落'],
    ];
    const out = [];
    for (let i = 0; i < 24; i++) {
      const c = emptyCase();
      const p = pick(posts), cs = cases[i % cases.length], d = pick(dests);
      const y = 2019 + Math.floor(rnd() * 7), m = 1 + Math.floor(rnd() * 12), dd = 1 + Math.floor(rnd() * 27);
      Object.assign(c, {
        repPost: p[2], repName: '架空　医務官' + (i % 5 + 1), repY: y, repM: m, repD: Math.min(28, dd + 1),
        chgPost: p[2], chgName: '架空　医務官' + (i % 5 + 1),
        confirm: rnd() < 0.85 ? 1 : 2, involve: 1 + Math.floor(rnd() * 4),
        occY: y, occM: m, occD: dd, occCity: p[0], occCountry: p[1],
        iniSei: String.fromCharCode(65 + Math.floor(rnd() * 26)), iniMei: String.fromCharCode(65 + Math.floor(rnd() * 26)),
        ageY: cs[0] === '切迫早産' ? 30 + Math.floor(rnd() * 8) : Math.floor(rnd() * 70) + 1,
        sex: cs[0] === '切迫早産' ? 2 : rnd() < 0.55 ? 1 : 2, kubun: pick([1, 1, 1, 2, 2, 3, 5, 6, 7]),
        m0: pick([1, 2, 2]), h0: p[0] + '市内の私立病院（架空）', c0: p[0], k0: p[1],
        m1: pick([2, 3, 4, 4]), h1: d[2], c1: d[0], k1: d[1],
        tenki: pick([1, 1, 1, 1, 2, 3, 4]), diag: cs[0], inout: cs[1],
        keyword: cs[3].split(' ').join('、'),
        logi: pick(['夜間でエアアンビュランスの離陸許可に時間を要した。', '保険会社との連絡に時間がかかった。', '空港での救急車横付けの許可取得に大使館が協力した。', '特になし。']),
        summary: p[1] + 'で発症した' + cs[0] + 'の症例。現地で初期治療の後、' + d[1] + 'へ移送した（架空の例）。',
        content: '①症例経過\n架空の症例です。\n\n②よかった点\n' + pick(['早めに保険会社へ連絡できた。', '現地の主治医と保険会社の医師の協議がすぐに始まった。', '家族の付き添いを早めに決められた。']) + '\n\n③反省点\n' + pick(['旅券の保管場所の確認に時間を要した。', '病院からデポジットを求められ、支払いに手間取った。', '通訳の手配に時間がかかった。', '週末で本省への連絡が遅れた。']) + '\n\n④今後の改善のための提言・まとめ\n着任時に旅券と保険証券の写しを医務室で把握しておく。',
      });
      if (c.ageY > 60 && c.kubun === 2) c.kubun = 3;
      const ex = cs[2]; ex.forEach(n => { c['x' + (cs[1] === 2 ? NAIIN.length + n : n)] = true; });
      if (c.tenki !== 4) { const od = new Date(y, m - 1, dd + 5 + Math.floor(rnd() * 20)); c.outY = od.getFullYear(); c.outM = od.getMonth() + 1; c.outD = od.getDate(); const rd = new Date(od.getFullYear(), od.getMonth(), od.getDate() + 14 + Math.floor(rnd() * 120)); c.repY = rd.getFullYear(); c.repM = rd.getMonth() + 1; c.repD = rd.getDate(); c.tenkiDetail = c.tenki === 3 ? '移送先で死亡（架空）' : '移送先で治療し退院（架空）'; }
      if (rnd() < 0.25 && d[1] !== '日本') { c.m2 = 3; c.h2 = '都内の大学病院（架空）'; c.c2 = '東京'; c.k2 = '日本'; }
      if (c.confirm === 2) { c.m1 = 0; c.h1 = c.c1 = c.k1 = ''; c.m2 = 0; c.h2 = c.c2 = c.k2 = ''; c.summary = p[1] + 'で発症した' + cs[0] + 'の症例。移送を検討したが現地で治療を継続した（架空の例）。'; }
      c.source = '架空のデータ';
      out.push(c);
    }
    // チェックの働きを見せるため、いくつか入力漏れ・誤りを入れておく
    out[3].diag = ''; out[5].inout = 0; out[8].outY = out[8].occY - 1; out[11].iniSei = 'YAMADA';
    out[14].summary = '患者の田中様が倒れ、旅券番号 TK1234567 を確認した（架空）';
    out[20] = Object.assign({}, out[2], { source: '架空のデータ（重複の例）' });
    return out;
  }

  const api = { FIRST_YEAR, VARS, VK, crossTab, crossTabSheet, dayStats, DAY_MEASURES, indicators, INDICATORS, themes, findText, THEMES, regionOf, isJapan, destKind, summaryStats, F, FK, LEGS, METHODS, NAIIN, GAIIN, R, readWorkbook, noFromFileName, caseFromForm, checkCase, aggregate, buildExport, label, occDate, repDate, outDate, initials, ageText, naiinList, gaiinList, legs, finalDest, routeText, demoCases, emptyCase, dupKey, LIST_COLS, colRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KinkyuCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
