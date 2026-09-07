/**
 * A tela do projeto: agentes à esquerda, contexto à direita, relações no meio.
 *
 * Cada ligação sai do agente, atravessa a calha numa faixa própria e entra no
 * item com uma seta. Conversa entre agentes é traço grosso com o turno.
 * O pulso corre do agente para o que ele está ligado.
 */
import { Grid, Rect } from '../tui/grid.ts';
import { browserShort, snapshotRefs, modeLabel } from './item.ts';
import { t } from '../i18n.ts';
export { snapshotRefs };
import { C, G, BG, RGB, sparkline, ago, tok, pad, padStart, fit } from '../tui/theme.ts';
import { State, windowOf } from '../core/sessions.ts';
import { View, Node, Edge, AgentNode, TaskNode, projectName, SubNode, WroteNode, NoteNode } from '../core/project.ts';
import { threadState } from '../core/store.ts';
import { relTo } from '../core/written.ts';
import { windowOf as winOf } from '../core/sessions.ts';
import { renderMd } from '../tui/markdown.ts';
import { gauge } from '../tui/theme.ts';
import { keybar, scrollHint } from './chrome.ts';

export const AGENT_H = 6, AGENT_TALL = 8;   // a caixa: estado, branch, conversas e ligações, sparkline; alta ganha ferramentas e tarefas
export const NOTE_H = 4, FILE_H = 3, SERVICE_H = 4;   // alturas antigas, ainda lidas por quem mede a tela
/** A altura da caixa de agente: cresce quando há poucos agentes e a tela comporta. */
export function agentH(v: View, H: number): number {
  const agents = v.nodes.filter((n) => n.kind === 'agent').length;
  if (!agents || agents > 3) return AGENT_H;
  const subs = v.nodes.filter((n) => n.kind === 'sub').length;
  return agents * (AGENT_TALL + 1) + subs * 3 <= H - 8 ? AGENT_TALL : AGENT_H;
}
/** A largura da coluna dos agentes: o suficiente para a frase do que eles estão fazendo. */
function agentW(v: View, room: number): number {
  let want = 34;   // o piso antigo: a caixa cresce a partir dele, nunca abaixo
  for (const n of v.nodes) {
    if (n.kind !== 'agent') continue;
    const doing = n.session?.lastText.replace(/^(\w+ )?cd \S+\s*(&&\s*)?/, '$1') ?? '';
    want = Math.max(want, [...n.name].length + 8, Math.min(60, [...doing].length + 5));
    for (const r of v.nodes) if (r.kind === 'sub' && r.agent === n.id) want = Math.max(want, Math.min(60, [...r.sub.name].length + 9));
  }
  return Math.max(24, Math.min(60, want, room));
}

const GLYPH: Record<State, string> = { running: G.running, waiting: G.waiting, idle: G.idle, stuck: G.stuck, sleeping: G.idle };
const COLOR: Record<State, RGB> = { running: C.run, waiting: C.hold, idle: C.idle, stuck: C.dead, sleeping: C.frame };
const LABEL = (s: State) => ({ running: t('running'), waiting: t('approval'), idle: t('idle'), stuck: t('stuck'), sleeping: t('asleep') })[s];
const SPARK: Record<State, RGB> = { running: C.sparkR, waiting: C.sparkH, idle: C.sparkI, stuck: C.sparkD, sleeping: C.sparkI };
const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
export const KIND_GLYPH = { agent: G.running, note: G.note, file: '▤', service: '◎', task: G.focus, sub: G.sub, wrote: '▥', browser: '▣' } as const;
export const PANEL_W = 34;
/** O painel cresce com a tela: em 34 colunas ele corta os próprios valores. */
export const panelW = (W: number) => Math.min(46, Math.max(PANEL_W, Math.floor(W * 0.22)));
export const panelFits = (W: number) => W >= 110;
const SUB_H = 3, SUB_INDENT = 3, GUTTER = 3;

/**
 * O mapa em árvore: nada de fio roteado. À esquerda os agentes, com os
 * subagentes e as notas que só eles leem penduradas embaixo; à direita um
 * razão denso, uma linha por item, em seções. A relação aparece quando você
 * seleciona: o que está ligado ao nó selecionado acende.
 */
export interface Path { cells: [number, number][]; from: string; to: string }
export interface LedgerRow { text: string; meta: string; color: RGB; second?: string }
export interface ProjectLayout {
  boxes: { id: string; rect: Rect; node: Node; row?: LedgerRow; hang?: boolean }[];
  heads: { y: number; title: string }[];
  paths: Path[];
  leftW: number; rightX: number; rightW: number;
  height: number;
}

/** Uma nota de um leitor só pende do leitor; o resto vai para o razão. */
const ownerOf = (n: NoteNode, agents: AgentNode[]): AgentNode | null => (n.doc.acl.length === 1 ? agents.find((a) => a.name === n.doc.acl[0]) ?? null : null);

function ledgerRow(n: Node, v: View, home: string): LedgerRow | null {
  const agents = v.nodes.filter((m): m is AgentNode => m.kind === 'agent');
  if (n.kind === 'note') { const who = n.doc.acl.length > 2 ? `${n.doc.acl.slice(0, 2).join(', ')} +${n.doc.acl.length - 2}` : n.doc.acl.join(', '); return { text: `${G.note} ${n.doc.title}`, meta: `${n.doc.ttl ? t('ephemeral') + ' · ' : ''}${n.doc.acl.length ? t('read by {0}', who) : t('nobody reads it')}`, color: C.link }; }
  if (n.kind === 'task') return { text: `${n.task.status === 'completed' ? G.running : n.task.status === 'in_progress' ? G.focus : G.idle} ${n.task.subject}`, meta: `${n.task.status === 'completed' ? t('done') : n.task.status === 'in_progress' ? t('in progress') : t('pending')}${(() => { const a = agents.find((x) => x.id === n.agent); return a ? ` · ${a.name}` : ''; })()}`, color: n.task.status === 'completed' ? C.run : n.task.status === 'in_progress' ? C.hold : C.dim };
  if (n.kind === 'browser') { const st = n.state; return { text: st.busy ? `${G.running} ${browserShort(st.lastTool ?? 'browser_')}…` : `▣ chrome (${modeLabel(n.item.mode)})${st.live ? ` ${G.running} ${t('live')}` : ''}  ${G.h}  ${st.title || t('no page yet')}`, meta: '', color: st.busy ? C.hold : st.url ? C.run : C.dim, second: st.url || t('link an agent (l) and ask it to browse') }; }
  if (n.kind === 'wrote') { const a = agents.find((x) => x.id === n.agent); return { text: `${n.group.length ? '▦' : '▥'} ${n.label}`, meta: n.group.length ? `${t('{0} files', n.group.length)} · ${a?.name ?? t('seen')}` : `${a?.name ?? t('seen')} · ${ago(Date.now() - n.ts)}`, color: n.how === 'seen' ? C.dim : C.ink }; }
  if (n.kind === 'file') return { text: `${n.item.dir ? '▦' : n.item.context ? '▤' : '▤'} ${n.item.label}${n.item.dir ? '/' : ''}`, meta: n.item.context ? t('context') : n.exists ? n.item.path.slice(0, -n.item.label.length).replace(home, '~') : t('gone'), color: n.exists ? C.ink : C.dead };
  if (n.kind === 'service') return { text: `◎ ${n.item.name}${n.item.port ? `:${n.item.port}` : ''}`, meta: `${n.alive ? t('alive') : t('dead')} · pid ${n.item.pid}`, color: n.alive ? C.run : C.dead };
  return null;
}

export function layoutProject(v: View, W: number, scroll = 0, panel = false, H = 40): ProjectLayout {
  const pw = panel && panelFits(W) ? panelW(W) : 0;
  const avail = W - 4 - pw;
  const home = process.env.HOME ?? '';
  const agents = v.nodes.filter((n): n is AgentNode => n.kind === 'agent');
  const aH = agentH(v, H);
  const leftW = agentW(v, Math.max(24, Math.floor((avail - GUTTER) / 2)));
  const rightX = 2 + leftW + GUTTER;
  const rightW = W - 2 - rightX - pw;
  const boxes: ProjectLayout['boxes'] = [];
  const heads: ProjectLayout['heads'] = [];

  // esquerda: o agente, os subagentes dele, as notas só dele
  const subsOf = (id: string) => v.nodes.filter((n): n is SubNode => n.kind === 'sub' && n.agent === id);
  const notes = v.nodes.filter((n): n is NoteNode => n.kind === 'note');
  const hung = new Set<string>();
  let y = 2 - scroll;
  for (const a of agents) {
    boxes.push({ id: a.id, rect: { x: 2, y, w: leftW, h: aH }, node: a }); y += aH;
    for (const s of subsOf(a.id)) { boxes.push({ id: s.id, rect: { x: 2 + SUB_INDENT, y, w: leftW - SUB_INDENT, h: SUB_H }, node: s }); y += SUB_H; }
    for (const n of notes) if (ownerOf(n, agents)?.id === a.id) { hung.add(n.id); boxes.push({ id: n.id, rect: { x: 2 + SUB_INDENT, y, w: leftW - SUB_INDENT, h: 1 }, node: n, hang: true }); y += 1; }
    y += 1;
  }
  const leftBottom = y;

  // direita: o razão, por seção
  y = 2 - scroll;
  const section = (title: string, items: Node[]) => {
    if (!items.length) return;
    heads.push({ y, title }); y += 1;
    for (const n of items) {
      const row = ledgerRow(n, v, home); if (!row) continue;
      const h = row.second ? 2 : 1;
      boxes.push({ id: n.id, rect: { x: rightX, y, w: rightW, h }, node: n, row }); y += h;
    }
    y += 1;
  };
  const shared = notes.filter((n) => !hung.has(n.id));
  section(`${t('notes')} ${shared.length}`, shared);
  const tasks = v.nodes.filter((n) => n.kind === 'task'); section(`${t('tasks')} ${tasks.length}`, tasks);
  const browsers = v.nodes.filter((n) => n.kind === 'browser'); section('browser', browsers);
  const wrote = v.nodes.filter((n) => n.kind === 'wrote'); section(`${t('produced')} ${wrote.length}`, wrote);
  const files = v.nodes.filter((n) => n.kind === 'file'); section(`${t('files')} ${files.length}`, files);
  const svcs = v.nodes.filter((n) => n.kind === 'service'); section(`${t('services')} ${svcs.length}`, svcs);
  const height = Math.max(leftBottom, y) + scroll;
  return { boxes, heads, paths: [], leftW, rightX, rightW, height };
}

// ---------------------------------------------------------------- caixas
/** O que liga a um nó: os vizinhos pelas arestas, para acender o que importa. */
function neighbours(v: View, id: string | null): Set<string> {
  const out = new Set<string>();
  if (!id) return out;
  for (const e of v.edges) { if (e.from === id) out.add(e.to); else if (e.to === id) out.add(e.from); }
  return out;
}

function agentBox(g: Grid, v: View, n: AgentNode, r: Rect, on: boolean, src: boolean, lit: boolean, tasks: TaskNode[] = []) {
  const s = n.session, inner = r.w - 4;
  const state: State = s ? s.state : 'idle';
  if (on || src) g.fill(r, BG.sel);
  const border = src ? C.hold : on || lit ? C.link : C.frame;
  g.frame(r, `${src ? G.tool + ' ' : ''}${n.name}`, src ? C.hold : on ? C.link : C.inkHi, border);
  g.put(r.x + 2, r.y + 1, pad(`${GLYPH[state]} ${LABEL(state)}`, inner - 7), COLOR[state]);
  g.put(r.x + 2 + inner - 7, r.y + 1, padStart(s ? ago(s.ageMs) : '', 7), C.frame);
  const branch = n.item?.worktree ?? (s?.branch && s.branch !== 'HEAD' ? s.branch : '');
  const doing = s?.lastText.replace(/^(\w+ )?cd \S+\s*(&&\s*)?/, '$1') ?? '';
  const inflight = s?.state === 'running' && s.pendingTool ? `${G.tool} ${s.pendingTool}${s.pendingInput ? ' ' + s.pendingInput : ''}` : '';
  const l2 = s?.state === 'waiting' || s?.state === 'stuck' ? `${G.pause} ${s.pendingTool ?? '?'}` : inflight || doing || (n.item ? t('no session — ↵ opens the chat') : '');
  g.put(r.x + 2, r.y + 2, pad(l2, inner), s?.state === 'waiting' ? C.hold : inflight ? C.dim : doing ? C.ink : C.frame);   // a história do agente, legível
  // conversas com outros agentes e o que está ligado, numa linha: era isso que os fios tentavam dizer
  const talks = v.edges.filter((e) => e.kind === 'talk' && (e.from === n.id || e.to === n.id)).map((e) => {
    const o = v.nodes.find((m) => m.id === (e.from === n.id ? e.to : e.from)); const st = e.thread ? threadState(e.thread) : null;
    const who = o && o.kind === 'agent' ? o.name : '?';
    if (!st) return { text: `${G.swap} ${who}`, color: C.link };
    if (st.state === 'concluded') return { text: `${G.swap} ${who} ${G.running}`, color: C.frame };
    if (st.state === 'exhausted') return { text: `${G.swap} ${who} ${st.turn}/${st.budget} ${G.pause}`, color: C.hold };
    return { text: `${G.swap} ${who} ${st.turn}/${st.budget}`, color: C.link };
  });
  const counts: string[] = [];
  const near = neighbours(v, n.id);
  const kinds = [...near].map((id) => v.nodes.find((m) => m.id === id)?.kind).filter(Boolean) as Node['kind'][];
  for (const [k, glyph] of [['note', G.note], ['wrote', '▦'], ['file', '▤'], ['browser', '▣'], ['service', '◎']] as const) { const c = kinds.filter((x) => x === k).length; if (c) counts.push(`${glyph} ${c}`); }
  {
    let x = r.x + 2;
    const segs = [...talks, ...counts.map((c) => ({ text: c, color: C.frame }))];
    g.put(x, r.y + 3, pad('', inner), C.frame);
    for (const sg of segs) { const w = [...sg.text].length; if (x + w > r.x + 2 + inner) { g.put(x, r.y + 3, G.ell, C.frame); break; } g.put(x, r.y + 3, sg.text, sg.color); x += w + 2; }
  }
  if (r.h >= AGENT_TALL) {
    const recent = (s?.recent ?? []).slice(-3).map((x) => x.split(' ')[0]).join(' · ');
    g.put(r.x + 2, r.y + 4, pad(recent ? `${G.tool} ${recent}` : '', inner), C.frame);
    const open = tasks.filter((k) => k.task.status !== 'completed'), doingT = open.find((k) => k.task.status === 'in_progress');
    const line = doingT ? `${G.focus} ${doingT.task.active || doingT.task.subject}` : open.length ? t('{0} tasks open', open.length) : tasks.length ? t('all tasks done') : '';
    g.put(r.x + 2, r.y + 5, pad(line, inner), doingT ? C.hold : C.frame);
  }
  const gy = r.y + r.h - 2;
  const win = s ? windowOf(s.model, s.context) : 0;
  const ctx = s?.context ? `${gauge(s.context / win, 6)} ${Math.round((100 * s.context) / win)}%` : '';
  const sw = Math.max(4, inner - (ctx ? [...ctx].length + 2 : 0));
  if (state === 'running' || state === 'waiting') g.put(r.x + 2, gy, sparkline(s?.spark ?? [], sw), SPARK[state]);
  else g.put(r.x + 2, gy, pad(branch, sw), C.linkDim);   // parado, a atividade não diz nada; o branch diz onde ele trabalha
  if (ctx) g.put(r.x + 2 + sw, gy, padStart(ctx, [...ctx].length + 2), s!.context / win > 0.85 ? C.hold : C.frame);
  g.hit(n.id, r);
}

/** A subagent: its description as title, one line with what it is doing, tokens on the right. */
export const subState = (s: SubNode['sub']): { glyph: string; color: RGB; label: string } =>
  s.error ? { glyph: G.stuck, color: C.dead, label: t('failed') }
  : s.done ? { glyph: G.idle, color: C.dim, label: t('done') }
  : s.orphan ? { glyph: G.stuck, color: C.dead, label: t('orphan — nothing is running it any more') }
  : s.silent ? { glyph: G.stuck, color: C.dead, label: t('silent for {0}', ago(s.ageMs < Infinity ? s.ageMs : Date.now() - s.started)) }
  : s.bg ? { glyph: G.waiting, color: C.hold, label: s.ageMs > 120_000 && s.ageMs < Infinity ? t('background, silent for {0}', ago(s.ageMs)) : t('background') }
  : { glyph: G.running, color: C.run, label: t('running') };

function subBox(g: Grid, n: SubNode, r: Rect, on: boolean, src: boolean) {
  const s = n.sub, inner = r.w - 4;
  if (on || src) g.fill(r, BG.sel);
  g.frame(r, fit(`${G.sub} ${s.name}`, Math.max(4, r.w - 6)), on ? C.link : C.inkHi, on ? C.link : C.frame);
  const st = subState(s);
  const right = s.tokens ? tok(s.tokens) : '';
  const quiet = !s.done && s.ageMs > 60_000 && s.ageMs < Infinity ? `  ${ago(s.ageMs)}` : '';   // a subagent writes a line per step: silence is worth seeing
  const what = !s.done && !s.bg && !s.error && !s.silent && !s.orphan && s.now ? s.now + quiet : st.label;
  g.put(r.x + 2, r.y + 1, pad(`${st.glyph} ${what}`, Math.max(1, inner - (right ? right.length + 2 : 0))), st.color);
  if (right) g.put(r.x + 2 + inner - right.length, r.y + 1, right, C.frame);
  g.hit(n.id, r);
}

/** Uma nota pendurada no agente que a lê: uma linha, com o galho. */
function hangRow(g: Grid, n: NoteNode, r: Rect, on: boolean, lit: boolean, last: boolean) {
  if (on) g.fill({ x: r.x - SUB_INDENT + 1, y: r.y, w: r.w + SUB_INDENT - 1, h: 1 }, BG.sel);
  g.put(r.x - 2, r.y, last ? G.branchEnd : G.branchMid, C.frame);
  g.put(r.x + 1, r.y, fit(`${G.note} ${n.doc.title}${n.doc.ttl ? `  ${G.h}  ${t('ephemeral')}` : ''}`, r.w - 1), on || lit ? C.inkHi : C.link);
  g.hit(n.id, r);
}

/** Uma linha do razão: o item à esquerda, o dado que importa à direita; aceso quando liga ao selecionado. */
function ledgerLine(g: Grid, b: ProjectLayout['boxes'][number], on: boolean, src: boolean, lit: boolean) {
  const r = b.rect, row = b.row!;
  if (on || src) g.fill(r, BG.sel);
  if (lit && !on) g.fill({ x: r.x - 1, y: r.y, w: r.w + 1, h: 1 }, BG.sel);
  if (lit || on) g.put(r.x - 1, r.y, '▎', src ? C.hold : C.link);
  const mw = Math.min(Math.floor(r.w / 2), [...row.meta].length);
  g.put(r.x + 1, r.y, fit(row.text, Math.max(4, r.w - mw - 3)), on || lit ? C.inkHi : row.color);
  if (mw) g.put(r.x + r.w - mw, r.y, fit(row.meta, mw), on || lit ? C.ink : C.dim);
  if (row.second) g.put(r.x + 1, r.y + 1, fit(row.second, r.w - 2), C.frame);
  g.hit(b.id, r);
}

export interface ProjectOpts { linkSource?: string | null; tick?: number; query?: string; panel?: boolean }

const nodeName = (n: Node) => n.kind === 'agent' ? n.name : n.kind === 'note' ? n.doc.title : n.kind === 'file' ? n.item.label : n.kind === 'task' ? n.task.subject : n.kind === 'sub' ? n.sub.name : n.kind === 'wrote' ? n.label : n.kind === 'browser' ? 'browser' : n.item.name;

/** Painel à direita: o que vale saber do nó selecionado sem entrar nele. */
function drawNodePanel(g: Grid, v: View, n: Node, top: number, bottom: number) {
  const x = g.W - panelW(g.W) + 2, w = g.W - 2 - x;
  let y = top;
  for (let yy = top; yy <= bottom; yy++) g.put(x - 2, yy, G.v, C.frame);
  const head = (t: string) => { if (y <= bottom) { g.put(x, y, t, C.link); g.put(x + t.length + 1, y, G.h.repeat(Math.max(0, w - t.length - 1)), C.frame); } y++; };
  const row = (k: string, val: string, col: RGB = C.ink) => { if (y <= bottom) { g.put(x, y, pad(k, 9), C.frame); g.put(x + 9, y, fit(val, w - 9), col); } y++; };
  const text = (t: string, col: RGB = C.dim, max = 6) => { for (const l of renderMd(t, w).slice(0, max)) { if (y > bottom) break; let sx = x; for (const sp of l.spans) { g.put(sx, y, fit(sp.text, Math.max(0, x + w - sx)), sp.color === C.ink ? col : sp.color); sx += [...sp.text].length; } y++; } };
  const links = v.edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => v.nodes.find((m) => m.id === (e.from === n.id ? e.to : e.from))).filter((m): m is Node => !!m && m.kind !== 'wrote');
  const home = process.env.HOME ?? '';

  head(n.kind === 'agent' ? t('agent') : n.kind === 'note' ? t('note') : n.kind === 'file' ? t('file') : n.kind === 'task' ? t('task') : n.kind === 'sub' ? t('subagent') : n.kind === 'wrote' ? (n.agent ? t('made') : t('changed')) : n.kind === 'browser' ? 'browser' : t('service'));
  if (n.kind === 'agent') {
    // a caixa já diz nome, estado, o que ele faz e o contexto: aqui vai o que não cabe lá
    const s = n.session;
    if (!s) { row(t('state'), t('no session'), C.dim); }
    else {
      y++; head(t('said last')); text(s.lastText.replace(/^(\w+ )?cd \S+\s*(&&\s*)?/, '$1') || t('nothing yet'), C.ink, 5);
      y++; head(t('session'));
      row(t('up'), ago(Date.now() - (s.started || s.mtime)));
      row(t('model'), s.model || '—');
      row('branch', n.item?.worktree ?? s.branch);
      row(t('wrote'), `${tok(s.burn)} ${t('tokens')}`);
      y++; head(t('last actions'));
      if (!s.recent.length) row('', t('nothing yet'), C.dim);
      for (const r of [...s.recent].reverse()) row('', `${G.tool} ${r.replace(v.project.cwd + '/', '').replace(home, '~')}`, C.dim);
    }
    const made = v.nodes.filter((m): m is WroteNode => m.kind === 'wrote' && m.agent === n.id);
    if (made.length) {
      y++; head(`${t('produced')} (${made.reduce((k, m) => k + Math.max(1, m.group.length), 0)})`);
      for (const m of made.slice(0, 4)) row('', `${m.group.length ? '▦' : '▥'} ${m.label}`, C.link);
    }
    const tasks = v.nodes.filter((m): m is TaskNode => m.kind === 'task' && m.agent === n.id);
    if (tasks.length) {
      y++; head(`${t('tasks')} (${tasks.length})`);
      for (const k of tasks.slice(0, 5)) row('', `${k.task.status === 'completed' ? G.running : k.task.status === 'in_progress' ? G.focus : G.idle} ${k.task.subject}`, k.task.status === 'completed' ? C.run : k.task.status === 'in_progress' ? C.hold : C.dim);
    }
  } else if (n.kind === 'note') {
    row(t('title'), n.doc.title, C.inkHi);
    row(t('life'), n.doc.ttl ? t('ephemeral, {0}', ago(n.doc.ttl - Date.now())) : t('persistent'));
    row(t('read by'), n.doc.acl.join(', ') || t('nobody'), n.doc.acl.length ? C.link : C.dim);
    y++; head(t('content')); text(n.doc.body.trim() || t('(empty)'), C.ink, 12);
  } else if (n.kind === 'file') {
    row(t('file'), n.item.label, C.inkHi);
    row(t('where'), n.item.path.slice(0, -n.item.label.length).replace(home, '~'));
    row(t('lines'), n.lines ? String(n.lines) : '—');
    if (n.item.context) { y++; text(n.item.context === 'claude' ? t('Environment context: Claude reads this file in every session of this project.') : t('Index of Claude automatic memory for this project.'), C.dim, 4); }
    if (!n.exists) row('', t('gone'), C.dead);
  } else if (n.kind === 'task') {
    const agent = v.nodes.find((m) => m.id === n.agent);
    row(t('state'), `${n.task.status === 'completed' ? G.running : n.task.status === 'in_progress' ? G.focus : G.idle} ${n.task.status}`, n.task.status === 'completed' ? C.run : n.task.status === 'in_progress' ? C.hold : C.dim);
    row(t('from'), agent && agent.kind === 'agent' ? agent.name : '?', C.link);
    if (n.task.active) row(t('now'), n.task.active);
    y++; head(t('task')); text(`**${n.task.subject}**\n\n${n.task.description || t('_no description_')}`, C.ink, 10);
  } else if (n.kind === 'sub') {
    const s = n.sub, st = subState(s), parent = v.nodes.find((m) => m.id === n.agent);
    row(t('name'), s.name, C.inkHi);
    row(t('type'), s.type || '—');
    row(t('state'), `${st.glyph} ${st.label}${!s.done && s.ageMs < Infinity ? `  ${ago(s.ageMs)}` : ''}`, st.color);
    row(t('from'), parent && parent.kind === 'agent' ? parent.name : '?', C.link);
    row(t('so far'), `${tok(s.tokens)}  ${G.h}  ${t('{0} tool call{1}', s.tools, s.tools === 1 ? '' : 's')}`);
    y++; head(t('doing now')); text(s.now || t('nothing yet'), C.ink, 3);
    y++; head(t('brief')); text(s.prompt.trim() || t('_no prompt_'), C.ink, 10);
  } else if (n.kind === 'browser') {
    row(t('page'), n.state.title || '—', C.inkHi);
    row('url', n.state.url || t('no url yet'));
    row(t('mode'), `${modeLabel(n.item.mode)}${n.state.live ? ` · ${t('live')}` : ''}`, n.state.live ? C.run : C.ink);
    row(t('port'), String(n.item.port));
    row(t('last'), n.state.lastTool ? browserShort(n.state.lastTool) + (n.state.busy ? '…' : '') : '—', n.state.busy ? C.hold : C.ink);
    if (n.state.counts) row('console', n.state.counts, /^0 /.test(n.state.counts) ? C.ink : C.hold);
    y++; head('snapshot');
    const snap = snapshotRefs(n.state.snapshot).slice(0, 8);
    if (!snap.length) row('', t('none yet'), C.dim);
    for (const it of snap) row(it.ref, it.text, C.dim);
  } else if (n.kind === 'wrote') {
    const from = v.nodes.find((m) => m.id === n.agent);
    row(t('made'), n.label, C.inkHi);
    row(t('by'), from && from.kind === 'agent' ? from.name : t('nobody claims it'), n.agent ? C.link : C.dim);
    row(t('how'), n.how === 'tool' ? t('a write tool') : n.how === 'shell' ? t('the shell') : t('found on disk'));
    row(t('when'), ago(Date.now() - n.ts));
    if (n.group.length) { y++; head(`${t('files')} (${n.group.length})`); for (const f of n.group.slice(0, 10)) row('', `${G.tool} ${f}`, C.ink); }
  } else {
    row(t('service'), `${n.item.name}${n.item.port ? `:${n.item.port}` : ''}`, C.inkHi);
    row(t('state'), n.alive ? `${G.running} ${t('alive')}` : `${G.stuck} ${t('dead')}`, n.alive ? C.run : C.dead);
    row('pid', String(n.item.pid));
    row(t('where'), n.item.cwd.replace(home, '~') || '—');
  }
  if (n.kind !== 'agent') {   // para o agente o mapa já acende as ligações; a lista aqui só repetia
    y++; head(`${t('links')}${links.length ? ` (${links.length})` : ''}`);
    if (!links.length) row('', t('none — l links'), C.dim);
    for (const m of links.slice(0, 6)) row('', `${m.kind === 'agent' ? G.swap : KIND_GLYPH[m.kind]} ${nodeName(m)}`, m.kind === 'agent' || m.kind === 'note' ? C.link : C.ink);
  }
  if (y <= bottom) g.put(x, bottom, fit(`${t('↵ opens')}  ${G.h}  ${t('] hides the panel')}`, w), C.frame);
}

export function renderProject(g: Grid, v: View, selected: string | null, scroll: number, status: string, opts: ProjectOpts = {}) {
  const { W, H } = g;
  const top = 1, bottom = H - 4;
  const L = layoutProject(v, W, scroll, !!opts.panel, H);
  const src = opts.linkSource ?? null;
  const home = process.env.HOME ?? '';

  g.frame({ x: 0, y: 0, w: W, h: H }, 'anthive', C.inkHi);
  const tt = ` ${v.project.name} `;
  g.put(13, 0, tt, C.link);
  g.put(13 + tt.length, 0, fit(`${G.h} ${v.project.cwd.replace(home, '~')} `, Math.max(0, W - 40 - tt.length)), C.dim);
  const nA = v.nodes.filter((n) => n.kind === 'agent').length, nN = v.nodes.filter((n) => n.kind === 'note').length;
  const nF = v.nodes.filter((n) => n.kind === 'file').length, nS = v.nodes.filter((n) => n.kind === 'service').length, nT = v.nodes.filter((n) => n.kind === 'task').length, nSub = v.nodes.filter((n) => n.kind === 'sub').length;
  const nW = v.nodes.filter((n): n is WroteNode => n.kind === 'wrote').reduce((k, n) => k + Math.max(1, n.group.length), 0);
  const counts = [nA && t('{0} agent{1}', nA, nA > 1 ? 's' : ''), nN && t('{0} note{1}', nN, nN > 1 ? 's' : ''), nT && t('{0} task{1}', nT, nT > 1 ? 's' : ''), nSub && t('{0} subagent{1}', nSub, nSub > 1 ? 's' : ''), nW && t('{0} produced', nW), nF && t('{0} file{1}', nF, nF > 1 ? 's' : ''), nS && t('{0} service{1}', nS, nS > 1 ? 's' : '')].filter(Boolean).join(` ${G.h} `);
  if (counts) g.put(W - 4 - counts.length, 0, ` ${counts} `, C.dim);

  const vis = (r: Rect) => r.y >= top && r.y + r.h - 1 <= bottom;
  if (!v.nodes.length) {
    const msg = t('empty project — n creates an agent, a note, a file or a service');
    g.put(Math.max(2, Math.floor((W - msg.length) / 2)), Math.floor(H / 2), msg, C.dim);
  }
  // o que acende: os vizinhos do selecionado (ou da origem de uma ligação em curso)
  const lit = neighbours(v, src ?? selected);
  for (const h of L.heads) if (h.y >= top && h.y <= bottom) { g.put(L.rightX, h.y, `${h.title} `, C.link); g.put(L.rightX + h.title.length + 1, h.y, G.h.repeat(Math.max(0, L.rightW - h.title.length - 1)), C.frame); }
  for (const b of L.boxes) {
    if (!vis(b.rect)) continue;
    const on = b.id === selected, isSrc = b.id === src, isLit = lit.has(b.id);
    if (b.node.kind === 'agent') agentBox(g, v, b.node, b.rect, on, isSrc, isLit, v.nodes.filter((m): m is TaskNode => m.kind === 'task' && m.agent === b.node.id));
    else if (b.node.kind === 'sub') subBox(g, b.node, b.rect, on, isSrc);
    else if (b.hang && b.node.kind === 'note') hangRow(g, b.node, b.rect, on, isLit, false);
    else if (b.row) ledgerLine(g, b, on, isSrc, isLit);
  }
  // o galho de cada agente: dos subagentes e das notas penduradas, na margem que o recuo deixa livre
  for (const b of L.boxes) {
    if (b.node.kind !== 'agent') continue;
    const kids = L.boxes.filter((k) => (k.node.kind === 'sub' && k.node.agent === b.id) || (k.hang && k.node.kind === 'note' && ownerOf(k.node, v.nodes.filter((m): m is AgentNode => m.kind === 'agent'))?.id === b.id));
    if (!kids.length) continue;
    const x = b.rect.x + 1;
    const last = kids[kids.length - 1]!;
    const yEnd = last.node.kind === 'sub' ? last.rect.y + 1 : last.rect.y;
    for (let y = b.rect.y + b.rect.h; y < yEnd; y++) if (y >= top && y <= bottom) g.put(x, y, G.v, C.frame);
    for (const k of kids) {
      const y = k.node.kind === 'sub' ? k.rect.y + 1 : k.rect.y;
      if (y < top || y > bottom) continue;
      g.put(x, y, k === last ? G.bl : G.teeL, C.frame); g.put(x + 1, y, G.h, C.frame);
    }
  }

  // a história, quando sobra tela: o mapa é presente, a faixa é o passado recente
  const lowest = L.boxes.reduce((m, b) => Math.max(m, b.rect.y + b.rect.h), 1);
  const room = bottom - lowest - 1;
  if (v.moments?.length && room >= 5 && scroll === 0) {
    const hy = lowest + 1;
    const label = ` ${t('history')} `;
    g.put(2, hy, label, C.link);
    g.put(2 + label.length, hy, G.h.repeat(Math.max(0, W - 4 - label.length)), C.frame);
    const shown = v.moments.slice(-(bottom - hy - 1));
    const who = Math.min(12, Math.max(...shown.map((m) => [...m.who].length)));
    for (let i = 0; i < shown.length; i++) {
      const m = shown[i]!, y = hy + 1 + i;
      if (y > bottom) break;
      const col = m.kind === 'turn' ? C.run : m.kind === 'wrote' ? C.link : C.linkDim;
      const mark = m.kind === 'turn' ? G.running : m.kind === 'wrote' ? '▥' : G.sub;
      const what = m.kind === 'wrote' ? relTo(v.project.cwd, m.what) : m.what;
      g.put(2, y, hhmm(m.ts), C.frame);
      g.put(8, y, pad(m.who, who), C.dim);
      g.put(9 + who, y, `${mark} `, col);
      g.put(11 + who, y, fit(what, Math.max(0, W - 13 - who)), m.kind === 'turn' ? C.ink : C.dim);
    }
  }

  const selNode = selected ? v.nodes.find((n) => n.id === selected) : undefined;
  if (opts.panel && panelFits(W) && selNode) drawNodePanel(g, v, selNode, top + 1, bottom);

  g.put(0, H - 3, G.teeL + G.h.repeat(W - 2) + G.teeR, C.frame);
  const all = L.boxes.map((b) => b.rect);
  scrollHint(g, H - 3, all.filter((r) => r.y < top).length, all.filter((r) => r.y + r.h - 1 > bottom).length);
  const name = (id: string | null) => { const n = id ? v.nodes.find((x) => x.id === id) : null; return n ? nodeName(n) : '…'; };
  if (src) {
    keybar(g, H - 2, [[`${G.tool} ${t('link')}`, `${name(src)} ${G.arrow} ${selected && selected !== src ? name(selected) : '…'}`], [t('arrows'), t('choose')], ['↵', t('confirm')], ['esc', t('cancel')]], '', `${G.tool} ${t('link')}`);
    return;
  }
  keybar(g, H - 2, [['↑↓←→', t('navigate')], ['↵', t('open')], ['n', t('new')], ['l', t('link')], ['d', t('remove')], ['s', t('select')], [']', t('panel')], ['esc', t('projects')], ['q', t('quit')]], status);
}
