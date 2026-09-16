# 项目速查（PROJECT_STATE）

> 精简版项目说明，完整文档见 `README.md`。

## 一句话
自托管的 DSH 远程控制台：在手机上继续操作本机 DeepSeek Harness。两种接入：**Tailscale（免域名）** 或 **Cloudflare（需域名）**。

## 运行
- DSH：`dsh web`（127.0.0.1:3080）
- 桥接：`node src/index.js`（127.0.0.1:8787）
- 暴露：`tailscale serve --bg 8788` 或 cloudflared 隧道
- 一键：`scripts/start-all.ps1`（Tailscale）/ `scripts/start-cloudflare.ps1`（Cloudflare）
- 托盘（Windows）：`scripts/tray.ps1` —— 鲸鱼图标驻留系统托盘，右键「一键启动所有服务 / 开启监控 / 退出」，默认只驻留、不自动拉起服务

## 关键文件
- `src/bridge.js`（核心）、`src/server.js`（HTTP）、`src/dsh/client.js`（DSH API 客户端）
- `web/index.html`（前端单文件）
- `scripts/`（一键启动 + 托盘 + 看门狗 + 自测）

## 技术要点
- 零 npm 依赖、单文件前端
- 复用 DSH loopback `/api`（RPC + WebSocket 流 + respond），不依赖插件槽位
- SSE 心跳 + 断线自动恢复
- 余额密钥读 `~/.dsh/.credentials.yaml`，不进仓库
- `npm run test:web` 用 Node 标准库 + 本机 Edge CDP 跑 HTTP 与真实浏览器回归，无 npm 测试依赖

## 最近进展
- [2026-09-15] 斜杠输入：`/` 合并展示 DSH 命令与技能，空白后的 `/` 或 `@` 只筛技能；候选带类别和中文简介，点击/方向键补全但不立即执行。
- [2026-09-15] 输入行为：Enter 改为换行，仅点击发送按钮提交；菜单支持外部点击/Escape 关闭、手机触摸和异步竞态保护。
- [2026-09-15] 技能展示修复：按 `source.kind=skill-invocation` 隐藏注入上下文，并通过缓存版本迁移清除旧的错误气泡。
- [2026-09-15] 侧栏会话：按「会话 cwd 精确匹配工作区 path」分组（`workspace.sessionIds` 只作 cwd 缺失时的回退，避免新建会话因工作区索引未刷新而掉进「未分组」），可折叠且状态持久化；按 `session.list` 的权威 `blank` 字段隐藏空白会话，并过滤全局归档与 subagent 会话。
- [2026-09-15] 侧栏排序：组内按更新时间倒序、组间按「组内最新会话」倒序，最近聊过的会话（含当前运行会话）排在最前，空工作区不再显示；响应改为统一的 `groups` 字段。
- [2026-09-15] 后台预载同步过滤空白/归档会话；桌面 1280×900 与手机 390×844 浏览器回归均通过。
- [2026-09-15] 附件输入：图片/文本选择器分流并限制类型，支持多选、暂存、移除及继续输入文字；仅点击发送后把附件块与文字作为同一条 prompt 提交，不再选完即发送。
- [2026-09-15] 打断修复：cancel API 校验 DSH `accepted` 回执，Bridge 主动以 `cancelled` 结算 SSE 并处理 `turn/end` 竞态；前端显示打断进度/结果、保留部分回复，并按发起时的 sessionId 清理跨会话运行状态。
- [2026-09-15] 打断通知：打断成功后无条件在对话区追加系统样式「⛔ 已打断」提示（覆盖刷新前/后台已运行、无活动 SSE 流的场景），部分回复保留。
- [2026-09-15] 新消息气泡：当前会话内、用户不在底部时，新消息到达会浮出「↓ N 条新消息」按钮，点击跳到底部并清除；在底部时自动跟随。
- [2026-09-15] 刷新与缓存：删除「清理缓存」入口；`🔄` 改为权威重拉当前会话（PAGE_SIZE=20）并整体重渲染，可修正跨会话串话；运行状态（打断按钮 / 任务进行中 / 侧栏绿点）刷新后主动查询并保持 2s 轮询。
- [2026-09-15] 清理企业微信桥接：删除 `bridge.js` 微信入口（onTextMessage/命令解析/审批提问推送/会话映射/去重）、`store.js`、`test-bridge.js`、`test-concurrency.js`、`data/*.json` 及 `respondCancel`；网页为唯一入口，零依赖单一路径。

## 踩坑
- Cloudflare 隧道必须显式 `--protocol http2`（QUIC/7844 被墙）；部分网络下还需 `--edge-ip-version 4` 强制 IPv4（IPv6 边缘超时）
- 页面能开但 API 403 → 把 `*.ts.net` 域名加进 DSH `trustedHosts`
- 换网络后隧道会自动重连；掉线则重启隧道/桥接即可
