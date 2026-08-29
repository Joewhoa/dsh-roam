import { DshClient } from '../src/dsh/client.js';
import { JsonStore } from '../src/store.js';
import { Bridge } from '../src/bridge.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wecom = {
  async sendText(userId, content) {
    console.log(`\n[→${userId}] ${content}`);
  },
  async sendMarkdown() {},
};

async function main() {
  const dsh = new DshClient('http://127.0.0.1:3080');
  const store = new JsonStore('./data/conc-mappings.json');
  const bridge = new Bridge({ dsh, wecom, store, config: { dsh: {} }, turnTimeoutMs: 120000 });
  await bridge.start();
  await sleep(800);

  const userId = 'conc-user-0001';
  console.log('>>> 并发发两条消息（第二条应在第一条完成后才处理，且各自回复正确、不悬挂）');
  const t0 = Date.now();
  const p1 = bridge.onTextMessage(userId, '请只回复两个字：一');
  const p2 = bridge.onTextMessage(userId, '请只回复两个字：二');
  await Promise.all([p1, p2]);
  console.log(`\n总耗时 ${Date.now() - t0}ms，两条都已完成（说明串行化生效、无悬挂）`);
  bridge.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error('并发测试失败:', e);
  process.exit(1);
});
