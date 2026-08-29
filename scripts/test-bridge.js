import { DshClient } from '../src/dsh/client.js';
import { JsonStore } from '../src/store.js';
import { Bridge } from '../src/bridge.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mock 企业微信客户端：把 sendText 打印到控制台，代替真实 API。
const mockWecom = {
  async sendText(userId, content) {
    console.log(`\n[wecom → ${userId}] ↓↓↓ 最终回复 ↓↓↓\n${content}\n`);
  },
  async sendMarkdown(userId, content) {
    console.log(`[wecom → ${userId}] markdown:\n${content}`);
  },
};

async function main() {
  const dsh = new DshClient('http://127.0.0.1:3080');
  const store = new JsonStore('./data/test-mappings.json');
  const bridge = new Bridge({
    dsh,
    wecom: mockWecom,
    store,
    config: { dsh: {} },
    turnTimeoutMs: 120000,
  });

  await bridge.start();
  await sleep(800); // 等 mux 连上

  const userId = 'test-user-0001';
  const q = process.argv[2] ?? '请只回复两个字：pong';
  console.log(`>>> 用户 ${userId} 发送: ${q}`);
  await bridge.onTextMessage(userId, q);

  // 再发一条，验证多轮复用同一会话（不新建）。
  const q2 = process.argv[3];
  if (q2) {
    await sleep(300);
    console.log(`\n>>> 用户 ${userId} 继续发送: ${q2}`);
    await bridge.onTextMessage(userId, q2);
  }

  const sid = store.get(userId);
  console.log(`\n映射已持久化: ${userId} → ${sid}`);
  bridge.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
