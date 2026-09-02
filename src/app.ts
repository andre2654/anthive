import { Grid } from './tui/grid.ts';
import { Screen, Key } from './tui/screen.ts';
import { C, G, tok } from './tui/theme.ts';
import { TextInput, Form } from './tui/input.ts';
import { renderForm, renderConfirm, renderPick, PickItem } from './views/prompt.ts';
import { renderHome, layoutHome } from './views/home.ts';
import { renderProject, layoutProject, KIND_GLYPH } from './views/project.ts';
import { renderNote, renderFile, renderService, renderTask } from './views/item.ts';
import { isEditTool, hunksOf, renderDiff } from './tui/diff.ts';
import { renderBrowser } from './views/item.ts';
import { supportsKittyGraphics, placeImage, clearImages } from './tui/image.ts';
import { LiveView } from './core/live.ts';
import { BrowserMode, fitImage, toPage, inBox, MODE_LABEL } from './core/cdp.ts';
import { renderAgent, rows, Row, INPUT_H, LinkChip, detailWidth, tasksFrom, PanelData, panelFits } from './views/agent.ts';
import * as P from './core/project.ts';
import * as store from './core/store.ts';
import * as bus from './core/bus.ts';
import * as svc from './core/services.ts';
import { Session, Ev, parseSession, windowOf } from './core/sessions.ts';
import { ChatSession, ChatEvent, MODELS, EFFORTS, PERMISSIONS } from './core/chat.ts';
import { readFile, unlink } from 'node:fs/promises';
import { basename } from 'node:path';

type ViewName = 'home' | 'project' | 'agent' | 'note' | 'file' | 'service' | 'task' | 'diff' | 'browser';
type Modal =
  | { kind: 'form'; form: Form; note?: string; submit: (v: string[]) => Promise<string> }
  | { kind: 'confirm'; title: string; lines: string[]; ok: () => Promise<string> }
  | { kind: 'pick'; title: string; items: PickItem[]; index: number; note?: string; submit: (v: string) => Promise<string> };

const nodeLabel = (n: P.Node) => n.kind === 'agent' ? n.name : n.kind === 'note' ? n.doc.title : n.kind === 'file' ? n.item.label : n.kind === 'task' ? n.task.subject : n.kind === 'browser' ? 'browser' : n.item.name;

export class App {
  screen = new Screen();
  grid: Grid;
  prev: Grid | null = null;
  view: ViewName = 'home';
  dirty = true; status = ''; statusUntil = 0; tick = 0;
  modal: Modal | null = null;
  inline: { label: string; input: TextInput; submit: (v: string) => Promise<string> } | null = null;

  // início
  cards: P.ProjectCard[] = []; homeSel = ''; homeScroll = 0;   // vazio até o primeiro load: cai no primeiro projeto
  // projeto
  project: P.Project | null = null; pv: P.View | null = null; sel: string | null = null; pScroll = 0;
  linking: { source: string } | null = null;
  // agente
  agent: P.AgentNode | null = null; evs: Ev[] = []; rowsAll: Row[] = []; aScroll = 0; aCursor = -1; expanded = new Set<string>();
  chat: ChatSession | null = null; composing = false; chatInput = new TextInput(); prefs = { model: '', effort: '', permissionMode: '' };
  showThinking = false; showPanel = true;
  // itens
  note: store.Doc | null = null; noteScroll = 0;
  file: P.FileItem | null = null; fileLines: string[] | null = null; fileScroll = 0;
  service: P.ServiceItem | null = null; svcStats: svc.Stats | null = null;
  task: P.TaskNode | null = null;
  diffEv: Ev | null = null; diffScroll = 0; diffTotal = 0;
  browser: P.BrowserNode | null = null; browserScroll = 0; browserTotal = 0;
  page: LiveView | null = null; imgBox: { x: number; y: number; cols: number; rows: number } | null = null; imgKey = ''; imgId = 1; cellW = 8; cellH = 17; typing = false; booting = '';

  constructor(screen?: Screen) { if (screen) this.screen = screen; this.grid = new Grid(this.screen.W, this.screen.H); }
  say(msg: string, ms = 3000) { this.status = msg; this.statusUntil = Date.now() + ms; this.dirty = true; }

  // ------------------------------------------------------------ carregar
  async load() {
    if (this.view === 'home' || !this.project) {
      this.cards = await P.homeCards();
      const keys = [...this.cards.map((_, i) => `proj:${i}`), 'new'];
      if (!keys.includes(this.homeSel)) this.homeSel = keys[0]!;
    }
    if (this.project) {
      this.pv = await P.view(this.project);
      if (this.sel && !this.pv.nodes.some((n) => n.id === this.sel)) this.sel = this.pv.nodes[0]?.id ?? null;
      if (!this.sel) this.sel = this.pv.nodes[0]?.id ?? null;
      await this.applyBriefings();
      if (this.view === 'agent' && this.agent) {
        const fresh = this.pv.nodes.find((n): n is P.AgentNode => n.kind === 'agent' && n.id === this.agent!.id);
        if (fresh) { this.agent = fresh; if (fresh.session && !this.chat && fresh.session.path !== this.lastLoadedPath) await this.loadTranscript(fresh.session); }
      }
      if (this.view === 'service' && this.service) this.svcStats = await svc.stats(this.service.pid);
    }
    this.dirty = true;
  }

  /** Agente novo respondeu "ligar: …"? Então liga e marca como feito. */
  private async applyBriefings() {
    if (!this.project || !this.pv) return;
    const g = await P.loadGraph(this.project.id);
    let changed = false;
    for (const it of g.items) {
      if (it.kind !== 'agent' || !(it as any).briefingPending) continue;
      const node = this.pv.nodes.find((n): n is P.AgentNode => n.kind === 'agent' && n.id === it.id);
      if (!node?.session) continue;
      const evs = await parseSession(node.session.path);
      const reply = evs.find((e) => e.role === 'assistant' && e.text && /ligar:/i.test(e.text))?.text;
      if (!reply) continue;
      for (const id of P.parseBriefingReply(this.pv, reply)) await this.connect(node.id, id, 'contexto');
      delete (it as any).briefingPending; changed = true;
      this.say(`${node.name} se ligou ao que fazia sentido`, 5000);
    }
    if (changed) { await P.saveGraph(this.project.id, g); this.pv = await P.view(this.project); }
  }

  // ------------------------------------------------------------ navegação geométrica
  private rectsOnScreen(): { key: string; x: number; y: number }[] {
    if (this.view === 'home') return layoutHome(this.cards.length, this.grid.W, this.homeScroll).rects.map((r) => ({ key: r.key, x: r.rect.x + r.rect.w / 2, y: r.rect.y + r.rect.h / 2 }));
    if (this.view === 'project' && this.pv) return layoutProject(this.pv, this.grid.W, this.pScroll, this.showPanel).boxes.map((b) => ({ key: b.id, x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2 }));
    return [];
  }
  private get selKey() { return this.view === 'home' ? this.homeSel : this.sel; }
  private set selKey(v: string | null) { if (this.view === 'home') this.homeSel = v ?? 'new'; else this.sel = v; }

  navigate(dir: 'up' | 'down' | 'left' | 'right') {
    const ts = this.rectsOnScreen();
    const cur = ts.find((t) => t.key === this.selKey);
    if (!cur) { this.selKey = ts[0]?.key ?? null; this.dirty = true; return; }
    let best: typeof cur | null = null, score = Infinity;
    for (const t of ts) {
      if (t.key === cur.key) continue;
      const dx = t.x - cur.x, dy = t.y - cur.y;
      const ok = dir === 'left' ? dx < -1 : dir === 'right' ? dx > 1 : dir === 'up' ? dy < -1 : dy > 1;
      if (!ok) continue;
      const along = Math.abs(dir === 'left' || dir === 'right' ? dx : dy), off = Math.abs(dir === 'left' || dir === 'right' ? dy : dx);
      const s = along + off * 3;
      if (s < score) { score = s; best = t; }
    }
    if (best) { this.selKey = best.key; this.ensureVisible(); this.dirty = true; }
  }
  cycle(step: number) {
    const ts = this.rectsOnScreen(); if (!ts.length) return;
    const i = ts.findIndex((t) => t.key === this.selKey);
    this.selKey = ts[((i < 0 ? 0 : i + step) % ts.length + ts.length) % ts.length]!.key;
    this.ensureVisible(); this.dirty = true;
  }
  ensureVisible() {
    const top = 1, bottom = this.grid.H - 4;
    if (this.view === 'home') {
      const r = layoutHome(this.cards.length, this.grid.W, this.homeScroll).rects.find((x) => x.key === this.homeSel)?.rect; if (!r) return;
      if (r.y < top) this.homeScroll -= top - r.y; else if (r.y + r.h - 1 > bottom) this.homeScroll += r.y + r.h - 1 - bottom;
      this.homeScroll = Math.max(0, this.homeScroll);
    } else if (this.view === 'project' && this.pv) {
      const r = layoutProject(this.pv, this.grid.W, this.pScroll, this.showPanel).boxes.find((b) => b.id === this.sel)?.rect; if (!r) return;
      if (r.y < top) this.pScroll -= top - r.y; else if (r.y + r.h - 1 > bottom) this.pScroll += r.y + r.h - 1 - bottom;
      this.pScroll = Math.max(0, this.pScroll);
    }
  }

  // ------------------------------------------------------------ início
  newProject() {
    this.modal = {
      kind: 'form',
      note: 'o diretório é criado se não existir',
      form: new Form('novo projeto', [
        { label: 'nome', required: true, hint: 'como você chama' },
        { label: 'diretório', hint: '~/Documents/<nome>' },
      ]),
      submit: async ([name, dir]) => {
        const p = await P.createProject(name!, dir || `~/Documents/${store.slugify(name!, 32)}`);
        await this.openProject(p);
        return `${p.name} criado em ${p.cwd.replace(process.env.HOME ?? '', '~')}`;
      },
    };
    this.dirty = true;
  }
  async openHomeSel() {
    if (this.homeSel === 'new') return this.newProject();
    const c = this.cards[Number(this.homeSel.slice(5))]; if (!c) return;
    await this.openProject(c.registered ? c.project : await P.ensureProject(c.project.cwd));
  }
  async openProject(p: P.Project) {
    this.project = p; this.view = 'project'; this.sel = null; this.pScroll = 0; this.linking = null;
    await this.load();
  }

  // ------------------------------------------------------------ projeto: abrir, criar, ligar, remover
  private node(id: string | null) { return id && this.pv ? this.pv.nodes.find((n) => n.id === id) ?? null : null; }

  async openSel() {
    const n = this.node(this.sel); if (!n) return;
    if (n.kind === 'agent') return this.openAgent(n);
    if (n.kind === 'note') { this.note = n.doc; this.noteScroll = 0; this.view = 'note'; }
    if (n.kind === 'file') { this.file = n.item; this.fileScroll = 0; this.fileLines = await readFile(n.item.path, 'utf8').then((t) => t.split('\n')).catch(() => null); this.view = 'file'; }
    if (n.kind === 'service') { this.service = n.item; this.svcStats = await svc.stats(n.item.pid); this.view = 'service'; }
    if (n.kind === 'task') { this.task = n; this.view = 'task'; }
    if (n.kind === 'browser') { this.browser = n; this.typing = false; this.view = 'browser'; void this.op(this.openLive(n.item)); }
    this.dirty = true;
  }

  /** Sobe o Chrome se preciso e liga a página ao vivo. */
  async openLive(it: P.BrowserItem) {
    this.page?.stop(); this.page = null; this.imgKey = '';
    this.booting = 'subindo o Chrome…'; this.dirty = true;
    try { const r = await P.ensureBrowserUp(it); this.booting = ''; if (r === 'subiu') this.say(`chrome ${MODE_LABEL[it.mode]} subiu`, 3000); }
    catch (e) { this.booting = ''; this.say(`chrome não subiu: ${(e as Error).message}`, 7000); this.dirty = true; return; }
    if (this.view !== 'browser') return;
    this.page = new LiveView(it.port, () => { this.dirty = true; });
    await this.page.start();
  }
  closeLive() { this.page?.stop(); this.page = null; this.wipeImages(); this.typing = false; }
  /** Apaga as imagens — só onde o protocolo do Kitty existe: num terminal sem ele a sequência viraria texto na tela. Redesenha tudo em seguida. */
  wipeImages() { if (supportsKittyGraphics()) this.screen.write(clearImages()); this.imgKey = ''; this.prev = null; this.dirty = true; }
  /** oculto ⇄ janela, com o mesmo perfil; o agente reconecta sozinho. */
  async toggleBrowserMode() {
    const b = this.browser; if (!b || !this.project) return;
    const mode: BrowserMode = b.item.mode === 'oculto' ? 'janela' : 'oculto';
    this.page?.stop(); this.page = null; this.wipeImages(); this.imgKey = '';
    this.booting = mode === 'janela' ? 'abrindo o Chrome na tela…' : 'ocultando o Chrome…'; this.dirty = true;
    try { await P.setBrowserMode(this.project.id, b.item, mode); await this.load(); }
    catch (e) { this.booting = ''; this.say(`não troquei o modo: ${(e as Error).message}`, 7000); this.dirty = true; return; }
    this.booting = '';
    const fresh = this.pv?.nodes.find((n): n is P.BrowserNode => n.kind === 'browser' && n.id === b.id); if (fresh) this.browser = fresh;
    this.say(mode === 'janela' ? 'o Chrome está na tela, sem roubar o foco; o agente reconecta sozinho' : 'o Chrome saiu da tela e do Dock; continua aqui ao vivo', 6000);
    if (this.view === 'browser') { this.page = new LiveView(b.item.port, () => { this.dirty = true; }); await this.page.start(); }
  }

  pickKind() {
    const agentSel = this.node(this.sel)?.kind === 'agent';
    this.modal = {
      kind: 'pick', title: 'novo', index: 0, items: [
        { value: 'agent', label: `${KIND_GLYPH.agent} agente`, hint: 'sessão nomeada, recebe o mapa do projeto' },
        { value: 'note', label: `${KIND_GLYPH.note} nota`, hint: agentSel ? 'já ligada ao agente selecionado' : 'texto numa linha; @2h = efêmera' },
        { value: 'file', label: `${KIND_GLYPH.file} arquivo`, hint: 'caminho no projeto ou absoluto' },
        { value: 'service', label: `${KIND_GLYPH.service} serviço`, hint: 'o que está escutando porta nesta máquina' },
        { value: 'browser', label: `${KIND_GLYPH.browser} browser`, hint: 'Chrome pelo Playwright; o agente ligado ganha browser_*' },
        { value: 'context', label: `${KIND_GLYPH.file} contexto`, hint: 'CLAUDE.md do projeto — abre, ou gera com o /init do Claude' },
      ],
      submit: async (kind) => { if (kind === 'context') return this.contextAction(); await this.create(kind as P.ItemKind | 'browser'); return ''; },
    };
    this.dirty = true;
  }

  async create(kind: P.ItemKind | 'browser') {
    if (kind === 'browser') {
      const p0 = this.project!;
      this.modal = { kind: 'pick', title: 'browser', index: 0, note: 'o anthive sobe um Chrome só do projeto; o agente ligado (l) usa esse mesmo Chrome',
        items: [{ value: 'oculto', label: 'oculto (recomendado)', hint: 'sem janela nem ícone no Dock — a página aparece ao vivo aqui, e você clica nela' }, { value: 'janela', label: 'janela', hint: 'o Chrome abre na tela sem roubar o foco; troca com o depois' }],
        submit: async (v) => { const it = await P.addBrowser(p0, v as BrowserMode); await this.load(); this.sel = it.id; this.ensureVisible(); return 'browser no projeto — ligue um agente (l) e abra com ↵ para ver ao vivo'; } };
      this.dirty = true; return;
    }
    const p = this.project!, agentSel = this.node(this.sel);
    if (kind === 'agent') {
      this.modal = {
        kind: 'form', note: 'com instrução, ele já começa — e antes decide com o que se ligar',
        form: new Form('novo agente', [
          { label: 'nome', required: true, hint: 'api, db, ui…' },
          { label: 'worktree', hint: 'branch; vazio usa o diretório do projeto' },
          { label: 'instrução', hint: 'opcional — o primeiro pedido' },
        ]),
        submit: async ([name, wt, prompt]) => {
          const it = await P.addAgent(p, name!, { worktree: wt || undefined });
          const bus = await P.ensureBus(it.cwd);
          if (bus !== 'já estava') this.say(`barramento ${bus} em ${it.cwd.replace(process.env.HOME ?? '', '~')}/.mcp.json`, 5000);
          if (prompt) {
            const briefing = P.buildBriefing(this.pv!, it.name, prompt);
            await P.firstTurn(it, briefing);
            const g = await P.loadGraph(p.id); const stored = g.items.find((x) => x.id === it.id); if (stored) { (stored as any).briefingPending = true; await P.saveGraph(p.id, g); }
          }
          await this.load(); this.sel = it.id; this.ensureVisible();
          return prompt ? `${it.name} nasceu e já está lendo o projeto` : `${it.name} nasceu — ↵ abre o chat`;
        },
      };
    } else if (kind === 'note') {
      const to = agentSel?.kind === 'agent' ? agentSel.name : null;
      this.inline = {
        label: to ? `${G.note} nota ${G.arrow} ${to}` : `${G.note} nota`, input: new TextInput(),
        submit: async (raw) => {
          const m = /\s@(\d+[smhd])\s*$/.exec(raw); const text = (m ? raw.slice(0, m.index) : raw).trim();
          if (!text) throw new Error('nota vazia');
          const d = await store.create({ kind: 'note', title: text.split('\n')[0]!.slice(0, 48), body: `${text}\n`, acl: to ? [to] : [], ttl: store.parseTTL(m?.[1]), project: p.id });
          await this.load(); this.sel = `note-${d.id}`; this.ensureVisible();
          return `${store.uri(d)}${to ? ` ligada a ${to}` : ''}`;
        },
      };
    } else if (kind === 'file') {
      this.inline = {
        label: `${KIND_GLYPH.file} arquivo`, input: new TextInput(),
        submit: async (raw) => {
          const rel = raw.trim(); if (!rel) throw new Error('caminho vazio');
          const abs = rel.startsWith('/') || rel.startsWith('~') ? rel : `${p.cwd}/${rel}`;
          const it = await P.addFile(p.id, abs).catch(() => { throw new Error(`não achei ${rel}`); });
          if (agentSel?.kind === 'agent') await P.link(p.id, agentSel.id, it.id);
          await this.load(); this.sel = it.id; this.ensureVisible();
          return `${it.label} no projeto${agentSel?.kind === 'agent' ? `, ligado a ${agentSel.name}` : ''}`;
        },
      };
    } else {
      const found = await svc.discover();
      if (!found.length) { this.say('nada escutando porta nesta máquina agora'); return; }
      this.modal = {
        kind: 'pick', title: 'serviço escutando', index: 0, note: 'só o que está vivo nesta máquina, pelo lsof',
        items: found.map((f) => ({ value: String(f.pid) + ':' + f.port, label: `${f.command} :${f.port}`, hint: `pid ${f.pid}  ${f.addr}` })),
        submit: async (v) => {
          const [pid, port] = v.split(':').map(Number);
          const f = found.find((x) => x.pid === pid && x.port === port)!;
          const it = await P.addService(p.id, { name: f.command, pid: f.pid, port: f.port, command: f.command, cwd: await svc.cwdOf(f.pid) });
          if (agentSel?.kind === 'agent') await P.link(p.id, agentSel.id, it.id);
          await this.load(); this.sel = it.id; this.ensureVisible();
          return `${it.name}:${it.port} no projeto`;
        },
      };
    }
    this.dirty = true;
  }

  /** CLAUDE.md existe: abre. Não existe: o /init do Claude gera numa sessão nova, em segundo plano. */
  async contextAction(): Promise<string> {
    const p = this.project!;
    const node = this.pv?.nodes.find((n): n is P.FileNode => n.kind === 'file' && n.item.context === 'claude');
    if (node) { this.sel = node.id; await this.openSel(); return ''; }
    P.generateClaudeMd(p.cwd);
    return 'gerando CLAUDE.md com o /init — aparece no mapa quando terminar';
  }

  /** Ligar tem semântica pelo par: agente⇄agente conversa; agente→nota é leitura; o resto é associação. */
  async connect(aId: string, bId: string, goal?: string): Promise<string> {
    const a = this.node(aId), b = this.node(bId); if (!a || !b || !this.project) throw new Error('nó sumiu');
    if (a.kind === 'agent' && b.kind === 'agent') {
      if (!goal) {
        this.inline = { label: `${G.swap} ${a.name} ${G.swap} ${b.name} ${G.h} objetivo`, input: new TextInput(),
          submit: async (g) => { const d = await bus.link(a.name, b.name, g.trim()); await this.load(); return `${d.id} aberta`; } };
        this.dirty = true; return '';
      }
      await bus.link(a.name, b.name, goal); return `${a.name} ⇄ ${b.name}`;
    }
    const [ag, other] = a.kind === 'agent' ? [a, b] : b.kind === 'agent' ? [b, a] : [null, null];
    if (ag && other?.kind === 'note') { await store.attach(other.doc.id, [ag.name]); return `${ag.name} lê ${other.doc.title}`; }
    await P.link(this.project.id, aId, bId);
    const br = a.kind === 'browser' || b.kind === 'browser';
    return `${nodeLabel(a)} → ${nodeLabel(b)}${br ? ' · reabra o chat do agente (x, i) para ele ganhar as ferramentas do browser' : ''}`;
  }
  async commitLink() {
    const src = this.linking?.source, dst = this.sel; if (!src || !dst) return;
    if (src === dst) { this.say('escolha outro nó'); return; }
    this.linking = null;
    try { const msg = await this.connect(src, dst); if (msg) { await this.load(); this.say(msg, 4000); } }
    catch (e) { this.say((e as Error).message, 5000); }
    this.dirty = true;
  }

  removeSel() {
    const n = this.node(this.sel); if (!n || !this.project) return;
    const pid = this.project.id;
    if (n.kind === 'agent' && !n.item) { this.say('sessão descoberta não se remove — ela é do disco', 4000); return; }
    if (n.kind === 'task') { this.say('tarefa é do agente — ele a fecha com TaskUpdate', 4000); return; }
    if (n.kind === 'file' && n.item.context) { this.say('arquivo de contexto do Claude — ele é lido em toda sessão; edite com e, não se desliga', 5000); return; }
    const what = n.kind === 'note' ? `apagar a nota "${n.doc.title}"?` : n.kind === 'file' ? `desligar ${n.item.label} do projeto?` : n.kind === 'service' ? `remover ${n.item.name} do projeto?` : n.kind === 'browser' ? 'remover o browser do projeto?' : `remover o agente ${n.name}?`;
    const lines = n.kind === 'note' ? ['o arquivo da nota some'] : n.kind === 'file' ? ['o arquivo continua no disco; só sai do mapa'] : n.kind === 'service' ? ['o processo continua rodando; só sai do mapa'] : n.kind === 'browser' ? ['o Chrome fecha; a entrada playwright fica no .mcp.json'] : ['o transcript fica; o worktree também'];
    this.modal = { kind: 'confirm', title: what, lines, ok: async () => {
      if (n.kind === 'browser') { this.closeLive(); await P.closeBrowser(n.item); }
      if (n.kind === 'note') await unlink(n.doc.path); else await P.removeItem(pid, n.id);
      this.sel = null; await this.load(); return 'removido';
    } };
    this.dirty = true;
  }

  // ------------------------------------------------------------ agente
  lastLoadedPath = '';
  private memView() { return Math.max(1, this.grid.H - 8 - INPUT_H(this.composing)); }
  private rebuild(toBottom: boolean) {
    this.rowsAll = rows(this.evs, this.agent?.cwd ?? '', this.expanded, detailWidth(this.grid.W, this.showPanel), this.showThinking);
    const max = Math.max(0, this.rowsAll.length - this.memView());
    if (toBottom) { this.aScroll = max; this.aCursor = -1; } else this.aScroll = Math.min(this.aScroll, max);
    this.dirty = true;
  }
  private async loadTranscript(s: Session) { this.evs = await parseSession(s.path); this.lastLoadedPath = s.path; this.expanded = new Set(); this.rebuild(true); }
  async openAgent(n: P.AgentNode) {
    this.agent = n; this.view = 'agent'; this.composing = false;
    if (n.session) await this.loadTranscript(n.session); else { this.evs = []; this.lastLoadedPath = ''; this.rebuild(true); }
    if (this.chat && this.chat.sessionId !== (n.session ? basename(n.session.path, '.jsonl') : n.item?.sessionId)) this.stopChat();
  }
  private chips(): LinkChip[] {
    if (!this.pv || !this.agent) return [];
    const out: LinkChip[] = [];
    for (const e of this.pv.edges) {
      const other = e.from === this.agent.id ? e.to : e.to === this.agent.id ? e.from : null; if (!other) continue;
      const n = this.node(other); if (!n) continue;
      const st = e.thread ? store.threadState(e.thread) : null;
      out.push({ glyph: n.kind === 'agent' ? G.swap : KIND_GLYPH[n.kind], label: n.kind === 'agent' && st ? `${n.name} ${st.turn}/${st.budget}` : nodeLabel(n), color: n.kind === 'agent' ? C.link : n.kind === 'note' ? C.link : n.kind === 'service' ? C.run : n.kind === 'task' ? C.hold : n.kind === 'browser' ? C.run : C.ink });
    }
    return out;
  }
  private get live() { const c = this.chat; return c ? { model: c.model, effort: c.effort, permissionMode: c.permissionMode, busy: c.busy, thinking: c.thinking, summary: c.summary, cost: c.cost } : null; }

  /** O painel direito: o que vale saber do agente sem sair da conversa. */
  private panelData(): PanelData | null {
    if (!this.showPanel || !this.agent) return null;
    const s = this.agent.session;
    const last = this.evs[this.evs.length - 1];
    const state = this.chat?.busy ? `pensando${'…'}${this.chat.thinking ? ` ${tok(this.chat.thinking)}` : ''}` : last?.tool ? `${last.tool} em andamento` : last?.role === 'assistant' ? 'esperando você' : s ? 'ocioso' : 'sessão nova';
    return {
      context: s?.context ?? 0, window: s ? windowOf(s.model, s.context) : 200_000,
      model: this.chat?.model || s?.model || '', effort: this.chat?.effort || s?.effort || '', perm: this.chat?.permissionMode || '',
      events: this.evs.length, burn: this.evs.reduce((n, e) => n + (e.usage?.output ?? 0), 0), cost: this.chat?.cost ?? 0,
      compactions: this.evs.filter((e) => e.isCompact).length, thinkingBlocks: this.evs.filter((e) => e.thinking).length, showThinking: this.showThinking,
      links: this.chips(), tasks: tasksFrom(this.evs), state,
    };
  }

  /** y: copia o turno sob o cursor (o que você disse, ou o que ele respondeu) para o clipboard. */
  copyTurn() {
    const r = this.rowsAll[this.aCursor] ?? this.rowsAll[this.rowsAll.length - 2];
    const turn = r?.turn; if (!turn) { this.say('nada para copiar aqui'); return; }
    const i = this.evs.findIndex((e) => e.uuid === turn);
    const chunk = this.evs.slice(i).filter((e, k) => k === 0 || (e.role === 'assistant' && !e.tool && e.full && this.evs.slice(i + 1, i + k).every((x) => !(x.role === 'user' && !x.tool && !x.meta))));
    const text = chunk.map((e) => (e.role === 'user' ? `> ${e.full ?? e.text}` : e.full ?? e.text)).join('\n\n');
    try {
      const p = Bun.spawn(['pbcopy'], { stdin: 'pipe' }); p.stdin.write(text); p.stdin.end();
      this.say(`copiado: ${[...text].length} caracteres`);
    } catch { this.say('pbcopy não disponível'); }
  }
  async startChat() {
    const a = this.agent; if (!a) return;
    const browser = !!(this.project && a.item && (await P.agentHasBrowser(this.project.id, a.item.id)));
    if (browser && this.project && a.item) {
      // o Playwright do agente liga no Chrome do anthive: ele precisa estar de pé antes do processo subir
      const it = await P.browserOf(this.project.id, a.item.id);
      if (it) {
        try { await P.ensureBrowserServer(a.cwd, it.port); const r = await P.ensureBrowserUp(it); if (r === 'subiu') this.say(`chrome ${MODE_LABEL[it.mode]} subiu para o agente`, 4000); }
        catch (e) { this.say(`chrome não subiu: ${(e as Error).message}`, 7000); }
      }
    }
    const sid = a.session ? basename(a.session.path, '.jsonl') : a.item?.sessionId ?? null;
    if (!sid) { this.say('essa sessão não tem id — abra pelo projeto de novo'); return; }
    if (this.chat?.sessionId === sid) return;
    this.chat?.stop();
    // o barramento tem que existir no diretório ANTES do processo subir: é lido na partida
    try { const bus = await P.ensureBus(a.cwd); if (bus !== 'já estava') this.say(`barramento ${bus} em .mcp.json — note_write, project_map e o resto já valem aqui`, 6000); }
    catch (e) { this.say(`não consegui gravar .mcp.json: ${(e as Error).message}`, 6000); }
    this.chat = new ChatSession({ cwd: a.cwd, resume: a.session ? sid : undefined, sessionId: a.session ? undefined : sid, agent: a.item?.name, browser,
      model: this.prefs.model || undefined, effort: this.prefs.effort || undefined, permissionMode: this.prefs.permissionMode || undefined }, (e) => this.onChat(e));
    this.chat.start();
  }
  stopChat() { this.chat?.stop(); this.chat = null; this.composing = false; this.dirty = true; }
  private onChat(e: ChatEvent) {
    if (e.kind === 'ev') { this.evs.push(e.ev); this.rebuild(true); }
    else if (e.kind === 'result') { this.screen.write('\x07'); const den = e.denials.length ? ` · negou ${e.denials.join(', ')} — p muda a permissão` : ''; this.say(`${e.stop || 'ok'}${e.cost ? ` · $${e.cost.toFixed(3)}` : ''}${den}`, den ? 8000 : 3000); }
    else if (e.kind === 'stderr') this.say(e.text.split('\n')[0] ?? 'erro', 6000);
    else if (e.kind === 'exit') { if (this.chat && !this.chat.proc) return; this.say(`chat saiu (${e.code})`, 5000); this.chat = null; this.composing = false; }
    this.dirty = true;
  }
  sendChat() {
    const text = this.chatInput.value.trim(); if (!text) return;
    if (!this.chat) { this.say('abrindo o chat… mande de novo em um instante'); void this.op(this.startChat()); return; }
    if (this.chat.busy) { this.say('espere a resposta terminar'); return; }
    if (!this.chat.send(text)) { this.say('chat caiu — i reabre'); this.chat = null; return; }
    this.evs.push({ uuid: crypto.randomUUID(), parent: null, sidechain: false, type: 'user', ts: Date.now(), role: 'user', text });
    this.rebuild(true); this.chatInput.set('');
  }
  pickSetting(kind: 'model' | 'effort' | 'permissionMode') {
    const label = { model: 'modelo', effort: 'esforço', permissionMode: 'permissão' }[kind];
    const base = { model: MODELS, effort: EFFORTS, permissionMode: PERMISSIONS }[kind];
    const cur = this.chat?.[kind] || this.prefs[kind] || (kind === 'model' ? this.agent?.session?.model : kind === 'effort' ? this.agent?.session?.effort : '') || '';
    const values = cur && !base.includes(cur) ? [cur, ...base] : [...base];
    const items: PickItem[] = [{ value: '', label: '(padrão da sessão)', hint: 'não passa a flag', current: !cur }, ...values.map((v) => ({ value: v, label: v, current: v === cur }))];
    this.modal = { kind: 'pick', title: label, items, index: Math.max(0, items.findIndex((i) => i.current)), note: this.chat ? 'reinicia na mesma sessão — nada se perde' : 'vale para o próximo chat',
      submit: async (v) => { this.prefs[kind] = v; if (this.chat) this.chat.restart({ [kind]: v } as any); return `${label}: ${v || 'padrão'}`; } };
    this.dirty = true;
  }
  /** Ligar a partir de uma tela de item: lista os outros nós do projeto. */
  pickLinkTarget(fromId: string) {
    if (!this.pv) return;
    const items: PickItem[] = this.pv.nodes.filter((n) => n.id !== fromId).map((n) => ({ value: n.id, label: `${n.kind === 'agent' ? KIND_GLYPH.agent : KIND_GLYPH[n.kind]} ${nodeLabel(n)}`, hint: n.kind }));
    if (!items.length) { this.say('não há outro nó no projeto'); return; }
    this.modal = { kind: 'pick', title: 'ligar a', items, index: 0, submit: async (id) => { const m = await this.connect(fromId, id); if (m) await this.load(); return m; } };
    this.dirty = true;
  }
  toggleTurn() {
    const r = this.rowsAll[this.aCursor]; if (!r?.turn) return;
    if (this.expanded.has(r.turn)) this.expanded.delete(r.turn); else this.expanded.add(r.turn);
    const keep = r.turn; this.rebuild(false);
    const i = this.rowsAll.findIndex((x) => x.kind === 'turn' && x.turn === keep); if (i >= 0) this.aCursor = i;
  }

  /** Abre o $EDITOR de verdade: devolve o terminal, espera, volta. */
  editExternal(path: string) {
    const ed = process.env.VISUAL || process.env.EDITOR || 'nano';
    this.screen.restore();
    Bun.spawnSync([ed, path], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    this.screen.enter(() => { this.screen.measure(); this.prev = null; this.dirty = true; });
    this.prev = null; this.dirty = true;
  }

  /** A última operação assíncrona disparada por tecla — os testes esperam por ela. */
  lastOp: Promise<unknown> = Promise.resolve();
  private op<T>(p: Promise<T>): Promise<T> { const prev = this.lastOp; this.lastOp = prev.then(() => p.catch(() => {})); return p; }   // encadeia: esperar lastOp = esperar tudo em voo

  /**
   * O modal sai de cena ANTES da ação rodar: a ação pode abrir outro modal ou um
   * campo, e teclas que chegam em seguida têm que ir para o que a ação abriu.
   * Erro de formulário devolve o formulário com a mensagem, sem perder o digitado.
   */
  private runModal(fn: () => Promise<string>) {
    const m = this.modal; this.modal = null;
    return this.op((async () => {
      try { const msg = await fn(); if (msg) this.say(msg, 4000); }
      catch (e) { if (m?.kind === 'form') { m.form.error = (e as Error).message; this.modal = m; } else this.say((e as Error).message, 5000); }
      this.dirty = true;
    })());
  }
  private runInline(fn: () => Promise<string>) {
    const f = this.inline; this.inline = null;
    return this.op((async () => {
      try { const msg = await fn(); if (msg) this.say(msg, 4000); }
      catch (e) { this.inline = f; this.say((e as Error).message, 5000); }
      this.dirty = true;
    })());
  }

  // ------------------------------------------------------------ teclas
  key(k: Key): void {
    if (k.k === 'cellpx') { this.cellW = k.w; this.cellH = k.h; this.dirty = true; return; }
    if (k.k === 'winpx') return;
    if (this.modal) {
      const m = this.modal;
      if (m.kind === 'confirm') { if (k.k === 'char' && 'sSy'.includes(k.c)) void this.runModal(m.ok); else if (k.k === 'esc' || (k.k === 'char' && 'nN'.includes(k.c))) { this.modal = null; this.dirty = true; } return; }
      if (m.kind === 'pick') {
        const n = m.items.length;
        if (k.k === 'up' || (k.k === 'char' && k.c === 'k')) m.index = (m.index - 1 + n) % n;
        else if (k.k === 'down' || (k.k === 'char' && k.c === 'j') || k.k === 'tab') m.index = (m.index + 1) % n;
        else if (k.k === 'enter') { const v = m.items[m.index]!.value; void this.runModal(() => m.submit(v)); return; }
        else if (k.k === 'esc') this.modal = null;
        else if (k.k === 'char' && k.c >= ' ') { const c = k.c.toLowerCase(); for (let i = 1; i <= n; i++) { const j = (m.index + i) % n; if (m.items[j]!.label.toLowerCase().split(/[-_\s]+/).some((w) => w.startsWith(c))) { m.index = j; break; } } }
        this.dirty = true; return;
      }
      const r = m.form.handle(k);
      if (r === 'cancel') this.modal = null; else if (r === 'submit') void this.runModal(() => m.submit(m.form.values()));
      this.dirty = true; return;
    }
    if (this.inline) {
      const f = this.inline;
      if (k.k === 'esc') this.inline = null; else if (k.k === 'enter') void this.runInline(() => f.submit(f.input.value)); else f.input.handle(k);
      this.dirty = true; return;
    }
    if (this.linking && this.view === 'project') {
      if (k.k === 'esc') { this.linking = null; this.dirty = true; return; }
      if (k.k === 'enter') { void this.op(this.commitLink()); return; }
      if (k.k === 'mouse' && k.press && k.button === 0) { const h = this.grid.hitTest(k.x, k.y); if (h) { this.sel = h; this.dirty = true; if (h !== this.linking.source) void this.op(this.commitLink()); } return; }
      if (k.k === 'char' && k.c !== 'q') return;
    }
    if (k.k === 'char' && (k.c === 'q' || k.c === 'Q') && !(this.view === 'agent' && this.composing)) return this.quit();

    switch (this.view) {
      case 'home':
        if (k.k === 'up' || k.k === 'down' || k.k === 'left' || k.k === 'right') this.navigate(k.k);
        else if (k.k === 'tab') this.cycle(1);
        else if (k.k === 'enter') void this.op(this.openHomeSel());
        else if (k.k === 'mouse' && k.press && k.button === 0) { const h = this.grid.hitTest(k.x, k.y); if (h) { if (h === this.homeSel) void this.op(this.openHomeSel()); else this.homeSel = h; this.dirty = true; } }
        else if (k.k === 'char' && k.c === 'n') this.newProject();
        else if (k.k === 'char' && k.c === 'r') void this.load();
        return;
      case 'project':
        if (k.k === 'up' || k.k === 'down' || k.k === 'left' || k.k === 'right') this.navigate(k.k);
        else if (k.k === 'tab') this.cycle(1);
        else if (k.k === 'enter') void this.op(this.openSel());
        else if (k.k === 'wheel') { this.pScroll = Math.max(0, this.pScroll + k.dir * 2); this.dirty = true; }
        else if (k.k === 'mouse' && k.press && k.button === 0) { const h = this.grid.hitTest(k.x, k.y); if (h) { if (h === this.sel) void this.op(this.openSel()); else this.sel = h; this.dirty = true; } }
        else if (k.k === 'esc') { this.project = null; this.pv = null; this.view = 'home'; void this.op(this.load()); }
        else if (k.k === 'char') {
          if (k.c === 'n') this.pickKind();
          else if (k.c === 'l') { if (!this.sel) this.say('selecione algo primeiro'); else if ((this.rectsOnScreen().length) < 2) this.say('não há outro nó para ligar'); else { this.linking = { source: this.sel }; this.dirty = true; } }
          else if (k.c === 'd') this.removeSel();
          else if (k.c === 'r') void this.load();
          else if (k.c === ']') { this.showPanel = !this.showPanel; this.ensureVisible(); this.dirty = true; }
        }
        return;
      case 'diff': {
        const max = Math.max(0, this.diffTotal - (this.grid.H - 7));
        if (k.k === 'up') this.diffScroll = Math.max(0, this.diffScroll - 1);
        else if (k.k === 'down') this.diffScroll = Math.min(max, this.diffScroll + 1);
        else if (k.k === 'wheel') this.diffScroll = Math.max(0, Math.min(max, this.diffScroll + k.dir * 3));
        else if (k.k === 'esc' || k.k === 'backspace') this.view = 'agent';
        this.dirty = true; return;
      }
      case 'browser': {
        const b = this.browser, live = this.page, box = this.imgBox;
        const clickAt = (x: number, y: number) => { if (box && live?.frame && inBox(x, y, box)) { const p = toPage(x, y, box, live.frame.w, live.frame.h); live.click(p.x, p.y); return true; } return false; };
        if (this.typing) {
          if (k.k === 'esc') this.typing = false;
          else if (k.k === 'enter') live?.key('Enter');
          else if (k.k === 'backspace') live?.key('Backspace');
          else if (k.k === 'tab') live?.key('Tab');
          else if (k.k === 'up') live?.key('ArrowUp'); else if (k.k === 'down') live?.key('ArrowDown'); else if (k.k === 'left') live?.key('ArrowLeft'); else if (k.k === 'right') live?.key('ArrowRight');
          else if (k.k === 'char' && k.c >= ' ') live?.text(k.c);
          else if (k.k === 'mouse' && k.press && k.button === 0) clickAt(k.x, k.y);
          this.dirty = true; return;
        }
        if (k.k === 'esc') { this.closeLive(); this.view = 'project'; void this.op(this.load()); }
        else if (k.k === 'mouse' && k.press && k.button === 0) clickAt(k.x, k.y);
        else if (k.k === 'wheel' && box && live?.frame && inBox(k.x, k.y, box)) { const p = toPage(k.x, k.y, box, live.frame.w, live.frame.h); live.wheel(p.x, p.y, k.dir * 120); }
        else if ((k.k === 'up' || k.k === 'down') && live?.frame) live.wheel(Math.round(live.frame.w / 2), Math.round(live.frame.h / 2), k.k === 'up' ? -160 : 160);
        else if (k.k === 'char' && k.c === 'i') { if (live?.connected) this.typing = true; else this.say('sem página ao vivo para digitar', 3000); }
        else if (k.k === 'char' && k.c === 'o') void this.op(this.toggleBrowserMode());
        else if (k.k === 'char' && k.c === 'r') live?.reload();
        else if (k.k === 'char' && k.c === 'l' && b) this.pickLinkTarget(b.id);
        else if (k.k === 'char' && k.c === 'd') this.removeSel();
        this.dirty = true; return;
      }
      case 'task': {
        if (k.k === 'esc') { this.view = 'project'; void this.op(this.load()); }
        else if (k.k === 'char' && k.c === 'l' && this.task) this.pickLinkTarget(this.task.id);
        this.dirty = true; return;
      }
      case 'agent': {
        if (this.composing) {
          if (k.k === 'esc') { this.composing = false; this.dirty = true; return; }
          if (k.k === 'enter') { this.sendChat(); return; }
          if (k.k !== 'up' && k.k !== 'down' && k.k !== 'wheel') { this.chatInput.handle(k); this.dirty = true; return; }
        }
        const view = this.memView(), max = Math.max(0, this.rowsAll.length - view);
        const step = (d: number) => { if (this.aCursor < 0) this.aCursor = d > 0 ? this.aScroll : Math.min(this.rowsAll.length - 1, this.aScroll + view - 1); let i = this.aCursor + d; while (i >= 0 && i < this.rowsAll.length && this.rowsAll[i]!.kind === 'blank') i += d; if (i >= 0 && i < this.rowsAll.length) this.aCursor = i; if (this.aCursor < this.aScroll) this.aScroll = this.aCursor; else if (this.aCursor >= this.aScroll + view) this.aScroll = this.aCursor - view + 1; };
        if (k.k === 'up') step(-1); else if (k.k === 'down') step(1);
        else if (k.k === 'wheel') { this.aScroll = Math.max(0, Math.min(max, this.aScroll + k.dir * 3)); this.aCursor = -1; }
        else if (k.k === 'enter') {
          const r = this.rowsAll[this.aCursor]; const ev = r?.ev ? this.evs.find((e) => e.uuid === r.ev) : null;
          if (ev && isEditTool(ev.tool)) { this.diffEv = ev; this.diffScroll = 0; this.view = 'diff'; } else this.toggleTurn();
        }
        else if (k.k === 'esc') { this.view = 'project'; void this.op(this.load()); }
        else if (k.k === 'char') {
          if (k.c === 'i') { this.composing = true; if (!this.chat) void this.op(this.startChat()); }
          else if (k.c === 'm') this.pickSetting('model'); else if (k.c === 'e') this.pickSetting('effort'); else if (k.c === 'p') this.pickSetting('permissionMode');
          else if (k.c === 'l' && this.agent) this.pickLinkTarget(this.agent.id);
          else if (k.c === 'x') { this.stopChat(); this.say('chat encerrado — o transcript fica'); }
          else if (k.c === 't') { this.showThinking = !this.showThinking; this.rebuild(false); this.say(this.showThinking ? 'pensamento visível' : 'pensamento escondido'); }
          else if (k.c === 'y') this.copyTurn();
          else if (k.c === ']') { this.showPanel = !this.showPanel; this.rebuild(false); }
          else if (k.c === 'g') { this.aScroll = 0; this.aCursor = 0; } else if (k.c === 'G') { this.aScroll = max; this.aCursor = -1; }
        }
        this.dirty = true; return;
      }
      case 'note': case 'file': case 'service': {
        const n = this.node(this.sel);
        if (k.k === 'esc') { this.view = 'project'; void this.op(this.load()); }
        else if (k.k === 'up') { if (this.view === 'note') this.noteScroll = Math.max(0, this.noteScroll - 1); else this.fileScroll = Math.max(0, this.fileScroll - 1); }
        else if (k.k === 'down') { if (this.view === 'note') this.noteScroll++; else this.fileScroll++; }
        else if (k.k === 'char' && k.c === 'l' && n) this.pickLinkTarget(n.id);
        else if (k.k === 'char' && k.c === 'd') this.removeSel();
        else if (k.k === 'char' && k.c === 'e' && this.view === 'note' && this.note) { this.editExternal(this.note.path); void store.read(this.note.id, 'note').then((d) => { if (d) this.note = d; this.dirty = true; }); }
        else if (k.k === 'char' && k.c === 'e' && this.view === 'file' && this.file) { this.editExternal(this.file.path); void readFile(this.file.path, 'utf8').then((t) => { this.fileLines = t.split('\n'); this.dirty = true; }); }
        else if (k.k === 'char' && k.c === 'k' && this.view === 'service' && this.service) {
          const s = this.service;
          this.modal = { kind: 'confirm', title: `encerrar ${s.name} (pid ${s.pid})?`, lines: [s.command, 'SIGTERM — o processo decide como parar'], ok: async () => { const ok = svc.stop(s.pid); await this.load(); return ok ? 'sinal enviado' : 'não deu — processo já morto ou sem permissão'; } };
        }
        this.dirty = true; return;
      }
    }
  }

  // ------------------------------------------------------------ desenho
  render() {
    if (this.statusUntil && Date.now() > this.statusUntil) { this.status = ''; this.statusUntil = 0; }
    if (this.grid.W !== this.screen.W || this.grid.H !== this.screen.H) { this.grid = new Grid(this.screen.W, this.screen.H); this.prev = null; this.screen.write('\x1b[2J'); if (this.view === 'agent') this.rebuild(false); }
    this.grid.clear();
    const g = this.grid;
    if (this.screen.W < 60 || this.screen.H < 16) { g.put(1, 1, 'terminal pequeno demais', C.dead); g.put(1, 2, `${this.screen.W}x${this.screen.H} — mínimo 60x16`, C.dim); }
    else if (this.view === 'home') renderHome(g, this.cards, this.homeSel, this.homeScroll, this.status);
    else if (this.view === 'project' && this.pv) renderProject(g, this.pv, this.sel, this.pScroll, this.status, { linkSource: this.linking?.source ?? null, tick: this.pulsing() ? this.tick : -1, panel: this.showPanel });
    else if (this.view === 'diff' && this.diffEv) this.diffTotal = renderDiff(g, this.diffEv, hunksOf(this.diffEv), this.diffScroll, this.status);
    else if (this.view === 'task' && this.task) { const ag = this.node(this.task.agent); renderTask(g, this.task, ag && ag.kind === 'agent' ? ag.name : '?', this.status, this.linksOf(this.task.id)); }
    else if (this.view === 'browser' && this.browser) {
      const fresh = this.pv?.nodes.find((n): n is P.BrowserNode => n.kind === 'browser' && n.id === this.browser!.id); if (fresh) this.browser = fresh;
      const canImg = supportsKittyGraphics(), live = this.page, fr = live?.frame ?? null;
      const refsW = 36, maxCols = Math.max(20, g.W - 4 - refsW - 3), maxRows = Math.max(6, g.H - 8);
      const size = fitImage(fr?.w ?? 1200, fr?.h ?? 800, maxCols, maxRows, this.cellW, this.cellH);
      this.imgBox = canImg ? { x: 2, y: 4, cols: size.cols, rows: size.rows } : null;
      renderBrowser(g, this.browser, { live: live ? { frame: fr, url: live.url, title: live.title, error: live.error, connected: live.connected } : null, box: this.imgBox, typing: this.typing, canImg, booting: this.booting }, this.status, this.linksOf(this.browser.id));
    }
    else if (this.view === 'agent' && this.agent) {
      const w = this.composing ? this.chatInput.window(this.grid.W - 30) : null;
      renderAgent(g, this.agent, this.agent.session, this.evs, this.rowsAll, this.aScroll, this.aCursor, this.status, w ? { text: w.text, cursor: w.cursorAt } : null, this.live, this.chips(), this.panelData());
    }
    else if (this.view === 'note' && this.note) renderNote(g, this.note, this.noteScroll, this.status, this.linksOf(`note-${this.note.id}`));
    else if (this.view === 'file' && this.file) renderFile(g, this.file, this.fileLines, this.fileScroll, this.status, this.linksOf(this.file.id));
    else if (this.view === 'service' && this.service) renderService(g, this.service, this.svcStats, svc.alive(this.service.pid), this.status, this.linksOf(this.service.id));

    if (this.modal?.kind === 'form') renderForm(g, this.modal.form, this.modal.note);
    else if (this.modal?.kind === 'confirm') renderConfirm(g, this.modal.title, this.modal.lines);
    else if (this.modal?.kind === 'pick') renderPick(g, this.modal.title, this.modal.items, this.modal.index, this.modal.note);
    else if (this.inline) {
      const lab = `${this.inline.label} › `; const w = this.inline.input.window(Math.max(8, g.W - lab.length - 26));
      // superfície opaca: apaga o rodapé que estava nessa linha, não só pinta o fundo
      g.panel({ x: 1, y: g.H - 2, w: g.W - 2, h: 1 }, [0x1c, 0x22, 0x2e]);
      g.put(2, g.H - 2, lab, C.link, [0x1c, 0x22, 0x2e]); g.put(2 + lab.length, g.H - 2, w.text, C.inkHi, [0x1c, 0x22, 0x2e]);
      const hint = '↵ confirmar   esc cancelar';
      g.put(g.W - 2 - hint.length, g.H - 2, hint, C.frame, [0x1c, 0x22, 0x2e]);
      g.cursor = { x: 2 + lab.length + w.cursorAt, y: g.H - 2 };
    }
    const wasFull = this.prev === null;
    this.screen.write(g.diff(this.prev)); this.prev = g.snapshot(); this.dirty = false;
    // a página ao vivo vai como imagem de verdade, depois do diff, só quando há frame novo (ou num redesenho completo)
    if (this.view === 'browser' && this.imgBox && this.page?.frame) {
      const fr = this.page.frame, b = this.imgBox, key = `${fr.at}:${b.x}:${b.y}:${b.cols}:${b.rows}`;
      if (key !== this.imgKey || wasFull) {
        const next = this.imgId === 1 ? 2 : 1;
        // desenha o novo e só então apaga o velho: sem piscar
        this.screen.write(placeImage(fr.data, b.x, b.y, b.cols, b.rows, next) + `\x1b_Ga=d,d=i,i=${this.imgId},q=2\x1b\\`);
        this.imgId = next; this.imgKey = key;
      }
    }
  }
  private linksOf(id: string): string[] { return (this.pv?.edges ?? []).filter((e) => e.from === id || e.to === id).map((e) => { const n = this.node(e.from === id ? e.to : e.from); return n ? nodeLabel(n) : '?'; }); }
  private pulsing() { return this.view === 'project' && !this.modal && !!this.pv && this.pv.edges.some((e) => e.kind !== 'talk' || (e.thread && store.threadState(e.thread).state === 'aberta')); }

  quit(): never { this.chat?.stop(); this.screen.restore(); process.exit(0); }
  async run(initial?: P.Project) {
    if (initial) { this.project = initial; this.view = 'project'; }
    await this.load();
    this.screen.enter(() => { this.screen.measure(); this.prev = null; this.dirty = true; });
    this.screen.onKey((k) => this.key(k));
    this.render();
    setInterval(() => { void this.load(); }, 2000);
    setInterval(() => { if (this.pulsing()) { this.tick++; this.dirty = true; } if (this.dirty || this.statusUntil || this.chat?.busy) this.render(); }, 100);
  }
}
