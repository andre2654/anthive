/**
 * The subagents an agent runs with the Agent tool, rebuilt from its transcript
 * and from what Claude Code writes for each one next to it:
 * <slug>/<session>/subagents/agent-<id>.jsonl and agent-<id>.meta.json
 * (the meta carries the tool_use id, so a subagent is found before it answers).
 * Everything is cached by file size and read incrementally: the map reloads every 2 s.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe } from './sessions.ts';

export interface Subagent {
  id: string;           // the Agent tool_use id
  name: string;         // its description
  type: string;         // subagent_type
  bg: boolean;          // launched in the background: it dies with the parent process
  prompt: string;
  started: number;      // ms
  done: boolean;        // the parent got its result (a background launch is never done here)
  error: boolean;       // the result was an error
  path: string | null;  // its own transcript, once Claude Code created it
  now: string;          // what it is doing: last tool and argument, or its last words
  tokens: number;       // output tokens so far
  tools: number;        // tool calls so far
  ageMs: number;        // since its transcript last grew (Infinity without one)
  silent: boolean;      // not done and nothing written for ten minutes: whatever ran it is gone
}
export type SubagentHead = Omit<Subagent, 'path' | 'now' | 'tokens' | 'tools' | 'ageMs' | 'silent'>;

const HARNESS = /^\s*<(task-notification|system-reminder|local-command-)/;
const TAIL = 4 * 1024 * 1024;   // a turn lives at the end of the transcript
const SHORT: Record<string, string> = { WebSearch: 'search', WebFetch: 'fetch', mcp__anthive__project_search: 'hive' };

const safeJSON = (l: string): any | null => { try { return JSON.parse(l); } catch { return null; } };
const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n') : '';
/** Something you said: not a tool result, not a subagent line, not the harness talking. */
const isTurn = (o: any): boolean => {
  if (o?.type !== 'user' || o.isSidechain || o.isMeta) return false;
  const c = o.message?.content;
  if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')) return false;
  const text = textOf(c);
  return !!text.trim() && !HARNESS.test(text);
};
const shortTool = (text: string) => text.replace(/^(\S+)/, (m) => SHORT[m] ?? m.replace(/^mcp__anthive__/, '').replace(/^mcp__playwright__browser_/, ''));

/** The Agent calls of the last turn (since the last thing you said), from the raw lines of a transcript. */
export function subagentsFromLines(lines: string[]): SubagentHead[] {
  const objs = lines.map(safeJSON).filter(Boolean);
  let start = 0;
  for (let i = objs.length - 1; i >= 0; i--) if (isTurn(objs[i])) { start = i; break; }
  const out: SubagentHead[] = [];
  const byId = new Map<string, SubagentHead>();
  for (const o of objs.slice(start)) {
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && b.id) {
        const inp = b.input ?? {};
        const s: SubagentHead = { id: String(b.id), name: String(inp.description ?? '').replace(/\s+/g, ' ').trim() || String(inp.subagent_type ?? 'subagent'), type: String(inp.subagent_type ?? ''), bg: inp.run_in_background === true, prompt: String(inp.prompt ?? ''), started: Date.parse(o.timestamp ?? '') || 0, done: false, error: false };
        byId.set(s.id, s); out.push(s);
      }
      if (b?.type === 'tool_result' && byId.has(String(b.tool_use_id))) {
        const s = byId.get(String(b.tool_use_id))!;
        if (!s.bg) { s.done = true; s.error = !!b.is_error; }   // a background launch only acknowledges the launch
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the files of each subagent
interface Tail { size: number; off: number; tokens: number; tools: number; now: string; mtime: number; msg: string; msgTok: number }
const SILENT_MS = 600_000;   // no growth for this long: whatever ran it is gone (or lost in thought)
const tails = new Map<string, Tail>();

/** Activity of a subagent transcript, reading only what grew since the last look. */
export async function tailOf(path: string): Promise<Tail | null> {
  let st; try { st = await stat(path); } catch { return null; }
  const cur = tails.get(path) ?? { size: 0, off: 0, tokens: 0, tools: 0, now: '', mtime: 0, msg: '', msgTok: 0 };
  cur.mtime = st.mtimeMs;
  if (cur.size === st.size) return { ...cur, tokens: cur.tokens + cur.msgTok };
  const chunk = await Bun.file(path).slice(cur.off, st.size).text();
  const end = chunk.lastIndexOf('\n');
  cur.size = st.size;
  if (end >= 0) {
    for (const line of chunk.slice(0, end).split('\n')) {
      const o = safeJSON(line);
      if (!o || o.type !== 'assistant') continue;
      // one message, several lines (thinking, text, tool_use) with a growing usage: the largest is the total
      const id = String(o.message?.id ?? ''), out = Number(o.message?.usage?.output_tokens) || 0;
      if (id !== cur.msg) { cur.tokens += cur.msgTok; cur.msg = id; cur.msgTok = out; } else cur.msgTok = Math.max(cur.msgTok, out);
      const d = describe(o);
      if (d.tool) { cur.tools++; cur.now = shortTool(d.text); } else if (d.text) cur.now = d.text;
    }
    cur.off += end + 1;
  }
  tails.set(path, cur);
  return { ...cur, tokens: cur.tokens + cur.msgTok };
}

const metas = new Map<string, Map<string, string>>();   // subagents dir → tool_use id → transcript
async function fileFor(dir: string, toolUseId: string): Promise<string | null> {
  let m = metas.get(dir);
  if (!m?.has(toolUseId)) {
    m = m ?? new Map();
    const known = new Set(m.values());
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith('.meta.json')) continue;
      const transcript = join(dir, f.replace(/\.meta\.json$/, '.jsonl'));
      if (known.has(transcript)) continue;
      const j = safeJSON(await readFile(join(dir, f), 'utf8').catch(() => ''));
      if (j?.toolUseId) m.set(String(j.toolUseId), transcript);
    }
    metas.set(dir, m);
  }
  return m.get(toolUseId) ?? null;
}

const heads = new Map<string, { size: number; subs: SubagentHead[] }>();

/** The subagents of the last turn of a session, with what each one is doing right now. */
export async function subagentsOfSession(path: string, size: number): Promise<Subagent[]> {
  let hit = heads.get(path);
  if (!hit || hit.size !== size) {
    const from = Math.max(0, size - TAIL);
    const lines = (await Bun.file(path).slice(from, size).text()).split('\n');
    if (from > 0) lines.shift();   // the first line is cut in the middle
    hit = { size, subs: subagentsFromLines(lines) };
    heads.set(path, hit);
  }
  if (!hit.subs.length) return [];
  const dir = join(path.replace(/\.jsonl$/, ''), 'subagents');
  const out: Subagent[] = [];
  for (const s of hit.subs) {
    const p = await fileFor(dir, s.id);
    const tl = p ? await tailOf(p) : null;
    const ageMs = tl ? Math.max(0, Date.now() - tl.mtime) : Infinity;
    const silent = !s.done && (tl ? ageMs > SILENT_MS : Date.now() - s.started > SILENT_MS);
    out.push({ ...s, path: p, now: tl?.now ?? '', tokens: tl?.tokens ?? 0, tools: tl?.tools ?? 0, ageMs, silent });
  }
  return out;
}
