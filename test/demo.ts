/** Monta um projeto de demonstração no ANTHIVE_HOME atual: 2 agentes, 2 notas, 1 arquivo, 1 serviço vivo, 1 conversa. */
import * as P from '../src/core/project.ts';
import * as store from '../src/core/store.ts';
import * as bus from '../src/core/bus.ts';
import * as svc from '../src/core/services.ts';
import { mkdir, writeFile } from 'node:fs/promises';

const R = process.argv[2] ?? '/tmp/tai-demo-repo';
await mkdir(`${R}/apps/api/src`, { recursive: true });
await writeFile(`${R}/apps/api/src/order.ts`, 'export const order = 1;\n');
await writeFile(`${R}/CLAUDE.md`, '# CLAUDE.md\n\n## Comandos\n- bun test\n\n## Estrutura\n- apps/api\n');
const sh = (c: string[]) => Bun.spawnSync(c, { cwd: R, stdout: 'ignore', stderr: 'ignore' });
sh(['git', 'init', '-q']); sh(['git', 'add', '-A']); sh(['git', 'commit', '-qm', 'init']);

const p = await P.createProject('pedidos', R);
const api = await P.addAgent(p, 'api', { worktree: 'feat/pedidos' });
const db = await P.addAgent(p, 'db');
await store.create({ kind: 'note', title: 'schema-pedidos', body: 'idempotência é chave do cliente\n', acl: ['api', 'db'], project: p.id });
await store.create({ kind: 'note', title: 'bug-checkout-duplo', body: 'retry cai no mesmo segundo\n', acl: ['db'], ttl: store.parseTTL('2h'), project: p.id });
const f = await P.addFile(p.id, `${R}/apps/api/src/order.ts`);
const live = (await svc.discover())[0];
const s = live ? await P.addService(p.id, { name: live.command, pid: live.pid, port: live.port, command: live.command, cwd: await svc.cwdOf(live.pid) }) : null;
await P.link(p.id, api.id, f.id); if (s) await P.link(p.id, db.id, s.id);
await bus.link('api', 'db', 'fechar o schema de pedidos', 6);
await bus.say('dm-api-db', 'api', 'proponho chave_idem'); await bus.say('dm-api-db', 'db', 'índice parcial');
console.log(`demo: ${p.name} @ ${R} · api, db · 2 notas · ${f.label} · ${s ? `${s.name}:${s.port}` : 'sem serviço'}`);
