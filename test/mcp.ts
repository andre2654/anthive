/** Fala JSON-RPC de verdade com o servidor MCP, como um agente faria. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'tai-mcp-'));
const CP = mkdtempSync(join(tmpdir(), 'tai-mcp-claude-'));   // where "Claude Code" keeps transcripts, for project_search
const self = join(import.meta.dir, '..', 'src', 'index.ts');
process.env.ANTHIVE_HOME = HOME; process.env.ANTHIVE_CLAUDE_PROJECTS = CP;
const P = await import('../src/core/project.ts');
const { mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'tai-mcp-repo-')));
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
must('tools/list expõe o barramento inteiro', ['note_write', 'note_read', 'send_message', 'inbox', 'thread_conclude', 'project_map', 'project_search'].every((n) => names.includes(n)));
must('toda ferramenta tem inputSchema', res[1].result.tools.every((t: any) => t.inputSchema?.type === 'object'));

// --- api abre conversa e manda mensagem ---
res = await session('api', [init,
  call(2, 'send_message', { to: 'db', text: 'proponho chave_idem unique', goal: 'fechar o schema' }),
  call(3, 'thread_list'),
]);
must('send_message cria a conversa e envia', text(res[1]).includes('dm-api-db') && text(res[1]).includes('1/6'));
must('thread_list mostra a conversa', text(res[2]).includes('fechar o schema'));

// --- db lê a caixa e responde ---
res = await session('db', [init, call(2, 'inbox'), call(3, 'thread_post', { id: 'dm-api-db', text: 'índice parcial' })]);
must('inbox entrega a mensagem', text(res[1]).includes('chave_idem'));
must('inbox marca como dado de terceiro', text(res[1]).includes('DATA'));
must('thread_post avança o turno', text(res[2]).includes('2/6'));

// --- quem está fora não entra ---
res = await session('ui', [init, call(2, 'thread_read', { id: 'dm-api-db' })]);
must('agente fora da ACL é barrado', text(res[1]).includes('not part'));

// --- conclusão grava nota ---
res = await session('db', [init, call(2, 'thread_conclude', { id: 'dm-api-db', decision: 'índice parcial where not null' })]);
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
must('project_search finds what api said in the thread, wrapped as data', text(res[1]).includes('dm-api-db') && text(res[1]).includes('DATA') && !text(res[1]).includes('[you'));
must('own posts come as [you], the decision note as note://', text(res[2]).includes('[you') && text(res[2]).includes('note://'));
must('project_search reads the transcripts of the agents of the project', text(res[3]).includes('agent api') && text(res[3]).includes('idempotency key'));
must('no match is an answer, not an error', text(res[4]).startsWith('No match') && !res[4]?.result?.isError);
must('a broken regex is an error and the server survives', res[5]?.result?.isError === true && text(res[6]).includes('dm-api-db'));
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

console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
