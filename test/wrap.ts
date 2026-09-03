import { wrap, rows, detailWidth } from '../src/views/agent.ts';
import { Ev } from '../src/core/sessions.ts';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const w = wrap('Olá! Estou no repositório do Wealth Studio, na branch fix/aw-650. Vi que há alguns files não rastreados.\n\nQuer que eu faça o commit?', 40);
must('quebra por palavra dentro da largura', w.every((l) => [...l].length <= 40) && w.length >= 3);
must('nenhuma palavra cortada no meio', w.join(' ').replace(/\s+/g, ' ').includes('Wealth Studio, na branch'));
must('parágrafo vira linha em branco', w.includes(''));
must('palavra gigante é partida, não some', wrap('a'.repeat(95), 40).length === 3);
must('largura de texto para 100 colunas é 62', detailWidth(100) === 62);
const ev = (o: Partial<Ev>): Ev => ({ uuid: crypto.randomUUID(), parent: null, sidechain: false, type: 'assistant', ts: 1, role: 'assistant', text: '', ...o });
const long = 'x'.repeat(30) + ' ' + 'y'.repeat(30) + ' ' + 'z'.repeat(30);
const rs = rows([ev({ type: 'user', role: 'user', text: 'ola', full: 'ola' }), ev({ text: long, full: long })], '', new Set(), 40);
must('resposta longa vira várias linhas, nenhuma cortada', rs.filter((r) => r.kind === 'cont').length === 2 && rs.every((r) => !r.detail.includes('…')));
must('continuação mantém o tronco da árvore', rs.filter((r) => r.kind === 'cont').every((r) => r.connector.trim() === '' || r.connector.includes('│')));
must('"agora" diz o estado, não repete a resposta', rs[rs.length - 1]!.kind === 'now' && rs[rs.length - 1]!.detail === 'waiting for you');
const tool = rows([ev({ type: 'user', role: 'user', text: 'x', full: 'x' }), ev({ text: 'Bash ' + 'c'.repeat(200), tool: 'Bash' })], '', new Set(), 40);
must('comando de ferramenta fica numa linha só', !tool.some((r) => r.kind === 'cont'));
// --- voices: you, the agent, its thoughts
const voiced = rows([ev({ type: 'user', role: 'user', text: 'oi', full: 'oi' }), ev({ thinking: 'hmm', text: 'pensando' }), ev({ text: 'resposta', full: 'resposta **forte**' })], '', new Set(), 40, true, 'api');
must('your turn is voice you, in green', voiced[0]!.voice === 'you' && voiced[0]!.name === 'you');
must('the answer carries the agent name and voice agent', voiced.some((r) => r.voice === 'agent' && r.name === 'api'));
must('thinking is voice thought', voiced.some((r) => r.voice === 'thought'));

console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
