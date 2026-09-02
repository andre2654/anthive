/**
 * Tela inicial: os projetos, um cartão cada, e o `+ Novo` no fim.
 * Setas escolhem, ↵ entra, n cria. Nada além disso aqui.
 */
import { Grid, Rect } from '../tui/grid.ts';
import { C, G, BG, ago, pad, padStart, fit, sparkline } from '../tui/theme.ts';
import { ProjectCard } from '../core/project.ts';
import { keybar, scrollHint } from './chrome.ts';

export const CARD_H = 5;

export interface HomeLayout { rects: { key: string; rect: Rect }[]; cols: number; cardW: number; height: number }

export function layoutHome(n: number, W: number, scroll = 0): HomeLayout {
  const avail = W - 4;
  let cols = 3, cardW = 0;
  for (cols = 3; cols >= 1; cols--) {
    cardW = Math.min(36, Math.floor((avail - (cols - 1) * 3) / cols));
    if (cardW >= 24) break;
  }
  if (cols < 1) { cols = 1; cardW = Math.max(20, avail); }
  const rects: HomeLayout['rects'] = [];
  const total = n + 1;   // + Novo
  for (let i = 0; i < total; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    rects.push({ key: i < n ? `proj:${i}` : 'new', rect: { x: 2 + col * (cardW + 3), y: 2 + row * (CARD_H + 1) - scroll, w: cardW, h: CARD_H } });
  }
  const rows = Math.ceil(total / cols);
  return { rects, cols, cardW, height: 2 + rows * (CARD_H + 1) };
}

function card(g: Grid, c: ProjectCard, r: Rect, on: boolean) {
  const inner = r.w - 4;
  if (on) g.fill(r, BG.sel);
  g.frame(r, c.project.name, on ? C.link : c.registered ? C.inkHi : C.ink, on ? C.link : C.frame);
  const live = c.running > 0;
  const l1 = live ? `${G.running} ${c.running} rodando` : c.sessions.length ? `${G.idle} ${c.sessions.length} sess${c.sessions.length === 1 ? 'ão' : 'ões'}` : `${G.idle} sem sessão`;
  g.put(r.x + 2, r.y + 1, pad(l1, inner - 7), live ? C.run : C.dim);
  g.put(r.x + 2 + inner - 7, r.y + 1, padStart(c.sessions.length ? ago(c.lastMs) : '', 7), C.frame);
  const home = process.env.HOME ?? '';
  g.put(r.x + 2, r.y + 2, pad(c.project.cwd.replace(home, '~'), inner), C.frame);
  const spark = c.sessions.flatMap((s) => s.spark).slice(-inner);
  g.put(r.x + 2, r.y + 3, spark.length ? sparkline(spark, inner) : pad(c.registered ? 'registrado' : 'descoberto pelas sessões', inner), spark.length ? (live ? C.sparkR : C.sparkI) : C.frame);
}

function newCard(g: Grid, r: Rect, on: boolean) {
  if (on) g.fill(r, BG.sel);
  g.frame(r, '', C.frame, on ? C.link : C.frame);
  const t = '+ Novo';
  g.put(r.x + Math.floor((r.w - t.length) / 2), r.y + 2, t, on ? C.link : C.dim);
}

export function renderHome(g: Grid, cards: ProjectCard[], selected: string, scroll: number, status: string) {
  const { W, H } = g;
  g.frame({ x: 0, y: 0, w: W, h: H }, 'anthive', C.inkHi);
  const right = ` ${cards.length} projeto${cards.length === 1 ? '' : 's'} `;
  g.put(W - 2 - right.length, 0, right, C.dim);

  const L = layoutHome(cards.length, W, scroll);
  const top = 1, bottom = H - 4;
  for (const { key, rect } of L.rects) {
    if (rect.y < top || rect.y + rect.h - 1 > bottom) continue;
    if (key === 'new') newCard(g, rect, selected === key);
    else card(g, cards[Number(key.slice(5))]!, rect, selected === key);
    g.hit(key, rect);
  }
  g.put(0, H - 3, G.teeL + G.h.repeat(W - 2) + G.teeR, C.frame);
  scrollHint(g, H - 3, L.rects.filter((r) => r.rect.y < top).length, L.rects.filter((r) => r.rect.y + r.rect.h - 1 > bottom).length);
  keybar(g, H - 2, [['↑↓←→', 'selecionar'], ['↵', 'entrar'], ['n', 'novo projeto'], ['q', 'sair']], status);
}
