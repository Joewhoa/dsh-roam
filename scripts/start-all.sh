#!/usr/bin/env bash
# ============================================================
#  DSH 手机控制台 —— Tailscale 版一键启动（macOS / Linux）
#  免域名：只需 Tailscale（PC 与手机登录同一账号），无需 cloudflared/域名
#  启动：dsh web + 桥接(node src/index.js) + tailscale serve(HTTPS)
#  幂等：已运行的自动跳过
#  用法：bash start-all.sh   （或 chmod +x 后 ./start-all.sh）
#  前提：本机已装并登录 Tailscale；手机装 Tailscale 并登录同一账号
# ============================================================

SILENT=0
[ "$1" = "--silent" ] && SILENT=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$SCRIPT_DIR/.."

port_listening() { lsof -i ":$1" -sTCP:LISTEN >/dev/null 2>&1; }

echo ""
echo "========== DSH 手机控制台（Tailscale 版）一键启动 =========="

# 1. DSH web (3080)
if port_listening 3080; then echo "[1/3] DSH web      已在运行 (3080)"; else
  echo "[1/3] 启动 DSH web ..."
  dsh web >/dev/null 2>&1 & sleep 2
fi

# 2. 桥接 (8787)
if port_listening 8787; then echo "[2/3] 桥接          已在运行 (8787)"; else
  echo "[2/3] 启动桥接 ..."
  (cd "$BRIDGE_DIR" && node src/index.js >/dev/null 2>&1 &) ; sleep 2
fi

# 3. Tailscale Serve（HTTPS：ts.net → 127.0.0.1:8787）
if tailscale serve status 2>/dev/null | grep -q 8788; then
  echo "[3/3] Tailscale Serve  已启用"
else
  echo "[3/3] 启用 Tailscale Serve（HTTPS 代理 8787）..."
  tailscale serve --bg 8788 >/dev/null 2>&1; sleep 3
fi

# 健康报告
echo ""
echo "---------- 健康检查 ----------"
sleep 3
port_listening 3080 && echo "  DSH web (3080) : OK" || echo "  DSH web (3080) : 未就绪"
port_listening 8787 && echo "  桥接    (8787) : OK" || echo "  桥接    (8787) : 未就绪"

echo ""
echo "  手机访问：先 tailscale status 看本机名字，再用"
echo "    https://<机器名>.<你的tailnet>.ts.net/   （输入 WEB_PASSWORD）"
echo "  提示：PC 与手机必须登录同一个 Tailscale 账号。"
echo ""
