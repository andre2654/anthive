/**
 * Diff por linhas do que o agente editou. Edit traz trecho antigo → novo;
 * MultiEdit vários; Write é arquivo inteiro (tudo novo). LCS por linhas, que
 * basta para trechos; acima de 400 linhas cai para "tudo saiu, tudo entrou".
 */
import { Grid } from './grid.ts';
import { C, G, fit } from './theme.ts';
import { Ev } from '../core/sessions.ts';
import { keybar, scrollHint } from '../views/chrome.ts';

export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }
export interface Hunk { tool: string; path: string; lines: DiffLine[]; note?: string }

export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.replace(/\n$/, '').split('\n'), B = b.replace(/\n$/, '').split('\n');
  if (A.length > 400 || B.length > 400) return [...A.map((t) => ({ kind: 'del' as const, text: t })), ...B.map((t) => ({ kind: 'add' as const, text: t }))];
  const n = A.length, m = B.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = A[i] === B[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ kind: 'same', text: A[i]! }); i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) { out.push({ kind: 'del', text: A[i]! }); i++; }
    else { out.push({ kind: 'add', text: B[j]! }); j++; }
  }
  while (i < n) out.push({ kind: 'del', text: A[i++]! });
  while (j < m) out.push({ kind: 'add', text: B[j++]! });
  return out;
}

export const isEditTool = (tool?: string) => tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write';

/** As mudanças de um evento de ferramenta, prontas para desenhar. */
export function hunksOf(ev: Ev): Hunk[] {
  const inp = ev.input as any;
  const path = String(inp?.file_path ?? inp?.path ?? '');
  if (!inp) return [{ tool: ev.tool ?? '?', path, lines: [], note: 'entrada grande demais para guardar — o transcript tem o conteúdo' }];
  if (ev.tool === 'Write') return [{ tool: 'Write', path, lines: String(inp.content ?? '').replace(/\n$/, '').split('\n').map((t) => ({ kind: 'add' as const, text: t })) }];
  if (ev.tool === 'MultiEdit' && Array.isArray(inp.edits)) return inp.edits.map((e: any) => ({ tool: 'MultiEdit', path, lines: diffLines(String(e.old_string ?? ''), String(e.new_string ?? '')) }));
  return [{ tool: ev.tool ?? 'Edit', path, lines: diffLines(String(inp.old_string ?? ''), String(inp.new_string ?? '')), note: inp.replace_all ? 'todas as ocorrências' : undefined }];
}

/** Desenha os hunks; devolve o total de linhas para a rolagem. */
export function renderDiff(g: Grid, ev: Ev, hunks: Hunk[], scroll: number, status: string): number {
  const { W, H } = g;
  const home = process.env.HOME ?? '';
  const path = hunks[0]?.path ?? '';
  g.frame({ x: 0, y: 0, w: W, h: H }, `${G.tool} ${ev.tool} ${fit(path.split('/').pop() ?? '', W - 30)}`, C.inkHi);
  const adds = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'add').length, 0);
  const dels = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'del').length, 0);
  g.put(2, 1, fit(`${path.replace(home, '~')}  ${G.h}  `, W - 24), C.dim);
  const tag = `+${adds} −${dels}`;
  g.put(W - 2 - tag.length, 1, tag, adds || dels ? C.ink : C.frame);

  const rows: { kind: DiffLine['kind'] | 'head' | 'note'; text: string }[] = [];
  hunks.forEach((h, i) => {
    if (hunks.length > 1) rows.push({ kind: 'head', text: `edição ${i + 1} de ${hunks.length}` });
    if (h.note) rows.push({ kind: 'note', text: h.note });
    for (const l of h.lines) rows.push(l);
    if (i < hunks.length - 1) rows.push({ kind: 'note', text: '' });
  });
  const top = 3, bottom = H - 4, view = Math.max(1, bottom - top + 1);
  const slice = rows.slice(scroll, scroll + view);
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i]!, y = top + i;
    if (r.kind === 'head') { g.put(2, y, r.text, C.link); continue; }
    if (r.kind === 'note') { g.put(2, y, r.text, C.frame); continue; }
    const mark = r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' ';
    const col = r.kind === 'add' ? C.run : r.kind === 'del' ? C.dead : C.dim;
    g.put(2, y, mark, col);
    g.put(4, y, fit(r.text.replace(/\t/g, '  '), W - 6), col);
  }
  scrollHint(g, H - 3, scroll, Math.max(0, rows.length - scroll - view));
  g.put(0, H - 3, G.teeL + G.h.repeat(W - 2) + G.teeR, C.frame);
  keybar(g, H - 2, [['↑↓', 'rolar'], ['esc', 'voltar à conversa']], status);
  return rows.length;
}
