/**
 * Telas por tipo. Cada uma mostra o que faz sentido para o tipo e só as ações
 * que existem para ele: nota se edita e apaga; arquivo se abre e se desliga;
 * serviço só se olha, se encerra e se remove.
 */
import { Grid } from '../tui/grid.ts';
import { C, G, ago, fit, pad } from '../tui/theme.ts';
import { Doc } from '../core/store.ts';
import { FileItem, ServiceItem, TaskNode, BrowserNode } from '../core/project.ts';
import { BrowserMode } from '../core/cdp.ts';

/** hidden ⇄ window, as the user sees it (the stored values stay `oculto`/`janela`). */
export const modeLabel = (m: BrowserMode) => (m === 'hidden' ? t('hidden') : t('window'));
import { Stats } from '../core/services.ts';
import { keybar, scrollHint } from './chrome.ts';
import { renderMd, MdLine } from '../tui/markdown.ts';
import { t } from '../i18n.ts';

const home = () => process.env.HOME ?? '';

function shell(g: Grid, title: string, titleColor = C.inkHi) {
  g.frame({ x: 0, y: 0, w: g.W, h: g.H }, title, titleColor);
  g.put(0, g.H - 3, G.teeL + G.h.repeat(g.W - 2) + G.teeR, C.frame);
}

/** Linhas de markdown já quebradas, com os trechos coloridos. */
function mdLines(g: Grid, ls: MdLine[], scroll: number, top: number, bottom: number) {
  const view = Math.max(1, bottom - top + 1);
  const slice = ls.slice(scroll, scroll + view);
  for (let i = 0; i < slice.length; i++) {
    let x = 2;
    for (const sp of slice[i]!.spans) { g.put(x, top + i, sp.text, sp.color); x += [...sp.text].length; }
  }
  scrollHint(g, g.H - 3, scroll, Math.max(0, ls.length - scroll - view));
  return view;
}

function lines(g: Grid, ls: string[], scroll: number, top: number, bottom: number, numbered = false) {
  const view = Math.max(1, bottom - top + 1);
  const slice = ls.slice(scroll, scroll + view);
  const numW = numbered ? String(ls.length).length + 1 : 0;
  for (let i = 0; i < slice.length; i++) {
    if (numbered) g.put(2, top + i, String(scroll + i + 1).padStart(numW), C.frame);
    g.put(2 + numW + (numbered ? 1 : 0), top + i, fit(slice[i]!, g.W - 4 - numW - 1), C.ink);
  }
  scrollHint(g, g.H - 3, scroll, Math.max(0, ls.length - scroll - view));
  return view;
}

export function renderNote(g: Grid, d: Doc, scroll: number, status: string, links: string[]) {
  shell(g, `${G.note} ${fit(d.title, g.W - 30)}`, C.link);
  const meta = [d.ttl ? t('ephemeral, expires in {0}', ago(d.ttl - Date.now())) : t('persistent'), d.acl.length ? t('read by: {0}', d.acl.join(', ')) : t('nobody reads it'), ...(links.length ? [t('linked to {0}', links.join(', '))] : [])].join(`  ${G.h}  `);
  g.put(2, 1, fit(meta, g.W - 4), C.dim);
  const body = d.body.replace(/\s+$/, '');
  const view = body ? mdLines(g, renderMd(body, g.W - 4), scroll, 3, g.H - 4) : lines(g, [t('(empty)')], scroll, 3, g.H - 4);
  keybar(g, g.H - 2, [['↑↓', t('scroll')], ['e', t('edit in $EDITOR')], ['l', t('link')], ['d', t('delete')], ['esc', t('back')]], status);
  return view;
}

export function renderFile(g: Grid, f: FileItem, content: string[] | null, scroll: number, status: string, links: string[]) {
  shell(g, `▤ ${fit(f.label, g.W - 30)}`, C.ink);
  const meta = [f.context ? (f.context === 'claude' ? t('environment context — Claude reads it every session') : t('Claude automatic memory')) : '', f.path.replace(home(), '~'), ...(links.length ? [t('linked to {0}', links.join(', '))] : [])].filter(Boolean).join(`  ${G.h}  `);
  g.put(2, 1, fit(meta, g.W - 4), C.dim);
  const isMd = /\.(md|markdown)$/i.test(f.path);
  const view = content && isMd ? mdLines(g, renderMd(content.join('\n'), g.W - 4), scroll, 3, g.H - 4)
    : lines(g, content ?? [t('(could not read — deleted, binary or no permission)')], scroll, 3, g.H - 4, !!content);
  keybar(g, g.H - 2, f.context
    ? [['↑↓', t('scroll')], ['e', t('edit in $EDITOR')], ['esc', t('back')]]
    : [['↑↓', t('scroll')], ['e', t('open in $EDITOR')], ['l', t('link')], ['d', t('unlink from project')], ['esc', t('back')]], status);
  return view;
}

export const TASK_GLYPH = (status: string) => status === 'completed' ? G.running : status === 'in_progress' ? G.focus : G.idle;
export const TASK_COLOR = (status: string) => status === 'completed' ? C.run : status === 'in_progress' ? C.hold : C.dim;
export const TASK_LABEL = (status: string) => status === 'completed' ? t('done') : status === 'in_progress' ? t('in progress') : status === 'pending' ? t('pending') : status;

/** Tarefa é do agente: aqui só se lê. */
export function renderTask(g: Grid, n: TaskNode, agentName: string, status: string, links: string[]) {
  shell(g, `${TASK_GLYPH(n.task.status)} ${t('task')} ${n.task.id}`, TASK_COLOR(n.task.status));
  g.put(2, 1, fit(`${TASK_LABEL(n.task.status)}  ${G.h}  ${t('from')} ${agentName}${n.task.active ? `  ${G.h}  ${n.task.active}` : ''}${links.length ? `  ${G.h}  ${t('linked to {0}', links.join(', '))}` : ''}`, g.W - 4), C.dim);
  const md = `# ${n.task.subject}\n\n${n.task.description || t('_no description_')}`;
  mdLines(g, renderMd(md, g.W - 4), 0, 3, g.H - 4);
  g.put(2, g.H - 4, t('created by the agent itself (TaskCreate); its state comes from its TaskUpdate calls'), C.frame);
  keybar(g, g.H - 2, [['l', t('link')], ['esc', t('back')]], status);
}

export function renderService(g: Grid, s: ServiceItem, st: Stats | null, alive: boolean, status: string, links: string[]) {
  shell(g, `◎ ${s.name}${s.port ? `:${s.port}` : ''}`, alive ? C.run : C.dead);
  g.put(2, 1, alive ? `${G.running} ${t('alive')}` : `${G.stuck} ${t('dead')}`, alive ? C.run : C.dead);
  const rows: [string, string][] = [
    ['pid', String(s.pid)],
    [t('port'), s.port ? String(s.port) : '—'],
    [t('command'), st?.command || s.command],
    [t('directory'), s.cwd ? s.cwd.replace(home(), '~') : '—'],
    [t('up for'), st?.elapsed ?? '—'],
    ['cpu', st ? `${st.cpu.toFixed(1)}%` : '—'],
    [t('memory'), st ? `${st.mem.toFixed(1)}%  ${G.h}  ${st.rssMb} MB` : '—'],
    [t('linked to'), links.length ? links.join(', ') : t('nothing')],
  ];
  let y = 3;
  for (const [k, v] of rows) { g.put(2, y, pad(k, 11), C.frame); g.put(14, y, fit(v, g.W - 16), C.ink); y++; }
  y++;
  g.put(2, y, t('logs: external process — Anthive does not capture them. Only what can be proven is above.'), C.frame);
  keybar(g, g.H - 2, [['k', alive ? t('stop (SIGTERM)') : t('already dead')], ['l', t('link')], ['d', t('remove from project')], ['esc', t('back')]], status);
}

/**
 * O browser por dentro: página, o último snapshot (a árvore que o agente lê)
 * e, se o terminal souber desenhar imagem, o último screenshot à direita —
 * quem desenha a imagem é o app, depois do diff; aqui só se reserva o lugar.
 */
/** Linhas do snapshot que têm ref — o que o agente consegue clicar/digitar — com o ref na frente, onde o corte não come. */
export function snapshotRefs(snapshot: string): { ref: string; text: string }[] {
  const out: { ref: string; text: string }[] = [];
  for (const l of snapshot.split('\n')) {
    const m = /\[ref=(e\d+)\]/.exec(l); if (!m) continue;
    out.push({ ref: m[1]!, text: l.replace(/\s*\[[^\]]*\]/g, '').replace(/^\s*-\s*/, '').replace(/:\s*$/, '').trim() });
  }
  return out;
}

/** nome curto da ferramenta do browser (cabe na coluna de 8 do chat): take_screenshot → print, console_messages → console */
export const browserShort = (t: string) => ({ browser_take_screenshot: 'print', browser_console_messages: 'console', browser_fill_form: 'fill', browser_press_key: 'key', browser_navigate_back: 'back', browser_select_option: 'select', browser_file_upload: 'upload', browser_handle_dialog: 'dialog', browser_tabs: 'tabs', browser_wait_for: 'wait', browser_network_requests: 'network', browser_run_code: 'run', browser_evaluate: 'eval' } as Record<string, string>)[t] ?? t.replace('browser_', '');

export interface LiveInfo { frame: { w: number; h: number; at: number } | null; url: string; title: string; error: string; connected: boolean }
export interface BrowserScreen { live: LiveInfo | null; box: { x: number; y: number; cols: number; rows: number } | null; typing: boolean; canImg: boolean; booting: string }

/**
 * A tela do browser: a página ao vivo (imagem pelo protocolo do Kitty, desenhada
 * depois do diff dentro da moldura) à esquerda; à direita, os refs do último
 * snapshot — o que o agente vê e clica. Sem imagem no terminal, o snapshot inteiro.
 */
export function renderBrowser(g: Grid, n: BrowserNode, s: BrowserScreen, status: string, links: string[]) {
  const st = n.state, live = s.live;
  const url = live?.url || st.url, title = live?.title || st.title;
  shell(g, `▣ browser${title ? ` ${G.h} ${fit(title, g.W - 40)}` : ''}`, live?.connected ? C.run : st.url ? C.ink : C.dim);
  const state = live?.connected ? `${G.running} ${t('live')}` : live?.error ? `${G.stuck} ${live.error}` : s.booting || `${G.idle} ${t('stopped')}`;
  g.put(2, 1, fit([url || t('no page yet'), modeLabel(n.item.mode), state, links.length ? t('linked to {0}', links.join(', ')) : t('no agent linked (l)')].join(`  ${G.h}  `), g.W - 4), C.dim);
  if (s.typing) { const tp = ` ${t('typing into the page')} `; g.put(g.W - 3 - tp.length, 1, tp, C.inkHi, C.hold); }
  const refsX = s.box ? s.box.x + s.box.cols + 3 : 2;
  if (s.box) {
    g.frame({ x: s.box.x - 1, y: s.box.y - 1, w: s.box.cols + 2, h: s.box.rows + 2 }, live?.frame ? t('live page') : t('page'), live?.frame ? C.run : C.dim);
    if (!live?.frame) g.put(s.box.x + 1, s.box.y + 1, fit(s.booting || live?.error || t('waiting for Chrome…'), s.box.cols - 2), C.dim);
  } else if (!s.canImg) {
    const w = g.W - 4, top = 3, view = g.H - 7;
    g.put(2, top, fit(t('this terminal cannot draw images — in Ghostty the page shows here, live. The last snapshot:'), w), C.dim);
    const lines = st.snapshot ? st.snapshot.split('\n').filter((l) => !l.startsWith('```') && !/^###/.test(l) && !/^- (Page (URL|Title)|Console):/.test(l)).filter((l) => l.trim()) : [t('no snapshot yet — the agent calls browser_snapshot to read the page.')];
    for (let i = 0; i < Math.min(lines.length, view - 1); i++) {
      const l = lines[i]!, ref = /\[ref=(\w+)\]/.exec(l);
      g.put(2, top + 1 + i, fit(l.replace(/\t/g, '  '), w), ref ? C.ink : C.dim);
      if (ref) { const at = l.indexOf(ref[0]); if (at >= 0 && at + ref[0].length <= w) g.put(2 + at, top + 1 + i, ref[0], C.link); }
    }
  }
  if (s.box || s.canImg) {
    const w = g.W - 2 - refsX, top = 3;
    if (w >= 16) {
      const head = (y: number, t: string) => { g.put(refsX, y, fit(t + ' ', w), C.frame); g.put(refsX + [...t].length + 1, y, G.h.repeat(Math.max(0, w - [...t].length - 1)), C.frame); };
      head(top, t('the agent sees'));
      const refs = snapshotRefs(st.snapshot);
      const rows = Math.max(1, g.H - 12);
      if (!refs.length) g.put(refsX, top + 1, fit(t('no snapshot yet'), w), C.dim);
      for (let i = 0; i < Math.min(refs.length, rows); i++) { const r = refs[i]!; g.put(refsX, top + 1 + i, pad(r.ref, 4), C.link); g.put(refsX + 4, top + 1 + i, fit(r.text, w - 4), C.dim); }
      if (refs.length > rows) g.put(refsX, top + 1 + rows, fit(t('… {0} more', refs.length - rows), w), C.dim);
      const y2 = g.H - 7;
      head(y2, t('agent'));
      g.put(refsX, y2 + 1, fit(st.lastTool ? `${t('last')}: ${browserShort(st.lastTool)}${st.busy ? '…' : ''}` : t('has not used the browser yet'), w), st.busy ? C.hold : C.dim);
      g.put(refsX, y2 + 2, fit(st.counts ? `console: ${st.counts}` : '', w), C.dim);
    }
  }
  const mode = n.item.mode === 'hidden' ? t('open window') : t('hide');
  keybar(g, g.H - 2, s.typing ? [['esc', t('stop typing')], ['↵', 'enter'], ['⌫', t('delete')], [t('click'), t('the page')]] : [[t('click'), t('the page')], ['↑↓', t('scroll')], ['i', t('type')], ['o', mode], ['r', t('reload')], ['l', t('link')], ['d', t('remove')], ['esc', t('back')]], status);
}
