# Capturing from a screen recording

Turn the recording into written steps, then run them as usual (steps 2 to 8 of the skill). Run:

`node ${CLAUDE_PLUGIN_ROOT}/video2prompt.mjs <file> --url <app URL>`

Gemini watches the recording and prints the steps; follow them exactly as if the user had written them. Read 3 or 4 stills (`node ${CLAUDE_PLUGIN_ROOT}/replay.mjs --video <file> --frames-only`, then `runs/<name>/frames`) only when a step is unclear.

## Replaying stills (slower, kept for comparison)

`replay.mjs` clicks through the recording's stills itself; it stops on hovers and rate limits, so use it only when asked. 

`node ${CLAUDE_PLUGIN_ROOT}/replay.mjs --video <file> --auto --tab-url <app domain>`

It pulls one still per pause in the recording, plus the recording's last frame. For each pair of stills it first checks whether the live page already looks like the second one (a hover or scroll pause: skipped), and otherwise asks the image-capable decision model which live element was clicked, and Shift+clicks it. Its last line is `RESULT {json}` (also in `<out>/state.json`).

- **done** (exit 0): every click step is captured. Take the last capture and finish: `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs tab <app domain> && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs settle && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs capture && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs finish`.
- **needs_text** (exit 2): the step is typing. Read `afterFrame` (an image), read what was typed into each field, type each with `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs type "<field>" "<text>"`, then rerun with `--from-step <nextFromStep>`.
- **low_confidence** (exit 2): read `beforeFrame` and `afterFrame`. If the second only differs by the pointer, a highlight or scrolling, rerun with `--from-step <nextFromStep>`. Otherwise Shift+click what was clicked with `node ${CLAUDE_PLUGIN_ROOT}/jev.mjs tab <app domain> && node ${CLAUDE_PLUGIN_ROOT}/jev.mjs shift "<what was clicked>"`, then rerun with `--from-step <nextFromStep>` in the same chain.
- **mismatch** (exit 2): the live page doesn't match `afterFrame`. Fix it to match, then rerun with the same `--from-step`.
- **not_at_start** (exit 2): bring the capture tab to the expected frame, then rerun with the same `--from-step`.
- **error** (exit 1): stop and show the user the message.

Expected captures = the recording's clicks and typed fields + 1 final. Read the stills to count them, since hover and scroll stills take none.
