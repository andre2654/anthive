/**
 * A página do agente ao vivo: segue o alvo certo (o que tem o Playwright
 * ligado, senão o último), recebe o screencast, repassa clique/rolagem/texto
 * e reconecta sozinho se o Chrome cair ou for trocado de modo.
 */
import { Cdp, CdpKey, CdpMsg, PageInfo, pickPage } from './cdp.ts';

export interface Frame { data: string; w: number; h: number; at: number }   // w/h: viewport em px CSS (não o tamanho do PNG)

export class LiveView {
  cdp: Cdp | null = null;
  sid: string | null = null;
  target: PageInfo | null = null;
  frame: Frame | null = null;
  url = ''; title = ''; error = '';
  frames = 0;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAt = 0;
  private busy = false;

  constructor(private port: number, private onChange: () => void, private opts: { maxWidth?: number; maxHeight?: number; minGapMs?: number } = {}) {}

  get connected() { return !!this.cdp && !!this.sid; }

  async start() {
    this.stopped = false;
    await this.connect();
    this.timer = setInterval(() => void this.tick(), 1500);
  }

  private async connect() {
    try {
      const cdp = await Cdp.connect(this.port);
      this.cdp = cdp; this.error = '';
      cdp.onClose = () => { if (this.stopped) return; this.cdp = null; this.sid = null; this.error = 'chrome caiu — tentando de novo'; this.onChange(); };
      cdp.on((m) => this.onEvent(m));
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      await this.follow();
    } catch (e) { this.cdp = null; this.sid = null; this.error = (e as Error).message; }
    this.onChange();
  }

  /** Muda de alvo quando o agente abre outra aba; senão só atualiza url/título. */
  private async follow() {
    const cdp = this.cdp; if (!cdp) return;
    let t = pickPage(await cdp.targets());
    if (!t) {
      // modo janela sobe sem página nenhuma (--no-startup-window): cria uma — a janela nasce sem roubar o foco
      try { await cdp.send('Target.createTarget', { url: 'about:blank' }); await Bun.sleep(300); t = pickPage(await cdp.targets()); } catch {}
      if (!t) { this.target = null; this.sid = null; return; }
    }
    if (this.target?.id === t.id && this.sid) { if (t.url !== this.url || t.title !== this.title) { this.url = t.url; this.title = t.title; this.onChange(); } return; }
    if (this.sid) { try { await cdp.send('Page.stopScreencast', {}, this.sid); await cdp.send('Target.detachFromTarget', { sessionId: this.sid }); } catch {} }
    this.target = t; this.url = t.url; this.title = t.title;
    const sid = await cdp.attach(t.id); this.sid = sid;
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Page.startScreencast', { format: 'png', maxWidth: this.opts.maxWidth ?? 1000, maxHeight: this.opts.maxHeight ?? 800, everyNthFrame: 1 }, sid);
    this.onChange();
  }

  private onEvent(m: CdpMsg) {
    if (m.method === 'Page.screencastFrame' && m.sessionId === this.sid && this.cdp) {
      void this.cdp.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }, this.sid).catch(() => {});
      const now = Date.now();
      if (now - this.lastAt < (this.opts.minGapMs ?? 120)) return;   // no máximo ~8 por segundo chegam à tela
      this.lastAt = now; this.frames++;
      this.frame = { data: String(m.params.data), w: Number(m.params.metadata?.deviceWidth) || 1200, h: Number(m.params.metadata?.deviceHeight) || 800, at: now };
      this.onChange();
    } else if (m.method === 'Target.targetInfoChanged' && m.params?.targetInfo?.targetId === this.target?.id) {
      const ti = m.params.targetInfo;
      if (ti.url !== this.url || ti.title !== this.title) { this.url = String(ti.url); this.title = String(ti.title); this.onChange(); }
    } else if (m.method === 'Target.targetCreated' || m.method === 'Target.targetDestroyed') void this.tick();
  }

  private async tick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try { if (!this.cdp) await this.connect(); else await this.follow(); } catch { /* alvo sumiu; a próxima volta resolve */ }
    this.busy = false;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    const c = this.cdp; this.cdp = null;
    if (c) { if (this.sid) c.send('Page.stopScreencast', {}, this.sid).catch(() => {}); setTimeout(() => c.close(), 50); }
    this.sid = null;
  }

  // ---- interação (fire and forget: a tela reflete pelo próximo frame)
  click(x: number, y: number) { if (this.cdp && this.sid) void this.cdp.click(this.sid, x, y).catch(() => {}); }
  wheel(x: number, y: number, dy: number) { if (this.cdp && this.sid) void this.cdp.wheel(this.sid, x, y, dy).catch(() => {}); }
  text(t: string) { if (this.cdp && this.sid) void this.cdp.text(this.sid, t).catch(() => {}); }
  key(k: CdpKey) { if (this.cdp && this.sid) void this.cdp.key(this.sid, k).catch(() => {}); }
  reload() { if (this.cdp && this.sid) void this.cdp.send('Page.reload', {}, this.sid).catch(() => {}); }
  navigate(url: string) { if (this.cdp && this.sid) void this.cdp.send('Page.navigate', { url }, this.sid).catch(() => {}); }
}
