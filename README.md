<div align="center">

# navattic-capture

**Navattic captures from written steps or a screen recording, taken by Claude.**

![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)
![Node](https://img.shields.io/badge/node-%E2%89%A522.15-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)

[Quick start](#quick-start) · [Screen recordings](#from-a-screen-recording) · [Configuration](#configuration) · [Decision models](#decision-models) · [Benchmarks](#benchmarks)

</div>

---

## Why

To capture a demo by hand, you click each step, wait for each page, and check each capture. When the product changes, you do it all again.

With this plugin, you write the steps or record your screen one time. Claude does the steps in a real browser. It takes one capture for each step.

Each step takes 1 to 2 seconds. A small decision model finds the element for the step, so Claude does not read the full page at each step. A 12-step flow with Claude Haiku took 2:15 without a decision model and 1:02 with one.

Claude controls the browser through the jev-browser CLI, not through an MCP server. An MCP tool sends the full page back to Claude after each action. The CLI sends back one line, and Claude can do many steps in one command. On a 6-step flow, MCP tools took 1:19 and the CLI took 0:45.

## Quick start

1. In Claude Code, add the plugin:

   ```text
   /plugin marketplace add percusser/navattic-capture
   /plugin install navattic-capture@navattic-capture
   ```

2. Start a new Claude Code session.
3. Ask Claude to set up navattic-capture. Claude installs jev-browser, its Chromium, ffmpeg and the Navattic extension into `~/navattic-capture`. Then it opens the browser.
4. Get a TypeSafe API key at [console.typesafe.ai/keys](https://console.typesafe.ai/keys). Put it in `~/navattic-capture/.env` as `TYPESAFE_API_KEY`.
5. In the browser window, log in to Navattic and to your app. The browser keeps your logins, so you do this only one time.
6. Ask Claude for a capture:

   ```text
   Use the navattic-capture skill to capture a demo of https://app.example.com/reports

   Steps:
   1. Click the "New report" button in the top right.
   2. Type "Q4 pipeline" into the "Report name" field.
   3. Open the "Owner" dropdown and pick "Sales".
   4. Click "Save".
   ```

Claude does the steps and reports each one with the number of captures.

You need Node.js 22.15 or later.

## Writing a prompt

Write one action for each step. Put the element's visible label in quotes, and say where it is on the screen. Claude uses your words to find each element.

By default, Claude makes a new demo and closes the session after **Finish** without building it. To change that, add one of these lines to the prompt:

- **`Name the demo "Q4 Reports".`** The new demo gets that name, not the app's host and the time.
- **`Add the captures to my "Q4 Reports" demo.`** The captures go into that demo, and no new demo is made.
- **`Build the demo.`** After **Finish**, Claude presses **Build demo**.
- **`Build the demo with Copilot for Sales.`** Claude picks that option under Copilot, then builds.
- **`Build the demo without Copilot.`** Claude turns Copilot off, then builds.

## From a screen recording

Record the flow one time, with any screen recorder. Then give Claude the file and the app's URL:

```text
Use the navattic-capture skill to capture a demo from ~/Desktop/reports.mov.
The app is at https://app.example.com/reports.
```

Claude writes the steps from the recording, and then takes the captures.

### Gemini (optional)

Without Gemini, Claude reads the recording as one still image for each second. With Gemini, Gemini watches the full video in one call:

- Gemini can see an action that happens between two stills.
- The recording does not use Claude's context, which matters for a long recording.
- On a 6-step recording, Gemini wrote the steps in 14 seconds.

To use Gemini, put a key from [aistudio.google.com](https://aistudio.google.com/apikey) in `.env` as `GEMINI_API_KEY`. When the key is set, Claude sends each recording to Gemini.

## Configuration

All settings are in `~/navattic-capture/.env`. A setting in your shell overrides the file.

| Setting | Default | Use |
| --- | --- | --- |
| `DECIDER` | `typesafe` | The decision model service: `typesafe`, `openrouter`, `cloudflare` or `custom` |
| `TYPESAFE_API_KEY` | | Your TypeSafe key. Required for the default service. |
| `TYPESAFE_MODEL` | `jev-latest` | The Jev version |
| `DECIDER_OPENROUTER_KEY` | | Your OpenRouter key, for `DECIDER=openrouter` |
| `OPENROUTER_MODEL` | `perplexity/pplx-decider-v1.2` | The OpenRouter model |
| `DECIDER_MODEL` | | Overrides the model of the active service |
| `GEMINI_API_KEY` | | Optional. Gemini writes the steps from a recording. |
| `GEMINI_MODEL` | `gemini-3.5-flash` | The Gemini model |
| `CDP_PORT` | `9222` | The browser's debugging port |

To change the decision model, change `DECIDER` or `DECIDER_MODEL`. The next step uses the new model. To see the active model, ask Claude to run `decider.mjs`.

## Decision models

A decision model does not write text. It reads the state of a page and a question. Then it gives a probability for each possible answer. A call takes 1 to 2 seconds and costs less than one tenth of a cent.

This plugin uses **Jev** from [TypeSafe](https://typesafe.ai) by default. Jev is a System One model: it makes fast, narrow decisions, and the calling code acts on them. It costs $0.042 for one million input tokens, and output is free.

### How a step finds its element

1. jev-browser reads the page's accessibility tree. This tree lists each control with its role and its visible name, for example `button "Save"`.
2. jev-browser sends the tree and your words for the step to the decision model. For example: "the Save button at the top of the form".
3. The decision model gives each control a probability.
4. If the top control has a probability of 0.7 or more, the plugin takes the capture on it. If no control is that high, Claude searches the page by name and selects the control itself.

Without a decision model, Claude must read the page for each step. That takes a full turn and thousands of tokens for each element.

### Other services

| `DECIDER` | Models | Key |
| --- | --- | --- |
| `typesafe` | Jev | [console.typesafe.ai](https://console.typesafe.ai/keys) |
| `openrouter` | liquid/d1-ultra, liquid/d1.1, baseten/elephant-1, microsoft/microsoft-decision-1, openai/gpt-6-luna-decisions, perplexity/pplx-decider-v1.2, perplexity/pplx-decider-flash-v1.2 | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `cloudflare` | clef-flash, clef | A Cloudflare API token with Workers AI access |
| `custom` | Any server that uses the System One API | Set `CUSTOM_URL` |

## How it works

The plugin has three parts:

1. **A Chromium browser** with the Navattic extension. Your logins stay in its profile. Other tools connect to it through Chrome's debugging port.
2. **[jev-browser](https://github.com/tontoko/jev-browser)**, a CLI built on Playwright. It keeps one session open on that browser between commands. It also sends the decision model its questions.
3. **The plugin's scripts and skill.** They run jev-browser with your decision model and tell Claude how to do a capture.

A capture run has four parts:

1. Claude opens your app in the browser.
2. Claude opens the Navattic extension and waits for the capture bar to appear.
3. For each step, the decision model finds the element. Then the plugin takes the capture and does the step.
4. Claude presses **Finish**. Then it builds the demo or closes the session.

> [!WARNING]
> While the browser runs, any program on your computer can control it through the debugging port. Close the browser when you finish.

## Benchmarks

Each setup below ran this prompt five times, with Claude at medium effort:

```text
Use the navattic-capture skill to capture a demo of https://app.builtlms.com/admin-dashboard/
Add it to the existing "Built LMS" demo.

Steps:
1. In the left side navigation, under the Learning section, click "Courses".
2. Click the "Create Course" button in the top corner.
3. Enter the Course Title of "It's a Brand New Jev".
4. Click "Create Course".
5. In the Course Information section, under Short Description, type "This is a short description."
6. Under Full Description, enter "This is a full description for this amazing and wonderful course for testing Jev and Navattic captures together. It is a wonderful wonderful thing."
7. Under Difficulty Level, open the dropdown and choose "Expert".
8. Set Target Audience to "Everyone who loves Jev."
9. Set Prerequisites to "Being able to spell Jev"
10. Set Duration (minutes) to 30.
11. Under Learning objectives, type "Demonstrate through the power of Jev how to automate Navattic captures for efficient demo creation." into the text box, then click "Add".
12. Click the "Save changes" button. A confirmation toast should be in the last capture.
```

"Capturing" is the time from the first capture to the end of the session. "Total" also includes the time Navattic takes to start the capture session.

### Jev compared to no decision model

**Haiku, no decision model**

| Run | Capturing | Total | Claude cost |
| --- | --- | --- | --- |
| 1 | 1:49 | 2:11 | $0.028 |
| 2 | 2:15 | 2:37 | $0.025 |
| 3 | 1:47 | 2:07 | $0.021 |
| 4 | 2:31 | 2:51 | $0.030 |
| 5 | 2:38 | 3:10 | $0.024 |
| **Median** | **2:15** | **2:37** | **$0.025** |

**Haiku + Jev**

| Run | Capturing | Total | Claude cost | Jev cost |
| --- | --- | --- | --- | --- |
| 1 | 1:02 | 1:23 | $0.011 | $0.0065 |
| 2 | 1:02 | 1:23 | $0.010 | $0.0065 |
| 3 | 1:02 | 1:42 | $0.010 | $0.0065 |
| 4 | 0:48 | 1:11 | $0.009 | $0.0065 |
| 5 | 0:44 | 1:14 | $0.010 | $0.0065 |
| **Median** | **1:02** | **1:23** | **$0.010** | **$0.0065** |

**Sonnet, no decision model**

| Run | Capturing | Total | Claude cost |
| --- | --- | --- | --- |
| 1 | 1:16 | 1:42 | $0.197 |
| 2 | 1:21 | 1:40 | $0.248 |
| 3 | 1:06 | 1:23 | $0.190 |
| 4 | 1:26 | 1:45 | $0.218 |
| 5 | 1:25 | 2:30 | $0.247 |
| **Median** | **1:21** | **1:42** | **$0.218** |

**Sonnet + Jev**

| Run | Capturing | Total | Claude cost | Jev cost |
| --- | --- | --- | --- | --- |
| 1 | 0:35 | 1:00 | $0.138 | $0.0065 |
| 2 | 0:52 | 1:13 | $0.145 | $0.0065 |
| 3 | 0:50 | 1:10 | $0.145 | $0.0065 |
| 4 | 2:16 | 2:37 | $0.195 | $0.0065 |
| 5 | 0:53 | 1:12 | $0.139 | $0.0065 |
| **Median** | **0:52** | **1:12** | **$0.145** | **$0.0065** |

### Decision models compared

Each decision model below ran the same prompt twice using Haiku.

| Decision model | Capturing, run 1 | Capturing, run 2 | Cost per run |
| --- | --- | --- | --- |
| liquid/d1-ultra | 0:47 | 0:52 | $0.0055 |
| baseten/elephant-1 | 0:56 | 0:49 | $0.0053 |
| liquid/d1.1 | 1:01 | 0:50 | $0.0027 |
| microsoft/microsoft-decision-1 | 1:02 | 1:00 | $0.0048 |
| openai/gpt-6-luna-decisions | 1:00 | 1:08 | $0.0112 |
| perplexity/pplx-decider-v1.2 | 0:54 | 1:16 | $0.0027 |
| perplexity/pplx-decider-flash-v1.2 | 1:11 | 1:33 | $0.0014 |


## Credits

- [jev-browser](https://github.com/tontoko/jev-browser) by tontoko (Apache-2.0) controls the browser and asks the decision model. Setup downloads it. It is not part of this repository.
- [TypeSafe](https://typesafe.ai) makes Jev.
- [Navattic](https://www.navattic.com) makes the capture extension. Setup downloads it from the Chrome Web Store. This project is not affiliated with Navattic.
