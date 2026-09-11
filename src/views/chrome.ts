import { Grid } from '../tui/grid.ts';
import { BG, C, RGB, fit, strong } from '../tui/theme.ts';
import { t } from '../i18n.ts';

/** Shared surface: a quiet canvas and a single, clearly named location. */
export function surface(g: Grid, title: string, detail = '', color: RGB = C.inkHi) {
  g.panel({ x: 0, y: 0, w: g.W, h: g.H }, BG.base);
  g.panel({ x: 0, y: 0, w: g.W, h: 1 }, BG.panel);
  g.put(2, 0, fit(title, g.W - 4), strong(color));
  if (detail) g.put(2, 1, fit(detail, g.W - 4), C.dim);
}

/**
 * The key bar is the last row; the status line is the row above it, shared with
 * the scroll hint at the right. Keys are drawn in the order given until the row
 * is full: the rest is one `?` away, in a menu that lists every key.
 */
export function keybar(g: Grid, y: number, keys: [string, string][], status: string, urgent?: string) {
  g.actions = keys;
  g.panel({ x: 0, y, w: g.W, h: 1 }, BG.panel);
  const back = keys.find(([key]) => key === 'esc');
  const textEntry = keys.some(([key, label]) => key === '^v' || (key === 'esc' && label === t('stop typing')));
  const help = textEntry ? t('actions') : t('? actions');
  const tail = (back ? `esc ${back[1]}   ` : '') + help;
  const tailX = g.W - 2 - [...tail].length;
  let x = 2;
  for (const [k, label] of keys) {
    if (k === 'esc') continue;
    const kw = [...k].length, need = kw + 1 + [...label].length;
    if (x + need > tailX - 3) break;
    g.put(x, y, k, urgent === k ? C.hold : strong(C.inkHi));
    g.put(x + kw + 1, y, label, urgent === k ? C.hold : C.dim);
    g.hit(`action:${k}`, { x, y, w: need, h: 1 });
    x += need + 3;
  }
  if (back) {
    g.put(tailX, y, `esc ${back[1]}`, C.dim);
    g.hit('action:esc', { x: tailX, y, w: [...back[1]].length + 4, h: 1 });
  }
  g.put(g.W - 2 - help.length, y, help, C.link);
  g.hit('action:?', { x: g.W - 2 - help.length, y, w: help.length, h: 1 });
  if (status) {
    g.panel({ x: 0, y: y - 1, w: g.W - 16, h: 1 }, BG.base);
    g.put(2, y - 1, fit(status, g.W - 20), urgent ? C.hold : C.link);
  }
}

/** Marks content beyond the visible area, at the right of the status row. */
export function scrollHint(g: Grid, y: number, above: number, below: number) {
  if (!above && !below) return;
  const label = [above ? '↑' : '', below ? t('↓ {0} more', below) : ''].filter(Boolean).join(' ');
  g.put(g.W - 2 - label.length, y, label, C.dim);
}
