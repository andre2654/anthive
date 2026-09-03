/** Deep search: the process flags, the prompt wrapper, the rows, the input box, and the search module — all offline. */
import { ChatSession, DEEP_TOOLS, DEEP_PREAMBLE, DEEP_TRIGGER, deepPrompt, SYSTEM_PREAMBLE } from '../src/core/chat.ts';
import { describe } from '../src/core/sessions.ts';
import { rows, renderAgent, inputLayout, DEEP_CHIP } from '../src/views/agent.ts';
import { Grid } from '../src/tui/grid.ts';
import { matcher, searchText, searchJsonl, searchDocs, formatHits } from '../src/core/search.ts';
import type { Doc } from '../src/core/store.ts';
import { Ev } from '../src/core/sessions.ts';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };

// --- process flags
const plain = new ChatSession({ cwd: '/tmp', resume: 'abc' }, () => {}).argv();
const deep = new ChatSession({ cwd: '/tmp', resume: 'abc', deep: true }, () => {}).argv();
const allow = (a: string[]) => { const i = a.indexOf('--allowedTools'); const out: string[] = []; for (let j = i + 1; j < a.length && !a[j]!.startsWith('--'); j++) out.push(a[j]!); return out; };
must('plain chat: only the bus, no web, no subagent forwarding', allow(plain).join() === 'mcp__anthive' && !plain.includes('--forward-subagent-text') && !plain[plain.indexOf('--append-system-prompt') + 1]!.includes(DEEP_TRIGGER));
must('deep chat: bus first, then the web and read-only git', allow(deep).join() === ['mcp__anthive', ...DEEP_TOOLS].join());
must('deep chat forwards subagent text and carries the protocol', deep.includes('--forward-subagent-text') && deep[deep.indexOf('--append-system-prompt') + 1]!.includes(DEEP_PREAMBLE));
must('no budget flag unless asked', !deep.includes('--max-budget-usd'));
process.env.ANTHIVE_DEEP_BUDGET_USD = '3';
const budgeted = new ChatSession({ cwd: '/tmp', resume: 'abc', deep: true }, () => {}).argv();
must('ANTHIVE_DEEP_BUDGET_USD caps the process', budgeted[budgeted.indexOf('--max-budget-usd') + 1] === '3');
delete process.env.ANTHIVE_DEEP_BUDGET_USD;
must('the wrapper and the protocol share the trigger', deepPrompt('  x ') === `${DEEP_TRIGGER} x` && DEEP_PREAMBLE.includes(DEEP_TRIGGER));
must('the protocol names the tools it needs', ['project_search', 'note_write', 'WebSearch', 'WebFetch', 'Explore', 'TaskCreate'].every((w) => DEEP_PREAMBLE.includes(w)));
must('the bus preamble lists project_search', SYSTEM_PREAMBLE.includes('project_search'));

// --- describe() hints for the research tools
const tu = (name: string, input: object) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }] } });
must('WebSearch shows its query', describe(tu('WebSearch', { query: 'bun ffi' })).text === 'WebSearch bun ffi');
must('WebFetch shows its url', describe(tu('WebFetch', { url: 'https://bun.sh/docs', prompt: 'read' })).text === 'WebFetch https://bun.sh/docs');
must('project_search shows its query', describe(tu('mcp__anthive__project_search', { query: 'idem' })).text === 'mcp__anthive__project_search idem');

// --- rows: short names, indentation, forwarded subagent briefs
const ev = (o: Partial<Ev>): Ev => ({ uuid: crypto.randomUUID(), parent: null, sidechain: false, type: 'assistant', ts: 0, role: 'assistant', text: '', ...o });
const evs = [
  ev({ type: 'user', role: 'user', text: 'Deep search: why retries duplicate', full: 'Deep search: why retries duplicate' }),
  ev({ text: 'Agent find the retry path', tool: 'Agent', input: { description: 'find the retry path' } }),
  ev({ type: 'user', role: 'user', sidechain: true, text: 'You are an explorer. Find the retry path.', full: 'You are an explorer. Find the retry path.' }),
  ev({ sidechain: true, text: 'Grep retry', tool: 'Grep', input: { pattern: 'retry' } }),
  ev({ text: 'WebSearch idempotent retry', tool: 'WebSearch', input: { query: 'idempotent retry' } }),
  ev({ text: 'WebFetch https://x.dev/idem', tool: 'WebFetch', input: { url: 'https://x.dev/idem' } }),
  ev({ text: 'mcp__anthive__project_search idem', tool: 'mcp__anthive__project_search', input: { query: 'idem' } }),
  ev({ text: 'Read a.ts', tool: 'Read', input: { file_path: 'a.ts' } }),
  ev({ text: 'Read b.ts', tool: 'Read', input: { file_path: 'b.ts' } }),
  ev({ text: 'done', full: 'done' }),
];
const rs = rows(evs, '', new Set(), 80);
must('search/fetch/hive get short names with the query or url', rs.some((r) => r.name === 'search' && r.detail === 'idempotent retry') && rs.some((r) => r.name === 'fetch' && r.detail.includes('x.dev')) && rs.some((r) => r.name === 'hive' && r.detail === 'idem'));
must('a subagent brief is an indented child, not a turn', rs.filter((r) => r.kind === 'turn').length === 1 && rs.some((r) => r.name === 'brief' && r.connector.includes('│')));
must('the live turn stays open with 8 children (no summary)', !rs.some((r) => r.kind === 'summary') && rs.filter((r) => r.kind === 'child').length >= 8);

// --- the input box
must('the text starts after the chip when deep', inputLayout(100, true).x === 5 + DEEP_CHIP.length + 1 && inputLayout(100, false).x === 5);
const agent = { kind: 'agent' as const, id: 'a1', name: 'api', item: null, session: null, cwd: '/tmp' };
const g = new Grid(100, 26);
renderAgent(g, agent, null, [], [], 0, -1, '', { text: '', cursor: 0, deep: true }, null, []);
const t = g.toString();
must('deep box: chip, title, hint, placeholder, cursor after the chip', t.includes(DEEP_CHIP) && t.includes('deep search with api') && t.includes('tab plain') && t.includes('the hive and the web') && g.cursor?.x === inputLayout(100, true).x);
const g2 = new Grid(100, 26);
renderAgent(g2, agent, null, [], [], 0, -1, '', { text: '', cursor: 0, deep: false }, null, []);
must('plain box: no chip, tab offers deep', !g2.toString().includes(DEEP_CHIP) && g2.toString().includes('tab deep'));

// --- search module
const m = matcher('Idem key');
must('words match all, case-insensitive', !!searchText('the IDEM_KEY is the customer key', m) && !searchText('only idem here', m));
const re = matcher('/idem_\\w+/');
must('/regex/ is a regex', !!searchText('idem_key', re) && !searchText('idem key', re));
let threw = false; try { matcher('/[/'); } catch { threw = true; }
must('an invalid regex throws (the tool reports it)', threw);
const ctx = searchText('a\nthe idem key line\nb', m);
must('context is the matching line with its neighbours', !!ctx && ctx.context.includes('idem key') && ctx.context.includes('a') && ctx.context.includes('b'));
const jsonl = [
  { type: 'user', timestamp: '2026-09-02T10:00:00Z', message: { role: 'user', content: 'fix the duplicate checkout' } },
  { type: 'assistant', timestamp: '2026-09-02T10:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'order.ts' } }] } },
  { type: 'user', timestamp: '2026-09-02T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'const retry = sameSecond(idem_key)' }] } },
  { type: 'assistant', timestamp: '2026-09-02T10:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The retry reuses the idempotency key within the same second.' }] } },
].map((o) => JSON.stringify(o)).join('\n');
const hs = searchJsonl(jsonl, 'api', matcher('idem'));
must('transcript search finds the tool result and the answer, with where', hs.length === 2 && hs.some((h) => h.where === 'tool result') && hs.some((h) => h.where === 'text' && h.context.includes('idempotency')));
const note: Doc = { id: 'n1', kind: 'note', title: 'schema', acl: ['api'], ttl: null, created: Date.now(), project: 'p', body: 'idem key is the customer key', path: '' } as Doc;
const secret: Doc = { ...note, id: 'n2', acl: ['db'] } as Doc;
const thread: Doc = { id: 'dm-api-db', kind: 'thread', title: 'api ⇄ db', acl: ['api', 'db'], ttl: null, created: Date.now(), goal: 'close it', budget: 6, project: 'p', path: '', body: '## api · 2026-09-02T10:00:00.000Z\n\nuse idem_key as unique\n\n## db · 2026-09-02T10:01:00.000Z\n\nagreed on idem_key\n' } as Doc;
const dh = searchDocs([note, secret, thread], 'api', matcher('idem'));
must('notes and posts are found, ACL respected', dh.some((h) => h.kind === 'note' && h.source === 'note://n1') && !dh.some((h) => h.source === 'note://n2') && dh.filter((h) => h.kind === 'thread').length === 2);
const txt = formatHits({ hits: dh, counts: { notes: 1, threads: 2, transcripts: 0 }, scanned: 0, bytes: 0 }, 'api', 'idem', (a, t) => `<wrapped ${a}>${t}</wrapped>`);
must('others are wrapped, own posts are [you]', txt.includes('<wrapped') && txt.includes('[you') && txt.startsWith('3 matches for "idem"'));
must('no match says so without an error', formatHits({ hits: [], counts: { notes: 0, threads: 0, transcripts: 0 }, scanned: 2, bytes: 0 }, 'api', 'zzz', (a, t) => t).startsWith('No match for "zzz"'));
// --- the three voices on screen
const vevs = [ev({ type: 'user', role: 'user', text: 'oi', full: 'oi', ts: 1 }), ev({ text: 'resposta', full: 'resposta' })];
const vrows = rows(vevs, '', new Set(), 60, false, 'api');
const g3 = new Grid(100, 20);
renderAgent(g3, agent, null, vevs, vrows, 0, -1, '', null, null, []);
const yRow = vrows.findIndex((r) => r.voice === 'you'), aRow = vrows.findIndex((r) => r.voice === 'agent');
must('your line sits on a band', !!g3.cell(20, 3 + yRow).bg);
must('the agent line has the bar and the name', g3.toString().split('\n')[3 + aRow]!.includes('▎resposta') && g3.toString().split('\n')[3 + aRow]!.includes('api'));

// --- harness notifications are not your words; background subagents are flagged
const nevs = [ev({ type: 'user', role: 'user', text: 'go', full: 'go' }), ev({ text: 'Agent research', tool: 'Agent', input: { description: 'research', run_in_background: true } }), ev({ type: 'user', role: 'user', text: '<task-notification> <task-id>x</task-id> <summary>No completion record was found for 4 background agents.</summary> </task-notification>', full: '<task-notification>\n<task-id>x</task-id>\n<summary>No completion record was found for 4 background agents.</summary>\n</task-notification>' }), ev({ type: 'user', role: 'user', text: 'continue', full: 'continue' }), ev({ text: 'ok', full: 'ok' })];
const nrows = rows(nevs, '', new Set(), 80, false, 'api');
must('a task notification renders as injected, with its summary, not as a turn', nrows.filter((r) => r.kind === 'turn').length === 2 && nrows.some((r) => r.name === 'notification' && r.detail.includes('No completion record')));
must('a background subagent is flagged', nrows.some((r) => r.name === 'Agent' && r.detail.startsWith('background')));
must('the bus preamble forbids background subagents', /run_in_background: false/.test(SYSTEM_PREAMBLE) && /SendMessage/.test(SYSTEM_PREAMBLE));

console.log(fails ? `\n${fails} failure(s)` : '\nall green');
process.exit(fails ? 1 : 0);
