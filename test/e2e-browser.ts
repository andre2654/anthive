/** Ponta a ponta com API (custa): agente haiku, pelo Chrome oculto do anthive (CDP), lê uma página local;
 *  o mapa passa a mostrar url, título, snapshot e screenshot a partir do transcript. Deixa o store e o cwd no disco para screenshots. */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as P from '../src/core/project.ts';
import { ChatSession, ChatEvent } from '../src/core/chat.ts';

let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'tai-loja-')));
writeFileSync(join(cwd, 'page.html'), '<html><head><title>Loja da Ana</title></head><body><h1>Pedidos</h1><a href="/novo">Novo pedido</a><label>Cliente <input name="cliente"></label><button>Salvar</button></body></html>');
const port = 8100 + Math.floor(Math.random() * 800);
const http = Bun.spawn(['python3', '-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd, stdout: 'ignore', stderr: 'ignore' });
await Bun.sleep(800);

const p = await P.createProject('loja', cwd);
await P.ensureBus(cwd);
const br = await P.addBrowser(p, 'hidden');
must('chrome oculto do anthive sobe', (await P.ensureBrowserUp(br)) === 'started');
const ag = await P.addAgent(p, 'comprador');
await P.link(p.id, ag.id, br.id);
must('agente ligado ao browser', await P.agentHasBrowser(p.id, ag.id));
const mcp = JSON.parse(await Bun.file(join(cwd, '.mcp.json')).text());
must('.mcp.json tem playwright ligado ao Chrome do anthive e o barramento', !!mcp.mcpServers?.playwright && mcp.mcpServers.playwright.args.includes(`http://127.0.0.1:${br.port}`) && !!mcp.mcpServers?.anthive);

const events: ChatEvent[] = [];
const chat = new ChatSession({ cwd, sessionId: ag.sessionId ?? undefined, model: 'claude-haiku-4-5-20251001', effort: 'low', agent: ag.name, browser: true }, (e) => events.push(e));
const waitFor = (pred: () => boolean, ms: number) => new Promise<boolean>((res) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (pred()) { clearInterval(iv); res(true); } else if (Date.now() - t0 > ms) { clearInterval(iv); res(false); } }, 200);
});
const results = () => events.filter((e) => e.kind === 'result') as Extract<ChatEvent, { kind: 'result' }>[];
chat.start();
chat.send(`Abra http://127.0.0.1:${port}/page.html com browser_navigate, depois chame browser_snapshot e por fim browser_take_screenshot. Responda em uma linha: o título da página e quantos refs o snapshot tem.`);
must('turno com browser termina', await waitFor(() => results().length === 1, 240000));
const tools = events.filter((e) => e.kind === 'ev' && !!e.ev.tool).map((e) => ((e as Extract<ChatEvent, { kind: 'ev' }>).ev.tool as string).replace(/^mcp__playwright__/, ''));
console.log('  ferramentas:', tools.join(', ') || '(nenhuma)');
console.log('  resposta:', (results()[0]?.text ?? '').slice(0, 200).replace(/\n/g, ' '));
must('usou navigate, snapshot e screenshot', ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot'].every((t) => tools.includes(t)));
must('resposta cita a página', /Loja da Ana/i.test(results()[0]?.text ?? ''));
chat.stop();
await Bun.sleep(800);
const v = await P.view(p);
const node = v.nodes.find((n): n is P.BrowserNode => n.kind === 'browser');
console.log('  estado:', node?.state.url, '|', node?.state.title, '|', node?.state.counts ?? 'sem contagem', '| snapshot', node?.state.snapshot.split('\n').length, 'linhas | imagem', node?.state.image ? `${node.state.image.data.length} chars` : 'não', '| último', node?.state.lastTool, node?.state.busy ? '(ocupado)' : '');
must('mapa reads url e título do transcript', !!node && node.state.url.includes(`127.0.0.1:${port}`) && node.state.title === 'Loja da Ana');
must('snapshot com refs chegou ao mapa', !!node && /\[ref=e\d+\]/.test(node.state.snapshot));
must('screenshot chegou como imagem', !!node?.state.image && node.state.image.data.length > 1000);
must('não está ocupado depois do turno', !!node && !node.state.busy);
must('mapa vê a página ao vivo no Chrome do anthive', !!node?.state.live && (await P.pagesOf(br)).some((pg) => pg.title === 'Loja da Ana'));
await P.closeBrowser(br);
http.kill();
console.log(`\ncusto: $${chat.cost.toFixed(4)}\nstore: ${process.env.ANTHIVE_HOME}\ncwd: ${cwd}\nsessão: ${ag.sessionId}`);
console.log(fails ? `${fails} falha(s)` : 'tudo verde');
process.exit(fails ? 1 : 0);
