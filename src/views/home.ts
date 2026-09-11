import { Grid, Rect } from '../tui/grid.ts';
import { C, G, BG, ago, fit, strong } from '../tui/theme.ts';
import { ProjectCard } from '../core/project.ts';
import { keybar, scrollHint, surface } from './chrome.ts';
import { t } from '../i18n.ts';

export const CARD_H = 5;
export interface HomeLayout { rects: { key: string; rect: Rect }[]; cols: number; cardW: number; height: number }

export function layoutHome(n: number, W: number, scroll = 0): HomeLayout {
  const cols = W >= 120 ? 3 : W >= 76 ? 2 : 1;
  const cardW = Math.floor((W - 4 - (cols - 1) * 2) / cols);
  const rects = Array.from({ length: n + 1 }, (_, i) => ({
    key: i < n ? `proj:${i}` : 'new',
    rect: { x: 2 + i % cols * (cardW + 2), y: 5 + Math.floor(i / cols) * (CARD_H + 1) - scroll, w: cardW, h: CARD_H },
  }));
  return { rects, cols, cardW, height: 5 + Math.ceil((n + 1) / cols) * (CARD_H + 1) };
}

export function renderHome(g: Grid, cards: ProjectCard[], selected: string, scroll: number, status: string) {
  const { W, H } = g;
  surface(g, 'anthive', t('A workspace for your agents and their work.'));
  g.put(2, 3, t('Your projects'), strong(C.inkHi));
  const count = cards.length === 1 ? t('1 project') : t('{0} projects', cards.length);
  g.put(W - 2 - count.length, 3, count, C.dim);
  const L = layoutHome(cards.length, W, scroll);
  for (const { key, rect: r } of L.rects) {
    if (r.y < 5 || r.y + r.h > H - 2) continue;
    const on = key === selected;
    g.panel(r, on ? BG.sel : BG.panel);
    if (on) for (let y = r.y; y < r.y + r.h; y++) g.put(r.x, y, '▎', C.link);
    if (key === 'new') {
      g.put(r.x + 2, r.y + 1, t('+ New project'), strong(on ? C.link : C.ink));
      g.put(r.x + 2, r.y + 2, fit(t('Choose a folder to get started'), r.w - 4), C.dim);
    } else {
      const c = cards[Number(key.slice(5))]!;
      g.put(r.x + 2, r.y + 1, fit(c.project.name, r.w - 4), strong(C.inkHi));
      g.put(r.x + 2, r.y + 2, fit(c.project.cwd.replace(process.env.HOME ?? '', '~'), r.w - 4), C.dim);
      const label = c.running ? t('{0} running', c.running) : c.sessions.length ? t('{0} sessions', c.sessions.length) : t('Ready to start');
      g.put(r.x + 2, r.y + 3, fit(`${c.running ? G.running : G.idle} ${label}`, r.w - 12), c.running ? C.run : C.dim);
      if (c.sessions.length) g.put(r.x + r.w - 9, r.y + 3, fit(ago(c.lastMs), 7), C.dim);
    }
    g.hit(key, r);
  }
  scrollHint(g, H - 2, L.rects.filter(({ rect }) => rect.y < 5).length, L.rects.filter(({ rect }) => rect.y + rect.h > H - 2).length);
  keybar(g, H - 1, [['↵', t('open')], ['n', t('new project')], ['↑↓←→', t('choose')], ['r', t('refresh')], ['q', t('quit')]], status);
}
