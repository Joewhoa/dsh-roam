# 项目上线 GitHub 交接文档（给接手智能体）

> 本文件专门写给接手上线/润色的智能体：读完即可理解项目、准备 GitHub 发布、避免泄密。完整技术细节见 `README.md` 与 `PROJECT_STATE.md`。

## 一、项目是什么

**DSH 手机远程控制台（dsh-roam）**：把本机 **DeepSeek Harness（DSH）** 接入手机/桌面 —— 一个 DeepSeek 风格的**响应式网页**（会话/聊天/流式/提问审批/余额/模型切换/缓存预载/文件上传/主题切换/对话消费）+ 一个**可选的企业微信消息通道**。全部**自建**，走 DSH loopback `/api` + 桥接 HTTP 服务 + Cloudflare 隧道。

## 一·五、当前功能全览（写 README/简历用）

**聊天与会话**
- 会话列表/切换/新建/打断（打断按会话独立）；聊天 + 流式回复（短回复整段升起 / 长回复转流式）；提问选项按钮、审批允许/拒绝；文件上传（md/txt 文本 + 图片）；每条消息下方复制按钮。

**界面与主题**
- 官方 logo（鲸鱼+deepseek+HARNESS，侧栏顶部）；三段式主题开关（深色/浅色/自动随系统）；响应式（手机抽屉侧栏 / 桌面居中限宽 780px）。

**智能增强**
- 模型管理（输入框上方状态条，点开左右两栏：模型/思考强度）；本次对话消费（余额左侧，对话结束显示，按整段对话累计）；余额查询（¥ 仅人民币，点击刷新）；手动刷新按钮（侧栏 🔄）。

**性能与可靠性**
- 会话缓存（切回秒显）+ localStorage 持久化（刷新秒开）；后台预载（侧栏开关，5s 拉非当前会话最新消息并缓存）+ 未读徽章 + 点击跳最早未读；清理缓存（保留5条/全清）；SSE 心跳保活（5s）+ 断线自动恢复（轮询历史捞回复）；运行状态实时刷新（打断按钮/任务进行中提示不丢）；`no-store` 禁缓存。

**可选扩展：企业微信消息通道**
- 多轮会话、流式回推、命令（列表/切换/新建/退出/记录/打断/取消/帮助）、提问/审批文本式（纯文字、无 UI）。

**部署**
- 一键启动脚本（Windows `.ps1` + Mac `.sh`，幂等 + 开机自启）；零 npm 依赖、单文件前端；跨平台。

## 二、一句话卖点 / 差异化（写 README 时用）

> 纯自建、**不依赖 DSH 插件槽位**（DSH 升级不崩）+ **Cloudflare 公网隧道**（非局域网）+ **完整 DeepSeek 风格响应式 UI**（流式、提问/审批按钮、模型切换、余额、缓存/预载/未读、文件上传、主题切换、对话消费）+ **跨平台一键部署 + 开机自启**。

与 GitHub 上雷同项目的区别：多数是「Android/Termux 本地跑」或「局域网访问」或「单一 IM 桥接」；本项目是**PC 跑 + 公网隧道 + 完整响应式 UI**（+ 可选企业微信通道）的组合，且**零 npm 依赖、单文件前端**，复现门槛低。

## 三、技术栈

- **后端**：Node.js（纯 ESM，**无第三方 npm 依赖**，`node src/index.js` 直接跑）。
- **前端**：原生 HTML/CSS/JS（`web/index.html` 单文件，无构建）。
- **集成**：DSH `/api`（loopback 一元 RPC + WebSocket 事件流 + respond）、cloudflared 命名隧道、企业微信自建应用回调（AES 加解密）。

## 四、核心文件结构

```
dsh-roam/
├── src/
│   ├── bridge.js        # 桥接核心：会话映射、流式、提问/审批、模型
│   ├── server.js        # HTTP 服务：静态网页 + /web/api/* 接口
│   ├── config.js        # 读 .env + 深度求索 API 密钥
│   ├── store.js         # JSON 持久化（用户↔会话映射）
│   ├── dsh/client.js    # DSH /api 客户端
│   └── wecom/           # 企业微信：callback / client / crypto
├── web/index.html       # 手机网页前端（单文件）
├── web/logo.svg         # 官方鲸鱼 logo
├── scripts/             # 一键启动 + 自测脚本
├── README.md            # 完整文档（含部署复现）
└── PROJECT_STATE.md     # 精炼速查（架构/踩坑/功能）
```

## 五、发布前必做（重要）

1. **`.gitignore`**：排除 `.env`、`data/`、`node_modules/`、`.cloudflared/`（隧道凭证）、`*.log`。
2. **`LICENSE`**：加 MIT（或用户指定）。
3. **去敏**：确认以下**不进仓库**（见下一节清单）。
4. **README 英文版** + 一张**架构图**（mermaid：手机/微信 → 隧道 → 桥接 → DSH）。
5. **截图/GIF** 放 README 演示（手机网页主界面、模型菜单、提问审批、余额）。

## 六、敏感信息清单（绝不能进 GitHub）

| 位置 | 内容 |
|---|---|
| `.env` | `WECOM_SECRET`、`WECOM_ENCODING_AES_KEY`、`WECOM_TOKEN`、`WEB_PASSWORD`、`DSH_URL` |
| `.cloudflared/*.json` | 隧道 credentials（`b9e1e6a7-*.json` 等） |
| `data/mappings.json` | 微信 userid ↔ 会话映射 |
| `~/.dsh/.credentials.yaml` | `DEEPSEEK_API_KEY`（不在项目内，但注意别误抄） |

> 注意：`.env.example` 里应只保留**占位符**，不要出现真实值；README/PROJECT_STATE 里若写了密码/域名/密钥，上线前要么改占位、要么确认是**示例值**。

## 七、雷同项目（供 README 对比/引用）

- [dsh-chatops](https://github.com/ZhuoSir/dsh-chatops) — 微信/飞书 IM 桥接
- [dsh-mobile](https://github.com/saya-ch/dsh-mobile) — 移动端适配 + 局域网
- [dsh-pocket](https://github.com/shaobeichen/dsh-pocket) — PC 跑 + 手机扫码访问
- [deepseek-harness-wecom-plus](https://github.com/fryghost/deepseek-harness-wecom-plus) — 企业微信增强
- Android 本地方案：deepseek-harness-android / dsh-mobile-apk / deepseek-harness-mobile

## 八、可选丰富化（提升作品观感，按价值排序）

1. **Markdown 渲染 + 代码高亮**（消息气泡现在纯文本，改 Markdown 最直观加分）。
2. **PWA**（`manifest.json` + service worker，手机"添加到主屏幕"像原生 app）。
3. **深/浅主题切换**（现在只有深色）。
4. 会话**重命名/删除/归档**。
5. 中英文 i18n。

## 九、本地跑起来（演示用）

```bash
# 三个进程（或直接用一键脚本 scripts/start-all.ps1 / start-all.sh）
dsh web                                        # DSH 本体（3080）
node src/index.js                              # 桥接（8787，cd 到项目目录）
cloudflared tunnel --protocol http2 \
  --config ~/.cloudflared/config-dsh.yml run dsh-bridge   # 隧道
```

> 一键脚本会幂等拉起三进程，末尾询问是否开机自启（Y/N）。

## 十、注意事项（写文档/README 时会用到）

- **代码注释一律用中文**（技术专有名词如 AES-CBC、PKCS#7、SSE 可保留英文）；用户会亲自读代码。
- **隧道必须 `--protocol http2`**（QUIC/7844 被墙；光配置 `protocol: http2` 会被预检覆盖）。
- **企业微信加解密用 32 字节 PKCS#7 填充**（企业微信特有，非 AES 标准 16）。
- **余额密钥**：桥接自动读 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`，密钥只在服务端。
- **跨平台**：桥接零 npm 依赖、单文件前端，Windows/macOS/Linux 通用（脚本已区分）。
