import { config } from './config.js';
import { DshClient } from './dsh/client.js';
import { WecomClient } from './wecom/client.js';
import { JsonStore } from './store.js';
import { Bridge } from './bridge.js';
import { createWecomHandler } from './wecom/callback.js';
import { createBridgeServer } from './server.js';

const log = console;

function checkWecomConfig() {
  const missing = Object.entries(config.wecom)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    log.warn(`[startup] 企业微信配置缺失: ${missing.join(', ')} —— 回调加解密与主动推送不可用，仅启动 DSH 侧与 HTTP 服务。请在 .env 补齐后重启。`);
  }
}

async function main() {
  const dsh = new DshClient(config.dsh.baseUrl);

  // 冒烟：确认 DSH 可达。
  try {
    await dsh.sessionList({});
    log.info(`[startup] DSH 可达: ${config.dsh.baseUrl}`);
  } catch (e) {
    log.error('[startup] DSH 不可达，退出:', e.message);
    process.exit(1);
  }

  const store = new JsonStore(config.store.path);
  const wecom = new WecomClient(config.wecom);
  const bridge = new Bridge({ dsh, wecom, store, config, log });
  await bridge.start();

  const handler = createWecomHandler({ config, bridge, log });
  const server = createBridgeServer({ handler, bridge, config, log });
  server.listen(config.server.port, () => {
    log.info(`[startup] 桥接已启动: http://127.0.0.1:${config.server.port}`);
    log.info(`[startup] 企业微信回调地址（经 Cloudflare Tunnel 暴露）应指向: /wecom/callback`);
    log.info(`[startup] 手机网页: http://127.0.0.1:${config.server.port}/ （公网经隧道 chat.your-domain.com）`);
  });

  const shutdown = () => {
    log.info('[startup] 正在关闭…');
    bridge.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

checkWecomConfig();
main().catch((e) => {
  log.error('[startup] 启动失败:', e);
  process.exit(1);
});
