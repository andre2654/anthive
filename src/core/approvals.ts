/**
 * Permission requests, answered on the map. In print mode Claude Code cannot
 * ask; with `--permission-prompt-tool` every request reaches the bus instead.
 * The bus decides alone when a remembered rule or a linked file covers it,
 * otherwise it writes the request to disk and waits for the user's answer,
 * which the TUI gives with a key. Files, so the two processes never need to
 * talk directly — the same principle as the rest of the store.
 */
import { mkdir, readFile, writeFile, readdir, unlink, access } from 'node:fs/promises';
import { join, basename, isAbsolute, resolve } from 'node:path';
import { ROOT } from './store.ts';
import type { Graph, Rule, FileItem } from './project.ts';

export type Decision = 'allow' | 'deny';
export interface Request {
  id: string; agent: string; project: string | null; cwd: string;
  tool: string; input: Record<string, unknown>; toolUseId?: string;
  ts: number; state: 'pending' | Decision; reason?: string;
}

export const DIR = () => join(ROOT, 'approvals');
const file = (id: string) => join(DIR(), `${id}.json`);

/** One line that says what the request is: the command, or the path/url/query. */
export function summary(tool: string, input: Record<string, unknown>): string {
  const s = tool === 'Bash' ? input.command : input.file_path ?? input.path ?? input.url ?? input.query ?? input.pattern ?? input.description;
  return (s !== undefined ? String(s) : JSON.stringify(input)).replace(/\s+/g, ' ').trim().slice(0, 400);
}

/** What "always allow this" should remember: the command up to its first flag, or the path. */
export const TRUST = '*';   // a rule with tool '*' means: everything this agent asks is allowed

export function prefixOf(tool: string, input: Record<string, unknown>): string {
  if (tool === 'WebSearch') return '';   // the whole tool: a rule per query would never match again
  if (tool === 'WebFetch') { try { return new URL(String(input.url ?? '')).origin; } catch { return ''; } }
  if (tool !== 'Bash') return summary(tool, input);
  const toks = String(input.command ?? '').trim().split(/\s+/);
  const cut = toks.findIndex((t, i) => i > 0 && t.startsWith('-'));
  return (cut > 0 ? toks.slice(0, cut) : toks).join(' ').slice(0, 200);
}

export const matchesRule = (rule: Rule, tool: string, input: Record<string, unknown>) => rule.tool === TRUST || (rule.tool === tool && (rule.prefix === '' || summary(tool, input).startsWith(rule.prefix)));
export const isTrusted = (g: Graph, agent: string) => (g.rules ?? []).some((r) => r.agent === agent && r.tool === TRUST);
/** How a rule reads on screen: WebSearch(*), WebFetch(https://x.com:*), Bash(git log:*), or "everything". */
export const ruleLabel = (tool: string, prefix: string) => tool === TRUST ? 'everything' : `${tool}(${prefix ? `${prefix}:*` : '*'})`;

/** The linked file the request touches, if any: by absolute path, by path relative to the project, or by bare file name. */
export function touchesLinked(tool: string, input: Record<string, unknown>, files: FileItem[], cwd: string): FileItem | null {
  const text = summary(tool, input);
  const toks = text.split(/[\s"'`]+/).filter(Boolean);
  for (const f of files) {
    const rel = f.path.startsWith(cwd + '/') ? f.path.slice(cwd.length + 1) : null;
    if (toks.some((t) => t === f.path || (rel && (t === rel || t === `./${rel}`)) || t === basename(f.path) || t.endsWith(`/${basename(f.path)}`) && resolve(cwd, t) === f.path)) return f;
  }
  return null;
}

/** A path in the request that exists inside the project and is not linked yet — what `l` (allow and link) would link. */
export async function fileIn(req: Request, linked: FileItem[]): Promise<string | null> {
  for (const t of summary(req.tool, req.input).split(/[\s"'`]+/)) {
    if (!t || t.startsWith('-') || !/[./]/.test(t)) continue;
    const p = isAbsolute(t) ? t : resolve(req.cwd, t);
    if (!p.startsWith(req.cwd + '/') || linked.some((f) => f.path === p)) continue;
    try { await access(p); return p; } catch {}
  }
  return null;
}

/** The files linked to an agent, by its name. */
export function linkedFiles(g: Graph, agent: string): FileItem[] {
  const a = g.items.find((i) => i.kind === 'agent' && i.name === agent);
  if (!a) return [];
  const ids = new Set(g.links.filter((l) => l.from === a.id || l.to === a.id).map((l) => (l.from === a.id ? l.to : l.from)));
  return g.items.filter((i): i is FileItem => i.kind === 'file' && ids.has(i.id));
}

/** Decides without the user when a rule or a linked file covers the request. */
export function autoDecide(req: Pick<Request, 'agent' | 'tool' | 'input' | 'cwd'>, g: Graph): { state: 'allow'; reason: string } | null {
  const rule = (g.rules ?? []).find((r) => r.agent === req.agent && matchesRule(r, req.tool, req.input));
  if (rule) return { state: 'allow', reason: rule.tool === TRUST ? 'trusted agent' : `rule: ${ruleLabel(rule.tool, rule.prefix)}` };
  const f = touchesLinked(req.tool, req.input, linkedFiles(g, req.agent), req.cwd);
  if (f) return { state: 'allow', reason: `linked file: ${f.label}` };
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Writes the request and waits for the answer (the TUI writes it); no answer in time → deny. */
export async function ask(req: Omit<Request, 'id' | 'ts' | 'state'>, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<{ state: Decision; reason?: string }> {
  await mkdir(DIR(), { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const full: Request = { ...req, id, ts: Date.now(), state: 'pending' };
  await writeFile(file(id), JSON.stringify(full, null, 2), 'utf8');
  const end = Date.now() + (opts.timeoutMs ?? 900_000);
  try {
    while (Date.now() < end) {
      await sleep(opts.pollMs ?? 250);
      let cur: Request; try { cur = JSON.parse(await readFile(file(id), 'utf8')); } catch { return { state: 'deny', reason: 'the request vanished' }; }
      if (cur.state !== 'pending') return { state: cur.state, reason: cur.reason };
    }
    return { state: 'deny', reason: 'nobody answered in Anthive in time' };
  } finally { await unlink(file(id)).catch(() => {}); }
}

/** Requests waiting for the user — for one project, or all when the project is unknown. */
export async function pending(project?: string | null): Promise<Request[]> {
  let names: string[]; try { names = await readdir(DIR()); } catch { return []; }
  const out: Request[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { const r: Request = JSON.parse(await readFile(join(DIR(), n), 'utf8')); if (r.state === 'pending' && (!project || !r.project || r.project === project)) out.push(r); } catch {}
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export async function decide(id: string, state: Decision, reason?: string) {
  const r: Request = JSON.parse(await readFile(file(id), 'utf8'));
  await writeFile(file(id), JSON.stringify({ ...r, state, reason }, null, 2), 'utf8');
}
