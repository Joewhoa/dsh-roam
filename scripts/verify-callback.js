import { config } from '../src/config.js';
import { encrypt, signature, parseXml } from '../src/wecom/crypto.js';

const { token, encodingAesKey, corpId } = config.wecom;
const BASE = 'https://bridge.your-domain.com/wecom/callback';

async function main() {
  const echostr = 'verify-echostr-1234567890';
  const enc = encrypt(encodingAesKey, token, echostr, corpId);
  const url =
    `${BASE}?msg_signature=${enc.msgSignature}&timestamp=${enc.timestamp}` +
    `&nonce=${enc.nonce}&echostr=${encodeURIComponent(enc.encrypt)}`;

  const res = await fetch(url);
  const body = await res.text();
  console.log(`GET ${BASE}`);
  console.log(`HTTP ${res.status}`);
  console.log(`响应: ${body}`);
  const ok = body === echostr;
  console.log(`\n=== ${ok ? '✅ 通过：企业微信保存 URL 的验证能通过' : '❌ 不匹配'} ===`);
  if (!ok) {
    console.log(`期望回显: ${echostr}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
