/**
 * Prompts por projeto.
 *
 * Ficam em `<projeto>/.claude/commands/<nome>.md`, que é exatamente onde o
 * Claude Code procura slash commands. Escrever aqui não cria um formato
 * paralelo: o prompt vira `/nome` dentro de qualquer agente daquele projeto,
 * com ou sem o anthive aberto.
 */
import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { slugify } from './store.ts';

export interface Prompt {
  name: string;          // vira /nome
  description: string;
  argHint: string;
  body: string;
  path: string;
  project: string;       // cwd do projeto
}

export const dirFor = (cwd: string) => join(cwd, '.claude', 'commands');

function parse(text: string, path: string, project: string): Prompt {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const head: Record<string, string> = {};
  if (m) for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    name: basename(path, '.md'),
    description: head.description ?? '',
    argHint: head['argument-hint'] ?? '',
    body: m ? text.slice(m[0].length) : text,
    path, project,
  };
}

export async function list(cwd: string): Promise<Prompt[]> {
  const dir = dirFor(cwd);
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const out: Prompt[] = [];
  for (const n of names.filter((x) => x.endsWith('.md'))) {
    const p = join(dir, n);
    try { out.push(parse(await readFile(p, 'utf8'), p, cwd)); } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function read(cwd: string, name: string): Promise<Prompt | null> {
  const p = join(dirFor(cwd), `${name}.md`);
  try { return parse(await readFile(p, 'utf8'), p, cwd); } catch { return null; }
}

export async function save(cwd: string, opts: {
  name: string; body: string; description?: string; argHint?: string;
}): Promise<Prompt> {
  const dir = dirFor(cwd);
  await mkdir(dir, { recursive: true });
  const name = slugify(opts.name, 40);
  const head: string[] = ['---'];
  if (opts.description) head.push(`description: ${opts.description}`);
  if (opts.argHint) head.push(`argument-hint: ${opts.argHint}`);
  head.push('---', '');
  const text = (head.length > 3 ? head.join('\n') : '') + opts.body.trimEnd() + '\n';
  const path = join(dir, `${name}.md`);
  await writeFile(path, text, 'utf8');
  return parse(text, path, cwd);
}

export async function remove(cwd: string, name: string): Promise<boolean> {
  try { await unlink(join(dirFor(cwd), `${name}.md`)); return true; } catch { return false; }
}

/** Resolve nome parcial, como o store faz com os documentos. */
export async function resolve(cwd: string, partial: string): Promise<string> {
  const names = (await list(cwd)).map((p) => p.name);
  if (names.includes(partial)) return partial;
  const pick = names.filter((n) => n.startsWith(partial));
  if (pick.length === 1) return pick[0]!;
  const loose = names.filter((n) => n.includes(partial));
  if (loose.length === 1) return loose[0]!;
  return partial;
}

/** Como o prompt é invocado dentro do agente. */
export const invocation = (p: Prompt, args = '') => `/${p.name}${args ? ` ${args}` : ''}`;
