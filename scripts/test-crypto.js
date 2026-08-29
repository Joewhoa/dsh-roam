import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, signature, parseXml, aesKey, buildReplyXml, buildEncryptXml, xmlEscape } from '../src/wecom/crypto.js';

// 造一套可复现的密钥：EncodingAESKey = base64(32字节) 去掉末尾 '='
const encodingAesKey = Buffer.from(randomBytes(32)).toString('base64').slice(0, 43);
const token = 'testToken123';
const corpId = 'ww1234567890abcdef';

console.log('EncodingAESKey:', encodingAesKey, `(len=${encodingAesKey.length})`);
console.log('key bytes =', aesKey(encodingAesKey).length, '（应为 32）\n');

// 1) 加密 → 验签 → 解密 往返
const msg = '<xml><ToUserName><![CDATA[ww1234567890abcdef]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好，DSH]]></Content></xml>';
const enc = encrypt(encodingAesKey, token, msg, corpId);
console.log('encrypt.msgSignature:', enc.msgSignature);
console.log('验签结果:', signature(token, enc.timestamp, enc.nonce, enc.encrypt) === enc.msgSignature ? '✅ 通过' : '❌ 失败');

const dec = decrypt(encodingAesKey, enc.encrypt);
console.log('解密 corpId 一致:', dec.corpId === corpId ? '✅ 通过' : `❌ 失败 (${dec.corpId})`);
console.log('解密 message 一致:', dec.message === msg ? '✅ 通过' : '❌ 失败');
console.log('解密 message 内容:\n', dec.message, '\n');

// 2) XML 解析
const parsed = parseXml(msg);
console.log('parseXml →', JSON.stringify(parsed));

// 3) 回复 XML + 外层加密包裹
const reply = buildReplyXml({ toUser: parsed.FromUserName, fromUser: corpId, content: '收到，正在处理…' });
const replyEnc = encrypt(encodingAesKey, token, reply, corpId);
const outer = buildEncryptXml(replyEnc);
console.log('\n回复明文:\n', reply);
console.log('\n回复加密外层(截断):\n', outer.slice(0, 180) + '…');

// 4) xmlEscape 自检
console.log('\nxmlEscape:', xmlEscape('a<b>&"c"'));
