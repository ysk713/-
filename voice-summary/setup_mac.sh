#!/bin/bash
# Mac mini 初回セットアップ。ターミナルで:  bash setup_mac.sh
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"

echo "== 1. Homebrew の確認"
if ! command -v brew >/dev/null; then
  echo "Homebrew がありません。https://brew.sh の1行コマンドで入れてから再実行してください。"
  exit 1
fi

echo "== 2. Python と ffmpeg のインストール"
brew install python@3.12 ffmpeg

echo "== 3. Python 仮想環境とライブラリ"
"$(brew --prefix)/bin/python3.12" -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

echo "== 4. 設定ファイル .env"
if [ ! -f .env ]; then
  cp .env.example .env
  PW="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)"
  sed -i '' "s/^APP_PASSWORD=.*/APP_PASSWORD=${PW}/" .env
  echo "ログイン用パスワードを生成しました（.env の APP_PASSWORD）。"
fi
chmod 600 .env
if ! grep -q '^ANTHROPIC_API_KEY=.\+' .env; then
  echo "!! .env の ANTHROPIC_API_KEY が空です。キーを書き込んでから続けてください:"
  echo "   open -e $DIR/.env"
  read -r -p "   書き込んだら Enter … "
fi

echo "== 5. Whisper モデルの事前ダウンロード（初回のみ数分）"
set -a; source ./.env; set +a
./.venv/bin/python - <<'PY'
import server
server._load_whisper()
print("OK:", server._whisper[0])
PY

echo "== 6. 自動起動（ログイン時に常駐、落ちても再起動）"
chmod +x start.sh
PLIST="$HOME/Library/LaunchAgents/local.voice-summary.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.voice-summary</string>
  <key>ProgramArguments</key><array><string>$DIR/start.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/logs/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/server.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 3
if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/ | grep -q 401; then
  echo "サーバー起動OK → Mac mini 上なら http://127.0.0.1:8000 で開けます"
else
  echo "起動を確認できませんでした。ログ: $DIR/logs/server.log"
fi

echo
echo "次は README.md の「遠隔から使う」の手順へ進んでください。"
