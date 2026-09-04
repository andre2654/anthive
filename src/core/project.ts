/**
 * Projeto = um diretório com um grafo de itens e ligações.
 *
 *   ~/.anthive/projects.json          registro: id, nome, diretório
 *   ~/.anthive/projects/<id>.json     grafo: agentes, arquivos, serviços, ligações
 *
 * Notas ficam no store (com `project`), conversas entre agentes também.
 * Sessões do Claude Code no diretório viram agentes sozinhas — o mapa nasce
 * cheio sem você registrar nada.
 */
import { readFile, writeFile, mkdir, access, realpath } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ROOT, ensure, slugify } from './store.ts';
import * as store from './store.ts';
import { Session, Ev, listSessions, sessionById, parseSession, PROJECTS } from './sessions.ts';
import { Task, tasksOfSession } from './tasks.ts';
import { Subagent, subagentsOfSession } from './subagents.ts';
import { Write, How, Moment, writesOfSession, changedFiles, historyOf, relTo, folderOf } from './written.ts';
import { pending } from './approvals.ts';
import { sessionGone } from './procs.ts';
import { SYSTEM_PREAMBLE, BROWSER_PREAMBLE } from './chat.ts';
import { BrowserMode, freePort, isUp, pages, pickPage, findChrome, launchChrome, waitUp, closeChrome as cdpClose } from './cdp.ts';
import { t } from '../i18n.ts';

export interface Project { id: string; name: string; cwd: string; created: number }

export type ItemKind = 'agent' | 'note' | 'file' | 'service';
export interface AgentItem { kind: 'agent'; id: string; name: string; cwd: string; sessionId: string | null; worktree: string | null; created: number }
export interface FileItem { kind: 'file'; id: string; path: string; label: string; created: number; context?: 'claude' | 'memory' }
export interface ServiceItem { kind: 'service'; id: string; name: string; pid: number; port: number | null; command: string; cwd: string; created: number }
/** O Chrome do projeto: modo (oculto = headless; janela = na tela, sem roubar o foco), porta de depuração fixa, perfil próprio. */
export interface BrowserItem { kind: 'browser'; id: string; name: string; mode: BrowserMode; port: number; headless?: boolean; created: number }
export type StoredItem = AgentItem | FileItem | ServiceItem | BrowserItem;

/** Ligação genérica. Agente↔agente é conversa (store); agente→nota é ACL (store). O resto mora aqui. */
export interface Link { from: string; to: string; created: number }
/** "Always allow" remembered per agent: Bash commands by prefix, other tools by path. */
export interface Rule { agent: string; tool: string; prefix: string; created: number }
export interface Graph { items: StoredItem[]; links: Link[]; rules?: Rule[] }

const REG = () => join(ROOT, 'projects.json');
const GRAPH = (id: string) => join(ROOT, 'projects', `${id}.json`);

export const projectName = (cwd: string, short = false) =>
  cwd.split('/').filter(Boolean).slice(short ? -1 : -2).join('/') || cwd;

// ---------------------------------------------------------------- registro
export async function listProjects(): Promise<Project[]> {
  try { return JSON.parse(await readFile(REG(), 'utf8')); } catch { return []; }
}
async function saveProjects(list: Project[]) {
  await ensure();
  await writeFile(REG(), JSON.stringify(list, null, 2), 'utf8');
}

export async function createProject(name: string, cwd: string): Promise<Project> {
  // Claude Code resolves symlinks before building the transcript slug (/var → /private/var): store the real path so sessions match
  cwd = await realpath(cwd).catch(() => cwd);
  const list = await listProjects();
  const dir = resolve(cwd.replace(/^~(?=\/|$)/, homedir()));
  const existing = list.find((p) => p.cwd === dir);
  if (existing) return existing;
  let id = slugify(name, 32);
  if (list.some((p) => p.id === id)) id = `${id}-${Date.now().toString(36).slice(-4)}`;
  await mkdir(dir, { recursive: true });
  const p: Project = { id, name: name.trim(), cwd: dir, created: Date.now() };
  await saveProjects([...list, p]);
  return p;
}

/** Registra um diretório descoberto pelas sessões, com o nome da pasta. */
export async function ensureProject(cwd: string): Promise<Project> {
  const list = await listProjects();
  const found = list.find((p) => p.cwd === cwd);
  if (found) return found;
  return createProject(projectName(cwd, true), cwd);
}

export interface ProjectCard { project: Project; registered: boolean; sessions: Session[]; running: number; lastMs: number }

/** Tela inicial: projetos registrados + diretórios com sessões recentes. */
export async function homeCards(): Promise<ProjectCard[]> {
  const [reg, sessions] = await Promise.all([listProjects(), listSessions(80)]);
  const byCwd = new Map<string, Session[]>();
  for (const s of sessions) (byCwd.get(s.cwd) ?? byCwd.set(s.cwd, []).get(s.cwd)!).push(s);
  const cards: ProjectCard[] = [];
  const seen = new Set<string>();
  for (const p of reg) {
    const ss = byCwd.get(p.cwd) ?? [];
    seen.add(p.cwd);
    cards.push({ project: p, registered: true, sessions: ss,
      running: ss.filter((s) => s.state === 'running' || s.state === 'waiting').length,
      lastMs: ss.length ? Math.min(...ss.map((s) => s.ageMs)) : Date.now() - p.created });
  }
  for (const [cwd, ss] of byCwd) {
    if (seen.has(cwd)) continue;
    if (!ss.some((s) => s.state !== 'sleeping')) continue;   // só o que acordou na última hora
    cards.push({ project: { id: slugify(projectName(cwd), 32), name: projectName(cwd, true), cwd, created: 0 },
      registered: false, sessions: ss,
      running: ss.filter((s) => s.state === 'running' || s.state === 'waiting').length,
      lastMs: Math.min(...ss.map((s) => s.ageMs)) });
  }
  return cards.sort((a, b) => a.lastMs - b.lastMs);
}

// ---------------------------------------------------------------- grafo
export async function loadGraph(id: string): Promise<Graph> {
  try { return JSON.parse(await readFile(GRAPH(id), 'utf8')); } catch { return { items: [], links: [] }; }
}
export async function addRule(pid: string, rule: Omit<Rule, 'created'>) {
  const g = await loadGraph(pid);
  g.rules ??= [];
  if (!g.rules.some((r) => r.agent === rule.agent && r.tool === rule.tool && r.prefix === rule.prefix)) g.rules.push({ ...rule, created: Date.now() });
  await saveGraph(pid, g);
}
/** The remembered rules of an agent as Claude Code allow patterns, for the process allowlist. */
export const rulesFor = (g: Graph, agent: string): string[] => (g.rules ?? []).filter((r) => r.agent === agent && r.tool === 'Bash' && r.prefix).map((r) => `${r.tool}(${r.prefix}:*)`);
export async function removeRules(pid: string, agent: string, tool?: string) {
  const g = await loadGraph(pid);
  g.rules = (g.rules ?? []).filter((r) => !(r.agent === agent && (tool === undefined || r.tool === tool)));
  await saveGraph(pid, g);
}

export async function saveGraph(id: string, g: Graph) {
  await mkdir(join(ROOT, 'projects'), { recursive: true });
  await writeFile(GRAPH(id), JSON.stringify(g, null, 2), 'utf8');
}

const uid = () => Math.random().toString(36).slice(2, 8);

export async function addFile(pid: string, path: string): Promise<FileItem> {
  const g = await loadGraph(pid);
  const abs = resolve(path.replace(/^~(?=\/|$)/, homedir()));
  const found = g.items.find((i): i is FileItem => i.kind === 'file' && i.path === abs);
  if (found) return found;
  await access(abs);   // tem que existir
  const it: FileItem = { kind: 'file', id: `f-${uid()}`, path: abs, label: basename(abs), created: Date.now() };
  g.items.push(it); await saveGraph(pid, g); return it;
}

export async function addService(pid: string, svc: Omit<ServiceItem, 'kind' | 'id' | 'created'>): Promise<ServiceItem> {
  const g = await loadGraph(pid);
  const found = g.items.find((i): i is ServiceItem => i.kind === 'service' && i.pid === svc.pid);
  if (found) return found;
  const it: ServiceItem = { kind: 'service', id: `s-${uid()}`, created: Date.now(), ...svc };
  g.items.push(it); await saveGraph(pid, g); return it;
}

export async function removeItem(pid: string, id: string) {
  const g = await loadGraph(pid);
  g.items = g.items.filter((i) => i.id !== id);
  g.links = g.links.filter((l) => l.from !== id && l.to !== id);
  await saveGraph(pid, g);
}

export async function link(pid: string, from: string, to: string) {
  const g = await loadGraph(pid);
  if (!g.links.some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from))) {
    g.links.push({ from, to, created: Date.now() });
    await saveGraph(pid, g);
  }
}
export async function unlink(pid: string, a: string, b: string) {
  const g = await loadGraph(pid);
  g.links = g.links.filter((l) => !((l.from === a && l.to === b) || (l.from === b && l.to === a)));
  await saveGraph(pid, g);
}

// ---------------------------------------------------------------- contexto de ambiente
/** Como o Claude Code nomeia o diretório de um projeto em ~/.claude/projects (symlinks resolvidos). */
export async function claudeSlug(cwd: string): Promise<string> {
  const real = await realpath(cwd).catch(() => cwd);
  return real.replace(/\//g, '-');
}

/**
 * O contexto de ambiente que o Claude já usa: CLAUDE.md do projeto (o que o
 * /init gera) e o índice da memória automática. São nós de arquivo descobertos
 * sozinhos e ligados a todo agente — ninguém precisa criar à mão.
 */
export async function contextFiles(cwd: string): Promise<FileItem[]> {
  const out: FileItem[] = [];
  const add = async (path: string, context: 'claude' | 'memory', label: string) => {
    try { await access(path); out.push({ kind: 'file', id: `ctx-${context}`, path, label, created: 0, context }); } catch {}
  };
  await add(join(cwd, 'CLAUDE.md'), 'claude', 'CLAUDE.md');
  if (!out.length) await add(join(cwd, '.claude', 'CLAUDE.md'), 'claude', '.claude/CLAUDE.md');
  await add(join(PROJECTS, await claudeSlug(cwd), 'memory', 'MEMORY.md'), 'memory', 'MEMORY.md');
  return out;
}
export const hasClaudeMd = async (cwd: string) => (await contextFiles(cwd)).some((f) => f.context === 'claude');

// ---------------------------------------------------------------- barramento no projeto
/**
 * O Claude Code carrega o `.mcp.json` do diretório onde a sessão roda — em modo
 * -p também, sem flag (verificado). Então antes de subir um chat ou o primeiro
 * turno de um agente, o barramento do anthive entra ali. Só acrescenta a
 * entrada `anthive`; o que já existir no arquivo fica como está.
 */
export async function ensureBus(cwd: string): Promise<'new' | 'updated' | 'unchanged'> {
  const file = join(cwd, '.mcp.json');
  const compiled = import.meta.dir.startsWith('/$bunfs');
  const entry = { command: process.execPath, args: compiled ? ['mcp'] : [resolve(import.meta.dir, '..', 'index.ts'), 'mcp'], env: { ANTHIVE_HOME: ROOT } };
  let cfg: any = null;
  try { cfg = JSON.parse(await readFile(file, 'utf8')); } catch {}
  const had = cfg !== null;
  cfg ??= {}; cfg.mcpServers ??= {};
  const cur = cfg.mcpServers.anthive;
  if (cur && cur.command === entry.command && JSON.stringify(cur.args) === JSON.stringify(entry.args)) return 'unchanged';
  cfg.mcpServers.anthive = entry;
  delete cfg.mcpServers.terminai;   // the bus's old name, from before the rename
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return had ? 'updated' : 'new';
}

// ---------------------------------------------------------------- browser
/** O servidor Playwright MCP no .mcp.json do diretório — o agente ligado ao browser recebe as ferramentas browser_*. */
export async function ensureBrowserServer(cwd: string, port: number): Promise<'new' | 'updated' | 'unchanged'> {
  const file = join(cwd, '.mcp.json');
  // o Playwright grava snapshots e screenshots em .playwright-mcp/ dentro do cwd: fica fora do git sem mexer no .gitignore do projeto
  try {
    const ex = join(cwd, '.git', 'info', 'exclude'); const exCur = await readFile(ex, 'utf8').catch(() => null);
    if (exCur !== null && !exCur.includes('.playwright-mcp/')) await writeFile(ex, exCur + (exCur === '' || exCur.endsWith('\n') ? '' : '\n') + '.playwright-mcp/\n', 'utf8');
  } catch {}
  // o Playwright não abre browser nenhum: liga no Chrome do anthive pela porta de depuração
  const entry = { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--cdp-endpoint', `http://127.0.0.1:${port}`] };
  let cfg: any = null;
  try { cfg = JSON.parse(await readFile(file, 'utf8')); } catch {}
  const had = cfg !== null;
  cfg ??= {}; cfg.mcpServers ??= {};
  const cur = cfg.mcpServers.playwright;
  if (cur && JSON.stringify(cur.args) === JSON.stringify(entry.args)) return 'unchanged';
  cfg.mcpServers.playwright = entry;
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return had ? 'updated' : 'new';
}

export async function addBrowser(p: Project, mode: BrowserMode): Promise<BrowserItem> {
  const g = await loadGraph(p.id);
  const found = g.items.find((i): i is BrowserItem => i.kind === 'browser');
  if (found) {
    await settleBrowser(found);
    if (found.mode !== mode) { if (await isUp(found.port)) await cdpClose(found.port); found.mode = mode; }
    await saveGraph(p.id, g); await ensureBrowserServer(p.cwd, found.port); return found;
  }
  const it: BrowserItem = { kind: 'browser', id: `b-${uid()}`, name: 'browser', mode, port: await freePort(), created: Date.now() };
  g.items.push(it); await saveGraph(p.id, g);
  await ensureBrowserServer(p.cwd, it.port);
  return it;
}

/** Item antigo (só `headless`) ganha modo e porta. */
export async function settleBrowser(it: BrowserItem): Promise<boolean> {
  const before = `${it.mode}:${it.port}`;
  const m = it.mode as string;
  if (!it.mode || m === 'oculto') it.mode = 'hidden';   // items from before the rename (or with no mode) start hidden; `o` opens the window
  else if (m === 'janela') it.mode = 'window';
  if (!it.port) it.port = await freePort();
  return before !== `${it.mode}:${it.port}`;
}
export const browserProfile = (it: BrowserItem) => join(ROOT, 'browsers', it.id);

/** Sobe o Chrome deste browser se não estiver de pé. */
export async function ensureBrowserUp(it: BrowserItem): Promise<'was up' | 'started'> {
  if (await isUp(it.port)) return 'was up';
  const chrome = await findChrome();
  if (!chrome) throw new Error(t('no Chrome on this machine (Google Chrome, or `npx playwright install chromium`)'));
  await launchChrome(chrome, browserProfile(it), it.port, it.mode);
  if (!(await waitUp(it.port))) throw new Error(t('{0} did not answer on port {1}', chrome.name, it.port));
  return 'started';
}
/** Troca oculto ⇄ janela: fecha, grava, sobe de novo com o mesmo perfil (o Playwright do agente reconecta sozinho). */
export async function setBrowserMode(pid: string, it: BrowserItem, mode: BrowserMode) {
  if (await isUp(it.port)) await cdpClose(it.port);
  const g = await loadGraph(pid);
  const cur = g.items.find((i): i is BrowserItem => i.kind === 'browser' && i.id === it.id);
  if (cur) { cur.mode = mode; await saveGraph(pid, g); }
  it.mode = mode;
  await ensureBrowserUp(it);
}
export const closeBrowser = (it: BrowserItem) => cdpClose(it.port);
export const pagesOf = (it: BrowserItem) => pages(it.port);

/** O browser ligado a um agente, se houver. */
export async function browserOf(pid: string, agentId: string): Promise<BrowserItem | null> {
  const g = await loadGraph(pid);
  const ids = g.links.filter((l) => l.from === agentId || l.to === agentId).map((l) => (l.from === agentId ? l.to : l.from));
  const it = g.items.find((i): i is BrowserItem => i.kind === 'browser' && ids.includes(i.id)) ?? null;
  if (it) await settleBrowser(it);
  return it;
}

/** O agente está ligado a um browser do projeto? Decide as ferramentas autorizadas e a instrução. */
export async function agentHasBrowser(pid: string, agentId: string): Promise<boolean> { return !!(await browserOf(pid, agentId)); }

// ---------------------------------------------------------------- agentes
async function sh(cmd: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  return { ok: (await p.exited) === 0, out: (out + err).trim() };
}
export const isRepo = async (cwd: string) => (await sh(['git', 'rev-parse', '--show-toplevel'], cwd)).ok;

async function makeWorktree(repo: string, branch: string): Promise<string> {
  const root = (await sh(['git', 'rev-parse', '--show-toplevel'], repo)).out || repo;
  const path = join(root, '..', `${basename(root)}--${branch.replace(/\//g, '-')}`);
  try { await access(path); return path; } catch {}
  let r = await sh(['git', 'worktree', 'add', '-b', branch, path], root);
  if (!r.ok) r = await sh(['git', 'worktree', 'add', path, branch], root);
  if (!r.ok) throw new Error(t('git worktree failed: {0}', r.out.split('\n')[0] ?? ''));
  return path;
}

/**
 * Agente novo = sessão reservada com id próprio. Nada roda aqui; o primeiro
 * turno acontece no chat (com --session-id) ou por `firstTurn` em segundo plano.
 */
export async function addAgent(p: Project, name: string, opts: { worktree?: string } = {}): Promise<AgentItem> {
  const g = await loadGraph(p.id);
  const nm = slugify(name, 24);
  if (g.items.some((i) => i.kind === 'agent' && i.name === nm)) throw new Error(t('an agent named "{0}" already exists in this project', nm));
  let cwd = p.cwd, worktree: string | null = null;
  if (opts.worktree) {
    if (!(await isRepo(p.cwd))) throw new Error(t('{0} is not a git repository — without a worktree the agent uses the directory directly', projectName(p.cwd)));
    cwd = await makeWorktree(p.cwd, opts.worktree); worktree = opts.worktree;
  }
  const it: AgentItem = { kind: 'agent', id: `a-${uid()}`, name: nm, cwd, sessionId: crypto.randomUUID(), worktree, created: Date.now() };
  g.items.push(it); await saveGraph(p.id, g); return it;
}

/**
 * O que o primeiro turno executa. Sem CLAUDE.md, a sessão do agente roda o
 * próprio /init do Claude Code primeiro — verificado em modo -p — e só então o
 * briefing, já com --resume. Função pura para o teste conferir a composição.
 */
export function firstTurnPlan(a: AgentItem, prompt: string, needsInit: boolean, browser = false): string[][] {
  // --allowedTools é variádico: fica ANTES de --session-id/--resume, que encerram a lista; o prompt vem sempre por último
  const base = ['claude', '-p', '--append-system-prompt', browser ? `${SYSTEM_PREAMBLE} ${BROWSER_PREAMBLE}` : SYSTEM_PREAMBLE, '--allowedTools', 'mcp__anthive', ...(browser ? ['mcp__playwright'] : []), '--permission-prompt-tool', 'mcp__anthive__permission_prompt'];
  if (!needsInit) return [[...base, '--session-id', a.sessionId!, prompt]];
  return [
    [...base, '--session-id', a.sessionId!, '--permission-mode', 'acceptEdits', '/init'],
    [...base, '--resume', a.sessionId!, prompt],
  ];
}

/** Dispara o primeiro turno em segundo plano; devolve o pid do encadeamento. */
export async function firstTurn(a: AgentItem, prompt: string, browser = false): Promise<number> {
  const env = { ...process.env as Record<string, string>, ANTHIVE_HOME: ROOT, ANTHIVE_AGENT: a.name };
  const plan = firstTurnPlan(a, prompt, !(await hasClaudeMd(a.cwd)), browser);
  // um só processo de shell encadeia os passos; o prompt vai por variável para não brigar com aspas
  const script = plan.map((argv, i) => argv.map((x, j) => (j === argv.length - 1 && i === plan.length - 1) ? '"$ANTHIVE_PROMPT"' : JSON.stringify(x)).join(' ')).join(' && ');
  const p = Bun.spawn(['sh', '-c', script], { cwd: a.cwd, env: { ...env, ANTHIVE_PROMPT: prompt }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  p.unref();
  return p.pid;
}

/** Gera o CLAUDE.md de um projeto com o /init do Claude Code, numa sessão nova, em segundo plano. */
export function generateClaudeMd(cwd: string): number {
  const p = Bun.spawn(['claude', '-p', '--permission-mode', 'acceptEdits', '/init'], { cwd, env: { ...process.env as Record<string, string>, ANTHIVE_HOME: ROOT }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  p.unref();
  return p.pid;
}

// ---------------------------------------------------------------- a vista de um projeto
export interface AgentNode { kind: 'agent'; id: string; name: string; item: AgentItem | null; session: Session | null; cwd: string }
export interface NoteNode { kind: 'note'; id: string; doc: store.Doc }
export interface FileNode { kind: 'file'; id: string; item: FileItem; exists: boolean; lines?: number }
export interface ServiceNode { kind: 'service'; id: string; item: ServiceItem; alive: boolean }
export interface TaskNode { kind: 'task'; id: string; task: Task; agent: string }   // agent = id do nó do agente
export interface SubNode { kind: 'sub'; id: string; sub: Subagent; agent: string }   // a subagent of the last turn of that agent
/** Um arquivo que saiu do trabalho: escrito por ferramenta, pelo shell, ou só visto no disco. */
export interface WroteNode { kind: 'wrote'; id: string; label: string; path: string; how: How; count: number; ts: number; agent: string | null; group: string[] }
export interface BrowserState { url: string; title: string; snapshot: string; console: string; image?: { media: string; data: string }; lastTool?: string; counts?: string; busy: boolean; live?: boolean }
export interface BrowserNode { kind: 'browser'; id: string; item: BrowserItem; state: BrowserState }
export type Node = AgentNode | NoteNode | FileNode | ServiceNode | TaskNode | SubNode | WroteNode | BrowserNode;

export interface Edge { from: string; to: string; kind: 'talk' | 'context' | 'assoc' | 'task' | 'sub' | 'wrote'; thread?: store.Doc }
export interface View { project: Project; nodes: Node[]; edges: Edge[]; moments?: Moment[] }   // moments = a história recente, quando cabe na tela

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function view(p: Project): Promise<View> {
  const [g, sessions, docs] = await Promise.all([loadGraph(p.id), listSessions(80), store.list()]);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const claimed = new Set<string>();

  // agentes registrados (com sessão pelo id) e sessões do diretório que ninguém reclamou
  for (const it of g.items) {
    if (it.kind !== 'agent') continue;
    let s: Session | null = it.sessionId ? sessions.find((x) => x.path.endsWith(`/${it.sessionId}.jsonl`)) ?? null : null;
    if (!s && it.sessionId) s = await sessionById(it.sessionId);
    if (s) claimed.add(s.path);
    nodes.push({ kind: 'agent', id: it.id, name: it.name, item: it, session: s, cwd: it.cwd });
  }
  const inDir = sessions.filter((s) => (s.cwd === p.cwd || s.cwd.startsWith(p.cwd + '/')) && !claimed.has(s.path) && s.state !== 'sleeping');
  for (const s of inDir) nodes.push({ kind: 'agent', id: `sess-${s.id}`, name: s.id, item: null, session: s, cwd: s.cwd });

  for (const d of docs) {
    if (d.kind === 'note' && d.project === p.id && !store.isExpired(d)) nodes.push({ kind: 'note', id: `note-${d.id}`, doc: d });
  }
  // tarefas do próprio Claude Code, por agente: as abertas e as últimas concluídas
  for (const a of nodes.filter((n): n is AgentNode => n.kind === 'agent')) {
    if (!a.session) continue;
    const all = await tasksOfSession(a.session.path, a.session.bytes);
    const open = all.filter((t) => t.status !== 'completed'), done = all.filter((t) => t.status === 'completed').slice(-2);
    for (const t of [...open, ...done]) {
      const id = `task-${a.id}-${t.id}`;
      nodes.push({ kind: 'task', id, task: t, agent: a.id });
      edges.push({ from: a.id, to: id, kind: 'task' });
    }
  }
  // subagents of the last turn, per agent: what the Agent tool is running right now, read from the
  // files Claude Code keeps for each one. A pending permission request is the only "approval" state.
  const waiting = new Set((await pending(p.id).catch(() => [])).map((r) => r.agent));
  for (const a of nodes.filter((n): n is AgentNode => n.kind === 'agent')) {
    if (!a.session) continue;
    if (waiting.has(a.name)) a.session = { ...a.session, state: 'waiting' };
    else if (a.session.state === 'running' && await sessionGone(basename(a.session.path, '.jsonl'))) {
      // nothing holds this session: a tool with no result means the turn was cut, not that it is working
      a.session = { ...a.session, state: a.session.pendingTool ? 'stuck' : 'idle' };
    }
    const subs = await subagentsOfSession(a.session.path, a.session.bytes).catch(() => [] as Subagent[]);
    const live = subs.filter((s) => !s.done && !s.silent && !s.orphan);
    if (!live.length && a.session.ageMs > 3600_000 && !subs.some((s) => !s.done)) continue;   // an old, finished turn: its subagents are history
    for (const s of subs) { const id = `sub-${s.id}`; nodes.push({ kind: 'sub', id, sub: s, agent: a.id }); edges.push({ from: a.id, to: id, kind: 'sub' }); }
    if (live.length && a.session.state !== 'waiting') {
      // the parent's transcript sleeps while its subagents work: their files say how alive it is
      const age = Math.min(a.session.ageMs, ...live.map((s) => s.ageMs));
      a.session = { ...a.session, ageMs: age, state: age < 600_000 ? 'running' : a.session.state, lastText: `${live.length} subagent${live.length > 1 ? 's' : ''}: ${live.map((s) => s.name).join(', ')}` };
    }
  }
  // browser: o estado vem do que os agentes ligados fizeram com as ferramentas browser_*
  for (const it of g.items) {
    if (it.kind !== 'browser') continue;
    const st: BrowserState = { url: '', title: '', snapshot: '', console: '', busy: false };
    const linked = g.links.filter((l) => l.from === it.id || l.to === it.id).map((l) => (l.from === it.id ? l.to : l.from));
    for (const a of nodes.filter((n): n is AgentNode => n.kind === 'agent' && linked.includes(n.id) && !!n.session)) {
      const evs = await parseSession(a.session!.path);
      Object.assign(st, browserStateFrom(evs, st));
    }
    if (await settleBrowser(it)) await saveGraph(p.id, g);
    // com o Chrome de pé, url e título vêm dele, ao vivo; o resto (snapshot, última ferramenta) segue vindo do transcript
    const livePage = pickPage(await pages(it.port));
    if (livePage) { st.live = true; st.url = livePage.url; st.title = livePage.title; }
    nodes.push({ kind: 'browser', id: it.id, item: it, state: st });
  }
  const ctx = await contextFiles(p.cwd);
  for (const f of ctx) {
    const lines = await readFile(f.path, 'utf8').then((t) => t.replace(/\n$/, '').split('\n').length, () => 0);   // quebra final não é linha
    nodes.push({ kind: 'file', id: f.id, item: f, exists: true, lines });
  }
  for (const it of g.items) {
    if (it.kind === 'file') nodes.push({ kind: 'file', id: it.id, item: it, exists: await access(it.path).then(() => true, () => false) });
    if (it.kind === 'service') nodes.push({ kind: 'service', id: it.id, item: it, alive: alive(it.pid) });
  }

  // o trabalho: arquivos que os agentes produziram, dos transcripts e do disco.
  // Uma pasta é um nó só, com o dono de quem mais escreveu nela; passa a ser
  // arquivo por arquivo quando o projeto todo produziu cinco ou menos.
  const onMap = new Set<string>(nodes.filter((n): n is FileNode => n.kind === 'file').map((n) => n.item.path));
  const work = new Map<string, Write & { agent: string | null }>();
  let oldest = Date.now();
  for (const a of nodes.filter((n): n is AgentNode => n.kind === 'agent')) {
    if (!a.session) continue;
    oldest = Math.min(oldest, a.session.started || a.session.mtime);
    for (const w of await writesOfSession(a.session.path, a.session.bytes, a.name, [p.cwd, a.cwd]).catch(() => [] as Write[])) {
      if (onMap.has(w.path)) continue;
      const cur = work.get(w.path);
      if (!cur) work.set(w.path, { ...w, agent: a.id });
      else { cur.count += w.count; cur.ts = Math.max(cur.ts, w.ts); }
    }
  }
  // o que só o disco sabe: uma planilha gerada por um script que o agente rodou
  for (const f of await changedFiles(p.cwd, oldest).catch(() => [])) {
    if (onMap.has(f.path) || work.has(f.path)) continue;
    work.set(f.path, { path: f.path, how: 'seen', count: 1, ts: f.ts, by: '', agent: null });
  }
  const all = [...work.values()].sort((x, y) => y.ts - x.ts);
  const wrote: WroteNode[] = [];
  if (all.length && all.length <= 5) {
    for (const w of all) wrote.push({ kind: 'wrote', id: `wrote-${relTo(p.cwd, w.path)}`, label: relTo(p.cwd, w.path), path: w.path, how: w.how, count: w.count, ts: w.ts, agent: w.agent, group: [] });
  } else {
    const dirs = new Map<string, (Write & { agent: string | null })[]>();
    for (const w of all) { const d = folderOf(p.cwd, w.path); const list = dirs.get(d); if (list) list.push(w); else dirs.set(d, [w]); }
    for (const [dir, ws] of dirs) {
      const votes = new Map<string, number>();
      for (const w of ws) if (w.agent) votes.set(w.agent, (votes.get(w.agent) ?? 0) + 1);
      const owner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      wrote.push({
        kind: 'wrote', id: `wrote-dir-${dir}`, label: dir === '.' ? `${p.name}/` : `${dir}/`, path: dir === '.' ? p.cwd : join(p.cwd, dir),
        how: ws.some((w) => w.how === 'tool') ? 'tool' : ws.some((w) => w.how === 'shell') ? 'shell' : 'seen',
        count: ws.reduce((n, w) => n + w.count, 0), ts: Math.max(...ws.map((w) => w.ts)), agent: owner,
        group: ws.map((w) => basename(w.path)),
      });
    }
  }
  for (const n of wrote.sort((x, y) => y.ts - x.ts).slice(0, 8)) {
    nodes.push(n);
    if (n.agent) edges.push({ from: n.agent, to: n.id, kind: 'wrote' });
  }

  // ligações: conversas (store), acesso a nota (ACL), e as genéricas do grafo
  const agentByName = new Map(nodes.filter((n): n is AgentNode => n.kind === 'agent').map((n) => [n.name, n]));
  for (const d of docs) {
    if (d.kind === 'thread' || store.isExpired(d)) { if (d.kind !== 'thread') continue; }
    if (d.kind === 'thread') {
      const [a, b] = d.acl; const na = a && agentByName.get(a), nb = b && agentByName.get(b);
      if (na && nb) edges.push({ from: na.id, to: nb.id, kind: 'talk', thread: d });
      continue;
    }
    if (d.kind === 'note' && d.project === p.id) {
      for (const who of d.acl) { const n = agentByName.get(who); if (n) edges.push({ from: n.id, to: `note-${d.id}`, kind: 'context' }); }
    }
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const l of g.links) if (ids.has(l.from) && ids.has(l.to)) edges.push({ from: l.from, to: l.to, kind: nodes.find((n) => n.id === l.from)?.kind === 'agent' ? 'context' : 'assoc' });
  // o Claude lê CLAUDE.md e a memória em toda sessão: todo agente está ligado a eles
  for (const f of ctx) for (const a of nodes) if (a.kind === 'agent') edges.push({ from: a.id, to: f.id, kind: 'context' });
  // a história recente: os turnos, os subagentes e as escritas, de todos os agentes juntos
  const live = nodes.filter((n): n is AgentNode => n.kind === 'agent' && !!n.session)
    .map((a) => ({ name: a.name, path: a.session!.path, size: a.session!.bytes, cwd: [p.cwd, a.cwd] }));
  const moments = live.length ? await historyOf(live, 40).catch(() => []) : [];
  return { project: p, nodes, edges, moments };
}

// ---------------------------------------------------------------- briefing
/**
 * O agente novo recebe o mapa do projeto e a instrução de como usar cada
 * relação. Ele decide com o que se liga — responde `ligar: a, b` na primeira
 * linha — e o anthive aplica quando o turno termina.
 */
export function buildBriefing(v: View, agentName: string, prompt: string): string {
  const home = homedir();
  const agents = v.nodes.filter((n): n is AgentNode => n.kind === 'agent' && n.name !== agentName);
  const notes = v.nodes.filter((n): n is NoteNode => n.kind === 'note');
  const files = v.nodes.filter((n): n is FileNode => n.kind === 'file');
  const svcs = v.nodes.filter((n): n is ServiceNode => n.kind === 'service');
  const nameOf = (id: string) => { const n = v.nodes.find((x) => x.id === id); return !n ? id : n.kind === 'agent' ? n.name : n.kind === 'note' ? n.doc.title : n.kind === 'file' ? n.item.label : n.kind === 'task' ? n.task.subject : n.kind === 'sub' ? n.sub.name : n.kind === 'wrote' ? n.label : n.item.name; };
  const ctx = files.filter((f) => f.item.context);
  const ctxLine = ctx.length
    ? `Environment context: ${ctx.map((f) => `${f.item.label} (${f.lines ?? '?'} lines)`).join(' and ')} — read it first; it describes how this project runs, tests and is organized.`
    : 'This project had no CLAUDE.md: one was just generated by /init in your session. Read it before anything else; if it is incomplete, complete it — it stays linked to you and to every agent here.';
  const lines: string[] = [
    `You are agent "${agentName}" of project "${v.project.name}", in ${v.project.cwd.replace(home, '~')}.`,
    ctxLine,
    'The project currently has:',
    ...(agents.length ? [`- agents: ${agents.map((a) => `${a.name} (${a.session ? a.session.state : 'no session'}${a.item?.worktree ? `, ${a.item.worktree}` : ''})`).join('; ')}`] : ['- agents: none besides you']),
    ...(notes.length ? [`- notes: ${notes.map((n) => `${n.doc.title} (${n.doc.ttl ? 'ephemeral' : 'persistent'}${n.doc.acl.length ? `; read by: ${n.doc.acl.join(', ')}` : ''})`).join('; ')}`] : ['- notes: none']),
    ...(files.filter((f) => !f.item.context).length ? [`- files: ${files.filter((f) => !f.item.context).map((f) => f.item.path.replace(home, '~')).join('; ')}`] : ['- files: none besides the context']),
    ...(svcs.length ? [`- live services on this machine: ${svcs.map((s) => `${s.item.name}${s.item.port ? ` on port ${s.item.port}` : ''} (pid ${s.item.pid}${s.alive ? '' : ', dead'})`).join('; ')}`] : ['- services: none']),
    ...(v.edges.length ? [`Current relations: ${v.edges.map((e) => `${nameOf(e.from)} ${e.kind === 'talk' ? '⇄' : '→'} ${nameOf(e.to)}${e.thread?.goal ? ` ("${e.thread.goal}")` : ''}`).join('; ')}.`] : ['Current relations: none.']),
    'How to use the relations: notes are read with the note_read tool of the anthive bus (MCP) once linked to you; to talk to another agent use send_message with a clear goal; linked files are at the paths above; services are live processes on the ports listed.',
    'Before anything else, decide what is worth linking to for context. Reply FIRST with a single line in exactly this format:',
    'link: name1, name2',
    '(use the names above; write "link: nothing" if nothing makes sense). Only then handle the request.',
    '',
    `Request: ${prompt}`,
  ];
  return lines.join('\n');
}

/** Lê "ligar: a, b" da resposta e devolve os ids dos nós que batem. */
export function parseBriefingReply(v: View, text: string): string[] {
  const m = /^\s*(?:link|ligar):\s*(.+)$/im.exec(text);   // `ligar:` is the old (Portuguese) form, still accepted
  if (!m) return [];
  const wanted = m[1]!.split(/[,;]/).map((s) => s.trim().toLowerCase()).filter((s) => s && s !== 'nothing' && s !== 'none' && s !== 'nada');
  const ids: string[] = [];
  for (const n of v.nodes) {
    if (n.kind === 'task' || n.kind === 'sub' || n.kind === 'wrote') continue;
    const label = (n.kind === 'agent' ? n.name : n.kind === 'note' ? n.doc.title : n.kind === 'file' ? n.item.label : n.item.name).toLowerCase();
    const alt = n.kind === 'note' ? n.doc.id.toLowerCase() : n.kind === 'file' ? n.item.path.toLowerCase() : '';
    if (wanted.some((w) => w === label || w === alt || label.includes(w) || alt.endsWith(w))) ids.push(n.id);
  }
  return ids;
}

/** Lê, dos eventos de um agente, a última página, o último snapshot, o console e a última captura. */
/** As ferramentas do Playwright chegam no transcript como mcp__playwright__browser_x; aqui é só browser_x. */
export function browserTool(name?: string | null): string | null {
  if (!name) return null;
  const t = name.replace(/^mcp__playwright__/, '');
  return t.startsWith('browser_') ? t : null;
}

export function browserStateFrom(evs: Ev[], base: BrowserState): BrowserState {
  const st = { ...base };
  // o evento da chamada não guarda o id do bloco tool_use; o transcript grava os resultados na ordem das chamadas,
  // então cada chamada (de qualquer ferramenta) consome o próximo resultado ainda não reclamado
  const used = new Set<number>();
  const resultAfter = (i: number): Ev | undefined => {
    for (let j = i + 1; j < evs.length; j++) { const r = evs[j]!; if (r.resultFor && !used.has(j)) { used.add(j); return r; } }
    return undefined;
  };
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]!;
    if (!e.tool) continue;
    const res = resultAfter(i);
    const tool = browserTool(e.tool); if (!tool) continue;
    st.lastTool = tool;
    if (tool === 'browser_navigate' && e.input?.url) st.url = String(e.input.url);
    const text = res?.result ?? '';
    const mUrl = /Page URL:\s*(\S+)/i.exec(text), mTitle = /Page Title:\s*(.+)/i.exec(text);
    if (mUrl) st.url = mUrl[1]!;
    if (mTitle) st.title = mTitle[1]!.trim();
    const mC = /Console:\s*(\d+) errors?,\s*(\d+) warnings?/i.exec(text);
    if (mC) st.counts = t('{0} errors · {1} warnings', mC[1]!, mC[2]!);
    if (tool === 'browser_snapshot' && text) st.snapshot = text;
    if (tool === 'browser_console_messages' && text) st.console = text;
    if (tool === 'browser_take_screenshot' && res?.image) st.image = res.image;
    st.busy = !res;
  }
  return st;
}
