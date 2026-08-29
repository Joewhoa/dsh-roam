/**
 * 企业微信「自建应用」主动调用客户端（gettoken + message/send）。
 * 用于把 DSH 的回复/进度主动推回给用户（绕开 5s 被动回复限制）。
 */
const API = 'https://qyapi.weixin.qq.com/cgi-bin';

export class WecomClient {
  constructor({ corpId, agentId, secret, dryRun = false }) {
    this.corpId = corpId;
    this.agentId = agentId;
    this.secret = secret;
    this.dryRun = dryRun;
    this._token = null; // { access_token, expiresAt }
  }

  async getAccessToken() {
    if (this.dryRun) return 'dry-run-token';
    if (this._token && Date.now() < this._token.expiresAt) return this._token.access_token;
    const url = `${API}/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.secret)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.errcode !== 0) throw new Error(`gettoken 失败: ${data.errcode} ${data.errmsg}`);
    this._token = {
      access_token: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 300) * 1000, // 提前 5 分钟过期
    };
    return this._token.access_token;
  }

  async sendText(userId, content) {
    if (this.dryRun) {
      console.log(`[wecom:dry-run → ${userId}] ${content}`);
      return { errcode: 0, dryRun: true };
    }
    return this._send({
      touser: userId,
      msgtype: 'text',
      agentid: this.agentId,
      text: { content },
      safe: 0,
    });
  }

  async sendMarkdown(userId, content) {
    if (this.dryRun) {
      console.log(`[wecom:dry-run → ${userId}] markdown:\n${content}`);
      return { errcode: 0, dryRun: true };
    }
    return this._send({
      touser: userId,
      msgtype: 'markdown',
      agentid: this.agentId,
      markdown: { content },
    });
  }

  async _send(body) {
    const token = await this.getAccessToken();
    const res = await fetch(`${API}/message/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.errcode !== 0) throw new Error(`message/send 失败: ${data.errcode} ${data.errmsg}`);
    return data;
  }
}
