/**
 * O que os agentes produziram no projeto, reconstruído dos transcripts.
 *
 * Três fontes, da mais confiável para a menos: as ferramentas de escrita
 * (Write/Edit/MultiEdit/NotebookEdit), o redirecionamento no shell (a maior
 * parte do trabalho real sai de `cat > arquivo`), e o próprio sistema de
 * arquivos, para o que nenhuma chamada nomeia — uma planilha gerada por um
 * script, por exemplo. Tudo lido de linhas cruas: `Ev` descarta o id do
 * tool_use e joga fora a entrada acima de 64 KB, que é justamente o caso dos
 * arquivos grandes. Cursor incremental como em subagents.ts: o mapa atualiza
 * a cada 2 s e um transcript pode ter 144 MB.
 */
import { readdir, stat, access } from 'node:fs/promises';
import { join, dirname, basename, resolve, normalize } from 'node:path';
import { isTurn, textOf } from './subagents.ts';

export type How = 'tool' | 'shell' | 'seen';
export interface Write { path: string; how: How; count: number; ts: number; by: string }
export interface Moment { ts: number; kind: 'turn' | 'subagent' | 'wrote'; who: string; what: string }

const FIRST = 8 * 1024 * 1024;            // primeira passada: só a cauda, o resto é história antiga
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const HAS_WRITE = /"name":"(Write|Edit|MultiEdit|NotebookEdit|Bash|Agent|Task)"|"type":"user"/;
const SKIP_DIR = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '.next', '__pycache__', 'target', 'vendor', '.turbo', 'coverage']);
/** Alvos de `>`, `>>`, `tee` e `sed -i`. Casa muito lixo de propósito: o filtro real é o arquivo existir. */
const REDIRECT = /(?:(?<![0-9&])>>?|\btee\b(?:\s+-a)?)\s+([^\s;|&<>()"'`]+)|\bsed\s+-i(?:\.\w+)?\s+(?:-e\s+\S+\s+)?\S+\s+([^\s;|&<>()"'`]+)/g;

const safeJSON = (l: string): any | null => { try { return JSON.parse(l); } catch { return null; } };
const exists = (p: string) => access(p).then(() => true, () => false);
const inside = (p: string, roots: string | string[]) => (Array.isArray(roots) ? roots : [roots]).some((r) => r && (p === r || p.startsWith(r + '/')));

/** Alvos de escrita de um comando de shell, resolvidos contra o diretório do agente. */
export function shellTargets(cmd: string, cwd: string | string[]): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(REDIRECT)) {
    const raw = (m[1] ?? m[2] ?? '').replace(/^['"]|['"]$/g, '');
    if (!raw || raw.startsWith('/dev/') || raw.startsWith('$') || /^\d+$/.test(raw)) continue;
    const base = Array.isArray(cwd) ? cwd[0]! : cwd;
    const p = raw.startsWith('/') ? normalize(raw) : normalize(resolve(base, raw));
    if (inside(p, cwd)) out.push(p);
  }
  return out;
}

/** As escritas de um pedaço de transcript. Puro: quem checa o disco é quem chama. */
export function writesFromLines(lines: string[], by: string, cwd: string | string[]): Write[] {
  const calls = new Map<string, Write>();
  const failed = new Set<string>();
  const out: Write[] = [];
  for (const line of lines) {
    if (!line || !HAS_WRITE.test(line)) continue;
    const o = safeJSON(line);
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    const ts = Date.parse(o.timestamp ?? '') || 0;
    for (const b of c) {
      if (b?.type === 'tool_use' && b.id) {
        const inp = b.input ?? {};
        if (WRITE_TOOLS.has(b.name)) {
          const p = String(inp.file_path ?? inp.notebook_path ?? inp.path ?? '');
          if (p && inside(p, cwd)) calls.set(String(b.id), { path: p, how: 'tool', count: 1, ts, by });
        } else if (b.name === 'Bash') {
          for (const p of shellTargets(String(inp.command ?? ''), cwd)) out.push({ path: p, how: 'shell', count: 1, ts, by });
        }
      }
      if (b?.type === 'tool_result' && b.is_error && b.tool_use_id) failed.add(String(b.tool_use_id));
    }
  }
  for (const [id, w] of calls) if (!failed.has(id)) out.push(w);
  return out;
}

/** Os momentos de um pedaço de transcript: o que você pediu, quem foi chamado, o que foi escrito. */
export function momentsFromLines(lines: string[], who: string, cwd: string | string[]): Moment[] {
  const out: Moment[] = [];
  for (const line of lines) {
    if (!line || !HAS_WRITE.test(line)) continue;
    const o = safeJSON(line);
    if (!o) continue;
    const ts = Date.parse(o.timestamp ?? '') || 0;
    if (isTurn(o)) { const tx = textOf(o.message?.content).replace(/\s+/g, ' ').trim(); if (tx) out.push({ ts, kind: 'turn', who, what: tx }); continue; }
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type !== 'tool_use') continue;
      const inp = b.input ?? {};
      if (b.name === 'Agent' || b.name === 'Task') out.push({ ts, kind: 'subagent', who, what: String(inp.description ?? '') });
      else if (WRITE_TOOLS.has(b.name)) { const p = String(inp.file_path ?? inp.notebook_path ?? ''); if (p && inside(p, cwd)) out.push({ ts, kind: 'wrote', who, what: p }); }
      else if (b.name === 'Bash') for (const p of shellTargets(String(inp.command ?? ''), cwd)) out.push({ ts, kind: 'wrote', who, what: p });
    }
  }
  return out;
}

// ---------------------------------------------------------------- leitura incremental
interface Cursor { size: number; off: number; writes: Write[]; moments: Moment[] }
const cursors = new Map<string, Cursor>();

/** Lê só o que cresceu desde a última olhada; a primeira passada é limitada à cauda. */
async function scan(path: string, size: number, by: string, cwd: string | string[]): Promise<Cursor> {
  const cur = cursors.get(path) ?? { size: 0, off: Math.max(0, size - FIRST), writes: [], moments: [] };
  if (size < cur.size) { cur.size = 0; cur.off = 0; cur.writes = []; cur.moments = []; }   // transcript reescrito: começa de novo
  if (cur.size === size && cursors.has(path)) return cur;
  const chunk = await Bun.file(path).slice(cur.off, size).text().catch(() => '');
  const end = chunk.lastIndexOf('\n');
  cur.size = size;
  if (end >= 0) {
    const lines = chunk.slice(0, end).split('\n');
    if (cur.off > 0 && !cursors.has(path)) lines.shift();   // a primeira linha da cauda vem cortada
    cur.writes.push(...writesFromLines(lines, by, cwd));
    cur.moments.push(...momentsFromLines(lines, by, cwd));
    cur.off += end + 1;
    if (cur.moments.length > 400) cur.moments = cur.moments.slice(-400);
  }
  cursors.set(path, cur);
  return cur;
}

/** Os transcripts dos subagentes de uma sessão: três dos quatro relatórios do usuário nasceram aí. */
export async function subTranscripts(path: string): Promise<string[]> {
  const dir = join(path.replace(/\.jsonl$/, ''), 'subagents');
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n));
}

async function sizeOf(p: string): Promise<number> { return stat(p).then((s) => s.size, () => 0); }

/** Tudo que a sessão escreveu, dela e dos subagentes dela, mesclado por caminho. */
export async function writesOfSession(path: string, size: number, by: string, cwd: string | string[]): Promise<Write[]> {
  const parts = [await scan(path, size, by, cwd)];
  for (const s of await subTranscripts(path)) parts.push(await scan(s, await sizeOf(s), by, cwd));
  const rank: Record<How, number> = { tool: 2, shell: 1, seen: 0 };
  const merged = new Map<string, Write>();
  for (const w of parts.flatMap((p) => p.writes)) {
    const cur = merged.get(w.path);
    if (!cur) { merged.set(w.path, { ...w }); continue; }
    cur.count += w.count;
    cur.ts = Math.max(cur.ts, w.ts);
    if (rank[w.how] > rank[cur.how]) cur.how = w.how;
  }
  const out: Write[] = [];
  for (const w of merged.values()) if (await exists(w.path)) out.push(w);   // o palpite do shell só vale se o arquivo existe
  return out.sort((a, b) => b.ts - a.ts);
}

/**
 * A história recente de um conjunto de agentes, mais nova por último.
 * As linhas de escrita passam pelo mesmo filtro das escritas: sem ele o
 * palpite do shell enche a faixa de pedaços de heredoc.
 */
export async function historyOf(agents: { name: string; path: string; size: number; cwd: string | string[] }[], limit = 40): Promise<Moment[]> {
  const all: Moment[] = [];
  const real = new Set<string>();
  for (const a of agents) {
    for (const w of await writesOfSession(a.path, a.size, a.name, a.cwd)) real.add(w.path);
    const cur = await scan(a.path, a.size, a.name, a.cwd);
    all.push(...cur.moments);
    for (const s of await subTranscripts(a.path)) {
      const sub = await scan(s, await sizeOf(s), a.name, a.cwd);
      all.push(...sub.moments.filter((m) => m.kind === 'wrote'));   // o subagente não tem turno seu
    }
  }
  const seen = new Set<string>();
  return all
    .filter((m) => m.kind !== 'wrote' || real.has(m.what))
    .filter((m) => { const k = `${m.kind}:${m.what}:${Math.round(m.ts / 1000)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.ts - b.ts)
    .slice(-limit);
}

// ---------------------------------------------------------------- o que o disco sabe
const walks = new Map<string, { at: number; files: { path: string; ts: number }[] }>();
const WALK_TTL = 10_000, WALK_CAP = 4000, WALK_DEPTH = 4;

/** Arquivos do projeto mexidos depois de `since`. Limitado e com cache: num repo grande a varredura custa 350 ms. */
export async function changedFiles(cwd: string, since: number): Promise<{ path: string; ts: number }[]> {
  const hit = walks.get(cwd);
  if (hit && Date.now() - hit.at < WALK_TTL) return hit.files.filter((f) => f.ts >= since);
  const out: { path: string; ts: number }[] = [];
  let seen = 0, bail = false;
  const walk = async (d: string, k: number): Promise<void> => {
    if (k > WALK_DEPTH || bail) return;
    const ents = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      if (bail) return;
      if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, k + 1);
      else { if (++seen > WALK_CAP) { bail = true; return; } const st = await stat(p).catch(() => null); if (st) out.push({ path: p, ts: st.mtimeMs }); }
    }
  };
  await walk(cwd, 0);
  const files = bail ? [] : out;   // repositório grande demais: o disco fica fora, os transcripts bastam
  walks.set(cwd, { at: Date.now(), files });
  return files.filter((f) => f.ts >= since);
}

/** O rótulo curto de um caminho, relativo ao projeto. */
export const relTo = (cwd: string, p: string) => (inside(p, cwd) ? p.slice(cwd.length + 1) : p);
/** A pasta de um caminho, relativa ao projeto; a raiz vira '.'. */
export const folderOf = (cwd: string, p: string) => dirname(relTo(cwd, p)) || '.';
export { basename };
