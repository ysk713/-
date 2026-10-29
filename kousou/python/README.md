# 個人用医薬品購送 下判定ツール（kousou）

日次スキャンPDFを患者ごとの三点セット（申込書→診断書→指示書）に分け、チェック①〜⑬で**下判定**し、`YYYYMMDD氏名.pdf` で1人1PDFに出力します。最終判断は必ず人が行ってください。

## 二層構造

| 層 | 担当 | 内容 |
|---|---|---|
| 決定的処理 | Python（`pdfops.py`） | 白紙除去（インク密度0.5%未満）、結合、命名、UTF-8フラグ付きZIP |
| 読み取り | Claude（`ai.py`、画像入力） | ページ種別の分類、記載内容・チェック欄・署名/押印の読み取り、薬剤の添付文書知識 |
| 判定 | Python（`rules.py`） | 読み取り結果に①〜⑬と既知ルール（メモ3〜7節）を機械的に適用 |

`drug_master.json` に登録した薬はマスタの値（規格・上限・向精神薬・適応）で判定し、未登録の薬だけAIの判断を使います（結果に `[マスタ]`／`[AI判断]` と表示）。

## 準備

```bash
pip install -r requirements.txt
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## 使い方

```bash
python -m kousou 20260929113409.pdf -o out/20260929
```

出力（`out/20260929/`）:

- `判定結果.md`：案件別の指摘、クリーン案件、優先度順の総括表、除去した白紙ページ
- `判定一覧.csv`：Excelで開ける一覧（エラー相当／要確認／クリーン）
- `pdf/YYYYMMDD氏名.pdf`：1人1PDF（申込書→診断書→指示書→委任状の順）
- `YYYYMMDD_購送下判定.zip`：上記をまとめたZIP（日本語名が化けない）
- `work/`：AIの読み取り結果（JSON）

### 読み取りや分割の誤りを直して再判定する

1. `work/groups.json`（患者ごとの分割）や `work/cases/gNN.json`（読み取り内容）を直します。
2. API を使わずに再実行します。

```bash
python -m kousou 20260929113409.pdf -o out/20260929 --offline
```

分割を直したときは、該当する `work/cases/gNN.json` を消してから `--offline` を付けずに実行すると、その案件だけ読み直します。

### 過去バッチとの突き合わせ

`./kousou_history.json` に申込ごとの要約（職員コード・日付・薬剤）が蓄積され、同一療養者の前回分と1剤ずつ比較します。日付が違えば二重供給とはせず、用量の変更点を表示します。`--history パス` で場所を変更、`--no-history` で無効化できます。

## ルールの変更

コードを触らずに `kousou/rules.json` と `kousou/drug_master.json` を編集します。

- `no_seal_missions`：押印なしでよい公館（キューバ、ジブチ）
- `patrol_missions`：巡回公館・健康相談公館の一覧（**要入力**：医務官訓令別表から転記）。診断書原本の別送可否に使います。
- `psych_permits`：向精神薬の特別許可（患者名を含むのでリポジトリには入れず、手元で追記）
- `verified_dose_ok` / `verified_indication_ok`：確認済みでOKの用量・適応
- `flag_kankatsu`：兼轄を指摘するか（既定 false＝2026-10-20の方針）
- `offlabel_severity`：AIが適応外と判断したときの重要度（既定 `check`＝要確認）
- `consent_items`：同意チェック11項目（**要差し替え**：様式A最新テンプレートの正式文言）

## テスト（API不要・架空データ）

```bash
python tests/test_pipeline.py
```

## 注意

- スキャン画像（個人の医療情報）は Anthropic API に送信されます。職場の情報管理規程で外部送信が認められているか確認してください。
- 「書類が無い」と出ても断定せず、スキャンの重複・欠落・ページ境界を確認してください。
