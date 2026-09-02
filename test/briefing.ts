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
must('briefing lista a note com quem lê', b.includes('schema-pedidos') && b.includes('read by: api'));
must('briefing lista o arquivo', b.includes('order.ts'));
must('briefing explica o barramento', b.includes('note_read') && b.includes('send_message'));
must('briefing asks for the link: line', b.includes('link:'));
must('briefing termina com o pedido', b.trim().endsWith('revise o schema'));
const ids = P.parseBriefingReply(v, 'link: schema-pedidos, order.ts\n\nStarting…');
must('resposta vira dois ids', ids.length === 2);
must('"link: nothing" is empty (and the old "ligar: nada" still works)', P.parseBriefingReply(v, 'link: nothing').length === 0 && P.parseBriefingReply(v, 'ligar: nada').length === 0);
must('sem a linha, nada', P.parseBriefingReply(v, 'vou ler o schema').length === 0);
console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
