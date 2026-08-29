import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * 企业微信「自建应用」回调消息的加解密（安全模式）。
 *
 * 参考企业微信官方「接收消息」协议：
 *  - 签名：SHA1( sort([token, timestamp, nonce, encrypt]).join('') )，GET 验证时第 4 项是 echostr。
 *  - 加密：AES-256-CBC，key = base64(EncodingAESKey + '=')，iv = key 前 16 字节。
 *  - 明文结构：16 字节随机 + 4 字节大端消息长度 + 消息明文(XML) + receiveid(=CorpId)。
 *  - 填充：PKCS#7，但块大小为 32 字节（企业微信特有，非 AES 标准 16 字节）。
 */

const BLOCK = 32; // 填充块大小：企业微信用 32 字节块做 PKCS#7 填充
const PREFIX_LEN = 20; // 16 随机 + 4 长度

/** AES key：EncodingAESKey(43 字符) 补 '=' 后 base64 解码为 32 字节。 */
export function aesKey(encodingAesKey) {
  if (encodingAesKey.length !== 43) throw new Error(`EncodingAESKey 必须为 43 字符，当前 ${encodingAesKey.length}`);
  return Buffer.from(encodingAesKey + '=', 'base64');
}

/** 校验/生成消息签名。 */
export function signature(token, timestamp, nonce, encrypt) {
  const s = [token, timestamp, nonce, encrypt].sort().join('');
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

/** PKCS#7 填充到 blockSize 的倍数。 */
function pkcs7Pad(buf, blockSize) {
  const padLen = blockSize - (buf.length % blockSize);
  const pad = Buffer.alloc(padLen, padLen);
  return Buffer.concat([buf, pad]);
}

/** 去除 PKCS#7 填充（按 32 字节块）。 */
function pkcs7Unpad(buf) {
  if (buf.length === 0) throw new Error('empty plaintext');
  const padLen = buf[buf.length - 1];
  if (padLen < 1 || padLen > BLOCK || padLen > buf.length) throw new Error(`invalid padding length ${padLen}`);
  return buf.subarray(0, buf.length - padLen);
}

/** 解密：encrypt(base64) → { message: <XML字符串>, corpId }。 */
export function decrypt(encodingAesKey, encryptB64) {
  const key = aesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false); // 企业微信是 32 字节块填充，关闭 Node 默认 16 字节填充
  const padded = Buffer.concat([decipher.update(Buffer.from(encryptB64, 'base64')), decipher.final()]);
  const raw = pkcs7Unpad(padded);
  const msgLen = raw.readUInt32BE(16);
  const message = raw.subarray(PREFIX_LEN, PREFIX_LEN + msgLen).toString('utf8');
  const corpId = raw.subarray(PREFIX_LEN + msgLen).toString('utf8');
  return { message, corpId };
}

/** 加密：明文 XML → { encrypt(base64), msgSignature, timestamp, nonce }。 */
export function encrypt(encodingAesKey, token, message, corpId = '', { timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomHex(16) } = {}) {
  const key = aesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const msgBuf = Buffer.from(message, 'utf8');
  const corpIdBuf = Buffer.from(corpId, 'utf8');
  // 明文：16 随机 + 4 长度 + msg + corpId
  const raw = Buffer.concat([
    randomBytes(16),
    lenBuf(msgBuf.length),
    msgBuf,
    corpIdBuf,
  ]);
  const padded = pkcs7Pad(raw, BLOCK);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encrypt = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
  const msgSignature = signature(token, timestamp, nonce, encrypt);
  return { encrypt, msgSignature, timestamp, nonce };
}

function lenBuf(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

/** 解析企业微信消息 XML（扁平字段 → 对象）。支持 CDATA 与纯文本；跳过根标签。 */
export function parseXml(xml) {
  const out = {};
  if (typeof xml !== 'string') return out;
  // 普通文本分支用 [^<>]*?，避免 <xml> 根标签把内层字段一起吞掉；CDATA 分支可含任意字符。
  for (const m of xml.matchAll(/<(\w+)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<>]*?))\s*<\/\1>/g)) {
    const name = m[1];
    if (name === 'xml') continue;
    out[name] = m[2] !== undefined ? m[2] : (m[3] ?? '').trim();
  }
  return out;
}

/** XML 转义（用于拼回复 XML）。 */
export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 构造一条被动回复用的明文 XML（text 类型）。To/From 已按回复方向对调。 */
export function buildReplyXml({ toUser, fromUser, content }) {
  return `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName><FromUserName><![CDATA[${fromUser}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content></xml>`;
}

/** 构造回调响应用的加密 XML 外层。 */
export function buildEncryptXml({ encrypt, msgSignature, timestamp, nonce }) {
  return `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt><MsgSignature><![CDATA[${msgSignature}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;
}
