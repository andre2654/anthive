import { renderMd, plain } from '../src/tui/markdown.ts';
import { C } from '../src/tui/theme.ts';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const md = `# Wealth Studio

Stack em **TypeScript** com \`bun test\` e [docs](https://x.y).

- item um que é longo o bastante para quebrar a linha na largura pedida aqui
- item dois
  - sub item

> uma citação

\`\`\`
const x = 1; // linha de código que não deve quebrar mesmo sendo muito comprida
\`\`\`
---
fim`;
const ls = renderMd(md, 40);
must('título é linha própria e clara', ls[0]!.kind === 'h' && plain(ls[0]!) === 'Wealth Studio' && ls[0]!.spans[0]!.color === C.inkHi);
const p = ls.find((l) => l.kind === 'p' && plain(l).startsWith('Stack'))!;
must('negrito e código inline viram cor', p.spans.some((s) => s.text === 'TypeScript' && s.color === C.inkHi) && p.spans.some((s) => s.text === 'bun test' && s.color === C.link));
must('link mostra o texto e esconde a url', plain(p).includes('docs') && !plain(p).includes('https'));
must('nenhuma linha passa da largura', ls.every((l) => [...plain(l)].length <= 40));
const items = ls.filter((l) => l.kind === 'li');
must('lista ganha •, item longo quebra com recuo', items[0]!.spans[0]!.text === '•' && items.length >= 4 && plain(items[1]!).startsWith('  '));
must('sub item recuado', items.some((l) => plain(l).startsWith('  •')));
must('citação com marcador', ls.some((l) => l.kind === 'quote' && plain(l).startsWith('▎')));
const code = ls.find((l) => l.kind === 'code')!;
must('código não quebra: corta com …', [...plain(code)].length <= 40 && plain(code).endsWith('…'));
must('régua vira traço', ls.some((l) => l.kind === 'hr'));
must('sem linha em branco duplicada', !ls.some((l, i) => l.kind === 'blank' && ls[i + 1]?.kind === 'blank'));
// --- tables
const tb = renderMd('| a | b |\n|---|---|\n| 1 | **x** |\n| um valor bem comprido nesta célula | y |', 30);
must('a table becomes aligned table lines: header, rule, rows', tb.filter((l) => l.kind === 'table').length >= 4 && plain(tb[0]!).startsWith('a') && plain(tb[0]!).includes('b') && /^─+\s+─+/.test(plain(tb[1]!)));
must('cells wrap inside their column when the table is wider than the screen', tb.filter((l) => l.kind === 'table').length > 4 && tb.every((l) => [...plain(l)].length <= 30));
must('bold inside a cell is emphasized', tb.some((l) => l.spans.some((sp) => sp.text === 'x' && sp.color === C.inkHi)));
must('a lone pipe line is not a table', renderMd('| just text', 30)[0]!.kind === 'p');

console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
