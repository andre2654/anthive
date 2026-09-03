/**
 * The hive, searchable: notes and threads from the store, and the transcripts of
 * the agents of a project (what they said, thought, read and ran). Pure functions
 * over text, plus thin readers — the `project_search` bus tool is a wrapper.
 * Transcripts are pre-filtered line by line before any JSON is parsed: a 50 MB
 * transcript costs a regex pass, not a full parse.
 */
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import * as store from './store.ts';
import { PROJECTS, describe, sessionById, listSessions } from './sessions.ts';
import { Project, Graph, claudeSlug, loadGraph } from './project.ts';

export type Scope = 'all' | 'notes' | 'threads' | 'transcripts';
export interface Matcher { label: string; any: RegExp; all: RegExp[] }
export interface Hit { kind: 'note' | 'thread' | 'transcript'; source: string; author: string; ts: number; where: string; context: string; score: number }
export interface SearchResult { hits: Hit[]; counts: { notes: number; threads: number; transcripts: number }; scanned: number; bytes: number }

export const TAIL_CAP = 32 * 1024 * 1024;   // per transcript: the newest 32 MB
const MAX_TRANSCRIPTS = 12, PER_SOURCE = 6, DEFAULT_LIMIT = 20, MAX_LIMIT = 60;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `/re/` → one case-insensitive regex; anything else → every word must match (up to 8), case-insensitive. Throws on empty or invalid. */
export function matcher(query: string): Matcher {
  const q = query.trim();
  if (!q) throw new Error('empty query');
  const re = /^\/(.+)\/[a-z]*$/s.exec(q);
  if (re) return { label: q, any: new RegExp(re[1]!, 'i'), all: [new RegExp(re[1]!, 'i')] };
  const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
  return { label: q, any: new RegExp(words.map(esc).join('|'), 'i'), all: words.map((w) => new RegExp(esc(w), 'i')) };
}

const clip = (line: string, m: Matcher, max = 200) => {
  const l = line.trim();
  if (l.length <= max) return l;
  const at = Math.max(0, l.search(m.all[0]!));
  const start = Math.max(0, Math.min(at - 60, l.length - max));
  return (start ? '…' : '') + l.slice(start, start + max) + (start + max < l.length ? '…' : '');
};

/** All terms present → how many times the first term appears, and the matching line with one line of context each side. */
export function searchText(text: string, m: Matcher): { count: number; context: string } | null {
  if (!m.all.every((re) => re.test(text))) return null;
  const lines = text.split('\n');
  let idx = lines.findIndex((l) => m.all[0]!.test(l));
  if (idx < 0) idx = 0;
  const count = text.match(new RegExp(m.any.source, 'gi'))?.length ?? 1;
  const context = lines.slice(Math.max(0, idx - 1), idx + 2).filter((l) => l.trim()).map((l) => clip(l, m)).join(' ⏎ ');
  return { count, context };
}

const recency = (ts: number) => { const age = Date.now() - ts; return age < 86_400_000 ? 2 : age < 7 * 86_400_000 ? 1 : 0; };
const postTs = (p: store.Post) => { const v = (p as { ts: unknown }).ts; return typeof v === 'number' ? v : Date.parse(String(v)) || 0; };

/** Notes by title and body, threads post by post. Only what the caller could read with note_read / thread_read (ACL). */
export function searchDocs(docs: store.Doc[], me: string, m: Matcher): Hit[] {
  const out: Hit[] = [];
  for (const d of docs) {
    if (store.isExpired(d) || !d.acl.includes(me)) continue;
    if (d.kind === 'note') {
      const r = searchText(`${d.title}\n${d.body}`, m);
      if (r) out.push({ kind: 'note', source: `note://${d.id}`, author: `note://${d.id}`, ts: d.created, where: d.title, context: r.context, score: Math.min(r.count, 5) + recency(d.created) + 1 });
    } else {
      for (const p of store.posts(d)) {
        const r = searchText(p.text, m);
        if (r) out.push({ kind: 'thread', source: `thread ${d.id}`, author: p.author, ts: postTs(p), where: d.goal ?? d.title, context: r.context, score: Math.min(r.count, 5) + recency(postTs(p)) });
      }
    }
  }
  return out;
}

/** One transcript (JSONL text) → hits. Raw lines are pre-filtered; only candidates are parsed and checked field by field. */
export function searchJsonl(jsonl: string, agent: string, m: Matcher): Hit[] {
  const out: Hit[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line || !m.any.test(line)) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta) continue;
    const type = o.type;
    if (type !== 'user' && type !== 'assistant' && type !== 'summary') continue;
    const ts = Date.parse(String(o.timestamp ?? '')) || 0;
    const push = (where: string, text: string) => { const r = searchText(text, m); if (!r) return false; out.push({ kind: 'transcript', source: `agent ${agent}`, author: agent, ts, where: o.isSidechain || o.parent_tool_use_id ? `${where} (subagent)` : where, context: r.context, score: Math.min(r.count, 5) + recency(ts) }); return true; };
    if (type === 'summary') { push('summary', String(o.summary ?? '')); continue; }
    const d = describe(o);
    const role = o.message?.role ?? type;
    const said = d.full ?? d.text;
    if (said && push(d.tool ? d.tool : role === 'user' ? 'you' : 'text', said)) continue;
    if (d.thinking && push('thinking', d.thinking)) continue;
    if (d.input && push(`${d.tool ?? 'tool'} input`, JSON.stringify(d.input))) continue;
    if (d.result) push('tool result', d.result);
  }
  return out;
}

/** The newest TAIL_CAP bytes of a transcript, cut at a line boundary. */
export async function searchTranscript(path: string, agent: string, m: Matcher): Promise<{ hits: Hit[]; bytes: number }> {
  const f = Bun.file(path);
  const size = f.size;
  if (!size) return { hits: [], bytes: 0 };
  const start = Math.max(0, size - TAIL_CAP);
  const text = await f.slice(start, size).text();
  const jsonl = start ? text.slice(text.indexOf('\n') + 1) : text;
  return { hits: searchJsonl(jsonl, agent, m), bytes: size - start };
}

/** The transcripts worth reading for a project: every registered agent's session, then recent unclaimed sessions in the project directory. */
export async function projectTranscripts(p: Project, g: Graph): Promise<{ agent: string; path: string; mtime: number }[]> {
  const out = new Map<string, { agent: string; path: string; mtime: number }>();
  for (const it of g.items) {
    if (it.kind !== 'agent' || !it.sessionId) continue;
    let path = join(PROJECTS, await claudeSlug(it.cwd), `${it.sessionId}.jsonl`);
    let st = await stat(path).catch(() => null);
    if (!st) { const s = await sessionById(it.sessionId); if (s) { path = s.path; st = await stat(path).catch(() => null); } }
    if (st) out.set(path, { agent: it.name, path, mtime: st.mtimeMs });
  }
  for (const s of await listSessions(24, p.cwd)) {
    if (out.size >= MAX_TRANSCRIPTS) break;
    if (!out.has(s.path)) out.set(s.path, { agent: `session ${s.id}`, path: s.path, mtime: Number(s.mtime) || 0 });
  }
  return [...out.values()].sort((a, b) => b.mtime - a.mtime).slice(0, MAX_TRANSCRIPTS);
}

export async function searchProject(p: Project, me: string, o: { query: string; scope?: Scope; limit?: number }): Promise<SearchResult> {
  const m = matcher(o.query);
  const scope = o.scope ?? 'all';
  const limit = Math.min(MAX_LIMIT, Math.max(1, o.limit ?? DEFAULT_LIMIT));
  const g = await loadGraph(p.id);
  const agents = g.items.filter((i) => i.kind === 'agent').map((i) => i.name);
  const hits: Hit[] = [];
  if (scope !== 'transcripts') {
    const docs = (await store.list()).filter((d) => {
      if (scope === 'notes' && d.kind !== 'note') return false;
      if (scope === 'threads' && d.kind !== 'thread') return false;
      return d.kind === 'note' ? d.project === p.id || d.acl.some((a) => agents.includes(a)) : d.acl.some((a) => agents.includes(a));
    });
    hits.push(...searchDocs(docs, me, m));
  }
  let scanned = 0, bytes = 0;
  if (scope === 'all' || scope === 'transcripts') {
    for (const tr of await projectTranscripts(p, g)) {
      const r = await searchTranscript(tr.path, tr.agent, m);
      scanned++; bytes += r.bytes; hits.push(...r.hits);
    }
  }
  const counts = { notes: hits.filter((h) => h.kind === 'note').length, threads: hits.filter((h) => h.kind === 'thread').length, transcripts: hits.filter((h) => h.kind === 'transcript').length };
  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
  const per = new Map<string, number>(); const kept: Hit[] = [];
  for (const h of hits) {
    const n = per.get(h.source) ?? 0;
    if (n >= PER_SOURCE) continue;
    per.set(h.source, n + 1); kept.push(h);
    if (kept.length >= limit) break;
  }
  return { hits: kept, counts, scanned, bytes };
}

const mb = (n: number) => `${(n / 1048576).toFixed(n < 1048576 ? 2 : 0)} MB`;
const when = (ts: number) => (ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '?');

/** Text for the agent: a header with what was scanned, then one block per source; what others wrote goes through `wrap` (untrusted). */
export function formatHits(r: SearchResult, me: string, query: string, wrap: (author: string, text: string) => string): string {
  const scanned = `scanned ${r.scanned} transcript${r.scanned === 1 ? '' : 's'} (${mb(r.bytes)}; last ${mb(TAIL_CAP)} of each)`;
  if (!r.hits.length) return `No match for "${query}" · ${scanned}.`;
  const head = `${r.hits.length} matches for "${query}" · notes ${r.counts.notes} · threads ${r.counts.threads} · transcripts ${r.counts.transcripts} · ${scanned}`;
  const groups = new Map<string, Hit[]>();
  for (const h of r.hits) { const g = groups.get(h.source); if (g) g.push(h); else groups.set(h.source, [h]); }
  const blocks: string[] = [];
  for (const [source, hs] of groups) {
    const lines = hs.map((h) => `[${h.author === me ? 'you' : h.author} · ${when(h.ts)} · ${h.where}] ${h.context}`).join('\n');
    blocks.push(`## ${source}\n${hs.every((h) => h.author === me) ? lines : wrap(hs[0]!.author, lines)}`);
  }
  return [head, ...blocks].join('\n\n');
}
