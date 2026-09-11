/** `anthive status`: one snapshot of every project with agents — states, what needs you, limits — and `decide` answering a request from outside the TUI. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const claude = await mkdtemp(join(tmpdir(), 'anthive-claude-'));
process.env.ANTHIVE_CLAUDE_PROJECTS = claude;
const cwd = await mkdtemp(join(tmpdir(), 'anthive-repo-'));
const SID = '44444444-4444-4444-8444-444444444444';
process.env.ANTHIVE_FAKE_PS = `claude -p --resume ${SID}`;
const P = await import('../src/core/project.ts');
const A = await import('../src/core/approvals.ts');
const { statusSnapshot, statusText } = await import('../src/core/status.ts');
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };

const p = await P.createProject('hive', cwd);
const g = await P.loadGraph(p.id);
g.items.push({ kind: 'agent', id: 'ag1', name: 'maestro', cwd, sessionId: SID, worktree: null, created: Date.now() });
g.items.push({ kind: 'agent', id: 'ag2', name: 'worker', cwd, sessionId: null, worktree: 'feat/x', created: Date.now() });
await P.saveGraph(p.id, g);
await P.createProject('empty', await mkdtemp(join(tmpdir(), 'anthive-empty-')));   // no agents: stays out of the report
const dir = join(claude, '-tmp-repo'); await mkdir(dir, { recursive: true });
const line = (o: object) => JSON.stringify({ uuid: crypto.randomUUID(), parentUuid: null, isSidechain: false, cwd, sessionId: SID, timestamp: new Date().toISOString(), ...o });
await writeFile(join(dir, `${SID}.jsonl`), [
  line({ type: 'user', message: { role: 'user', content: 'go' } }),
  line({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: '**Checking** the `retry` path' }], usage: { input_tokens: 1000, output_tokens: 10 } } }),
].join('\n') + '\n');
await mkdir(A.DIR(), { recursive: true });
await writeFile(join(A.DIR(), 'req-1.json'), JSON.stringify({ id: 'req-1', agent: 'worker', project: p.id, cwd, tool: 'Bash', input: { command: 'rm -rf build' }, ts: Date.now(), state: 'pending' }));

const s = await statusSnapshot();
must('only projects with agents are reported', s.projects.length === 1 && s.projects[0]!.name === 'hive');
const hive = s.projects[0]!;
must('a fresh transcript with a live process is running, with markdown stripped from what it does', hive.agents.some((a) => a.name === 'maestro' && a.state === 'running' && a.doing === 'Checking the retry path') && s.running === 1);
must('an agent without a session is new, and keeps its worktree as branch', hive.agents.some((a) => a.name === 'worker' && a.state === 'new' && a.branch === 'feat/x'));
must('the pending request is what needs you', s.needs === 1 && hive.needs[0]!.kind === 'approval' && hive.needs[0]!.id === 'req-1' && hive.needs[0]!.text.includes('worker asks to run Bash: rm -rf build'));
must('agents that need an eye come first', hive.agents[0]!.state === 'waiting' || hive.agents[0]!.state === 'running');
const text = statusText(s);
must('the text form has the totals and the request', text.startsWith('● 1 running · ◆ 1 need you') && text.includes('◆ worker asks to run Bash'));
must('limits are unknown until a chat has run', s.limits === null && text.includes('limits unknown'));

await A.decide('req-1', 'deny', 'denied from the menu bar');
const s2 = await statusSnapshot();
must('a decision from outside the TUI clears the request', s2.needs === 0 && (await A.pending(p.id)).length === 0);

console.log(fails ? `\n${fails} failure(s)` : '\nall green');
process.exit(fails ? 1 : 0);
