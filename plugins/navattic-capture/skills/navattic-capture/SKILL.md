---
name: navattic-capture
description: Capture interactive Navattic demos of a web app in the shared jev-browser Chromium. Use when asked to capture, record or build a Navattic demo.
---

# Navattic capture

A shared Chromium (CDP :9222) has the Navattic extension loaded. `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs` drives it through jev-browser's CLI: one persistent session, the decision model from `.env`, one short line of output per command. Everything for this lives in ~/navattic-capture; create files only there. Without Bash, use the MCP tools as described in [MCP.md](MCP.md).

## jev.mjs

Chain a step's commands with `&&` in one Bash call: each exits nonzero with a `FAIL …` line on failure, which stops the chain.

- `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs tab <url part>`: select the newest tab whose url contains it.
- `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs shift "<description>"`: the decision model locates the element, then it is Shift+clicked. Prints what was clicked and the confidence.
- `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs type "<description>" "<text>" [--submit]`: locate a field, Shift+click it (a capture), wait until the capture counter goes up so the capture shows the field empty, then type into it; `--submit` presses Enter. `--no-capture` skips the Shift+click.
- `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs capture`: Control+c.
- `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs settle`: waits until the page stops changing (usually 0.5–1.5 s, at most 4 s).
- `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs wait <seconds>`: a fixed wait, for the toast timing in step 6.
- `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs bar`: the capture counter.
- `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs finish`: Finish, then close the "Select your captures" dialog with its X. Prints the counter and the dialog's "Generating from N captures". `--build` presses "Build demo" instead; add `--copilot "<option>"` to pick that option in Copilot's "Generate demo content for" dropdown (Customer Success, Marketing, Product, Sales, or a custom one; it defaults to Marketing), or `--no-copilot` to turn Copilot off.
- `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs find "<name>" ["<name>" ...]`: elements whose name contains a term (marked `*`), each with its two neighbours in page order, with ref, role and checked state. An unnamed field shows as `(no name)` beside the label or button next to it (`find "Add"` finds the text box before an Add button). Act on a ref with `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs call click --args '{"target":"<ref>","modifiers":["Shift"]}'`, then `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs call type --args '{"target":"<ref>","text":"…"}'` for a field.

- Any other jev-browser command runs as `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs call <command> --args '<json>'`, with a ref from `semantic_locate` or `find`: `select_option` for a native dropdown, `hover`, `drag`, `press_key`, `file_upload`. Arguments are listed in `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs --help`.

Write each description as the user's wording plus where the element sits ("the avatar button in the top right of the header"). Locate fails below the decider's confidence bar (0.7; 0.15 for Cloudflare's Clef, whose confidences run low); then use `find` and click the ref, and say so in the report. `find` is also how to read a control's current state when the steps depend on it ("if it is already checked, stop"). Each `find` costs a full-page snapshot, so use it only for those two cases. `find` is the whole fallback: one `find` per failed step, then act on the ref and go on with the chain.

## Captures

A **capture** records one demo step. Exactly two actions take one:

- **Shift+click** (`shift`, and `type` before it types): every click step and every typing step the user describes. It both captures and performs the click, links included. A typing step's capture shows the empty field as the hotspot; the typed text shows in the next capture.
- **Control+c** (`capture`): captures the current screen with no click. The app page has focus after start.mjs and after every Shift+click.

A Shift+click records the screen as it is *at* the click, with the clicked element as the hotspot. The screen that click leads to is not recorded until the next capture. So the result of the last click step only exists once the final Control+c is taken.

Everything else records nothing: the typing itself, plain clicks, reloads, tab switches. Each step is clicked once: a second click on a toggle undoes it. When a step opens a new tab, switch to it with `tab`.

**One action, one capture.** Each capture is taken once and trusted. Before ever repeating one, run `bar`; if the counter hasn't moved, `wait 3` and `bar` again, since it can lag. Repeat only when it still hasn't moved. A second capture of the same screen makes a duplicate step.

**Expected count** = the number of click and typing steps + 1 (final screen), plus 1 more when the first step is neither (see step 4). A dropdown choice is two click steps: open it, pick the option. Work it out before starting, and take every planned capture even when the counter already shows that number.

## Steps

1. **Browser.** `curl -fs http://127.0.0.1:9222/json/version`. If it fails, start it: `bash ${CLAUDE_PLUGIN_ROOT}/browser.sh --background`. If that says the extension or Chromium is missing, run `bash ${CLAUDE_PLUGIN_ROOT}/setup.sh` first (one-time: it downloads jev-browser and the Navattic extension into ~/navattic-capture), then tell the user to add a decision-model key to `~/navattic-capture/.env` and log into Navattic in the browser window, and wait.
2. **Start.** `node ${CLAUDE_PLUGIN_ROOT}/start.mjs <app URL>`. It opens the app, starts Navattic, answers the "Choose a demo" dialog and reloads the tab, ending with the capture bar up at 0. By default it makes a **new demo** named after the app's host and the time. When the user names the demo, add `--new "<name>"`; when they say to add to an existing demo, add `--existing "<name>"`. Its last line is `RESULT {json}`:
   - `ready` (exit 0): go on.
   - `needs_site_access` / `needs_login` (exit 2): relay the message, wait for the user, rerun.
   - `demo_limit` (exit 2): the Navattic account can't make another demo. Tell the user and ask which existing demo to add to, then rerun with `--existing "<name>"`.
   - `setup_failed` (exit 2): the dialog went differently; do it by hand with [DIALOG.md](DIALOG.md).
   - `error` (exit 1): show the user the message and stop. Rerun only with the app URL: without one, start.mjs attaches to whatever tab is newest, which may be an older capture session.
3. **Tab.** `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs tab <app URL path>`, as the first command of the first step's chain. The `ready` result already confirmed the bar at 0.
4. **First capture.** Only when the user's first step is neither a click nor typing (a key press, say): `capture` on the untouched starting screen. Otherwise skip this: the first Shift+click already captures the starting screen.
5. **Demo steps.** Chain consecutive steps into one Bash call, in order: every turn between calls costs seconds, and a failed command stops the chain where it failed. End a call only where the next step depends on what the page shows (a `find` that checks a control's state, a condition in the user's steps). A step that leads to a new page or opens a menu or dropdown is followed by `settle` so the next locate sees the new screen:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/jev.mjs tab <app URL path> && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs shift "…" && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs settle && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs shift "…" && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs settle && …
   ```
   Each typing step is one `type`. For a screen recording instead of written steps, follow [RECORDINGS.md](RECORDINGS.md).
6. **Last capture**, in the same chain as the last click step, since its timing matters. When the user says not to wait for toasts or confirmations, use `settle` in place of `wait 1` below. That holds when that click falls back to a `find` ref too: `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs call click --args '{…Shift…}' && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs wait 1 && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs capture`.
   - **Saved, submitted, sent or deleted something**: the confirmation toast fades in a few seconds and belongs in the demo: `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs shift "…" && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs wait 1 && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs capture`.
   - **Opened a new page**: `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs shift "…" && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs settle && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs capture`.
7. **Finish.** Append `&& node ${CLAUDE_PLUGIN_ROOT}/jev.mjs finish` to the last chain: by default it closes the dialog, keeping the captures without building. When the user asks to build the demo, use `finish --build`; when they name Copilot content ("with Copilot for Sales"), `finish --build --copilot "Sales"`; when they say no Copilot, `finish --build --no-copilot`. It waits for the counter to settle, so no `bar` or extra wait is needed. Compare its counter and "Generating from N captures" with the expected count: lower means a missed capture, higher a duplicate.
8. **Report.** Each step with worked / failed (and any that fell back to `find`), the expected and actual capture counts, and any duplicate.
