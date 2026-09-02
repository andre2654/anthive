/** CLAUDE.md e memória viram nós de contexto ligados a todo agente; sem CLAUDE.md o primeiro turno roda /init antes. */
import * as P from '../src/core/project.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const repo = mkdtempSync(join(tmpdir(), 'tai-ctx-'));
const p = await P.createProject('ctx', repo);
const a = await P.addAgent(p, 'api');

must('sem CLAUDE.md: nada descoberto', (await P.contextFiles(repo)).length === 0);
const plan0 = P.firstTurnPlan(a, 'faça x', true);
must('sem CLAUDE.md o plano tem dois passos', plan0.length === 2);
must('primeiro passo é o /init na sessão do agente', plan0[0]!.includes('/init') && plan0[0]!.includes('--session-id'));
must('segundo passo retoma a sessão com o briefing', plan0[1]!.includes('--resume') && plan0[1]![plan0[1]!.length - 1] === 'faça x');
must('com CLAUDE.md o plano é um passo só', P.firstTurnPlan(a, 'faça x', false).length === 1);

await Bun.write(join(repo, 'CLAUDE.md'), '# CLAUDE.md\n\n## Comandos\n- bun test\n');
const ctx = await P.contextFiles(repo);
must('CLAUDE.md descoberto como contexto', ctx.length === 1 && ctx[0]!.context === 'claude' && ctx[0]!.label === 'CLAUDE.md');
const v = await P.view(p);
const node = v.nodes.find((n): n is P.FileNode => n.kind === 'file' && n.item.context === 'claude');
must('vira nó de arquivo com contagem de linhas', !!node && node.lines === 4);
must('ligado ao agente sem ninguém pedir', v.edges.some((e) => e.from === a.id && e.to === node!.id && e.kind === 'context'));
const b = P.buildBriefing(v, 'db', 'revise');
must('briefing manda ler o CLAUDE.md primeiro', b.includes('CLAUDE.md (4 linhas)') && b.includes('leia primeiro'));
must('briefing não repete o contexto na lista de arquivos', b.includes('nenhum além do contexto'));
const slug = await P.claudeSlug(repo);
must('slug resolve symlink do /var → /private/var', slug.startsWith('-private-var-') || !repo.startsWith('/var'));
console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
