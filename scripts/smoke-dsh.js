import { DshClient } from '../src/dsh/client.js';
import { config } from '../src/config.js';

const client = new DshClient(config.dsh.baseUrl);

function summarize(frame) {
  const p = frame.payload ?? {};
  switch (p.type) {
    case 'session/event': {
      const ev = p.event ?? {};
      return `session/event  seq=${ev.seq}  evType=${ev.type}  data=${json(ev.data)}`;
    }
    case 'session/subscribed':
      return `session/subscribed  lastSeq=${p.lastSeq}`;
    case 'approval/requested':
      return `approval/requested  tool=${p.toolName}  reason=${p.reason ?? ''}`;
    case 'approval/resolved':
      return `approval/resolved  outcome=${p.outcome}`;
    case 'question/requested':
      return `question/requested  questions=${p.questions?.length ?? 0}`;
    case 'stream/error':
      return `stream/error  ${json(p.error)}`;
    default:
      return `${p.type ?? '(unknown)'}  ${json(p)}`;
  }
}

function json(v) {
  const s = JSON.stringify(v);
  return s === undefined ? '' : s.length > 240 ? s.slice(0, 240) + '…' : s;
}

async function list() {
  const res = await client.sessionList({});
  console.log(`session.list → ${res.items.length} 个会话\n`);
  for (const it of res.items.slice(0, 10)) {
    console.log(
      `  ${it.sessionId}  running=${it.running}  blank=${it.blank}  cwd=${it.cwd ?? '-'}  preset=${it.agentPreset ?? '-'}`
    );
  }
}

async function prompt(text) {
  const created = await client.sessionCreate({
    ...(config.dsh.cwd ? { cwd: config.dsh.cwd } : {}),
    ...(config.dsh.agentPreset ? { agentPreset: config.dsh.agentPreset } : {}),
  });
  const sessionId = created.sessionId;
  console.log(`session.create → ${sessionId}`);

  const aborter = new AbortController();
  const stream = client.eventsMux({ signal: aborter.signal });

  const accepted = await client.sessionPrompt({
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  });
  console.log(`session.prompt → accepted=${accepted.accepted}${accepted.command ? ` command=${json(accepted.command)}` : ''}`);

  // 只消费属于本会话的帧，直到 turn/end 或超时。
  let done = false;
  let assistantText = '';
  const deadline = setTimeout(() => {
    console.log('\n[timeout] 60s 未等到 turn/end，主动中断');
    aborter.abort();
  }, 60_000);

  try {
    for await (const frame of stream) {
      const p = frame.payload ?? {};
      if (p.sessionId !== sessionId) continue; // mux 混流，只取本会话
      const line = summarize(frame);
      console.log(line);

      if (p.type === 'session/event') {
        const ev = p.event ?? {};
        // 尽力提取 assistant 文本：事件名为 message/* 且带 content 文本块时。
        if (typeof ev.type === 'string' && ev.type.includes('message') && ev.data) {
          const text = extractText(ev.data);
          if (text) assistantText += text;
        }
        if (ev.type === 'turn/end') {
          done = true;
          break;
        }
      }
    }
  } catch (e) {
    console.log(`[stream ended] ${e.message}`);
  } finally {
    clearTimeout(deadline);
  }

  console.log('\n===== 提取到的 assistant 文本 =====');
  console.log(assistantText.trim() || '(未提取到文本，见上方事件数据)');
  console.log(`\n[done=${done}] 会话 ${sessionId} 可在 Web GUI 中继续查看`);
}

// 深度优先在事件 data 里找文本类字段（content 数组 / text / content 字符串）。
function extractText(node, depth = 0) {
  if (node == null || depth > 6) return '';
  if (typeof node === 'string') return '';
  if (Array.isArray(node)) {
    let out = '';
    for (const item of node) out += extractText(item, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'string' && node.type === 'text' && typeof node.text === 'string') {
      return node.text;
    }
    if (typeof node.type === 'string' && node.type.includes('text') && typeof node.text === 'string') {
      return node.text;
    }
    // 常见的 content 块数组 / 对象
    if (Array.isArray(node.content)) return extractText(node.content, depth + 1);
    if (typeof node.content === 'string' && (node.type === 'text' || node.role === 'assistant')) {
      return node.content;
    }
    let out = '';
    for (const v of Object.values(node)) {
      if (typeof v === 'object' || Array.isArray(v)) out += extractText(v, depth + 1);
    }
    return out;
  }
  return '';
}

const mode = process.argv[2];
if (mode === '--list') {
  list().catch((e) => {
    console.error('失败:', e.message);
    process.exit(1);
  });
} else {
  const text = process.argv.slice(2).join(' ') || '请回复两个字：pong';
  prompt(text).catch((e) => {
    console.error('失败:', e.message);
    process.exit(1);
  });
}
