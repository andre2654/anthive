/**
 * A tela do projeto: agentes à esquerda, contexto à direita, relações no meio.
 *
 * Cada ligação sai do agente, atravessa a calha numa faixa própria e entra no
 * item com uma seta. Conversa entre agentes é traço grosso com o turno.
 * O pulso corre do agente para o que ele está ligado.
 */
import { Grid, Rect } from '../tui/grid.ts';
import { browserShort, snapshotRefs, modeLabel, TASK_GLYPH, TASK_COLOR, TASK_LABEL } from './item.ts';
import { t } from '../i18n.ts';
export { snapshotRefs };
import { C, G, BG, RGB, sparkline, ago, tok, pad, padStart, fit, strong, plain, plainMd } from '../tui/theme.ts';
import { State, windowOf } from '../core/sessions.ts';
import { View, Node, Edge, AgentNode, TaskNode, projectName, SubNode, WroteNode, NoteNode } from '../core/project.ts';
import { threadState } from '../core/store.ts';
import { summary as approvalSummary, type Request } from '../core/approvals.ts';
import { relTo } from '../core/written.ts';
import { windowOf as winOf } from '../core/sessions.ts';
import { renderMd } from '../tui/markdown.ts';
import { gauge } from '../tui/theme.ts';
import { keybar, scrollHint, surface } from './chrome.ts';

export const AGENT_H = 4, AGENT_TALL = 6;   // a caixa: nome e estado, o que faz, conversas e ligações, atividade; alta ganha ferramentas e tarefas
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
    const doing = plainMd(n.session?.lastText.replace(/^(\w+ )?cd \S+\s*(&&\s*)?/, '$1') ?? '');
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
export interface Need { kind: 'approval' | 'stuck' | 'exhausted'; text: string; color: RGB; req?: Request; action: string }
export interface Box { id: string; rect: Rect; node: Node; row?: LedgerRow; hang?: boolean; parent?: string; folded?: { notes: number; wrote: number; tasks: number; outcome?: NoteNode }; more?: number; need?: Need }
export interface ProjectLayout {
  boxes: Box[];
  heads: { y: number; title: string; x: number; w: number }[];
  paths: Path[];
  leftW: number; rightX: number; rightW: number;
  height: number;
}
/** Quantos itens um agente em atividade mostra antes de dobrar o resto numa linha `+N more`. */
export const HANG_CAP = 3;
export interface Fold { unfolded: Set<string>; approvals?: Request[] }

/** O agente com quem todos falam, quando existe um: estritamente o de mais conversas, pelo menos duas. */
export function hubOf(v: View, agents: AgentNode[]): AgentNode | null {
  const talks = new Map<string, number>();
  for (const e of v.edges) if (e.kind === 'talk') for (const id of [e.from, e.to]) talks.set(id, (talks.get(id) ?? 0) + 1);
  const ranked = agents.map((a) => ({ a, n: talks.get(a.id) ?? 0 })).sort((x, y) => y.n - x.n);
  const top = ranked[0];
  return top && top.n >= 2 && (!ranked[1] || ranked[1].n < top.n) ? top.a : null;
}
/** De quem é a nota: do único leitor, ou do outro leitor quando o hub é um de dois. Mais largo que isso é de todos. */
export function ownerOf(n: NoteNode, agents: AgentNode[], hub: AgentNode | null): AgentNode | null {
  const readers = n.doc.acl.filter((name) => agents.some((a) => a.name === name));
  if (readers.length === 1) return agents.find((a) => a.name === readers[0]) ?? null;
  if (readers.length === 2 && hub && readers.includes(hub.name)) return agents.find((a) => a.name === readers.find((r) => r !== hub.name)) ?? null;
  return null;
}
/** Concluído: dormindo há uma hora ou mais, sem conversa ainda aberta. O hub nunca: é com ele que você fala. */
export const isDone = (a: AgentNode, v: View, hub: AgentNode | null = null) => a !== hub && a.session?.state === 'sleeping' && !v.edges.some((e) => e.kind === 'talk' && (e.from === a.id || e.to === a.id) && !!e.thread && threadState(e.thread).state === 'open');
/** O que uma nota é, lido do título: os agentes chamam as suas de brief, report e review round. */
export function noteKind(title: string): { glyph: string; label: string } {
  const s = title.toLowerCase();
  if (/^research:/.test(s)) return { glyph: G.note, label: t('research') };
  if (/\bbrief\b/.test(s)) return { glyph: '▹', label: t('brief') };
  if (/\b(close-?out|report|final|deliver(y|ed)|shipped|outcome|pushed)\b/.test(s)) return { glyph: '◈', label: t('report') };
  if (/\b(review|round \d)/.test(s)) return { glyph: '↻', label: t('review') };
  return { glyph: G.note, label: '' };
}

function ledgerRow(n: Node, v: View, home: string): LedgerRow | null {
  const agents = v.nodes.filter((m): m is AgentNode => m.kind === 'agent');
  if (n.kind === 'note') { const k = noteKind(n.doc.title); const who = n.doc.acl.length > 2 ? t('{0} readers', n.doc.acl.length) : t('read by {0}', n.doc.acl.join(', ')); return { text: `${k.glyph} ${plain(n.doc.title)}`, meta: `${k.label ? k.label + ' · ' : ''}${n.doc.ttl ? t('ephemeral') + ' · ' : ''}${n.doc.acl.length ? who : t('nobody reads it')}`, color: C.link }; }
  if (n.kind === 'task') return { text: `${TASK_GLYPH(n.task.status)} ${n.task.subject}`, meta: `${TASK_LABEL(n.task.status)}${(() => { const a = agents.find((x) => x.id === n.agent); return a ? ` · ${a.name}` : ''; })()}`, color: TASK_COLOR(n.task.status) };
  if (n.kind === 'browser') { const st = n.state; return { text: st.busy ? `${G.running} ${browserShort(st.lastTool ?? 'browser_')}…` : `▣ chrome (${modeLabel(n.item.mode)})${st.live ? ` ${G.running} ${t('live')}` : ''}  ${G.h}  ${st.title || t('no page yet')}`, meta: '', color: st.busy ? C.hold : st.url ? C.run : C.dim, second: st.url || t('link an agent (l) and ask it to browse') }; }
  if (n.kind === 'wrote') { const a = agents.find((x) => x.id === n.agent); return { text: `${n.group.length ? '▦' : '▥'} ${n.label}`, meta: n.group.length ? `${t('{0} files', n.group.length)} · ${a?.name ?? t('seen')}` : `${a?.name ?? t('seen')} · ${ago(Date.now() - n.ts)}`, color: n.how === 'seen' ? C.dim : C.ink }; }
  if (n.kind === 'file') return { text: `${n.item.dir ? '▦' : n.item.context ? '▤' : '▤'} ${n.item.label}${n.item.dir ? '/' : ''}`, meta: n.item.context ? t('context') : n.exists ? n.item.path.slice(0, -n.item.label.length).replace(home, '~') : t('gone'), color: n.exists ? C.ink : C.dead };
  if (n.kind === 'service') return { text: `◎ ${n.item.name}${n.item.port ? `:${n.item.port}` : ''}`, meta: `${n.alive ? t('alive') : t('dead')} · pid ${n.item.pid}`, color: n.alive ? C.run : C.dead };
  return null;
}

/**
 * O mapa: à esquerda os agentes, e pendurado em cada um o que é dele — os
 * subagentes, as tarefas, as notas que só ele e o hub leem, o que produziu.
 * Agente em atividade mostra os itens mais novos e dobra o resto numa linha;
 * agente concluído é uma linha só, até o espaço abrir. À direita, o que é de
 * todos: notas lidas por mais gente, o browser, arquivos e serviços.
 */
export function layoutProject(v: View, W: number, scroll = 0, panel = false, H = 40, fold: Fold = { unfolded: new Set() }): ProjectLayout {
  const pw = panel && panelFits(W) ? panelW(W) : 0;
  const avail = W - 4 - pw;
  const home = process.env.HOME ?? '';
  const agents = v.nodes.filter((n): n is AgentNode => n.kind === 'agent');
  const aH = agentH(v, H);
  const leftW = agentW(v, Math.max(24, Math.floor((avail - GUTTER) / 2)));
  const rightX = 2 + leftW + GUTTER;
  const rightW = W - 2 - rightX - pw;
  const boxes: Box[] = [];
  const heads: ProjectLayout['heads'] = [];

  const subsOf = (id: string) => v.nodes.filter((n): n is SubNode => n.kind === 'sub' && n.agent === id);
  const notes = v.nodes.filter((n): n is NoteNode => n.kind === 'note');
  const hub = hubOf(v, agents);
  const owner = new Map<string, string>();
  for (const n of notes) { const o = ownerOf(n, agents, hub); if (o) owner.set(n.id, o.id); }
  // o que pende de um agente: as tarefas primeiro, depois notas e arquivos produzidos, do mais novo ao mais velho
  const itemsOf = (a: AgentNode): Node[] => {
    const tasks = v.nodes.filter((n): n is TaskNode => n.kind === 'task' && n.agent === a.id);
    const dated: { n: Node; ts: number }[] = [
      ...notes.filter((n) => owner.get(n.id) === a.id).map((n) => ({ n: n as Node, ts: n.doc.created })),
      ...v.nodes.filter((n): n is WroteNode => n.kind === 'wrote' && n.agent === a.id).map((n) => ({ n: n as Node, ts: n.ts })),
    ];
    return [...tasks, ...dated.sort((x, y) => y.ts - x.ts).map((x) => x.n)];
  };
  const attention = (a: AgentNode) => a.session?.state === 'waiting' || a.session?.state === 'stuck';
  const working = agents.filter((a) => !isDone(a, v, hub)).sort((a, b) => Number(attention(b)) - Number(attention(a)));
  const asleep = agents.filter((a) => isDone(a, v, hub)).sort((a, b) => (b.session?.mtime ?? 0) - (a.session?.mtime ?? 0));

  // o que precisa de você vem antes de tudo: pedidos de permissão, agentes travados, conversas sem turnos
  const needRows: { id: string; node: Node; need: Need }[] = [];
  for (const r of fold.approvals ?? []) { const a = agents.find((x) => x.name === r.agent); if (a) needRows.push({ id: `need-approval-${r.id}`, node: a, need: { kind: 'approval', text: `${G.waiting} ${t('{0} asks to run {1}', a.name, r.tool)}: ${approvalSummary(r.tool, r.input)}`, color: C.hold, req: r, action: t('decide') } }); }
  for (const a of agents) if (a.session?.state === 'stuck') needRows.push({ id: `need-stuck-${a.id}`, node: a, need: { kind: 'stuck', text: `${G.stuck} ${t('{0} stuck for {1} on {2}', a.name, ago(a.session.ageMs), a.session.pendingTool ?? '?')}`, color: C.dead, action: t('chat') } });
  for (const e of v.edges) {
    if (e.kind !== 'talk' || !e.thread) continue;
    const st = threadState(e.thread); if (st.state !== 'exhausted') continue;
    const a = agents.find((x) => x.id === e.from), b = agents.find((x) => x.id === e.to); if (!a || !b) continue;
    needRows.push({ id: `need-thread-${e.thread.id}`, node: a, need: { kind: 'exhausted', text: `${G.pause} ${t('{0} ⇄ {1} out of turns {2}/{3}', a.name, b.name, st.turn, st.budget)}${e.thread.goal ? ` · ${plain(e.thread.goal)}` : ''}`, color: C.hold, action: t('chat') } });
  }
  let y = 3 - scroll;
  if (needRows.length) {
    heads.push({ y, title: `${t('needs you')} ${needRows.length}`, x: 2, w: W - 4 - pw }); y += 1;
    for (const r of needRows) { boxes.push({ id: r.id, rect: { x: 2, y, w: W - 4 - pw, h: 1 }, node: r.node, need: r.need }); y += 1; }
    y += 1;
  }
  const columnsTop = y;
  const place = (a: AgentNode, full: boolean) => {
    boxes.push({ id: a.id, rect: { x: 2, y, w: leftW, h: aH }, node: a }); y += aH;
    for (const s of subsOf(a.id)) { boxes.push({ id: s.id, rect: { x: 2 + SUB_INDENT, y, w: leftW - SUB_INDENT, h: SUB_H }, node: s, parent: a.id }); y += SUB_H; }
    const items = itemsOf(a);
    const shown = full || fold.unfolded.has(a.id) ? items : items.slice(0, HANG_CAP);
    for (const n of shown) { boxes.push({ id: n.id, rect: { x: 2 + SUB_INDENT, y, w: leftW - SUB_INDENT, h: 1 }, node: n, hang: true, parent: a.id }); y += 1; }
    if (shown.length < items.length) { boxes.push({ id: `more-${a.id}`, rect: { x: 2 + SUB_INDENT, y, w: leftW - SUB_INDENT, h: 1 }, node: a, hang: true, parent: a.id, more: items.length - shown.length }); y += 1; }
    y += 1;
  };
  if (working.length && asleep.length) { heads.push({ y, title: `${t('working')} ${working.length}`, x: 2, w: leftW }); y += 1; }
  for (const a of working) place(a, false);
  if (asleep.length) {
    heads.push({ y, title: `${t('done')} ${asleep.length}  ${G.h}  ${t('space unfolds')}`, x: 2, w: leftW }); y += 1;
    for (const a of asleep) {
      if (fold.unfolded.has(a.id)) { place(a, true); continue; }
      const items = itemsOf(a);
      const notesOf = items.filter((n): n is NoteNode => n.kind === 'note');
      const outcome = notesOf.find((n) => noteKind(n.doc.title).label === t('report')) ?? notesOf[0];   // o resultado: o relatório mais novo, senão a nota mais nova
      boxes.push({ id: a.id, rect: { x: 2, y, w: leftW, h: 1 }, node: a, folded: { notes: notesOf.length, wrote: items.filter((n) => n.kind === 'wrote').length, tasks: items.filter((n) => n.kind === 'task').length, outcome } }); y += 1;
    }
    y += 1;
  }
  const leftBottom = y;

  // direita: o que é de todos, por seção
  y = columnsTop;
  const section = (title: string, items: Node[]) => {
    if (!items.length) return;
    heads.push({ y, title, x: rightX, w: rightW }); y += 1;
    for (const n of items) {
      const row = ledgerRow(n, v, home); if (!row) continue;
      const h = row.second ? 2 : 1;
      boxes.push({ id: n.id, rect: { x: rightX, y, w: rightW, h }, node: n, row }); y += h;
    }
    y += 1;
  };
  const shared = notes.filter((n) => !owner.has(n.id));
  section(`${t('notes')} ${shared.length}`, shared);
  const browsers = v.nodes.filter((n) => n.kind === 'browser'); section('browser', browsers);
  const loose = v.nodes.filter((n): n is WroteNode => n.kind === 'wrote' && !n.agent); section(`${t('produced')} ${loose.length}`, loose);
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
  const s = n.session, inner = r.w - 4, x0 = r.x + 2;
  const state: State = s ? s.state : 'idle';
  g.panel(r, on || src ? BG.sel : BG.panel);
  if (on || src || lit) for (let y = r.y; y < r.y + r.h; y++) g.put(r.x, y, '▎', src ? C.hold : C.link);
  // primeira linha: nome, estado e há quanto tempo; numa caixa estreita a idade cede a vez ao nome
  const stateLabel = `${GLYPH[state]} ${LABEL(state)}`;
  const pillBg = state === 'running' ? BG.run : state === 'waiting' ? BG.hold : state === 'stuck' ? BG.dead : null;   // estado que pede olho vira pílula
  const pillW = [...stateLabel].length + (pillBg ? 2 : 0);
  const age = s && [...n.name].length + pillW + ago(s.ageMs).length + 6 <= inner ? ago(s.ageMs) : '';
  const rightW = pillW + (age ? age.length + 2 : 0);
  g.put(x0, r.y, fit(n.name, Math.max(4, inner - rightW - 2)), strong(src ? C.hold : on ? C.link : C.inkHi));
  if (pillBg) g.put(r.x + r.w - 2 - rightW, r.y, ` ${stateLabel} `, COLOR[state], pillBg); else g.put(r.x + r.w - 2 - rightW, r.y, stateLabel, COLOR[state]);
  if (age) g.put(r.x + r.w - 2 - age.length, r.y, age, C.dim);
  // a história do agente, legível
  const doing = plainMd(s?.lastText.replace(/^(\w+ )?cd \S+\s*(&&\s*)?/, '$1') ?? '');
  const inflight = s?.state === 'running' && s.pendingTool ? `${G.tool} ${s.pendingTool}${s.pendingInput ? ' ' + s.pendingInput : ''}` : '';
  const summary = s?.state === 'waiting' || s?.state === 'stuck' ? `${G.pause} ${s.pendingTool ?? '?'}` : inflight || doing || (n.item ? t('no session — ↵ opens the chat') : '');
  g.put(x0, r.y + 1, fit(summary, inner), s?.state === 'waiting' ? C.hold : inflight ? C.dim : doing ? C.ink : C.dim);
  // conversas com outros agentes, com o estado de cada uma, e o que está ligado: era isso que os fios tentavam dizer
  const talksAll = v.edges.filter((e) => e.kind === 'talk' && (e.from === n.id || e.to === n.id)).map((e) => {
    const o = v.nodes.find((m) => m.id === (e.from === n.id ? e.to : e.from)); const st = e.thread ? threadState(e.thread) : null;
    const who = o && o.kind === 'agent' ? o.name : '?';
    if (!st) return { text: `${G.swap} ${who}`, color: C.link, done: false };
    if (st.state === 'concluded') return { text: `${G.swap} ${who} ${G.running}`, color: C.dim, done: true };
    if (st.state === 'exhausted') return { text: `${G.swap} ${who} ${st.turn}/${st.budget} ${G.pause}`, color: C.hold, done: false };
    return { text: `${G.swap} ${who} ${st.turn}/${st.budget}`, color: C.link, done: false };
  });
  // as conversas abertas uma a uma; as concluídas, quando são muitas, viram uma contagem
  const doneT = talksAll.filter((x) => x.done);
  const talks = [...talksAll.filter((x) => !x.done), ...(doneT.length > 2 ? [{ text: `${G.swap} ${doneT.length} ${t('done')}`, color: C.dim }] : doneT)];
  const kinds = [...neighbours(v, n.id)].map((id) => v.nodes.find((m) => m.id === id)?.kind).filter(Boolean) as Node['kind'][];
  const counts: { text: string; color: RGB }[] = [];
  for (const [k, glyph] of [['note', G.note], ['wrote', '▦'], ['file', '▤'], ['browser', '▣'], ['service', '◎']] as const) { const c = kinds.filter((x) => x === k).length; if (c) counts.push({ text: `${glyph} ${c}`, color: C.dim }); }
  const open = tasks.filter((k) => k.task.status !== 'completed'), doingT = open.find((k) => k.task.status === 'in_progress');
  const taskLine = doingT ? { text: `${G.focus} ${doingT.task.active || doingT.task.subject}`, color: C.hold } : open.length ? { text: t('{0} tasks open', open.length), color: C.dim } : tasks.length ? { text: t('all tasks done'), color: C.dim } : null;
  const segs = [...talks, ...counts];
  if (!segs.length && taskLine && r.h < AGENT_TALL) segs.push(taskLine);   // sem ligações, a caixa baixa mostra a tarefa nessa linha
  if (!segs.length) segs.push({ text: t('nothing linked — l links'), color: C.frame });
  {
    let x = x0;
    for (const sg of segs) { const w = [...sg.text].length; if (x + w > x0 + inner) { g.put(x, r.y + 2, G.ell, C.frame); break; } g.put(x, r.y + 2, sg.text, sg.color); x += w + 2; }
  }
  if (r.h >= AGENT_TALL) {
    const recent = (s?.recent ?? []).slice(-3).map((x) => x.split(' ')[0]).join(' · ');
    g.put(x0, r.y + 3, fit(recent ? `${G.tool} ${recent}` : '', inner), C.dim);
    if (taskLine) g.put(x0, r.y + 4, fit(taskLine.text, inner), taskLine.color);
  }
  // última linha: a atividade enquanto roda, o branch quando parado; o contexto à direita
  const gy = r.y + r.h - 1;
  const branch = n.item?.worktree ?? (s?.branch && s.branch !== 'HEAD' ? s.branch : '');
  const win = s ? windowOf(s.model, s.context) : 0;
  const pct = s?.context ? Math.round((100 * s.context) / win) : -1;
  const ctxLabel = pct >= 0 ? ` ${pct}%` : '', barW = pct >= 0 ? 6 : 0;
  const sw = Math.max(4, inner - (pct >= 0 ? barW + [...ctxLabel].length + 2 : 0));
  if (state === 'running' || state === 'waiting') g.put(x0, gy, sparkline(s?.spark ?? [], sw), SPARK[state]);
  else g.put(x0, gy, fit(branch, sw), C.linkDim);
  if (pct >= 0) { const bx = x0 + sw + 2, full = Math.round((Math.min(100, pct) / 100) * barW); g.put(bx, gy, '━'.repeat(full), pct > 85 ? C.hold : C.run); g.put(bx + full, gy, '─'.repeat(barW - full), C.frame); g.put(bx + barW, gy, ctxLabel, pct > 85 ? C.hold : C.dim); }
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
  const s = n.sub, inner = r.w - 4, x0 = r.x + 2;
  // duas linhas pintadas e uma de respiro, para caixas empilhadas não virarem um bloco só
  g.panel({ x: r.x, y: r.y, w: r.w, h: 2 }, on || src ? BG.sel : BG.panel);
  if (on || src) for (let y = r.y; y < r.y + 2; y++) g.put(r.x, y, '▎', src ? C.hold : C.link);
  const st = subState(s);
  const right = s.tokens ? tok(s.tokens) : '';
  g.put(x0, r.y, fit(`${G.sub} ${s.name}`, Math.max(4, inner - (right ? right.length + 2 : 0))), strong(on ? C.link : C.inkHi));
  if (right) g.put(x0 + inner - right.length, r.y, right, C.dim);
  const quiet = !s.done && s.ageMs > 60_000 && s.ageMs < Infinity ? `  ${ago(s.ageMs)}` : '';   // a subagent writes a line per step: silence is worth seeing
  const what = !s.done && !s.bg && !s.error && !s.silent && !s.orphan && s.now ? s.now + quiet : st.label;
  g.put(x0, r.y + 1, fit(`${st.glyph} ${what}`, inner), st.color);
  g.hit(n.id, r);
}

/** Um item pendurado no agente: nota com o que ela é, tarefa com o estado, arquivo produzido. O galho vem do agente. */
function hangRow(g: Grid, n: Node, r: Rect, on: boolean, lit: boolean) {
  if (on) g.fill({ x: r.x - SUB_INDENT + 1, y: r.y, w: r.w + SUB_INDENT - 1, h: 1 }, BG.sel);
  let text = '', meta = '', color: RGB = C.link;
  if (n.kind === 'note') { const k = noteKind(n.doc.title); text = `${k.glyph} ${plain(n.doc.title)}`; meta = [k.label, n.doc.ttl ? t('ephemeral') : '', ago(Date.now() - n.doc.created)].filter(Boolean).join(' · '); }
  else if (n.kind === 'task') { text = `${TASK_GLYPH(n.task.status)} ${n.task.subject}`; meta = TASK_LABEL(n.task.status); color = TASK_COLOR(n.task.status); }
  else if (n.kind === 'wrote') { text = `${n.group.length ? '▦' : '▥'} ${n.label}`; meta = n.group.length ? t('{0} files', n.group.length) : ago(Date.now() - n.ts); color = n.how === 'seen' ? C.dim : C.ink; }
  else text = nodeName(n);
  const mw = Math.min(Math.floor(r.w * 0.4), [...meta].length);
  g.put(r.x + 1, r.y, fit(text, Math.max(4, r.w - mw - 3)), on || lit ? strong(C.inkHi) : color);
  if (mw) g.put(r.x + r.w - mw, r.y, fit(meta, mw), C.dim);
  g.hit(n.id, r);
}

/** Um agente concluído numa linha: estado, nome, há quanto dorme, branch e o que deixou. */
function foldRow(g: Grid, n: AgentNode, r: Rect, on: boolean, src: boolean, lit: boolean, left: NonNullable<Box['folded']>, nameW: number) {
  if (on || src) g.fill(r, BG.sel);
  if (on || src || lit) g.put(r.x, r.y, '▎', src ? C.hold : C.link);
  const s = n.session, state: State = s ? s.state : 'idle';
  const counts = left.outcome ? '' : [left.tasks ? `${G.focus} ${left.tasks}` : '', left.notes ? `${G.note} ${left.notes}` : '', left.wrote ? `▦ ${left.wrote}` : ''].filter(Boolean).join('  ');
  const branch = n.item?.worktree ?? (s?.branch && s.branch !== 'HEAD' ? s.branch : '');
  // o que ficou: o título do relatório mais novo, sem repetir o nome do agente na frente; sem nota, o branch
  const out = left.outcome;
  const what = out ? `${noteKind(out.doc.title).glyph} ${plain(out.doc.title).replace(new RegExp(`^${n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-:·#]?\\s*`, 'i'), '')}` : branch;
  let x = r.x + 2;
  g.put(x, r.y, GLYPH[state], COLOR[state]); x += 2;
  g.put(x, r.y, pad(n.name, nameW), on ? strong(C.inkHi) : C.link); x += nameW + 1;
  g.put(x, r.y, pad(s ? ago(s.ageMs) : '', 6), C.dim); x += 7;
  const cw = [...counts].length;
  g.put(x, r.y, fit(what, Math.max(0, r.x + r.w - 2 - x - (cw ? cw + 2 : 0))), out ? (on ? C.inkHi : C.ink) : C.linkDim);
  if (cw) g.put(r.x + r.w - 2 - cw, r.y, counts, C.dim);
  g.hit(n.id, r);
}

/** Uma linha do que precisa de você: o pedido, em cor de alerta, e o que ↵ faz com ele. */
function needRow(g: Grid, b: Box, on: boolean) {
  const r = b.rect, nd = b.need!;
  g.panel(r, on ? BG.sel : BG.panel);
  if (on) g.put(r.x, r.y, '▎', C.link);
  const act = `↵ ${nd.action}`;
  g.put(r.x + 2, r.y, fit(nd.text, Math.max(4, r.w - 4 - [...act].length - 2)), on ? strong(C.inkHi) : nd.color);
  g.put(r.x + r.w - 2 - [...act].length, r.y, act, C.dim);
  g.hit(b.id, r);
}

/** A linha que fecha a lista dobrada de um agente: quantos itens faltam e como vê-los. */
function moreRow(g: Grid, b: Box, on: boolean) {
  const r = b.rect;
  if (on) g.fill({ x: r.x - SUB_INDENT + 1, y: r.y, w: r.w + SUB_INDENT - 1, h: 1 }, BG.sel);
  g.put(r.x + 1, r.y, fit(`+${b.more} ${t('more')}  ${G.h}  ${t('space shows all')}`, r.w - 2), on ? C.inkHi : C.dim);
  g.hit(b.id, r);
}

/** Uma linha do razão: o item à esquerda, o dado que importa à direita; aceso quando liga ao selecionado. */
function ledgerLine(g: Grid, b: ProjectLayout['boxes'][number], on: boolean, src: boolean, lit: boolean) {
  const r = b.rect, row = b.row!;
  if (on || src) g.fill(r, BG.sel);
  if (lit && !on) g.fill({ x: r.x - 1, y: r.y, w: r.w + 1, h: r.h }, BG.panel);
  if (lit || on) g.put(r.x - 1, r.y, '▎', src ? C.hold : C.link);
  const mw = Math.min(Math.floor(r.w / 2), [...row.meta].length);
  g.put(r.x + 1, r.y, fit(row.text, Math.max(4, r.w - mw - 3)), on || lit ? strong(C.inkHi) : row.color);
  if (mw) g.put(r.x + r.w - mw, r.y, fit(row.meta, mw), on || lit ? C.ink : C.dim);
  if (row.second) g.put(r.x + 3, r.y + 1, fit(row.second, r.w - 4), C.dim);
  g.hit(b.id, r);
}

const nodeName = (n: Node) => n.kind === 'agent' ? n.name : n.kind === 'note' ? plain(n.doc.title) : n.kind === 'file' ? n.item.label : n.kind === 'task' ? n.task.subject : n.kind === 'sub' ? n.sub.name : n.kind === 'wrote' ? n.label : n.kind === 'browser' ? 'browser' : n.item.name;

/** Painel à direita: o que vale saber do nó selecionado sem entrar nele, e no rodapé o que as teclas fazem com ele. */
function drawNodePanel(g: Grid, v: View, n: Node, top: number, bottom: number, hint: string) {
  const x = g.W - panelW(g.W) + 2, w = g.W - 2 - x;
  let y = top;
  g.panel({ x: x - 1, y: top, w: w + 2, h: bottom - top + 1 }, BG.panel);
  for (let yy = top; yy <= bottom; yy++) g.put(x - 2, yy, G.v, C.frame);
  const head = (t: string) => { if (y <= bottom) { g.put(x, y, t, C.link); g.put(x + t.length + 1, y, G.h.repeat(Math.max(0, w - t.length - 1)), C.frame); } y++; };
  const row = (k: string, val: string, col: RGB = C.ink) => { if (y <= bottom) { g.put(x, y, pad(k, 9), C.dim); g.put(x + 9, y, fit(val, w - 9), col); } y++; };
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
    row(t('kind'), noteKind(n.doc.title).label || t('note'));
    row(t('title'), plain(n.doc.title), C.inkHi);
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
  if (y <= bottom) g.put(x, bottom, fit(hint, w), C.dim);
}

export interface ProjectOpts { linkSource?: string | null; tick?: number; query?: string; panel?: boolean; unfolded?: Set<string>; approvals?: Request[] }

/** What ↵, l and d do with each kind of node: the panel says it, so nobody has to guess. */
const HINTS: Record<Node['kind'], string> = {
  agent: '↵ chat · l link · d remove', note: '↵ read · l link · d delete', file: '↵ open · l link · d unlink', task: '↵ open · l link',
  sub: '↵ watch', wrote: '↵ open · l pin · d refuse', browser: '↵ watch · l link · d remove', service: '↵ open · l link · d remove',
};

export function renderProject(g: Grid, v: View, selected: string | null, scroll: number, status: string, opts: ProjectOpts = {}) {
  const { W, H } = g;
  const top = 3, bottom = H - 3;
  const fold: Fold = { unfolded: opts.unfolded ?? new Set(), approvals: opts.approvals };
  const L = layoutProject(v, W, scroll, !!opts.panel, H, fold);
  const src = opts.linkSource ?? null;
  const home = process.env.HOME ?? '';

  surface(g, `anthive / ${v.project.name}`, v.project.cwd.replace(home, '~'));
  const agents = v.nodes.filter((n): n is AgentNode => n.kind === 'agent');
  const running = agents.filter((n) => n.session?.state === 'running').length;
  const waiting = agents.filter((n) => n.session?.state === 'waiting' || n.session?.state === 'stuck').length;
  // pílulas no cabeçalho: quantos rodam, quantos precisam de você
  const needs = L.boxes.filter((b) => b.need).length;
  const pills: [string, RGB, RGB][] = [];
  if (running) pills.push([` ${G.running} ${t('{0} running', running)} `, C.run, BG.run]);
  if (needs || waiting) pills.push([` ${G.waiting} ${t('{0} need you', Math.max(needs, waiting))} `, C.hold, BG.hold]);
  let px = W - 2;
  for (const [text, color, bg] of pills.reverse()) { px -= [...text].length; g.put(px, 0, text, color, bg); px -= 1; }
  const subs = v.nodes.filter((n) => n.kind === 'sub').length;
  g.put(2, 2, `${t('Agents · {0}', agents.length)}${subs ? ` · ${subs === 1 ? t('1 subagent') : t('{0} subagents', subs)}` : ''}`, strong(C.inkHi));
  g.put(L.rightX, 2, `${t('Shared')} · ${L.boxes.filter((b) => b.row).length}`, strong(C.inkHi));

  const vis = (r: Rect) => r.y >= top && r.y + r.h - 1 <= bottom;
  if (!v.nodes.length) {
    const msg = t('Start with an agent. Press n to add one.');
    g.put(Math.max(2, Math.floor((W - msg.length) / 2)), Math.floor(H / 2), msg, C.dim);
  }
  // o que acende: os vizinhos do selecionado (ou da origem de uma ligação em curso)
  const lit = neighbours(v, src ?? selected);
  for (const h of L.heads) if (h.y >= top && h.y <= bottom) { g.put(h.x, h.y, `${h.title} `, C.link); g.put(h.x + [...h.title].length + 1, h.y, G.h.repeat(Math.max(0, h.w - [...h.title].length - 1)), C.frame); }
  const foldNameW = Math.min(16, Math.max(8, ...L.boxes.filter((b) => b.folded).map((b) => [...nodeName(b.node)].length)));
  for (const b of L.boxes) {
    if (!vis(b.rect)) continue;
    const on = b.id === selected, isSrc = b.id === src, isLit = lit.has(b.id);
    if (b.need) needRow(g, b, on);
    else if (b.more) moreRow(g, b, on);
    else if (b.folded && b.node.kind === 'agent') foldRow(g, b.node, b.rect, on, isSrc, isLit, b.folded, foldNameW);
    else if (b.node.kind === 'agent') agentBox(g, v, b.node, b.rect, on, isSrc, isLit, v.nodes.filter((m): m is TaskNode => m.kind === 'task' && m.agent === b.node.id));
    else if (b.node.kind === 'sub') subBox(g, b.node, b.rect, on, isSrc);
    else if (b.hang) hangRow(g, b.node, b.rect, on, isLit);
    else if (b.row) ledgerLine(g, b, on, isSrc, isLit);
  }
  // o galho de cada agente aberto: dos subagentes e dos itens pendurados, na margem que o recuo deixa livre
  for (const b of L.boxes) {
    if (b.node.kind !== 'agent' || b.folded || b.more || b.need) continue;
    const kids = L.boxes.filter((k) => k.parent === b.id);
    if (!kids.length) continue;
    const x = b.rect.x + 1, last = kids[kids.length - 1]!;
    for (let y = b.rect.y + b.rect.h; y < last.rect.y; y++) if (y >= top && y <= bottom) g.put(x, y, G.v, C.frame);
    for (const k of kids) {
      const y = k.rect.y;
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
    g.put(2 + label.length, hy, G.h.repeat(Math.max(0, W - (opts.panel && panelFits(W) ? panelW(W) : 0) - 4 - label.length)), C.frame);
    const shown = v.moments.slice(-(bottom - hy - 1));
    const who = Math.min(12, Math.max(...shown.map((m) => [...m.who].length)));
    for (let i = 0; i < shown.length; i++) {
      const m = shown[i]!, y = hy + 1 + i;
      if (y > bottom) break;
      const col = m.kind === 'turn' ? C.run : m.kind === 'wrote' ? C.link : C.linkDim;
      const mark = m.kind === 'turn' ? G.running : m.kind === 'wrote' ? '▥' : G.sub;
      const what = m.kind === 'wrote' ? relTo(v.project.cwd, m.what) : plainMd(m.what);
      g.put(2, y, hhmm(m.ts), C.frame);
      g.put(8, y, pad(m.who, who), C.dim);
      g.put(9 + who, y, `${mark} `, col);
      g.put(11 + who, y, fit(what, Math.max(0, W - (opts.panel && panelFits(W) ? panelW(W) : 0) - 13 - who)), m.kind === 'turn' ? C.ink : C.dim);
    }
  }

  // o que o selecionado é e como se mexe nele: no painel e na primeira tecla do rodapé
  const selBox = L.boxes.find((b) => b.id === selected);
  const selNode = selected ? v.nodes.find((n) => n.id === selected) : undefined;
  const agentSel = selBox?.need ? null : selBox?.more ? selBox.parent ?? null : selNode?.kind === 'agent' ? selNode.id : null;
  const hasMore = !!agentSel && L.boxes.some((b) => !!b.more && b.parent === agentSel);
  const canFold = !!agentSel && (!!selBox?.folded || hasMore || fold.unfolded.has(agentSel));
  const foldLabel = selBox?.folded || hasMore ? t('unfold') : t('fold');
  const openLabel = selBox?.need ? selBox.need.action : selBox?.more ? t('show all') : selNode?.kind === 'agent' ? t('chat') : selNode?.kind === 'note' ? t('read') : selNode?.kind === 'sub' || selNode?.kind === 'browser' ? t('watch') : t('open');
  if (opts.panel && panelFits(W) && selNode && !selBox?.need) drawNodePanel(g, v, selNode, 2, bottom, t(HINTS[selNode.kind]));

  const all = L.boxes.map((b) => b.rect);
  scrollHint(g, H - 2, all.filter((r) => r.y < top).length, all.filter((r) => r.y + r.h - 1 > bottom).length);
  const name = (id: string | null) => { const n = id ? v.nodes.find((x) => x.id === id) : null; return n ? nodeName(n) : '…'; };
  if (src) {
    keybar(g, H - 1, [[`${G.tool} ${t('link')}`, `${name(src)} ${G.arrow} ${selected && selected !== src ? name(selected) : '…'}`], [t('arrows'), t('choose')], ['↵', t('confirm')], ['esc', t('cancel')]], '', `${G.tool} ${t('link')}`);
    return;
  }
  keybar(g, H - 1, [['↵', openLabel], ...(canFold ? ([['space', foldLabel]] as [string, string][]) : []), ['n', t('add')], ['l', t('link')], [']', t('details')], ['↑↓←→', t('navigate')], ['d', t('remove')], ['s', t('select text')], ['r', t('refresh')], ['esc', t('projects')], ['q', t('quit')]], status);
}
