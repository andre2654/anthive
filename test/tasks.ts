import { tasksFrom } from '../src/core/tasks.ts';
import { Ev } from '../src/core/sessions.ts';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const ev = (tool: string, input: any): Ev => ({ uuid: crypto.randomUUID(), parent: null, sidechain: false, type: 'assistant', ts: 0, role: 'assistant', text: '', tool, input });
const ts = tasksFrom([
  ev('TaskCreate', { subject: 'Corrigir ARBs', description: 'remover ? final', activeForm: 'Corrigindo ARBs' }),
  ev('TaskCreate', { subject: 'Rodar testes', description: '' }),
  ev('TaskUpdate', { taskId: '1', status: 'in_progress' }),
  ev('TaskUpdate', { taskId: '2', status: 'completed' }),
  ev('TaskUpdate', { taskId: '9', status: 'completed' }),
]);
must('duas tasks, ids sequenciais', ts.length === 2 && ts[0]!.id === '1' && ts[1]!.id === '2');
must('estado atualizado pelo TaskUpdate', ts[0]!.status === 'in_progress' && ts[1]!.status === 'completed');
must('descrição e forma ativa preservadas', ts[0]!.description === 'remover ? final' && ts[0]!.active === 'Corrigindo ARBs');
must('update de id inexistente é ignorado', ts.length === 2);
console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
