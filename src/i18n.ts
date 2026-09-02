/**
 * Two languages, one dictionary. English is the source of truth in the code:
 * every user-facing string is written in English and passed through `t()`.
 * Portuguese (pt-BR) comes from the table below; a missing entry falls back
 * to English, never to a blank. Agent-facing text (prompts, tool descriptions)
 * is English only — the agent answers in whatever language the user writes.
 *
 * Language: `<APP>_LANG=pt|en`, else the system `LANG`/`LC_ALL` (pt* → pt).
 */
export type Lang = 'en' | 'pt';

export function detectLang(env: Record<string, string | undefined> = process.env, appVar = 'ANTHIVE_LANG'): Lang {
  const forced = (env[appVar] ?? '').toLowerCase();
  if (forced.startsWith('pt')) return 'pt';
  if (forced.startsWith('en')) return 'en';
  const sys = (env.LC_ALL || env.LC_MESSAGES || env.LANG || '').toLowerCase();
  return sys.startsWith('pt') ? 'pt' : 'en';
}

export let lang: Lang = detectLang();
export function setLang(l: Lang) { lang = l; }

/** `t('linked to {0}', name)` — placeholders are {0}, {1}… in both languages. */
export function t(key: string, ...args: (string | number)[]): string {
  const s = lang === 'pt' ? (PT[key] ?? key) : key;
  return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) : s;
}

/** Keys with no Portuguese entry — the test keeps this list empty. */
export const missingPt = (keys: Iterable<string>) => [...keys].filter((k) => !(k in PT));

export const PT: Record<string, string> = {};
