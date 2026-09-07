/**
 * Acorda um agente que recebeu mensagem e não está rodando.
 *
 * Um worker roda o turno do briefing e para; o maestro escreve na conversa e
 * ninguém lê. Aqui, a chegada de uma mensagem vira um turno em segundo plano
 * na sessão do destinatário, com a instrução de ler a caixa e agir. Um
 * marcador por agente evita acordar duas vezes, e quem já tem processo vivo
 * não é acordado por aqui: a TUI cuida dos chats abertos.
 */
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './store.ts';
import { listProjects, loadGraph, agentHasBrowser, wakeTurn, AgentItem } from './project.ts';
import { sessionGone } from './procs.ts';

export const WAKE_PROMPT =
  'Anthive woke you because a message arrived for you on the bus. Read your inbox with the inbox tool, read the conversation with thread_read, ' +
  'do what it asks in this same turn, answer with thread_post (or thread_conclude when it is settled), and stop. Never leave it for a later turn.';
const WAKES = () => join(ROOT, 'wakes');
const COOLDOWN = 60_000;

/** O agente registrado com esse nome, em qualquer projeto; o mais recente ganha em caso de empate. */
export async function agentByName(name: string): Promise<{ project: string; item: AgentItem } | null> {
  let best: { project: string; item: AgentItem } | null = null;
  for (const p of await listProjects()) {
    const g = await loadGraph(p.id);
    const it = g.items.find((i): i is AgentItem => i.kind === 'agent' && i.name === name && !!i.sessionId);
    if (it && (!best || it.created > best.item.created)) best = { project: p.id, item: it };
  }
  return best;
}

export type Woke = 'woken' | 'live' | 'cooldown' | 'unknown';

/** Acorda `name` para a mensagem mais nova (`newest`, epoch ms). Diz o que fez. */
export async function wakeAgent(name: string, newest = Date.now()): Promise<Woke> {
  const found = await agentByName(name);
  if (!found) return 'unknown';
  const { project, item } = found;
  if (!(await sessionGone(item.sessionId!))) return 'live';
  await mkdir(WAKES(), { recursive: true });
  const marker = join(WAKES(), `${name}.json`);
  const prev = await readFile(marker, 'utf8').then((t) => JSON.parse(t) as { ts: number; for: number }, () => null);
  if (prev && (Date.now() - prev.ts < COOLDOWN || prev.for >= newest)) return 'cooldown';
  await writeFile(marker, JSON.stringify({ ts: Date.now(), for: newest }));
  const browser = await agentHasBrowser(project, item.id).catch(() => false);
  wakeTurn(item, WAKE_PROMPT, browser, `rm -f ${JSON.stringify(marker)}`);
  return 'woken';
}

/** Apaga o marcador: testes e limpeza. */
export const forgetWake = (name: string) => unlink(join(WAKES(), `${name}.json`)).catch(() => {});
