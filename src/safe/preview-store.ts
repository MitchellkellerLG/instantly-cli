import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, readdirSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { clone } from './canonical.js';

export interface PreviewRecord {
  expires: number;
  binding: string;
  command: string;
  args: Record<string, unknown>;
  planHash: string;
}
export interface PreviewStore {
  issue(record: PreviewRecord): string;
  peek(token: string): PreviewRecord;
  consume(token: string): void;
  prune(now: number): void;
}
function valid(token: string): void {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('INVALID_PREVIEW');
}
export class MemoryPreviewStore implements PreviewStore {
  private records = new Map<string, PreviewRecord>();
  issue(record: PreviewRecord): string {
    const token = randomBytes(32).toString('hex');
    this.records.set(token, clone(record));
    return token;
  }
  peek(token: string): PreviewRecord {
    valid(token);
    const record = this.records.get(token);
    if (!record) throw new Error('INVALID_PREVIEW');
    return clone(record);
  }
  prune(now: number): void {
    for (const [token, record] of this.records) if (record.expires <= now) this.records.delete(token);
  }
  consume(token: string): void {
    this.peek(token);
    if (!this.records.delete(token)) throw new Error('INVALID_PREVIEW');
  }
}
/** Local CLI handoff store. Rename atomically claims a token before dispatch. */
export class FilePreviewStore implements PreviewStore {
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const st = lstatSync(directory);
    if (!st.isDirectory() || (process.platform !== 'win32' && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))) {
      throw new Error('INSECURE_PREVIEW_STORE');
    }
  }
  private path(token: string): string { valid(token); return join(this.directory, token + '.json'); }
  issue(record: PreviewRecord): string {
    const token = randomBytes(32).toString('hex');
    writeFileSync(this.path(token), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    return token;
  }
  peek(token: string): PreviewRecord {
    let fd: number | undefined;
    try {
      const path = this.path(token);
      if (!lstatSync(path).isFile()) throw new Error('INSECURE_PREVIEW');
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || (process.platform !== 'win32' && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))) throw new Error('INSECURE_PREVIEW');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } catch { throw new Error('INVALID_PREVIEW'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  prune(now: number): void {
    for (const file of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const token = file.slice(0, -5);
      try { if (this.peek(token).expires <= now) this.consume(token); }
      catch { /* Another process may have consumed it. Never follow invalid files. */ }
    }
  }
  consume(token: string): void {
    const path = this.path(token);
    const claimed = path + '.' + randomBytes(16).toString('hex') + '.consumed';
    try { renameSync(path, claimed); }
    catch { throw new Error('INVALID_PREVIEW'); }
    unlinkSync(claimed);
  }
}
