#!/usr/bin/env bash
# ============================================================
#  看门狗（macOS / Linux）：检查并自动拉起指定的服务
#  - 配置在同目录 watchdog.conf：DSH / BRIDGE / WATCH_TUNNEL
#  - 幂等：已运行的自动跳过
#  - 建议用 launchd 每 5 分钟跑一次（见 README「自动恢复」）
# ============================================================

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ---- 默认值 ----
WATCH_DSH=1
WATCH_BRIDGE=1
WATCH_TUNNEL="tailscale"

# ---- 读取配置（shell 兼容格式 KEY=VALUE）----
if [ -f "$SCRIPT_DIR/watchdog.conf" ]; then
  # shellcheck disable=SC1090
  source "$SCRIPT_DIR/watchdog.conf" 2>/dev/null || true
fi

port_listening() {
  lsof -i:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# ---- 1. DSH web (3080) ----
if [ "$WATCH_DSH" != "0" ] && ! port_listening 3080; then
  echo "[watchdog] DSH web 未运行，拉起..."
  nohup dsh web >/dev/null 2>&1 &
fi

# ---- 2. 桥接 (8787) ----
if [ "$WATCH_BRIDGE" != "0" ] && ! port_listening 8787; then
  echo "[watchdog] 桥接未运行，拉起..."
  ( cd "$PROJECT_DIR" && nohup node src/index.js >/dev/null 2>&1 & )
fi

# ---- 3. 隧道（按模式） ----
if [ "$WATCH_TUNNEL" = "tailscale" ]; then
  if ! tailscale serve status 2>/dev/null | grep -q '8788'; then
    echo "[watchdog] tailscale serve 未生效，重新启用..."
    tailscale serve --bg 8788 >/dev/null 2>&1
  fi
elif [ "$WATCH_TUNNEL" = "cloudflare" ]; then
  if ! pgrep -x cloudflared >/dev/null 2>&1; then
    echo "[watchdog] cloudflared 未运行，拉起..."
    nohup cloudflared tunnel --protocol http2 --edge-ip-version 4 --config ~/.cloudflared/config-dsh.yml run dsh-bridge >/dev/null 2>&1 &
  fi
fi
# none：跳过隧道守护
