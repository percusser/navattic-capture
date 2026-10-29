# Capturing from a screen recording

Turn the recording into written steps, then run them as usual (steps 2 to 8 of the skill). Run:

- **`GEMINI_API_KEY` is set in `.env`:** `node ${CLAUDE_PLUGIN_ROOT}/video2prompt.mjs <file> --url <app URL>`. Gemini watches the recording and prints the steps; follow them exactly as if the user had written them.
- **No Gemini key:** pull one still per second, `mkdir -p runs/<name>/frames && ffmpeg -loglevel error -i <file> -vf fps=1 runs/<name>/frames/%03d.png`, then read the stills in order and write the steps yourself: each click, each field with the exact text typed into it, and the final screen.

Either way, read a few stills around a step only when that step is unclear.
