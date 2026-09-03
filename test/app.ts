/** Dirige o app novo com uma tela falsa: início → projeto → nota → ligação → remoção → agente. */
import { App } from '../src/app.ts';
import { Screen, Key } from '../src/tui/screen.ts';
import * as P from '../src/core/project.ts';
import * as store from '../src/core/store.ts';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
// a fake `claude` on PATH: logs its argv, answers every turn at once (the App spawns whatever `claude` resolves to)
const fakeBin = mkdtempSync(join(tmpdir(), 'tai-fake-claude-'));
const fakeLog = join(fakeBin, 'argv.log');
writeFileSync(join(fakeBin, 'claude'), [
  '#!/bin/sh',
  `printf '%s\\n' "$*" >> "${fakeLog}"`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake","permissionMode":"default"}'`,
  'n=0',
  'while IFS= read -r line; do',
  '  n=$((n+1))',
  '  case "$line" in *slow*) sleep 2;; esac',
  `  printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok %s"}]},"uuid":"fake-u-%s","timestamp":"2026-09-02T00:00:00Z"}\\n' "$n" "$n"`,
  `  printf '%s\\n' '{"type":"result","subtype":"success","result":"see note://research-x","total_cost_usd":0.001,"permission_denials":[]}'`,
  'done',
  '',
].join('\n'));
chmodSync(join(fakeBin, 'claude'), 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
const argvLines = () => { try { return readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean); } catch { return [] as string[]; } };
class F extends Screen {
  constructor() { super({ mouse: true }); this.W = 100; this.H = 28; }
  override measure() {} override enter() {} override restore() {} override write() {} override onKey() {}
}
const type = (app: App, s: string) => { for (const c of s) app.key({ k: 'char', c } as Key); };
const press = (app: App, k: Key['k']) => app.key({ k } as Key);

const repo = mkdtempSync(join(tmpdir(), 'tai-app-'));
const app = new App(new F());
const settle = async () => { await app.lastOp; await new Promise((r) => setTimeout(r, 30)); };
await app.load();
app.render();
must('início mostra o + Novo', app.grid.toString().includes('+ New'));

// --- novo projeto pelo modal ---
type(app, 'n');
must('n abre o formulário de projeto', app.modal?.kind === 'form');
type(app, 'pedidos'); press(app, 'enter');
type(app, repo); press(app, 'enter');
await settle();
must('projeto criado e aberto', app.view === 'project' && app.project?.name === 'pedidos');
must('cartão do projeto aparece no registro', (await P.listProjects()).some((p) => p.name === 'pedidos'));
app.render();
must('projeto vazio explica o que fazer', app.grid.toString().includes('empty project'));

// --- novo agente (sem instrução: não roda nada) ---
type(app, 'n');
must('n abre o seletor de tipo', app.modal?.kind === 'pick');
press(app, 'enter');                       // agente
must('agente pede nome', app.modal?.kind === 'form' && app.modal.form.title === 'new agent');
type(app, 'api'); press(app, 'enter'); press(app, 'enter');   // nome → worktree vazio → envia
await settle();
must('agente api existe no grafo', app.pv?.nodes.some((n) => n.kind === 'agent' && n.name === 'api') === true);
must('agente novo fica selecionado', app.sel !== null && app.pv?.nodes.find((n) => n.id === app.sel)?.kind === 'agent');

// --- nota inline, já ligada ao agente selecionado ---
type(app, 'n'); press(app, 'down'); press(app, 'enter');   // nota
must('nota abre campo inline preso ao api', !!app.inline && app.inline.label.includes('api'));
type(app, 'idempotência é chave do cliente @2h'); press(app, 'enter');
await settle();
const note = app.pv?.nodes.find((n): n is P.NoteNode => n.kind === 'note');
must('nota existe added to the project', !!note && note.doc.project === app.project!.id);
must('nota já é lida pelo api', !!note && note.doc.acl.includes('api'));
must('@2h virou efêmera', !!note && note.doc.ttl !== null);
must('aresta api→nota existe', app.pv?.edges.some((e) => e.kind === 'context' && e.to === note!.id) === true);

// --- arquivo pelo caminho relativo, com o api selecionado (a nota nova tinha ficado selecionada) ---
app.sel = app.pv!.nodes.find((n) => n.kind === 'agent')!.id;
await Bun.write(join(repo, 'order.ts'), 'export const x = 1;\n');
type(app, 'n'); press(app, 'down'); press(app, 'down'); press(app, 'enter');   // arquivo
type(app, 'order.ts'); press(app, 'enter');
await settle();
const file = app.pv?.nodes.find((n): n is P.FileNode => n.kind === 'file');
must('arquivo entrou added to the project', !!file && file.item.label === 'order.ts');
must('arquivo já ligado ao agent selecionado', app.pv?.edges.some((e) => e.to === file!.id) === true);

// --- segundo agente e ligação por gesto (conversa pede objetivo) ---
type(app, 'n'); press(app, 'enter'); type(app, 'db'); press(app, 'enter'); press(app, 'enter');
await settle();
const api = app.pv!.nodes.find((n): n is P.AgentNode => n.kind === 'agent' && n.name === 'api')!;
const db = app.pv!.nodes.find((n): n is P.AgentNode => n.kind === 'agent' && n.name === 'db')!;
app.sel = api.id; type(app, 'l');
must('l entra em modo de ligação', app.linking?.source === api.id);
app.sel = db.id; press(app, 'enter'); await settle();
must('agente⇄agente pede o objetivo numa linha', !!app.inline && app.inline.label.includes('goal'));
type(app, 'fechar o schema'); press(app, 'enter'); await settle();
must('conversa gravada', (await store.list('thread')).some((t) => t.goal === 'fechar o schema'));
must('aresta de conversa no grafo', app.pv?.edges.some((e) => e.kind === 'talk') === true);
app.render();
must('desenha o turno na aresta', app.grid.toString().includes('⇄ 0/6'));

// --- ligar nota a db por gesto (leitura, sem perguntar) ---
app.sel = note!.id; type(app, 'l'); app.sel = db.id; press(app, 'enter'); await settle();
must('nota→agente vira leitura sem perguntar', app.inline === null && (await store.read(note!.doc.id, 'note'))!.acl.includes('db'));

// --- remover arquivo com confirmação ---
app.sel = file!.id; type(app, 'd');
must('d pede confirmação', app.modal?.kind === 'confirm');
type(app, 's'); await settle();
must('arquivo saiu do projeto', !app.pv?.nodes.some((n) => n.id === file!.id));

// --- tela do agente: caixa de escrita e seletor ---
app.sel = api.id; press(app, 'enter'); await settle();
must('↵ no agent abre a tela dele', app.view === 'agent' && app.agent?.name === 'api');
app.render();
must('faixa de ligações lista a note e a conversa', app.grid.toString().includes('linked to') && app.grid.toString().includes('db 0/6'));
type(app, 'e');
must('e abre o seletor de esforço', app.modal?.kind === 'pick' && app.modal.title === 'effort');
press(app, 'esc');

// --- deep search: i, tab, D, and the restart that must not kill the chat ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred: () => boolean, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(20); } return pred(); };
type(app, 'i'); await settle();
must('i opens the box and spawns a plain chat', (await waitFor(() => argvLines().length === 1)) && app.composing && !!app.chat && !argvLines()[0]!.includes('WebSearch'));
press(app, 'tab');
must('tab turns the chip on and restarts once with the web tools and effort max', app.deep && (await waitFor(() => argvLines().length === 2)) && argvLines()[1]!.includes('WebSearch') && argvLines()[1]!.includes('--forward-subagent-text') && argvLines()[1]!.includes('--effort max'));
await sleep(300);
must('the old process exiting did not close the chat', !!app.chat && app.composing);
app.render();
must('the box shows the chip', app.grid.toString().includes('[deep]'));
press(app, 'tab'); press(app, 'tab'); await sleep(150);
must('flipping the chip again does not restart', app.deep && argvLines().length === 2);
type(app, 'why'); press(app, 'enter');
must('enter sends the wrapped prompt', app.evs.some((e) => e.role === 'user' && e.text === 'Deep search: why'));
must('the fake answered and the status names the report note', (await waitFor(() => app.evs.some((e) => e.role === 'assistant' && (e.text ?? '').startsWith('ok')) && app.status.includes('note://research-x'))));
press(app, 'esc'); type(app, 'i');
must('i opens a plain box again', app.composing && !app.deep);
press(app, 'esc'); type(app, 'D');
must('D opens the box in deep mode', app.composing && app.deep);
press(app, 'esc'); type(app, 'x');
must('x stops the chat', !app.chat);

// --- approvals: a pending request becomes a modal; y allows, a remembers the rule ---
const A = await import('../src/core/approvals.ts');
const ask1 = A.ask({ agent: 'api', project: app.project!.id, cwd: app.project!.cwd, tool: 'Bash', input: { command: 'python3 scripts/ler.py --painel' } }, { timeoutMs: 8000, pollMs: 50 });
await new Promise((r) => setTimeout(r, 120)); await app.load();
must('a pending request opens the approval modal', app.modal?.kind === 'approval' && app.modal.req.tool === 'Bash');
type(app, 'y'); await settle();
must('y allows once and closes the modal', (await ask1).state === 'allow' && app.modal === null);
const ask2 = A.ask({ agent: 'api', project: app.project!.id, cwd: app.project!.cwd, tool: 'Bash', input: { command: 'python3 scripts/ler.py --painel' } }, { timeoutMs: 8000, pollMs: 50 });
await new Promise((r) => setTimeout(r, 120)); await app.load();
type(app, 'a'); await settle();
must('a allows and remembers the rule for the agent', (await ask2).state === 'allow' && P.rulesFor(await P.loadGraph(app.project!.id), 'api').includes('Bash(python3 scripts/ler.py:*)'));
const g5 = await P.loadGraph(app.project!.id);
must('the remembered rule answers by itself next time', A.autoDecide({ agent: 'api', tool: 'Bash', input: { command: 'python3 scripts/ler.py --outro' }, cwd: app.project!.cwd }, g5)?.state === 'allow');
const ask3 = A.ask({ agent: 'api', project: app.project!.id, cwd: app.project!.cwd, tool: 'WebSearch', input: { query: 'gado boi' } }, { timeoutMs: 8000, pollMs: 50 });
await new Promise((r) => setTimeout(r, 120)); await app.load();
app.render(); must('the modal offers trust', app.modal?.kind === 'approval' && app.grid.toString().includes('trust api'));
type(app, 't'); await settle();
must('t trusts the agent: allowed, remembered, everything', (await ask3).state === 'allow' && A.isTrusted(await P.loadGraph(app.project!.id), 'api') && A.autoDecide({ agent: 'api', tool: 'Bash', input: { command: 'anything at all' }, cwd: app.project!.cwd }, await P.loadGraph(app.project!.id))?.state === 'allow');
type(app, 'p');
must('the permission picker offers "ask again" to a trusted agent', app.modal?.kind === 'pick' && app.modal.items.some((i) => i.value === '__untrust'));
if (app.modal?.kind === 'pick') app.modal.index = app.modal.items.findIndex((i) => i.value === '__untrust'); press(app, 'enter'); await settle();
must('ask again forgets the trust and the rules', !A.isTrusted(await P.loadGraph(app.project!.id), 'api') && P.rulesFor(await P.loadGraph(app.project!.id), 'api').length === 0);

// --- mid-turn: x and q ask first; a setting changed mid-turn waits for the answer ---
const spawns = argvLines().length;
type(app, 'i'); await settle();
must('a new chat spawns for the guards', (await waitFor(() => argvLines().length === spawns + 1)) && !!app.chat);
type(app, 'slow one'); press(app, 'enter'); await sleep(100);
must('the fake is answering: the chat is busy', !!app.chat?.busy);
press(app, 'esc'); type(app, 'x');
must('x mid-turn asks before killing the turn', app.modal?.kind === 'confirm' && app.modal.title.includes('mid-turn') && !!app.chat);
press(app, 'esc');
must('esc keeps the chat alive', app.modal === null && !!app.chat?.busy);
type(app, 'e');
const pickNote = app.modal?.kind === 'pick' ? app.modal.note ?? '' : '';
must('e mid-turn says the change waits for the answer', app.modal?.kind === 'pick' && pickNote.includes('mid-turn'));
const choice = app.modal?.kind === 'pick' ? app.modal.items.find((i) => i.value && i.value !== '__untrust' && !i.current)! : null;
if (app.modal?.kind === 'pick' && choice) app.modal.index = app.modal.items.indexOf(choice);
press(app, 'enter'); await settle();
must('the restart is deferred: no new process yet', argvLines().length === spawns + 1 && !!app.chat && app.status.includes('applies when this answer finishes'));
must('when the answer lands the chat restarts with the new effort', (await waitFor(() => argvLines().length === spawns + 2, 5000)) && argvLines()[spawns + 1]!.includes(`--effort ${choice?.value}`) && !!app.chat);
type(app, 'i'); type(app, 'slow two'); press(app, 'enter'); await sleep(100); press(app, 'esc');
type(app, 'q');
must('q mid-turn asks instead of quitting', app.modal?.kind === 'confirm' && app.modal.title.includes('quit') && !!app.chat);
press(app, 'esc');
must('esc stays', app.modal === null && !!app.chat);
must('the turn finishes', await waitFor(() => !app.chat?.busy, 5000));
type(app, 'x');
must('x on an idle chat stops it without asking', !app.chat && app.modal === null);

// --- s gives the mouse back to the terminal, and freezes the frame while you select ---
type(app, 's');
must('s freezes the screen and says how to come back', app.selecting && app.status.includes('frozen'));
const mark = 'marcaselecao';
app.evs.push({ uuid: 'sel-1', parent: null, sidechain: false, type: 'assistant', ts: Date.now(), role: 'assistant', text: mark, full: mark } as any);
(app as any).rebuild(true); app.render();
must('no new frame is drawn while selecting', !app.grid.toString().includes(mark));
must('the frozen frame drops the frame, the gutter and the panel', (() => {
  const lines = app.grid.toString().split('\n');
  return !lines.some((l) => l.includes('│') || l.includes('▎') || l.includes('╭'));
})());
type(app, 'i');
must('other keys do nothing while selecting', !app.composing && app.selecting);
press(app, 'esc');
must('esc gives the mouse back to the app', !app.selecting);
app.render();
must('and the screen paints again', app.grid.toString().includes(mark));

// --- selection mode scrolls: the frame is frozen, not stuck ---
for (let i = 0; i < 200; i++) app.evs.push({ uuid: `fill-${i}`, parent: null, sidechain: false, type: 'assistant', ts: Date.now(), role: 'assistant', text: `linha ${i}`, full: `linha ${i}` } as any);
(app as any).rebuild(true);
type(app, 's');
must('selection mode is on', app.selecting);
type(app, 'g');
must('g goes to the top', app.selScroll === 0);
type(app, 'G');
const bottom = app.selScroll;
must('G goes to the bottom', bottom > 0);
press(app, 'up');
must('the arrows scroll', app.selScroll === bottom - 1);
app.key({ k: 'wheel', dir: -1, x: 0, y: 5 } as any);
must('the wheel scrolls too', app.selScroll === bottom - 4);
type(app, 's');
must('s comes back', !app.selecting);

// --- the mouse points, y copies what it points at, and it lights up ---
const rowOf = (evId: string) => app.rowsAll.findIndex((r) => r.ev === evId);
const yOf = (i: number) => 3 + i - app.aScroll;
app.aScroll = Math.max(0, rowOf('sel-1'));   // bring it into view: the pointer only reaches what is drawn
app.aCursor = -1; app.hoverEv = null;
app.key({ k: 'motion', x: 40, y: yOf(rowOf('sel-1')) } as any);
must('the pointer over a message hovers the whole message', app.hoverEv === 'sel-1');
app.render();
must('the hover says what y does', app.grid.toString().includes('y copies'));
app.key({ k: 'mouse', x: 40, y: yOf(rowOf('sel-1')), button: 0, press: true } as any);
must('clicking puts the cursor there', app.rowsAll[app.aCursor]?.ev === 'sel-1');
type(app, 'y');
must('y copies what the pointer is on and lights it', app.flashEv === 'sel-1' && /copied/.test(app.status));
app.render();
must('the flash is drawn', app.grid.toString().includes('copied'));
app.hoverEv = null; app.aCursor = -1;
type(app, 'y');
must('with nothing pointed at, y takes the last thing the agent said', app.flashEv !== null && /copied/.test(app.status));

// --- y copies the message under the cursor, Y the whole turn ---
app.aCursor = app.rowsAll.findIndex((r) => r.ev === 'sel-1');
type(app, 'y');
must('y copies just that message', /copied/.test(app.status) || app.status.includes('pbcopy'));
type(app, 'Y');
must('Y copies the whole turn', app.status.includes('turn copied') || app.status.includes('nothing to copy') || app.status.includes('pbcopy'));
press(app, 'esc'); await settle();
must('esc volta ao projeto', app.view === 'project');
press(app, 'esc'); await settle();
must('esc de novo volta aos projects', app.view === 'home');

console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
