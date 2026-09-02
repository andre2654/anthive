/** Chrome de verdade (sem API): sobe oculto, a página ao vivo chega por CDP, clique funciona, fecha. ~5 s. */
import { findChrome, launchChrome, waitUp, isUp, closeChrome, freePort, pages } from '../src/core/cdp.ts';
import { LiveView } from '../src/core/live.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const chrome = await findChrome(); if (!chrome) { console.log('sem chrome'); process.exit(1); }
const port = await freePort(), profile = mkdtempSync(join(tmpdir(), 'tai-chrome-'));
const t0 = Date.now();
await launchChrome(chrome, profile, port, 'oculto');
must('sobe oculto em menos de 12 s', await waitUp(port));
console.log(`  ${chrome.name} em ${Date.now() - t0} ms, porta ${port}`);
let changes = 0; const live = new LiveView(port, () => changes++);
await live.start();
live.navigate('data:text/html,' + encodeURIComponent('<html><head><title>Vitrine</title></head><body style="font:40px sans-serif"><h1>Pedidos</h1><button onclick="document.title=\'Clicou\'" style="font-size:40px;position:absolute;left:100px;top:300px">Salvar</button></body></html>'));
const until = async (pred: () => boolean, ms: number) => { const s = Date.now(); while (Date.now() - s < ms) { if (pred()) return true; await Bun.sleep(100); } return pred(); };
must('frame ao vivo chega depois de navegar', await until(() => !!live.frame, 8000));
must('título ao vivo acompanha', await until(() => live.title === 'Vitrine', 4000));
must('a página aparece na lista HTTP para o mapa', (await pages(port)).some((p) => p.title === 'Vitrine'));
live.click(140, 320);
must('clique na página tem efeito (título mudou)', await until(() => live.title === 'Clicou', 4000));
console.log(`  frames: ${live.frames}, último ${live.frame ? Math.round(live.frame.data.length / 1024) + ' KB' : '-'}, viewport ${live.frame?.w}x${live.frame?.h}`);
live.stop();
await closeChrome(port);
must('fecha', !(await isUp(port)));
console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
