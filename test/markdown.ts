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
console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
