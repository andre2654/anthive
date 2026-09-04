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
import { View, Node, Edge, AgentNode, TaskNode, projectName, SubNode, WroteNode } from '../core/project.ts';
import { threadState } from '../core/store.ts';
import { windowOf as winOf } from '../core/sessions.ts';
import { renderMd } from '../tui/markdown.ts';
import { gauge } from '../tui/theme.ts';
import { keybar, scrollHint } from './chrome.ts';

export const AGENT_H = 5, NOTE_H = 4, FILE_H = 3, SERVICE_H = 4;
const LANE_STEP = 3;                     // faixas em +2, +5, +8, … ; a última coluna da calha fica para a seta
const MIN_GUTTER = 12;

const GLYPH: Record<State, string> = { running: G.running, waiting: G.waiting, idle: G.idle, stuck: G.stuck, sleeping: G.idle };
const COLOR: Record<State, RGB> = { running: C.run, waiting: C.hold, idle: C.idle, stuck: C.dead, sleeping: C.frame };
const LABEL = (s: State) => ({ running: t('running'), waiting: t('approval'), idle: t('idle'), stuck: t('stuck'), sleeping: t('asleep') })[s];
const SPARK: Record<State, RGB> = { running: C.sparkR, waiting: C.sparkH, idle: C.sparkI, stuck: C.sparkD, sleeping: C.sparkI };
export const KIND_GLYPH = { agent: G.running, note: G.note, file: '▤', service: '◎', task: G.focus, sub: G.sub, wrote: '▥', browser: '▣' } as const;
export const PANEL_W = 34;
export const panelFits = (W: number) => W >= 110;
const TASK_H = 3, BROWSER_H = 4, SUB_H = 3, SUB_INDENT = 3, WROTE_H = 3;   // subagents hang under their agent, indented

export interface Path { cells: [number, number][]; from: string; to: string }
export interface ProjectLayout {
  boxes: { id: string; rect: Rect; node: Node }[];
  paths: Path[];
  leftW: number; rightX: number; rightW: number;
  height: number;
}

/** Coloração por intervalo: cada faixa só recebe trechos verticais que não se sobrepõem. */
function assignLanes(spans: { key: string; y0: number; y1: number }[]): { lanes: Map<string, number>; count: number } {
  const lanes = new Map<string, number>();
  const used: { y0: number; y1: number }[][] = [];
  for (const sp of [...spans].sort((a, b) => a.y0 - b.y0 || a.y1 - b.y1)) {
    let k = 0;
    while (used[k]?.some((u) => sp.y0 <= u.y1 && u.y0 <= sp.y1)) k++;
    (used[k] ??= []).push({ y0: sp.y0, y1: sp.y1 });
    lanes.set(sp.key, k);
  }
  return { lanes, count: Math.max(1, used.length) };
}

export function layoutProject(v: View, W: number, scroll = 0, panel = false): ProjectLayout {
  const pw = panel && panelFits(W) ? PANEL_W : 0;
  const avail = W - 4 - pw;
  const agents = v.nodes.filter((n): n is AgentNode => n.kind === 'agent');
  const items = (['note', 'task', 'browser', 'wrote', 'file', 'service'] as const).flatMap((kind) => v.nodes.filter((x) => x.kind === kind));
  const hOf = (n: Node) => n.kind === 'agent' ? AGENT_H : n.kind === 'note' ? NOTE_H : n.kind === 'file' ? (n.item.context ? NOTE_H : FILE_H) : n.kind === 'task' ? TASK_H : n.kind === 'sub' ? SUB_H : n.kind === 'wrote' ? WROTE_H : n.kind === 'browser' ? BROWSER_H : SERVICE_H;

  // 1) alturas primeiro: não dependem da largura da calha
  const yOf = new Map<string, number>();
  let y = 2 - scroll;
  const subsOf = (id: string) => v.nodes.filter((n): n is SubNode => n.kind === 'sub' && n.agent === id);
  for (const a of agents) { yOf.set(a.id, y); y += AGENT_H; for (const s of subsOf(a.id)) { yOf.set(s.id, y); y += SUB_H; } y += 1; }
  const leftBottom = y;
  y = 2 - scroll;
  for (const n of items) { yOf.set(n.id, y); y += hOf(n) + 1; }
  const height = Math.max(leftBottom, y) + scroll;

  // 2) faixas pelos trechos verticais das ligações que cruzam a calha.
  //    Saídas e chegadas escalonadas: a k-ésima ligação de um nó usa a k-ésima
  //    linha de conteúdo dele, então nada se empilha na mesma linha.
  const left = new Set(v.nodes.filter((n) => n.kind === 'agent' || n.kind === 'sub').map((n) => n.id));
  const isAgent = (id: string) => left.has(id);
  const key = (e: Edge) => `${e.from}>${e.to}`;
  const hById = new Map(v.nodes.map((n) => [n.id, hOf(n)]));
  const outCount = new Map<string, number>(), inCount = new Map<string, number>();
  const rowOut = new Map<string, number>(), rowIn = new Map<string, number>();
  const crossing = v.edges.filter((e) => yOf.has(e.from) && yOf.has(e.to) && isAgent(e.from) !== isAgent(e.to))
    .sort((a, b) => (yOf.get(isAgent(a.from) ? a.to : a.from)! - yOf.get(isAgent(b.from) ? b.to : b.from)!));
  for (const e of crossing) {
    const [l, r] = isAgent(e.from) ? [e.from, e.to] : [e.to, e.from];
    const ko = outCount.get(l) ?? 0, ki = inCount.get(r) ?? 0;
    outCount.set(l, ko + 1); inCount.set(r, ki + 1);
    rowOut.set(key(e), yOf.get(l)! + 1 + (ko % Math.max(1, hById.get(l)! - 2)));
    rowIn.set(key(e), yOf.get(r)! + 1 + (ki % Math.max(1, hById.get(r)! - 2)));
  }
  const spans = crossing.map((e) => {
    const yl = rowOut.get(key(e))!, yr = rowIn.get(key(e))!;
    return { key: key(e), y0: Math.min(yl, yr), y1: Math.max(yl, yr) };
  });
  const { lanes, count } = assignLanes(spans);
  const gutter = Math.min(Math.max(MIN_GUTTER, 2 + count * LANE_STEP + 2), Math.max(MIN_GUTTER, Math.floor(avail / 3)));   // muitas faixas não podem zerar a coluna da direita

  // 3) agora as larguras e as caixas
  const leftW = Math.min(34, Math.max(24, Math.floor((avail - gutter) / 2)));
  const rightX = 2 + leftW + gutter;
  const rightW = W - 2 - rightX - pw;
  const boxes: ProjectLayout['boxes'] = [];
  for (const a of agents) boxes.push({ id: a.id, rect: { x: 2, y: yOf.get(a.id)!, w: leftW, h: AGENT_H }, node: a });
  for (const a of agents) for (const s of subsOf(a.id)) boxes.push({ id: s.id, rect: { x: 2 + SUB_INDENT, y: yOf.get(s.id)!, w: leftW - SUB_INDENT, h: SUB_H }, node: s });
  for (const n of items) boxes.push({ id: n.id, rect: { x: rightX, y: yOf.get(n.id)!, w: rightW, h: hOf(n) }, node: n });

  // 4) rotas
  const rect = (id: string) => boxes.find((b) => b.id === id)?.rect;
  const nameLen = (id: string) => { const n = boxes.find((b) => b.id === id)?.node; return n && n.kind === 'agent' ? [...n.name].length : 4; };
  const paths: Path[] = [];
  const gx = 2 + leftW;
  for (const e of v.edges) {
    if (e.kind === 'sub') continue;   // drawn as a stem next to the boxes, not as a route
    const a = rect(e.from), b = rect(e.to);
    if (!a || !b) continue;
    const cells: [number, number][] = [];
    if (a.x !== b.x) {
      const [l, r] = a.x < b.x ? [a, b] : [b, a];
      const yl = rowOut.get(key(e)) ?? l.y + 2, yr = rowIn.get(key(e)) ?? r.y + 1;
      const lx = gx + 2 + (lanes.get(key(e)) ?? 0) * LANE_STEP;
      for (let x = l.x + l.w; x < lx; x++) cells.push([x, yl]);
      const step = yr > yl ? 1 : yr < yl ? -1 : 0;
      if (step === 0) cells.push([lx, yl]);
      else for (let yy = yl; yy !== yr + step; yy += step) cells.push([lx, yy]);
      for (let x = lx + 1; x < r.x - 1; x++) cells.push([x, yr]);
      cells.push([r.x - 1, yr]);
      paths.push({ cells: a.x < b.x ? cells : cells.reverse(), from: e.from, to: e.to });
    } else {
      const [t, btm] = a.y < b.y ? [a, b] : [b, a];
      const x = Math.min(t.x + t.w - 3, t.x + 4 + Math.max(nameLen(e.from), nameLen(e.to)) + 1);
      for (let yy = t.y + t.h - 1; yy <= btm.y; yy++) cells.push([x, yy]);
      paths.push({ cells: a.y < b.y ? cells : cells.reverse(), from: e.from, to: e.to });
    }
  }
  return { boxes, paths, leftW, rightX, rightW, height };
}

// ---------------------------------------------------------------- caixas
function agentBox(g: Grid, n: AgentNode, r: Rect, on: boolean, src: boolean) {
  const s = n.session, inner = r.w - 4;
  const state: State = s ? s.state : 'idle';
  if (on || src) g.fill(r, BG.sel);
  const border = src ? C.hold : on ? C.link : C.frame;
  g.frame(r, `${src ? G.tool + ' ' : ''}${n.name}`, src ? C.hold : on ? C.link : C.inkHi, border);
  g.put(r.x + 2, r.y + 1, pad(`${GLYPH[state]} ${LABEL(state)}`, inner - 7), COLOR[state]);
  g.put(r.x + 2 + inner - 7, r.y + 1, padStart(s ? ago(s.ageMs) : '', 7), C.frame);
  const branch = n.item?.worktree ?? (s?.branch && s.branch !== 'HEAD' ? s.branch : '');
  const doing = s?.lastText.replace(/^(\w+ )?cd \S+\s*(&&\s*)?/, '$1') ?? '';
  const inflight = s?.state === 'running' && s.pendingTool ? `${G.tool} ${s.pendingTool}${s.pendingInput ? ' ' + s.pendingInput : ''}` : '';
  const l2 = s?.state === 'waiting' || s?.state === 'stuck' ? `${G.pause} ${s.pendingTool ?? '?'}` : inflight || branch || doing || (n.item ? t('no session — ↵ opens the chat') : '');
  g.put(r.x + 2, r.y + 2, pad(l2, inner), s?.state === 'waiting' ? C.hold : inflight ? C.dim : branch ? C.link : C.frame);
  const ctx = s?.context ? `${tok(s.context)}` : '';
  const sw = Math.max(4, inner - (ctx ? ctx.length + 2 : 0));
  g.put(r.x + 2, r.y + 3, sparkline(s?.spark ?? [], sw), SPARK[state]);
  if (ctx) g.put(r.x + 2 + sw, r.y + 3, padStart(ctx, ctx.length + 2), (s!.context / windowOf(s!.model, s!.context)) > 0.85 ? C.hold : C.frame);
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

function itemBox(g: Grid, n: Node, r: Rect, on: boolean, src: boolean) {
  const inner = r.w - 4;
  if (on || src) g.fill(r, BG.sel);
  const border = src ? C.hold : on ? C.link : C.frame;
  const title = n.kind === 'note' ? t('note') : n.kind === 'file' ? (n.item.context ? t('context') : t('file')) : n.kind === 'task' ? t('task') : n.kind === 'wrote' ? (n.agent ? t('made') : t('changed')) : n.kind === 'browser' ? 'browser' : t('service');
  const ttl = title;
  g.frame(r, `${src ? G.tool + ' ' : ''}${ttl}`, src ? C.hold : on ? C.link : C.linkDim, border);
  const home = process.env.HOME ?? '';
  if (n.kind === 'note') {
    g.put(r.x + 2, r.y + 1, pad(`${G.note} ${n.doc.title}`, inner), C.link);
    const who = n.doc.acl.length ? t('read by: {0}', n.doc.acl.join(', ')) : t('nobody reads it yet');
    g.put(r.x + 2, r.y + 2, pad(`${n.doc.ttl ? t('ephemeral') : t('persistent')}  ${G.h}  ${who}`, inner), C.dim);
  } else if (n.kind === 'file' && n.item.context) {
    g.put(r.x + 2, r.y + 1, pad(`▤ ${n.item.label}`, inner), C.link);
    const what = n.item.context === 'claude' ? t('environment context — Claude reads it every session') : t('Claude automatic memory for this project');
    g.put(r.x + 2, r.y + 2, pad(`${what}  ${G.h}  ${t('{0} lines', n.lines ?? 0)}`, inner), C.dim);
  } else if (n.kind === 'file') {
    const dir = n.item.path.slice(0, -n.item.label.length).replace(home, '~');
    const lab = `▤ ${n.item.label}`;
    g.put(r.x + 2, r.y + 1, pad(lab, inner), n.exists ? C.ink : C.dead);
    const rest = inner - [...lab].length - 2;
    if (rest > 6) g.put(r.x + 2 + [...lab].length + 2, r.y + 1, fit(n.exists ? dir : t('gone'), rest), C.frame);
  } else if (n.kind === 'task') {
    const st = n.task.status;
    const glyph = st === 'completed' ? G.running : st === 'in_progress' ? G.focus : G.idle;
    const col = st === 'completed' ? C.run : st === 'in_progress' ? C.hold : C.dim;
    g.put(r.x + 2, r.y + 1, pad(`${glyph} ${n.task.subject}`, inner), col);
  } else if (n.kind === 'wrote') {
    const mark = n.group.length ? '▦' : '▥';
    const right = n.group.length ? t('{0} files', n.group.length) : n.count > 1 ? `${n.count}x` : '';
    const col = n.how === 'seen' ? C.dim : C.ink;
    g.put(r.x + 2, r.y + 1, pad(`${mark} ${n.label}`, Math.max(1, inner - (right ? right.length + 2 : 0))), col);
    if (right) g.put(r.x + 2 + inner - right.length, r.y + 1, right, C.frame);
  } else if (n.kind === 'browser') {
    const st = n.state;
    const l1 = st.busy ? `${G.running} ${browserShort(st.lastTool ?? 'browser_')}…` : `▣ chrome (${modeLabel(n.item.mode)})${st.live ? ` ${G.running} ${t('live')}` : ''}  ${G.h}  ${st.title || t('no page yet')}`;
    g.put(r.x + 2, r.y + 1, pad(l1, inner), st.busy ? C.hold : st.url ? C.run : C.dim);
    g.put(r.x + 2, r.y + 2, pad(st.url || t('link an agent (l) and ask it to browse'), inner), C.dim);
  } else if (n.kind === 'service') {
    const port = n.item.port ? `:${n.item.port}` : '';
    g.put(r.x + 2, r.y + 1, pad(`◎ ${n.item.name}${port}`, inner), n.alive ? C.run : C.dead);
    g.put(r.x + 2, r.y + 2, pad(`pid ${n.item.pid}  ${G.h}  ${n.alive ? t('alive') : t('dead')}  ${G.h}  ${fit(n.item.cwd.replace(home, '~'), Math.max(6, inner - 22))}`, inner), C.dim);
  }
  g.hit(n.id, r);
}

// ---------------------------------------------------------------- linhas
/** Escreve um traço fundindo com o que já existe: │ sobre ─ vira ┼. */
function stroke(g: Grid, x: number, y: number, ch: string, col: RGB) {
  const cur = g.at(x, y);
  const cross = (cur === G.v && ch === G.h) || (cur === G.h && ch === G.v) ? '┼' : ch;
  g.put(x, y, cross, col);
}

function drawPath(g: Grid, p: Path, e: Edge, W: number, arrow = true) {
  const talk = e.kind === 'talk';
  const col = talk ? (e.thread && threadState(e.thread).state === 'exhausted' ? C.hold : C.link) : e.kind === 'context' ? C.linkDim : C.frame;
  const H = talk ? G.hH : G.h, V = talk ? G.hV : G.v;
  const cs = p.cells;
  for (let i = 0; i < cs.length; i++) {
    const [x, y] = cs[i]!, prev = cs[i - 1], next = cs[i + 1];
    let ch: string = H;
    const dxPrev = prev ? x - prev[0] : 0, dyPrev = prev ? y - prev[1] : 0;
    const dxNext = next ? next[0] - x : 0, dyNext = next ? next[1] - y : 0;
    const horizIn = dxPrev !== 0, vertIn = dyPrev !== 0, horizOut = dxNext !== 0, vertOut = dyNext !== 0;
    if (i === cs.length - 1 && !talk && arrow) ch = '▸';   // seta só quando o destino está na tela
    else if ((horizIn || !prev) && vertOut) ch = dyNext > 0 ? '╮' : '╯';
    else if (vertIn && horizOut) ch = dyPrev > 0 ? '╰' : '╭';
    else if (vertIn || vertOut) ch = V;
    if (talk && (ch === '╮' || ch === '╯' || ch === '╰' || ch === '╭')) ch = ch === '╮' ? '┓' : ch === '╯' ? '┛' : ch === '╰' ? '┗' : '┏';
    stroke(g, x, y, ch, col);
  }
  if (talk && e.thread) {
    const st = threadState(e.thread);
    const mid = cs[Math.floor(cs.length / 2)]!;
    const tag = `${st.state === 'exhausted' ? G.pause : G.swap} ${st.turn}/${st.budget}`;
    if (mid[0] + 2 + tag.length < W - 1) g.put(mid[0] + 2, mid[1], tag, st.state === 'exhausted' ? C.hold : C.inkHi);
  }
}

export interface ProjectOpts { linkSource?: string | null; tick?: number; query?: string; panel?: boolean }

const nodeName = (n: Node) => n.kind === 'agent' ? n.name : n.kind === 'note' ? n.doc.title : n.kind === 'file' ? n.item.label : n.kind === 'task' ? n.task.subject : n.kind === 'sub' ? n.sub.name : n.kind === 'wrote' ? n.label : n.kind === 'browser' ? 'browser' : n.item.name;

/** Painel à direita: o que vale saber do nó selecionado sem entrar nele. */
function drawNodePanel(g: Grid, v: View, n: Node, top: number, bottom: number) {
  const x = g.W - PANEL_W + 2, w = g.W - 2 - x;
  let y = top;
  for (let yy = top; yy <= bottom; yy++) g.put(x - 2, yy, G.v, C.frame);
  const head = (t: string) => { if (y <= bottom) { g.put(x, y, t, C.link); g.put(x + t.length + 1, y, G.h.repeat(Math.max(0, w - t.length - 1)), C.frame); } y++; };
  const row = (k: string, val: string, col: RGB = C.ink) => { if (y <= bottom) { g.put(x, y, pad(k, 9), C.frame); g.put(x + 9, y, fit(val, w - 9), col); } y++; };
  const text = (t: string, col: RGB = C.dim, max = 6) => { for (const l of renderMd(t, w).slice(0, max)) { if (y > bottom) break; let sx = x; for (const sp of l.spans) { g.put(sx, y, fit(sp.text, Math.max(0, x + w - sx)), sp.color === C.ink ? col : sp.color); sx += [...sp.text].length; } y++; } };
  const links = v.edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => v.nodes.find((m) => m.id === (e.from === n.id ? e.to : e.from))).filter((m): m is Node => !!m);
  const home = process.env.HOME ?? '';

  head(n.kind === 'agent' ? t('agent') : n.kind === 'note' ? t('note') : n.kind === 'file' ? t('file') : n.kind === 'task' ? t('task') : n.kind === 'sub' ? t('subagent') : n.kind === 'wrote' ? (n.agent ? t('made') : t('changed')) : n.kind === 'browser' ? 'browser' : t('service'));
  if (n.kind === 'agent') {
    const s = n.session;
    row(t('name'), n.name, C.inkHi);
    row(t('state'), s ? `${GLYPH[s.state]} ${LABEL(s.state)}  ${ago(s.ageMs)}` : t('no session'), s ? COLOR[s.state] : C.dim);
    if (s) { const win = winOf(s.model, s.context); row(t('context'), `${gauge(s.context / win, 8)} ${Math.round((100 * s.context) / win)}%`, s.context / win > 0.85 ? C.hold : C.run); row(t('model'), s.model || '—'); row('branch', n.item?.worktree ?? s.branch); }
    y++; head(t('doing now')); text(s?.lastText.replace(/^(\w+ )?cd \S+\s*(&&\s*)?/, '$1') || t('nothing yet'), C.ink, 4);
    const tasks = v.nodes.filter((m): m is TaskNode => m.kind === 'task' && m.agent === n.id);
    y++; head(`${t('tasks')}${tasks.length ? ` (${tasks.length})` : ''}`);
    if (!tasks.length) row('', t('none'), C.dim);
    for (const t of tasks.slice(0, 5)) row('', `${t.task.status === 'completed' ? G.running : t.task.status === 'in_progress' ? G.focus : G.idle} ${t.task.subject}`, t.task.status === 'completed' ? C.run : t.task.status === 'in_progress' ? C.hold : C.dim);
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
  y++; head(`${t('links')}${links.length ? ` (${links.length})` : ''}`);
  if (!links.length) row('', t('none — l links'), C.dim);
  for (const m of links.slice(0, 6)) row('', `${m.kind === 'agent' ? G.swap : KIND_GLYPH[m.kind]} ${nodeName(m)}`, m.kind === 'agent' || m.kind === 'note' ? C.link : C.ink);
  if (y <= bottom) g.put(x, bottom, fit(`${t('↵ opens')}  ${G.h}  ${t('] hides the panel')}`, w), C.frame);
}

export function renderProject(g: Grid, v: View, selected: string | null, scroll: number, status: string, opts: ProjectOpts = {}) {
  const { W, H } = g;
  const top = 1, bottom = H - 4;
  const L = layoutProject(v, W, scroll, !!opts.panel);
  const src = opts.linkSource ?? null;
  const home = process.env.HOME ?? '';

  g.frame({ x: 0, y: 0, w: W, h: H }, 'anthive', C.inkHi);
  const tt = ` ${v.project.name} `;
  g.put(13, 0, tt, C.link);
  g.put(13 + tt.length, 0, fit(`${G.h} ${v.project.cwd.replace(home, '~')} `, Math.max(0, W - 40 - t.length)), C.dim);
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
  for (const b of L.boxes) {
    if (!vis(b.rect)) continue;
    if (b.node.kind === 'agent') agentBox(g, b.node, b.rect, b.id === selected, b.id === src);
    else if (b.node.kind === 'sub') subBox(g, b.node, b.rect, b.id === selected, b.id === src);
    else itemBox(g, b.node, b.rect, b.id === selected, b.id === src);
  }
  // the stem from an agent to its subagents, in the margin the indent leaves free
  for (const b of L.boxes) {
    if (b.node.kind !== 'agent') continue;
    const subs = L.boxes.filter((s) => s.node.kind === 'sub' && s.node.agent === b.id);
    if (!subs.length) continue;
    const x = b.rect.x + 1, last = subs[subs.length - 1]!.rect.y + 1;
    for (let y = b.rect.y + b.rect.h; y < last; y++) if (y >= top && y <= bottom) g.put(x, y, G.v, C.frame);
    for (const s of subs) { const y = s.rect.y + 1; if (y >= top && y <= bottom) { g.put(x, y, s === subs[subs.length - 1] ? G.bl : G.teeL, C.frame); g.put(x + 1, y, G.h, C.frame); } }
  }
  // linhas depois das caixas: elas encostam nas bordas, nunca entram
  const rectOf = (id: string) => L.boxes.find((b) => b.id === id)?.rect;
  for (const p of L.paths) {
    const e = v.edges.find((x) => x.from === p.from && x.to === p.to);
    if (!e) continue;
    const inside = p.cells.filter(([, y]) => y >= top && y <= bottom);
    if (!inside.length) continue;
    const target = rectOf(p.to);
    drawPath(g, { ...p, cells: inside }, e, W, !!target && vis(target));
  }
  // pulso: do agente para a ligação, uma célula por frame
  const tick = opts.tick ?? -1;
  if (tick >= 0) {
    for (const p of L.paths) {
      const from = v.nodes.find((n) => n.id === p.from);
      if (from?.kind !== 'agent') continue;
      const cells = p.cells.filter(([, y]) => y >= top && y <= bottom);
      if (cells.length < 2) continue;
      const [px, py] = cells[tick % cells.length]!;
      if (g.at(px, py) !== '▸') g.put(px, py, G.running, C.inkHi);
    }
  }
  // prévia da ligação
  if (src && selected && src !== selected) {
    const a = L.boxes.find((b) => b.id === src)?.rect, b = L.boxes.find((x) => x.id === selected)?.rect;
    if (a && b && a.x !== b.x) {
      const [l, r] = a.x < b.x ? [a, b] : [b, a];
      const y = l.y + 2;
      for (let x = l.x + l.w; x < r.x - 1; x++) g.put(x, y, G.dH, C.hold);
      g.put(r.x - 1, y, '▸', C.hold);
    }
  }

  const selNode = selected ? v.nodes.find((n) => n.id === selected) : undefined;
  if (opts.panel && panelFits(W) && selNode) drawNodePanel(g, v, selNode, top + 1, bottom);
  g.put(0, H - 3, G.teeL + G.h.repeat(W - 2) + G.teeR, C.frame);
  const all = L.boxes.map((b) => b.rect);
  scrollHint(g, H - 3, all.filter((r) => r.y < top).length, all.filter((r) => r.y + r.h - 1 > bottom).length);
  if (src) {
    const name = (id: string) => { const n = v.nodes.find((x) => x.id === id); return n ? nodeName(n) : '?'; };
    keybar(g, H - 2, [[`${G.tool} ${t('link')}`, `${name(src)} ${G.arrow} ${selected && selected !== src ? name(selected) : '…'}`], [t('arrows'), t('choose')], ['↵', t('confirm')], ['esc', t('cancel')]], '', `${G.tool} ${t('link')}`);
    return;
  }
  keybar(g, H - 2, [['↑↓←→', t('navigate')], ['↵', t('open')], ['n', t('new')], ['l', t('link')], ['d', t('remove')], ['s', t('select')], [']', t('panel')], ['esc', t('projects')], ['q', t('quit')]], status);
}
