import { randomUUID } from 'node:crypto';

/**
 * DSH Web GUI `/api` 的最小忠实客户端（南向）。
 *
 * 协议（来自 dsh-host-apiproxy 的 fetch carrier）：
 *  - 一元调用：POST /api/<method>，body = { type:'client-request', rpcId, method, payload }
 *    返回 { type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error } }
 *    业务错误也是 HTTP 200；只有载体层错误（404/415/400/500）才非 2xx。
 *  - 流式：GET /api/events.mux，SSE `data:` 行，每帧 = { type:'server-request', rpcId, method, payload }
 */
export class DshClient {
  constructor(baseUrl = 'http://127.0.0.1:3080', { timeoutMs = 120000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  /** 一次一元 RPC。成功返回 result.value；失败抛带 code/details 的 Error。 */
  async call(method, payload, { signal } = {}) {
    const rpcId = randomUUID();
    const body = { type: 'client-request', rpcId, method, payload: payload ?? {} };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
    const onOuterAbort = () => ctrl.abort(signal.reason);
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason);
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`transport failure for ${method}: HTTP ${res.status}`);
      const full = await res.json();
      if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${method}: sent ${rpcId}, got ${full.rpcId}`);
      const result = full.result;
      if (!result || result.ok !== true) {
        const err = result?.error ?? { code: 'internal', message: 'malformed server response', details: {} };
        const e = new Error(`${method} failed: ${err.code} — ${err.message}`);
        e.code = err.code;
        e.details = err.details;
        throw e;
      }
      return result.value;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  /**
   * 打开 mux 事件流（WebSocket 下行链路，downlink-only）。
   *
   * 真实网络传输里 `/api/events.mux` 走 WebSocket：客户端只读，服务端逐条推送
   * JSON 文本帧，每帧 = { type:'server-request', rpcId, method, payload }。
   * yield 的是 { rpcId, payload }（与一元调用的响应信封对齐）。纯 HTTP GET 会得到 426。
   */
  async *eventsMux({ signal } = {}) {
    const url = new URL('/api/events.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    const socket = new WebSocket(url);
    const inbox = [];
    let wake;
    let opened = false;
    let openError = null;

    const enqueue = (item) => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };

    socket.addEventListener('open', () => { opened = true; });
    socket.addEventListener('error', (event) => {
      if (!opened) openError = event.error ?? new Error('WebSocket connection failed');
    });
    socket.addEventListener('message', (event) => {
      let full;
      try {
        if (typeof event.data !== 'string') return; // 二进制帧是协议违规，忽略。
        full = JSON.parse(event.data);
      } catch {
        return;
      }
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: full.payload } });
    });
    socket.addEventListener('close', () => {
      enqueue({ kind: openError ? 'error' : 'end', error: openError });
    }, { once: true });

    const handleAbort = () => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
    };
    if (signal) signal.addEventListener('abort', handleAbort, { once: true });
    if (signal?.aborted) handleAbort();

    try {
      for (;;) {
        while (inbox.length > 0) {
          const item = inbox.shift();
          if (item.kind === 'error') throw item.error;
          if (item.kind === 'end') return;
          yield item.envelope;
        }
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      if (signal) signal.removeEventListener('abort', handleAbort);
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
    }
  }

  // ── 便捷方法 ────────────────────────────────────────────────
  sessionList(payload, opts) { return this.call('session.list', payload, opts); }
  sessionCreate(payload, opts) { return this.call('session.create', payload, opts); }
  sessionPrompt(payload, opts) { return this.call('session.prompt', payload, opts); }
  sessionHistory(payload, opts) { return this.call('session.history', payload, opts); }
  sessionCancel(payload, opts) { return this.call('session.cancel', payload, opts); }
  workspaceList(payload, opts) { return this.call('workspace.list', payload, opts); }
  sessionModels(payload, opts) { return this.call('session.models', payload, opts); }
  sessionSelectModel(payload, opts) { return this.call('session.selectModel', payload, opts); }

  /**
   * 回应一个审批/提问请求。信封是 client-response（不是 client-request）：
   * POST /api/respond，body = { type:'client-response', rpcId, result:{ ok:true, value } }。
   * @param rpcId 请求帧顶层的 rpcId（approval/requested 或 question/requested 的关联 id）
   * @param value 审批 { sessionId, approvalId, outcome } 或 提问 { sessionId, answer:{ answers:[...] } }
   */
  async respond(rpcId, value, { signal } = {}) {
    const body = { type: 'client-response', rpcId, result: { ok: true, value } };
    const res = await fetch(`${this.baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`transport failure for respond: HTTP ${res.status}`);
    return res.json(); // { accepted:true } | { accepted:false, reason }
  }

  /** 取消一个待处理的提问（发送 ok:false + code:cancelled）。 */
  async respondCancel(rpcId, { signal } = {}) {
    const body = {
      type: 'client-response',
      rpcId,
      result: { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } },
    };
    const res = await fetch(`${this.baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`transport failure for respond: HTTP ${res.status}`);
    return res.json();
  }
}
