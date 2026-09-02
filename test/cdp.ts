/** Cliente CDP e geometria da imagem, contra um Chrome de mentira (websocket local). Sem Chrome, sem rede. */
import { Cdp, fitImage, toPage, pickPage, launchArgs, findChrome, inBox } from '../src/core/cdp.ts';
import { LiveView } from '../src/core/live.ts';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };

// --- Chrome de mentira: responde ao que o LiveView usa e grava o que recebe
const seen: string[] = [];
let frameTimer: ReturnType<typeof setInterval> | null = null;
const server = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === '/json/version') return Response.json({ Browser: 'Fake/1', webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/x` });
    if (u.pathname === '/json/list') return Response.json([{ id: 'p1', type: 'page', url: 'https://loja.dev/pedidos', title: 'Pedidos' }, { id: 'ui', type: 'browser_ui', url: 'chrome://x', title: 'x' }]);
    if (srv.upgrade(req)) return undefined as any;
    return new Response('no', { status: 404 });
  },
  websocket: {
    message(ws, raw): void {
      const m = JSON.parse(String(raw)); seen.push(m.method);
      const reply = (result: any): void => { ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) })); };
      switch (m.method) {
        case 'Target.getTargets': return reply({ targetInfos: [
          { targetId: 'p0', type: 'page', url: 'about:blank', title: '', attached: false },
          { targetId: 'p1', type: 'page', url: 'https://loja.dev/pedidos', title: 'Pedidos', attached: true },
          { targetId: 'ui', type: 'browser_ui', url: 'chrome://webui', title: 'ui', attached: false }] });
        case 'Target.attachToTarget': { reply({ sessionId: `s-${m.params.targetId}` }); return; }
        case 'Page.startScreencast': {
          reply({});
          let n = 0;
          frameTimer = setInterval(() => { n++; void ws.send(JSON.stringify({ method: 'Page.screencastFrame', sessionId: m.sessionId, params: { data: 'iVBORw0KGgo=', sessionId: n, metadata: { deviceWidth: 1200, deviceHeight: 800 } } })); if (n >= 3 && frameTimer) { clearInterval(frameTimer); frameTimer = null; } }, 30);
          return;
        }
        case 'Page.stopScreencast': { if (frameTimer) { clearInterval(frameTimer); frameTimer = null; } reply({}); return; }
        case 'Input.dispatchMouseEvent': seen.push(`${m.params.type}@${m.params.x},${m.params.y}${m.params.deltaY ? ' dy' + m.params.deltaY : ''}`); { reply({}); return; }
        case 'Input.insertText': seen.push(`text:${m.params.text}`); { reply({}); return; }
        case 'Input.dispatchKeyEvent': seen.push(`key:${m.params.type}:${m.params.key}`); { reply({}); return; }
        case 'Boom': { ws.send(JSON.stringify({ id: m.id, error: { message: 'explodiu' } })); return; }
        default: { reply({}); return; }
      }
    },
  },
});
const port = server.port!;

// --- cliente cru
const c = await Cdp.connect(port);
const ts = await c.targets();
must('targets filtra só páginas', ts.length === 2 && ts.every((t) => t.id.startsWith('p')));
must('pickPage prefere a página com alguém ligado (o agent)', pickPage(ts)?.id === 'p1');
must('pickPage ignora páginas do próprio chrome', pickPage([{ id: 'a', url: 'chrome://x', title: '' }, { id: 'b', url: 'https://x', title: '' }, { id: 'c', url: 'devtools://y', title: '' }])?.id === 'b');
let err = ''; try { await c.send('Boom'); } catch (e) { err = (e as Error).message; }
must('erro do protocolo vira rejeição com a mensagem', err === 'explodiu');
c.close();

// --- LiveView: segue a página, recebe frames, repassa interação
let changes = 0;
const live = new LiveView(port, () => changes++, { minGapMs: 0 });
await live.start();
await Bun.sleep(250);
must('liga na página do agent e sabe url/título', live.connected && live.target?.id === 'p1' && live.url === 'https://loja.dev/pedidos' && live.title === 'Pedidos');
must('frames chegam com o tamanho do viewport', live.frames === 3 && live.frame?.w === 1200 && live.frame?.h === 800 && live.frame.data === 'iVBORw0KGgo=');
must('cada frame foi confirmado (ack)', seen.filter((s) => s === 'Page.screencastFrameAck').length === 3);
must('avisou a tela a cada mudança', changes >= 4);
live.click(100, 50); live.wheel(10, 10, 120); live.text('ana'); live.key('Enter');
await Bun.sleep(80);
must('clique vira mover+pressionar+soltar na coordenada', seen.includes('mousePressed@100,50') && seen.includes('mouseReleased@100,50'));
must('rolagem, texto e enter chegam', seen.includes('mouseWheel@10,10 dy120') && seen.includes('text:ana') && seen.includes('key:keyDown:Enter') && seen.includes('key:keyUp:Enter'));
live.stop();
await Bun.sleep(100);
must('parar encerra o screencast', seen.includes('Page.stopScreencast'));
server.stop(true);

// --- geometria
const f1 = fitImage(1200, 800, 90, 40, 8, 17);
must('imagem larga: usa todas as colunas e calcula as linhas pela proporção', f1.cols === 90 && f1.rows === Math.round((90 * 8) / 1.5 / 17));
const f2 = fitImage(1200, 800, 90, 10, 8, 17);
must('quando a altura limita, encolhe as colunas', f2.rows === 10 && f2.cols === Math.round((10 * 17 * 1.5) / 8) && f2.cols < 90);
const pt = toPage(10 + 45, 4 + 14, { x: 10, y: 4, cols: 90, rows: 28 }, 1200, 800);
must('célula do meio da caixa cai no meio da página', Math.abs(pt.x - 607) <= 8 && Math.abs(pt.y - 414) <= 16);
must('inBox respeita os limites', inBox(10, 4, { x: 10, y: 4, cols: 90, rows: 28 }) && !inBox(100, 4, { x: 10, y: 4, cols: 90, rows: 28 }) && !inBox(9, 4, { x: 10, y: 4, cols: 90, rows: 28 }));

// --- lançamento
const a1 = launchArgs('/p/x', 9400, 'hidden'), a2 = launchArgs('/p/x', 9400, 'window');
must('oculto é headless e já abre uma página', a1.includes('--headless=new') && a1.includes('about:blank') && a1.includes('--user-data-dir=/p/x') && a1.includes('--remote-debugging-port=9400'));
must('janela nasce sem janela inicial (é o que evita roubar o foco)', a2.includes('--no-startup-window') && !a2.includes('--headless=new'));
must('a janela coberta continua desenhando', a1.includes('--disable-backgrounding-occluded-windows') && a2.includes('--disable-backgrounding-occluded-windows'));
const chrome = await findChrome();
must('acha um Chrome nesta máquina', !!chrome && (await Bun.file(chrome.bin).exists()));
console.log(chrome ? `  chrome: ${chrome.name}` : '');
console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
