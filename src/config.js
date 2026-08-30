import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 极简 .env 加载，不引入第三方依赖。
function loadEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (line.trimStart().startsWith('#') || line.trim() === '') continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1];
      const raw = m[2];
      const val = raw.replace(/^["']/, '').replace(/["']$/, '');
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // .env 不存在则忽略，允许全部走真实环境变量。
  }
}

loadEnv(resolve(process.cwd(), '.env'));

// 读取 DeepSeek API 密钥（用于余额查询）：优先环境变量，否则从 DSH 凭证文件解析。
function loadDeepseekApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const credPath = resolve(process.env.DSH_HOME ?? 'C:\\Users\\Joe\\.dsh', '.credentials.yaml');
    const raw = readFileSync(credPath, 'utf8');
    const m = raw.match(/^\s*DEEPSEEK_API_KEY:\s*['"]?([^'"\r\n]+)['"]?\s*$/m);
    if (m) return m[1].trim();
  } catch { /* 凭证不可读则忽略 */ }
  return '';
}

export const config = {
  dsh: {
    baseUrl: (process.env.DSH_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, ''),
    cwd: process.env.DSH_CWD || undefined,
    agentPreset: process.env.DSH_AGENT_PRESET || undefined,
  },
  // Tailscale 版：不含企业微信桥接。
  server: {
    port: Number(process.env.BRIDGE_PORT ?? 8787),
  },
  web: {
    // 手机网页的访问密码（留空则不加密码，仅限可信内网用；公网务必设）。
    password: process.env.WEB_PASSWORD ?? '',
  },
  // 用于网页端余额查询的 DeepSeek API 密钥（来自凭证文件或环境变量）。
  deepseekApiKey: loadDeepseekApiKey(),
  store: {
    path: process.env.BRIDGE_STORE ?? resolve(process.cwd(), 'data', 'mappings.json'),
  },
};
