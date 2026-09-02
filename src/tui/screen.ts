export type Key =
  | { k: 'char'; c: string }
  | { k: 'up' | 'down' | 'left' | 'right' | 'enter' | 'esc' | 'tab' | 'backspace' }
  | { k: 'mouse'; x: number; y: number; button: number; press: boolean }
  | { k: 'wheel'; dir: -1 | 1; x: number; y: number }
  | { k: 'cellpx'; w: number; h: number }     // resposta a CSI 16 t: tamanho da célula em pixels
  | { k: 'winpx'; w: number; h: number };     // resposta a CSI 14 t: área de texto em pixels

const ALT_ON = '\x1b[?1049h', ALT_OFF = '\x1b[?1049l';
const CUR_OFF = '\x1b[?25l', CUR_ON = '\x1b[?25h';
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h', MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

export class Screen {
  W = 80; H = 24;
  private restored = false;
  private onResize?: () => void;
  private mouse = true;

  constructor(opts: { mouse?: boolean } = {}) {
    this.mouse = opts.mouse !== false;
    this.measure();
  }

  measure() {
    this.W = Math.max(40, process.stdout.columns || 80);
    this.H = Math.max(12, process.stdout.rows || 24);
  }

  enter(onResize: () => void) {
    this.onResize = onResize;
    process.stdout.write(ALT_ON + CUR_OFF + (this.mouse ? MOUSE_ON : '') + '\x1b[2J');
    this.askCellSize();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdout.on('resize', this.handleResize);
    // Restaurar o terminal é obrigatório em qualquer saída, senão o shell fica quebrado.
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, this.bail);
    process.on('exit', () => this.restore());
    process.on('uncaughtException', (e) => { this.restore(); console.error(e); process.exit(1); });
  }

  private handleResize = () => { this.measure(); this.askCellSize(); this.onResize?.(); };
  /** Pede o tamanho da célula em pixels (CSI 16 t); a resposta chega pelo stdin como Key 'cellpx'. */
  askCellSize() { if (process.stdout.isTTY) process.stdout.write('\x1b[16t'); }
  private bail = () => { this.restore(); process.exit(0); };

  restore() {
    if (this.restored) return;
    this.restored = true;
    process.stdout.write((this.mouse ? MOUSE_OFF : '') + CUR_ON + ALT_OFF);
    if (process.stdin.isTTY) try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
  }

  write(s: string) { if (s) process.stdout.write(s); }

  /** Traduz o buffer cru em eventos. Um chunk pode trazer vários. */
  static parse(buf: string): Key[] {
    const out: Key[] = [];
    let i = 0;
    while (i < buf.length) {
      const c = buf[i]!;
      if (c === '\x1b') {
        const rest = buf.slice(i);
        // mouse SGR: ESC [ < b ; x ; y (M|m)
        const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
        if (m) {
          const b = +m[1]!, x = +m[2]! - 1, y = +m[3]! - 1, press = m[4] === 'M';
          if (b === 64 || b === 65) out.push({ k: 'wheel', dir: b === 64 ? -1 : 1, x, y });
          else out.push({ k: 'mouse', x, y, button: b, press });
          i += m[0].length; continue;
        }
        // XTWINOPS: o terminal responde ao pedido de tamanho da célula/janela em pixels
        const px = /^\x1b\[(6|4);(\d+);(\d+)t/.exec(rest);
        if (px) { out.push({ k: px[1] === '6' ? 'cellpx' : 'winpx', h: +px[2]!, w: +px[3]! }); i += px[0].length; continue; }
        const a = /^\x1b\[([ABCD])/.exec(rest);
        if (a) {
          out.push({ k: ({ A: 'up', B: 'down', C: 'right', D: 'left' } as const)[a[1] as 'A'] });
          i += 3; continue;
        }
        const other = /^\x1b\[[\d;]*[~A-Za-z]/.exec(rest);
        if (other) { i += other[0].length; continue; }
        out.push({ k: 'esc' }); i += 1; continue;
      }
      if (c === '\r' || c === '\n') { out.push({ k: 'enter' }); i++; continue; }
      if (c === '\t') { out.push({ k: 'tab' }); i++; continue; }
      if (c === '\x7f' || c === '\b') { out.push({ k: 'backspace' }); i++; continue; }
      if (c === '\x03') { out.push({ k: 'char', c: 'q' }); i++; continue; } // ctrl-c
      out.push({ k: 'char', c }); i++;
    }
    return out;
  }

  onKey(fn: (k: Key) => void) {
    process.stdin.on('data', (d: Buffer) => { for (const k of Screen.parse(d.toString('utf8'))) fn(k); });
  }
}
