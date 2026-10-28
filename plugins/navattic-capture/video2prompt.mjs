#!/usr/bin/env node
// video2prompt.mjs: Gemini watches a screen recording and writes the navattic-capture prompt for it.
//
//   node video2prompt.mjs recordings/flow.mov --url https://app.example.com
//   node video2prompt.mjs recordings/flow.mov --model gemini-3.1-pro-preview
//
// The key and model come from .env (GEMINI_API_KEY, GEMINI_MODEL; --model overrides). Prints the prompt,
// ready to paste, and saves it to runs/<video name>/prompt.txt. --url sets the start URL when the
// recording doesn't show it. Videos up to ~18 MB go inline; larger ones go through the Files API.

import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { HOME } from './decider.mjs'; // also loads .env into process.env

const ROOT = HOME;
const API = 'https://generativelanguage.googleapis.com';
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const url = flag('--url');
const model = flag('--model') ?? process.env.GEMINI_MODEL ?? 'gemini-3.5-flash';
const video = args[0];
const key = process.env.GEMINI_API_KEY;
if (!video) { console.error('usage: node video2prompt.mjs <video> [--url START_URL] [--model NAME]'); process.exit(1); }
if (!key) { console.error('GEMINI_API_KEY is not set in .env'); process.exit(1); }

const mime = { '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.webm': 'video/webm' }[extname(video).toLowerCase()] ?? 'video/mp4';
const headers = { 'x-goog-api-key': key };

async function videoPart() {
  const size = statSync(video).size;
  if (size < 18e6) return { type: 'video', data: readFileSync(video).toString('base64'), mime_type: mime };
  const start = await fetch(`${API}/upload/v1beta/files`, { method: 'POST', headers: { ...headers,
    'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
    'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: basename(video) } }) });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error(`upload start failed: HTTP ${start.status} ${await start.text()}`);
  const done = await (await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Length': String(size),
    'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: readFileSync(video) })).json();
  let file = done.file;
  while (file.state === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 2000));
    file = await (await fetch(`${API}/v1beta/${file.name}`, { headers })).json();
  }
  if (file.state !== 'ACTIVE') throw new Error(`file processing ended ${file.state}`);
  return { type: 'video', uri: file.uri, mime_type: mime };
}

const instructions = `This is a screen recording of someone clicking through a web app. Write the steps to repeat it, for an agent that will redo them in a live browser.

Rules:
- One numbered step per action, in order: each click, each field typed into, each dropdown choice (opening the dropdown and picking the option are two steps).
- Leave out mouse movement, hovering and scrolling: only actions that change something.
- Name each element by its visible label in double quotes, and say where it is on the screen ("In the left navigation under Learning, click \\"Courses\\"."). For an icon or avatar with no label, describe it.
- For typing, quote the exact text that ends up in the field: Type "..." into the "<label>" field. For a field with no label, use its placeholder text.
- For a checkbox or toggle, say which state it ends in ("check \\"Videos\\"").
- After a step that saves or submits, stop: the agent captures the confirmation itself.

Reply with exactly this and nothing else:
START_URL: <the URL of the first screen if it is visible anywhere (address bar, link previews), else UNKNOWN>
1. ...
2. ...`;

const t0 = Date.now();
const res = await fetch(`${API}/v1beta/interactions`, { method: 'POST',
  headers: { ...headers, 'Api-Revision': '2026-05-20', 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, store: false, input: [await videoPart(), { type: 'text', text: instructions }] }) });
const body = await res.json();
if (!res.ok) { console.error(`Gemini HTTP ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 500)}`); process.exit(1); }
const text = body.steps?.filter(s => s.type === 'model_output').flatMap(s => s.content ?? []).map(c => c.text ?? '').join('').trim();
if (!text) { console.error(`no text in the reply: ${JSON.stringify(body).slice(0, 500)}`); process.exit(1); }

const seen = text.match(/^START_URL:\s*(\S+)/m)?.[1];
const start = url ?? (seen && seen !== 'UNKNOWN' ? seen : '<app URL>');
const steps = text.replace(/^START_URL:.*\n?/m, '').trim();
const prompt = `Use the navattic-capture skill to capture a demo of ${start}\n\nSteps:\n${steps}\n`;

const out = join(ROOT, 'runs', basename(video, extname(video)));
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'prompt.txt'), prompt);
console.log(prompt);
console.error(`(${model}, ${((Date.now() - t0) / 1000).toFixed(1)}s, saved to ${join(out, 'prompt.txt')})`);
