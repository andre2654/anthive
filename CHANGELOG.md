# Changelog

## 0.1.0 — 2026-09-02

First public release.

- Projects screen; project map with agents, notes, files, services, tasks and a browser, linked by pulsing lines.
- Agents are named Claude Code sessions (`claude -p`, stream-json); chat with model/effort/permission switches, thinking, markdown, diffs, right panel (memory, links, tasks).
- Agent bus over MCP: notes with ACL and TTL, agent-to-agent threads with a mandatory goal and a turn budget, project map for agents, untrusted framing for cross-agent content.
- Environment context: `CLAUDE.md` generated with `/init` when missing, linked to every agent.
- Browser: a Chrome owned by Anthive (hidden by default, no Dock icon) shared with the agent over CDP; the page rendered **live inside the terminal** (Kitty graphics, Ghostty), click/scroll/type from the terminal, `o` toggles hidden ⇄ window.
- `anthive doctor`, installer script, MIT.
