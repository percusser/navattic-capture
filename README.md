# navattic-capture

A Claude Code plugin that captures Navattic interactive demos. You describe the clicks in plain English, or hand over a screen recording, and Claude drives a browser with the Navattic extension. Each click is a Navattic capture.

A small "decision model" picks each element on the page, so Claude doesn't read the whole page at every step. That keeps runs fast and cheap.

## Requirements

- macOS or Linux
- Node.js 22.15 or newer, plus `git`, `python3` and `curl`
- Claude Code
- A Navattic account
- A key for one decision-model backend, either [OpenRouter](https://openrouter.ai) or [TypeSafe](https://console.typesafe.ai/keys)
- Optional: a [Gemini API key](https://aistudio.google.com/apikey), to turn screen recordings into steps

## Install

In Claude Code:

```text
/plugin marketplace add <github-user>/navattic-capture
/plugin install navattic-capture@navattic-capture
```

Then start a new session.

## First run

1. Ask Claude to capture something (see [Prompts](#prompts)). On the first run it runs `setup.sh`, which downloads everything into `~/navattic-capture`:
   - [jev-browser](https://github.com/tontoko/jev-browser) (Apache-2.0), built from GitHub, plus its Chromium
   - the Navattic extension, from the Chrome Web Store
2. Open `~/navattic-capture/.env` and add your decision-model key. The file explains each backend.
3. In the browser window that opens, log into Navattic. Then log into the app you want to capture.
4. On the first capture, Navattic asks for site access. Click **Enable site access**, then **Allow**.

Claude waits while you do steps 2–4, then carries on. Your logins are saved in `~/navattic-capture/profile`, so this is a one-time setup.

## Prompts

Every choice goes in the prompt. Nothing needs editing between runs.

```text
Use the navattic-capture skill to capture a demo of https://app.example.com/dashboard

Steps:
1. In the left navigation, click "Reports".
2. Click "New report".
3. Type "Q4 pipeline" into the "Name" field.
4. Click "Save".
```

These optional phrases change what happens:

| Say in the prompt | What happens | If you say nothing |
| --- | --- | --- |
| "call the demo Onboarding" | Creates a new demo named Onboarding | Creates a new demo named after the app and the time |
| "add to the Sales Tour demo" | Adds the captures to an existing demo | |
| "build the demo" | Presses **Build demo** at the end | Closes the dialog; the captures are kept and nothing is built |
| "build it with Copilot for Sales" | Builds with Copilot set to Sales (or Customer Success, Marketing, Product, or a custom option) | |
| "build it without Copilot" | Builds with Copilot turned off | |
| "don't wait for toasts" | Takes the last capture as soon as the page settles | Waits a second so a "Saved" toast shows up in the last capture |

Free Navattic accounts can't create more demos, so say which existing demo to add to.

### From a screen recording

1. Record the click-through with Cmd+Shift+5.
2. Put `GEMINI_API_KEY` in `~/navattic-capture/.env`.
3. Ask Claude: `Use the navattic-capture skill to capture a demo from ~/Desktop/flow.mov, the app is at https://app.example.com`

Gemini watches the recording and writes out the steps, and Claude runs them as above.

## Where things live

- **The plugin's code** lives in Claude Code's plugin folder. It is replaced on every update.
- **Your data** lives in `~/navattic-capture`:
  - `.env`, your keys
  - `profile/`, your browser logins
  - `jev-browser/` and `extension/`
  - `runs/`
  
  Updating or uninstalling the plugin doesn't touch this folder.
- **Update the Navattic extension:** quit the browser, then run `bash <plugin folder>/setup.sh --update-extension`. Or ask Claude to do it.
- **Remove everything:** uninstall the plugin, then delete `~/navattic-capture`.
