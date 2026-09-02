/**
 * `anthive doctor`: what this machine has and what is missing, in one screen.
 * Nothing here is fatal — Anthive degrades (no browser, no images) — but a
 * newcomer should see the picture before the first project.
 */
import { findChrome } from './cdp.ts';
import { supportsKittyGraphics } from '../tui/image.ts';

export interface Check { name: string; ok: boolean; detail: string; fix?: string }

const run = async (cmd: string[]): Promise<string | null> => {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : null;
  } catch { return null; }
};

export async function checks(): Promise<Check[]> {
  const out: Check[] = [];
  const claude = await run(['claude', '--version']);
  out.push({ name: 'Claude Code', ok: !!claude, detail: claude ? claude.split('\n')[0]! : 'not found in PATH', fix: claude ? undefined : 'npm install -g @anthropic-ai/claude-code, then `claude` once to log in' });
  const npx = await run(['npx', '--version']);
  out.push({ name: 'npx (for the Playwright MCP)', ok: !!npx, detail: npx ? `npm ${npx}` : 'not found', fix: npx ? undefined : 'install Node.js — only needed for the browser feature' });
  const chrome = await findChrome();
  out.push({ name: 'Chrome (for the browser)', ok: !!chrome, detail: chrome ? chrome.name : 'no Google Chrome, no Chrome for Testing', fix: chrome ? undefined : 'install Google Chrome, or `npx playwright install chromium`' });
  const perl = await run(['perl', '-e', 'print 1']);
  out.push({ name: 'perl (detaches the hidden Chrome)', ok: perl === '1', detail: perl === '1' ? 'ok' : 'not found' });
  const lsof = await run(['lsof', '-v']) !== null || (await run(['which', 'lsof'])) !== null;
  out.push({ name: 'lsof (finds local services)', ok: lsof, detail: lsof ? 'ok' : 'not found' });
  const kitty = supportsKittyGraphics();
  out.push({ name: 'Terminal images (Kitty graphics)', ok: kitty, detail: kitty ? `${process.env.TERM_PROGRAM ?? process.env.TERM} draws images` : `${process.env.TERM_PROGRAM ?? process.env.TERM ?? 'this terminal'} cannot draw the live page`, fix: kitty ? undefined : 'use Ghostty, kitty or WezTerm to see the browser live' });
  out.push({ name: 'Platform', ok: process.platform === 'darwin', detail: `${process.platform} ${process.arch}`, fix: process.platform === 'darwin' ? undefined : 'Anthive 0.1 is macOS only' });
  return out;
}

export function report(list: Check[]): string {
  const w = Math.max(...list.map((c) => c.name.length));
  return list.map((c) => `${c.ok ? '✓' : '✗'} ${c.name.padEnd(w)}  ${c.detail}${c.fix ? `\n  ${' '.repeat(w)}  → ${c.fix}` : ''}`).join('\n');
}
