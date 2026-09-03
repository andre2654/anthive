/** The UI speaks English: no Portuguese left in any user-facing string, and t() formats placeholders. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '../src/i18n.ts';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
must('t() fills placeholders in order', t('edit {0} of {1}', 2, 5) === 'edit 2 of 5' && t('plain') === 'plain' && t('{0}{0}', 'ab') === 'abab');
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
walk('src');
const pt = /[áéíóúãõçêâô]|\b(não|você|ainda|nenhum|nenhuma|ligado|ligada|agente|nota|arquivo|serviço|projeto|página|tarefa|esperando|conversa|objetivo|criada|vazia|ferramenta|desconhecida|confirmar|cancelar)\b/i;
const bad: string[] = [];
for (const f of files) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*(\*|\/\*|\/\/)/.test(line)) return;
    for (const m of code.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
      const s = m[1] ?? m[2] ?? '';
      if (pt.test(s) && !/^[\w\-./:${}]+$/.test(s)) bad.push(`${f}:${i + 1}: ${s.slice(0, 60)}`);
    }
  });
}
must(`no Portuguese in user-facing strings (${files.length} files)`, bad.length === 0);
if (bad.length) console.log('  ' + bad.slice(0, 10).join('\n  '));
console.log(fails ? `\n${fails} failure(s)` : '\nall green'); process.exit(fails ? 1 : 0);
