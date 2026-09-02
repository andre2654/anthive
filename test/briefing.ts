/** O briefing descreve o projeto e a resposta "ligar: …" vira ligações. */
import * as P from '../src/core/project.ts';
import * as store from '../src/core/store.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const repo = mkdtempSync(join(tmpdir(), 'tai-brief-'));
const p = await P.createProject('loja', repo);
await P.addAgent(p, 'api');
await store.create({ kind: 'note', title: 'schema-pedidos', body: 'x\n', acl: ['api'], project: p.id });
await Bun.write(join(repo, 'order.ts'), '1');
await P.addFile(p.id, join(repo, 'order.ts'));
const v = await P.view(p);
const b = P.buildBriefing(v, 'db', 'revise o schema');
must('briefing cita o projeto e o agente', b.includes('"db"') && b.includes('"loja"'));
must('briefing lista a nota com quem lê', b.includes('schema-pedidos') && b.includes('lê: api'));
must('briefing lista o arquivo', b.includes('order.ts'));
must('briefing explica o barramento', b.includes('note_read') && b.includes('send_message'));
must('briefing pede a linha ligar:', b.includes('ligar:'));
must('briefing termina com o pedido', b.trim().endsWith('revise o schema'));
const ids = P.parseBriefingReply(v, 'ligar: schema-pedidos, order.ts\n\nVou começar…');
must('resposta vira dois ids', ids.length === 2);
must('"ligar: nada" vira vazio', P.parseBriefingReply(v, 'ligar: nada').length === 0);
must('sem a linha, nada', P.parseBriefingReply(v, 'vou ler o schema').length === 0);
console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
