/** Colar imagem: o clipboard vira anexo, o turno vira blocos, e o transcript reconhece de volta. */
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };

const { pasteImage } = await import('../src/core/clip.ts');
const { describe } = await import('../src/core/sessions.ts');
const { rows, INPUT_H, THUMB_ROWS, thumbBoxes } = await import('../src/views/agent.ts');

// --- o clipboard sem imagem não inventa anexo ---
const dir = await mkdtemp(join(tmpdir(), 'anthive-clip-'));
Bun.spawnSync(['pbcopy'], { stdin: Buffer.from('apenas texto') });
must('sem imagem no clipboard não há anexo', (await pasteImage(dir)) === null);

// --- o turno com imagem vira blocos na entrada do processo ---
const { ChatSession } = await import('../src/core/chat.ts');
const sent: string[] = [];
const chat = new ChatSession({ cwd: dir }, () => {});
(chat as any).proc = { stdin: { write: (s: string) => sent.push(s), flush: () => {} } };
chat.send('o que é isto?', [{ media: 'image/png', data: 'QUJD' }]);
const msg = JSON.parse(sent[0]!);
must('a imagem vai antes do texto, como blocos', Array.isArray(msg.message.content) && msg.message.content[0].type === 'image' && msg.message.content[0].source.data === 'QUJD' && msg.message.content[1].text === 'o que é isto?');
sent.length = 0;
chat.send('sem imagem');
must('sem imagem o conteúdo continua sendo texto puro', JSON.parse(sent[0]!).message.content === 'sem imagem');
sent.length = 0;
chat.send('', [{ media: 'image/png', data: 'QUJD' }]);
must('só imagem, sem texto, também vale', JSON.parse(sent[0]!).message.content.length === 1);

// --- relendo o transcript, o turno não some ---
const d = describe({ message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'o que é isto?' }] } });
must('o transcript marca a imagem e guarda o dado', d.text === '[image] o que é isto?' && d.image?.data === 'QUJD');
const only = describe({ message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] } });
must('turno só de imagem tem texto próprio, então aparece na árvore', only.text === '[image]');
const ev = { uuid: 'u1', parent: null, sidechain: false, type: 'user', ts: 1, role: 'user', text: only.text, full: only.text } as any;
must('e vira mesmo uma linha sua na árvore', rows([ev], '', new Set(), 40, false, 'api').some((r) => r.kind === 'turn' && r.detail.includes('[image]')));

// --- a tira de miniaturas ocupa espaço só quando há anexo ---
must('sem anexo a caixa tem a altura de sempre', INPUT_H(true, 0) === 3 && INPUT_H(false, 0) === 1);
must('com anexo a caixa reserva a tira', INPUT_H(true, 2) === 3 + THUMB_ROWS);
const boxes = thumbBoxes(120, 30, 3);
must('as miniaturas ficam lado a lado, acima da caixa', boxes.length === 3 && boxes[1]!.x > boxes[0]!.x && boxes.every((b) => b.y > 0 && b.y < 30 - 4));
must('mais de quatro imagens não estouram a tira', thumbBoxes(120, 30, 9).length === 4);

console.log(fails ? `\n${fails} failure(s)` : '\nall green');
process.exit(fails ? 1 : 0);
