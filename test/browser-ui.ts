import { Grid } from '../src/tui/grid.ts';
import { renderProject } from '../src/views/project.ts';
import { renderBrowser } from '../src/views/item.ts';
import { rows } from '../src/views/agent.ts';
import type { View, BrowserNode } from '../src/core/project.ts';
import { Ev } from '../src/core/sessions.ts';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const agent = { kind: 'agent' as const, id: 'a1', name: 'api', item: null, session: null, cwd: '/tmp' };
const br: BrowserNode = { kind: 'browser', id: 'b1', item: { kind: 'browser', id: 'b1', name: 'browser', mode: 'hidden', port: 9401, created: 0 }, state: { url: 'https://loja.dev/pedidos', title: 'Pedidos', snapshot: '- heading "Pedidos" [ref=e1]\n- link "Novo" [ref=e2]', console: '', busy: false, lastTool: 'browser_snapshot', live: true } };
const v: View = { project: { id: 'p', name: 'loja', cwd: '/tmp', created: 0 }, nodes: [agent, br], edges: [{ from: 'a1', to: 'b1', kind: 'context' }] };
const g = new Grid(130, 24); renderProject(g, v, 'b1', 0, '', { panel: true });
const t = g.toString();
must('browser é caixa no mapa com modo, ao vivo e a página', t.includes('▣ chrome (hidden)') && t.includes('live') && t.includes('Pedidos') && t.includes('https://loja.dev/pedidos'));
must('painel mostra url, modo com porta e snapshot com ref na frente', t.includes('page     Pedidos') && t.includes('hidden · live') && t.includes('port     9401') && /e1\s+heading "Pedidos"/.test(t));

// tela com imagem (Ghostty): moldura da página à esquerda, refs à direita
const g2 = new Grid(130, 30);
renderBrowser(g2, br, { live: { frame: { w: 1200, h: 800, at: 1 }, url: 'https://loja.dev/pedidos/novo', title: 'Novo pedido', error: '', connected: true }, box: { x: 2, y: 4, cols: 85, rows: 20 }, typing: false, canImg: true, booting: '' }, '', ['api']);
const t2 = g2.toString();
must('cabeçalho: url ao vivo, modo, estado, ligação', t2.includes('loja.dev/pedidos/novo') && t2.includes('hidden') && t2.includes('live') && t2.includes('linked to api') && t2.includes('Novo pedido'));
must('moldura da página ao vivo e refs com o ref na frente', t2.includes('live page') && t2.includes('the agent sees') && /e2\s+link "Novo"/.test(t2));
must('teclas: clique, digitar, abrir janela', t2.includes('i type') && t2.includes('o open window') && t2.includes('click the page'));
must('dentro da moldura não tem texto (a imagem vai por cima)', g2.toString().split('\n').slice(4, 24).every((l) => l.slice(2, 87).trim() === ''));

// sem frame ainda: diz que está esperando; modo digitar aparece
const g3 = new Grid(130, 30);
renderBrowser(g3, br, { live: { frame: null, url: '', title: '', error: '', connected: false }, box: { x: 2, y: 4, cols: 85, rows: 20 }, typing: true, canImg: true, booting: 'starting Chrome…' }, '', []);
const t3 = g3.toString();
must('sem frame mostra o que está acontecendo', t3.includes('starting Chrome…') && t3.includes('no agent linked'));
must('modo digitar avisa e troca as teclas', t3.includes('typing into the page') && t3.includes('stop typing'));

// terminal sem imagem: cai para o snapshot em texto
const g4 = new Grid(120, 20);
renderBrowser(g4, br, { live: null, box: null, typing: false, canImg: false, booting: '' }, '', ['api']);
const t4 = g4.toString();
must('sem imagem, explica e mostra o snapshot com refs', t4.includes('cannot draw images') && t4.includes('[ref=e2]'));

const ev = (o: Partial<Ev>): Ev => ({ uuid: crypto.randomUUID(), parent: null, sidechain: false, type: 'assistant', ts: 0, role: 'assistant', text: '', ...o });
const rs = rows([ev({ type: 'user', role: 'user', text: 'abra a loja', full: 'abra a loja' }), ev({ text: 'browser_navigate', tool: 'mcp__playwright__browser_navigate', input: { url: 'https://loja.dev' } }), ev({ text: 'browser_click', tool: 'browser_click', input: { element: 'link Novo', ref: 'e2' } })], '', new Set(), 60);
must('árvore mostra o agent no browser sem o prefixo', rs.some((r) => r.name === 'navigate' && r.detail === 'https://loja.dev') && rs.some((r) => r.name === 'click' && r.detail.includes('Novo')));
console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
