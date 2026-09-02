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

export type RowKind = 'turn' | 'child' | 'cont' | 'summary' | 'compact' | 'now' | 'blank';
export interface Row { kind: RowKind; turn: string | null; connector: string; glyph: string; gc: RGB; name: string; nc: RGB; detail: string; dc: RGB; right: string; ts: number; showTime: boolean; spans?: Span[]; ev?: string }
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

export function rows(evs: Ev[], cwd = '', expanded: Set<string> = new Set(), width = 60, showThinking = false): Row[] {
  const out: Row[] = [];
  let turnId: string | null = null, pending: Child[] = [];
  const lastTurn = [...evs].reverse().find((e) => e.role === 'user' && !e.tool && e.text)?.uuid ?? null;
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
      out.push({ kind: 'summary', turn: turnId, connector: G.branchEnd, glyph: G.tool, gc: C.frame, name: `${pending.length} ações`, nc: C.dim, detail: tools ? `${tools}  ${G.h}  ↵ abre` : '↵ abre', dc: C.frame, right: spent ? tok(spent) : '', ts: 0, showTime: false });
    } else {
      for (let i = 0; i < pending.length; i++) {
        const c = pending[i]!, last = i === pending.length - 1 || pending[i + 1]!.indent < c.indent;
        const conn = (c.indent ? '│  ' : '') + (last ? G.branchEnd : G.branchMid);
        // texto do agente se lê inteiro; comando de ferramenta fica numa linha
        const stem = (c.indent ? '│  ' : '') + (last ? '   ' : '│  ');
        if (c.thought) {
          // raciocínio: texto corrido, apagado, quebrado na largura
          const ls = wrap(c.thought, width);
          out.push({ kind: 'child', turn: turnId, connector: conn, glyph: c.glyph, gc: c.gc, name: c.name, nc: c.nc, detail: ls[0]!, dc: C.frame, right: '', ts: 0, showTime: false });
          for (const l of ls.slice(1)) out.push({ kind: 'cont', turn: turnId, connector: stem, glyph: '', gc: C.frame, name: '', nc: C.frame, detail: l, dc: C.frame, right: '', ts: 0, showTime: false });
          continue;
        }
        if (c.tool || c.thinking) {
          out.push({ kind: 'child', turn: turnId, connector: conn, glyph: c.glyph, gc: c.gc, name: c.name, nc: c.nc, detail: c.detail, dc: c.dc, right: c.right, ts: 0, showTime: false, ev: c.ev });
          continue;
        }
        // resposta em markdown: títulos, listas, código e ênfase viram cor
        const md = renderMd(c.full ?? c.detail, width);
        const first = md[0];
        out.push({ kind: 'child', turn: turnId, connector: conn, glyph: c.glyph, gc: c.gc, name: c.name, nc: c.nc, detail: first ? first.spans.map((x) => x.text).join('') : '', dc: c.dc, right: c.right, ts: 0, showTime: false, spans: first?.spans });
        for (const l of md.slice(1)) out.push({ kind: 'cont', turn: turnId, connector: stem, glyph: '', gc: C.frame, name: '', nc: C.frame, detail: l.spans.map((x) => x.text).join(''), dc: c.dc, right: '', ts: 0, showTime: false, spans: l.spans });
      }
    }
    out.push(BLANK); pending = [];
  };
  for (const e of evs) {
    const indent = e.sidechain ? 1 : 0;
    if (e.isCompact) { flush(); out.push({ kind: 'compact', turn: null, connector: '', glyph: G.cut, gc: C.hold, name: 'COMPACTAÇÃO', nc: C.hold, detail: e.text || 'contexto reduzido', dc: C.dim, right: '', ts: e.ts, showTime: true }); out.push(BLANK); continue; }
    if (e.type === 'system') continue;
    if (e.role === 'user' && e.meta) {
      // conteúdo que o Claude Code injetou (skill carregada, lembrete de sistema): mostra o que foi, numa linha
      const m = /Base directory for this skill:\s*\S*\/([^\/\s]+)\s*$/m.exec(e.full ?? e.text ?? '');
      const what = m ? `skill ${m[1]}` : 'contexto injetado';
      pending.push({ glyph: G.tool, gc: C.hold, name: what.split(' ')[0]!, nc: C.hold, detail: m ? `${m[1]} carregada — ${(e.text ?? '').split('#')[1]?.trim().slice(0, 60) ?? ''}` : (e.text ?? '').slice(0, 80), dc: C.dim, right: '', indent, tool: what, out: 0 });
      continue;
    }
    if (e.role === 'user' && !e.tool) {
      if (!e.text) continue;
      flush(); turnId = e.uuid;
      const ls = wrap(e.full ?? e.text, width);
      out.push({ kind: 'turn', turn: e.uuid, connector: '', glyph: G.running, gc: C.run, name: 'você', nc: C.inkHi, detail: ls[0]!, dc: C.ink, right: '', ts: e.ts, showTime: true });
      for (const l of ls.slice(1)) out.push({ kind: 'cont', turn: e.uuid, connector: '', glyph: '', gc: C.frame, name: '', nc: C.frame, detail: l, dc: C.ink, right: '', ts: 0, showTime: false });
      continue;
    }
    const right = e.usage?.output ? tok(e.usage.output) : '';
    if (showThinking && e.thinking && e.role === 'assistant') {
      pending.push({ glyph: G.tool, gc: C.hold, name: 'pensou', nc: C.hold, detail: e.thinking.replace(/\s+/g, ' ').slice(0, 200), dc: C.frame, right: '', indent, out: 0, thought: e.thinking });
    }
    if (e.tool) {
      const sub = e.tool === 'Agent' || e.tool === 'Task' || e.tool === 'Explore';
      const { name, detail } = splitTool(e.text ?? e.tool, e.tool, cwd);
      const editable = e.tool === 'Edit' || e.tool === 'MultiEdit' || e.tool === 'Write';
      const bt = browserTool(e.tool);
      if (bt) {
        // o agente no browser: o que ele fez e em quê, sem o prefixo
        const inp = (e.input ?? {}) as Record<string, unknown>;
        const what = String(inp.url ?? inp.text ?? inp.element ?? inp.ref ?? inp.key ?? '');
        pending.push({ glyph: '▣', gc: C.run, name: browserShort(bt), nc: C.ink, detail: what, dc: C.dim, right, indent, tool: e.tool, out: e.usage?.output ?? 0, ev: e.uuid });
        continue;
      }
      pending.push({ glyph: sub ? G.sub : G.tool, gc: sub ? C.link : editable ? C.run : C.frame, name, nc: sub ? C.link : editable ? C.ink : C.dim, detail: editable ? `${detail}  ${G.h}  ↵ diff` : detail, dc: C.dim, right, indent, tool: name, out: e.usage?.output ?? 0, ev: e.uuid });
    } else if (e.text) pending.push({ glyph: ' ', gc: C.frame, name: '', nc: C.dim, detail: e.text, dc: C.ink, right, indent, out: e.usage?.output ?? 0, thinking: e.text === 'pensando', full: e.full });
  }
  flush();
  const last = evs[evs.length - 1];
  if (last) {
    const d = last.tool ? splitTool(last.text ?? last.tool, last.tool, cwd) : null;
    const state = d ? `${d.name} ${d.detail}`.trim() : last.role === 'assistant' ? 'esperando você' : 'pensando…';
    out.push({ kind: 'now', turn: null, connector: '', glyph: G.focus, gc: C.run, name: 'agora', nc: C.run, detail: state, dc: d ? C.ink : C.dim, right: '', ts: 0, showTime: false });
  }
  return out;
}

const hhmm = (ts: number) => (ts ? new Date(ts).toTimeString().slice(0, 8) : '');
export interface Live { model: string; effort: string; permissionMode: string; busy: boolean; thinking: number; summary: string; cost: number }
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

  head('memória');
  const frac = p.window ? p.context / p.window : 0;
  row('contexto', `${gauge(frac, 8)} ${Math.round(frac * 100)}%`, frac > 0.85 ? C.hold : C.run);
  row('', `${tok(p.context)} de ${tok(p.window)}`, C.dim);
  row('modelo', p.model || '—');
  row('esforço', `${p.effort || '—'}${p.perm ? `  ${G.h}  ${p.perm}` : ''}`);
  row('eventos', `${p.events}${p.compactions ? `  ${G.h}  ${p.compactions} compact.` : ''}`);
  row('queima', `${tok(p.burn)}${p.cost ? `  ${G.h}  $${p.cost.toFixed(3)}` : ''}`);
  row('pensou', p.thinkingBlocks ? `${p.thinkingBlocks} blocos ${G.h} t ${p.showThinking ? 'oculta' : 'mostra'}` : 'nada gravado', p.thinkingBlocks ? C.hold : C.dim);
  y++;
  head('ligações');
  if (!p.links.length) line('nenhuma — l liga');
  for (const c of p.links) line(`${c.glyph} ${c.label}`, c.color);
  y++;
  head('tarefas');
  if (!p.tasks.length) line('nenhuma nesta sessão');
  for (const t of p.tasks) {
    const mark = t.status === 'completed' ? G.running : t.status === 'in_progress' ? G.focus : G.idle;
    const col = t.status === 'completed' ? C.run : t.status === 'in_progress' ? C.hold : C.dim;
    line(`${mark} ${t.subject}`, col);
  }
  y++;
  head('agora');
  line(p.state, C.ink);
}

/** Altura da caixa de escrita no rodapé: 3 linhas quando aberta, 1 quando fechada. */
export const INPUT_H = (open: boolean) => (open ? 3 : 1);

export function renderAgent(
  g: Grid, n: AgentNode, s: Session | null, evs: Ev[], all: Row[], scroll: number, cursorRow: number,
  status: string, input: { text: string; cursor: number } | null, live: Live | null, chips: LinkChip[],
  panel: PanelData | null = null,
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
    g.put(gx - 10, 0, ' contexto ', C.dim); g.put(gx, 0, gauge(frac, gw), frac > 0.85 ? C.hold : C.run); g.put(W - 2 - right.length, 0, right, C.dim);
    g.put(6 + n.name.length, 0, fit(`${G.h} ${n.cwd.replace(home, '~')}`, Math.max(0, gx - 18 - n.name.length)) + ' ', C.dim);
  } else g.put(6 + n.name.length, 0, fit(`${G.h} ${n.cwd.replace(home, '~')} `, W - 10 - n.name.length), C.dim);
  const tag = live ? (live.busy ? ` ${G.focus} chat vivo ` : ` ${G.running} chat vivo `) : '';
  const meta = [live?.model || s?.model || (s ? '—' : 'sessão nova'), live?.effort || s?.effort || '', live?.permissionMode || '', s?.branch, evs.length ? `${evs.length} eventos` : '', s ? `${ago(s.ageMs)} atrás` : ''].filter(Boolean).join(`  ${G.h}  `);
  g.put(2, 1, fit(meta, W - 4 - tag.length - 1), live ? C.dim : C.frame);
  if (tag) g.put(W - 2 - tag.length, 1, tag, C.run);
  // faixa de ligações
  let x = 2;
  g.put(x, 2, 'ligado a', C.frame); x += 10;
  if (!chips.length) g.put(x, 2, 'nada ainda — l liga a uma nota, arquivo, serviço ou agente', C.frame);
  for (const c of chips) { const t = `${c.glyph} ${c.label}`; if (x + t.length > W - 3) break; g.put(x, 2, t, c.color); x += t.length + 3; }

  // árvore
  const timeW = 8, tokW = 6, connW = 7, nameW = 9, nameX = 2 + connW + 2, detailX = nameX + nameW, detailW = detailWidth(W, withPanel);
  const rightEdge = treeW;   // tokens e hora encostam na borda da árvore, não da tela
  if (!all.length) g.put(2, top + 1, s ? 'sem eventos' : 'sessão nova — i escreve o primeiro prompt', C.frame);
  const slice = all.slice(scroll, scroll + view);
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i]!, y = top + i; if (r.kind === 'blank') continue;
    const on = scroll + i === cursorRow; if (on) g.fill({ x: 1, y, w: W - 2, h: 1 }, BG.sel);
    g.put(2, y, pad(r.connector, connW), C.frame); g.put(2 + connW, y, r.glyph, r.gc);
    if (r.name) g.put(nameX, y, pad(r.name, nameW - 1), on && r.kind !== 'turn' ? C.inkHi : r.nc);
    let detail = r.detail, dc = r.dc;
    if (r.kind === 'now' && live?.busy) { detail = live.thinking ? `pensando${G.ell} ${tok(live.thinking)}` : live.summary || `pensando${G.ell}`; dc = C.run; }
    if (r.spans && !on) { let sx = detailX; for (const sp of r.spans) { g.put(sx, y, fit(sp.text, Math.max(0, detailX + detailW - sx)), sp.color); sx += [...sp.text].length; if (sx >= detailX + detailW) break; } }
    else g.put(detailX, y, fit(detail, detailW), on ? C.inkHi : dc);
    if (r.right) g.put(rightEdge - 3 - timeW - tokW, y, padStart(r.right, tokW), C.frame);
    if (r.showTime) g.put(rightEdge - 2 - timeW, y, hhmm(r.ts), C.frame);
  }
  scrollHint(g, bottom + 1, scroll, Math.max(0, all.length - scroll - view));
  if (withPanel && panel) drawPanel(g, treeW, 3, bottom, panel);

  // a caixa de escrita
  const by = H - 4 - ih + 1;
  if (input) {
    g.panel({ x: 1, y: by, w: W - 2, h: 3 }, BG.panel);
    g.frame({ x: 1, y: by, w: W - 2, h: 3 }, `escreva para ${n.name}`, C.run, C.link);
    g.fill({ x: 2, y: by + 1, w: W - 4, h: 1 }, BG.input);
    g.put(3, by + 1, `${G.arrow} `, C.run, BG.input);
    const iw = W - 8;
    g.put(5, by + 1, pad(input.text, iw), C.inkHi, BG.input);
    const hint = '↵ envia   esc sai';
    if (!input.text) g.put(5, by + 1, fit('o que ele deve fazer agora', iw - hint.length - 2), C.frame, BG.input);
    g.put(W - 3 - hint.length, by + 1, hint, C.frame, BG.input);
    g.cursor = { x: 5 + input.cursor, y: by + 1 };
  } else {
    g.put(2, by, `${G.arrow} `, C.frame);
    g.put(4, by, fit(`escreva para ${n.name}  ${G.h}  i`, W - 6), C.frame);
  }
  g.put(0, H - 3, G.teeL + G.h.repeat(W - 2) + G.teeR, C.frame);
  keybar(g, H - 2, input
    ? [['↵', 'enviar'], ['esc', 'sair do campo']]
    : [['i', 'escrever'], ['↑↓', 'navegar'], ['↵', 'turno'], ['t', 'pensamento'], ['y', 'copiar'], ['m', 'modelo'], ['e', 'esforço'], ['p', 'permissão'], ['l', 'ligar'], ...(live ? ([['x', 'encerrar chat']] as [string, string][]) : []), ['esc', 'projeto']], status);
}
