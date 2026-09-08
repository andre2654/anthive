/** Fala JSON-RPC de verdade com o servidor MCP, como um agente faria. */
import { mkdtempSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'tai-mcp-'));
const CP = mkdtempSync(join(tmpdir(), 'tai-mcp-claude-'));   // where "Claude Code" keeps transcripts, for project_search
const self = join(import.meta.dir, '..', 'src', 'index.ts');
process.env.ANTHIVE_HOME = HOME; process.env.ANTHIVE_CLAUDE_PROJECTS = CP;
const P = await import('../src/core/project.ts');
const { mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'tai-mcp-repo-')));
// a fake claude for the first turn agent_create fires: it logs its argv and exits
const fakeBin = await mkdtemp(join(tmpdir(), 'anthive-fake-claude-'));
const fakeLog = join(fakeBin, 'argv.log');
await writeFile(join(fakeBin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${fakeLog}"\n`, { mode: 0o755 });
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.ANTHIVE_NO_CHROME = '1';
process.env.ANTHIVE_FAKE_PS = 'claude --resume 99999999-9999-4999-8999-999999999999';   // some other session is alive; none of ours is
const project = await P.createProject('hive', repo);
const apiAgent = await P.addAgent(project, 'api'); await P.addAgent(project, 'db');
const slugDir = join(CP, await P.claudeSlug(apiAgent.cwd)); mkdirSync(slugDir, { recursive: true });
writeFileSync(join(slugDir, `${apiAgent.sessionId}.jsonl`), [
  { type: 'user', timestamp: '2026-09-02T10:00:00Z', message: { role: 'user', content: 'fix the duplicate checkout' } },
  { type: 'assistant', timestamp: '2026-09-02T10:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'order.ts' } }] } },
  { type: 'user', timestamp: '2026-09-02T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'const retry = sameSecond(idem_key)' }] } },
  { type: 'assistant', timestamp: '2026-09-02T10:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The retry reuses the idempotency key within the same second.' }] } },
].map((o) => JSON.stringify(o)).join('\n') + '\n');

let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };

async function session(agent: string, reqs: object[]): Promise<any[]> {
  const p = Bun.spawn([process.execPath, 'run', self, 'mcp'], {
    env: { ...process.env, ANTHIVE_HOME: HOME, ANTHIVE_AGENT: agent, ANTHIVE_CLAUDE_PROJECTS: CP },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  p.stdin.write(reqs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  p.stdin.end();
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } };
const call = (id: number, name: string, args: object = {}) =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const text = (r: any) => r?.result?.content?.[0]?.text ?? '';

// --- handshake ---
let res = await session('api', [init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
must('initialize responde com serverInfo', res[0]?.result?.serverInfo?.name === 'anthive');
const names = (res[1]?.result?.tools ?? []).map((t: any) => t.name);
must('tools/list expõe o barramento inteiro', ['note_write', 'note_read', 'send_message', 'inbox', 'thread_conclude', 'project_map', 'project_search', 'agent_create', 'browser_create', 'link'].every((n) => names.includes(n)));
must('toda ferramenta tem inputSchema', res[1].result.tools.every((t: any) => t.inputSchema?.type === 'object'));

// --- api abre conversa e manda mensagem ---
res = await session('api', [init,
  call(2, 'send_message', { to: 'db', text: 'proponho chave_idem unique', goal: 'fechar o schema' }),
  call(3, 'thread_list'),
]);
const DM = /Sent in (\S+?)\./.exec(text(res[1]))?.[1] ?? '';
must('send_message cria a conversa e envia', DM.startsWith('dm-') && DM.includes('api') && DM.includes('db') && DM.includes(project.id) && text(res[1]).includes('1/6'));
must('thread_list mostra a conversa', text(res[2]).includes('fechar o schema'));

// --- db lê a caixa e responde ---
res = await session('db', [init, call(2, 'inbox'), call(3, 'thread_post', { id: DM, text: 'índice parcial' })]);
must('inbox entrega a mensagem', text(res[1]).includes('chave_idem'));
must('inbox marca como dado de terceiro', text(res[1]).includes('DATA'));
must('thread_post avança o turno', text(res[2]).includes('2/6'));

// --- quem está fora não entra ---
res = await session('ui', [init, call(2, 'thread_read', { id: DM })]);
must('agente fora da ACL é barrado', text(res[1]).includes('not part'));

// --- conclusão grava nota ---
res = await session('db', [init, call(2, 'thread_conclude', { id: DM, decision: 'índice parcial where not null' })]);
must('conclude grava a decisão numa nota', /note:\/\//.test(text(res[1])));

res = await session('db', [init, call(2, 'notes_list'), call(3, 'note_write', { title: 'observação do db', text: 'o retry vem sem chave', ttl: '2h' })]);
must('notes_list mostra a note da decisão', text(res[1]).includes('note://'));
must('note_write cria efêmera', text(res[2]).includes('note://'));

// --- erro de ferramenta não derruba o servidor ---
res = await session('api', [init, call(2, 'thread_post', { id: 'nao-existe', text: 'oi' }), call(3, 'agents_list')]);
must('erro vira isError, não crash', res[1]?.result?.isError === true);
must('servidor segue vivo depois do erro', res[2]?.result !== undefined);

// --- project_search: the hive from db's point of view ---
res = await session('db', [init, call(2, 'project_search', { query: 'chave_idem' }), call(3, 'project_search', { query: 'parcial' }), call(4, 'project_search', { query: 'idempotency', scope: 'transcripts' }), call(5, 'project_search', { query: 'nothing-like-this-anywhere' }), call(6, 'project_search', { query: '/[/' }), call(7, 'thread_list'), call(8, 'note_write', { title: 'alias', body: 'written through body' }), call(9, 'note_write', { title: 'empty' })]);
must('project_search finds what api said in the thread, wrapped as data', text(res[1]).includes(DM) && text(res[1]).includes('DATA') && !text(res[1]).includes('[you'));
must('own posts come as [you], the decision note as note://', text(res[2]).includes('[you') && text(res[2]).includes('note://'));
must('project_search reads the transcripts of the agents of the project', text(res[3]).includes('agent api') && text(res[3]).includes('idempotency key'));
must('no match is an answer, not an error', text(res[4]).startsWith('No match') && !res[4]?.result?.isError);
must('a broken regex is an error and the server survives', res[5]?.result?.isError === true && text(res[6]).includes(DM));
must('note_write accepts body as an alias of text', text(res[7]).startsWith('Created note://'));
must('an empty note is refused', res[8]?.result?.isError === true && text(res[8]).includes('text'));

// --- permission_prompt: a rule answers alone; without one, the map answers ---
const A = await import('../src/core/approvals.ts');
await P.addRule(project.id, { agent: 'api', tool: 'Bash', prefix: 'git log' });
res = await session('api', [init, call(2, 'permission_prompt', { tool_name: 'Bash', input: { command: 'git log --oneline' }, tool_use_id: 't1' })]);
must('a remembered rule allows on the spot, with the input echoed back', JSON.parse(text(res[1])).behavior === 'allow' && JSON.parse(text(res[1])).updatedInput.command === 'git log --oneline');
const waiting = session('api', [init, call(2, 'permission_prompt', { tool_name: 'Bash', input: { command: 'python3 scripts/x.py --painel' } })]);
let req: any = null; for (let i = 0; i < 60 && !req; i++) { await new Promise((r) => setTimeout(r, 100)); req = (await A.pending(project.id))[0] ?? null; }
must('an unknown command waits on disk for the user', !!req && req.agent === 'api' && req.tool === 'Bash');
if (req) await A.decide(req.id, 'deny', 'the user said no');
res = await waiting;
must('the user\'s no becomes a deny with a message', JSON.parse(text(res[1])).behavior === 'deny' && /Anthive/.test(JSON.parse(text(res[1])).message));

// --- assembling a team from the bus: agent_create, browser_create, link ---
const born = await session('api', [init, call(30, 'agent_create', { name: 'worker', prompt: 'close out PR #790', link: 'db' })]);
const bornText = String(born[1]?.result?.content?.[0]?.text ?? '');
must('agent_create answers with the agent, its links and the running first turn', /Agent worker created/.test(bornText) && /Linked to: api, db/.test(bornText) && /first turn is running/.test(bornText) && !born[1]?.result?.isError);
const g1 = await P.loadGraph(project.id);
const worker = g1.items.find((i) => i.kind === 'agent' && i.name === 'worker') as { id: string; sessionId: string | null } | undefined;
must('the agent is in the graph with a session and the briefing flag', !!worker?.sessionId && (worker as any).briefingPending === true);
must('linked to the caller and to what was asked', !!worker && g1.links.filter((l) => l.from === worker.id || l.to === worker.id).length === 2);
const waitLog = async () => { for (let i = 0; i < 40; i++) { const t = await Bun.file(fakeLog).text().catch(() => ''); if (t.includes('close out PR #790')) return t; await new Promise((r) => setTimeout(r, 50)); } return await Bun.file(fakeLog).text().catch(() => ''); };
const log = await waitLog();
must('the first turn really started: claude got the session id and the request inside a briefing', log.includes(`--session-id ${worker?.sessionId}`) || log.includes(`--resume ${worker?.sessionId}`)) ;
must('and the request travels inside the briefing, with the bus allowed', log.includes('close out PR #790') && log.includes('mcp__anthive'));
const dup = await session('api', [init, call(31, 'agent_create', { name: 'worker', prompt: 'again' })]);
must('a second agent with the same name is refused', dup[1]?.result?.isError === true);
const br = await session('api', [init, call(32, 'browser_create', {})]);
must('browser_create adds the browser', /Browser added/.test(String(br[1]?.result?.content?.[0]?.text)) && (await P.loadGraph(project.id)).items.some((i) => i.kind === 'browser'));
const lk = await session('api', [init, call(33, 'link', { from: 'worker', to: 'browser' })]);
const g2 = await P.loadGraph(project.id);
const brItem = g2.items.find((i) => i.kind === 'browser')!;
must('link joins two nodes by name', /linked/.test(String(lk[1]?.result?.content?.[0]?.text)) && g2.links.some((l) => (l.from === worker!.id && l.to === brItem.id) || (l.to === worker!.id && l.from === brItem.id)));
const nope = await session('api', [init, call(34, 'link', { from: 'worker', to: 'nobody-here' })]);
must('an unknown name is an error, not a silent no-op', nope[1]?.result?.isError === true);

// --- a message wakes an idle recipient with a background turn on its own session ---
const dbItem = (await P.loadGraph(project.id)).items.find((i) => i.kind === 'agent' && (i as any).name === 'db') as { sessionId: string } | undefined;
const sent = await session('api', [init, call(40, 'send_message', { to: 'db', goal: 'settle the schema', text: 'db, please confirm the column name' })]);
const sentText = String(sent[1]?.result?.content?.[0]?.text ?? '');
const threadId = /Sent in (\S+)\./.exec(sentText)?.[1] ?? '';
const waitWake = async () => { for (let i = 0; i < 60; i++) { const t = await Bun.file(fakeLog).text().catch(() => ''); if (t.includes(`--resume ${dbItem?.sessionId}`)) return t; await new Promise((r) => setTimeout(r, 50)); } return await Bun.file(fakeLog).text().catch(() => ''); };
const wl = await waitWake();
must('the recipient is woken with a resume turn on its session, told to read its inbox', !!dbItem && wl.includes(`--resume ${dbItem.sessionId}`) && wl.includes('Read your inbox'));
if (threadId) await session('api', [init, call(41, 'thread_post', { id: threadId, text: 'and one more thing' })]);
await new Promise((r) => setTimeout(r, 400));
const wl2 = await Bun.file(fakeLog).text().catch(() => '');
must('a second message inside the cooldown does not wake it twice', wl2.split(`--resume ${dbItem?.sessionId}`).length === 2);

// --- conversations written before the scope get their owner ---
const bus2 = await import('../src/core/bus.ts');
const st2 = await import('../src/core/store.ts');
const legacy = await st2.create({ kind: 'thread', id: 'dm-legacy-api-db', title: 'api ⇄ db', acl: ['api', 'db'], goal: 'antiga', budget: 6 });
must('nasce sem projeto, como as de antes', !legacy.project);
must('o carimbo acha o único projeto com os dois participantes', (await bus2.stampThreads()) >= 1 && (await st2.read('dm-legacy-api-db', 'thread'))?.project === project.id);

// --- names are scoped to a project: four "maestro" cannot reach each other ---
const other = await P.createProject('outra-obra', await mkdtemp(join(tmpdir(), 'anthive-other-')));
await P.addAgent(other, 'api');   // mesmo nome, outro projeto
const twin = (await P.loadGraph(other.id)).items.find((i) => i.kind === 'agent') as { id: string };
const list = await session('db', [init, call(50, 'agents_list')]);
const listText = String(list[1]?.result?.content?.[0]?.text ?? '');
must('agents_list separa quem é do meu projeto de quem não é', /In your project \(hive\)/.test(listText) && /out of your reach/.test(listText) && /outra-obra/.test(listText));
const cross = await session('db', [init, call(51, 'send_message', { to: 'ninguem-aqui', text: 'oi', goal: 'x' })]);
must('mandar para quem não é do projeto é erro, com a lista de quem é', cross[1]?.result?.isError === true && /Agents here: /.test(String(cross[1]?.result?.content?.[0]?.text)));
const ok2 = await session('db', [init, call(52, 'send_message', { to: 'worker', text: 'oi vizinho', goal: 'combinar o schema' })]);   // api⇄db já foi concluída acima
const okText = String(ok2[1]?.result?.content?.[0]?.text ?? '');
must('dentro do projeto a mensagem vai para a conversa do projeto', /Sent in dm-/.test(okText) && okText.includes(project.id) && !ok2[1]?.result?.isError);
const threads = await P.loadGraph(project.id) && (await (await import('../src/core/store.ts')).list('thread'));
const dm = threads.find((d) => d.id.includes(project.id) && d.acl.includes('worker'));
must('a conversa nasce carimbada com o projeto', dm?.project === project.id);
must('o gêmeo de outro projeto não vê essa conversa', (await (await import('../src/core/bus.ts')).threadsFor('api', other.id)).every((d) => d.id !== dm?.id));
void twin;

console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
