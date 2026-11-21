#!/bin/bash
# サーバーを起動する（launchd からも手動でも使う）
cd "$(dirname "$0")"
set -a; source ./.env; set +a
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"   # ffmpeg を見つけるため
# 127.0.0.1 のみで待ち受け。外からは Tailscale Funnel / Cloudflare Tunnel 経由でだけ届く
exec ./.venv/bin/uvicorn server:app --host 127.0.0.1 --port "${PORT:-8000}"
