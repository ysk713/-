// 使い方: node kinkyu-isou/tests/test_core.js
// 登録フォームと同じ位置にセルを置いた架空のブックで、読み取り・チェック・書き出し・読み直しを確かめる。
const assert = require('assert');
const XLSX = require('../../geppou/lib/xlsx.full.min.js');
globalThis.XLSX = XLSX;
const K = require('../src/core.js');

function formBook(vals, cached) {
  const ws = { A4: { t: 's', v: '緊急移送症例登録フォーム' } };
  for (const [a, v] of Object.entries(vals)) ws[a] = typeof v === 'number' ? { t: 'n', v } : typeof v === 'boolean' ? { t: 'b', v } : { t: 's', v };
  // 3行目の集まり（数式の結果）だけが入っているブックも読めること
  for (const [a, v] of Object.entries(cached || {})) ws[a] = typeof v === 'number' ? { t: 'n', v } : { t: 's', v };
  ws['!ref'] = 'A1:DW227';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Default');
  return XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
}
const ok = {
  E9: 'ケニア大', Q9: '架空　一郎', AE9: 2026, AH9: 4, AJ9: 2, AY3: 1, AZ3: 4,
  H19: 2026, K19: 3, M19: 20, V19: 'ナイロビ', AH19: 'ケニア', G21: 'ｋ', I21: 'Ｔ', O21: 52,
  BJ3: 1, BK3: 1, BL3: 2, D27: '架空病院A', V27: 'ナイロビ', AH27: 'ケニア',
  BQ3: 4, D31: '架空病院B', V31: 'ヨハネスブルグ', AH31: '南アフリカ',
  F41: 2026, I41: 3, K41: 30, CI3: 1, C45: '急性心筋梗塞', CL3: 1, CN3: true, E60: '胸痛、PCI', E66: '架空の要約',
  A72: '①症例経過 \n\n②よかった点\n\n③反省点  \n\n④今後の改善のための提言・まとめ\n',
};
const today = new Date(2026, 10, 9);

// 1. 入力セルから読む
let r = K.readWorkbook(formBook(ok), 'a.xlsx');
assert.strictEqual(r.kind, 'form');
let c = r.cases[0];
assert.strictEqual(c.repPost, 'ケニア大');
assert.strictEqual(c.iniSei, 'K'); assert.strictEqual(c.iniMei, 'T');
assert.strictEqual(K.label(c, 'confirm'), '実施');
assert.strictEqual(K.label(c, 'm1'), 'エアアンビュランス');
assert.deepStrictEqual(K.naiinList(c), ['循環器系']);
assert.strictEqual(c.content, '', '見出しだけの「内容」は空欄とみなす');
assert.deepStrictEqual(K.checkCase(c, [c], today), []);

// 2. 3行目（数式の結果）だけのブック
r = K.readWorkbook(formBook({ AY3: 2 }, { AR3: '在ボリビア大', BE3: 'ボリビア', CK3: '肺炎' }), 'b.xlsx');
assert.strictEqual(r.cases[0].repPost, '在ボリビア大');
assert.strictEqual(r.cases[0].diag, '肺炎');

// 3. 空のフォーム
assert.ok(K.readWorkbook(formBook({}), 'c.xlsx').blank);

// 3b. 空のひな形（Default）と記入済みのシート（症例１）が同じブックにある
{
  const one = formBook(ok);
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, formBook({}).Sheets.Default, 'Default');
  XLSX.utils.book_append_sheet(wb2, one.Sheets.Default, '症例１');
  const r2 = K.readWorkbook(wb2, 'png.xlsx');
  assert.strictEqual(r2.cases.length, 1);
  assert.strictEqual(r2.cases[0].diag, '急性心筋梗塞');
  assert.strictEqual(r2.cases[0].source, 'png.xlsx');
  XLSX.utils.book_append_sheet(wb2, formBook(Object.assign({}, ok, { C45: '肺炎' })).Sheets.Default, '症例２');
  const r3 = K.readWorkbook(wb2, 'png.xlsx');
  assert.deepStrictEqual(r3.cases.map(c => c.source), ['png.xlsx（症例１）', 'png.xlsx（症例２）']);
}

// 3c. 症例番号はファイル名の先頭の数字から
assert.strictEqual(K.noFromFileName('0031_PapuaNewGuinea_20190326.xlsx'), 31);
assert.strictEqual(K.noFromFileName('届いた分/0105-Kenya.xlsx'), 105);
assert.strictEqual(K.noFromFileName('０１２_ケニア.xlsx'), 12);
assert.strictEqual(K.noFromFileName('PapuaNewGuinea_20190326.xlsx'), null);
assert.strictEqual(K.noFromFileName('20190326.xlsx'), 20190326 > 999999 ? null : 20190326);
{
  const r4 = K.readWorkbook(formBook(ok), '0031_PapuaNewGuinea_20190326.xlsx');
  assert.strictEqual(r4.cases[0].no, 31);
  const r5 = K.readWorkbook(formBook(Object.assign({}, ok, { AB4: 7 })), '0031_x.xlsx');
  assert.strictEqual(r5.cases[0].no, 31);
  assert.ok(K.checkCase(r5.cases[0], r5.cases, today).some(p => /ファイル名から 31/.test(p.msg)));
  assert.strictEqual(K.readWorkbook(formBook(Object.assign({}, ok, { AB4: 7 })), 'x.xlsx').cases[0].no, 7);
}

// 4. チェック
const bad = Object.assign({}, c, { diag: '', occD: 31, occM: 2, iniSei: 'YAMADA', inout: 2, summary: '田中様が転倒。旅券番号 TK1234567', ageM: 3, m1: 5, mo1: '' });
const msgs = K.checkCase(bad, [bad], today).map(p => p.level + ':' + p.msg).join('\n');
['err:診断が空欄', 'err:症例発生年月日が日付として正しくありません', 'イニシャル（姓）が「YAMADA」', '外因性ですが、外因性分類にチェックがありません', '外因性ですが、内因性分類にもチェック', '人名・旅券番号', '「その他」ですが、内容']
  .forEach(s => assert.ok(msgs.indexOf(s) >= 0, '見つからない: ' + s + '\n' + msgs));
const dup = Object.assign({}, c);
assert.ok(K.checkCase(c, [c, dup], today).some(p => /二重登録/.test(p.msg)));

// 5. 書き出し → 読み直し（Summary シートは福利厚生室の集計表と同じ列）
const demo = K.demoCases();
const wb = XLSX.read(XLSX.write(K.buildExport(demo, { today }), { type: 'array', bookType: 'xlsx' }), { type: 'array' });
assert.deepStrictEqual(wb.SheetNames, ['Summary', '一覧', '集計', '主な指標']);
assert.strictEqual(wb.Sheets.Summary.AQ2.v, '症例番号(Default 0)');
assert.strictEqual(wb.Sheets.Summary.DQ2.v, 'その他の外因(Default 0)');
const back = K.readWorkbook(wb, 'out.xlsx');
assert.strictEqual(back.kind, 'table');
assert.strictEqual(back.cases.length, demo.length);
const strip = x => { const o = Object.assign({}, x); delete o.source; delete o.id; return o; };
back.cases.forEach((b, i) => assert.deepStrictEqual(strip(b), strip(demo[i])));

// 6. 集計
const ag = K.aggregate(demo);
assert.strictEqual(ag.total, demo.length);
assert.strictEqual(ag.tables.find(t => t.title === '緊急移送の確認').rows.reduce((s, r) => s + r[1], 0), demo.length);

// 6b. 古い年（さかのぼって登録した症例は正しい。報告年が2018年より前・生まれ年と同じ発生年は知らせる）
{
  const old = Object.assign({}, c, { occY: 2016, occM: 12, occD: 11, outY: 2016, outM: 12, outD: 31, repY: 2019 });
  assert.ok(!K.checkCase(old, [old], today).some(p => /2016年/.test(p.msg)), 'さかのぼって登録した症例は指摘しない');
  const b1 = Object.assign({}, c, { occY: 1987, ageY: 39, repY: 2026 });
  assert.ok(K.checkCase(b1, [b1], today).some(p => /生年月日を入れていないか/.test(p.msg)));
  assert.ok(K.checkCase(b1, [b1], today).some(p => /1年以上離れて/.test(p.msg)));
  const b2 = Object.assign({}, c, { repY: 2005 });
  assert.ok(K.checkCase(b2, [b2], today).some(p => /報告年月日が2005年/.test(p.msg)));
}
{
  const b3 = Object.assign({}, c, { occY: 2025, occM: 4, occD: 29, outY: 2026, outM: 5, outD: 22, repY: 2025, repM: 6, repD: 18 });
  assert.ok(K.checkCase(b3, [b3], today).some(p => /報告年月日（2025-06-18）より後/.test(p.msg)));
}
// 6c. フォームに行が足されて位置がずれていても、3行目の数式が指すセルを読む
{
  const wbS = formBook(Object.assign({}, ok, { H19: '', H20: 2025 }));
  wbS.Sheets.Default.BA3 = { t: 'n', v: 2025, f: '+H20' };
  assert.strictEqual(K.readWorkbook(wbS, 's.xlsx').cases[0].occY, 2025);
}

// 7. 分析
assert.strictEqual(K.regionOf('ケニア'), 'アフリカ');
assert.strictEqual(K.regionOf('在パプアニューギニア日本国大使館'), '大洋州');
assert.strictEqual(K.regionOf('PNG'), '大洋州');
assert.strictEqual(K.regionOf('米国'), '北米・中米・カリブ');
assert.ok(K.isJapan('日本') && K.isJapan('Japan') && !K.isJapan('南アフリカ'));
{
  const ct = K.crossTab(demo, 'region', 'dest');
  const sum = ct.cells.reduce((s, r) => s + r.reduce((t, a) => t + a.length, 0), 0);
  assert.strictEqual(sum, demo.length, '単一選択どうしのクロス表の合計は症例数');
  assert.strictEqual(ct.rowCases.reduce((s, a) => s + a.length, 0), demo.length);
  const ct2 = K.crossTab(demo, 'outYear', 'cause');
  assert.ok(ct2.cols.indexOf('感染症科') >= 0);
  const ind = K.indicators(demo, 'outYear');
  assert.strictEqual(ind.groups[0].values[0].hit, demo.filter(c => c.confirm === 1).length);
  const ds = K.dayStats(demo, 'inout');
  assert.ok(ds[0].stats[0].n > 0 && ds[0].stats[0].median >= 0);
  assert.strictEqual(K.summaryStats([1, 2, 3, 4, 100]).median, 3);
  const th = K.themes(demo);
  const money = th.find(t => t.name.indexOf('費用') === 0);
  assert.ok(money.hits.length > 0 && money.hits.every(h => /デポジット|費用|支払/.test(h.snip.hit)));
}

console.log('kinkyu-isou: すべてのテストに合格しました');
