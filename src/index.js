import { config } from './config.js';
import { DshClient } from './dsh/client.js';
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

  const bridge = new Bridge({ dsh, config, log });
  await bridge.start();

  if (!config.web.password) {
    log.warn('[security] WEB_PASSWORD 未设置：仅允许本机 loopback 访问；通过隧道暴露前必须设置密码。');
  }
  const server = createBridgeServer({ bridge, config, log });
  server.listen(config.server.port, '127.0.0.1', () => {
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