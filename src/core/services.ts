/**
 * Serviços = processos escutando porta TCP nesta máquina. Descobertos pelo
 * `lsof`, sem daemon nem permissão especial. Só o que der para provar: pid,
 * porta, comando, diretório. Logs de processo alheio não existem — a tela diz.
 */
export interface Listening { pid: number; command: string; port: number; addr: string; user: string }

/** Parser da saída padrão de `lsof -nP -iTCP -sTCP:LISTEN`. Um pid pode ter várias portas. */
export function parseLsof(text: string): Listening[] {
  const out: Listening[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    // "(LISTEN)" é a última coluna; o endereço:porta vem logo antes
    const name = cols[cols.length - 1] === '(LISTEN)' ? cols[cols.length - 2] : cols[cols.length - 1];
    const m = /^(.*):(\d+)$/.exec(name ?? '');
    if (!m) continue;
    const key = `${cols[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ command: cols[0]!, pid: Number(cols[1]), user: cols[2]!, addr: m[1]!, port: Number(m[2]) });
  }
  return out.sort((a, b) => a.port - b.port);
}

async function run(cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  } catch { return ''; }
}

export async function discover(): Promise<Listening[]> {
  return parseLsof(await run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN']));
}

export interface Stats { cpu: number; mem: number; rssMb: number; elapsed: string; command: string }

export async function stats(pid: number): Promise<Stats | null> {
  const out = (await run(['ps', '-o', '%cpu=,%mem=,rss=,etime=,command=', '-p', String(pid)])).trim();
  if (!out) return null;
  const m = /^\s*([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(out);
  if (!m) return null;
  return { cpu: Number(m[1]), mem: Number(m[2]), rssMb: Math.round(Number(m[3]) / 1024), elapsed: m[4]!, command: m[5]! };
}

export async function cwdOf(pid: number): Promise<string> {
  const out = await run(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const m = /\nn(.+)/.exec(out);
  return m ? m[1]!.trim() : '';
}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Encerrar é a única escrita possível num serviço. Quem chama já confirmou com o usuário. */
export function stop(pid: number, hard = false): boolean {
  try { process.kill(pid, hard ? 'SIGKILL' : 'SIGTERM'); return true; } catch { return false; }
}
