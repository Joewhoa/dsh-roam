import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 极简 JSON 文件持久化（会话映射等小数据）。原子写：先写临时文件再改名。 */
export class JsonStore {
  constructor(path) {
    this.path = path;
    this.data = {};
    this._load();
  }

  _load() {
    try {
      this.data = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
  }

  del(key) {
    delete this.data[key];
    this._save();
  }

  all() {
    return this.data;
  }

  _save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(tmp, this.path);
    } catch (e) {
      console.error('[store] 写入失败:', e.message);
    }
  }
}
