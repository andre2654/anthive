/**
 * Paleta e vocabulário de glifos.
 *
 * REGRA DE ALINHAMENTO (não negociável):
 * todo glifo desenhado tem que ocupar exatamente 1 célula em qualquer terminal.
 * Box drawing (U+2500–257F), blocos (U+2580–259F) e braille (U+2800–28FF) são
 * seguros. Qualquer coisa com apresentação emoji ocupa 2 células e arrebenta a
 * linha inteira à direita. `assertNarrow` derruba isso em dev.
 */

export type RGB = readonly [number, number, number];

export const C = {
  frame:  [0x39, 0x42, 0x4f],
  dim:    [0x6d, 0x78, 0x89],
  ink:    [0xcf, 0xd6, 0xe2],
  inkHi:  [0xf4, 0xf7, 0xfb],
  run:    [0x5e, 0xe0, 0xa0],
  hold:   [0xe8, 0xb0, 0x4b],
  dead:   [0xf4, 0x68, 0x5c],
  idle:   [0x5b, 0x66, 0x75],
  link:   [0xa5, 0x8c, 0xf0],
  linkDim:[0x5c, 0x4d, 0x8a],
  sparkR: [0x2f, 0x7a, 0x56],
  sparkH: [0x7a, 0x60, 0x29],
  sparkI: [0x3a, 0x42, 0x4e],
  sparkD: [0x7a, 0x38, 0x32],
} satisfies Record<string, RGB>;

/** Glifos verificados single-width. Nunca adicione um sem passar por assertNarrow. */
export const G = {
  // moldura
  tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│',
  teeL: '├', teeR: '┤', teeD: '┬', teeU: '┴',
  // arestas pesadas (conversa)
  hH: '━', hV: '┃',
  jL: '┝', jR: '┥', jD: '┳', jU: '┸', jDown: '┰',
  // aresta tracejada (anexo)
  dH: '┄', dV: '┆',
  // estados
  running: '●', waiting: '◆', idle: '○', stuck: '✕', focus: '◉', note: '◇',
  // marcadores
  tool: '▸', sub: '⤷', cut: '▚', pause: '‖', swap: '⇄', arrow: '→', ell: '…',
  branchMid: '├─', branchEnd: '╰─',
} as const;

/** Rampa braille de 1 a 8 níveis — 2×4 subpixels por célula, igual ao btop. */
export const SPARK = ['⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;

/** Blocos horizontais para barras de progresso. */
export const BAR = ['⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;

/**
 * Rejeita qualquer coisa que possa ocupar 2 células.
 * Cobre os blocos de emoji, o seletor de variação 16 e pares substitutos.
 */
export function isNarrow(ch: string): boolean {
  if ([...ch].length !== 1) return false;
  const cp = ch.codePointAt(0)!;
  if (cp === 0xfe0f) return false;              // variation selector-16 → emoji
  if (cp > 0xffff) return false;                // fora do BMP → quase sempre emoji
  if (cp >= 0x1f300) return false;
  if (cp >= 0x2600 && cp <= 0x27bf) {           // Misc Symbols + Dingbats
    const safe = new Set([0x2713, 0x2714, 0x2715, 0x2717]);
    if (!safe.has(cp)) return false;
  }
  if (cp >= 0x2b00 && cp <= 0x2bff) return false;
  // Geometric Shapes que têm apresentação emoji e viram 2 células
  if ([0x25aa, 0x25ab, 0x25b6, 0x25c0, 0x25fb, 0x25fc, 0x25fd, 0x25fe].includes(cp)) return false;
  if (cp >= 0x23e9 && cp <= 0x23fa) return false; // ⏩ ⏸ ⏹ …
  // CJK, Hangul, Kana: genuinamente 2 células
  if (cp >= 0x1100 && cp <= 0x115f) return false;
  if (cp >= 0x2e80 && cp <= 0xa4cf) return false;
  if (cp >= 0xac00 && cp <= 0xd7a3) return false;
  if (cp >= 0xf900 && cp <= 0xfaff) return false;
  if (cp >= 0xfe30 && cp <= 0xfe6f) return false;
  if (cp >= 0xff00 && cp <= 0xff60) return false;
  return true;
}

/** Trunca para caber em `w` células, com reticências. Conteúdo nunca empurra borda. */
export function fit(s: string, w: number): string {
  if (w <= 0) return '';
  const chars = [...s];
  if (chars.length <= w) return s;
  if (w === 1) return G.ell;
  return chars.slice(0, w - 1).join('') + G.ell;
}

/** Preenche à direita até `w` células exatas (trunca se passar). */
export function pad(s: string, w: number): string {
  const t = fit(s, w);
  return t + ' '.repeat(Math.max(0, w - [...t].length));
}

/** Preenche à esquerda até `w` células exatas. */
export function padStart(s: string, w: number): string {
  const t = fit(s, w);
  return ' '.repeat(Math.max(0, w - [...t].length)) + t;
}

export const fg = (c: RGB) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';

/** Sparkline braille. Escala pelo pico da própria série. */
export function sparkline(values: number[], width: number): string {
  if (width <= 0) return '';
  const v = values.slice(-width);
  while (v.length < width) v.unshift(0);
  const max = Math.max(1, ...v);
  return v.map((n) => SPARK[Math.min(SPARK.length - 1, Math.round((n / max) * (SPARK.length - 1)))]!).join('');
}

/** Barra de preenchimento em braille, 0..1. */
export function gauge(frac: number, width: number): string {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.floor(f * width);
  const rest = f * width - full;
  let s = SPARK[SPARK.length - 1]!.repeat(full);
  if (full < width) s += SPARK[Math.min(SPARK.length - 1, Math.round(rest * (SPARK.length - 1)))]!;
  return s.padEnd(width, SPARK[0]!).slice(0, width);
}

/** "4m12s", "11m", "2h04" — sempre curto e de largura previsível. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)}d`;
}

/** "104k", "1.2M" */
export function tok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const bgAnsi = (c: RGB) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;

/** Fundos de superfície — usados no modal e na linha selecionada. */
export const BG = {
  panel: [0x14, 0x18, 0x21],
  input: [0x1c, 0x22, 0x2e],
  sel:   [0x1b, 0x1f, 0x2c],
} satisfies Record<string, RGB>;
