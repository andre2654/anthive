/**
 * A primitiva única: um documento markdown endereçável, com quem pode ler e um
 * tempo de vida. Nota, conversa e memória promovida são o mesmo objeto com
 * políticas diferentes.
 *
 * Tudo é arquivo em disco — grepável, versionável, editável no $EDITOR. Sem banco.
 */
import { mkdir, readdir, readFile, writeFile, appendFile, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROOT = process.env.ANTHIVE_HOME ?? join(homedir(), '.anthive');
export const NOTES = join(ROOT, 'notes');
export const THREADS = join(ROOT, 'threads');

export type Kind = 'note' | 'thread';

export interface Doc {
  id: string;
  kind: Kind;
  title: string;
  acl: string[];          // agentes que podem ler; vazio = só você
  ttl: number | null;     // epoch ms de expiração; null = persistente
  created: number;
  goal?: string;          // só thread
  budget?: number;        // só thread: teto de turnos
  project?: string;       // id do projeto dono
  body: string;
  path: string;
}

export interface Post { author: string; ts: number; text: string; concluded: boolean }

/** Slug curto e digitável: para na fronteira de palavra, nunca no meio. */
export function slugify(s: string, max = 28): string {
  const words = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (out.length && [...out, w].join('-').length > max) break;
    out.push(w);
  }
  return out.join('-').slice(0, max) || 'nota';
}

export function parseTTL(s: string | undefined): number | null {
  if (!s || s === 'keep' || s === 'persistente') return null;
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  if (!m) return null;
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as 's'];
  return Date.now() + Number(m[1]) * mult;
}

const dirFor = (k: Kind) => (k === 'note' ? NOTES : THREADS);

export async function ensure() {
  // Before the rename this lived in ~/.anthive: move it once, keep everything (projects, notes, threads, browsers).
  if (!process.env.ANTHIVE_HOME) {
    const old = join(homedir(), '.anthive');
    const has = async (p: string) => stat(p).then(() => true, () => false);
    if (!(await has(ROOT)) && (await has(old))) { const { rename } = await import('node:fs/promises'); await rename(old, ROOT); }
  }
  await mkdir(NOTES, { recursive: true });
  await mkdir(THREADS, { recursive: true });
}

function frontmatter(d: Omit<Doc, 'body' | 'path'>): string {
  const lines = [
    '---',
    `id: ${d.id}`,
    `kind: ${d.kind}`,
    `title: ${d.title}`,
    `acl: ${d.acl.join(', ')}`,
    `ttl: ${d.ttl ? new Date(d.ttl).toISOString() : 'none'}`,
    `created: ${new Date(d.created).toISOString()}`,
  ];
  if (d.goal !== undefined) lines.push(`goal: ${d.goal}`);
  if (d.budget !== undefined) lines.push(`budget: ${d.budget}`);
  if (d.project !== undefined) lines.push(`project: ${d.project}`);
  lines.push('---', '');
  return lines.join('\n');
}

function parse(text: string, path: string, kind: Kind): Doc | null {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return null;
  const head: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const ttlRaw = head.ttl ?? 'none';
  return {
    id: head.id ?? '?',
    kind: (head.kind as Kind) ?? kind,
    title: head.title ?? head.id ?? '?',
    acl: (head.acl ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ttl: ttlRaw === 'none' || ttlRaw === 'persistente' ? null : Date.parse(ttlRaw) || null,   // 'persistente': notes written before the rename
    created: Date.parse(head.created ?? '') || 0,
    goal: head.goal,
    budget: head.budget ? Number(head.budget) : undefined,
    project: head.project,
    body: text.slice(m[0].length),
    path,
  };
}

export const isExpired = (d: Doc) => d.ttl !== null && d.ttl < Date.now();
export const uri = (d: Doc) => `${d.kind}://${d.id}`;

export async function create(opts: {
  kind: Kind; title: string; body?: string; acl?: string[]; ttl?: number | null;
  goal?: string; budget?: number; id?: string; project?: string;
}): Promise<Doc> {
  await ensure();
  const id = opts.id ?? slugify(opts.title);
  const doc: Omit<Doc, 'body' | 'path'> = {
    id, kind: opts.kind, title: opts.title,
    acl: opts.acl ?? [], ttl: opts.ttl ?? null, created: Date.now(),
    ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.project !== undefined ? { project: opts.project } : {}),
  };
  const path = join(dirFor(opts.kind), `${id}.md`);
  await writeFile(path, frontmatter(doc) + (opts.body ?? ''), 'utf8');
  return { ...doc, body: opts.body ?? '', path };
}

export class AmbiguousId extends Error {
  constructor(public partial: string, public matches: string[]) {
    super(`"${partial}" matches ${matches.length}: ${matches.join(', ')}`);
  }
}

/**
 * Resolve um id parcial. Exato ganha; senão prefixo; senão trecho.
 * Ambíguo é erro — melhor perguntar do que agir no documento errado.
 */
export async function resolveId(partial: string, kind?: Kind): Promise<string> {
  const all = await list(kind);
  const ids = all.map((d) => d.id);
  if (ids.includes(partial)) return partial;
  for (const pick of [ids.filter((i) => i.startsWith(partial)), ids.filter((i) => i.includes(partial))]) {
    if (pick.length === 1) return pick[0]!;
    if (pick.length > 1) throw new AmbiguousId(partial, pick);
  }
  return partial;
}

export async function read(id: string, kind?: Kind): Promise<Doc | null> {
  for (const k of kind ? [kind] : (['note', 'thread'] as Kind[])) {
    const path = join(dirFor(k), `${id}.md`);
    try {
      const text = await readFile(path, 'utf8');
      return parse(text, path, k);
    } catch {}
  }
  return null;
}

export async function list(kind?: Kind): Promise<Doc[]> {
  await ensure();
  const kinds: Kind[] = kind ? [kind] : ['note', 'thread'];
  const out: Doc[] = [];
  for (const k of kinds) {
    let names: string[];
    try { names = await readdir(dirFor(k)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const path = join(dirFor(k), n);
      try {
        const d = parse(await readFile(path, 'utf8'), path, k);
        if (d) out.push(d);
      } catch {}
    }
  }
  return out.sort((a, b) => b.created - a.created);
}

/** Reescreve o cabeçalho preservando o corpo. Usado por attach e promote. */
export async function update(d: Doc, patch: Partial<Doc>): Promise<Doc> {
  const next = { ...d, ...patch };
  const { body, path, ...head } = next;
  await writeFile(path, frontmatter(head) + body, 'utf8');
  return next;
}

export async function attach(idPartial: string, agents: string[]): Promise<Doc | null> {
  const d = await read(await resolveId(idPartial));
  if (!d) return null;
  return update(d, { acl: [...new Set([...d.acl, ...agents])] });
}

export async function detach(idPartial: string, agents: string[]): Promise<Doc | null> {
  const d = await read(await resolveId(idPartial));
  if (!d) return null;
  return update(d, { acl: d.acl.filter((a) => !agents.includes(a)) });
}

/** Promove a persistente — a nota efêmera vira memória. */
export async function promote(idPartial: string): Promise<Doc | null> {
  const d = await read(await resolveId(idPartial));
  if (!d) return null;
  return update(d, { ttl: null });
}

/** Remove as expiradas. Devolve os ids varridos. */
export async function sweep(): Promise<string[]> {
  const gone: string[] = [];
  for (const d of await list()) {
    if (!isExpired(d)) continue;
    try { await unlink(d.path); gone.push(d.id); } catch {}
  }
  return gone;
}

// ------------------------------------------------------------ append-only
const POST_RE = /^## (✓ )?([^\n·]+?) ?· (\S+)$/;

/**
 * Acrescenta um post. Append de verdade — o estado da conversa é derivado do
 * corpo, nunca de um contador no cabeçalho, então dois agentes escrevendo ao
 * mesmo tempo não corrompem nada.
 */
export async function post(id: string, author: string, text: string, conclude = false): Promise<void> {
  const path = join(THREADS, `${id}.md`);
  const head = `## ${conclude ? '✓ ' : ''}${author} · ${new Date().toISOString()}\n`;
  await appendFile(path, `${head}${text.trim()}\n\n`, 'utf8');
}

export function posts(d: Doc): Post[] {
  const out: Post[] = [];
  let cur: Post | null = null;
  for (const line of d.body.split('\n')) {
    const m = POST_RE.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { author: m[2]!.trim(), ts: Date.parse(m[3]!) || 0, text: '', concluded: !!m[1] };
    } else if (cur) cur.text += (cur.text ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out.map((p) => ({ ...p, text: p.text.trim() }));
}

export type ThreadState = 'open' | 'concluded' | 'exhausted';

export function threadState(d: Doc): { state: ThreadState; turn: number; budget: number } {
  const ps = posts(d);
  const budget = d.budget ?? 6;
  const turn = ps.length;
  if (ps.some((p) => p.concluded)) return { state: 'concluded', turn, budget };
  if (turn >= budget) return { state: 'exhausted', turn, budget };
  return { state: 'open', turn, budget };
}
