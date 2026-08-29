import { decrypt, encrypt, signature, parseXml, buildReplyXml, buildEncryptXml } from './crypto.js';

const ACK = '收到，正在处理…';

/**
 * 企业微信回调处理器：GET 验证（echostr）+ POST 消息（验签/解密 → 派发 → 被动回复）。
 */
export function createWecomHandler({ config, bridge, log = console }) {
  const { token, encodingAesKey, corpId } = config.wecom;

  const ok = (v) => ({ ok: true, ...v });
  const fail = (error) => ({ ok: false, error });

  /** GET 验证：加密模式验签+解密，明文模式直接回显。 */
  function verifyEchostr(query) {
    const { msg_signature: msgSig, timestamp, nonce, echostr } = query;
    if (!echostr) return fail('missing echostr');
    if (msgSig && token && encodingAesKey) {
      if (signature(token, timestamp, nonce, echostr) !== msgSig) return fail('signature mismatch');
      return ok({ echostr: decrypt(encodingAesKey, echostr).message });
    }
    return ok({ echostr });
  }

  /** POST 消息：解密 → 派发异步 → 同步返回被动回复 XML。 */
  function handleMessage(query, bodyXml) {
    const { msg_signature: msgSig, timestamp, nonce } = query;
    const body = parseXml(bodyXml);

    // 明文模式：body 直接是消息。
    if (body.Encrypt === undefined) {
      bridge.dispatchMessage(body).catch((e) => log.error('[wecom] 异步处理失败:', e));
      return buildReplyXml({ toUser: body.FromUserName, fromUser: corpId, content: ACK });
    }

    if (signature(token, timestamp, nonce, body.Encrypt) !== msgSig) return fail('signature mismatch');
    let dec;
    try {
      dec = decrypt(encodingAesKey, body.Encrypt);
    } catch (e) {
      log.error('[wecom] 解密失败:', e.message);
      log.error('[wecom] query:', JSON.stringify(query));
      log.error('[wecom] 原始 body(前200字符):', String(bodyXml).slice(0, 200));
      log.error('[wecom] Encrypt 字段长度:', String(body.Encrypt).length);
      return fail('decrypt failed');
    }
    if (corpId && dec.corpId && dec.corpId !== corpId) {
      log.warn(`[wecom] corpId 不匹配：预期 ${corpId}，实际 ${dec.corpId}`);
    }
    const msg = parseXml(dec.message);

    bridge.dispatchMessage(msg).catch((e) => log.error('[wecom] 异步处理失败:', e));

    const reply = buildReplyXml({ toUser: msg.FromUserName, fromUser: corpId, content: ACK });
    return buildEncryptXml(encrypt(encodingAesKey, token, reply, corpId));
  }

  return { verifyEchostr, handleMessage };
}
