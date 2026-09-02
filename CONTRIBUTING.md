# Contributing

Anthive is a Bun + TypeScript TUI with its own renderer (no ncurses, no React). Comments in the code are in Portuguese — pull requests in English or Portuguese are both welcome.

- `bun install` then `bun run dev` runs from source; `bun run build` compiles the single binary.
- `bun run check` (tsc) and `bun run test` must stay green. The suite is hermetic: no network, no API, no Chrome — each test gets its own `ANTHIVE_HOME`.
- Tests that cost something are opt-in: `bun run test:chrome` (real Chrome, free), `bun run test:browser` and `bun run test:chat` (a haiku agent, a few cents).
- Every user-facing string goes through `t('English text')` (`src/i18n.ts`), which keeps them greppable; `test/english.ts` fails if Portuguese sneaks into one.
- Visual changes: capture the real thing with `python3 test/screenshot.py COLS ROWS [keys]` (a pty run of the binary), not a function-level render.
