# Changelog

## Unreleased

- The map panel stops repeating the box. For an agent it now shows how long the session has been up, the model and branch, the tokens it burned, its last five tool calls, what it produced and its open tasks, and files it produced are no longer listed twice.
- Agent boxes grow with the screen instead of stopping at 34 columns: wide enough for the whole sentence of what the agent is doing, up to 60, and with three or fewer agents they gain two rows for the last tools and the open tasks. The context reads as a gauge with a percentage, the same measure the panel shows.
- A history strip fills the empty part of the map: the last turns, the subagents that ran and the files that were written, oldest first, with the hour and who did it. It appears only when nothing scrolls, so a busy map is untouched. The wheel now stops at the end of the map instead of scrolling into the void.
- The map shows the work, not only what you registered: the files an agent produced hang off it as nodes, grouped by folder past five, with the folder, the count and who made them. They come from three sources, the write tools, shell redirection (`cat > file`, `tee`, `sed -i`), which is how most real writing happens, and the filesystem for what no tool call names, like a spreadsheet a script wrote. Shell targets only count when the file exists, which turns 61 candidate paths into the 4 real ones on the author's project. `↵` opens the file, `l` pins it to the project as a real file item, `d` refuses. `project_map` lists them.

- The transcript follows the mouse: hovering a message lights the whole block and shows `y copies` at its edge, clicking puts the cursor there, and `y` copies exactly that, flashing it green. With nothing pointed at, `y` takes the agent's last answer, so it always copies something. `Y` still takes the whole turn.
- Selection mode scrolls: `↑↓`, the wheel (alternate scroll while the terminal owns the mouse), `g`, `G`, and page keys, with a counter in the header saying where you are.
- In selection mode the agent's transcript is redrawn plain: no frame, no gutter, no side panel, wrapped to the whole width, so what the terminal copies is the text alone. `y` now copies the message under the cursor and `Y` the whole turn.
- `s` hands the mouse back to the terminal so you can select and copy with it, and freezes the frame while you do (a redraw would move the text under the selection). `s` or `esc` returns. `y` still copies the whole turn under the cursor.

- Subagents on the map: the Agent calls of an agent's current turn hang under it as boxes with the description, what each one is doing (read from the files Claude Code keeps per subagent), tokens so far and state (running, done, failed, background, and silent when nothing was written for ten minutes: the process that ran it is gone). `↵` opens one as a read-only transcript that follows it live; the panel shows its brief. `project_map` lists them.
- The agent's chat shows its subagents: a panel section with state, what each is doing, tokens and how long it has been quiet, and a live row that says how many are working instead of a bare `thinking…`. A subagent composing a long answer writes nothing until it lands, which used to look like a freeze.
- A subagent whose session has no process behind it is marked `orphan` immediately (one `ps` per refresh, matched by session id), instead of looking busy for ten minutes. A running one shows how long it has been quiet once it passes a minute.
- Fixed: opening a subagent's transcript killed the chat that was running it (it looked like switching agents). Watching is read-only now: no input box, the parent's events stay in the parent's tree, and the chat keeps running.
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
