/** O trabalho no mapa: escritas por ferramenta, pelo shell e vistas no disco; história em ordem. */
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
const claude = await realpath(await mkdtemp(join(tmpdir(), 'anthive-claude-')));
process.env.ANTHIVE_CLAUDE_PROJECTS = claude;
process.env.ANTHIVE_FAKE_PS = 'claude --resume 22222222-3333-4444-8555-666666666666';
const cwd = await realpath(await mkdtemp(join(tmpdir(), 'anthive-repo-')));
const W = await import('../src/core/written.ts');
const P = await import('../src/core/project.ts');
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };

// --- um projeto com um transcript de verdade e um subagente ---
const sid = '22222222-3333-4444-8555-666666666666';
const dir = join(claude, '-tmp-repo'); await mkdir(dir, { recursive: true });
const main = join(dir, `${sid}.jsonl`);
const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const line = (o: object, min = 1) => JSON.stringify({ uuid: crypto.randomUUID(), parentUuid: null, isSidechain: false, cwd, sessionId: sid, timestamp: at(min), ...o });
const call = (id: string, name: string, input: object, min = 1) => line({ type: 'assistant', message: { id: `m-${id}`, role: 'assistant', model: 'x', content: [{ type: 'tool_use', id, name, input }], usage: { output_tokens: 5 } } }, min);
const result = (id: string, err = false, min = 1) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content: 'ok' }] } }, min);

await mkdir(join(cwd, 'docs'), { recursive: true });
for (const f of ['docs/a.md', 'docs/b.md', 'nota.txt', 'gerado.csv']) await writeFile(join(cwd, f), 'x\n');
await writeFile(join(cwd, 'falhou.md'), 'x\n');

await writeFile(main, [
  line({ type: 'user', message: { role: 'user', content: 'faça o relatório' } }, 20),
  call('W1', 'Write', { file_path: join(cwd, 'docs/a.md'), content: '# a' }, 19), result('W1', false, 19),
  call('W2', 'Write', { file_path: join(cwd, 'falhou.md'), content: 'x' }, 18), result('W2', true, 18),
  call('W3', 'Write', { file_path: '/etc/hosts', content: 'x' }, 18), result('W3', false, 18),
  call('B1', 'Bash', { command: `grep -n foo ${cwd}/docs/a.md > /dev/null && echo ok` }, 17), result('B1', false, 17),
  call('B2', 'Bash', { command: `cat > ${cwd}/nota.txt <<'FIM'\n# título > importante\nvale 5 > 3\nFIM` }, 16), result('B2', false, 16),
  call('B3', 'Bash', { command: `python fazer.py > ${cwd}/inexistente.csv` }, 15), result('B3', false, 15),
  call('A1', 'Agent', { description: 'pesquisar preços', subagent_type: 'general-purpose', prompt: 'p' }, 14),
].join('\n') + '\n');

const subDir = join(dir, sid, 'subagents'); await mkdir(subDir, { recursive: true });
await writeFile(join(subDir, 'agent-s1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'pesquisar preços', toolUseId: 'A1' }));
await writeFile(join(subDir, 'agent-s1.jsonl'), [
  JSON.stringify({ uuid: crypto.randomUUID(), isSidechain: true, agentId: 's1', type: 'user', message: { role: 'user', content: 'pesquise' }, timestamp: at(14) }),
  JSON.stringify({ uuid: crypto.randomUUID(), isSidechain: true, agentId: 's1', type: 'assistant', timestamp: at(13), message: { id: 'ms1', role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: 'S1', name: 'Bash', input: { command: `cat > ${cwd}/docs/b.md <<'EOF'\n# b\nEOF` } }], usage: { output_tokens: 3 } } }),
].join('\n') + '\n');

const size = (await Bun.file(main).stat()).size;
const ws = await W.writesOfSession(main, size, 'api', cwd);
const paths = ws.map((w) => w.path.slice(cwd.length + 1)).sort();
must('a escrita por ferramenta entra', paths.includes('docs/a.md'));
must('o cat > do subagente entra: é assim que a maior parte do trabalho sai', paths.includes('docs/b.md') && ws.find((w) => w.path.endsWith('docs/b.md'))!.how === 'shell');
must('o cat > do próprio agente entra, sem o lixo do heredoc', paths.includes('nota.txt') && !paths.some((p) => p.includes('título') || p === '3'));
must('redirecionar para /dev/null não é escrita', !paths.some((p) => p.includes('null')));
must('alvo que não existe no disco é descartado', !paths.some((p) => p.includes('inexistente')));
must('chamada que falhou é descartada', !paths.includes('falhou.md'));
must('caminho fora do projeto é descartado', !ws.some((w) => w.path.startsWith('/etc')));
must('nada além disso', paths.length === 3);

// --- crescimento lido em pedaços ---
await appendFile(main, call('W9', 'Write', { file_path: join(cwd, 'gerado.csv'), content: 'a,b' }, 1) + '\n' + result('W9') + '\n');
const size2 = (await Bun.file(main).stat()).size;
const ws2 = await W.writesOfSession(main, size2, 'api', cwd);
must('o que cresceu é lido sem reler o resto', ws2.length === 4 && ws2[0]!.path.endsWith('gerado.csv'));

// --- história ---
const hist = await W.historyOf([{ name: 'api', path: main, size: size2, cwd }], 10);
const kinds = hist.map((m) => m.kind);
must('a história tem o turno, o subagente e as escritas, do mais velho ao mais novo', kinds.includes('turn') && kinds.includes('subagent') && kinds.includes('wrote') && hist.every((m, i) => i === 0 || hist[i - 1]!.ts <= m.ts));
must('a história não repete o lixo do shell', !hist.some((m) => m.kind === 'wrote' && m.what.includes('inexistente')));

// --- o disco, para o que nenhuma chamada nomeia ---
await writeFile(join(cwd, 'saida.xlsx'), 'x');
const seen = await W.changedFiles(cwd, Date.now() - 3600_000);
must('o disco entrega o que nenhuma ferramenta nomeou', seen.some((f) => f.path.endsWith('saida.xlsx')));

// --- no mapa ---
const p = await P.createProject('obra', cwd);
const g = await P.loadGraph(p.id);
g.items.push({ kind: 'agent', id: 'ag1', name: 'api', cwd, sessionId: sid, worktree: null, created: Date.now() });
await P.saveGraph(p.id, g);
const v = await P.view(p);
const wrote = v.nodes.filter((n): n is import('../src/core/project.ts').WroteNode => n.kind === 'wrote');
must('o trabalho vira nó ligado ao agente', wrote.length > 0 && wrote.some((n) => n.agent === 'ag1') && v.edges.some((e) => e.kind === 'wrote'));
must('com poucos arquivos cada um é um nó', wrote.every((n) => n.group.length === 0) && wrote.some((n) => n.label === 'docs/a.md'));
must('o que só o disco viu não tem dono', wrote.some((n) => n.agent === null && n.label === 'saida.xlsx'));

// --- passando de cinco, agrupa por pasta ---
for (const [i, f] of ['docs/c.md', 'docs/d.md', 'docs/e.md'].entries()) {
  await writeFile(join(cwd, f), 'x\n');
  await appendFile(main, call(`X${i}`, 'Write', { file_path: join(cwd, f), content: 'x' }, 1) + '\n' + result(`X${i}`) + '\n');
}
const v2 = await P.view(p);
const w2 = v2.nodes.filter((n): n is import('../src/core/project.ts').WroteNode => n.kind === 'wrote');
must('acima de cinco arquivos o mapa mostra pastas', w2.every((n) => n.group.length > 0) && w2.some((n) => n.label === 'docs/' && n.group.length >= 4));
must('a pasta herda o dono de quem mais escreveu nela', w2.find((n) => n.label === 'docs/')?.agent === 'ag1');

// --- abrir e fixar ---
const { App } = await import('../src/app.ts');
const { Screen } = await import('../src/tui/screen.ts');
class F extends Screen { constructor() { super({ mouse: true }); this.W = 130; this.H = 30; } override measure() {} override enter() {} override restore() {} override write() {} override onKey() {} }
const app = new App(new F()); app.consentOk = true;
await app.openProject(p);
const dirNode = app.pv!.nodes.find((n) => n.kind === 'wrote' && n.group.length > 0)!;
app.sel = dirNode.id;
await app.openSel();
must('↵ num nó do trabalho abre o arquivo', (app as any).view === 'file' && !!app.file && app.file.path.startsWith(cwd));
(app as any).view = 'project';
app.sel = dirNode.id; (app as any).linking = { source: dirNode.id };
const agentNode = app.pv!.nodes.find((n) => n.kind === 'agent')!;
app.sel = agentNode.id;
await (app as any).commitLink();
const saved = await P.loadGraph(p.id);
must('l fixa o arquivo no projeto em vez de gravar um id que morre', saved.items.some((i) => i.kind === 'file') && saved.links.every((l) => !l.from.startsWith('wrote-') && !l.to.startsWith('wrote-')));

// --- a faixa de história ---
const { renderProject } = await import('../src/views/project.ts');
const { Grid } = await import('../src/tui/grid.ts');
const gh = new Grid(120, 34);
renderProject(gh, app.pv!, null, 0, '', {});
const sh = gh.toString();
must('a faixa aparece quando sobra tela, com hora, quem e o quê', sh.includes('history ─') && /\d\d:\d\d api/.test(sh) && sh.includes('faça o relatório'));
const gs = new Grid(120, 14);
renderProject(gs, app.pv!, null, 0, '', {});
must('com a tela cheia a faixa some sozinha', !gs.toString().includes('history ─'));
must('a roda não passa do fim do mapa', (app as any).mapMax() >= 0);

await rm(claude, { recursive: true, force: true });
console.log(fails ? `\n${fails} failure(s)` : '\nall green');
process.exit(fails ? 1 : 0);
