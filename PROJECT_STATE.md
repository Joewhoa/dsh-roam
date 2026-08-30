# 项目速查（PROJECT_STATE）

> 精简版项目说明，完整文档见 `README.md`。

## 一句话
自托管的 DSH 远程控制台：在手机上继续操作本机 DeepSeek Harness。两种接入：**Tailscale（免域名）** 或 **Cloudflare（需域名）**。

## 运行
- DSH：`dsh web`（127.0.0.1:3080）
- 桥接：`node src/index.js`（127.0.0.1:8787）
- 暴露：`tailscale serve --bg 8788` 或 cloudflared 隧道
- 一键：`scripts/start-all.ps1`（Tailscale）/ `scripts/start-cloudflare.ps1`（Cloudflare）

## 关键文件
- `src/bridge.js`（核心）、`src/server.js`（HTTP）、`src/dsh/client.js`（DSH API 客户端）
- `web/index.html`（前端单文件）
- `scripts/`（一键启动 + 自测）

## 技术要点
- 零 npm 依赖、单文件前端
- 复用 DSH loopback `/api`（RPC + WebSocket 流 + respond），不依赖插件槽位
- SSE 心跳 + 断线自动恢复
- 余额密钥读 `~/.dsh/.credentials.yaml`，不进仓库

## 踩坑
- Cloudflare 隧道必须显式 `--protocol http2`（QUIC/7844 被墙）
- 页面能开但 API 403 → 把 `*.ts.net` 域名加进 DSH `trustedHosts`
- 换网络后隧道会自动重连；掉线则重启隧道/桥接即可
