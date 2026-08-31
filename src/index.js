import { config } from './config.js';
import { DshClient } from './dsh/client.js';
import { JsonStore } from './store.js';
import { Bridge } from './bridge.js';
import { createBridgeServer } from './server.js';

const log = console;

async function main() {
  const dsh = new DshClient(config.dsh.baseUrl);

  // 冒烟：确认 DSH 可达（启动时 DSH 可能还没就绪，重试最多 5 次）
  let dshReady = false;
  for (let i = 1; i <= 5; i++) {
    try {
      await dsh.sessionList({});
      dshReady = true;
      break;
    } catch (e) {
      if (i < 5) {
        log.warn(`[startup] DSH 未就绪（${i}/5），3 秒后重试...`);
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        log.error('[startup] DSH 不可达，退出:', e.message);
      }
    }
  }
  if (!dshReady) process.exit(1);
  log.info(`[startup] DSH 可达: ${config.dsh.baseUrl}`);

  const store = new JsonStore(config.store.path);
  // 不含企业微信桥接（Bridge 内部对 wecom 使用 no-op）。
  const bridge = new Bridge({ dsh, store, config, log });
  await bridge.start();

  const server = createBridgeServer({ bridge, config, log });
  server.listen(config.server.port, () => {
    log.info(`[startup] 桥接已启动: http://127.0.0.1:${config.server.port}`);
    log.info('[startup] 手机/桌面浏览器经隧道访问（Tailscale：https://<机器名>.<tailnet>.ts.net/ 或 Cloudflare：你的域名）');
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

main().catch((e) => {
  log.error('[startup] 启动失败:', e);
  process.exit(1);
});