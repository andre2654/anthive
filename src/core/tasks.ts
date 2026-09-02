/**
 * As tarefas que o próprio Claude Code mantém (TaskCreate/TaskUpdate),
 * reconstruídas do transcript de cada agente. Cache por tamanho do arquivo:
 * o mapa atualiza a cada 2 s e um transcript pode ter megabytes.
 */
import { Ev, parseSession } from './sessions.ts';

export interface Task { id: string; subject: string; description: string; status: string; active?: string }

export function tasksFrom(evs: Ev[]): Task[] {
  const tasks: Task[] = [];
  for (const e of evs) {
    if (!e.tool || !e.input) continue;
    if (e.tool === 'TaskCreate') tasks.push({ id: String(tasks.length + 1), subject: String(e.input.subject ?? ''), description: String(e.input.description ?? ''), status: 'pending', active: e.input.activeForm ? String(e.input.activeForm) : undefined });
    if (e.tool === 'TaskUpdate') { const t = tasks.find((x) => x.id === String(e.input!.taskId)); if (t && e.input.status) t.status = String(e.input.status); }
  }
  return tasks;
}

const cache = new Map<string, { size: number; tasks: Task[] }>();

/** Tarefas de uma sessão pelo caminho do transcript; só reparseia quando o arquivo cresceu. */
export async function tasksOfSession(path: string, size: number): Promise<Task[]> {
  const hit = cache.get(path);
  if (hit && hit.size === size) return hit.tasks;
  const tasks = tasksFrom(await parseSession(path));
  cache.set(path, { size, tasks });
  return tasks;
}
