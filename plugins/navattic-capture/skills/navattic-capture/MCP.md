# Capturing with the jev-browser MCP tools

For sessions without Bash (some A/B arms deny it). The capture rules and steps in SKILL.md still hold; this file replaces each `jev.mjs` command with MCP tool calls.

| jev.mjs | MCP tools |
| --- | --- |
| `tab <url part>` | `browser_tabs` `{"action": "list"}`, then `{"action": "select", "index": N}` |
| `shift "<description>"` | `browser_semantic_locate` with `description`, then `browser_click` with `target` = its ref and `modifiers: ["Shift"]` |
| `type "<description>" "<text>" --submit` | `browser_semantic_locate`, then `browser_type` with `target`, `text`, `submit: true` |
| `capture` | `browser_press_key` with `key: "Control+c"` |
| `wait N` | `browser_wait_for` with `time: N` |
| `bar` | **bar snapshot**: `browser_snapshot` with `exclude: ["main", "nav", "header", "aside"]`; the counter is the frame-1 text just before "Capture" and "Finish" |
| `finish` | click "Finish" with its id from a bar snapshot; select the app.navattic.com tab; snapshot; check "Generating from N captures"; click the "Close button" (the X), leaving "Build demo" and "Cancel" alone |
| `find "<name>"` | `browser_snapshot`, then pick the element from `elements` |

**When the semantic tools are denied too**, find each app element in a `browser_snapshot` yourself.

## Call gotchas

Every one of these cost a failed call or a 30-second timeout in past runs:

- `browser_click` and `browser_type` take `target` = a ref from `browser_semantic_locate` or an `r…` element `id` from the latest snapshot. Text ids (`t0_3`) and selectors like `text=Finish` time out after 30 seconds; the Navattic bar and dialogs sit in frame 1 (ids containing `_e1_`), where only `r…` ids reach.
- A ref belongs to the locate or snapshot that produced it. After the page changes, get a fresh one; an old one fails with `STALE_TARGET`. Navattic's own pages re-render a moment after loading, so a `STALE_TARGET` there means: snapshot and click the fresh id.
- `browser_click` scrolls its target into view itself.
- Full snapshots of large pages are too big for the tool result and get saved to a file. Search that file with `node ${CLAUDE_PLUGIN_ROOT}/snap.mjs <file> "<name>"` when Bash is available; otherwise prefer bar snapshots and locate.
- Take a screenshot only when the user wants to see the screen or a snapshot can't settle a question.
