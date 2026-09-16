import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INDEX_HTML = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
const LOGO_SVG = readFileSync(fileURLToPath(new URL('../web/logo.svg', import.meta.url)), 'utf8');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 从内容块数组里拼接所有 text 块。 */
function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ');
}

/** 判断是否为 DSH 注入的非用户上下文，这类不应显示为用户气泡。 */
function isInjectedContext(ev, text) {
  if (ev?.data?.source?.kind === 'skill-invocation') return true;
  return typeof text === 'string' && (text.startsWith('Current runtime context') || text.startsWith('<system-reminder>'));
}

/** 桥接 HTTP 服务：/health + 手机网页 UI 及其 API（Tailscale 版，无企业微信）。 */
export function createBridgeServer({ bridge, config, log = console }) {
  const webPassword = config.web.password ?? '';

  function isAuthed(req) {
    if (!webPassword) return true; // 未设密码则放行（仅限可信网络）
    return req.headers['authorization'] === `Bearer ${webPassword}`;
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      // ── 健康检查 ─────────────────────────────────────────────
      if (req.method === 'GET' && path === '/health') {
        json(res, 200, { ok: true, name: 'dsh-roam' });
        return;
      }

      // ── 手机网页 UI（静态）────────────────────────────────────
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(INDEX_HTML);
        return;
      }
      if (req.method === 'GET' && path === '/logo.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
        res.end(LOGO_SVG);
        return;
      }

      // ── Web API（带密码）─────────────────────────────────────
      if (path.startsWith('/web/api/')) {
        if (!isAuthed(req)) { json(res, 401, { error: 'unauthorized' }); return; }

        if (req.method === 'GET' && path === '/web/api/sessions') {
          const [sessions, ws] = await Promise.all([
            bridge.dsh.sessionList({}),
            bridge.dsh.workspaceList({}),
          ]);
          const archived = new Set(ws.archivedSessionIds ?? []);
          const workspaces = Array.isArray(ws.items) ? ws.items : [];
          const visible = sessions.items
            .filter((it) => it.origin !== 'subagent' && it.blank !== true && !archived.has(it.sessionId))
            .map((it) => ({
              sessionId: it.sessionId,
              title: (it.projections?.values?.title || '').toString().trim() || '(未命名)',
              running: !!it.running,
              cwd: typeof it.cwd === 'string' ? it.cwd : '',
              updatedAt: it.updatedAt ?? 0,
            }));
          const items = visible.slice().sort((a, b) => b.updatedAt - a.updatedAt);
          // 路径归一化：去尾斜杠、统一分隔符、忽略大小写（Windows）。
          const normPath = (p) => (typeof p === 'string' ? p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() : '');
          const workspaceByPath = new Map();
          const sessionIdsByWorkspace = new Map();
          for (const w of workspaces) {
            if (normPath(w.path)) workspaceByPath.set(normPath(w.path), w);
            sessionIdsByWorkspace.set(w.workspaceId, new Set(w.sessionIds ?? []));
          }
          // 归属：优先按会话 cwd 精确匹配工作区 path（实时，能覆盖「新建后尚未写入工作区
          // 索引」的会话，避免最近会话掉进未分组）；cwd 缺失时回退到 workspace.sessionIds；
          // 都不命中才归「未分组」。
          const groupMap = new Map();   // workspaceId -> { workspaceId, title, sessions }
          const groupOrder = [];
          const ensureGroup = (workspaceId, title) => {
            if (!groupMap.has(workspaceId)) {
              groupMap.set(workspaceId, { workspaceId, title, sessions: [] });
              groupOrder.push(workspaceId);
            }
            return groupMap.get(workspaceId);
          };
          for (const s of visible) {
            let target = workspaceByPath.get(normPath(s.cwd)) ?? null;
            if (!target) {
              for (const w of workspaces) {
                if (sessionIdsByWorkspace.get(w.workspaceId)?.has(s.sessionId)) { target = w; break; }
              }
            }
            if (target) ensureGroup(target.workspaceId, target.title || '(未命名工作区)').sessions.push(s);
            else ensureGroup('__ungrouped__', '未分组').sessions.push(s);
          }
          // 组内按更新时间倒序，组间按「组内最新会话」倒序：最近聊过的排在侧栏最前。
          const groups = groupOrder
            .map((workspaceId) => {
              const g = groupMap.get(workspaceId);
              const sorted = g.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt);
              return {
                workspaceId,
                title: g.title,
                sessions: sorted.map(({ cwd, updatedAt, ...session }) => session),
                latest: sorted.reduce((max, s) => Math.max(max, s.updatedAt), 0),
              };
            })
            .filter((g) => g.sessions.length > 0)
            .sort((a, b) => b.latest - a.latest)
            .map(({ latest, ...g }) => g);
          json(res, 200, {
            items: items.map(({ cwd, updatedAt, ...session }) => session),
            groups,
          });
          return;
        }

        if (req.method === 'GET' && path === '/web/api/history') {
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) { json(res, 400, { error: 'missing sessionId' }); return; }
          const beforeSeq = url.searchParams.get('beforeSeq');
          const maxMessages = Math.min(Number(url.searchParams.get('maxMessages') ?? 200) || 200, 200);
          const payload = { sessionId, maxMessages };
          if (beforeSeq !== null && beforeSeq !== '') payload.beforeSeq = Number(beforeSeq);
          const h = await bridge.dsh.sessionHistory(payload);
          const messages = [];
          let oldestSeq = null;
          for (const entry of h.events ?? []) {
            const ev = entry.event ?? {};
            if (typeof ev.seq === 'number' && (oldestSeq === null || ev.seq < oldestSeq)) oldestSeq = ev.seq;
            if (ev.type === 'user/message') {
              const t = blockText(ev.data?.content);
              if (t && !isInjectedContext(ev, t)) messages.push({ role: 'user', text: t, seq: ev.seq });
            } else if (ev.type === 'assistant/message') {
              const t = blockText(ev.data?.message?.content);
              if (t) messages.push({ role: 'assistant', text: t, seq: ev.seq });
            }
          }
          json(res, 200, { messages, hasMore: !!h.hasMore, oldestSeq });
          return;
        }

        if (req.method === 'POST' && path === '/web/api/new') {
          const created = await bridge.dsh.sessionCreate({
            ...(config.dsh.cwd ? { cwd: config.dsh.cwd } : {}),
            ...(config.dsh.agentPreset ? { agentPreset: config.dsh.agentPreset } : {}),
          });
          json(res, 200, { sessionId: created.sessionId });
          return;
        }

        if (req.method === 'POST' && path === '/web/api/send') {
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
          const { sessionId, content, blocks } = body;
          if (!sessionId || (!content && !blocks)) { json(res, 400, { error: 'missing sessionId/content' }); return; }

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',   // 禁用代理层缓冲，让帧即时到达
          });
          res.flushHeaders();   // 立即发送响应头
          res.write(': connected\n\n');
          const emit = (obj) => { res.write(`data: ${JSON.stringify(obj)}\n\n`); };
          // SSE 心跳保活：agent 长时间思考时无数据帧，连接易被中间层掐断；每 5s 发一个注释帧维持
          const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 连接已断 */ } }, 5000);
          try {
            const result = await bridge.sendMessageStream(sessionId, content, (delta) => emit({ type: 'delta', text: delta }), blocks);
            if (result.kind === 'done') emit({ type: 'done', text: result.text ?? '' });
            else if (result.kind === 'error') emit({ type: 'error', error: result.error?.message ?? result.error?.code ?? 'unknown' });
            else if (result.kind === 'cancelled') emit({ type: 'cancelled', text: result.text ?? '' });
            else emit({ type: 'timeout', text: result.text ?? '' });
          } catch (e) {
            emit({ type: 'error', error: e.message });
          } finally {
            clearInterval(keepAlive);
          }
          res.end();
          return;
        }

        if (req.method === 'POST' && path === '/web/api/cancel') {
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
          if (!body.sessionId) { json(res, 400, { error: 'missing sessionId' }); return; }
          const receipt = await bridge.cancelSession(body.sessionId);
          if (receipt?.accepted !== true) { json(res, 409, { ok: false, accepted: false }); return; }
          json(res, 200, { ok: true, accepted: true });
          return;
        }

        // 排队发送消息（不等回复，回复由前端轮询自动显示；用于审批附带的文本指令）
        if (req.method === 'POST' && path === '/web/api/send-queued') {
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
          const { sessionId, content } = body;
          if (!sessionId || !content) { json(res, 400, { error: 'missing sessionId/content' }); return; }
          await bridge.dsh.sessionPrompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: content }] });
          json(res, 200, { ok: true });
          return;
        }

        // 查询当前会话待处理的提问/审批（前端轮询用）
        if (req.method === 'GET' && path === '/web/api/pending') {
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) { json(res, 400, { error: 'missing sessionId' }); return; }
          const question = bridge.pendingQuestions.get(sessionId) || null;
          const approval = bridge.pendingApprovals.get(sessionId) || null;
          json(res, 200, { question, approval });
          return;
        }

        // 提交提问回答 / 审批决定（转发给 DSH 的 respond）
        if (req.method === 'POST' && path === '/web/api/respond') {
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
          if (!body.rpcId || !body.value) { json(res, 400, { error: 'missing rpcId/value' }); return; }
          const receipt = await bridge.dsh.respond(body.rpcId, body.value);
          json(res, 200, receipt);
          return;
        }

        // 查询当前会话可用的斜杠命令与用户技能（输入候选菜单）
        if (req.method === 'GET' && path === '/web/api/slash-options') {
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) { json(res, 400, { error: 'missing sessionId' }); return; }
          const [commands, skills] = await Promise.allSettled([
            bridge.dsh.commandsList({ sessionId }),
            bridge.dsh.skillList({ sessionId }),
          ]);
          json(res, 200, {
            commands: commands.status === 'fulfilled' ? commands.value ?? [] : [],
            skills: skills.status === 'fulfilled' ? skills.value.skills ?? [] : [],
          });
          return;
        }

        // 查询当前会话的模型（当前选择 + 可用分组）
        if (req.method === 'GET' && path === '/web/api/model') {
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) { json(res, 400, { error: 'missing sessionId' }); return; }
          const m = await bridge.dsh.sessionModels({ sessionId });
          json(res, 200, {
            current: m.current ?? null,
            groups: m.groups ?? [],
            routable: !!m.routable,
          });
          return;
        }

        // 切换当前会话的模型
        if (req.method === 'POST' && path === '/web/api/model') {
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
          if (!body.sessionId || !body.provider || !body.model) { json(res, 400, { error: 'missing fields' }); return; }
          const selected = await bridge.dsh.sessionSelectModel({
            sessionId: body.sessionId,
            provider: body.provider,
            model: body.model,
            ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
          });
          json(res, 200, selected);
          return;
        }

        // 查询 DeepSeek 余额（用量密钥只在服务端，不出网不带）
        if (req.method === 'GET' && path === '/web/api/balance') {
          if (!config.deepseekApiKey) { json(res, 200, { ok: false, error: 'no deepseek api key' }); return; }
          let data;
          try {
            const r = await fetch('https://api.deepseek.com/user/balance', {
              headers: { 'authorization': `Bearer ${config.deepseekApiKey}` },
            });
            data = await r.json();
          } catch {
            json(res, 200, { ok: false, error: 'fetch failed' });
            return;
          }
          json(res, 200, { ok: true, is_available: !!data.is_available, balance_infos: data.balance_infos ?? [] });
          return;
        }

        // 单次对话消费（最近一次结算，供"本次对话消费"提示）
        if (req.method === 'GET' && path === '/web/api/cost') {
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) { json(res, 400, { error: 'missing sessionId' }); return; }
          json(res, 200, { ok: true, last: bridge.getLastCost(sessionId) ?? null });
          return;
        }

        // 会话运行状态（前端周期性刷新，驱动"打断"按钮 + 任务进行中提示）
        if (req.method === 'GET' && path === '/web/api/status') {
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) { json(res, 400, { error: 'missing sessionId' }); return; }
          const [sessions] = await Promise.all([bridge.dsh.sessionList({})]);
          const it = sessions.items.find((x) => x.sessionId === sessionId);
          json(res, 200, { ok: true, running: !!(it && it.running) });
          return;
        }

        // 后台预载：返回所有非当前会话的最新 20 条消息 + 分页信息（供切换秒开 + 未读气泡）
        if (req.method === 'GET' && path === '/web/api/previews') {
          const except = url.searchParams.get('except');
          const [sessions, ws] = await Promise.all([
            bridge.dsh.sessionList({}),
            bridge.dsh.workspaceList({}),
          ]);
          const archived = new Set(ws.archivedSessionIds ?? []);
          const items = sessions.items.filter((it) => it.origin !== 'subagent' && it.blank !== true && !archived.has(it.sessionId) && it.sessionId !== except);
          const previews = [];
          for (const it of items) {
            try {
              const h = await bridge.dsh.sessionHistory({ sessionId: it.sessionId, maxMessages: 20 });
              const messages = [];
              let oldestSeq = null;
              for (const entry of h.events ?? []) {
                const ev = entry.event ?? {};
                if (typeof ev.seq === 'number' && (oldestSeq === null || ev.seq < oldestSeq)) oldestSeq = ev.seq;
                if (ev.type === 'user/message') { const t = blockText(ev.data?.content); if (t && !isInjectedContext(ev, t)) messages.push({ role: 'user', text: t, seq: ev.seq }); }
                else if (ev.type === 'assistant/message') { const t = blockText(ev.data?.message?.content); if (t) messages.push({ role: 'assistant', text: t, seq: ev.seq }); }
              }
              previews.push({
                sessionId: it.sessionId, title: it.title, running: !!it.running,
                messages, hasMore: !!h.hasMore, oldestSeq,
                latestSeq: messages.length ? messages[messages.length - 1].seq : null,
              });
            } catch { /* 单个会话失败则跳过 */ }
          }
          json(res, 200, { previews });
          return;
        }

        json(res, 404, { error: 'not found' });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      log.error('[server] 处理请求失败:', e);
      try {
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('internal error'); }
        else res.end();
      } catch { /* 连接已断 */ }
    }
  });
}
