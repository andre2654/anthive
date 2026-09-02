/**
 * Chat com um agente, de dentro do anthive.
 *
 * Um processo `claude -p --input-format stream-json --output-format stream-json`
 * fica vivo enquanto o chat estiver aberto; cada turno é uma linha JSON no
 * stdin. Ele escreve no MESMO .jsonl da sessão, então a tela de memória e o
 * chat são uma coisa só. Modelo, esforço e permissão são flags reais da CLI —
 * trocar qualquer um reinicia o processo com `--resume`, sem perder nada.
 */
import { Ev, evFromStream, usageOf, Usage } from './sessions.ts';
import { ROOT, ensure } from './store.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Vai em --append-system-prompt de todo chat e primeiro turno. Sem isto o Claude
 * confunde "criar nota" e "ligar agente" com skills de outros canvases
 * (maestri, nodeterm) instaladas globalmente — aconteceu de verdade.
 */
export const SYSTEM_PREAMBLE = [
  'Você está sendo operado pelo anthive, um mapa de projetos no terminal.',
  'Neste ambiente, notas, ligações, conversa entre agentes e o mapa do projeto são as ferramentas MCP do servidor "anthive":',
  'note_write (cria uma nota já ligada a você), note_read, notes_list, project_map, send_message, inbox, thread_read, thread_post, thread_conclude, agents_list.',
  'Quando o usuário pedir para criar uma nota, se ligar a algo, ver o projeto ou falar com outro agente, use essas ferramentas.',
  'Não use skills nem CLIs de outros canvases (maestri, nodeterm, etc.) para isso — não estão ativos nesta sessão.',
].join(' ');

/** Copiado do jeito que o Maestri instrui o portal: snapshot primeiro, refs como seletor, screenshot só para ver layout. */
export const BROWSER_PREAMBLE = [
  'Você tem um browser (servidor MCP "playwright", ferramentas browser_*).',
  'Comece SEMPRE com browser_snapshot: ele devolve a árvore de acessibilidade da página com refs — use esses refs em browser_click, browser_type e browser_fill_form; é o seletor mais confiável.',
  'browser_take_screenshot só quando precisar ver layout; para ler a página, snapshot basta.',
  'browser_navigate devolve só URL, título e o caminho de um arquivo em .playwright-mcp/ (não o snapshot): depois de navegar ou clicar, chame browser_snapshot de novo antes de agir.',
  'Se as ferramentas browser_* aparecerem como adiadas, carregue todas de uma vez com ToolSearch (select:mcp__playwright__browser_snapshot,mcp__playwright__browser_navigate,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_fill_form,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_console_messages).',
  'A página é compartilhada: o usuário a vê ao vivo no terminal e pode clicar ou digitar nela; trabalhe na aba atual e não abra abas novas sem necessidade.',
  'Nunca chame browser_close por conta própria. Não versione a pasta .playwright-mcp/.',
].join(' ');

export const MODELS = ['claude-opus-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const PERMISSIONS = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

export interface ChatOpts {
  cwd: string;
  resume?: string;
  sessionId?: string;      // nova sessão com este id (agente criado sem tmux)
  model?: string;
  effort?: string;
  permissionMode?: string;
  agent?: string;          // nome no barramento, vira ANTHIVE_AGENT
  browser?: boolean;       // ligado a um browser do projeto: autoriza mcp__playwright e instrui
}

export interface RateWindow { fiveHour: number; sevenDay: number; resetsAt: number; seenAt?: number }

const RATE_FILE = () => join(ROOT, 'rate.json');

/** Última janela vista por qualquer chat — o mapa mostra mesmo sem chat aberto. */
export async function saveRate(r: RateWindow) {
  await ensure();
  await writeFile(RATE_FILE(), JSON.stringify({ ...r, seenAt: Date.now() }), 'utf8');
}
export async function loadRate(): Promise<RateWindow | null> {
  try {
    const r = JSON.parse(await readFile(RATE_FILE(), 'utf8')) as RateWindow;
    // depois que a janela reinicia, o número antigo é mentira
    if (r.resetsAt && r.resetsAt < Date.now()) return null;
    if (r.seenAt && Date.now() - r.seenAt > 6 * 3600_000) return null;
    return r;
  } catch { return null; }
}

export type ChatEvent =
  | { kind: 'init'; sessionId: string; model: string; permissionMode: string }
  | { kind: 'thinking'; tokens: number }
  | { kind: 'ev'; ev: Ev }
  | { kind: 'task'; detail: string }
  | { kind: 'summary'; category: string; detail: string; needsAction: string }
  | { kind: 'rate'; rate: RateWindow }
  | { kind: 'result'; text: string; cost: number; usage?: Usage; denials: string[]; stop: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'exit'; code: number };

export class ChatSession {
  proc: ReturnType<typeof Bun.spawn> | null = null;
  sessionId: string | null;
  model: string;
  effort: string;
  permissionMode: string;
  busy = false;
  turns = 0;
  cost = 0;
  thinking = 0;
  summary = '';
  rate: RateWindow | null = null;
  lastError = '';
  cwdResolved = '';     // como o Claude Code enxerga o cwd (symlinks resolvidos)

  constructor(public opts: ChatOpts, private onEvent: (e: ChatEvent) => void) {
    this.sessionId = opts.resume ?? opts.sessionId ?? null;
    this.model = opts.model ?? '';
    this.effort = opts.effort ?? '';
    this.permissionMode = opts.permissionMode ?? '';
  }

  /** As ferramentas do barramento já autorizadas: em -p não há prompt de permissão, só negação. */
  static readonly ALLOWED = ['--allowedTools', 'mcp__anthive'];

  argv(): string[] {
    // --allowedTools é variádico (engole tudo até a próxima flag): aqui não há prompt posicional, mas vai antes das outras flags por garantia
    const sys = this.opts.browser ? `${SYSTEM_PREAMBLE} ${BROWSER_PREAMBLE}` : SYSTEM_PREAMBLE;
    const a = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', sys, '--allowedTools', 'mcp__anthive', ...(this.opts.browser ? ['mcp__playwright'] : [])];
    if (this.sessionId) a.push(this.opts.resume || this.turns > 0 ? '--resume' : '--session-id', this.sessionId);
    if (this.model) a.push('--model', this.model);
    if (this.effort) a.push('--effort', this.effort);
    if (this.permissionMode) a.push('--permission-mode', this.permissionMode);
    return a;
  }

  start() {
    const env: Record<string, string> = { ...process.env as Record<string, string>, ANTHIVE_HOME: ROOT };
    if (this.opts.agent) env.ANTHIVE_AGENT = this.opts.agent;
    this.proc = Bun.spawn(this.argv(), {
      cwd: this.opts.cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    void this.pump();
    void this.pumpErr();
    this.proc.exited.then((code) => {
      this.busy = false;
      this.onEvent({ kind: 'exit', code });
    });
  }

  /** Um turno seu. Devolve false se o processo não está de pé. */
  send(text: string): boolean {
    const p = this.proc;
    if (!p || !p.stdin || typeof p.stdin === 'number') return false;
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    p.stdin.write(line + '\n');
    p.stdin.flush();
    this.busy = true;
    this.thinking = 0;
    this.turns++;
    return true;
  }

  stop() {
    const p = this.proc;
    if (!p) return;
    try { if (p.stdin && typeof p.stdin !== 'number') p.stdin.end(); } catch {}
    try { p.kill(); } catch {}
    this.proc = null;
    this.busy = false;
  }

  /** Troca modelo/esforço/permissão: reinicia com --resume na mesma sessão. */
  restart(patch: Partial<Pick<ChatSession, 'model' | 'effort' | 'permissionMode'>>) {
    Object.assign(this, patch);
    this.stop();
    this.start();
  }

  private async pump() {
    const p = this.proc;
    if (!p || !p.stdout || typeof p.stdout === 'number') return;
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of p.stdout) {
      buf += dec.decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.handle(line);
      }
    }
  }

  private async pumpErr() {
    const p = this.proc;
    if (!p || !p.stderr || typeof p.stderr === 'number') return;
    const dec = new TextDecoder();
    for await (const chunk of p.stderr) {
      const t = dec.decode(chunk).trim();
      if (t) { this.lastError = t.split('\n')[0]!; this.onEvent({ kind: 'stderr', text: t }); }
    }
  }

  private handle(line: string) {
    let o: any;
    try { o = JSON.parse(line); } catch { return; }
    const t = o.type, st = o.subtype;

    if (t === 'system') {
      if (st === 'init') {
        this.sessionId = o.session_id ?? this.sessionId;
        this.cwdResolved = o.cwd ?? this.cwdResolved;
        this.model = o.model ?? this.model;
        this.permissionMode = o.permissionMode ?? this.permissionMode;
        this.onEvent({ kind: 'init', sessionId: this.sessionId ?? '', model: this.model, permissionMode: this.permissionMode });
      } else if (st === 'thinking_tokens') {
        this.thinking = o.estimated_tokens ?? this.thinking;
        this.onEvent({ kind: 'thinking', tokens: this.thinking });
      } else if (st === 'task_summary' && o.detail) {
        this.summary = o.detail;
        this.onEvent({ kind: 'task', detail: o.detail });
      } else if (st === 'post_turn_summary') {
        this.summary = o.status_detail ?? '';
        this.onEvent({ kind: 'summary', category: o.status_category ?? '', detail: o.status_detail ?? '', needsAction: o.needs_action ?? '' });
      }
      return;
    }

    if (t === 'rate_limit_event') {
      const w = o.rate_limit_info?.unifiedWindows ?? {};
      const norm = (v: any) => { const n = Number(v ?? 0); return n > 1 ? n / 100 : n; };
      this.rate = {
        fiveHour: norm(w.five_hour?.utilization),
        sevenDay: norm(w.seven_day?.utilization),
        resetsAt: (w.five_hour?.resetsAt ?? o.rate_limit_info?.resetsAt ?? 0) * 1000,
      };
      void saveRate(this.rate);
      this.onEvent({ kind: 'rate', rate: this.rate });
      return;
    }

    if (t === 'result') {
      this.busy = false;
      this.cost += Number(o.total_cost_usd ?? 0);
      this.onEvent({
        kind: 'result', text: String(o.result ?? ''), cost: Number(o.total_cost_usd ?? 0),
        usage: usageOf(o), denials: (o.permission_denials ?? []).map((d: any) => d?.tool_name ?? String(d)),
        stop: o.stop_reason ?? st ?? '',
      });
      return;
    }

    const ev = evFromStream(o);
    if (ev) this.onEvent({ kind: 'ev', ev });
  }
}
