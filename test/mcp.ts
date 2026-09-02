/** Fala JSON-RPC de verdade com o servidor MCP, como um agente faria. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'tai-mcp-'));
const self = join(import.meta.dir, '..', 'src', 'index.ts');

let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };

async function session(agent: string, reqs: object[]): Promise<any[]> {
  const p = Bun.spawn([process.execPath, 'run', self, 'mcp'], {
    env: { ...process.env, ANTHIVE_HOME: HOME, ANTHIVE_AGENT: agent },
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
must('tools/list expõe o barramento inteiro', ['note_write', 'note_read', 'send_message', 'inbox', 'thread_conclude', 'project_map'].every((n) => names.includes(n)));
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
must('inbox marca como dado de terceiro', text(res[1]).includes('DADO'));
must('thread_post avança o turno', text(res[2]).includes('2/6'));

// --- quem está fora não entra ---
res = await session('ui', [init, call(2, 'thread_read', { id: 'dm-api-db' })]);
must('agente fora da ACL é barrado', text(res[1]).includes('não participa'));

// --- conclusão grava nota ---
res = await session('db', [init, call(2, 'thread_conclude', { id: 'dm-api-db', decision: 'índice parcial where not null' })]);
must('conclude grava a decisão numa nota', /note:\/\//.test(text(res[1])));

res = await session('db', [init, call(2, 'notes_list'), call(3, 'note_write', { title: 'observação do db', text: 'o retry vem sem chave', ttl: '2h' })]);
must('notes_list mostra a nota da decisão', text(res[1]).includes('note://'));
must('note_write cria efêmera', text(res[2]).includes('note://'));

// --- erro de ferramenta não derruba o servidor ---
res = await session('api', [init, call(2, 'thread_post', { id: 'nao-existe', text: 'oi' }), call(3, 'agents_list')]);
must('erro vira isError, não crash', res[1]?.result?.isError === true);
must('servidor segue vivo depois do erro', res[2]?.result !== undefined);

console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
