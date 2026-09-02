/**
 * README screenshots without a screen: drives the App in-process against a demo store,
 * turns each Grid into HTML (one absolutely positioned span per cell, so box-drawing and
 * symbols never drift) and lets the project's own hidden Chrome rasterize it over CDP.
 * The browser screen gets the real live frame composited where the Kitty image would be.
 *
 *   ANTHIVE_HOME=<demo store> bun run docs/shots.ts            (see test/demo.ts for a demo store)
 */
import { App } from '../src/app.ts';
import { Screen } from '../src/tui/screen.ts';
import { Grid } from '../src/tui/grid.ts';
import * as P from '../src/core/project.ts';
import { Cdp, pickPage, isUp } from '../src/core/cdp.ts';
import { writeFile } from 'node:fs/promises';

process.env.TERM_PROGRAM = 'ghostty';   // the app draws the image box only where the Kitty protocol exists
const W = 132, H = 38, CW = 9.03, CH = 19, PAD = 28;
const project = process.argv[2] ?? 'pedidos';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const p = (await P.listProjects()).find((x) => x.name === project);
if (!p) { console.error(`no project ${project} in ${process.env.ANTHIVE_HOME}`); process.exit(1); }
const screen = new Screen(); screen.W = W; screen.H = H; screen.write = () => {};
const app = new App(screen); app.consentOk = true;
await app.openProject(p);
app.render();
const shots: { name: string; grid: Grid; img?: { data: string; x: number; y: number; cols: number; rows: number } }[] = [];
const snap = (name: string, img?: (typeof shots)[0]['img']) => { const g = new Grid(W, H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = app.grid.cell(x, y); g.put(x, y, c.ch, c.fg, c.bg ?? undefined); } shots.push({ name, grid: g, img }); };
snap('map');

// the chat of the first agent
const api = app.pv!.nodes.find((n) => n.kind === 'agent');
if (api) { app.sel = api.id; await app.openSel(); await sleep(300); app.render(); snap('chat'); app.view = 'project'; }

// a nice page in the project's Chrome, then the browser screen with the live frame
const br = app.pv!.nodes.find((n): n is P.BrowserNode => n.kind === 'browser');
if (br && (await isUp(br.item.port))) {
  const c = await Cdp.connect(br.item.port);
  const pg = pickPage(await c.targets());
  if (pg && (pg.url === 'about:blank' || pg.url === '')) {   // only when nobody navigated yet
    const sid = await c.attach(pg.id);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pedidos · dashboard</title><style>
      body{margin:0;font-family:-apple-system,Inter,sans-serif;background:#f6f7fb;color:#111}header{background:#1d3557;color:#fff;padding:18px 32px;font-size:22px;font-weight:600}
      main{padding:28px 32px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.card{background:#fff;border-radius:12px;padding:18px 20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
      .k{font-size:13px;color:#667}.v{font-size:32px;font-weight:700;margin-top:6px}table{grid-column:1/4;width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden}
      th,td{text-align:left;padding:12px 16px;border-bottom:1px solid #eef}th{font-size:12px;color:#667;text-transform:uppercase}.ok{color:#2a9d8f}.dup{color:#e63946;font-weight:600}
      button{background:#e63946;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px}</style></head><body>
      <header>Pedidos <span style="opacity:.7;font-weight:400">· orders API</span></header>
      <main><div class="card"><div class="k">orders today</div><div class="v">1,284</div></div><div class="card"><div class="k">duplicates</div><div class="v dup">3</div></div><div class="card"><div class="k">p95 latency</div><div class="v">212 ms</div></div>
      <table><tr><th>id</th><th>customer</th><th>idempotency key</th><th>total</th><th>status</th></tr>
      <tr><td>ord_9f21</td><td>ana</td><td>c-ana-8a1f</td><td>R$ 249,90</td><td class="ok">created</td></tr>
      <tr><td>ord_9f22</td><td>ana</td><td>c-ana-8a1f</td><td>R$ 249,90</td><td class="dup">duplicate</td></tr>
      <tr><td>ord_9f23</td><td>bruno</td><td>c-bru-77c0</td><td>R$ 89,00</td><td class="ok">created</td></tr>
      <tr><td colspan="5"><button>Retry checkout</button></td></tr></table></main></body></html>`;
    await c.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) }, sid);
    await sleep(600);
  }
  c.close();
  app.sel = br.id; await app.openSel();
  const t0 = Date.now(); while (!app.page?.frame && Date.now() - t0 < 8000) await sleep(200);
  await sleep(600); app.render();
  const fr = app.page?.frame, box = app.imgBox;
  snap('browser', fr && box ? { data: fr.data, ...box } : undefined);
  app.closeLive();
}

// grid → html
const hex = (c: readonly [number, number, number]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function toHtml(s: (typeof shots)[0]): string {
  const cells: string[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = s.grid.cell(x, y);
    if (c.ch === ' ' && !c.bg) continue;
    cells.push(`<i style="left:${(x * CW).toFixed(2)}px;top:${y * CH}px;color:${hex(c.fg)}${c.bg ? `;background:${hex(c.bg)}` : ''}">${esc(c.ch)}</i>`);
  }
  const img = s.img ? `<img src="data:image/png;base64,${s.img.data}" style="position:absolute;left:${(s.img.x * CW).toFixed(2)}px;top:${s.img.y * CH}px;width:${(s.img.cols * CW).toFixed(2)}px;height:${s.img.rows * CH}px">` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent}
    .win{position:absolute;left:${PAD}px;top:${PAD}px;width:${(W * CW).toFixed(2)}px;border-radius:12px;overflow:hidden;background:#0e1117;box-shadow:0 18px 50px rgba(0,0,0,.45)}
    .bar{height:34px;background:#171b24;display:flex;align-items:center;padding:0 14px;gap:8px;font:13px -apple-system,sans-serif;color:#8b93a7}
    .bar b{width:12px;height:12px;border-radius:6px;display:inline-block}.bar span{margin-left:10px}
    .term{position:relative;height:${H * CH}px;font:15px/${CH}px "SF Mono",Menlo,monospace}
    .term i{position:absolute;font-style:normal;white-space:pre;width:${CW.toFixed(2)}px;height:${CH}px}
  </style></head><body><div class="win"><div class="bar"><b style="background:#ff5f57"></b><b style="background:#febc2e"></b><b style="background:#28c840"></b><span>anthive — ${esc(project)}</span></div><div class="term">${cells.join('')}${img}</div></div></body></html>`;
}

// html → png in a scratch tab of the same Chrome (opened after the live view stopped, so it never steals the followed page)
const port = br?.item.port;
if (!port || !(await isUp(port))) { console.error('need the project Chrome up for rasterizing'); process.exit(1); }
const c = await Cdp.connect(port);
const tid = (await c.send('Target.createTarget', { url: 'about:blank' })).targetId;
const sid = await c.attach(tid);
await c.send('Page.enable', {}, sid);
await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sid);
for (const s of shots) {
  const w = Math.ceil(W * CW + PAD * 2), h = H * CH + 34 + PAD * 2;
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false }, sid);
  await c.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(toHtml(s)) }, sid);
  await sleep(900);
  const shot = await c.send('Page.captureScreenshot', { format: 'png', omitBackground: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } }, sid);
  await writeFile(`docs/${s.name}.png`, Buffer.from(shot.data, 'base64'));
  console.log(`docs/${s.name}.png  ${Math.round(shot.data.length * 0.75 / 1024)} KB`);
}
await c.send('Target.closeTarget', { targetId: tid });
c.close();
process.exit(0);
