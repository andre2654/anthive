/** Dirige o app novo com uma tela falsa: início → projeto → nota → ligação → remoção → agente. */
import { App } from '../src/app.ts';
import { Screen, Key } from '../src/tui/screen.ts';
import * as P from '../src/core/project.ts';
import * as store from '../src/core/store.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
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
press(app, 'esc'); await settle();
must('esc volta ao projeto', app.view === 'project');
press(app, 'esc'); await settle();
must('esc de novo volta aos projects', app.view === 'home');

console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
