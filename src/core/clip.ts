/**
 * A imagem que está na área de transferência.
 *
 * Nenhum terminal entrega imagem por colagem: o Cmd+V do sistema só passa
 * texto, e com um PNG no clipboard o terminal não manda nada. Então a tecla é
 * ctrl-v, tratada aqui dentro. A leitura vai direto ao NSPasteboard: pedir
 * `the clipboard as «class PNGf»` ao AppleScript custa 2,3 s porque ele
 * enumera e converte toda representação (AVIF, 8BPS, JP2); por aqui é 0,4 s.
 */
import { mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './store.ts';

export interface Pasted { path: string; media: string; bytes: number }
export const PASTES = () => join(ROOT, 'pastes');

/** Escreve o dado de imagem do clipboard em `out` e devolve o tipo achado, ou ''. */
const GRAB = `ObjC.import('AppKit');
var pb = $.NSPasteboard.generalPasteboard;
var ts = ObjC.deepUnwrap(pb.types) || [];
var t = ts.indexOf('public.png') >= 0 ? 'public.png' : (ts.indexOf('public.tiff') >= 0 ? 'public.tiff' : '');
if (t) { pb.dataForType(t).writeToFileAtomically($.NSProcessInfo.processInfo.environment.objectForKey('ANTHIVE_CLIP_OUT').js, true); }
console.log(t);`;

async function run(args: string[], env?: Record<string, string>): Promise<void> {
  try {
    const p = Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore', env: { ...process.env as Record<string, string>, ...env } });
    await p.exited;
  } catch {}
}

/** PNG e TIFF pelos primeiros bytes: o JXA escreve o tipo em stderr, o arquivo é a fonte confiável. */
async function kindOf(path: string): Promise<'png' | 'tiff' | null> {
  const buf = new Uint8Array(await Bun.file(path).slice(0, 4).arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) return 'tiff';
  return null;
}

const TYPES = `ObjC.import('AppKit'); console.log((ObjC.deepUnwrap($.NSPasteboard.generalPasteboard.types) || []).join(','));`;

/** Os tipos que o clipboard anuncia agora, direto do NSPasteboard (0,27 s). Vazio fora do macOS. */
export async function clipboardTypes(): Promise<string> {
  if (process.platform !== 'darwin') return '';
  try {
    const p = Bun.spawn(['osascript', '-l', 'JavaScript', '-e', TYPES], { stdout: 'ignore', stderr: 'pipe' });
    const err = await new Response(p.stderr).text();   // o console.log do JXA sai em stderr
    await p.exited;
    return err.trim();
  } catch { return ''; }
}
export const hasImage = (types: string) => /public\.(png|tiff)/.test(types);

/**
 * Grava a imagem do clipboard num arquivo e devolve o caminho.
 * `null` quando não há imagem, quando não é macOS, ou quando a leitura falha.
 */
export async function pasteImage(dir = PASTES()): Promise<Pasted | null> {
  if (process.platform !== 'darwin') return null;
  await mkdir(dir, { recursive: true });
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const raw = join(dir, `${stamp}.raw`);
  await run(['osascript', '-l', 'JavaScript', '-e', GRAB], { ANTHIVE_CLIP_OUT: raw });
  const kind = await kindOf(raw);
  if (!kind) { await unlink(raw).catch(() => {}); return null; }
  const path = join(dir, `${stamp}.png`);
  if (kind === 'png') await Bun.write(path, Bun.file(raw));
  else await run(['sips', '-s', 'format', 'png', raw, '--out', path]);   // TIFF do clipboard vira PNG pelo conversor do sistema
  await unlink(raw).catch(() => {});
  const st = await stat(path).catch(() => null);
  if (!st || st.size < 8) return null;
  return { path, media: 'image/png', bytes: st.size };
}

const IMG = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
/**
 * Caminhos de imagem dentro de um texto colado. É por aqui que o Cmd+V serve
 * para alguma coisa: com um arquivo copiado no Finder, o terminal cola o
 * caminho, e o caminho vira a imagem.
 */
export async function imagePaths(text: string): Promise<string[]> {
  const lines = text.split(/[\r\n]+/).map((l) => l.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (!lines.length || lines.length > 8) return [];
  const out: string[] = [];
  for (const raw of lines) {
    const p = raw.startsWith('file://') ? decodeURIComponent(raw.slice(7)) : raw;
    if (!p.startsWith('/') || !IMG.test(p)) return [];   // um só que não seja imagem e a colagem é texto
    if (!(await stat(p).then((s) => s.isFile(), () => false))) return [];
    out.push(p);
  }
  return out;
}

/** Um arquivo de imagem que já está no disco vira anexo, copiado para a pasta de colagens. */
export async function attachFile(path: string, dir = PASTES()): Promise<Pasted | null> {
  const st = await stat(path).catch(() => null);
  if (!st || !st.isFile()) return null;
  await mkdir(dir, { recursive: true });
  const to = join(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
  if (/\.png$/i.test(path)) await Bun.write(to, Bun.file(path));
  else await run(['sips', '-s', 'format', 'png', path, '--out', to]);
  const out = await stat(to).catch(() => null);
  return out && out.size > 8 ? { path: to, media: 'image/png', bytes: out.size } : null;
}

/** O conteúdo em base64, para mandar ao agente ou desenhar no terminal. */
export const readB64 = (path: string) => Bun.file(path).arrayBuffer().then((b) => Buffer.from(b).toString('base64'));
