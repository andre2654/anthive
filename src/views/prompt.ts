import { Grid, Rect } from '../tui/grid.ts';
import { C, G, BG, fit, pad, strong } from '../tui/theme.ts';
import { Form } from '../tui/input.ts';
import { t } from '../i18n.ts';

/** Centered dialogs keep their focus and controls inside the viewport. */
function dialog(g: Grid, w: number, h: number, title: string, color = C.link): Rect {
  const box = { x: Math.floor((g.W - w) / 2), y: Math.max(1, Math.floor((g.H - h) / 2)), w, h };
  g.hits = [];
  g.panel({ x: box.x + 1, y: box.y + 1, w, h }, BG.base);
  g.panel(box, BG.panel);
  g.frame(box, fit(title, w - 6), strong(C.inkHi), color);
  g.cursor = null;
  return box;
}

export function renderForm(g: Grid, form: Form, note?: string) {
  const w = Math.min(g.W - 6, 76);
  const count = Math.min(form.fields.length, Math.max(1, Math.floor((g.H - 7) / 2)));
  const first = Math.min(Math.max(0, form.active - count + 1), form.fields.length - count);
  const { x, y, h } = dialog(g, w, count * 2 + 5, form.title);
  for (let i = first; i < first + count; i++) {
    const f = form.fields[i]!, on = i === form.active, fy = y + 1 + (i - first) * 2;
    g.put(x + 2, fy, fit(`${f.label}${f.required ? ' *' : ''}`, w - 4), on ? C.link : C.dim);
    const ix = x + 3, iw = w - 6, win = f.input.window(iw - 1);
    g.panel({ x: x + 2, y: fy + 1, w: w - 4, h: 1 }, on ? BG.input : BG.base);
    g.put(ix, fy + 1, f.input.empty ? fit(f.hint || '', iw - 1) : win.text.replace(/\n/g, '↵'), f.input.empty ? C.dim : C.inkHi);
    if (on) g.cursor = { x: ix + win.cursorAt, y: fy + 1 };
    g.hit(`field:${i}`, { x: x + 2, y: fy, w: w - 4, h: 2 });
  }
  const f = form.fields[form.active]!;
  const message = form.error ? `${G.stuck} ${form.error}` : note || t('Fields marked * are required.');
  g.put(x + 2, y + h - 3, fit(message, w - 4), form.error ? C.dead : C.dim);
  g.put(x + 2, y + h - 2, fit(f.options?.length ? t('↵ continue   tab complete   ↑↓ fields   esc cancel') : t('↵ continue   ↑↓ fields   esc cancel'), w - 4), C.dim);
}

export function renderConfirm(g: Grid, title: string, lines: string[]) {
  const w = Math.min(g.W - 6, 76);
  const body = lines.flatMap((line) => wrapText(line, w - 4));
  const count = Math.min(body.length, g.H - 7);
  const { x, y, h } = dialog(g, w, count + 5, title, C.hold);
  body.slice(0, count).forEach((line, i) => g.put(x + 2, y + 2 + i, fit(line, w - 4), C.ink));
  g.put(x + 2, y + h - 2, t('y confirm   n / esc cancel'), C.hold);
}

export interface PickItem { value: string; label: string; hint?: string; current?: boolean }
/** One row per item; the list scrolls around the selection when it does not fit. */
export function pickLayout(W: number, H: number, items: PickItem[], index: number, note?: string) {
  const count = Math.min(items.length, Math.max(1, H - 7 - (note ? 1 : 0)));
  const first = Math.max(0, Math.min(index - Math.floor(count / 2), items.length - count));
  return { w: Math.min(W - 6, 72), h: count + 5 + (note ? 1 : 0), rowH: 1, count, first };
}

export function renderPick(g: Grid, title: string, items: PickItem[], index: number, note?: string) {
  const { w, h, count, first } = pickLayout(g.W, g.H, items, index, note);
  const { x, y } = dialog(g, w, h, title);
  const position = t('{0} of {1}', items.length ? index + 1 : 0, items.length);
  g.put(x + w - 2 - position.length, y + 1, position, C.dim);
  const labelW = Math.min(30, Math.max(0, ...items.map((it) => [...it.label].length)) + 2);
  for (let i = first; i < first + count; i++) {
    const it = items[i]!, iy = y + 2 + (i - first), on = i === index;
    if (on) g.fill({ x: x + 1, y: iy, w: w - 2, h: 1 }, BG.sel);
    g.put(x + 2, iy, on ? '›' : ' ', C.link);
    g.put(x + 4, iy, pad(it.label, labelW), on ? strong(C.inkHi) : C.ink);
    if (it.hint) g.put(x + 4 + labelW + 1, iy, fit(it.hint, Math.max(0, w - labelW - (it.current ? 19 : 8))), C.dim);
    if (it.current) g.put(x + w - 11, iy, t('● current'), C.run);
    g.hit(`pick:${i}`, { x: x + 1, y: iy, w: w - 2, h: 1 });
  }
  if (note) g.put(x + 2, y + h - 3, fit(note, w - 4), C.dim);
  g.put(x + 2, y + h - 2, t('↑↓ choose   ↵ select   esc cancel'), C.dim);
}

export function approvalLayout(W: number, H: number, what: string) {
  const w = Math.min(W - 6, 90), body = wrapText(what, w - 4);
  const count = Math.min(body.length, Math.max(1, H - 12));
  return { w, body, count };
}

export function renderApproval(g: Grid, agent: string, tool: string, what: string, opts: { linkable: string | null; rule: string; scroll?: number }) {
  const { w, body, count } = approvalLayout(g.W, g.H, what), inner = w - 4;
  const first = Math.min(opts.scroll ?? 0, Math.max(0, body.length - count));
  const extra = [t('a  always allow: {0}', opts.rule), ...(opts.linkable ? [t('l  allow and link {0} to {1}', opts.linkable, agent)] : []), t('t  trust {0}: allow everything (p → ask again)', agent)];
  const h = count + extra.length + 7;
  const { x, y } = dialog(g, w, h, t('{0} asks permission', agent), C.hold);
  g.put(x + 2, y + 1, fit(tool, inner), strong(C.hold));
  body.slice(first, first + count).forEach((line, i) => g.put(x + 2, y + 2 + i, line, C.ink));
  if (body.length > count) g.put(x + 2, y + 2 + count, fit(t('↑↓ review details · lines {0}–{1} of {2}', first + 1, first + count, body.length), inner), C.link);
  extra.forEach((line, i) => g.put(x + 2, y + 3 + count + i, fit(line, inner), C.dim));
  g.put(x + 2, y + h - 2, t('y allow once   n deny   esc later'), C.hold);
}

export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (!line) line = word;
      else if ([...line].length + 1 + [...word].length <= width) line += ' ' + word;
      else { out.push(line); line = word; }
      while ([...line].length > width) { out.push([...line].slice(0, width).join('')); line = [...line].slice(width).join(''); }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}
