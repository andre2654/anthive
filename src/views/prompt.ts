import { Grid, Rect } from '../tui/grid.ts';
import { C, G, BG, fit, pad } from '../tui/theme.ts';
import { Form } from '../tui/input.ts';

/**
 * Modal de entrada sobre o mapa. Fica na parte de baixo, sem cobrir a seleção,
 * e devolve o cursor real do terminal para o campo ativo.
 */
export function renderForm(g: Grid, form: Form, note?: string) {
  const { W, H } = g;
  const w = Math.min(W - 6, 72);
  const x = Math.floor((W - w) / 2);
  const rows = form.fields.length;
  const h = rows + 3 + (form.error || note ? 1 : 0);
  const y = Math.max(1, H - 4 - h);
  const box: Rect = { x, y, w, h };

  g.panel(box, BG.panel);
  g.frame(box, form.title, C.link, C.link);

  const labelW = Math.max(...form.fields.map((f) => [...f.label].length)) + 1;
  for (let i = 0; i < rows; i++) {
    const f = form.fields[i]!;
    const fy = y + 1 + i;
    const on = i === form.active;
    g.put(x + 2, fy, pad(f.label, labelW), on ? C.inkHi : C.frame, BG.panel);

    const ix = x + 2 + labelW + 1;
    const iw = w - (labelW + 6);
    const win = f.input.window(iw - 1);
    g.put(ix, fy, ' '.repeat(iw), C.ink, on ? BG.input : BG.panel);

    if (f.input.empty && f.hint) g.put(ix, fy, fit(f.hint, iw - 1), C.frame, on ? BG.input : BG.panel);
    else g.put(ix, fy, win.text, on ? C.inkHi : C.ink, on ? BG.input : BG.panel);

    if (on) g.cursor = { x: ix + win.cursorAt, y: fy };
    if (f.required && f.input.empty && !on) g.put(x + w - 3, fy, G.waiting, C.hold, BG.panel);
  }

  let ly = y + rows + 1;
  if (form.error) { g.put(x + 2, ly, fit(`${G.stuck} ${form.error}`, w - 4), C.dead, BG.panel); ly++; }
  else if (note) { g.put(x + 2, ly, fit(note, w - 4), C.frame, BG.panel); ly++; }

  const f = form.fields[form.active]!;
  const keys = f.options?.length
    ? `↵ confirmar   tab completar   ↑↓ campo   esc cancelar`
    : `↵ confirmar   ↑↓ campo   esc cancelar`;
  g.put(x + 2, ly, fit(keys, w - 4), C.frame, BG.panel);
}

/** Confirmação de uma linha, para ações com efeito colateral. */
export function renderConfirm(g: Grid, title: string, lines: string[]) {
  const { W, H } = g;
  const w = Math.min(W - 6, 76);
  const x = Math.floor((W - w) / 2);
  const h = lines.length + 3;
  const y = Math.max(1, H - 4 - h);
  const box: Rect = { x, y, w, h };

  g.panel(box, BG.panel);
  g.frame(box, title, C.hold, C.hold);
  for (let i = 0; i < lines.length; i++) {
    g.put(x + 2, y + 1 + i, fit(lines[i]!, w - 4), i === 0 ? C.inkHi : C.dim, BG.panel);
  }
  g.put(x + 2, y + h - 2, 's confirmar   n / esc cancelar', C.frame, BG.panel);
  g.cursor = null;
}

export interface PickItem { value: string; label: string; hint?: string; current?: boolean }

/** Lista para escolher um valor entre poucos: setas movem, ↵ aplica, ● marca o atual. */
export function renderPick(g: Grid, title: string, items: PickItem[], index: number, note?: string) {
  const { W, H } = g;
  const w = Math.min(W - 6, 64);
  const x = Math.floor((W - w) / 2);
  const h = items.length + 3 + (note ? 1 : 0);
  const y = Math.max(1, H - 4 - h);
  const box: Rect = { x, y, w, h };

  g.panel(box, BG.panel);
  g.frame(box, title, C.link, C.link);

  const labelW = Math.min(30, Math.max(...items.map((i) => [...i.label].length)) + 2);
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const iy = y + 1 + i;
    const on = i === index;
    if (on) g.fill({ x: x + 1, y: iy, w: w - 2, h: 1 }, BG.sel);
    const bg = on ? BG.sel : BG.panel;
    g.put(x + 2, iy, on ? G.focus : ' ', C.link, bg);
    g.put(x + 4, iy, pad(it.label, labelW), on ? C.inkHi : C.ink, bg);
    if (it.hint) g.put(x + 4 + labelW + 1, iy, fit(it.hint, w - labelW - 14), C.dim, bg);
    if (it.current) g.put(x + w - 9, iy, `${G.running} atual`, C.run, bg);
  }
  let ly = y + items.length + 1;
  if (note) { g.put(x + 2, ly, fit(note, w - 4), C.frame, BG.panel); ly++; }
  g.put(x + 2, ly, '↑↓ escolher   ↵ aplicar   esc cancelar', C.frame, BG.panel);
  g.cursor = null;
}
