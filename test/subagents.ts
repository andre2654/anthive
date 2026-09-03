/** Subagents on the map: read from the parent's transcript and its subagents/ files, drawn under the parent, state from the files. */
import { mkdtemp, mkdir, writeFile, appendFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const claude = await mkdtemp(join(tmpdir(), 'anthive-claude-'));
process.env.ANTHIVE_CLAUDE_PROJECTS = claude;
const cwd = await mkdtemp(join(tmpdir(), 'anthive-repo-'));
const SID = '11111111-2222-4333-8444-555555555555';
process.env.ANTHIVE_FAKE_PS = `claude -p --input-format stream-json --resume ${SID} --verbose`;   // the session has a live process
const { subagentsOfSession } = await import('../src/core/subagents.ts');
const P = await import('../src/core/project.ts');
const A = await import('../src/core/approvals.ts');
const { summarize } = await import('../src/core/sessions.ts');
const { layoutProject, renderProject } = await import('../src/views/project.ts');
const { Grid } = await import('../src/tui/grid.ts');
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };

// --- a transcript with an old turn and a last turn that fans out three subagents ---
const sid = SID;
const dir = join(claude, '-tmp-repo'); await mkdir(dir, { recursive: true });
const main = join(dir, `${sid}.jsonl`);
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const line = (o: object, minAgo = 1) => JSON.stringify({ uuid: crypto.randomUUID(), parentUuid: null, isSidechain: false, cwd, sessionId: sid, version: '2.1.0', timestamp: at(minAgo), ...o });
const agentCall = (id: string, description: string, bg = false, minAgo = 1) => line({ type: 'assistant', message: { id: `msg-${id}`, role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id, name: 'Agent', input: { description, subagent_type: 'general-purpose', run_in_background: bg, prompt: `Find the ${description} for cattle investment groups.` } }], usage: { input_tokens: 10, output_tokens: 10 } } }, minAgo);
const result = (id: string, extra: object = {}, minAgo = 1) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'report' }] }, ...extra }, minAgo);
await writeFile(main, [
  line({ type: 'user', message: { role: 'user', content: 'old question' } }, 30),
  agentCall('A0', 'Old one', false, 29), result('A0', {}, 28),
  line({ type: 'user', message: { role: 'user', content: 'Deep search: cattle groups' } }, 16),
  line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Continue from where you left off.' } }, 15),
  agentCall('A1', 'CVM rules', false, 15),
  agentCall('A2', 'Tax view', false, 15),
  agentCall('A3', 'Market', true, 1), result('A3', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'x3' } }, 1),   // a recent launch: still "background", not yet silent
  result('A2', {}, 15),
].join('\n') + '\n');
const subDir = join(dir, sid, 'subagents'); await mkdir(subDir, { recursive: true });
await writeFile(join(subDir, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'CVM rules', toolUseId: 'A1', spawnDepth: 1 }));
const sub = join(subDir, 'agent-x1.jsonl');
const subLine = (o: object) => JSON.stringify({ uuid: crypto.randomUUID(), parentUuid: null, isSidechain: true, agentId: 'x1', cwd, sessionId: sid, timestamp: at(0), ...o });
const subCall = (msg: string, name: string, input: object, out: number) => subLine({ type: 'assistant', message: { id: msg, role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: `t-${msg}-${name}`, name, input }], usage: { input_tokens: 5, output_tokens: out } } });
await writeFile(sub, [
  subLine({ type: 'user', message: { role: 'user', content: 'Find the CVM rules for cattle investment groups.' } }),
  subCall('m1', 'WebFetch', { url: 'https://www.gov.br/cvm/x' }, 120),
  subCall('m2', 'Grep', { pattern: 'CVM' }, 80),
  subLine({ type: 'assistant', message: { id: 'm2', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Reading the ruling.' }], usage: { input_tokens: 5, output_tokens: 80 } } }),
].join('\n') + '\n');

const size = (await Bun.file(main).stat()).size;
const subs = await subagentsOfSession(main, size);
const a1 = subs.find((s) => s.id === 'A1')!, a2 = subs.find((s) => s.id === 'A2')!, a3 = subs.find((s) => s.id === 'A3')!;
must('only the last turn counts: three subagents, the old one stays out', subs.length === 3 && !subs.some((s) => s.name === 'Old one') && !!a1 && !!a2 && !!a3);
must('a running one has its transcript, its last words, tokens counted once per message', !a1.done && !!a1.path?.endsWith('agent-x1.jsonl') && a1.now === 'Reading the ruling.' && a1.tokens === 200 && a1.tools === 2 && a1.ageMs < 60_000);
must('a finished one is done, without a transcript of its own yet', a2.done && !a2.error && a2.path === null && a2.ageMs === Infinity);
must('a background launch is never done: it is only flagged', a3.bg && !a3.done);
must('the brief is kept', a1.prompt.startsWith('Find the CVM rules'));
await appendFile(sub, subCall('m3', 'WebSearch', { query: 'CVM 88' }, 50) + '\n');
const a1b = (await subagentsOfSession(main, size)).find((s) => s.id === 'A1')!;
must('growth is read incrementally, with short tool names', a1b.tokens === 250 && a1b.tools === 3 && a1b.now === 'search CVM 88');

// --- the state of the parent: a tool in flight is running, not an approval ---
const old = new Date(Date.now() - 15 * 60_000);
await utimes(main, old, old);
const stale = await summarize(main);
must('an Agent call without result for 15 min is stuck on its own', stale?.state === 'stuck' && stale.pendingTool === 'Agent');
await utimes(main, new Date(), new Date());
const fresh = await summarize(main);
must('the same call, recent, is running (not "approval")', fresh?.state === 'running' && fresh.pendingTool === 'Agent');
await utimes(main, old, old);

// --- on the map ---
const p = await P.createProject('hive', cwd);
const g = await P.loadGraph(p.id);
g.items.push({ kind: 'agent', id: 'ag1', name: 'maestro', cwd, sessionId: sid, worktree: null, created: Date.now() });
await P.saveGraph(p.id, g);
const v = await P.view(p);
const agent = v.nodes.find((n): n is import('../src/core/project.ts').AgentNode => n.kind === 'agent' && n.name === 'maestro')!;
const subNodes = v.nodes.filter((n) => n.kind === 'sub');
must('the map has the subagents of the last turn, hanging from their agent', !!agent && subNodes.length === 3 && v.edges.filter((e) => e.kind === 'sub' && e.from === agent.id).length === 3);
must('a parent whose subagents are alive is running, even with an old transcript', agent.session?.state === 'running' && agent.session.lastText.includes('CVM rules'));
const L = layoutProject(v, 130);
const ab = L.boxes.find((b) => b.id === agent.id)!, sb = L.boxes.filter((b) => b.node.kind === 'sub');
must('subagent boxes sit right under the parent, indented and narrower', sb.length === 3 && sb[0]!.rect.x === ab.rect.x + 3 && sb[0]!.rect.y === ab.rect.y + ab.rect.h && sb[1]!.rect.y === sb[0]!.rect.y + 3 && sb[0]!.rect.w === ab.rect.w - 3);
const grid = new Grid(130, 32);
renderProject(grid, v, 'sub-A1', 0, '', { panel: true });
const s = grid.toString();
must('drawn with name, stem and states', s.includes('⤷ CVM rules') && s.includes('├─') && s.includes('╰─') && s.includes('○ done') && s.includes('◆ background') && s.includes('search CVM 88'));
must('the parent shows the tool in flight, dim, and the header counts them', s.includes('▸ Agent CVM rules') && s.includes('3 subagents'));
must('the panel describes the selected subagent and its brief', s.includes('subagent ─') && s.includes('brief') && s.includes('Find the CVM rules') && s.includes('general-purpose'));
must('no line overflows the grid', s.split('\n').every((l) => [...l].length === 130));

// --- a subagent whose file stopped growing is silent, not running ---
await utimes(sub, old, old);
const v3 = await P.view(p);
const quiet = v3.nodes.find((n) => n.kind === 'sub' && n.id === 'sub-A1');
const g3 = new Grid(130, 32); renderProject(g3, v3, null, 0, '', {});
must('ten minutes without a line: silent, drawn as stuck', quiet?.kind === 'sub' && quiet.sub.silent && g3.toString().includes('✕ silent for 15m'));
await utimes(sub, new Date(), new Date());

// --- in the agent's chat: the subagents are a panel section and they carry the "now" line ---
const { subsLine } = await import('../src/views/agent.ts');
must('the now line names them and shows the longest silence', subsLine([
  { name: 'CVM', state: 'running', tokens: 20000, quietMs: 300_000, now: 'Write report' },
  { name: 'Tax', state: 'running', tokens: 18000, quietMs: 30_000, now: 'search x' },
  { name: 'Market', state: 'done', tokens: 6000, quietMs: 0, now: '' },
]).includes('2 subagents') === true);
must('with none alive the now line stays out of the way', subsLine([{ name: 'CVM', state: 'done', tokens: 1, quietMs: 0, now: '' }]) === '');

// --- no process behind the session: its subagents are orphans, right away ---
process.env.ANTHIVE_FAKE_PS = 'claude --resume 99999999-9999-4999-8999-999999999999';
const vGone = await P.view(p);
const orphan = vGone.nodes.find((n) => n.kind === 'sub' && n.id === 'sub-A1');
const agentGone = vGone.nodes.find((n) => n.kind === 'agent' && n.name === 'maestro');
const gGone = new Grid(130, 32); renderProject(gGone, vGone, null, 0, '', {});
must('with no process holding the session the subagent is an orphan, not running', orphan?.kind === 'sub' && orphan.sub.orphan && gGone.toString().includes('✕ orphan'));
must('and its agent stops counting as running', agentGone?.kind === 'agent' && agentGone.session?.state === 'stuck');
await utimes(main, new Date(), new Date());
const vFresh = await P.view(p);
const agentFresh = vFresh.nodes.find((n) => n.kind === 'agent' && n.name === 'maestro');
must('even with a transcript written seconds ago: no process, no work', agentFresh?.kind === 'agent' && agentFresh.session?.state === 'stuck');
await utimes(main, old, old);
process.env.ANTHIVE_FAKE_PS = `claude -p --resume ${SID}`;
const vBack = await P.view(p);
must('with the process back it is running again', vBack.nodes.some((n) => n.kind === 'sub' && n.id === 'sub-A1' && !n.sub.orphan));

// --- watching a subagent must not touch the chat that is running it ---
const { App } = await import('../src/app.ts');
const { Screen } = await import('../src/tui/screen.ts');
class F extends Screen { constructor() { super({ mouse: true }); this.W = 130; this.H = 30; } override measure() {} override enter() {} override restore() {} override write() {} override onKey() {} }
const app = new App(new F());
app.project = p; app.pv = await P.view(p); app.view = 'project';
let stops = 0;
app.chat = { sessionId: sid, busy: true, model: 'claude-x', effort: 'high', permissionMode: '', deep: true, thinking: 0, summary: '', cost: 0, proc: {}, stop: () => { stops++; } } as any;
app.sel = 'sub-A1';
await app.openSel();
const viewNow = (): string => app.view;
must('opening a subagent watches it without killing the chat that runs it', stops === 0 && !!app.chat && viewNow() === 'agent' && !!app.agent?.name.includes('CVM rules'));
const before = app.evs.length;
(app as any).onChat({ kind: 'ev', ev: { uuid: 'x', parent: null, sidechain: false, type: 'assistant', ts: 0, role: 'assistant', text: 'from the parent' } });
must('the parent chat writes into its own transcript, not the one being watched', app.evs.length === before);
app.render();
const w = app.grid.toString();
must('the view says it is read-only and offers no input', w.includes('watching') && !w.includes('write to') && !w.includes('D deep'));
(app as any).startChat();
must('starting a chat on a subagent is refused', stops === 0 && app.status.includes('watch only'));
app.sel = 'sub-A1'; (app as any).removeSel();
must('a subagent cannot be removed from the map', app.modal === null && app.status.includes('ends by itself'));
app.sel = agent.id; await app.openSel();
app.showPanel = true; app.render();
const chat = app.grid.toString();
must('the agent chat gives the subagents their own panel section', chat.includes('subagents (3)') && chat.includes('CVM rules') && chat.includes('search CVM 88') && chat.includes('background'));
const quietAt = new Date(Date.now() - 3 * 60_000);
await utimes(sub, quietAt, quietAt);
app.pv = await P.view(p); app.render();
const quietChat = app.grid.toString();
must('a running subagent that went quiet says so, without calling it dead', quietChat.includes('quiet for 3m') && !quietChat.includes('orphan'));
await utimes(sub, new Date(), new Date());
must('and the live row says how many are working instead of just thinking', chat.includes('2 subagents') || chat.includes('1 subagent'));

// --- a pending permission request is the only "approval" ---
void A.ask({ agent: 'maestro', project: p.id, cwd, tool: 'Bash', input: { command: 'rm -rf build' } }, { timeoutMs: 5000, pollMs: 50 });
await new Promise((r) => setTimeout(r, 120));
const v2 = await P.view(p);
const agent2 = v2.nodes.find((n) => n.kind === 'agent' && n.name === 'maestro');
must('with a request on disk the agent waits for approval', agent2?.kind === 'agent' && agent2.session?.state === 'waiting');
for (const r of await A.pending(p.id)) await A.decide(r.id, 'deny', 'test');

console.log(fails ? `\n${fails} failure(s)` : '\nall green');
process.exit(fails ? 1 : 0);
