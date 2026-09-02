import { C, G, RGB, fg, bgAnsi, RESET, isNarrow, pad, fit } from './theme.ts';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Hit extends Rect { key: string }

const packed = (c: RGB) => (c[0] << 16) | (c[1] << 8) | c[2];
const unpack = (n: number): RGB => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

/**
 * Grade de caracteres. Uma célula = um caractere + uma cor.
 * Desenhar é sempre por coordenada absoluta; nada reflui.
 */
export class Grid {
  readonly W: number;
  readonly H: number;
  private ch: string[];
  private co: Int32Array;
  private bgc: Int32Array;
  hits: Hit[] = [];
  /** Onde o cursor real do terminal deve aparecer; null esconde. */
  cursor: { x: number; y: number } | null = null;

  constructor(w: number, h: number) {
    this.W = w; this.H = h;
    this.ch = new Array(w * h).fill(' ');
    this.co = new Int32Array(w * h).fill(packed(C.ink));
    this.bgc = new Int32Array(w * h).fill(-1);
  }

  clear() {
    this.ch.fill(' ');
    this.co.fill(packed(C.ink));
    this.bgc.fill(-1);
    this.hits = [];
    this.cursor = null;
  }

  put(x: number, y: number, text: string, color: RGB = C.ink, bg?: RGB) {
    if (y < 0 || y >= this.H) return;
    const p = packed(color);
    const b = bg ? packed(bg) : -1;
    let i = 0;
    for (const c of text) {
      const cx = x + i;
      i++;
      if (cx < 0 || cx >= this.W) continue;
      const j = y * this.W + cx;
      if (bg) this.bgc[j] = b;
      // A regra: nada de largura dupla entra na grade.
      if (!isNarrow(c)) { this.ch[j] = '?'; this.co[j] = packed(C.dead); continue; }
      this.ch[j] = c;
      this.co[j] = p;
    }
  }

  /** Superfície opaca: limpa os caracteres e pinta o fundo. É o que um modal precisa. */
  panel(r: Rect, bg: RGB) {
    const b = packed(bg), ink = packed(C.ink);
    for (let y = r.y; y < r.y + r.h; y++) {
      if (y < 0 || y >= this.H) continue;
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 0 || x >= this.W) continue;
        const j = y * this.W + x;
        this.ch[j] = ' '; this.co[j] = ink; this.bgc[j] = b;
      }
    }
  }

  /** Pinta o fundo de um retângulo sem tocar nos caracteres. */
  fill(r: Rect, bg: RGB) {
    const b = packed(bg);
    for (let y = r.y; y < r.y + r.h; y++) {
      if (y < 0 || y >= this.H) continue;
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 0 || x >= this.W) continue;
        this.bgc[y * this.W + x] = b;
      }
    }
  }

  /** Texto já truncado e preenchido para largura exata. */
  field(x: number, y: number, text: string, w: number, color: RGB = C.ink) {
    this.put(x, y, pad(text, w), color);
  }

  hLine(x: number, y: number, w: number, char = G.h, color = C.frame) {
    this.put(x, y, char.repeat(Math.max(0, w)), color);
  }

  vLine(x: number, y: number, h: number, char = G.v, color = C.frame) {
    for (let i = 0; i < h; i++) this.put(x, y + i, char, color);
  }

  /** Moldura simples. O conteúdo é responsabilidade de quem chama. */
  frame(r: Rect, title = '', titleColor: RGB = C.inkHi, color: RGB = C.frame) {
    const { x, y, w, h } = r;
    if (w < 4 || h < 2) return;
    const t = fit(title, Math.max(0, w - 6));
    const used = t ? t.length + 4 : 2;
    this.put(x, y, G.tl + G.h + (t ? ' ' : ''), color);
    if (t) this.put(x + 3, y, t, titleColor);
    this.put(x + used, y, G.h.repeat(Math.max(0, w - used - 1)) + G.tr, color);
    for (let i = 1; i < h - 1; i++) {
      this.put(x, y + i, G.v, color);
      this.put(x + w - 1, y + i, G.v, color);
    }
    this.put(x, y + h - 1, G.bl + G.h.repeat(w - 2) + G.br, color);
  }

  /** O que está desenhado numa célula — usado para rotear sem atropelar texto. */
  /** Everything in one cell — what a renderer other than the terminal needs (docs/shots.ts draws PNGs from it). */
  cell(x: number, y: number): { ch: string; fg: RGB; bg: RGB | null } {
    const i = y * this.W + x;
    return { ch: this.ch[i] ?? ' ', fg: unpack(this.co[i] ?? packed(C.ink)), bg: (this.bgc[i] ?? -1) < 0 ? null : unpack(this.bgc[i]!) };
  }

  at(x: number, y: number): string {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return '';
    return this.ch[y * this.W + x]!;
  }

  hit(key: string, r: Rect) { this.hits.push({ key, ...r }); }

  /** Qual nó está sob (col,row)? Coordenadas 0-based. */
  hitTest(x: number, y: number): string | null {
    for (const h of this.hits) {
      if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return h.key;
    }
    return null;
  }

  /** Emite só o que mudou desde o frame anterior. */
  diff(prev: Grid | null): string {
    const out: string[] = [];
    let lastColor = -1, lastBg = -2;
    let at = -1;
    const same = prev && prev.W === this.W && prev.H === this.H;
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const i = y * this.W + x;
        if (same && prev!.ch[i] === this.ch[i] && prev!.co[i] === this.co[i] && prev!.bgc[i] === this.bgc[i]) continue;
        if (at !== i) { out.push(`\x1b[${y + 1};${x + 1}H`); at = i; }
        if (this.bgc[i] !== lastBg) {
          lastBg = this.bgc[i]!;
          out.push(lastBg < 0 ? '\x1b[49m' : bgAnsi(unpack(lastBg)));
        }
        if (this.co[i] !== lastColor) { out.push(fg(unpack(this.co[i]!))); lastColor = this.co[i]!; }
        out.push(this.ch[i]!);
        at = i + 1;
      }
    }
    if (out.length) out.push(RESET);
    // Cursor real — o terminal pisca sozinho. Só reemite se desenhei algo (o
    // desenho move o cursor) ou se ele mudou de lugar.
    const pc = prev?.cursor ?? null, cc = this.cursor;
    const moved = (pc?.x ?? -1) !== (cc?.x ?? -1) || (pc?.y ?? -1) !== (cc?.y ?? -1);
    if (out.length || moved) {
      if (cc) out.push(`\x1b[${cc.y + 1};${cc.x + 1}H\x1b[?25h`);
      else if (moved || !prev) out.push('\x1b[?25l');
    }
    return out.join('');
  }

  /** Snapshot para o diff do próximo frame. */
  snapshot(): Grid {
    const g = new Grid(this.W, this.H);
    g.ch = this.ch.slice();
    g.co = Int32Array.from(this.co);
    g.bgc = Int32Array.from(this.bgc);
    g.cursor = this.cursor;
    return g;
  }

  /** Texto puro, sem cor — usado nos testes. */
  toString(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.H; y++) rows.push(this.ch.slice(y * this.W, (y + 1) * this.W).join(''));
    return rows.join('\n');
  }
}
