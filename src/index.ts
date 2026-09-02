#!/usr/bin/env bun
import { App } from './app.ts';
import * as P from './core/project.ts';
import { ROOT } from './core/store.ts';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import pkg from '../package.json';

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'mcp') { await (await import('./mcp/server.ts')).serve(); process.exit(0); }

if (cmd === '--version' || cmd === '-v' || cmd === 'version') { console.log(`anthive ${pkg.version}`); process.exit(0); }

if (cmd === 'doctor') {
  const { checks, report } = await import('./core/doctor.ts');
  const list = await checks();
  console.log(report(list));
  process.exit(list.filter((c) => !c.ok && c.name === 'Claude Code').length ? 1 : 0);
}

if (cmd === 'install-mcp') {
  const i = rest.indexOf('--cwd'); const dir = resolve(i >= 0 ? rest[i + 1]! : process.cwd());
  const file = resolve(dir, '.mcp.json');
  const compiled = import.meta.dir.startsWith('/$bunfs');
  let cfg: any = {}; try { cfg = JSON.parse(await readFile(file, 'utf8')); } catch {}
  cfg.mcpServers ??= {};
  cfg.mcpServers.anthive = { command: process.execPath, args: compiled ? ['mcp'] : [resolve(import.meta.dir, 'index.ts'), 'mcp'], env: { ANTHIVE_HOME: ROOT } };
  delete cfg.mcpServers.terminai;
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(`bus registered in ${file}`); process.exit(0);
}

if (cmd === 'ls') {
  for (const c of await P.homeCards()) console.log(`${c.registered ? '●' : '○'} ${c.project.name.padEnd(24)} ${String(c.sessions.length).padStart(3)} sessions  ${c.project.cwd}`);
  process.exit(0);
}

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(`anthive ${pkg.version} — an ant hive for your Claude Code agents

  anthive               open the projects screen
  anthive <project>     open a project by name, id or a piece of its path
  anthive ls            list projects as text
  anthive doctor        check what this machine has (Claude Code, Chrome, terminal images…)
  anthive install-mcp   register the agent bus in the current directory's .mcp.json
  anthive mcp           run the MCP server (agents call this; you don't)

  env: ANTHIVE_HOME (data dir, default ~/.anthive)  ANTHIVE_LANG=en|pt`);
  process.exit(0);
}

// `anthive <project>` opens it directly: by name, by id or by a piece of its directory
let initial: P.Project | undefined;
if (cmd && !cmd.startsWith('-')) {
  const q = cmd.toLowerCase();
  const all = await P.listProjects();
  initial = all.find((p) => p.name.toLowerCase() === q || p.id === q) ?? all.find((p) => p.cwd.toLowerCase().includes(q));
  if (!initial) { console.error(`no project "${cmd}" — \`anthive ls\` lists the ones that exist`); process.exit(1); }
}
await new App().run(initial);
