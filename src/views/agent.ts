/**
 * O agente por dentro: a árvore do que ele fez, a faixa do que ele está ligado,
 * e uma caixa de escrita de verdade. Turno longo nasce recolhido; o vivo fica
 * aberto. Modelo, esforço e permissão trocam por seletor.
 */
import { Grid } from '../tui/grid.ts';
import { browserTool, AgentNode } from '../core/project.ts';
import { browserShort } from './item.ts';
import { C, G, RGB, BG, gauge, sparkline, ago, tok, fit, pad, padStart } from '../tui/theme.ts';
import { Ev, Session, windowOf } from '../core/sessions.ts';
import { keybar, scrollHint } from './chrome.ts';
import { renderMd, Span } from '../tui/markdown.ts';
import { t } from '../i18n.ts';

export type RowKind = 'turn' | 'child' | 'cont' | 'summary' | 'compact' | 'now' | 'blank';
export type Voice = 'you' | 'agent' | 'thought';
export interface Row { kind: RowKind; turn: string | null; connector: string; glyph: string; gc: RGB; name: string; nc: RGB; detail: string; dc: RGB; right: string; ts: number; showTime: boolean; voice?: Voice; spans?: Span[]; ev?: string }
const BLANK: Row = { kind: 'blank', turn: null, connector: '', glyph: '', gc: C.frame, name: '', nc: C.frame, detail: '', dc: C.frame, right: '', ts: 0, showTime: false };
const COLLAPSE_OVER = 6;

function splitTool(text: string, tool: string, cwd: string): { name: string; detail: string } {
  let detail = text.startsWith(tool) ? text.slice(tool.length).trim() : text;
  if (cwd) detail = detail.replace(new RegExp(`^cd ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(&&\\s*)?`), '');
  return { name: tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool, detail };
}
interface Child { glyph: string; gc: RGB; name: string; nc: RGB; detail: string; dc: RGB; right: string; indent: number; tool?: string; out: number; thinking?: boolean; full?: string; thought?: string; ev?: string }

/** Largura da coluna de texto para uma tela de W colunas — a mesma conta do render. */
export const PANEL_W = 34;
export const panelFits = (W: number) => W >= 110;
export const detailWidth = (W: number, panel = false) => Math.max(8, W - 38 - (panel && panelFits(W) ? PANEL_W : 0));

export { tasksFrom } from '../core/tasks.ts';
export type { Task } from '../core/tasks.ts';
import type { Task } from '../core/tasks.ts';

/** Quebra por palavra, preservando parágrafos; palavra maior que a largura é partida. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, '').split('\n')) {
    if (!para.trim()) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (!line) line = word;
      else if ([...line].length + 1 + [...word].length <= width) line += ' ' + word;
      else { out.push(line); line = word; }
      while ([...line].length > width) { out.push([...line].slice(0, width).join('')); line = [...line].slice(width).join(''); }
    }
    if (line) out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.length ? out : [''];
}

const RESEARCH: Record<string, string> = { WebSearch: 'search', WebFetch: 'fetch', mcp__anthive__project_search: 'hive' };

export function rows(evs: Ev[], cwd = '', expanded: Set<string> = new Set(), width = 60, showThinking = false, agentName = ''): Row[] {
  const out: Row[] = [];
  let turnId: string | null = null, pending: Child[] = [];
  const isHarness = (e: Ev) => e.role === 'user' && !e.tool && !e.meta && /^\s*<(task-notification|system-reminder|local-command-stdout|local-command-caveat)/.test(e.full ?? e.text ?? '');
  const lastTurn = [...evs].reverse().find((e) => e.role === 'user' && !e.tool && e.text && !e.sidechain && !e.meta && !isHarness(e))?.uuid ?? null;
  const flush = () => {
    const live = turnId === lastTurn;
    pending = pending.filter((c, i) => !c.thinking || (live && i === pending.length - 1));
    if (!pending.length) return;
    for (let i = 0; i < pending.length; i++) { const c = pending[i]!, nx = pending[i + 1]; if (nx && nx.right === c.right && nx.out === c.out) { c.right = ''; c.out = 0; } }
    const open = turnId === null || live || expanded.has(turnId) || pending.length <= COLLAPSE_OVER;
    if (!open) {
      const by = new Map<string, number>();
      for (const c of pending) if (c.tool) by.set(c.tool, (by.get(c.tool) ?? 0) + 1);
      const tools = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t}×${n}`).join(' ');
      const spent = pending.reduce((n, c) => n + c.out, 0);
      out.push({ kind: 'summary', turn: turnId, connector: G.branchEnd, glyph: G.tool, gc: C.frame, name: t('{0} actions', pending.length), nc: C.dim, detail: tools ? `${tools}  ${G.h}  ${t('↵ opens')}` : t('↵ opens'), dc: C.frame, right: spent ? tok(spent) : '', ts: 0, showTime: false });
    } else {
      for (let i = 0; i < pending.length; i++) {
        const c = pending[i]!, last = i === pending.length - 1 || pending[i + 1]!.indent < c.indent;
        const conn = (c.indent ? '│  ' : '') + (last ? G.branchEnd : G.branchMid);
        // texto do agente se lê inteiro; comando de ferramenta fica numa linha
        const stem = (c.indent ? '│  ' : '') + (last ? '   ' : '│  ');
        if (c.thought) {
          // raciocínio: texto corrido, apagado, quebrado na largura
          const ls = wrap(c.thought, width);
          out.push({ kind: 'child', turn: turnId, connector: conn, glyph: c.glyph, gc: c.gc, name: c.name, nc: c.nc, detail: ls[0]!, dc: C.frame, right: '', ts: 0, showTime: false, voice: 'thought' });
          for (const l of ls.slice(1)) out.push({ kind: 'cont', turn: turnId, connector: stem, glyph: '', gc: C.frame, name: '', nc: C.frame, detail: l, dc: C.frame, right: '', ts: 0, showTime: false, voice: 'thought' });
          continue;
        }
        if (c.tool || c.thinking) {
          out.push({ kind: 'child', turn: turnId, connector: conn, glyph: c.glyph, gc: c.gc, name: c.name, nc: c.nc, detail: c.detail, dc: c.dc, right: c.right, ts: 0, showTime: false, ev: c.ev, voice: c.thinking ? 'thought' : undefined });
          continue;
        }
        // resposta em markdown: títulos, listas, código e ênfase viram cor
        const md = renderMd(c.full ?? c.detail, width);
        const first = md[0];
        out.push({ kind: 'child', turn: turnId, connector: conn, glyph: c.glyph, gc: c.gc, name: agentName || c.name, nc: agentName ? C.link : c.nc, detail: first ? first.spans.map((x) => x.text).join('') : '', dc: c.dc, right: c.right, ts: 0, showTime: false, voice: 'agent', spans: first?.spans });
        for (const l of md.slice(1)) out.push({ kind: 'cont', turn: turnId, connector: stem, glyph: '', gc: C.frame, name: '', nc: C.frame, detail: l.spans.map((x) => x.text).join(''), dc: c.dc, right: '', ts: 0, showTime: false, voice: 'agent', spans: l.spans });
      }
    }
    out.push(BLANK); pending = [];
  };
  for (const e of evs) {
    const indent = e.sidechain ? 1 : 0;
    if (e.isCompact) { flush(); out.push({ kind: 'compact', turn: null, connector: '', glyph: G.cut, gc: C.hold, name: t('COMPACTION'), nc: C.hold, detail: e.text || t('context compacted'), dc: C.dim, right: '', ts: e.ts, showTime: true }); out.push(BLANK); continue; }
    if (e.type === 'system') continue;
    const harness = e.role === 'user' && !e.tool && !e.meta && /^\s*<(task-notification|system-reminder|local-command-stdout|local-command-caveat)/.test(e.full ?? e.text ?? '');
    if (e.role === 'user' && (e.meta || harness)) {
      // conteúdo que o Claude Code injetou (skill carregada, lembrete de sistema): mostra o que foi, numa linha
      const m = /Base directory for this skill:\s*\S*\/([^\/\s]+)\s*$/m.exec(e.full ?? e.text ?? '');
      const kind = /<task-notification/.test(e.full ?? e.text ?? '') ? t('notification') : t('injected context');
      const what = m ? `skill ${m[1]}` : kind;
      const summ = /<summary>([\s\S]*?)<\/summary>/.exec(e.full ?? e.text ?? '')?.[1]?.replace(/\s+/g, ' ').trim();
      pending.push({ glyph: G.tool, gc: C.hold, name: what.split(' ')[0]!, nc: C.hold, detail: m ? `${m[1]} ${t('loaded')} — ${(e.text ?? '').split('#')[1]?.trim().slice(0, 60) ?? ''}` : (summ ?? e.text ?? '').slice(0, 200), dc: C.dim, right: '', indent, tool: what, out: 0 });
      continue;
    }
    if (e.sidechain && e.role === 'user' && !e.tool) {
      // --forward-subagent-text: the brief a subagent received is a child of the turn, never a turn of its own
      if (e.text) pending.push({ glyph: G.sub, gc: C.link, name: t('brief'), nc: C.link, detail: e.text.slice(0, 200), dc: C.dim, right: '', indent: 1, tool: 'brief', out: 0 });
      continue;
    }
    if (e.role === 'user' && !e.tool) {
      if (!e.text) continue;
      flush(); turnId = e.uuid;
      const ls = wrap(e.full ?? e.text, width);
      out.push({ kind: 'turn', turn: e.uuid, connector: '', glyph: G.running, gc: C.run, name: t('you'), nc: C.run, detail: ls[0]!, dc: C.inkHi, right: '', ts: e.ts, showTime: true, voice: 'you' });
      for (const l of ls.slice(1)) out.push({ kind: 'cont', turn: e.uuid, connector: '', glyph: '', gc: C.frame, name: '', nc: C.frame, detail: l, dc: C.inkHi, right: '', ts: 0, showTime: false, voice: 'you' });
      continue;
    }
    const right = e.usage?.output ? tok(e.usage.output) : '';
    if (showThinking && e.thinking && e.role === 'assistant') {
      pending.push({ glyph: G.tool, gc: C.hold, name: t('thought'), nc: C.hold, detail: e.thinking.replace(/\s+/g, ' ').slice(0, 200), dc: C.frame, right: '', indent, out: 0, thought: e.thinking });
    }
    if (e.tool) {
      const sub = e.tool === 'Agent' || e.tool === 'Task' || e.tool === 'Explore';
      const split = splitTool(e.text ?? e.tool, e.tool, cwd);
      const research = RESEARCH[e.tool];   // search/fetch/hive: purple like subagents, short enough for the name column
      const bg = sub && (e.input as Record<string, unknown> | undefined)?.run_in_background === true;   // dies with the process: worth seeing
      const name = research ?? split.name, detail = bg ? `${t('background')} ${G.h} ${split.detail}` : split.detail;
      const editable = e.tool === 'Edit' || e.tool === 'MultiEdit' || e.tool === 'Write';
      const bt = browserTool(e.tool);
      if (bt) {
        // o agente no browser: o que ele fez e em quê, sem o prefixo
        const inp = (e.input ?? {}) as Record<string, unknown>;
        const what = String(inp.url ?? inp.text ?? inp.element ?? inp.ref ?? inp.key ?? '');
        pending.push({ glyph: '▣', gc: C.run, name: browserShort(bt), nc: C.ink, detail: what, dc: C.dim, right, indent, tool: e.tool, out: e.usage?.output ?? 0, ev: e.uuid });
        continue;
      }
      pending.push({ glyph: sub ? G.sub : G.tool, gc: bg ? C.hold : sub || research ? C.link : editable ? C.run : C.frame, name, nc: bg ? C.hold : sub || research ? C.link : editable ? C.ink : C.dim, detail: editable ? `${detail}  ${G.h}  ↵ diff` : detail, dc: C.dim, right, indent, tool: name, out: e.usage?.output ?? 0, ev: e.uuid });
    } else if (e.text) pending.push({ glyph: ' ', gc: C.frame, name: '', nc: C.dim, detail: e.text, dc: C.ink, right, indent, out: e.usage?.output ?? 0, thinking: e.text === 'pensando', full: e.full });
  }
  flush();
  const last = evs[evs.length - 1];
  if (last) {
    const d = last.tool ? splitTool(last.text ?? last.tool, last.tool, cwd) : null;
    const state = d ? `${d.name} ${d.detail}`.trim() : last.role === 'assistant' ? t('waiting for you') : t('thinking…');
    out.push({ kind: 'now', turn: null, connector: '', glyph: G.focus, gc: C.run, name: t('now'), nc: C.run, detail: state, dc: d ? C.ink : C.dim, right: '', ts: 0, showTime: false });
  }
  return out;
}

const hhmm = (ts: number) => (ts ? new Date(ts).toTimeString().slice(0, 8) : '');
export interface Live { model: string; effort: string; permissionMode: string; busy: boolean; thinking: number; summary: string; cost: number; deep?: boolean }
export interface LinkChip { glyph: string; label: string; color: RGB }
export interface PanelData {
  context: number; window: number; model: string; effort: string; perm: string;
  events: number; burn: number; cost: number; compactions: number; thinkingBlocks: number; showThinking: boolean;
  links: LinkChip[]; tasks: Task[]; state: string;
}

function drawPanel(g: Grid, x: number, top: number, bottom: number, p: PanelData) {
  const w = g.W - 2 - x;
  let y = top;
  const head = (t: string) => { if (y <= bottom) { g.put(x, y, t, C.link); g.put(x + t.length + 1, y, G.h.repeat(Math.max(0, w - t.length - 1)), C.frame); } y++; };
  const row = (k: string, v: string, col: RGB = C.ink) => { if (y <= bottom) { g.put(x, y, pad(k, 10), C.frame); g.put(x + 10, y, fit(v, w - 10), col); } y++; };
  const line = (t: string, col: RGB = C.dim) => { if (y <= bottom) g.put(x, y, fit(t, w), col); y++; };
  for (let yy = top; yy <= bottom; yy++) g.put(x - 2, yy, G.v, C.frame);

  head(t('memory'));
  const frac = p.window ? p.context / p.window : 0;
  row(t('context'), `${gauge(frac, 8)} ${Math.round(frac * 100)}%`, frac > 0.85 ? C.hold : C.run);
  row('', `${tok(p.context)} ${t('of')} ${tok(p.window)}`, C.dim);
  row(t('model'), p.model || '—');
  row(t('effort'), `${p.effort || '—'}${p.perm ? `  ${G.h}  ${p.perm}` : ''}`);
  row(t('events'), `${p.events}${p.compactions ? `  ${G.h}  ${p.compactions} compact.` : ''}`);
  row(t('burn'), `${tok(p.burn)}${p.cost ? `  ${G.h}  $${p.cost.toFixed(3)}` : ''}`);
  row(t('thought'), p.thinkingBlocks ? `${t('{0} blocks', p.thinkingBlocks)} ${G.h} t ${p.showThinking ? t('hides') : t('shows')}` : t('nothing recorded'), p.thinkingBlocks ? C.hold : C.dim);
  y++;
  head(t('links'));
  if (!p.links.length) line(t('none — l links'));
  for (const c of p.links) line(`${c.glyph} ${c.label}`, c.color);
  y++;
  head(t('tasks'));
  if (!p.tasks.length) line(t('none in this session'));
  for (const t of p.tasks) {
    const mark = t.status === 'completed' ? G.running : t.status === 'in_progress' ? G.focus : G.idle;
    const col = t.status === 'completed' ? C.run : t.status === 'in_progress' ? C.hold : C.dim;
    line(`${mark} ${t.subject}`, col);
  }
  y++;
  head(t('now'));
  line(p.state, C.ink);
}

/** Altura da caixa de escrita no rodapé: 3 linhas quando aberta, 1 quando fechada. */
export const INPUT_H = (open: boolean) => (open ? 3 : 1);

/** The chip shown at the left of the text row when the turn is a deep search. */
export const DEEP_CHIP = '[deep]';
/** Where the text starts and how wide it is: after the arrow (and the chip), leaving room for the right-aligned hint. */
export function inputLayout(W: number, deep: boolean): { x: number; w: number; hint: string } {
  const hint = deep ? t('↵ researches   tab plain   esc leaves') : t('↵ sends   tab deep   esc leaves');
  const x = deep ? 5 + DEEP_CHIP.length + 1 : 5;
  return { x, w: Math.max(8, W - 3 - hint.length - 2 - x), hint };
}

export function renderAgent(
  g: Grid, n: AgentNode, s: Session | null, evs: Ev[], all: Row[], scroll: number, cursorRow: number,
  status: string, input: { text: string; cursor: number; deep?: boolean } | null, live: Live | null, chips: LinkChip[],
  panel: PanelData | null = null, watching = false,
) {
  const { W, H } = g;
  const withPanel = !!panel && panelFits(W);
  const treeW = withPanel ? W - PANEL_W : W;
  const ih = INPUT_H(!!input);
  const top = 3, bottom = H - 5 - ih;
  const view = Math.max(1, bottom - top + 1);
  g.frame({ x: 0, y: 0, w: W, h: H }, `${G.running} ${n.name}`, C.inkHi);

  // cabeçalho: diretório, contexto
  const home = process.env.HOME ?? '';
  if (s) {
    const win = windowOf(s.model, s.context), frac = s.context / win, gw = 12, right = ` ${tok(s.context)}/${tok(win)} `;
    const gx = W - 2 - right.length - gw;
    const cl = ` ${t('context')} `;
    g.put(gx - cl.length, 0, cl, C.dim); g.put(gx, 0, gauge(frac, gw), frac > 0.85 ? C.hold : C.run); g.put(W - 2 - right.length, 0, right, C.dim);
    g.put(6 + n.name.length, 0, fit(`${G.h} ${n.cwd.replace(home, '~')}`, Math.max(0, gx - 8 - cl.length - n.name.length)) + ' ', C.dim);
  } else g.put(6 + n.name.length, 0, fit(`${G.h} ${n.cwd.replace(home, '~')} `, W - 10 - n.name.length), C.dim);
  const tag = live ? ` ${live.busy ? G.focus : G.running} ${t('chat live')}${live.deep ? ' · deep' : ''} ` : '';
  const meta = [live?.model || s?.model || (s ? '—' : t('new session')), live?.effort || s?.effort || '', live?.permissionMode || '', s?.branch, evs.length ? t('{0} events', evs.length) : '', s ? t('{0} ago', ago(s.ageMs)) : ''].filter(Boolean).join(`  ${G.h}  `);
  g.put(2, 1, fit(meta, W - 4 - tag.length - 1), live ? C.dim : C.frame);
  if (tag) g.put(W - 2 - tag.length, 1, tag, C.run);
  // faixa de ligações
  let x = 2;
  const lt = t('linked to'); g.put(x, 2, lt, C.frame); x += lt.length + 2;
  if (!chips.length) g.put(x, 2, t('nothing yet — l links a note, file, service or agent'), C.frame);
  for (const c of chips) { const t = `${c.glyph} ${c.label}`; if (x + t.length > W - 3) break; g.put(x, 2, t, c.color); x += t.length + 3; }

  // árvore
  const timeW = 8, tokW = 6, connW = 7, nameW = 9, nameX = 2 + connW + 2, detailX = nameX + nameW, detailW = detailWidth(W, withPanel);
  const rightEdge = treeW;   // tokens e hora encostam na borda da árvore, não da tela
  if (!all.length) g.put(2, top + 1, s ? t('no events') : t('new session — i writes the first prompt'), C.frame);
  const slice = all.slice(scroll, scroll + view);
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i]!, y = top + i; if (r.kind === 'blank') continue;
    const on = scroll + i === cursorRow; if (on) g.fill({ x: 1, y, w: W - 2, h: 1 }, BG.sel);
    // três vozes: você numa faixa própria, o agente com o nome e uma barra ao lado, o pensamento apagado com barra pontilhada
    const band = !on && r.voice === 'you' ? BG.input : undefined;
    if (band) g.fill({ x: nameX - 1, y, w: detailX + detailW - nameX + 1, h: 1 }, band);
    if (r.voice === 'agent') g.put(detailX - 1, y, '▎', C.link);
    if (r.voice === 'thought') g.put(detailX - 1, y, G.dV, C.sparkH);
    g.put(2, y, pad(r.connector, connW), C.frame); g.put(2 + connW, y, r.glyph, r.gc);
    if (r.name) g.put(nameX, y, pad(r.name, nameW - 1), on && r.kind !== 'turn' ? C.inkHi : r.nc, band);
    let detail = r.detail, dc = r.dc;
    if (r.kind === 'now' && live?.busy) { detail = live.thinking ? `${t('thinking')}${G.ell} ${tok(live.thinking)}` : live.summary || `${t('thinking')}${G.ell}`; dc = C.run; }
    if (r.spans && !on) { let sx = detailX; for (const sp of r.spans) { g.put(sx, y, fit(sp.text, Math.max(0, detailX + detailW - sx)), sp.color, band); sx += [...sp.text].length; if (sx >= detailX + detailW) break; } }
    else g.put(detailX, y, fit(detail, detailW), on ? C.inkHi : dc, band);
    if (r.right) g.put(rightEdge - 3 - timeW - tokW, y, padStart(r.right, tokW), C.frame);
    if (r.showTime) g.put(rightEdge - 2 - timeW, y, hhmm(r.ts), C.frame);
  }
  scrollHint(g, bottom + 1, scroll, Math.max(0, all.length - scroll - view));
  if (withPanel && panel) drawPanel(g, treeW, 3, bottom, panel);

  // a caixa de escrita
  const by = H - 4 - ih + 1;
  if (input) {
    const deep = !!input.deep, lay = inputLayout(W, deep);
    g.panel({ x: 1, y: by, w: W - 2, h: 3 }, BG.panel);
    g.frame({ x: 1, y: by, w: W - 2, h: 3 }, deep ? t('deep search with {0}', n.name) : t('write to {0}', n.name), deep ? C.hold : C.run, deep ? C.hold : C.link);
    g.fill({ x: 2, y: by + 1, w: W - 4, h: 1 }, BG.input);
    g.put(3, by + 1, `${G.arrow} `, deep ? C.hold : C.run, BG.input);
    if (deep) g.put(5, by + 1, DEEP_CHIP, C.hold, BG.input);
    g.put(lay.x, by + 1, pad(input.text, lay.w), C.inkHi, BG.input);
    if (!input.text) g.put(lay.x, by + 1, fit(deep ? t('a question for the repo, the hive and the web') : t('what it should do now'), lay.w), C.frame, BG.input);
    g.put(W - 3 - lay.hint.length, by + 1, lay.hint, C.frame, BG.input);
    g.cursor = { x: lay.x + input.cursor, y: by + 1 };
  } else {
    g.put(2, by, `${G.arrow} `, C.frame);
    g.put(4, by, fit(watching ? `${t('watching {0} — its parent runs it; esc goes back', n.name)}` : `${t('write to {0}', n.name)}  ${G.h}  i  ${G.h}  D ${t('deep search')}`, W - 6), C.frame);
  }
  g.put(0, H - 3, G.teeL + G.h.repeat(W - 2) + G.teeR, C.frame);
  keybar(g, H - 2, input
    ? [['↵', input.deep ? t('research') : t('send')], ['tab', input.deep ? t('plain turn') : t('deep search')], ['esc', t('leave the field')]]
    : watching
    ? [['↑↓', t('navigate')], ['↵', t('turn')], ['t', t('thoughts')], ['y', t('copy')], ['esc', t('project')]]
    : [['i', t('write')], ['D', t('deep')], ['↑↓', t('navigate')], ['↵', t('turn')], ['t', t('thoughts')], ['y', t('copy')], ['m', t('model')], ['e', t('effort')], ['p', t('permissions')], ['l', t('link')], ...(live ? ([['x', t('stop chat')]] as [string, string][]) : []), ['esc', t('project')]], status);
}
