# 项目上下文速查（PROJECT_STATE）

> 用途：本对话上下文快满，此文件为精炼版关键状态，供续接/重置后快速恢复。
> 完整文档见同目录 `README.md`。

## 一句话
已做成：**DSH 手机网页 + 企业微信桥接**，全部自建，走 DSH loopback `/api` + 桥接 HTTP 服务 + cloudflared 隧道。

## 运行状态（当前）
- 桥接：`node src/index.js`（127.0.0.1:8787），运行中。
- 隧道：`cloudflared tunnel --protocol http2 --config ~/.cloudflared/config-dsh.yml run dsh-bridge`，运行中。
- DSH Web：`dsh web`（127.0.0.1:3080），运行中（本对话就跑在里面）。

## 访问地址
- 手机网页：`https://chat.your-domain.com`，密码 `你的密码`（`WEB_PASSWORD`）。
- 企业微信回调：`https://bridge.your-domain.com/wecom/callback`。
- 域名 `your-domain.com` 托管在 Cloudflare。

## 关键文件
- 项目：`D:\Software\AI Tools\DeepSeek Harness\phone\dsh-roam\`
- 前端：`web/index.html`（单文件）；logo：`web/logo.svg`（官方鲸鱼）。
- 桥接核心：`src/bridge.js`；Web API+静态：`src/server.js`；DSH 客户端：`src/dsh/client.js`；企业微信加解密：`src/wecom/crypto.js`。
- 配置：`.env`；余额密钥：`~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`。
- 隧道配置：`~/.cloudflared/config-dsh.yml`。

## 核心机制
- 网页/企业微信 → cloudflared 隧道 → 桥接 8787 → DSH 3080（loopback `/api`）。
- **桥接**：一面驱动 DSH（会话/流式/提问/审批/模型/余额），一面服务网页 + 转发企业微信回调。**不依赖 DSH 插件槽位、不依赖 Cloudflare Access**。
- **手机网页 API**（密码 Bearer）：`/web/api/sessions | history | new | send(SSE) | cancel | pending | respond | model(GET/POST) | balance`。

## 关键踩坑（重要）
- **企业微信加解密**：用 **32 字节 PKCS#7 填充**（非 AES 标准 16）。`setAutoPadding(false)` + 手动 pad/unpad(32)。
- **cloudflared**：必须用**显式 `--protocol http2` CLI 参数**（光配置里的 `protocol: http2` 会被预检覆盖成 QUIC，而 QUIC/7844 被墙）。换网络后隧道会自动重连，但若掉线需重启隧道。
- **模型菜单点不开**：按钮点击冒泡到 document 全局关闭；已用 `event.stopPropagation()` 修。
- **余额只显示人民币**：`loadBalance` 优先取 CNY；点击带转圈动画。
- **企业微信 60020**：调用 IP 不在「企业可信IP」白名单；动态 IP 需更新（或换固定出口/VPS）。
- **加 `no-store`** 响应头：避免手机网页缓存旧版，刷新即最新。
- **手机端不同步最新消息** → `syncHistory` 之前被滞留的 `agentRunningSet` 误跳过；已改为只跳过 `webRunningSet`（网页自己流式）。
- **`dsh-web-auth-gateway` 插件已弃用**（版本不兼容 DSH 0.1.1）；改用自建方案。

## 已实现功能
- 响应式网页（手机抽屉侧栏 / 桌面居中限宽 780px）：会话列表/切换/新建/打断（**按会话独立**）、聊天（**短回复整段升起 / 长回复转流式** + 输入浮入 + **断线自动恢复**）、提问选项按钮、审批允许/拒绝、**文件上传**（md/txt 文本 + 图片）、每条消息复制按钮、余额（¥ 仅人民币，点击刷新+转圈）、**模型管理（输入框上方状态条，左右两栏：模型/思考强度）**、**三段式主题**（深/浅/自动随系统）、**本次对话消费**（余额左侧，整段对话累计）、**手动刷新按钮**（侧栏 🔄）、官方 logo（侧栏顶部）。
- **加载与缓存**：打开会话只拉最近 20 条 + "加载更多"（分页）；**会话缓存**（切回秒显）+ **localStorage 持久化**（刷新秒开）；**后台预载**（侧栏开关，5s 拉非当前会话最新 20 条并缓存）+ **未读徽章** + 点击跳最早未读 + 未读持久化；**清理缓存**（保留5条/全清）。
- **可靠性**：SSE 心跳保活（5s）+ 断线自动恢复（轮询历史捞回复）；运行状态实时刷新（`/web/api/status`，打断按钮/「任务进行中」提示切走不丢）；`no-store` 禁缓存。
- **一键启动脚本**：`scripts/start-all.ps1` / `start-all.sh`——幂等拉起三进程（含 `--protocol http2`），可开机自启（Y=加 / N=移；自启用 `-Silent`）。
- 企业微信桥接：多轮会话、流式回推、命令（列表/切换/新建/退出/记录/打断/取消/帮助）、提问/审批文本式。

## ⚠️ 工作流约定（重要）
网页端任何改动、需要**重启桥接服务**时：**先发审批确认（问用户是否允许重启）→ 等用户批准 → 再重启**。否则手机上正在处理的其他对话会因重启而半路断开。

## 待办/可选
- 权限预设调整：手机端未做；用 PC 界面下拉框或 DSH `/permission` 命令。
- 官方 logo 字标："deepseek" 是代码排版（近原版），非精确 SVG；CDN 被墙，需用户提供 SVG 或硬啃打包文件。
- 企业微信 IP 白名单：若动态 IP 烦，可换固定出口或 VPS。
