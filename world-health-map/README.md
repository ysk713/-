# 世界医療情報マップ

世界地図の国をクリックすると、その国の **医療・感染症ニュース** と **関連動画（YouTube）** が表示されるWebアプリです。
GitHub Actions が **毎朝6時（日本時間）** に世界中の情報を自動収集し、GitHub Pages で公開します。

## できること

- 世界地図（約240の国・地域）を記事数に応じて色分け表示。ドラッグで移動、ホイール／ボタンで拡大
- 国をクリック → 動画プレーヤー＋医療ニュース一覧＋公式情報リンク（WHO・外務省・FORTH・CDC）
- 地域ボタン（アジア・中東・アフリカ など）でその地域へズームし、記事の多い国ランキングを表示
- 見出しから病名を自動タグ付け（デング熱・コレラ・麻しん・エムポックス など約30疾患）
- 日本語／英語／公的機関のみ の絞り込み、国名検索（日本語・英語どちらも可）
- URL が `#KE`（ケニア）のように国ごとに変わるので、ブックマークや共有ができる

## 収集元

| 種類 | 収集元 | 備考 |
|---|---|---|
| 公的機関 | WHO ニュース、WHO 感染症アウトブレイク情報、CDC 渡航者向け情報、ECDC | 見出しの国名で各国に振り分け |
| 国別ニュース | Google ニュース RSS（日本語・英語で各国を検索） | 直近7日分 |
| 動画 | WHO の YouTube チャンネル（APIキー不要） | タイトルの国名で振り分け |
| 動画（任意） | YouTube Data API で国別に検索 | `YOUTUBE_API_KEY` を設定した場合のみ。1日約90か国ずつ巡回 |

収集元は `scripts/sources.json` で追加・変更できます。ニュースは国ごとに直近14日分（最大30件）を蓄積します。

## 公開手順（GitHub Pages）

1. このブランチをデフォルトブランチ（main など）にマージする
   ※ GitHub Actions の定期実行はデフォルトブランチでしか動きません
2. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
3. **Actions** タブ → `world-health-map` → **Run workflow** で初回収集を実行
4. 完了すると `https://<ユーザー名>.github.io/<リポジトリ名>/world-health-map/` で地図が見られます。以降は毎朝自動更新

### 国別の動画を増やす（任意）

1. Google Cloud Console で「YouTube Data API v3」を有効にし、APIキーを作成（無料枠：1日10,000ユニット）
2. リポジトリの **Settings → Secrets and variables → Actions** に `YOUTUBE_API_KEY` として登録

キーがない場合も WHO チャンネルの動画は表示され、動画のない国には「YouTube で探す」リンクが出ます。

## 手元で動かす

```bash
cd world-health-map
python3 scripts/collect.py --only JP,KE,BR   # 動作確認なら国を絞ると速い（全件は5〜10分）
python3 -m http.server 8000
# ブラウザで http://localhost:8000/ を開く
```

Python 3.9 以上の標準ライブラリだけで動きます（追加インストール不要）。

## ファイル構成

```
world-health-map/
├── index.html / style.css / app.js   画面（d3.js で地図を描画）
├── data/
│   ├── countries.json                国マスタ（日本語名・英語名・別名・地域）
│   └── news/                         収集結果（index.json と国ごとの XX.json）
└── scripts/
    ├── collect.py                    収集スクリプト
    ├── sources.json                  収集元の設定
    └── build_countries.py            国マスタの再生成用（通常は不要）
.github/workflows/world-health-map.yml  毎日の収集と公開
```

## 注意

- 国名・病名の判定は見出しのキーワード照合による機械的なものなので、誤分類（例：記事中の「日本人」で日本に分類）が起こりえます
- 記事本文は保存せず、見出し・リンク・媒体名のみ扱います。動画は YouTube の埋め込みで再生します
- 渡航・診療の判断には、必ず WHO・外務省・厚生労働省検疫所（FORTH）等の一次情報を確認してください
