# 音声要約（Mac mini 常駐版）

会議や診察の音声を、職場のPCのブラウザから Mac mini に送り、
**文字起こし（Mac mini 内で処理）→ 画面で確認 → 要約（Claude）** して返すアプリです。
職場のPCには何もインストールしません。

> このアプリは Mac mini の上でサーバーとして動かすものです。GitHub Pages（ysk713.github.io）では動きません。

```
職場PC（ブラウザで録音 or ファイル選択）
   │ HTTPS ＋ パスワード
   ▼
Mac mini（24時間稼働）
   ├ Whisper で文字起こし … 音声はMac mini の外に出ない・文字起こしが終わったらすぐ削除
   ├ 文字起こしを画面に表示 → 利用者が確認・修正して「送る」を押す
   └ 確認したテキストだけ Claude API へ → 議事録 / SOAP
```

## ⚠ 使い始める前に確認すること

- **所属先の規程**：患者さんの診察内容（文字起こしテキスト）を、職場外の機器（自宅等の Mac mini）と外部 API（Claude）に送ることが認められているか。
- **患者さんの同意**：診察を録音することへの同意の取り方。
- **職場ネットワーク**：職場PCから外部サイト（後述の `https://〜.ts.net` 等）に接続できるか、マイク使用が許可されているか。

## 1. Mac mini のセットアップ（初回だけ）

1. このフォルダ `voice-summary` を Mac mini にコピー（例：`~/voice-summary`）。
2. Claude API キーを用意（https://platform.claude.com → API Keys）。
3. ターミナルで：
   ```bash
   cd ~/voice-summary
   bash setup_mac.sh
   ```
   途中で `.env` に API キーを書き込むよう求められます。ログイン用パスワードは自動生成され、`.env` の `APP_PASSWORD` に入ります。
4. **スリープさせない**設定：システム設定 → エネルギー →「ディスプレイがオフのときに自動でスリープさせない」をオン、「停電後に自動的に起動」をオン。
   さらに、再起動後も自動で立ち上がるよう、システム設定 → ユーザとグループ →「自動ログイン」を有効にしてください（自動起動はログイン時に動くため）。

Apple Silicon（M1 以降）の Mac mini なら高速な `mlx-whisper` が使われます。目安として 1 時間の録音が数分〜十数分で文字起こしされます。

## 2. 遠隔から使う（おすすめ：Tailscale Funnel）

職場PCはブラウザだけで使え、URL も固定になります。

1. Mac mini に Tailscale を入れてログイン：https://tailscale.com/download （無料の個人プラン）
2. 管理画面（https://login.tailscale.com/admin）で **HTTPS Certificates** と **Funnel** を有効にする（画面の案内に従う）。
3. Mac mini のターミナルで：
   ```bash
   tailscale funnel --bg 8000
   ```
   表示された `https://<マシン名>.<tailnet名>.ts.net` が職場から開く URL です。
4. 職場PCのブラウザでその URL を開き、ユーザー名 `doctor`（.env の `APP_USER`）とパスワードを入力。

> Funnel はインターネットに公開されるため、守りはアプリのパスワードだけです。より強くしたい場合は下の Cloudflare 方式を使ってください。
>
> 総当たりでパスワードを当てられないよう、**10分間に10回ログインに失敗すると、15分間は正しいパスワードでも入れなくなります**（接続元は区別しません）。
> 自分が締め出されたときは、15分待つか、Mac mini でサーバーを再起動してください（下の「運用メモ」）。回数と時間は `.env` の `LOGIN_FAIL_LIMIT`・`LOGIN_LOCK_MIN` で変えられます。

### もう一段安全にしたい場合：Cloudflare Tunnel ＋ Cloudflare Access

独自ドメイン（年千数百円〜）が必要ですが、URL を開く前に「登録したメールアドレスに届くコード」での認証を挟めます。
`brew install cloudflared` → Cloudflare Zero Trust 画面で Tunnel を作成し `http://localhost:8000` を指定 → Access でアプリを作り、自分のメールアドレスだけを許可。

## 3. 使い方

1. 「会議 → 議事録」か「診察 → SOAP」を選ぶ。
2. 「● 録音開始」でその場で録音（HTTPS 接続時のみ）、または録音済みファイルを選ぶ（m4a / mp3 / wav / webm など）。
3. 必要なら専門用語（薬剤名・人名・委員会名など）を入れる（文字起こしに使うだけで、Claude には送りません）。
4. 「文字起こしする」を押す。
5. **送る前の確認**：文字起こしが表示されます。患者さんの氏名など送りたくない部分は消したり書き換えたりできます。必要なら補足メモも入れます。
   「この内容を Claude に送って要約する」を押すと、送る文字数を示す確認が出て、OK を押したときだけ Claude に送られます。送りたくないときは「送らずに終える」。
6. 完了したら「要約」「送った文字起こし」を確認し、コピーまたは保存。
7. 使い終わったら「サーバーから消去」。消さなくても 6 時間後か再起動で消えます。

### データの置き場所
- **音声**：アップロード中から文字起こしが終わるまで、Mac mini の一時フォルダにファイルとして置かれます。文字起こしが終わったら（失敗した場合も）すぐ削除します。
- **文字起こし・要約**：Mac mini のメモリ上にだけ置き、ファイルには書きません。
- **Claude に送るもの**：確認画面で「送る」を押したときの文字起こしと補足メモだけです。音声と専門用語の欄は送りません。

## 運用メモ

| やりたいこと | 方法 |
|---|---|
| ログを見る | `tail -f ~/voice-summary/logs/server.log` |
| 再起動 | `launchctl kickstart -k gui/$(id -u)/local.voice-summary` |
| 止める | `launchctl unload ~/Library/LaunchAgents/local.voice-summary.plist` |
| パスワード変更 | `.env` の `APP_PASSWORD` を書き換えて再起動 |
| ログインの締め出しを解除 | 再起動（または15分待つ） |
| 要約の書式を変える | `prompts.py` を編集して再起動 |

## ファイル構成

- `server.py` … サーバー本体（文字起こし・要約・認証）
- `prompts.py` … 議事録 / SOAP の指示文
- `static/index.html` … ブラウザ画面
- `setup_mac.sh` / `start.sh` … セットアップと起動
- `.env` … API キーとパスワード（他人に渡さない）
