import { DshClient } from './dsh/client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 session 事件里提取 assistant 的流式文本增量（text-delta）。 */
function assistantDelta(ev) {
  if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'text-delta') {
    return ev.data.chunk.text ?? '';
  }
  return '';
}

/** 从 assistant/message 事件里提取完整文本（拼接所有 text 块）。 */
function assistantMessageText(ev) {
  if (ev.type !== 'assistant/message') return '';
  const content = ev.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/** 从内容块数组里拼接所有 text 块的文本。 */
function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ');
}

/** 按 UTF-8 字节数安全截断（企业微信 text 上限约 2048 字节）。 */
function truncateBytes(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  // 回退到完整字符边界
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString('utf8')}\n\n（已截断）`;
}

/**
 * 桥接核心：一端驱动 DSH（会话映射 + prompt + 流式），一端把结果推回企业微信。
 */
export class Bridge {
  constructor({ dsh, wecom, store, config, log = console, turnTimeoutMs = 10 * 60 * 1000 }) {
    this.dsh = dsh;
    this.wecom = wecom;
    this.store = store;
    this.config = config;
    this.log = log;
    this.turnTimeoutMs = turnTimeoutMs;
    this.pending = new Map(); // sessionId -> 等待流式完成的句柄 { resolve, timer, parts, lastMessageText }
    this.sessionUser = new Map(); // sessionId -> userId（反向映射，用于把审批/提问推回给对应用户）
    this.decisions = new Map(); // userId -> { kind:'approval'|'question', sessionId, rpcId, approvalId?, questions? }
    this.pendingQuestions = new Map(); // sessionId -> { rpcId, questions }（Web 端展示用）
    this.pendingApprovals = new Map(); // sessionId -> { rpcId, approvalId, toolName, reason }（Web 端展示用）
    this.sessionLocks = new Map(); // sessionId -> Promise（按会话串行化，避免并发串话）
    this.creating = new Map(); // userId -> Promise<sessionId>（新建会话去重）
    this.sessionLists = new Map(); // userId -> [sessionId]（最近一次「列表」结果，供「切换 N」解析）
    this.turnCosts = new Map();    // sessionId -> 当前 turn 的成本聚合 { turn, cost, tokens, model, lastTs }
    this.sessionCost = new Map(); // sessionId -> 本次对话累计消费 { amount, tokens, model }（各 turn 之和）
    this.running = false;
  }

  // —— 单次对话消费统计（定价表，仿 dsh-balance-capsule；单位：元 / 百万 token，[空闲, 高峰]）——
  _priceFor(model) {
    const PRICING = [
      { match: 'deepseek-v4-pro', hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] },
      { match: 'deepseek', hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] },
      { match: 'kimi-k3', hit: [3, 3], miss: [21, 21], out: [105, 105] },
      { match: 'kimi-k2', hit: [1, 1], miss: [4, 4], out: [16, 16] },
      { match: 'k2', hit: [1, 1], miss: [4, 4], out: [16, 16] },
      { match: 'moonshot', hit: [1, 1], miss: [4, 4], out: [16, 16] },
      { match: 'kimi', hit: [3, 3], miss: [21, 21], out: [105, 105] },
      { match: '', hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] },
    ];
    const m = String(model || '').toLowerCase();
    for (const p of PRICING) {
      if (p.match === '' || m.includes(p.match)) return p;
    }
    return PRICING[PRICING.length - 1];
  }
  _isPeak() {
    const bj = new Date(Date.now() + 8 * 3600 * 1000);
    const dow = bj.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    const h = bj.getUTCHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  }
  _finalizeTurnCost(sid) {
    const agg = this.turnCosts.get(sid);
    if (agg && agg.cost > 0) {
      // 按会话累计（本次对话总消费 = 各 turn 之和），避免只显示最后一段
      const prev = this.sessionCost.get(sid) ?? { amount: 0, tokens: 0, model: '' };
      this.sessionCost.set(sid, {
        amount: prev.amount + agg.cost,
        tokens: prev.tokens + agg.tokens,
        model: agg.model || prev.model,
      });
    }
    this.turnCosts.delete(sid);
  }
  /** 取某会话累计的"本次对话消费"（无则 null）。 */
  getLastCost(sessionId) {
    return this.sessionCost.get(sessionId) ?? null;
  }

  async start() {
    this.running = true;
    this.muxLoop().catch((e) => this.log.error('[bridge] mux 循环异常退出:', e));
  }

  stop() {
    this.running = false;
  }

  /** 常驻 mux 连接：一条 WebSocket 复用，按 sessionId 分发到 pending 处理器。 */
  async muxLoop() {
    while (this.running) {
      try {
        for await (const frame of this.dsh.eventsMux()) {
          this.dispatch(frame); // frame = { rpcId, payload }
        }
      } catch (e) {
        if (this.running) this.log.warn('[bridge] mux 断开，1s 后重连:', e.message);
      }
      if (this.running) await sleep(1000);
    }
  }

  dispatch(frame) {
    const p = frame.payload ?? {};
    const sid = p.sessionId;
    const h = sid ? this.pending.get(sid) : undefined;

    switch (p.type) {
      case 'session/event': {
        const ev = p.event ?? {};
        const delta = assistantDelta(ev);
        if (h && delta) {
          h.parts.push(delta);
          if (h.onDelta) h.onDelta(delta);
        }
        const msgText = assistantMessageText(ev);
        if (h && msgText) h.lastMessageText = msgText;
        // —— 单次对话消费统计（仿 dsh-balance-capsule：从 usage 算成本）——
        try {
          const d = ev.data ?? {};
          if (ev.type === 'assistant/message') {
            const usage = d.usage;
            const turn = Number(d.turn);
            const model = d.message?.source?.model ?? '';
            if (usage && typeof usage === 'object' && isFinite(turn)) {
              let agg = this.turnCosts.get(sid);
              if (!agg || agg.turn !== turn) {
                if (agg) this._finalizeTurnCost(sid);
                agg = { turn, cost: 0, tokens: 0, model: '', lastTs: Date.now() };
                this.turnCosts.set(sid, agg);
              }
              const input = Number(usage.inputTokens) || 0;
              const cacheHit = Number(usage.cacheReadTokens) || 0;
              const output = Number(usage.outputTokens) || 0;
              const reasoning = Number(usage.reasoningTokens) || 0;
              agg.tokens += input + cacheHit + output + reasoning;
              if (model) agg.model = String(model);
              const pr = this._priceFor(model);
              const off = this._isPeak() ? 1 : 0;
              agg.cost += (cacheHit / 1e6) * pr.hit[off] + (input / 1e6) * pr.miss[off] + ((output + reasoning) / 1e6) * pr.out[off];
              agg.lastTs = Date.now();
            }
          } else if (ev.type === 'turn/end') {
            this._finalizeTurnCost(sid);
          }
        } catch (e) { /* 统计失败不影响主流程 */ }
        if (ev.type === 'turn/end' && h) {
          this._settle(sid, { kind: 'done', text: h.lastMessageText || h.parts.join('') });
        }
        break;
      }
      case 'stream/error':
        if (h) this._settle(sid, { kind: 'error', error: p.error });
        break;
      case 'approval/requested':
        this.pendingApprovals.set(sid, { rpcId: frame.rpcId, approvalId: p.approvalId, toolName: p.toolName, reason: p.reason });
        this._onApprovalRequested(frame.rpcId, p);
        break;
      case 'question/requested':
        this.pendingQuestions.set(sid, { rpcId: frame.rpcId, questions: p.questions });
        this._onQuestionRequested(frame.rpcId, p);
        break;
      case 'approval/resolved':
      case 'question/resolved':
        this.pendingApprovals.delete(sid);
        this.pendingQuestions.delete(sid);
        break;
      default:
        break;
    }
  }

  _settle(sessionId, result) {
    const h = this.pending.get(sessionId);
    if (!h) return;
    this.pending.delete(sessionId);
    clearTimeout(h.timer);
    h.resolve(result);
  }

  /** 处理一条来自企业微信的文本消息（按会话串行化，避免上一轮未结束时的并发串话）。 */
  async onTextMessage(userId, content) {
    const sessionId = await this.ensureSession(userId);
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const run = prev.then(() => this._runTurn(userId, sessionId, content));
    this.sessionLocks.set(sessionId, run.catch(() => {})); // 尾巴吞错，保证队列不断
    await run;
  }

  /** 单轮执行：prompt → 等 turn/end → 回推最终文本。 */
  async _runTurn(userId, sessionId, content) {
    const waiter = this.beginWait(sessionId);
    try {
      await this.dsh.sessionPrompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: content }],
      });
    } catch (e) {
      waiter.cancel();
      throw e;
    }
    const result = await waiter.promise;

    if (result.kind === 'error') {
      await this.wecom.sendText(userId, `处理出错：${result.error?.message ?? result.error?.code ?? '未知'}`);
      return;
    }
    const text = (result.text ?? '').trim();
    if (text) {
      await this.wecom.sendText(userId, truncateBytes(text, 1900));
    } else {
      await this.wecom.sendText(userId, result.kind === 'timeout' ? '（处理超时，未收到文本回复）' : '（本轮没有文本回复）');
    }
  }

  /** 企业微信消息入口：命令优先 → 决策回复 → 普通消息。 */
  async dispatchMessage(msg) {
    const userId = msg.FromUserName;
    const type = msg.MsgType;
    if (type === 'text') {
      const content = msg.Content ?? '';
      if (await this._handleCommand(userId, content)) return;
      if (await this._tryHandleDecision(userId, content)) return;
      await this.onTextMessage(userId, content);
    } else if (type === 'event') {
      this.log.info(`[bridge] 收到事件，暂不处理: ${msg.Event ?? ''}`);
    } else {
      this.log.info(`[bridge] 未处理的消息类型: ${type}`);
    }
  }

  /** 取该用户绑定的 DSH 会话，没有则新建并持久化（in-flight 去重，避免并发重复建会话）。 */
  async ensureSession(userId) {
    const cached = this.store.get(userId);
    if (cached) {
      this.sessionUser.set(cached, userId);
      return cached;
    }
    const inflight = this.creating.get(userId);
    if (inflight) return inflight;

    const p = (async () => {
      const created = await this.dsh.sessionCreate({
        ...(this.config.dsh.cwd ? { cwd: this.config.dsh.cwd } : {}),
        ...(this.config.dsh.agentPreset ? { agentPreset: this.config.dsh.agentPreset } : {}),
      });
      this.store.set(userId, created.sessionId);
      this.sessionUser.set(created.sessionId, userId);
      this.log.info(`[bridge] 为用户 ${userId} 新建会话 ${created.sessionId}`);
      return created.sessionId;
    })();
    this.creating.set(userId, p);
    try {
      return await p;
    } finally {
      this.creating.delete(userId);
    }
  }

  /** 命令分发：识别列表/切换/新建/记录/打断/帮助，命中则处理并返回 true。 */
  async _handleCommand(userId, raw) {
    const content = raw.trim();
    if (/^(列表|对话|\/list|list)$/i.test(content)) { await this.listSessions(userId); return true; }
    if (/^(新建|新对话|\/new|new)$/i.test(content)) { await this.newSession(userId); return true; }
    if (/^(退出|离开|\/leave|leave|\/exit|exit)$/i.test(content)) { await this.leaveSession(userId); return true; }
    if (/^(记录|历史|\/history|history)$/i.test(content)) { await this.history(userId); return true; }
    if (/^(打断|停止|\/stop|stop)$/i.test(content)) { await this.stopSession(userId); return true; }
    if (/^(取消|\/cancel|cancel)$/i.test(content)) { await this.cancelDecision(userId); return true; }
    if (/^(帮助|命令|help|\/help)$/i.test(content)) { await this.help(userId); return true; }
    const m = content.match(/^(?:切换|进入|切换到|\/switch|switch)\s*(?:第|N|n)?\s*(\d+)$/i);
    if (m) { await this.switchSession(userId, Number(m[1])); return true; }
    return false;
  }

  /** 列出工作区所有会话（过滤子代理会话与已归档会话，按更新时间倒序）。 */
  async listSessions(userId) {
    try {
      const [sessions, ws] = await Promise.all([
        this.dsh.sessionList({}),
        this.dsh.workspaceList({}),
      ]);
      const archived = new Set(ws.archivedSessionIds ?? []);
      const items = sessions.items
        .filter((it) => it.origin !== 'subagent' && !archived.has(it.sessionId))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      this.sessionLists.set(userId, items.map((it) => it.sessionId));
      if (items.length === 0) {
        await this.wecom.sendText(userId, '工作区里还没有对话。');
        return;
      }
      const lines = items.slice(0, 15).map((it, i) => {
        const title = (it.projections?.values?.title || '').toString().trim() || '(未命名)';
        const status = it.running ? '🟢运行中' : '⚪空闲';
        return `${i + 1}. ${title} ${status}`;
      });
      const text = `📂 工作区对话（共 ${items.length} 个${items.length > 15 ? '，显示前15' : ''}）：\n${lines.join('\n')}\n\n回复「切换 1」进入第 1 个（换成对应序号），或「新建」开新对话`;
      await this.wecom.sendText(userId, truncateBytes(text, 1900));
    } catch (e) {
      this.log.error('[bridge] 列表失败:', e.message);
      await this.wecom.sendText(userId, `列表失败：${e.message}`);
    }
  }

  /** 切换到最近一次「列表」里的第 N 个会话。 */
  async switchSession(userId, n) {
    const list = this.sessionLists.get(userId);
    if (!list || list.length === 0) {
      await this.wecom.sendText(userId, '请先回复「列表」查看对话，再回复「切换 N」。');
      return;
    }
    if (n < 1 || n > list.length) {
      await this.wecom.sendText(userId, `序号无效，请输入 1–${list.length}。`);
      return;
    }
    const sessionId = list[n - 1];
    this.store.set(userId, sessionId);
    this.sessionUser.set(sessionId, userId);
    let title = '(未命名)';
    try {
      const res = await this.dsh.sessionList({});
      title = (res.items.find((s) => s.sessionId === sessionId)?.projections?.values?.title || '').toString().trim() || '(未命名)';
    } catch { /* 标题取不到不致命 */ }
    const recent = await this._recentText(sessionId);
    const tail = recent && recent !== '(暂无文本记录)' ? `\n\n📜 最近记录：\n${recent}` : '';
    this.log.info(`[bridge] 用户 ${userId} 切换到会话 ${sessionId}`);
    await this.wecom.sendText(userId, truncateBytes(`✅ 已切换到「${title}」。${tail}`, 1900));
  }

  /** 新建一个会话并设为当前。 */
  async newSession(userId) {
    try {
      const created = await this.dsh.sessionCreate({
        ...(this.config.dsh.cwd ? { cwd: this.config.dsh.cwd } : {}),
        ...(this.config.dsh.agentPreset ? { agentPreset: this.config.dsh.agentPreset } : {}),
      });
      this.store.set(userId, created.sessionId);
      this.sessionUser.set(created.sessionId, userId);
      this.log.info(`[bridge] 用户 ${userId} 新建会话 ${created.sessionId}`);
      await this.wecom.sendText(userId, '✅ 已新建对话，现在发消息会进入它。');
    } catch (e) {
      this.log.error('[bridge] 新建失败:', e.message);
      await this.wecom.sendText(userId, `新建失败：${e.message}`);
    }
  }

  /** 退出当前对话（解除用户与当前会话的绑定，会话仍留在工作区）。 */
  async leaveSession(userId) {
    const sid = this.store.get(userId);
    if (!sid) {
      await this.wecom.sendText(userId, '当前没有进行中的对话。');
      return;
    }
    this.store.del(userId);
    this.sessionUser.delete(sid);
    await this.wecom.sendText(userId, '✅ 已退出当前对话。下次发消息会开一个新对话；原对话仍在工作区，可用「列表」「切换」回去。');
  }

  /** 取一个会话的最近几条文本记录（返回字符串；取不到返回 null）。 */
  async _recentText(sessionId) {
    try {
      const res = await this.dsh.sessionHistory({ sessionId, maxMessages: 10 });
      const lines = [];
      for (const entry of res.events ?? []) {
        const ev = entry.event;
        if (ev.type === 'user/message') {
          const t = blockText(ev.data?.content);
          if (t) lines.push(`你：${t}`);
        } else if (ev.type === 'assistant/message') {
          const t = blockText(ev.data?.message?.content);
          if (t) lines.push(`DSH：${t}`);
        }
      }
      if (!lines.length) return '(暂无文本记录)';
      return lines.slice(-8).map((l) => truncateBytes(l, 120)).join('\n');
    } catch {
      return null;
    }
  }

  /** 查看当前会话的最近几条记录。 */
  async history(userId) {
    const sessionId = this.store.get(userId);
    if (!sessionId) {
      await this.wecom.sendText(userId, '还没有对话，先发条消息或回复「新建」。');
      return;
    }
    const recent = await this._recentText(sessionId);
    if (recent === null) {
      await this.wecom.sendText(userId, '查看记录失败。');
      return;
    }
    await this.wecom.sendText(userId, truncateBytes(`📜 当前对话最近记录：\n${recent}`, 1900));
  }

  /** 打断当前会话正在进行的任务。 */
  async stopSession(userId) {
    const sessionId = this.store.get(userId);
    if (!sessionId) {
      await this.wecom.sendText(userId, '还没有进行中的对话。');
      return;
    }
    try {
      await this.dsh.sessionCancel({ sessionId });
      await this.wecom.sendText(userId, '🛑 已发送打断请求。');
    } catch (e) {
      this.log.error('[bridge] 打断失败:', e.message);
      await this.wecom.sendText(userId, `打断失败：${e.message}`);
    }
  }

  /** 取消当前待处理的审批/提问（提问可取消；审批则转为拒绝）。 */
  async cancelDecision(userId) {
    const d = this.decisions.get(userId);
    if (!d) {
      await this.wecom.sendText(userId, '当前没有需要取消的请求。');
      return;
    }
    this.decisions.delete(userId);
    try {
      if (d.kind === 'question') {
        const receipt = await this.dsh.respondCancel(d.rpcId);
        await this.wecom.sendText(userId, receipt.accepted === true ? '已取消该提问。' : `取消失败：${receipt.reason ?? '未知'}`);
      } else {
        const receipt = await this.dsh.respond(d.rpcId, { sessionId: d.sessionId, approvalId: d.approvalId, outcome: 'rejected' });
        await this.wecom.sendText(userId, receipt.accepted === true ? '已拒绝该审批。' : `拒绝失败：${receipt.reason ?? '未知'}`);
      }
    } catch (e) {
      this.log.error('[bridge] 取消失败:', e.message);
      await this.wecom.sendText(userId, `取消失败：${e.message}`);
    }
  }

  /** 命令帮助。 */
  async help(userId) {
    const text = [
      '📖 命令说明：',
      '列表 —— 查看工作区所有对话',
      '切换 1 —— 进入第 1 个对话（换成对应序号）',
      '新建 —— 开一个新对话',
      '退出 —— 退出当前对话（下次发消息开新对话）',
      '记录 —— 看当前对话最近记录',
      '打断 —— 停止当前对话正在跑的任务',
      '取消 —— 取消待处理的提问/审批',
      '直接发消息 —— 发送给当前对话',
    ].join('\n');
    await this.wecom.sendText(userId, text);
  }

  /** 审批请求到达：通知用户并登记决策等待。 */
  async _onApprovalRequested(rpcId, p) {
    const userId = this.sessionUser.get(p.sessionId);
    if (!userId) return;
    this.decisions.set(userId, { kind: 'approval', sessionId: p.sessionId, rpcId, approvalId: p.approvalId });
    const reason = p.reason ? `\n原因：${p.reason}` : '';
    try {
      await this.wecom.sendText(userId, `⚠️ 需要审批：${p.toolName}${reason}\n回复「同意」允许一次，或「拒绝」拒绝。`);
    } catch (e) {
      this.log.error('[bridge] 推送审批通知失败:', e.message);
    }
  }

  /** 提问请求到达：渲染问题并登记答案等待。 */
  async _onQuestionRequested(rpcId, p) {
    const userId = this.sessionUser.get(p.sessionId);
    if (!userId) return;
    this.decisions.set(userId, { kind: 'question', sessionId: p.sessionId, rpcId, questions: p.questions });
    const lines = (p.questions ?? [])
      .map((q, i) => {
        const opts = q.options?.length ? `\n选项：${q.options.map((o) => o.label).join(' / ')}` : '';
        return `${i + 1}. ${q.question}${opts}`;
      })
      .join('\n');
    try {
      await this.wecom.sendText(userId, `❓ 需要你回答：\n${lines}\n请回复你的选择。`);
    } catch (e) {
      this.log.error('[bridge] 推送提问通知失败:', e.message);
    }
  }

  /** 若用户发的是对当前审批/提问的决策，则处理并返回 true；否则返回 false（按普通消息走）。 */
  async _tryHandleDecision(userId, content) {
    const d = this.decisions.get(userId);
    if (!d) return false;
    const text = content.trim();

    if (d.kind === 'approval') {
      let outcome;
      if (/^(同意|允许|通过|可以|y|yes|allow|approve|1)$/i.test(text)) outcome = 'allowed-once';
      else if (/^(拒绝|不同意|取消|n|no|reject|deny|2)$/i.test(text)) outcome = 'rejected';
      else return false; // 不是明确决策词，按普通消息处理
      this.decisions.delete(userId);
      const receipt = await this.dsh.respond(d.rpcId, { sessionId: d.sessionId, approvalId: d.approvalId, outcome });
      if (receipt.accepted !== true) {
        await this.wecom.sendText(userId, `审批回应失败：${receipt.reason ?? '未知'}`);
      } else {
        await this.wecom.sendText(userId, outcome === 'allowed-once' ? '已同意，继续执行…' : '已拒绝。');
      }
      return true;
    }

    if (d.kind === 'question') {
      const answers = (d.questions ?? []).map((q) => {
        const selected = q.options?.length
          ? q.options.filter((o) => text.includes(o.label)).map((o) => o.label)
          : [];
        return { id: q.id, ...(selected.length ? { selected } : { custom: text }) };
      });
      this.decisions.delete(userId);
      const receipt = await this.dsh.respond(d.rpcId, { sessionId: d.sessionId, answer: { answers } });
      if (receipt.accepted !== true) {
        await this.wecom.sendText(userId, `回答提交失败：${receipt.reason ?? '未知'}`);
      } else {
        await this.wecom.sendText(userId, '已收到回答。');
      }
      return true;
    }

    return false;
  }

  /** 发送消息并流式回调每个 text-delta；返回 promise（resolve 于 turn/end）。blocks 为内容块（支持上传文件/图片）。 */
  async sendMessageStream(sessionId, content, onDelta, blocks) {
    const waiter = this.beginWait(sessionId, { onDelta });
    try {
      await this.dsh.sessionPrompt({
        sessionId,
        mode: 'queue',
        content: blocks && blocks.length ? blocks : [{ type: 'text', text: content }],
      });
    } catch (e) {
      waiter.cancel();
      throw e;
    }
    return waiter.promise;
  }

  /** 注册一个等待本轮结束的 pending 处理器，返回 promise + cancel。 */
  beginWait(sessionId, { onDelta } = {}) {
    let h;
    const promise = new Promise((resolve) => {
      h = {
        resolve,
        parts: [],
        lastMessageText: '',
        onDelta,
        timer: setTimeout(() => {
          if (this.pending.get(sessionId) === h) {
            this.pending.delete(sessionId);
            resolve({ kind: 'timeout', text: h.lastMessageText || h.parts.join('') });
          }
        }, this.turnTimeoutMs),
      };
      this.pending.set(sessionId, h);
    });
    return {
      promise,
      cancel: () => {
        clearTimeout(h.timer);
        if (this.pending.get(sessionId) === h) this.pending.delete(sessionId);
      },
    };
  }
}
