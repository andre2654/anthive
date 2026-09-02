/**
 * O Chrome do projeto. O anthive é dono do processo — lança oculto (headless,
 * sem janela nem ícone no Dock) ou com janela (que nasce sem roubar o foco) —,
 * o Playwright do agente se liga a ele por CDP (`--cdp-endpoint`), e o anthive
 * lê a MESMA página por CDP: screencast ao vivo, clique, rolagem, texto.
 * Perfil persistente por browser (logins ficam), mesmo trocando de modo.
 */
import { readdir, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type BrowserMode = 'oculto' | 'janela';
export const MODE_LABEL: Record<BrowserMode, string> = { oculto: 'oculto', janela: 'janela' };

export interface Chrome { bundle: string; bin: string; name: string }

const exists = (p: string) => access(p).then(() => true, () => false);

/** O Chrome do Playwright (Chrome for Testing) primeiro: é um app separado do Chrome do usuário. Senão, o Google Chrome. */
export async function findChrome(): Promise<Chrome | null> {
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    const dirs = (await readdir(cache)).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const d of dirs) {
      for (const sub of await readdir(join(cache, d)).catch(() => [] as string[])) {
        if (!sub.startsWith('chrome-mac')) continue;
        for (const app of ['Google Chrome for Testing.app', 'Chromium.app']) {
          const bundle = join(cache, d, sub, app), name = app.replace(/\.app$/, ''), bin = join(bundle, 'Contents', 'MacOS', name);
          if (await exists(bin)) return { bundle, bin, name };
        }
      }
    }
  } catch {}
  const bundle = '/Applications/Google Chrome.app', bin = join(bundle, 'Contents', 'MacOS', 'Google Chrome');
  if (await exists(bin)) return { bundle, bin, name: 'Google Chrome' };
  return null;
}

export function launchArgs(profile: string, port: number, mode: BrowserMode): string[] {
  const common = [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
    // janela coberta ou fora da tela continua desenhando — é o que alimenta o screencast
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-size=1200,800',
  ];
  // oculto: headless novo, nem janela nem Dock. janela: sem janela inicial — ela nasce quando alguém navega, e aí não rouba o foco.
  return mode === 'oculto' ? ['--headless=new', ...common, 'about:blank'] : ['--no-startup-window', ...common];
}

export async function launchChrome(chrome: Chrome, profile: string, port: number, mode: BrowserMode) {
  await mkdir(profile, { recursive: true });
  const args = launchArgs(profile, port, mode);
  if (mode === 'oculto') {
    // sessão própria (setsid), sem terminal: sobrevive ao anthive fechar — nohup não basta, o Chrome reinstala o SIGHUP.
    // perl vem com o macOS; setsid(1) não.
    const detach = 'use POSIX; POSIX::setsid(); open(STDIN, "</dev/null"); open(STDOUT, ">/dev/null"); open(STDERR, ">/dev/null"); exec @ARGV or exit 1;';
    Bun.spawn(['perl', '-e', detach, chrome.bin, ...args], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  } else {
    // -n: instância nova mesmo com o app já aberto; -g: não vem para a frente
    Bun.spawn(['open', '-n', '-g', '-a', chrome.bundle, '--args', ...args], { stdout: 'ignore', stderr: 'ignore' });
  }
}

export async function isUp(port: number): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) })).ok; } catch { return false; }
}
export async function waitUp(port: number, ms = 12000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await isUp(port)) return true; await Bun.sleep(200); }
  return false;
}

export interface PageInfo { id: string; url: string; title: string; attached?: boolean }
const ownPage = (url: string) => /^(chrome|devtools|chrome-extension):/.test(url);

/** Páginas abertas, pelo endpoint HTTP (barato; serve para o mapa sem abrir websocket). */
export async function pages(port: number): Promise<PageInfo[]> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(400) });
    const list = await r.json() as any[];
    return list.filter((t) => t.type === 'page' && !ownPage(String(t.url))).map((t) => ({ id: String(t.id), url: String(t.url), title: String(t.title) }));
  } catch { return []; }
}

/** A página que interessa: a última que tem alguém ligado (o Playwright do agente), senão a última de todas. */
export function pickPage<T extends PageInfo>(list: T[]): T | null {
  const real = list.filter((t) => !ownPage(t.url));
  const att = real.filter((t) => t.attached);
  return att[att.length - 1] ?? real[real.length - 1] ?? null;
}

/** Fecha pelo protocolo; se não responder, derruba o processo pela porta. */
export async function closeChrome(port: number) {
  try {
    const c = await Cdp.connect(port);
    await Promise.race([c.send('Browser.close'), Bun.sleep(2000)]);
    c.close();
  } catch {}
  await Bun.sleep(300);
  if (await isUp(port)) Bun.spawnSync(['pkill', '-f', `remote-debugging-port=${port}`]);
}

/** Uma porta livre para o Chrome deste browser. */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const port = 9300 + Math.floor(Math.random() * 600);
    try { const s = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('') }); s.stop(true); return port; } catch {}
  }
  return 9222;
}

// ---------------------------------------------------------------- geometria
/** Quantas células a imagem ocupa para caber em maxCols×maxRows mantendo a proporção da página. */
export function fitImage(frameW: number, frameH: number, maxCols: number, maxRows: number, cellW: number, cellH: number): { cols: number; rows: number } {
  const aspect = Math.max(0.1, frameW / Math.max(1, frameH));
  let cols = Math.max(1, maxCols), rows = Math.round((cols * cellW) / aspect / cellH);
  if (rows > maxRows) { rows = Math.max(1, maxRows); cols = Math.round((rows * cellH * aspect) / cellW); }
  return { cols: Math.max(1, Math.min(cols, maxCols)), rows: Math.max(1, rows) };
}
/** Célula clicada dentro da caixa → coordenada CSS na página. */
export function toPage(cx: number, cy: number, box: { x: number; y: number; cols: number; rows: number }, frameW: number, frameH: number) {
  return { x: Math.round(((cx - box.x + 0.5) / box.cols) * frameW), y: Math.round(((cy - box.y + 0.5) / box.rows) * frameH) };
}
export const inBox = (cx: number, cy: number, b: { x: number; y: number; cols: number; rows: number }) => cx >= b.x && cx < b.x + b.cols && cy >= b.y && cy < b.y + b.rows;

// ---------------------------------------------------------------- cliente
export interface CdpMsg { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string }
export type CdpKey = 'Enter' | 'Backspace' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Escape';
const KEYCODES: Record<CdpKey, number> = { Enter: 13, Backspace: 8, Tab: 9, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Escape: 27 };

/** JSON-RPC do Chrome DevTools sobre websocket, com sessões (flatten). */
export class Cdp {
  private seq = 0;
  private waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private listeners = new Set<(m: CdpMsg) => void>();
  closed = false;
  onClose?: () => void;

  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => { this.closed = true; for (const w of this.waiting.values()) w.rej(new Error('CDP fechou')); this.waiting.clear(); this.onClose?.(); };
    ws.onerror = () => {};
  }
  static async connect(port: number): Promise<Cdp> {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    const v = await r.json() as any;
    return Cdp.open(String(v.webSocketDebuggerUrl));
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.onopen = () => res(new Cdp(ws));
      ws.onerror = () => rej(new Error('não conectou ao CDP'));
    });
  }
  private onMessage(raw: string) {
    let m: CdpMsg; try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined && this.waiting.has(m.id)) {
      const w = this.waiting.get(m.id)!; this.waiting.delete(m.id);
      if (m.error) w.rej(new Error(m.error.message)); else w.res(m.result ?? {});
      return;
    }
    for (const l of this.listeners) l(m);
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CDP fechou'));
    const id = ++this.seq;
    return new Promise<T>((res, rej) => { this.waiting.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  on(fn: (m: CdpMsg) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  close() { this.closed = true; try { this.ws.close(); } catch {} }

  async targets(): Promise<PageInfo[]> {
    const r = await this.send('Target.getTargets');
    return (r.targetInfos as any[]).filter((t) => t.type === 'page').map((t) => ({ id: String(t.targetId), url: String(t.url), title: String(t.title), attached: !!t.attached }));
  }
  async attach(targetId: string): Promise<string> { return (await this.send('Target.attachToTarget', { targetId, flatten: true })).sessionId; }
  async click(sid: string, x: number, y: number) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sid);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, sid);
  }
  wheel(sid: string, x: number, y: number, dy: number) { return this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }, sid); }
  text(sid: string, text: string) { return this.send('Input.insertText', { text }, sid); }
  async key(sid: string, key: CdpKey) {
    const ev = { key, code: key, windowsVirtualKeyCode: KEYCODES[key], nativeVirtualKeyCode: KEYCODES[key], ...(key === 'Enter' ? { text: '\r' } : {}) };
    await this.send('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...ev }, sid);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev }, sid);
  }
}
