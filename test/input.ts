import { TextInput, Form } from '../src/tui/input.ts';
import { Key } from '../src/tui/screen.ts';

let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const type = (t: TextInput | Form, s: string) => { for (const c of s) t.handle({ k: 'char', c } as Key); };

const t = new TextInput();
type(t, 'nota');
must('digita', t.value === 'nota');
t.handle({ k: 'left' } as Key); t.handle({ k: 'left' } as Key);
type(t, 'XX');
must('insere no meio do cursor', t.value === 'noXXta');
t.handle({ k: 'backspace' } as Key);
must('backspace no cursor', t.value === 'noXta');
t.handle({ k: 'char', c: '\x15' } as Key);
must('ctrl-u corta até o começo', t.value === 'ta');

const acc = new TextInput('idempotência é chave');
must('conta caracteres, não bytes', acc.chars.length === 20 && acc.cursor === 20);
const w = acc.window(8);
must('janela segue o cursor', w.text === 'e chave' || w.text.length === 8);

const wt = new TextInput('uma nota comprida');
wt.handle({ k: 'char', c: '\x17' } as Key);
must('ctrl-w apaga a palavra', wt.value === 'uma nota ');

const f = new Form('nota', [
  { label: 'texto', required: true },
  { label: 'anexar a', options: ['api', 'db', 'ui'] },
]);
must('enter em campo vazio obrigatório não envia', f.handle({ k: 'enter' } as Key) === 'pending' && !!f.error);
type(f, 'idempotência');
must('enter avança de campo', f.handle({ k: 'enter' } as Key) === 'pending' && f.active === 1);
f.handle({ k: 'tab' } as Key);
must('tab completa da lista', f.current.input.value === 'api');
f.handle({ k: 'tab' } as Key);
must('tab cicla as opções', f.current.input.value === 'db');
f.handle({ k: 'tab' } as Key); f.handle({ k: 'tab' } as Key);
must('ciclo dá a volta', f.current.input.value === 'api');
f.handle({ k: 'tab' } as Key);
must('enter no último campo envia', f.handle({ k: 'enter' } as Key) === 'submit');
must('valores saem limpos', f.value(0) === 'idempotência' && f.value(1) === 'db');
must('esc cancela', f.handle({ k: 'esc' } as Key) === 'cancel');

const pf = new Form('t', [{ label: 'turnos', value: '6' }]);
pf.handle({ k: 'char', c: '3' } as Key);
must('valor sugerido é substituído, não acumulado', pf.value(0) === '3');
pf.handle({ k: 'char', c: '0' } as Key);
must('depois da primeira tecla acumula normal', pf.value(0) === '30');

const ef = new Form('t', [{ label: 'turnos', value: '6' }]);
ef.handle({ k: 'backspace' } as Key);
must('editar de propósito não limpa tudo', ef.value(0) === '');

console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
