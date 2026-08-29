import { randomBytes } from 'node:crypto';
import { config } from '../src/config.js';
import { DshClient } from '../src/dsh/client.js';
import { WecomClient } from '../src/wecom/client.js';
import { JsonStore } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { createWecomHandler } from '../src/wecom/callback.js';
import { createBridgeServer } from '../src/server.js';
import { encrypt, decrypt, parseXml } from '../src/wecom/crypto.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST = {
  token: 'e2e-test-token',
  encodingAesKey: Buffer.from(randomBytes(32)).toString('base64').slice(0, 43),
  corpId: 'ww-e2e-test-corp',
  agentId: '1000002',
  userId: 'e2e-user-0001',
};

async function main() {
  const dsh = new DshClient(config.dsh.baseUrl);
  const store = new JsonStore('./data/e2e-mappings.json');
  const wecom = new WecomClient({ ...TEST, secret: 'test-secret', dryRun: true });
  const bridge = new Bridge({ dsh, wecom, store, config: { dsh: config.dsh }, turnTimeoutMs: 120000 });
  await bridge.start();

  const handler = createWecomHandler({
    config: { wecom: { token: TEST.token, encodingAesKey: TEST.encodingAesKey, corpId: TEST.corpId } },
    bridge,
  });
  const server = createBridgeServer({ handler });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await sleep(800); // 等 mux 连上

  const q = process.argv[2] ?? '请只回复两个字：pong';
  console.log(`=== 端到端自测：GET 验证 + 加密回调 → 验签解密 → DSH → 流式 → 回推 ===`);

  // ① GET 验证（企业微信保存回调配置时第一步做的，echostr 为加密值）
  const echostrPlain = 'verify-me-123456';
  const echostrEnc = encrypt(TEST.encodingAesKey, TEST.token, echostrPlain, TEST.corpId);
  const getRes = await fetch(
    `http://127.0.0.1:${port}/wecom/callback?msg_signature=${echostrEnc.msgSignature}&timestamp=${echostrEnc.timestamp}&nonce=${echostrEnc.nonce}&echostr=${encodeURIComponent(echostrEnc.encrypt)}`
  );
  const got = await getRes.text();
  console.log(`GET 验证 HTTP ${getRes.status}，回显 ${got === echostrPlain ? '✅ 匹配' : `❌ 不匹配（got=${got}）`}\n`);

  // ② 加密消息回调
  console.log(`模拟用户 ${TEST.userId} 发送: ${q}\n`);

  // 构造一条企业微信加密文本消息
  const msgXml =
    `<xml><ToUserName><![CDATA[${TEST.corpId}]]></ToUserName>` +
    `<FromUserName><![CDATA[${TEST.userId}]]></FromUserName>` +
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>` +
    `<MsgType><![CDATA[text]]></MsgType>` +
    `<Content><![CDATA[${q}]]></Content>` +
    `<MsgId>123456789</MsgId><AgentID>${TEST.agentId}</AgentID></xml>`;
  const enc = encrypt(TEST.encodingAesKey, TEST.token, msgXml, TEST.corpId);
  const bodyXml = `<xml><Encrypt><![CDATA[${enc.encrypt}]]></Encrypt></xml>`;

  const res = await fetch(
    `http://127.0.0.1:${port}/wecom/callback?msg_signature=${enc.msgSignature}&timestamp=${enc.timestamp}&nonce=${enc.nonce}`,
    { method: 'POST', headers: { 'content-type': 'text/xml' }, body: bodyXml }
  );
  const ackXml = await res.text();
  const ackOuter = parseXml(ackXml);
  const ackPlain = decrypt(TEST.encodingAesKey, ackOuter.Encrypt).message;
  console.log(`回调 HTTP ${res.status}`);
  console.log(`被动回复(解密后): ${ackPlain.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/)?.[1] ?? '(未解析)'}\n`);

  console.log('等待 agent 完成并回推最终回复（下方 dry-run 日志）…\n');
  await sleep(15000);

  const sid = store.get(TEST.userId);
  console.log(`\n映射已持久化: ${TEST.userId} → ${sid}`);
  bridge.stop();
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('端到端自测失败:', e);
  process.exit(1);
});
