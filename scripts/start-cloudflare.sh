#!/usr/bin/env bash
# ============================================================
#  DSH 手机控制台 一键启动脚本（macOS / Linux）
#  启动：dsh web + 桥接(node src/index.js) + cloudflared 隧道
#  幂等：已运行的进程会自动跳过，可随时重复运行
#  用法：bash start-all.sh   （或 chmod +x start-all.sh 后 ./start-all.sh）
#  开机自启：末尾会询问是否加入开机自启（自启用 --silent 静默模式）
# ============================================================

SILENT=0
[ "$1" = "--silent" ] && SILENT=1

# ---- 路径配置（换机器时改这里）----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$SCRIPT_DIR/.."                         # 桥接项目目录（脚本在 scripts/ 下）
CLOUDFLARED="cloudflared"                            # 若不在 PATH，改成绝对路径
TUNNEL_CFG="$HOME/.cloudflared/config-dsh.yml"
TUNNEL_NAME="dsh-bridge"
MOBILE_URL="https://chat.your-domain.com"

port_listening() { lsof -i ":$1" -sTCP:LISTEN >/dev/null 2>&1; }

echo ""
echo "========== DSH 手机控制台 一键启动 =========="

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

# 3. cloudflared 隧道
if pgrep -x cloudflared >/dev/null 2>&1; then echo "[3/3] 隧道          已在运行"; else
  echo "[3/3] 启动隧道 ..."
  "$CLOUDFLARED" tunnel --protocol http2 --edge-ip-version 4 --config "$TUNNEL_CFG" run "$TUNNEL_NAME" >/dev/null 2>&1 & sleep 2
fi

# 健康报告
echo ""
echo "---------- 健康检查 ----------"
sleep 3
port_listening 3080 && echo "  DSH web (3080) : OK" || echo "  DSH web (3080) : 未就绪"
port_listening 8787 && echo "  桥接    (8787) : OK" || echo "  桥接    (8787) : 未就绪"
pgrep -x cloudflared >/dev/null 2>&1 && echo "  隧道 (cloudflared) : 运行中" || echo "  隧道 (cloudflared) : 未运行"

echo ""
echo "  手机访问: $MOBILE_URL"
echo "  注意：隧道连上云端约需 10~30 秒，稍后刷新即可。"

# ---- 开机自启询问（仅交互式；自启用 --silent 跳过）----
if [ "$SILENT" != "1" ]; then
  echo ""
  read -r -p "是否添加至开机自启？(Y=添加 / N=移除 / 回车跳过): " choice
  PLIST="$HOME/Library/LaunchAgents/com.dsh.mobile-console.plist"
  case "$choice" in
    [Yy])
      mkdir -p "$HOME/Library/LaunchAgents"
      cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.mobile-console</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT_DIR/start-all.sh</string>
    <string>--silent</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
      launchctl unload "$PLIST" >/dev/null 2>&1
      launchctl load "$PLIST" >/dev/null 2>&1
      echo "  已添加到开机自启（登录后自动静默拉起）。"
      ;;
    [Nn])
      launchctl unload "$PLIST" >/dev/null 2>&1
      rm -f "$PLIST"
      echo "  已从开机自启移除。"
      ;;
    *)
      echo "  未更改开机自启。"
      ;;
  esac
fi
