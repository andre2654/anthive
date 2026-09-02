/**
 * English only. `t()` is just the string formatter every user-facing text
 * goes through: `t('edit {0} of {1}', i, n)`. Keeping one door for all UI
 * text keeps it greppable (and translatable later, if it ever comes to that).
 */
export function t(key: string, ...args: (string | number)[]): string {
  return args.length ? key.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) : key;
}
