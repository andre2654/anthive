import { Grid } from '../tui/grid.ts';
import { C, G, fit } from '../tui/theme.ts';

/** Rodapé de teclas. Corta em vez de atropelar a borda; status só entra se sobrar espaço. */
export function keybar(
  g: Grid, y: number, keys: [string, string][], status: string, urgent?: string,
) {
  const limit = g.W - 2;
  let x = 2;
  for (const [k, l] of keys) {
    const need = k.length + 1 + l.length;
    if (x + need > limit) { g.put(x, y, G.ell, C.frame); break; }
    const hot = urgent === k;
    g.put(x, y, k, hot ? C.hold : C.inkHi);
    g.put(x + k.length + 1, y, l, hot ? C.hold : C.dim);
    x += need + 3;
  }
  if (!status) return;
  const room = limit - x - 1;
  if (room < 8) return;
  const t = fit(status, room);
  g.put(limit - t.length, y, t, C.link);
}

/** Marca que existe conteúdo fora da área visível. */
export function scrollHint(g: Grid, y: number, above: number, below: number) {
  if (above > 0) g.put(g.W - 4, y, '▲', C.linkDim);
  if (below > 0) {
    const t = `▼ mais ${below}`;
    g.put(g.W - 2 - t.length, y, t, C.linkDim);
  }
}
