# Anthive

**An ant hive for your Claude Code agents.** A live map of agents, notes, memory, services and a browser — all linked, all in the terminal.

[![ci](https://github.com/andre2654/anthive/actions/workflows/ci.yml/badge.svg)](https://github.com/andre2654/anthive/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/andre2654/anthive?display_name=tag)](https://github.com/andre2654/anthive/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![the project map: agents on the left, notes, files, services and a browser on the right, pulsing links between them](docs/map.png)

Run five Claude Code agents on the same project. See what each one is doing, what it reads, who it talks to. Pin a note to an agent, hand it a file, point it at a service that is running on your machine. Give it a browser and **watch the page render live inside your terminal** — then click on it yourself.

No web app, no Electron, no tmux. One binary, your own Claude subscription.

## Install

macOS (Apple Silicon or Intel). You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in.

```bash
curl -fsSL https://raw.githubusercontent.com/andre2654/anthive/main/install.sh | sh
```

Add `--alias` (`sh -s -- --alias`) to also get `ai` as a shortcut. Then:

```bash
anthive doctor   # what this machine has: Claude Code, Chrome, terminal images…
anthive          # the projects screen
```

From source: `bun install && bun run build` (Bun ≥ 1.3).

For the live browser image you need a terminal that speaks the Kitty graphics protocol: [Ghostty](https://ghostty.org), kitty or WezTerm. Everything else works in any terminal.

## 60-second tour

1. **Projects.** `n` creates one (a name and a directory). `↵` opens it.
2. **The map.** Agents on the left, everything else on the right, links drawn between them. `n` adds an agent, a note, a file, a service running on this machine, a browser, or the project's `CLAUDE.md`. `l` links the selected node to another one. `↵` opens it. `]` toggles the side panel.
3. **An agent** is a named Claude Code session. Open it: a chat with the whole transcript as a tree, markdown, the agent's thinking (`t`), the diffs of every edit (`↵` on an Edit), and a panel with context usage, links and tasks. `m`/`e`/`p` switch model, effort and permission mode mid-session.

   ![the agent chat: the transcript as a tree, tool calls collapsed, browser actions marked, and the panel with memory, links and tasks](docs/chat.png)

4. **A new agent reads the map first.** It gets a briefing of the project — the other agents, notes, files, services — and decides what to link to before touching the request. If the repo has no `CLAUDE.md`, it generates one with `/init` and links it to every agent.
5. **Agents talk to each other** through a small MCP bus: notes with access lists and TTLs, threads with a mandatory goal and a turn budget (only you can extend it), and everything another agent wrote arrives framed as data, not instructions.
6. **The browser.** `n → browser`, link an agent to it, open the chat. The agent gets `browser_*` tools; you get the page.

![the browser screen: the live page drawn inside the terminal, and on the right what the agent sees — the accessibility refs it clicks](docs/browser.png)

## The browser, in detail

Anthive owns the Chrome. It starts a Chrome for Testing (the Playwright one, or your Google Chrome) with a profile of its own and a fixed debugging port. The agent's Playwright MCP does not launch a browser; it connects to that Chrome over CDP. Anthive reads the **same page** over CDP: a screencast drawn into the terminal with the right aspect ratio, plus click, scroll and typing from the terminal.

- **hidden** (default): headless. No window, no Dock icon, nothing steals focus. The page lives in the terminal.
- **window**: `o` switches to a real Chrome window that opens without stealing focus. Same profile, logins kept, the agent reconnects by itself.

The agent is told how to use it: snapshot first (the accessibility tree with refs), refs as selectors, screenshots only for layout, never close the browser on its own — and that the page is shared with you.

## How it works

- **Own renderer.** A character grid with per-cell colors, frame diffing and mouse hit-testing. No curses, no React. The whole UI is ~5k lines of TypeScript on Bun, compiled to one binary.
- **Agents are `claude -p`.** Each agent is a Claude Code process in `stream-json` mode with a fixed session id, so the transcript in `~/.claude/projects` stays the single source of truth. Anthive reads those transcripts for everything it shows: state, context usage, tasks, diffs, browser activity.
- **The bus is MCP.** `anthive mcp` is a JSON-RPC server over stdio that Claude Code loads from the project's `.mcp.json`: `note_write`, `note_read`, `notes_list`, `project_map`, `send_message`, `inbox`, `thread_*`, `agents_list`.
- **The browser is CDP.** `Page.startScreencast` for the picture, `Input.*` for your clicks, `Target.*` to follow the tab the agent is on. PNG frames become Kitty graphics escape sequences; the terminal reports its cell size so the aspect ratio holds and clicks map back to page coordinates.

## What it writes, and where

- `~/.anthive/` — projects, notes, threads, browser profiles. Nothing leaves your machine.
- `<project>/.mcp.json` — the bus (and the browser) registered as MCP servers, so Claude Code loads them. Anthive tells you when it writes it.
- `<project>/.git/info/exclude` — `.playwright-mcp/`, where Playwright drops snapshots and screenshots. Your `.gitignore` is not touched.
- It reads `~/.claude/projects/**` (Claude Code transcripts). Read only.

## Status

0.1, macOS only. Built for one person's daily work and then opened up; expect rough edges. Claude Code's `stream-json` format changes between versions — tested with 2.1.x. Linux is a matter of four shell commands (`open`, `lsof`, `pbcopy`, the Chrome path) and is on the list.

Anthive is an independent project. It is not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic, PBC.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Tests are hermetic (`bun run test`); the ones that need Chrome or an API key are opt-in.

## License

[MIT](LICENSE)
