import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

/** Where Claude Code keeps transcripts; ANTHIVE_CLAUDE_PROJECTS overrides it (hermetic tests). */
export const PROJECTS = process.env.ANTHIVE_CLAUDE_PROJECTS ?? join(homedir(), '.claude', 'projects');

export type State = 'running' | 'waiting' | 'idle' | 'stuck' | 'sleeping';

export interface Usage { input: number; cacheRead: number; cacheWrite: number; output: number }

export interface Session {
  id: string;            // uuid curto da sessão
  path: string;
  project: string;       // nome legível do diretório de projeto
  cwd: string;
  branch: string;
  model: string;
  effort: string;      // low|medium|high|xhigh|max, como o Claude Code grava
  bytes: number;
  mtime: number;         // epoch ms
  ageMs: number;
  state: State;
  context: number;       // tokens vivos na janela
  burn: number;          // output tokens na janela lida
  spark: number[];       // amostras para o sparkline
  lastText: string;      // o que ele está fazendo agora
  pendingTool: string | null;
  pendingInput: string;  // argumentos da ferramenta parada, para você decidir
}

export interface Ev {
  uuid: string;
  parent: string | null;
  sidechain: boolean;
  type: string;
  ts: number;
  role?: string;
  text?: string;
  tool?: string;
  toolInput?: string;
  usage?: Usage;
  isCompact?: boolean;
  full?: string;         // texto inteiro, com parágrafos — para ler, não para resumir
  meta?: boolean;        // injetado por skill/sistema (isMeta), não é fala sua
  thinking?: string;     // o raciocínio gravado, quando o modelo o expõe
  input?: Record<string, unknown>;   // entrada da ferramenta (limitada), para tarefas e diffs
  result?: string;       // resultado da ferramenta (limitado) — snapshots do browser, saídas de comando
  resultFor?: string;    // id do tool_use a que o resultado responde
  image?: { media: string; data: string };   // imagem devolvida por ferramenta (screenshot), base64
  raw?: string;          // JSON original, cortado em 4 KB — para ver o evento cru
}

const TAIL = 256 * 1024;

function safeJSON(l: string): any | null {
  try { return JSON.parse(l); } catch { return null; }
}

/** Lê só o fim do arquivo e devolve as linhas completas. */
async function tailLines(path: string, bytes: number): Promise<any[]> {
  const f = Bun.file(path);
  const size = f.size;
  const start = Math.max(0, size - bytes);
  const text = await f.slice(start, size).text();
  const lines = text.split('\n');
  if (start > 0) lines.shift(); // primeira linha provavelmente cortada
  return lines.map(safeJSON).filter(Boolean);
}

export function usageOf(msg: any): Usage | undefined {
  let u = msg?.usage;
  if (!u) return undefined;
  // Respostas multi-iteração somam o cache de cada iteração no topo, o que infla
  // o contexto muito acima da janela real. A última iteração é o prompt de fato.
  if (Array.isArray(u.iterations) && u.iterations.length) u = u.iterations[u.iterations.length - 1];
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
}

export const contextOf = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;

/**
 * Janela do modelo. O nome do modelo nem sempre revela a janela de 1M, então
 * o contexto observado tem a palavra final — se passou de 200k, é 1M.
 */
export function windowOf(model: string, observed = 0): number {
  if (/\[1m\]|-1m/.test(model)) return 1_000_000;
  if (observed > 200_000) return 1_000_000;
  return 200_000;
}

/** Texto legível de um evento, para a linha "o que está fazendo". */
export function describe(o: any): { text: string; tool: string | null; full?: string; thinking?: string; input?: Record<string, unknown>; result?: string; resultFor?: string; image?: { media: string; data: string } } {
  const m = o.message;
  const c = m?.content;
  if (Array.isArray(c) && c[0]?.type === 'tool_result') {
    // resposta de ferramenta: guardo o texto (limitado) e uma imagem, se vier
    const b = c[0];
    const parts = Array.isArray(b.content) ? b.content : typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : [];
    const text = parts.filter((x: any) => x?.type === 'text').map((x: any) => String(x.text)).join('\n');
    const img = parts.find((x: any) => x?.type === 'image' && x.source?.data);
    return { text: '', tool: null, result: text.length > 20_000 ? text.slice(0, 20_000) + '\n…' : text, resultFor: String(b.tool_use_id ?? ''), image: img ? { media: String(img.source.media_type ?? 'image/png'), data: String(img.source.data) } : undefined };
  }
  if (typeof c === 'string') return { text: c.replace(/\s+/g, ' ').trim(), tool: null, full: c.trim() };
  if (Array.isArray(c)) {
    const thinking = c.filter((b: any) => b?.type === 'thinking' && b.thinking).map((b: any) => String(b.thinking).trim()).join('\n\n') || undefined;
    for (let i = c.length - 1; i >= 0; i--) {
      const b = c[i];
      if (b?.type === 'tool_use') {
        const inp = b.input ?? {};
        const hint = inp.file_path ?? inp.path ?? inp.pattern ?? inp.command ?? inp.description ?? inp.query ?? inp.url ?? '';
        // entrada guardada só quando é pequena o bastante para ser útil na tela (tarefas, edições)
        const cap = b.name === 'Edit' || b.name === 'MultiEdit' || b.name === 'Write' ? 64_000 : 12_000;
        const keep = JSON.stringify(inp).length <= cap ? inp : undefined;
        return { text: `${b.name} ${String(hint).replace(/\s+/g, ' ')}`.trim(), tool: b.name, thinking, input: keep };
      }
      if (b?.type === 'text' && b.text?.trim()) return { text: b.text.replace(/\s+/g, ' ').trim(), tool: null, full: b.text.trim(), thinking };
    }
    if (thinking) return { text: 'pensando', tool: null, thinking };
  }
  return { text: '', tool: null };
}

function deriveState(ageMs: number, pendingTool: string | null): State {
  const min = ageMs / 60000;
  if (min < 0.75) return 'running';
  if (pendingTool && min < 10) return 'waiting';
  if (pendingTool) return 'stuck';
  if (min < 60) return 'idle';
  return 'sleeping';
}

/** Resumo barato de uma sessão: só o fim do arquivo. */
export async function summarize(path: string): Promise<Session | null> {
  let st;
  try { st = await stat(path); } catch { return null; }
  if (st.size === 0) return null;

  const evs = await tailLines(path, TAIL);
  if (!evs.length) return null;

  const last = evs[evs.length - 1];
  const meta = [...evs].reverse().find((e) => e.cwd) ?? last;

  // último assistant define contexto e o que está acontecendo
  let context = 0, burn = 0;
  const spark: number[] = [];
  let lastAssistant: any = null;
  for (const e of evs) {
    if (e.type !== 'assistant') continue;
    const u = usageOf(e.message);
    if (!u) continue;
    lastAssistant = e;
    burn += u.output;
    spark.push(u.output);
    context = contextOf(u);
  }

  // ferramenta pendente = último tool_use sem tool_result correspondente
  let pendingTool: string | null = null;
  let pendingInput = '';
  const results = new Set<string>();
  for (const e of evs) {
    const c = e.message?.content;
    if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_result' && b.tool_use_id) results.add(b.tool_use_id);
  }
  for (let i = evs.length - 1; i >= 0 && !pendingTool; i--) {
    const c = evs[i].message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type !== 'tool_use' || results.has(b.id)) continue;
      pendingTool = b.name;
      const inp = b.input ?? {};
      pendingInput = String(inp.command ?? inp.file_path ?? inp.path ?? inp.pattern ?? inp.url ?? inp.query ?? inp.description ?? '')
        .replace(/\s+/g, ' ').trim();
      break;
    }
  }

  const mtime = st.mtimeMs;
  const ageMs = Date.now() - mtime;
  const desc = describe(lastAssistant ?? last);

  return {
    id: basename(path).slice(0, 8),
    path,
    project: basename(join(path, '..')).replace(/^-Users-[^-]+-/, '').replace(/-/g, '/'),
    cwd: meta.cwd ?? '',
    branch: meta.gitBranch || '—',
    model: lastAssistant?.message?.model ?? '',
    effort: lastAssistant?.effort ?? '',
    bytes: st.size,
    mtime,
    ageMs,
    state: deriveState(ageMs, pendingTool),
    context,
    burn,
    spark: spark.slice(-40),
    lastText: desc.text,
    pendingTool,
    pendingInput,
  };
}

/** Todas as sessões, mais recentes primeiro. `limit` corta antes de ler conteúdo. */
export async function listSessions(limit = 40, cwdFilter?: string): Promise<Session[]> {
  let dirs: string[];
  try { dirs = await readdir(PROJECTS); } catch { return []; }

  const files: { path: string; mtime: number }[] = [];
  await Promise.all(dirs.map(async (d) => {
    const dir = join(PROJECTS, d);
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
      const p = join(dir, n);
      try { const s = await stat(p); if (s.size > 0) files.push({ path: p, mtime: s.mtimeMs }); } catch {}
    }));
  }));

  files.sort((a, b) => b.mtime - a.mtime);
  const picked = files.slice(0, Math.max(limit * 3, limit));
  const out = (await Promise.all(picked.map((f) => summarize(f.path)))).filter(Boolean) as Session[];
  const filtered = cwdFilter ? out.filter((s) => s.cwd === cwdFilter) : out;
  return filtered.slice(0, limit);
}

/** Um evento do stream-json do `claude -p` no mesmo formato do transcript. */
export function evFromStream(o: any): Ev | null {
  const t = o?.type;
  if (t !== 'user' && t !== 'assistant') return null;
  const d = describe(o);
  return {
    uuid: o.uuid ?? crypto.randomUUID(),
    parent: null,
    sidechain: !!o.parent_tool_use_id,
    type: t,
    ts: Date.parse(o.timestamp ?? '') || Date.now(),
    role: o.message?.role ?? t,
    text: d.text,
    tool: d.tool ?? undefined,
    usage: usageOf(o.message),
    full: d.full,
    meta: !!o.isMeta,
    thinking: d.thinking,
    input: d.input,
    result: d.result,
    resultFor: d.resultFor,
    image: d.image,
    raw: JSON.stringify(o).slice(0, 4000),
  };
}

/** Uma sessão pelo id, em qualquer projeto — para agentes que nasceram com id próprio. */
export async function sessionById(id: string): Promise<Session | null> {
  let dirs: string[];
  try { dirs = await readdir(PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const p = join(PROJECTS, d, `${id}.jsonl`);
    try { await stat(p); return await summarize(p); } catch {}
  }
  return null;
}

/** Parse completo de uma sessão — só para a tela de memória. */
export async function parseSession(path: string): Promise<Ev[]> {
  const text = await Bun.file(path).text();
  const evs: Ev[] = [];
  for (const line of text.split('\n')) {
    const o = safeJSON(line);
    if (!o?.uuid) continue;
    const t = o.type;
    if (t !== 'user' && t !== 'assistant' && t !== 'system' && t !== 'summary') continue;
    const d = describe(o);
    const isCompact = t === 'summary' || /compact/i.test(o.subtype ?? '') || !!o.isCompactSummary;
    evs.push({
      uuid: o.uuid,
      parent: o.parentUuid ?? null,
      sidechain: !!o.isSidechain,
      type: t,
      ts: Date.parse(o.timestamp ?? '') || 0,
      role: o.message?.role,
      text: d.text,
      tool: d.tool ?? undefined,
      usage: usageOf(o.message),
      full: d.full,
      meta: !!o.isMeta,
      thinking: d.thinking,
      input: d.input,
      result: d.result,
      resultFor: d.resultFor,
      image: d.image,
      isCompact,
      raw: line.length > 4000 ? line.slice(0, 4000) + '…' : line,
    });
  }
  return evs;
}
