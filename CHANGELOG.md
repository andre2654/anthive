# Changelog

## Unreleased

- Subagents on the map: the Agent calls of an agent's current turn hang under it as boxes with the description, what each one is doing (read from the files Claude Code keeps per subagent), tokens so far and state (running, done, failed, background, and silent when nothing was written for ten minutes: the process that ran it is gone). `↵` opens one as a read-only transcript that follows it live; the panel shows its brief. `project_map` lists them.
- Mid-turn guards: `x` and `q` ask before killing a chat that is still answering (naming the live subagents), and `m`/`e`/`p` changes asked mid-turn wait for the answer before the restart, instead of losing the turn and its subagents.
- The map says `approval` only for a permission request that is actually pending (`~/.anthive/approvals`); a tool without its result is `running` with the tool's name, `stuck` after ten minutes. A parent whose subagents are alive counts as running even while its own transcript sleeps.

- Approvals on the map: permission prompts of every agent arrive as a modal (`y` once, `a` always as a remembered rule, `l` allow and link the file, `n` deny); rules and linked files answer by themselves.
- Deep search in the agent chat: `D` / Tab `[deep]` sends a research turn (Explore subagents over the repo, `project_search` over the hive, WebSearch/WebFetch on the web, report saved as a `research:` note); subagent progress streams into the tree.
- `project_search` bus tool: notes, threads and the transcripts of the project's agents, ACL-aware, grouped by source; deep search runs at effort `max`, with no spending cap unless `ANTHIVE_DEEP_BUDGET_USD` is set.
- Fixed: restarting a chat (model/effort/permissions) no longer closes it when the old process exits.

## 0.1.0 — 2026-09-02

First public release.

- Projects screen; project map with agents, notes, files, services, tasks and a browser, linked by pulsing lines.
- Agents are named Claude Code sessions (`claude -p`, stream-json); chat with model/effort/permission switches, thinking, markdown, diffs, right panel (memory, links, tasks).
- Agent bus over MCP: notes with ACL and TTL, agent-to-agent threads with a mandatory goal and a turn budget, project map for agents, untrusted framing for cross-agent content.
- Environment context: `CLAUDE.md` generated with `/init` when missing, linked to every agent.
- Browser: a Chrome owned by Anthive (hidden by default, no Dock icon) shared with the agent over CDP; the page rendered **live inside the terminal** (Kitty graphics, Ghostty), click/scroll/type from the terminal, `o` toggles hidden ⇄ window.
- `anthive doctor`, installer script, MIT.
