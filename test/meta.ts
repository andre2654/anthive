/** Skill injetada não é fala do usuário; o chat e o primeiro turno levam o preâmbulo do anthive. */
import { rows } from '../src/views/agent.ts';
import { Ev } from '../src/core/sessions.ts';
import { ChatSession, SYSTEM_PREAMBLE } from '../src/core/chat.ts';
import * as P from '../src/core/project.ts';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const ev = (o: Partial<Ev>): Ev => ({ uuid: crypto.randomUUID(), parent: null, sidechain: false, type: 'user', ts: 1, role: 'user', text: '', ...o });
const skill = 'Base directory for this skill: /Users/x/.claude/skills/portal-skill\n\n# Portal Inter-Agent Communication\n\nYou are running inside Maestri…';
const rs = rows([
  ev({ text: 'crie uma nota', full: 'crie uma nota' }),
  ev({ text: skill.replace(/\s+/g, ' '), full: skill, meta: true }),
  ev({ type: 'assistant', role: 'assistant', text: 'ok', full: 'ok' }),
], '', new Set(), 60);
must('só um turno "você"', rs.filter((r) => r.kind === 'turn').length === 1);
const sk = rs.find((r) => r.name === 'skill');
must('skill aparece como linha própria, com o nome', !!sk && sk.detail.startsWith('portal-skill loaded'));
must('nada da skill vira fala sua', !rs.some((r) => r.kind === 'turn' && r.detail.includes('Base directory')));

const c = new ChatSession({ cwd: '/tmp', resume: 'abc' }, () => {});
const argv = c.argv();
must('chat leva --append-system-prompt', argv.includes('--append-system-prompt') && argv.includes(SYSTEM_PREAMBLE));
must('preâmbulo nomeia as ferramentas e veta os outros canvases', SYSTEM_PREAMBLE.includes('note_write') && /other agent canvases/.test(SYSTEM_PREAMBLE));
const plan = P.firstTurnPlan({ kind: 'agent', id: 'a', name: 'api', cwd: '/tmp', sessionId: 'u', worktree: null, created: 0 }, 'faça', true);
must('os dois passos do primeiro turno levam o preâmbulo', plan.every((argv) => argv.includes('--append-system-prompt')));
must('chat autoriza o servidor anthive', argv.includes('--allowedTools') && argv[argv.indexOf('--allowedTools') + 1] === 'mcp__anthive');
must('primeiro turno autoriza o servidor anthive', plan.every((a) => a.includes('--allowedTools')));
// variádico: o que vem depois de mcp__anthive tem que ser uma flag, nunca o prompt
must('lista variádica termina numa flag, não no prompt', plan.every((a) => (a[a.indexOf('mcp__anthive') + 1] ?? '').startsWith('--')));
must('prompt continua sendo o último argumento', plan[1]![plan[1]!.length - 1] === 'faça');
console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
