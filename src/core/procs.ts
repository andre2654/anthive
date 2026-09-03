/**
 * Which Claude Code sessions have a process behind them right now.
 * Every session is spawned with its id on the command line (--resume or
 * --session-id), so one `ps` answers for all of them: a subagent whose
 * session is gone is an orphan, not a slow one. Cached for a refresh cycle.
 * Tests set ANTHIVE_FAKE_PS to stand in for the `ps` output.
 */
const TTL = 1500;
let at = 0, cached = new Set<string>();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function psOut(): Promise<string> {
  if ('ANTHIVE_FAKE_PS' in process.env) return process.env.ANTHIVE_FAKE_PS ?? '';
  try { return await new Response(Bun.spawn(['ps', '-axww', '-o', 'command'], { stdout: 'pipe', stderr: 'ignore' }).stdout).text(); } catch { return ''; }
}

/** Session ids with a live process. Empty when `ps` cannot be read: nothing is claimed dead on a doubt. */
export async function runningSessions(): Promise<Set<string>> {
  const fake = 'ANTHIVE_FAKE_PS' in process.env;
  if (!fake && Date.now() - at < TTL) return cached;
  const out = await psOut();
  const ids = new Set<string>();
  for (const line of out.split('\n')) {
    if (!/claude/i.test(line)) continue;
    for (const m of line.matchAll(UUID)) ids.add(m[0].toLowerCase());
  }
  if (!fake) { cached = ids; at = Date.now(); }
  return ids;
}

/** True when nothing holds this session — but only if `ps` had something to say. */
export async function sessionGone(sessionId: string): Promise<boolean> {
  const live = await runningSessions();
  return live.size > 0 && !live.has(sessionId.toLowerCase());
}
