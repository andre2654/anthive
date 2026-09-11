/**
 * One snapshot of the whole hive for whatever lives outside the TUI: the menu
 * bar app, a tmux status line, a script. It reads exactly what the map reads
 * and never writes. `anthive status` prints it as text, `--json` as data.
 */
import * as P from './project.ts';
import { pending, summary } from './approvals.ts';
import { threadState } from './store.ts';
import { loadRate, type RateWindow } from './chat.ts';
import { windowOf, type Session } from './sessions.ts';
import { ago } from '../tui/theme.ts';

export interface StatusAgent { id: string; name: string; state: string; ageMs: number; doing: string; context: number; branch: string; model: string }
export interface StatusNeed { kind: 'approval' | 'stuck' | 'exhausted'; id: string; agent: string; agentId: string; text: string; tool?: string }
export interface StatusProject { id: string; name: string; cwd: string; running: number; agents: StatusAgent[]; needs: StatusNeed[] }
export interface Status { at: number; running: number; needs: number; limits: RateWindow | null; projects: StatusProject[] }

const ORDER: Record<string, number> = { waiting: 0, stuck: 0, running: 1, idle: 2, new: 3, sleeping: 4 };
const doingOf = (s: Session) => (s.pendingTool && s.state !== 'idle' && s.state !== 'sleeping' ? `${s.pendingTool} ${s.pendingInput}` : s.lastText)
  .replace(/^(\w+ )?cd \S+\s*(&&\s*)?/, '$1').replace(/[*`#_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);

export async function statusSnapshot(): Promise<Status> {
  const projects: StatusProject[] = [];
  for (const p of await P.listProjects()) {
    const g = await P.loadGraph(p.id);
    if (!g.items.some((i) => i.kind === 'agent')) continue;   // nothing registered: nothing to report
    const v = await P.view(p);
    const agents = v.nodes.filter((n): n is P.AgentNode => n.kind === 'agent');
    const list: StatusAgent[] = agents.map((a) => ({
      id: a.id, name: a.name, state: a.session?.state ?? 'new', ageMs: a.session?.ageMs ?? -1,
      doing: a.session ? doingOf(a.session) : '', context: a.session ? a.session.context / windowOf(a.session.model, a.session.context) : 0,
      branch: a.item?.worktree ?? (a.session?.branch && a.session.branch !== '—' ? a.session.branch : ''), model: a.session?.model ?? '',
    })).sort((x, y) => (ORDER[x.state] ?? 9) - (ORDER[y.state] ?? 9) || x.ageMs - y.ageMs);
    const needs: StatusNeed[] = [];
    for (const r of await pending(p.id)) { const a = agents.find((x) => x.name === r.agent); needs.push({ kind: 'approval', id: r.id, agent: r.agent, agentId: a?.id ?? '', tool: r.tool, text: `${r.agent} asks to run ${r.tool}: ${summary(r.tool, r.input)}` }); }
    for (const a of agents) if (a.session?.state === 'stuck') needs.push({ kind: 'stuck', id: `stuck-${a.id}`, agent: a.name, agentId: a.id, tool: a.session.pendingTool ?? undefined, text: `${a.name} stuck for ${ago(a.session.ageMs)} on ${a.session.pendingTool ?? '?'}` });
    for (const e of v.edges) {
      if (e.kind !== 'talk' || !e.thread) continue;
      const st = threadState(e.thread); if (st.state !== 'exhausted') continue;
      const a = agents.find((x) => x.id === e.from), b = agents.find((x) => x.id === e.to); if (!a || !b) continue;
      needs.push({ kind: 'exhausted', id: `thread-${e.thread.id}`, agent: a.name, agentId: a.id, text: `${a.name} ⇄ ${b.name} out of turns ${st.turn}/${st.budget}` });
    }
    projects.push({ id: p.id, name: p.name, cwd: p.cwd, running: list.filter((a) => a.state === 'running' || a.state === 'waiting').length, agents: list, needs });
  }
  // the busiest project first, then the one touched most recently
  const freshest = (p: StatusProject) => Math.min(...p.agents.map((a) => (a.ageMs < 0 ? Infinity : a.ageMs)));
  projects.sort((a, b) => (b.needs.length + b.running) - (a.needs.length + a.running) || freshest(a) - freshest(b));
  return { at: Date.now(), running: projects.reduce((n, p) => n + p.running, 0), needs: projects.reduce((n, p) => n + p.needs.length, 0), limits: await loadRate(), projects };
}

const GLYPH: Record<string, string> = { running: '●', waiting: '◆', stuck: '✕', idle: '○', sleeping: '○', new: '·' };
const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5);

/** The same snapshot for a person: one line of totals, then each project with what needs you and who is doing what. */
export function statusText(s: Status): string {
  const out: string[] = [];
  const lim = s.limits ? `5h window ${Math.round(s.limits.fiveHour * 100)}% (resets ${hhmm(s.limits.resetsAt)}) · 7d ${Math.round(s.limits.sevenDay * 100)}%` : 'limits unknown until a chat runs';
  out.push(`● ${s.running} running · ◆ ${s.needs} need you · ${lim}`);
  for (const p of s.projects) {
    out.push('', `${p.name}  ${p.cwd}`);
    for (const n of p.needs) out.push(`  ${n.kind === 'stuck' ? '✕' : n.kind === 'exhausted' ? '‖' : '◆'} ${n.text}`);
    for (const a of p.agents) out.push(`  ${GLYPH[a.state] ?? '·'} ${a.name.padEnd(12)} ${a.state.padEnd(8)} ${(a.ageMs >= 0 ? ago(a.ageMs) : '').padEnd(7)} ${a.doing}`);
  }
  if (!s.projects.length) out.push('', 'no project with agents yet — `anthive` opens the projects screen');
  return out.join('\n');
}
