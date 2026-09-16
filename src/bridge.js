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

/** DSH command.execute accepts encoded image attachments, not ordinary content blocks. */
function commandImages(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b) => b?.type === 'image' && typeof b.mediaType === 'string' && typeof b.data === 'string')
    .map((b) => ({ mediaType: b.mediaType, data: b.data }));
}

/** DSH's skill layer recognizes whitespace-bounded /name gestures in ordinary prompts. */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

/**
 * 桥接核心：驱动 DSH（prompt + 流式 + 审批/提问登记 + 费用统计），供网页 HTTP 服务调用。
 */
export class Bridge {
  constructor({ dsh, config, log = console, turnTimeoutMs = 10 * 60 * 1000 }) {
    this.dsh = dsh;
    this.config = config;
    this.log = log;
    this.turnTimeoutMs = turnTimeoutMs;
    this.pending = new Map(); // sessionId -> 等待流式完成的句柄 { resolve, timer, parts, lastMessageText }
    this.pendingQuestions = new Map(); // sessionId -> { rpcId, questions }（Web 端展示用）
    this.pendingApprovals = new Map(); // sessionId -> { rpcId, approvalId, toolName, reason }（Web 端展示用）
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
          this._settle(sid, {
            kind: h.cancelRequested ? 'cancelled' : 'done',
            text: h.lastMessageText || h.parts.join(''),
          });
        }
        break;
      }
      case 'stream/error':
        if (h) this._settle(sid, { kind: 'error', error: p.error });
        break;
      case 'approval/requested':
        this.pendingApprovals.set(sid, { rpcId: frame.rpcId, approvalId: p.approvalId, toolName: p.toolName, reason: p.reason });
        break;
      case 'question/requested':
        this.pendingQuestions.set(sid, { rpcId: frame.rpcId, questions: p.questions });
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

  /** Execute a slash command and normalize its direct result to the web SSE shape. */
  async _executeSlashCommand(sessionId, line, blocks) {
    const execution = await this.dsh.commandsExecute({
      sessionId,
      line,
      images: commandImages(blocks),
    });
    if (!execution) {
      // @name is a web-only picker alias; the DSH runtime recognizes /name skill gestures.
      let skills = [];
      try { skills = (await this.dsh.skillList({ sessionId })).skills ?? []; } catch { /* no skill registry */ }
      const names = new Set(skills.filter((s) => s && typeof s.name === 'string').map((s) => s.name));
      SKILL_GESTURE.lastIndex = 0;
      const hasSkill = Array.from(line.matchAll(SKILL_GESTURE)).some((m) => names.has(m[2]));
      if (hasSkill) return null; // Let the normal prompt path inject <skill_content>.
      return { kind: 'error', error: { message: `未知或格式错误的命令：${line}` } };
    }
    const result = execution.result ?? {};
    if (result.kind === 'error') return { kind: 'error', error: { message: result.text || '命令执行失败' } };
    return { kind: 'done', text: result.text ?? '' };
  }

  /** 取消当前回合，并立即结算网页正在等待的 SSE，避免依赖延迟到达的 turn/end。 */
  async cancelSession(sessionId) {
    const pending = this.pending.get(sessionId);
    if (pending) pending.cancelRequested = true;
    try {
      const receipt = await this.dsh.sessionCancel({ sessionId });
      if (receipt?.accepted === true) {
        const h = this.pending.get(sessionId);
        if (h) this._settle(sessionId, { kind: 'cancelled', text: h.lastMessageText || h.parts.join('') });
      } else if (this.pending.get(sessionId) === pending) {
        pending.cancelRequested = false;
      }
      return receipt;
    } catch (error) {
      if (pending && this.pending.get(sessionId) === pending) pending.cancelRequested = false;
      throw error;
    }
  }

  /** 发送消息并流式回调每个 text-delta；返回 promise（resolve 于 turn/end）。blocks 为内容块（支持上传文件/图片）。 */
  async sendMessageStream(sessionId, content, onDelta, blocks) {
    const line = typeof content === 'string' ? content.trim() : '';
    if (line.startsWith('/')) {
      const commandResult = await this._executeSlashCommand(sessionId, line, blocks);
      if (commandResult) return commandResult;
    }

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
