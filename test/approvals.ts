/** Permission requests: what is remembered, what a linked file covers, and the file round trip with the user's answer. */
import { prefixOf, summary, matchesRule, touchesLinked, autoDecide, ask, pending, decide, fileIn } from '../src/core/approvals.ts';
import type { Graph } from '../src/core/project.ts';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };

must('the prefix of a command stops at its first flag', prefixOf('Bash', { command: 'python3 scripts/ler_carteira.py --painel --x' }) === 'python3 scripts/ler_carteira.py' && prefixOf('Bash', { command: 'git log --oneline' }) === 'git log' && prefixOf('Bash', { command: 'ls' }) === 'ls');
must('the prefix of a file tool is its path', prefixOf('Edit', { file_path: '/p/a.ts', old_string: 'x' }) === '/p/a.ts');
must('summary shows the command or the path', summary('Bash', { command: 'echo  hi' }) === 'echo hi' && summary('Read', { file_path: '/p/a.md' }) === '/p/a.md');
must('a rule matches by tool and prefix', matchesRule({ agent: 'api', tool: 'Bash', prefix: 'python3 scripts/ler_carteira.py', created: 0 }, 'Bash', { command: 'python3 scripts/ler_carteira.py --painel' }) && !matchesRule({ agent: 'api', tool: 'Bash', prefix: 'python3 scripts/ler_carteira.py', created: 0 }, 'Bash', { command: 'python3 other.py' }));
const cwd = mkdtempSync(join(tmpdir(), 'tai-appr-'));
mkdirSync(join(cwd, 'scripts')); writeFileSync(join(cwd, 'scripts', 'ler.py'), 'print(1)'); writeFileSync(join(cwd, 'Carteira.numbers'), 'x');
const files = [{ kind: 'file' as const, id: 'f1', path: join(cwd, 'Carteira.numbers'), label: 'Carteira.numbers', created: 0 }];
must('a linked file is recognised by absolute path, relative path or bare name', !!touchesLinked('Bash', { command: `python3 scripts/ler.py ${join(cwd, 'Carteira.numbers')}` }, files, cwd) && !!touchesLinked('Bash', { command: 'open Carteira.numbers' }, files, cwd) && !!touchesLinked('Read', { file_path: join(cwd, 'Carteira.numbers') }, files, cwd) && !touchesLinked('Bash', { command: 'rm -rf node_modules' }, files, cwd));
const g: Graph = { items: [{ kind: 'agent', id: 'a1', name: 'api', cwd, sessionId: 'u', worktree: null, created: 0 }, files[0]!], links: [{ from: 'a1', to: 'f1', created: 0 }], rules: [{ agent: 'api', tool: 'Bash', prefix: 'python3 scripts/ler.py', created: 0 }] };
must('autoDecide: a rule allows, a linked file allows, the rest waits', autoDecide({ agent: 'api', tool: 'Bash', input: { command: 'python3 scripts/ler.py --painel' }, cwd }, g)?.reason.startsWith('rule') === true && autoDecide({ agent: 'api', tool: 'Bash', input: { command: 'cat Carteira.numbers' }, cwd }, g)?.reason.startsWith('linked') === true && autoDecide({ agent: 'api', tool: 'Bash', input: { command: 'rm -rf /' }, cwd }, g) === null && autoDecide({ agent: 'db', tool: 'Bash', input: { command: 'python3 scripts/ler.py' }, cwd }, g) === null);
const req = { id: 'r', agent: 'api', project: null, cwd, tool: 'Bash', input: { command: 'python3 scripts/ler.py --painel' }, ts: 0, state: 'pending' as const };
must('fileIn finds the project file the request touches (not linked yet)', (await fileIn(req, [])) === join(cwd, 'scripts', 'ler.py') && (await fileIn(req, [{ kind: 'file', id: 'x', path: join(cwd, 'scripts', 'ler.py'), label: 'ler.py', created: 0 }])) === null);
// round trip: the bus asks, the TUI answers
const asked = ask({ agent: 'api', project: 'p', cwd, tool: 'Bash', input: { command: 'python3 x.py' } }, { timeoutMs: 5000, pollMs: 50 });
await new Promise((r) => setTimeout(r, 120));
const list = await pending('p');
must('the request is on disk, pending, for its project', list.length === 1 && list[0]!.agent === 'api' && (await pending('other')).length === 0);
await decide(list[0]!.id, 'allow', 'the user allowed it once');
const d = await asked;
must('the answer reaches the asker and the file is gone', d.state === 'allow' && (await pending('p')).length === 0);
const late = await ask({ agent: 'api', project: 'p', cwd, tool: 'Bash', input: { command: 'sleep' } }, { timeoutMs: 300, pollMs: 50 });
must('no answer in time is a deny', late.state === 'deny' && /time/.test(late.reason ?? ''));
console.log(fails ? `\n${fails} failure(s)` : '\nall green'); process.exit(fails ? 1 : 0);
