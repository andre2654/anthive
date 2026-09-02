/** Chat real: sobe o claude, manda dois turnos, troca o esforço no meio, confere o .jsonl. */
import { ChatSession, ChatEvent } from '../src/core/chat.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };
const cwd = mkdtempSync(join(tmpdir(), 'tai-chat-'));
const events: ChatEvent[] = [];
const chat = new ChatSession({ cwd, model: 'claude-haiku-4-5-20251001', effort: 'low' }, (e) => events.push(e));

const waitFor = (pred: () => boolean, ms = 60000) => new Promise<boolean>((res) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (pred()) { clearInterval(iv); res(true); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); res(false); }
  }, 100);
});
const results = () => events.filter((e) => e.kind === 'result') as Extract<ChatEvent, { kind: 'result' }>[];

chat.start();
must('envia o primeiro turno', chat.send('responda apenas: um'));
must('fica ocupado enquanto espera', chat.busy);
must('primeiro turno responde', await waitFor(() => results().length === 1));
must('resposta é a esperada', /um/i.test(results()[0]?.text ?? ''));
must('ganhou session id do init', !!chat.sessionId);
must('viu texto do assistente como evento', events.some((e) => e.kind === 'ev' && e.ev.role === 'assistant' && !!e.ev.text));
must('recebeu janela de limite', chat.rate !== null && chat.rate.resetsAt > 0);
must('não está mais ocupado', !chat.busy);

const sid = chat.sessionId!;
chat.restart({ effort: 'medium' });
must('reinício preserva a sessão', chat.sessionId === sid);
must('envia o segundo turno no processo novo', chat.send('agora responda apenas: dois'));
must('segundo turno responde', await waitFor(() => results().length === 2));
must('resposta continua a conversa', /dois/i.test(results()[1]?.text ?? ''));

// o Claude Code resolve symlinks antes de montar o slug (/var → /private/var),
// então procuro o transcript pelo id em todos os projetos, não pelo caminho
const root = join(homedir(), '.claude', 'projects');
const found: string[] = [];
for (const d of await readdir(root)) {
  try { for (const f of await readdir(join(root, d))) if (f === `${sid}.jsonl`) found.push(join(root, d, f)); } catch {}
}
must('um único transcript para os dois turnos', found.length === 1);
const size = found[0] ? (await stat(found[0])).size : 0;
must('transcript no disco com conteúdo', size > 2000);

chat.stop();
must('custo somado é positivo', chat.cost > 0);
console.log(`\ncusto do teste: $${chat.cost.toFixed(4)}`);
console.log(fails ? `${fails} falha(s)` : 'tudo verde');
process.exit(fails ? 1 : 0);
