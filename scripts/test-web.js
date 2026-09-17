import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bridge } from '../src/bridge.js';
import { DshClient } from '../src/dsh/client.js';
import { createBridgeServer } from '../src/server.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture({ commandsError = false, historyEvents = [], catalogDelayMs = 0, cancelDelayMs = 0, sendDelayMs = 0, historyDelayMs = 0, sessionItems, workspaceData, sendResult, webPassword = '' } = {}) {
  const state = { sendCalls: [], cancelCalls: [], historyEvents, historyBySession: {}, subagentEntries: [] };
  const dsh = {
    async commandsList({ sessionId }) {
      assert.equal(sessionId, 'session-test');
      if (catalogDelayMs) await delay(catalogDelayMs);
      if (commandsError) throw new Error('command registry unavailable');
      return [
        { name: 'goal', description: 'set or view the goal', input: { hint: '[objective]' } },
        { name: 'compact', description: 'compact older history' },
      ];
    },
    async skillList({ sessionId }) {
      assert.equal(sessionId, 'session-test');
      if (catalogDelayMs) await delay(catalogDelayMs);
      return {
        skills: [
          { name: 'grill-me', description: 'stress-test a plan', modelInvocable: false },
          { name: 'tdd', description: 'develop test-first', modelInvocable: true },
        ],
      };
    },
    async sessionList() {
      return {
        items: sessionItems ?? [{
          sessionId: 'session-test',
          origin: 'user',
          blank: false,
          running: false,
          updatedAt: 1,
          projections: { values: { title: '测试会话' } },
        }],
      };
    },
    async workspaceList() { return workspaceData ?? { items: [], archivedSessionIds: [] }; },
    async sessionHistory({ sessionId, maxMessages, beforeSeq }) {
      if (historyDelayMs) await delay(historyDelayMs);
      const all = state.historyBySession[sessionId] ?? state.historyEvents ?? [];
      const filtered = (beforeSeq !== undefined && beforeSeq !== null)
        ? all.filter((e) => ((e.event ?? {}).seq ?? 0) < beforeSeq)
        : all;
      const page = filtered.slice(-(maxMessages ?? filtered.length));
      return { events: page, hasMore: filtered.length > page.length };
    },
    async sessionModels() { return { current: null, groups: [], routable: false }; },
    async subagentList({ parentSessionId }) {
      return { entries: state.subagentEntries ?? [], parentAvailable: true };
    },
    async subagentHistory() { return { events: [], hasMore: false }; },
    async sessionCancel({ sessionId }) {
      state.cancelCalls.push(sessionId);
      if (cancelDelayMs) await delay(cancelDelayMs);
      return { accepted: true };
    },
  };
  const bridge = {
    dsh,
    pendingQuestions: new Map(),
    pendingApprovals: new Map(),
    getLastCost() { return null; },
    async cancelSession(sessionId) { return dsh.sessionCancel({ sessionId }); },
    async sendMessageStream(sessionId, content, onDelta, blocks) {
      state.sendCalls.push({ sessionId, content, ...(blocks ? { blocks } : {}) });
      if (sendDelayMs) await delay(sendDelayMs);
      return sendResult ?? { kind: 'done', text: '收到' };
    },
  };
  const config = { web: { password: webPassword }, dsh: {}, deepseekApiKey: '' };
  return { bridge, config, state };
}

async function withServer(run, options) {
  const environment = fixture(options);
  const server = createBridgeServer({ bridge: environment.bridge, config: environment.config, log: console });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`, environment);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function edgePath() {
  const candidates = [
    join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error('Microsoft Edge was not found');
  return found;
}

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitFor(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = once(this.socket, 'open');
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async call(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
    throw new Error(detail);
  }
  return response.result.value;
}

async function withBrowser(baseUrl, run, { beforeReload, windowSize = '390,844', mobile = false } = {}) {
  const debugPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'dsh-roam-edge-'));
  const edge = spawn(edgePath(), [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    `--window-size=${windowSize}`,
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    baseUrl,
  ], { stdio: 'ignore' });
  let cdp;
  try {
    const page = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const pages = await response.json();
      return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    }, 'Edge DevTools endpoint did not become ready');
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    if (mobile) {
      // 模拟触屏：让 (hover: hover) and (pointer: fine) 为 false，复现手机端
      await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    await cdp.call('Page.navigate', { url: baseUrl });
    await waitFor(() => evaluate(cdp, `location.origin === ${JSON.stringify(baseUrl)}`), 'Edge did not navigate to dsh-roam');
    await evaluate(cdp, `localStorage.setItem('dsh_pw', 'test'); localStorage.setItem('dsh_last_session', 'session-test'); true`);
    if (beforeReload) await evaluate(cdp, beforeReload);
    await cdp.call('Page.reload');
    await waitFor(
      () => evaluate(cdp, `typeof currentSessionId !== 'undefined' && currentSessionId === 'session-test' && !!document.getElementById('input')`),
      'dsh-roam page did not open the fixture session',
    );
    await run(cdp);
  } finally {
    cdp?.close();
    edge.kill();
    await Promise.race([once(edge, 'exit'), delay(2000)]).catch(() => {});
    // 临时 Edge 配置目录清理是尽力而为：Windows 下 Edge 子进程可能还没释放目录锁，
    // 抛 EPERM/ENOENT 属正常，不应让测试失败。
    try { rmSync(profile, { recursive: true, force: true }); }
    catch (e) { if (e.code !== 'EPERM' && e.code !== 'ENOENT' && e.code !== 'EBUSY') throw e; }
  }
}

test('web API rejects unauthenticated and wrong-password requests', async () => {
  await withServer(async (baseUrl) => {
    const unauth = await fetch(`${baseUrl}/web/api/sessions`);
    assert.equal(unauth.status, 401);
    const wrong = await fetch(`${baseUrl}/web/api/sessions`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${baseUrl}/web/api/sessions`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(ok.status, 200);
  }, { webPassword: 'secret' });
});

test('DshClient.call() sends a client-request envelope and unwraps the value', async () => {
  let captured;
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: captured.rpcId, result: { ok: true, value: { hello: 'world' } } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = new DshClient(`http://127.0.0.1:${server.address().port}`);
    const value = await client.call('session.list', { a: 1 });
    assert.deepEqual(value, { hello: 'world' });
    assert.equal(captured.type, 'client-request');
    assert.equal(captured.method, 'session.list');
    assert.deepEqual(captured.payload, { a: 1 });
    assert.ok(captured.rpcId);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('DshClient.call() rejects a business error', async () => {
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const { rpcId } = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'not-found', message: 'nope', details: {} } } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = new DshClient(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(() => client.call('session.list', {}), /not-found/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('sessions API hides blank and archived sessions and returns workspace groups', async () => {
  const sessionItems = [
    { sessionId: 'session-a', blank: false, running: false, updatedAt: 30, projections: { values: { title: 'A' } } },
    { sessionId: 'session-blank', blank: true, running: false, updatedAt: 40, projections: { values: {} } },
    { sessionId: 'session-archived', blank: false, running: false, updatedAt: 50, projections: { values: { title: 'Archived' } } },
    { sessionId: 'session-unassigned', blank: false, running: true, updatedAt: 20, projections: { values: { title: 'Loose' } } },
    { sessionId: 'subagent', blank: false, origin: 'subagent', running: false, updatedAt: 60, projections: { values: { title: 'Subagent' } } },
  ];
  const workspaceData = {
    archivedSessionIds: ['session-archived'],
    items: [
      { workspaceId: 'workspace-a', title: '工作区 A', path: 'D:/a', sessionIds: ['session-a', 'session-blank'] },
      { workspaceId: 'workspace-empty', title: '空工作区', path: 'D:/empty', sessionIds: [] },
    ],
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/web/api/sessions`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      items: [
        { sessionId: 'session-a', title: 'A', running: false },
        { sessionId: 'session-unassigned', title: 'Loose', running: true },
      ],
      groups: [
        { workspaceId: 'workspace-a', title: '工作区 A', sessions: [{ sessionId: 'session-a', title: 'A', running: false }] },
        { workspaceId: '__ungrouped__', title: '未分组', sessions: [{ sessionId: 'session-unassigned', title: 'Loose', running: true }] },
      ],
    });
    const previews = await (await fetch(`${baseUrl}/web/api/previews`)).json();
    assert.deepEqual(previews.previews.map((preview) => preview.sessionId), ['session-a', 'session-unassigned']);
  }, { sessionItems, workspaceData });
});

test('sidebar renders workspace groups and excludes blank or archived sessions', async () => {
  const sessionItems = [
    { sessionId: 'session-test', blank: false, running: false, updatedAt: 30, projections: { values: { title: '当前会话' } } },
    { sessionId: 'session-blank', blank: true, running: false, updatedAt: 40, projections: { values: {} } },
    { sessionId: 'session-archived', blank: false, running: false, updatedAt: 50, projections: { values: { title: '已归档' } } },
    { sessionId: 'session-loose', blank: false, running: true, updatedAt: 20, projections: { values: { title: '未分组会话' } } },
  ];
  const workspaceData = {
    archivedSessionIds: ['session-archived'],
    items: [
      { workspaceId: 'workspace-a', title: '工作区 A', path: 'D:/a', sessionIds: ['session-test', 'session-blank'] },
      { workspaceId: 'workspace-empty', title: '空工作区', path: 'D:/empty', sessionIds: [] },
    ],
  };
  await withServer(async (baseUrl) => {
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(
        () => evaluate(cdp, `document.querySelectorAll('#sessions .workspace-group').length === 2`),
        'workspace groups did not render',
      );
      assert.deepEqual(
        await evaluate(cdp, `Array.from(document.querySelectorAll('#sessions .workspace-title')).map((node) => node.textContent)`),
        ['工作区 A', '未分组'],
      );
      assert.deepEqual(
        await evaluate(cdp, `Array.from(document.querySelectorAll('#sessions .sess .t')).map((node) => node.textContent)`),
        ['当前会话', '未分组会话'],
      );
      assert.equal(await evaluate(cdp, `document.querySelector('[data-workspace-id="workspace-a"] .workspace-count').textContent`), '1');
      await evaluate(cdp, `document.querySelector('[data-workspace-id="workspace-a"] .workspace-head').click()`);
      assert.equal(await evaluate(cdp, `document.querySelector('[data-workspace-id="workspace-a"]').classList.contains('collapsed')`), true);
      assert.equal(await evaluate(cdp, `document.querySelector('[data-workspace-id="workspace-a"] .workspace-sessions').children.length`), 1);
      assert.deepEqual(await evaluate(cdp, `JSON.parse(localStorage.getItem('dsh_collapsed_workspaces'))`), ['workspace-a']);
    });
  }, { sessionItems, workspaceData });
});

test('desktop sidebar keeps workspace groups visible and collapsible', async () => {
  const sessionItems = [
    { sessionId: 'session-test', blank: false, running: false, updatedAt: 30, projections: { values: { title: '当前会话' } } },
  ];
  const workspaceData = {
    archivedSessionIds: [],
    items: [{ workspaceId: 'workspace-desktop', title: '桌面工作区', path: 'D:/desktop', sessionIds: ['session-test'] }],
  };
  await withServer(async (baseUrl) => {
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(
        () => evaluate(cdp, `document.querySelector('[data-workspace-id="workspace-desktop"]') !== null`),
        'desktop workspace did not render',
      );
      assert.equal(await evaluate(cdp, `innerWidth >= 720`), true);
      assert.notEqual(await evaluate(cdp, `getComputedStyle(document.getElementById('sidebar')).display`), 'none');
    }, { windowSize: '1280,900' });
  }, { sessionItems, workspaceData });
});

test('Bridge cancellation settles an active stream without waiting for turn/end', async () => {
  const cancelCalls = [];
  let bridge;
  bridge = new Bridge({
    dsh: {
      async sessionCancel({ sessionId }) {
        cancelCalls.push(sessionId);
        bridge.dispatch({ payload: {
          type: 'session/event', sessionId,
          event: { type: 'turn/end', data: { reason: { kind: 'interrupted' } } },
        } });
        return { accepted: true };
      },
    },
    config: { dsh: {} },
    turnTimeoutMs: 5000,
  });
  const waiter = bridge.beginWait('session-test');
  bridge.dispatch({ payload: {
    type: 'session/event',
    sessionId: 'session-test',
    event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '部分回复' } } },
  } });
  const receipt = await bridge.cancelSession('session-test');
  assert.deepEqual(receipt, { accepted: true });
  assert.deepEqual(cancelCalls, ['session-test']);
  assert.deepEqual(await waiter.promise, { kind: 'cancelled', text: '部分回复' });
  assert.equal(bridge.pending.has('session-test'), false);
});

test('Bridge streams reasoning deltas separately from text', async () => {
  const bridge = new Bridge({ dsh: {}, config: { dsh: {} }, turnTimeoutMs: 5000 });
  const deltas = [];
  const reasonings = [];
  const waiter = bridge.beginWait('session-test', {
    onDelta: (d) => deltas.push(d),
    onReasoning: (d) => reasonings.push(d),
  });
  bridge.dispatch({ payload: { type: 'session/event', sessionId: 'session-test', event: { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', index: 0, text: '让我想想' } } } } });
  bridge.dispatch({ payload: { type: 'session/event', sessionId: 'session-test', event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 1, text: '答案是 42' } } } } });
  bridge.dispatch({ payload: { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });
  const result = await waiter.promise;
  assert.deepEqual(reasonings, ['让我想想']);
  assert.deepEqual(deltas, ['答案是 42']);
  assert.equal(result.kind, 'done');
});

test('subagents endpoint returns child entries with running state', async () => {
  await withServer(async (baseUrl, { state }) => {
    state.subagentEntries = [
      { kind: 'child', id: 'child-1', activity: 'running', hasChildren: false, mode: 'continuable', label: '审查助手' },
      { kind: 'child', id: 'child-2', activity: 'inactive', hasChildren: false, mode: 'one-shot' },
    ];
    const r = await fetch(`${baseUrl}/web/api/subagents?sessionId=session-test`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { entries: state.subagentEntries, parentAvailable: true });
  });
});

test('thirty subagents stay collapsed by default and expand inside a scroll area', async () => {
  await withServer(async (baseUrl, { state }) => {
    state.subagentEntries = Array.from({ length: 30 }, (_, i) => ({
      kind: 'child',
      id: `child-${i + 1}`,
      activity: i < 3 ? 'running' : 'inactive',
      hasChildren: false,
      mode: i % 2 ? 'one-shot' : 'continuable',
      ...(i % 2 ? {} : { label: `子 agent ${i + 1} - 长任务标签` }),
    }));
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(
        () => evaluate(cdp, `document.getElementById('subagentBar').classList.contains('show')`),
        'subagent bar did not render',
      );
      assert.equal(
        await evaluate(cdp, `document.querySelector('#subagentBar .subagent-title').textContent`),
        '🤖 3 个工作中 · 27 个空闲 · 共 30 个',
      );
      assert.equal(await evaluate(cdp, `document.getElementById('subagentBar').classList.contains('expanded')`), false);
      assert.equal(await evaluate(cdp, `getComputedStyle(document.querySelector('#subagentBar .subagent-list')).display`), 'none');
      assert.ok(await evaluate(cdp, `document.getElementById('subagentBar').getBoundingClientRect().height <= 42`));

      await evaluate(cdp, `document.querySelector('#subagentBar .subagent-summary').click()`);
      assert.equal(await evaluate(cdp, `document.getElementById('subagentBar').classList.contains('expanded')`), true);
      assert.equal(await evaluate(cdp, `getComputedStyle(document.querySelector('#subagentBar .subagent-list')).display`), 'flex');
      assert.equal(await evaluate(cdp, `document.querySelectorAll('#subagentBar .subagent-item').length`), 30);
      assert.ok(await evaluate(cdp, `(() => { const list = document.querySelector('#subagentBar .subagent-list'); return list.scrollHeight > list.clientHeight && list.clientHeight <= 220; })()`));
      assert.equal(await evaluate(cdp, `localStorage.getItem('dsh_subagents_expanded')`), '1');
    });
  });
});

test('history includes assistant reasoning blocks', async () => {
  const historyEvents = [
    { event: { seq: 1, type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: '让我想想…' },
      { type: 'text', text: '答案是 42' },
    ] } } } },
  ];
  await withServer(async (baseUrl) => {
    const r = await fetch(`${baseUrl}/web/api/history?sessionId=session-test&maxMessages=5`);
    const d = await r.json();
    assert.deepEqual(d.messages, [{ role: 'assistant', text: '答案是 42', reasoning: '让我想想…', seq: 1 }]);
  }, { historyEvents });
});

test('cancel API returns the real DSH acceptance receipt', async () => {
  await withServer(async (baseUrl, { state }) => {
    const response = await fetch(`${baseUrl}/web/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-test' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: true });
    assert.deepEqual(state.cancelCalls, ['session-test']);
  });
});

test('send SSE reports cancellation explicitly instead of timing out', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/web/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-test', content: '长任务' }),
    });
    const body = await response.text();
    assert.match(body, /"type":"cancelled"/);
    assert.doesNotMatch(body, /"type":"timeout"/);
  }, { sendResult: { kind: 'cancelled', text: '部分回复' } });
});

test('cancel button shows progress and acceptance feedback', async () => {
  const sessionItems = [{
    sessionId: 'session-test', origin: 'user', blank: false, running: true, updatedAt: 1,
    projections: { values: { title: '运行中的会话' } },
  }];
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(
        () => evaluate(cdp, `document.getElementById('cancelBtn').classList.contains('show')`),
        'cancel button did not appear for a running session',
      );
      await evaluate(cdp, `document.getElementById('cancelBtn').click()`);
      assert.deepEqual(await evaluate(cdp, `({
        disabled: document.getElementById('cancelBtn').disabled,
        text: document.getElementById('cancelBtn').textContent,
      })`), { disabled: true, text: '打断中…' });
      await waitFor(() => state.cancelCalls.length === 1, 'cancel request did not reach DSH');
      await waitFor(
        () => evaluate(cdp, `document.getElementById('toast').textContent === '已请求打断'`),
        'cancel acceptance feedback did not appear',
      );
    });
  }, { sessionItems, cancelDelayMs: 200 });
});

test('cancelled SSE keeps the partial reply without an inline marker', async () => {
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(
        () => evaluate(cdp, `document.getElementById('loadingEl') === null`),
        'fixture session history did not finish loading',
      );
      await evaluate(cdp, `(() => {
        document.getElementById('input').value = '执行长任务';
        document.getElementById('send').click();
      })()`);
      await waitFor(() => state.sendCalls.length === 1, 'message did not start');
      await waitFor(
        () => evaluate(cdp, `webRunningSet.has('session-test') === false`),
        'cancelled stream did not finish',
      );
      assert.equal(
        await evaluate(cdp, `Array.from(document.querySelectorAll('.msg.assistant .bubble')).at(-1).textContent`),
        '部分回复',
      );
    });
  }, { sendResult: { kind: 'cancelled', text: '部分回复' } });
});

test('a stream started in one session clears that session after switching away', async () => {
  const sessionItems = [
    { sessionId: 'session-test', origin: 'user', blank: false, running: false, updatedAt: 2, projections: { values: { title: '会话 A' } } },
    { sessionId: 'session-other', origin: 'user', blank: false, running: false, updatedAt: 1, projections: { values: { title: '会话 B' } } },
  ];
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(() => evaluate(cdp, `document.getElementById('loadingEl') === null`), 'session A did not finish loading');
      await evaluate(cdp, `(() => {
        document.getElementById('input').value = '会话 A 的任务';
        document.getElementById('send').click();
      })()`);
      await waitFor(() => state.sendCalls.length === 1, 'session A did not start');
      await evaluate(cdp, `openSession('session-other')`);
      await waitFor(() => evaluate(cdp, `currentSessionId === 'session-other' && document.getElementById('loadingEl') === null`), 'did not switch to session B');
      await delay(350);
      assert.equal(await evaluate(cdp, `webRunningSet.has('session-test')`), false);
      assert.equal(await evaluate(cdp, `webRunningSet.has('session-other')`), false);
    });
  }, { sessionItems, sendDelayMs: 200 });
});

test('a stale syncHistory response does not pollute the newly opened session', async () => {
  const sessionItems = [
    { sessionId: 'session-test', origin: 'user', blank: false, running: false, updatedAt: 2, projections: { values: { title: '会话 A' } } },
    { sessionId: 'session-other', origin: 'user', blank: false, running: false, updatedAt: 1, projections: { values: { title: '会话 B' } } },
  ];
  await withServer(async (baseUrl, { state }) => {
    state.historyBySession = {
      'session-test': [{ event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'A1' }], source: { kind: 'user' } } } }],
      'session-other': [],
    };
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(() => evaluate(cdp, `document.querySelectorAll('.msg').length === 1`), 'session A did not load');
      // A 产生新消息 seq 2，然后触发一个延迟中的 syncHistory（拉 A），并立即切到 B
      state.historyBySession['session-test'] = [
        { event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'A1' }], source: { kind: 'user' } } } },
        { event: { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'A2' }], source: { kind: 'user' } } } },
      ];
      await evaluate(cdp, `syncHistory(); true`);           // 不 await，让它悬着
      await evaluate(cdp, `openSession('session-other')`); // 立即切 B
      await waitFor(() => evaluate(cdp, `currentSessionId === 'session-other' && document.getElementById('loadingEl') === null`), 'did not switch to session B');
      await delay(350);   // 等 A 的过期 syncHistory 响应落地
      assert.deepEqual(await evaluate(cdp, `(sessionCache.get('session-other') || {}).messages || []`), []);
      assert.equal(await evaluate(cdp, `document.querySelectorAll('.msg').length`), 0);
    });
  }, { sessionItems, historyDelayMs: 200 });
});

test('running banner and sidebar label show for a streaming session after switching', async () => {
  const sessionItems = [
    { sessionId: 'session-test', origin: 'user', blank: false, running: false, updatedAt: 2, projections: { values: { title: '会话 A' } } },
    { sessionId: 'session-other', origin: 'user', blank: false, running: false, updatedAt: 1, projections: { values: { title: '会话 B' } } },
  ];
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(() => evaluate(cdp, `document.getElementById('loadingEl') === null`), 'session A did not load');
      await evaluate(cdp, `(() => {
        document.getElementById('input').value = '长任务';
        document.getElementById('send').click();
      })()`);
      await waitFor(() => state.sendCalls.length === 1, 'stream did not start');
      await waitFor(() => evaluate(cdp, `document.getElementById('runningBanner').classList.contains('show')`), 'running banner did not show while streaming');
      await evaluate(cdp, `openSession('session-other')`);
      await waitFor(() => evaluate(cdp, `currentSessionId === 'session-other' && document.getElementById('loadingEl') === null`), 'did not switch to session B');
      assert.equal(await evaluate(cdp, `document.querySelector('.sess[data-session-id="session-test"]').classList.contains('running')`), true);
      assert.equal(await evaluate(cdp, `document.querySelector('.sess[data-session-id="session-test"] .run-label').textContent`), '运行中');
    });
  }, { sessionItems, sendDelayMs: 400 });
});

test('cancel appends a system interruption marker in the conversation', async () => {
  const sessionItems = [
    { sessionId: 'session-test', origin: 'user', blank: false, running: true, updatedAt: 1, projections: { values: { title: '运行中' } } },
  ];
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(
        () => evaluate(cdp, `document.getElementById('cancelBtn').classList.contains('show')`),
        'cancel button did not appear',
      );
      await evaluate(cdp, `document.getElementById('cancelBtn').click()`);
      await waitFor(() => state.cancelCalls.length === 1, 'cancel did not reach DSH');
      await waitFor(
        () => evaluate(cdp, `Array.from(document.querySelectorAll('.msg.system .bubble')).some((b) => b.textContent === '⛔ 已打断')`),
        'system interruption marker did not appear',
      );
    });
  }, { sessionItems });
});

test('running indicators survive a page load for an active session', async () => {
  const sessionItems = [
    { sessionId: 'session-test', origin: 'user', blank: false, running: true, updatedAt: 1, projections: { values: { title: '工作中' } } },
  ];
  await withServer(async (baseUrl) => {
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(
        () => evaluate(cdp, `document.getElementById('runningHint').classList.contains('show')`),
        'running hint did not show after load',
      );
      assert.equal(await evaluate(cdp, `document.getElementById('cancelBtn').classList.contains('show')`), true);
      assert.equal(await evaluate(cdp, `document.querySelector('.sess.running .dot') !== null`), true);
    });
  }, { sessionItems });
});

test('clear-cache button is removed and refresh re-fetches the session authoritatively', async () => {
  const historyEvents = [
    { event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '正确消息' }], source: { kind: 'user' } } } },
    { event: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正确回复' }] } } } },
  ];
  const staleCache = JSON.stringify([['session-test', {
    messages: [{ role: 'user', text: '错误消息', seq: 1 }],
    hasMore: false, oldestSeq: 1, latestSeq: 1,
  }]]);
  await withServer(async (baseUrl) => {
    await withBrowser(baseUrl, async (cdp) => {
      assert.equal(await evaluate(cdp, `Array.from(document.querySelectorAll('.tool-btn')).some((b) => b.textContent === '清理缓存')`), false);
      assert.equal(await evaluate(cdp, `document.getElementById('clearMenu') === null`), true);
      assert.deepEqual(
        await evaluate(cdp, `Array.from(document.querySelectorAll('.msg .bubble')).map((b) => b.textContent)`),
        ['错误消息'],
      );
      await evaluate(cdp, `manualRefresh()`);
      await waitFor(
        () => evaluate(cdp, `Array.from(document.querySelectorAll('.msg .bubble')).some((b) => b.textContent === '正确回复')`),
        'refresh did not re-fetch the session',
      );
      assert.deepEqual(
        await evaluate(cdp, `Array.from(document.querySelectorAll('.msg .bubble')).map((b) => b.textContent)`),
        ['正确消息', '正确回复'],
      );
    }, {
      beforeReload: `localStorage.setItem('dsh_cache_version', '3'); localStorage.setItem('dsh_cache', ${JSON.stringify(staleCache)}); true`,
    });
  }, { historyEvents });
});

test('a floating bubble appears for new messages when scrolled up', async () => {
  const initial = Array.from({ length: 30 }, (_, i) => ({
    event: { seq: i + 1, type: 'user/message', data: { content: [{ type: 'text', text: '消息 ' + (i + 1) }], source: { kind: 'user' } } },
  }));
  await withServer(async (baseUrl, { state }) => {
    state.historyEvents = initial.slice();
    await withBrowser(baseUrl, async (cdp) => {
      await waitFor(
        () => evaluate(cdp, `document.querySelectorAll('.msg.user').length === 20`),
        'initial messages did not render',
      );
      await evaluate(cdp, `document.getElementById('messages').scrollTop = 0; true`);
      assert.equal(await evaluate(cdp, `isAtBottom()`), false);
      state.historyEvents = initial.concat([
        { event: { seq: 31, type: 'user/message', data: { content: [{ type: 'text', text: '新消息' }], source: { kind: 'user' } } } },
      ]);
      await evaluate(cdp, `syncHistory()`);
      await waitFor(
        () => evaluate(cdp, `document.getElementById('newMsgBtn').classList.contains('show') && document.getElementById('newMsgCount').textContent === '1'`),
        'new message bubble did not appear',
      );
      await evaluate(cdp, `document.getElementById('newMsgBtn').click()`);
      assert.equal(await evaluate(cdp, `isAtBottom()`), true);
      assert.equal(await evaluate(cdp, `document.getElementById('newMsgBtn').classList.contains('show')`), false);
    });
  }, { historyEvents: initial });
});

test('slash options API returns commands and skills for one session', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/web/api/slash-options?sessionId=session-test`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      commands: [
        { name: 'goal', description: 'set or view the goal', input: { hint: '[objective]' } },
        { name: 'compact', description: 'compact older history' },
      ],
      skills: [
        { name: 'grill-me', description: 'stress-test a plan', modelInvocable: false },
        { name: 'tdd', description: 'develop test-first', modelInvocable: true },
      ],
    });
  });
});

test('slash options API keeps skills when the command catalog fails', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/web/api/slash-options?sessionId=session-test`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      commands: [],
      skills: [
        { name: 'grill-me', description: 'stress-test a plan', modelInvocable: false },
        { name: 'tdd', description: 'develop test-first', modelInvocable: true },
      ],
    });
  }, { commandsError: true });
});

test('history and previews hide skill injections but keep real user text', async () => {
  const historyEvents = [
    { event: { seq: 1, type: 'user/message', data: {
      content: [{ type: 'text', text: '<skill_content name="grill-me">hidden</skill_content>' }],
      source: { kind: 'skill-invocation', name: 'grill-me', form: 'instructions' },
    } } },
    { event: { seq: 2, type: 'user/message', data: {
      content: [{ type: 'text', text: 'Background subagent abc finished and will do no further work.' }],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'abc' },
    } } },
    { event: { seq: 3, type: 'user/message', data: {
      content: [{ type: 'text', text: 'Background subagent def reported: something' }],
      source: { kind: 'subagent-report', senderSessionId: 'def' },
    } } },
    { event: { seq: 4, type: 'user/message', data: {
      content: [{ type: 'text', text: '<skill_content name="quoted">real text</skill_content>' }],
      source: { kind: 'user' },
    } } },
  ];
  await withServer(async (baseUrl) => {
    const history = await (await fetch(`${baseUrl}/web/api/history?sessionId=session-test`)).json();
    const previews = await (await fetch(`${baseUrl}/web/api/previews`)).json();
    const expected = ['<skill_content name="quoted">real text</skill_content>'];
    assert.deepEqual(history.messages.map((message) => message.text), expected);
    assert.deepEqual(previews.previews[0].messages.map((message) => message.text), expected);
  }, { historyEvents });
});

test('history over-fetches past injected messages to return maxMessages visible', async () => {
  const events = [
    { event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'M1' }], source: { kind: 'user' } } } },
    { event: { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: '注入2' }], source: { kind: 'subagent-settled' } } } },
    { event: { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '注入3' }], source: { kind: 'subagent-settled' } } } },
    { event: { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: '注入4' }], source: { kind: 'subagent-settled' } } } },
    { event: { seq: 5, type: 'user/message', data: { content: [{ type: 'text', text: 'M5' }], source: { kind: 'user' } } } },
    { event: { seq: 6, type: 'user/message', data: { content: [{ type: 'text', text: 'M6' }], source: { kind: 'user' } } } },
    { event: { seq: 7, type: 'user/message', data: { content: [{ type: 'text', text: 'M7' }], source: { kind: 'user' } } } },
    { event: { seq: 8, type: 'user/message', data: { content: [{ type: 'text', text: 'M8' }], source: { kind: 'user' } } } },
  ];
  await withServer(async (baseUrl, { state }) => {
    state.historyBySession['session-test'] = events;
    const r = await fetch(`${baseUrl}/web/api/history?sessionId=session-test&maxMessages=5`);
    const d = await r.json();
    assert.deepEqual(d.messages.map((m) => m.text), ['M1', 'M5', 'M6', 'M7', 'M8']);
    assert.equal(d.hasMore, false);
    assert.equal(d.oldestSeq, 1);
  });
});

test('typing slash opens commands and skills with Chinese descriptions', async () => {
  await withServer(async (baseUrl) => {
    await withBrowser(baseUrl, async (cdp) => {
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '/';
        input.focus();
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(
        () => evaluate(cdp, `document.querySelectorAll('#slashMenu .slash-item').length === 4`),
        'slash menu did not load commands and skills',
      );
      const items = await evaluate(cdp, `Array.from(document.querySelectorAll('#slashMenu .slash-item')).map((item) => ({
        name: item.querySelector('.slash-name')?.textContent,
        kind: item.querySelector('.slash-kind')?.textContent,
        description: item.querySelector('.slash-desc')?.textContent,
      }))`);
      assert.deepEqual(items, [
        { name: '/compact', kind: '命令', description: '压缩较早的对话历史' },
        { name: '/goal', kind: '命令', description: '查看或管理长期任务目标' },
        { name: '/grill-me', kind: '技能', description: '通过连续追问打磨方案与决策' },
        { name: '/tdd', kind: '技能', description: '用测试驱动方式开发或修复问题' },
      ]);
      const geometry = await evaluate(cdp, `(() => {
        const menu = document.getElementById('slashMenu').getBoundingClientRect();
        const inputbar = document.getElementById('inputbar').getBoundingClientRect();
        return { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom, inputTop: inputbar.top, width: innerWidth, height: innerHeight };
      })()`);
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.width);
      assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.inputTop && geometry.bottom <= geometry.height);
    });
  });
});

test('selecting an at-triggered skill replaces the token without sending', async () => {
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '请用 @gr';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(
        () => evaluate(cdp, `document.querySelectorAll('#slashMenu .slash-item').length === 1`),
        'skill filter did not narrow the menu',
      );
      await evaluate(cdp, `document.querySelector('#slashMenu .slash-item').click()`);
      const result = await evaluate(cdp, `({
        value: document.getElementById('input').value,
        focused: document.activeElement === document.getElementById('input'),
        menuOpen: document.getElementById('slashMenu').classList.contains('show'),
      })`);
      assert.deepEqual(result, { value: '请用 /grill-me ', focused: true, menuOpen: false });
      assert.equal(state.sendCalls.length, 0);
    });
  });
});

test('arrow keys and Enter select a slash candidate without sending', async () => {
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '/';
        input.focus();
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(
        () => evaluate(cdp, `document.querySelectorAll('#slashMenu .slash-item').length === 4`),
        'slash menu did not load for keyboard selection',
      );
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`);
      assert.equal(await evaluate(cdp, `document.getElementById('input').value`), '/goal ');
      assert.equal(state.sendCalls.length, 0);
    });
  });
});

test('phone Enter inserts a newline and only the send button submits', async () => {
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '第一行';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      })()`);
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        commands: ['insertLineBreak'],
      });
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
      assert.equal(await evaluate(cdp, `document.getElementById('input').value`), '第一行\n');
      assert.equal(state.sendCalls.length, 0);
      await evaluate(cdp, `document.getElementById('send').click()`);
      await waitFor(() => state.sendCalls.length === 1, 'send button did not submit the message');
      assert.deepEqual(state.sendCalls, [{ sessionId: 'session-test', content: '第一行' }]);
    }, { mobile: true });
  });
});

test('desktop Enter sends and Shift+Enter inserts a newline', async () => {
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      assert.equal(await evaluate(cdp, `isDesktopDevice()`), true);
      // 桌面 Enter（无 Shift）→ 发送
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '桌面发送';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      })()`);
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
      await waitFor(() => state.sendCalls.length === 1, 'desktop Enter did not send');
      assert.equal(state.sendCalls[0].content, '桌面发送');
      // Shift+Enter → 换行（不发送）
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '第一行';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      })()`);
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        modifiers: 8, commands: ['insertLineBreak'],
      });
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8,
      });
      assert.equal(await evaluate(cdp, `document.getElementById('input').value`), '第一行\n');
      assert.equal(state.sendCalls.length, 1);
    }, { windowSize: '1280,900' });
  });
});

test('choosing an attachment stages it and sends it together with typed text', async () => {
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      await evaluate(cdp, `(async () => {
        const file = new File(['附件正文'], 'notes.txt', { type: 'text/plain' });
        await sendFile({ files: [file], value: 'selected' });
      })()`);
      assert.equal(state.sendCalls.length, 0);
      assert.equal(await evaluate(cdp, `document.querySelectorAll('#attachmentTray .attachment-item').length`), 1);
      assert.equal(await evaluate(cdp, `document.querySelector('#attachmentTray .attachment-name').textContent`), 'notes.txt');
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '请结合附件回答';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send').click();
      })()`);
      await waitFor(() => state.sendCalls.length === 1, 'staged attachment was not sent');
      assert.deepEqual(state.sendCalls, [{
        sessionId: 'session-test',
        content: '请结合附件回答',
        blocks: [
          { type: 'text', text: '【用户上传文件：notes.txt】\n附件正文' },
          { type: 'text', text: '请结合附件回答' },
        ],
      }]);
      assert.equal(await evaluate(cdp, `document.querySelectorAll('#attachmentTray .attachment-item').length`), 0);
      assert.equal(await evaluate(cdp, `document.getElementById('input').value`), '');
    });
  });
});

test('multiple image attachments can be staged and removed before sending', async () => {
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      const pickerConfig = await evaluate(cdp, `({
        imageAccept: document.getElementById('imageInput').accept,
        imageMultiple: document.getElementById('imageInput').multiple,
        textAccept: document.getElementById('textFileInput').accept,
      })`);
      assert.deepEqual(pickerConfig, {
        imageAccept: 'image/png,image/jpeg,image/webp,image/gif',
        imageMultiple: true,
        textAccept: '.txt,.md,.markdown,.json,.csv,.yaml,.yml,.xml,text/plain,text/markdown,application/json,text/csv,application/xml,text/xml',
      });
      await evaluate(cdp, `(async () => {
        const first = new File([new Uint8Array([1, 2, 3])], 'first.png', { type: 'image/png' });
        const second = new File([new Uint8Array([4, 5, 6])], 'second.png', { type: 'image/png' });
        await sendFile({ files: [first, second], value: 'selected' });
      })()`);
      assert.equal(state.sendCalls.length, 0);
      assert.deepEqual(
        await evaluate(cdp, `Array.from(document.querySelectorAll('#attachmentTray .attachment-name')).map((node) => node.textContent)`),
        ['first.png', 'second.png'],
      );
      await evaluate(cdp, `document.querySelector('#attachmentTray .attachment-remove').click()`);
      assert.deepEqual(
        await evaluate(cdp, `Array.from(document.querySelectorAll('#attachmentTray .attachment-name')).map((node) => node.textContent)`),
        ['second.png'],
      );
      await evaluate(cdp, `(() => {
        document.getElementById('input').value = '请分析图片';
        document.getElementById('send').click();
      })()`);
      await waitFor(() => state.sendCalls.length === 1, 'image and text were not sent together');
      assert.deepEqual(state.sendCalls[0], {
        sessionId: 'session-test',
        content: '请分析图片',
        blocks: [
          { type: 'image', mediaType: 'image/png', data: 'BAUG' },
          { type: 'text', text: '请分析图片' },
        ],
      });
    });
  });
});

test('clicking outside closes the slash menu', async () => {
  await withServer(async (baseUrl) => {
    await withBrowser(baseUrl, async (cdp) => {
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '/';
        input.focus();
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(
        () => evaluate(cdp, `document.querySelectorAll('#slashMenu .slash-item').length === 4`),
        'slash menu did not open before outside click',
      );
      await evaluate(cdp, `document.getElementById('messages').click()`);
      assert.equal(await evaluate(cdp, `document.getElementById('slashMenu').classList.contains('show')`), false);
    });
  });
});

test('an old browser cache cannot keep injected skill content visible', async () => {
  await withServer(async (baseUrl) => {
    const cached = JSON.stringify([['session-test', {
      messages: [{ role: 'user', text: '<skill_content name="grill-me">hidden</skill_content>', seq: 1 }],
      hasMore: false,
      oldestSeq: 1,
      latestSeq: 1,
    }]]);
    await withBrowser(baseUrl, async (cdp) => {
      const visible = await evaluate(cdp, `Array.from(document.querySelectorAll('.msg .bubble')).some((bubble) => bubble.textContent.startsWith('<skill_content'))`);
      assert.equal(visible, false);
    }, {
      beforeReload: `localStorage.setItem('dsh_cache', ${JSON.stringify(cached)}); true`,
    });
  });
});

test('sending a completed slash command closes its candidate menu', async () => {
  await withServer(async (baseUrl, { state }) => {
    await withBrowser(baseUrl, async (cdp) => {
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '/compact';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(
        () => evaluate(cdp, `document.querySelectorAll('#slashMenu .slash-item').length === 1`),
        'compact candidate did not appear',
      );
      await evaluate(cdp, `document.getElementById('send').click()`);
      await waitFor(() => state.sendCalls.length === 1, 'slash command was not sent');
      assert.equal(await evaluate(cdp, `document.getElementById('slashMenu').classList.contains('show')`), false);
    });
  });
});

test('secondary slash shows skills only and no-input commands complete without a space', async () => {
  await withServer(async (baseUrl) => {
    await withBrowser(baseUrl, async (cdp) => {
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '请用 /';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(
        () => evaluate(cdp, `document.querySelectorAll('#slashMenu .slash-item').length === 2`),
        'secondary slash did not show the skill catalog',
      );
      assert.deepEqual(
        await evaluate(cdp, `Array.from(document.querySelectorAll('#slashMenu .slash-kind')).map((item) => item.textContent)`),
        ['技能', '技能'],
      );
      await evaluate(cdp, `document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
      assert.equal(await evaluate(cdp, `document.getElementById('slashMenu').classList.contains('show')`), false);

      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '/co';
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(
        () => evaluate(cdp, `document.querySelectorAll('#slashMenu .slash-item').length === 1`),
        'compact filter did not narrow the command catalog',
      );
      await evaluate(cdp, `document.querySelector('#slashMenu .slash-item').click()`);
      assert.equal(await evaluate(cdp, `document.getElementById('input').value`), '/compact');
    });
  });
});

test('closing a loading slash menu prevents a stale request from reopening it', async () => {
  await withServer(async (baseUrl) => {
    await withBrowser(baseUrl, async (cdp) => {
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '/';
        input.focus();
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('messages').click();
      })()`);
      await delay(350);
      assert.equal(await evaluate(cdp, `document.getElementById('slashMenu').classList.contains('show')`), false);
    });
  }, { catalogDelayMs: 200 });
});

test('touching a skill candidate completes it on a phone viewport', async () => {
  await withServer(async (baseUrl) => {
    await withBrowser(baseUrl, async (cdp) => {
      await evaluate(cdp, `(() => {
        const input = document.getElementById('input');
        input.value = '@gr';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(
        () => evaluate(cdp, `document.querySelectorAll('#slashMenu .slash-item').length === 1`),
        'skill candidate did not appear for touch selection',
      );
      const point = await evaluate(cdp, `(() => {
        const rect = document.querySelector('#slashMenu .slash-item').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      await cdp.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
      await cdp.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitFor(
        () => evaluate(cdp, `document.getElementById('input').value === '/grill-me '`),
        'touch selection did not complete the skill',
      );
    });
  });
});
