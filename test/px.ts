/** A resposta do terminal ao pedido de tamanho da célula vira tecla 'cellpx', e não vaza como esc. */
import { Screen } from '../src/tui/screen.ts';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const ks = Screen.parse('\x1b[6;18;9t');
must('CSI 6;h;w t vira cellpx com w e h', ks.length === 1 && ks[0]!.k === 'cellpx' && (ks[0] as any).w === 9 && (ks[0] as any).h === 18);
const ks2 = Screen.parse('\x1b[4;900;1600tq');
must('CSI 4;h;w t vira winpx e a tecla seguinte sobrevive', ks2.length === 2 && ks2[0]!.k === 'winpx' && (ks2[0] as any).w === 1600 && ks2[1]!.k === 'char');
const ks3 = Screen.parse('\x1b[<0;10;5M\x1b[A');
must('mouse e setas continuam iguais', ks3.length === 2 && ks3[0]!.k === 'mouse' && ks3[1]!.k === 'up');
console.log(fails ? `${fails} falha(s)` : 'tudo verde'); process.exit(fails ? 1 : 0);
