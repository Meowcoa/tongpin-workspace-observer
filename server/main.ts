import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startObserver } from './http.ts';
const args = process.argv.slice(2);
const value = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i+1]; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(value('--port') ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1 到 65535 之间');
const service = await startObserver({ dataDir: path.resolve(value('--data') ?? path.join(root,'.observer-data')), port, root:value('--root') });
console.log(`同频已启动：http://127.0.0.1:${service.port}`);
console.log(`数据目录：${service.dataDir}`);
console.log('停止：Ctrl+C。项目文件只读；MCP 连接说明见界面。');
async function stop() { await service.close(); process.exit(0); }
process.once('SIGINT',stop); process.once('SIGTERM',stop);
