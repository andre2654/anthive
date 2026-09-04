/**
 * Markdown para a grade: títulos, listas, código, citações, negrito, código
 * inline e links viram linhas de trechos coloridos, já quebradas na largura.
 * Não há negrito de verdade na grade (só cor), então ênfase é cor mais clara.
 */
import { C, G, RGB, strong } from './theme.ts';

export interface Span { text: string; color: RGB }
export type MdKind = 'h' | 'p' | 'li' | 'code' | 'quote' | 'blank' | 'hr' | 'table';
export interface MdLine { kind: MdKind; spans: Span[] }

type Ch = { ch: string; color: RGB };

/** Ênfase inline: `código`, **negrito**, [texto](url). */
function inline(text: string, base: RGB): Ch[] {
  const out: Ch[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let i = 0, m: RegExpExecArray | null;
  const push = (s: string, color: RGB) => { for (const ch of s) out.push({ ch, color }); };
  while ((m = re.exec(text))) {
    push(text.slice(i, m.index), base);
    if (m[1]) push(m[1].slice(1, -1), C.link);
    else if (m[2]) push(m[2].slice(2, -2), strong(C.inkHi));   // **negrito** vira peso, não só cor
    else if (m[3]) push(m[3].slice(1, m[3].indexOf(']')), C.link);
    i = m.index + m[0].length;
  }
  push(text.slice(i), base);
  return out;
}

function toSpans(chs: Ch[]): Span[] {
  const spans: Span[] = [];
  for (const c of chs) {
    const last = spans[spans.length - 1];
    if (last && last.color === c.color) last.text += c.ch; else spans.push({ text: c.ch, color: c.color });
  }
  return spans;
}

/**
 * Quebra por palavra uma linha estilizada. `first` é o começo fixo da primeira
 * linha (recuo + marcador) e `hang` o das continuações — nenhum dos dois passa
 * pelo quebrador, senão os espaços de recuo somem. Espaços do conteúdo mantêm
 * a cor de origem, para `código com espaço` não se partir.
 */
function wrapChs(content: Ch[], width: number, first: Ch[], hang: Ch[]): Ch[][] {
  const lines: Ch[][] = [];
  let line: Ch[] = [...first];
  let word: Ch[] = [];
  let spaceColor: RGB = C.ink;
  let hasWord = false;
  const flushWord = () => {
    if (!word.length) return;
    if (hasWord && line.length + 1 + word.length > width) { lines.push(line); line = [...hang]; hasWord = false; }
    if (hasWord) line.push({ ch: ' ', color: spaceColor });
    while (line.length + word.length > width) {
      const take = Math.max(1, width - line.length);
      line.push(...word.slice(0, take)); word = word.slice(take);
      lines.push(line); line = [...hang]; hasWord = false;
    }
    line.push(...word); word = []; hasWord = true;
  };
  for (const c of content) {
    if (c.ch === ' ') { flushWord(); spaceColor = c.color; continue; }
    word.push(c);
  }
  flushWord();
  lines.push(line);
  return lines;
}

// ---------------------------------------------------------------- tabelas
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string) => {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
};
const bare = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

/** Colunas alinhadas, cabeçalho claro, sublinhado, células quebradas na largura da coluna; colunas largas encolhem até caber. */
function table(header: string[], body: string[][], w: number): MdLine[] {
  const ncol = Math.max(header.length, ...body.map((r) => r.length));
  const all = [header, ...body].map((r) => Array.from({ length: ncol }, (_, i) => r[i] ?? ''));
  const widths = Array.from({ length: ncol }, (_, i) => Math.max(1, ...all.map((r) => [...bare(r[i]!)].length)));
  const gap = 2, avail = Math.max(ncol * 4, w - gap * (ncol - 1));
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > avail) { const i = widths.indexOf(Math.max(...widths)); if (widths[i]! <= 4) break; widths[i]!--; total--; }
  const out: MdLine[] = [];
  const emit = (row: string[], color: RGB) => {
    const wrapped = row.map((cell, i) => (cell ? wrapChs(inline(cell, color), widths[i]!, [], []) : [[]]));
    const h = Math.max(1, ...wrapped.map((c) => c.length));
    for (let k = 0; k < h; k++) {
      const chs: Ch[] = [];
      for (let i = 0; i < ncol; i++) {
        const line = wrapped[i]![k] ?? [];
        chs.push(...line);
        for (let p = line.length; p < widths[i]!; p++) chs.push({ ch: ' ', color: C.ink });
        if (i < ncol - 1) chs.push({ ch: ' ', color: C.frame }, { ch: ' ', color: C.frame });
      }
      out.push({ kind: 'table', spans: toSpans(chs) });
    }
  };
  emit(all[0]!, C.inkHi);
  const rule: Ch[] = [];
  widths.forEach((cw, i) => { for (let p = 0; p < cw; p++) rule.push({ ch: '─', color: C.frame }); if (i < ncol - 1) rule.push({ ch: ' ', color: C.frame }, { ch: ' ', color: C.frame }); });
  out.push({ kind: 'table', spans: toSpans(rule) });
  for (const r of all.slice(1)) emit(r, C.ink);
  return out;
}

export function renderMd(text: string, width: number): MdLine[] {
  const out: MdLine[] = [];
  let inCode = false;
  const w = Math.max(8, width);
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*```/.test(raw)) { inCode = !inCode; continue; }
    if (!inCode && raw.trim().startsWith('|') && i + 1 < lines.length && isSep(lines[i + 1]!)) {
      const body: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.trim().startsWith('|')) { body.push(cells(lines[j]!)); j++; }
      out.push(...table(cells(raw), body, w));
      i = j - 1;
      continue;
    }
    if (inCode) {
      const chs: Ch[] = [{ ch: G.v, color: C.frame }, { ch: ' ', color: C.frame }, ...[...raw].map((ch) => ({ ch, color: C.quiet }))];
      out.push({ kind: 'code', spans: toSpans(chs.length > w ? [...chs.slice(0, w - 1), { ch: '…', color: C.frame }] : chs) });
      continue;
    }
    if (!raw.trim()) { if (out.length && out[out.length - 1]!.kind !== 'blank') out.push({ kind: 'blank', spans: [] }); continue; }
    if (/^\s*([-*_]\s*){3,}$/.test(raw)) { out.push({ kind: 'hr', spans: [{ text: '─'.repeat(Math.min(w, 40)), color: C.frame }] }); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      const color = strong(h[1]!.length <= 2 ? C.inkHi : C.ink);
      for (const l of wrapChs(inline(h[2]!.replace(/\s+#+$/, ''), color), w, [], [])) out.push({ kind: 'h', spans: toSpans(l) });
      continue;
    }
    const li = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) {
      const depth = Math.floor(li[1]!.length / 2);
      const bullet = /\d/.test(li[2]!) ? li[2]! : '•';
      const prefix: Ch[] = [...' '.repeat(depth * 2)].map((ch) => ({ ch, color: C.ink })).concat([...bullet].map((ch) => ({ ch, color: C.link })), [{ ch: ' ', color: C.ink }]);
      const hang: Ch[] = [...' '.repeat(depth * 2 + bullet.length + 1)].map((ch) => ({ ch, color: C.ink }));
      const lines = wrapChs(inline(li[3]!, C.ink), w, prefix, hang);
      for (const l of lines) out.push({ kind: 'li', spans: toSpans(l) });
      continue;
    }
    const q = /^>\s?(.*)$/.exec(raw);
    if (q) {
      const prefix: Ch[] = [{ ch: '▎', color: C.linkDim }, { ch: ' ', color: C.ink }];
      for (const l of wrapChs(inline(q[1]!, C.quiet), w, prefix, prefix)) out.push({ kind: 'quote', spans: toSpans(l) });
      continue;
    }
    for (const l of wrapChs(inline(raw.trim(), C.ink), w, [], [])) out.push({ kind: 'p', spans: toSpans(l) });
  }
  while (out.length && out[out.length - 1]!.kind === 'blank') out.pop();
  return out;
}

export const plain = (l: MdLine) => l.spans.map((s) => s.text).join('');
