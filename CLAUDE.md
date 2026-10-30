# このリポジトリでの作業のしかた

在外公館の医務官業務などで使うブラウザアプリを置いているリポジトリです。各アプリはフォルダごとに分かれ、GitHub Pages（https://ysk713.github.io/-/）で公開しています。

## 会話のルール

- やりとりは日本語で行う。
- アプリを作ったり直したりしたときは、**返信の最後にそのアプリのURLを付ける**（GitHub Pages のURL。claude.ai 版があればそのURLも）。
- アプリは、必要に応じて Claude につないでよい（claude.ai 版の「Claudeに質問」機能など）。ただし原稿など職場の文書を送る機能は、送る前に必ず画面で確認を出し、何が送られるかを利用者に示す。

## アプリづくりの決まり

- 職場PCにはソフトをインストールできない。**ブラウザだけで動く**こと（Edge／Chrome）。
- GitHub Pages 版は、ページの Content-Security-Policy で**外部への通信を禁止**する（読み込んだファイルがPCの外に出ないようにするため）。ライブラリはHTMLに埋め込む。
- 医務官名・職員の個人情報・実際の原稿などは**リポジトリに入れない**（GitHub Pages は誰でも見られる）。宛先データ等は各自のブラウザ内に保存する。
- 画面の文言は、IT の専門家でない利用者（医務官・事務担当）にわかる日本語で書く。

## アプリ一覧

| フォルダ | アプリ | 補足 |
|---|---|---|
| `sekai-check/` | 世界の医療事情 原稿チェッカー | 本体は `src/checker.html`。`python3 sekai-check/build.py` で `index.html`（Pages版）を作る。claude.ai 版：https://claude.ai/artifact/DUD5HnvRYf4v5jevpQHaQh |
| `kousou/` | 購送書類 審査 | |
| `shindansho/` | 診断書・指示書 作成支援 | |
| `geppou/` `geppou-app/` | 医務官月報 取りまとめ | |
| `world-health-map/` | 世界医療情報マップ | |
| `shihou-app/` | 司法試験 合格ノート | |
| `mental-health-app/` | メンタルヘルス・マネジメント検定 問題集 | |

詳しくは各フォルダの README を参照。
