import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import chokidar, { FSWatcher } from 'chokidar';
import { Store, type FileState, type Workspace } from './store.ts';

export const ignoredDirs = new Set(['.git','node_modules','dist','build','coverage','.cache','.next','.nuxt','.observer-data','.ssh','.codex','.gemini','.aws','.azure','.kube','.config','library','temp','obj','logs']);
const generatedDirs = new Set(['.work','release']);
export function secretName(name: string) { return /^\.env(?:\.|$)|^id_(?:rsa|ed25519|ecdsa)(?:\.|$)|\.(?:pem|key|p12|pfx)$|^(?:credentials|secrets)(?:\.|$)/i.test(name); }
export function inside(root: string, target: string) { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
export function ignored(root: string, target: string) { const rel = path.relative(root, target); return rel.split(path.sep).some(p => ignoredDirs.has(p.toLowerCase()) || generatedDirs.has(p.toLowerCase()) || secretName(p)); }

export class Monitor {
  store: Store; dataDir: string; watcher?: FSWatcher; active?: Workspace;
  pending?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval>;
  chain: Promise<unknown> = Promise.resolve(); stopping = false;
  constructor(store: Store, dataDir: string) { this.store = store; this.dataDir = path.resolve(dataDir); }
  enqueue<T>(fn: () => Promise<T>): Promise<T> { const next = this.chain.then(fn); this.chain = next.catch(() => {}); return next; }
  async validateRoot(input: string) {
    if (!path.isAbsolute(input)) throw new Error('请选择绝对路径');
    const root = await fs.realpath(input); const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error('请选择文件夹');
    if (root === path.parse(root).root) throw new Error('请选具体项目，不监控整个磁盘');
    if (inside(root, this.dataDir) || inside(this.dataDir, root)) throw new Error('监控文件夹与工具数据目录必须分开');
    if (root.split(path.sep).some(p => ignoredDirs.has(p.toLowerCase()) || secretName(p)) || generatedDirs.has(path.basename(root).toLowerCase())) throw new Error('此路径属于默认排除的凭据、缓存或生成目录');
    return root;
  }
  async select(input: string) {
    const root = await this.validateRoot(input);
    return this.enqueue(async () => {
      clearTimeout(this.pending); clearInterval(this.interval); await this.watcher?.close();
      if (this.active) this.store.health(this.active.id, 'paused');
      this.active = this.store.activate(root); const id = this.active.id;
      this.store.health(id, 'indexing');
      this.watcher = chokidar.watch(root, { ignoreInitial: true, followSymlinks: false, ignored: p => ignored(root, p), awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }, atomic: 250 });
      this.watcher.on('all', () => this.schedule(id));
      this.watcher.on('error', e => { this.store.health(id, 'error', String(e)); this.schedule(id); });
      await new Promise<void>((resolve, reject) => { this.watcher!.once('ready', resolve); this.watcher!.once('error', reject); });
      await this.scan('startup_reconcile');
      await this.scan('baseline_reconcile');
      this.interval = setInterval(() => { this.enqueue(() => this.scan('periodic_reconcile')).catch(e => this.fail(e)); }, 60000);
      this.interval.unref(); return this.store.workspace(id);
    });
  }
  fail(error: unknown) { if (this.active) this.store.health(this.active.id, 'error', String(error)); }
  schedule(id: string) {
    if (this.stopping || this.active?.id !== id) return;
    clearTimeout(this.pending);
    this.pending = setTimeout(() => { this.enqueue(() => this.scan('watcher')).catch(e => this.fail(e)); }, 300);
  }
  async scan(source = 'manual_reconcile') {
    if (!this.active) return { recorded: 0 };
    const { root, id } = this.active; const states: FileState[] = []; const errors: string[] = [];
    this.store.health(id, 'reconciling');
    try {
      if (await fs.realpath(root) !== root || !(await fs.stat(root)).isDirectory()) throw new Error('项目根目录已改变');
      const walk = async (dir: string) => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); }
        catch (e) { errors.push(`${path.relative(root, dir) || '.'}: 无法读取目录 (${(e as NodeJS.ErrnoException).code})`); return; }
        for (const entry of entries) {
          const target = path.join(dir, entry.name);
          if (ignored(root, target) || entry.isSymbolicLink()) continue;
          try {
            const real = await fs.realpath(target);
            if (!inside(root, real) || real !== target) continue;
            const before = await fs.lstat(target);
            if (before.isSymbolicLink()) continue;
            if (before.isDirectory()) { await walk(target); continue; }
            if (!before.isFile()) continue;
            const rel = path.relative(root, target).split(path.sep).join('/');
            if (before.size > this.store.settings().max_text_kb * 1024) { states.push({ path: rel, hash: null, size: before.size, mtime: before.mtimeMs, text: null, reason: 'file_too_large' }); continue; }
            const bytes = await fs.readFile(target); const after = await fs.lstat(target);
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || (await fs.realpath(target)) !== real) { errors.push(`${rel}: 文件仍在写入，等待补查`); this.schedule(id); continue; }
            let text: string | null = null; let reason: string | null = null;
            try {
              if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
              else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
              else if (bytes.includes(0)) reason = 'binary_file';
              else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch { reason = 'unsupported_encoding'; }
            states.push({ path: rel, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mtime: after.mtimeMs, text, reason });
          } catch (e) { errors.push(`${path.relative(root, target)}: ${(e as NodeJS.ErrnoException).code ?? '读取失败'}`); }
        }
      };
      await walk(root);
      const recorded = this.store.commitScan(id, states, errors.length === 0, source, errors);
      this.store.prune(); return { recorded, errors, scanned: states.length };
    } catch (e) { this.fail(e); throw e; }
  }
  rescan() { return this.enqueue(() => this.scan()); }
  async close() { this.stopping = true; clearTimeout(this.pending); clearInterval(this.interval); await this.watcher?.close(); await this.chain; }
}
