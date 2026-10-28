#!/usr/bin/env node
// navattic-replay: turn a rough screen recording into Navattic captures.
//
// For each pair of recorded screens (N -> N+1) it snapshots the live page with jev-browser,
// asks an image-capable System One decision model which live element turns screen N into N+1,
// Shift+clicks that element (a trusted click, which Navattic's Click-to-Capture records),
// then asks the model whether the live page now matches screen N+1.
//
// Decision models only choose; they cannot write text. When a step is typing into a form,
// the script stops (status "needs_text") so a person, or Claude Code reading the recorded
// frame, can fill the fields, then resumes with --from-step.
//
// --auto runs without prompts and writes <out>/state.json on every stop, for Claude Code.
//
// Usage: node replay.mjs --video rec.mov [--auto] [--from-step N]
//        node replay.mjs --help

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { resolveDecider, ENV_FILE } from './decider.mjs'; // also loads .env

const HOME = homedir();
// Everything lives under one folder: ~/navattic-capture (override with NAVATTIC_HOME).
const ROOT = process.env.NAVATTIC_HOME || join(HOME, 'navattic-capture');
const expand = p => (p && p.startsWith('~') ? join(HOME, p.slice(1)) : p);

const HELP = `navattic-replay: replay a screen recording as Navattic captures

Input (one of):
  --video FILE            Screen recording (.mov/.mp4). Frames are extracted once with ffmpeg
                          into <out>/frames and reused on later runs (--refresh to redo).
  --frames DIR            Use these frames instead (sorted by file name).

Run control:
  --auto                  No prompts. Stops with a status in <out>/state.json and exit code 2
                          when it needs help (needs_text, low_confidence, mismatch, not_at_start).
  --from-step N           Start at transition N (screen N -> N+1). Default 1.
  --out DIR               Run directory. Default ~/navattic-capture/runs/<video name>
  --refresh               Re-extract frames even if <out>/frames exists.
  --dry-run               Decide and print, never click.
  --frames-only           Extract frames into <out>/frames and exit (no browser, no key).

Decision backend (image-capable System One model):
  Normally set in .env (DECIDER plus that backend's key, model and endpoint); these flags override it.
  --backend NAME          openrouter | typesafe | cloudflare | custom (default: DECIDER from .env)
  --model NAME            Model for that backend (default: its *_MODEL in .env)
  --cf-url URL            Workers AI run URL, e.g.
                          https://api.cloudflare.com/client/v4/accounts/ID/ai/run/@cf/cloudflare/clef
  --endpoint URL          Override the POST URL (any System One-compatible endpoint).
  --image-mode MODE       state | field: images inside "state" (OpenRouter/TypeSafe docs) or a
                          top-level "images" array (Cloudflare). Default field for cloudflare.

Browser:
  --options FILE          jev-browser options file      (default ~/navattic-capture/opts.json). With
                          {"cdpEndpoint": ...} it attaches to the shared browser from browser.sh.
  --jev-dir DIR           jev-browser checkout           (default ~/navattic-capture/jev-browser)
  --tab-url TEXT          Work in the newest tab whose URL contains TEXT (e.g. your app's
                          domain). Default: the newest tab.

Tuning:
  --still SEC             Pause length that marks a screen (default 0.6). Rest the mouse ~1 s
                          on each screen while recording.
  --noise DB              Stillness noise floor (default -70; -60 merges a form before and
                          after typing into one screen)
  --dedupe-psnr N         Drop a pause frame this similar to the previous (default 35;
                          a moved cursor scores ~37, a new screen ~27-33)
  --min-confidence N      Below this, ask (or stop in --auto) before clicking (default 0.6)
  --verify-threshold N    Below this, pause (or stop) after a step          (default 0.5)
  --skip-match N          Skip a step when the live page already matches its after-still this
                          well: a hover or scroll pause, nothing to click   (default 0.85)
  --max-options N         Live elements offered per step                    (default 150)
  --settle-ms N           Wait after each click                             (default 1500)
  --yes                   Interactive only: don't confirm confident clicks
  --no-shift              Plain clicks (Manual Capture mode). Default is Shift+click.
`;

const { values: a } = parseArgs({
  options: {
    video: { type: 'string' }, frames: { type: 'string' },
    auto: { type: 'boolean', default: false }, 'from-step': { type: 'string', default: '1' },
    out: { type: 'string' }, refresh: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false }, 'frames-only': { type: 'boolean', default: false },
    backend: { type: 'string' }, model: { type: 'string' },
    'cf-url': { type: 'string' }, endpoint: { type: 'string' }, 'image-mode': { type: 'string' },
    options: { type: 'string', default: join(ROOT, 'opts.json') },
    'jev-dir': { type: 'string', default: join(ROOT, 'jev-browser') },
    still: { type: 'string', default: '0.6' }, noise: { type: 'string', default: '-70' },
    'tab-url': { type: 'string' },
    'dedupe-psnr': { type: 'string', default: '35' },
    'min-confidence': { type: 'string', default: '0.6' },
    'verify-threshold': { type: 'string', default: '0.5' },
    'skip-match': { type: 'string', default: '0.85' },
    'max-options': { type: 'string', default: '150' },
    'settle-ms': { type: 'string', default: '1500' },
    yes: { type: 'boolean', default: false }, 'no-shift': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (a.help || (!a.video && !a.frames)) { console.log(HELP); process.exit(a.help ? 0 : 1); }

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }
const num = (name, lo = -Infinity, hi = Infinity) => {
  const v = Number(a[name]);
  if (!Number.isFinite(v) || v < lo || v > hi) die(`--${name} must be a number in [${lo}, ${hi}]`);
  return v;
};
const cfg = {
  still: num('still', 0.1, 10), noise: num('noise', -120, 0), dedupePsnr: num('dedupe-psnr', 10, 100),
  minConf: num('min-confidence', 0, 1), verifyThr: num('verify-threshold', 0, 1), skipMatch: num('skip-match', 0, 1),
  maxOptions: Math.floor(num('max-options', 2, 250)), settleMs: Math.floor(num('settle-ms', 0)),
  fromStep: Math.floor(num('from-step', 1)),
  shift: !a['no-shift'], yes: a.yes, dry: a['dry-run'], auto: a.auto,
};

// ---------- decision backend ----------
const backend = (() => {
  if (a['frames-only']) return { name: 'none', imageMode: 'state' };
  let d; try { d = resolveDecider(a.backend, { model: a.model, cfUrl: a['cf-url'] }); } catch (e) { die(e.message); }
  if (d.missing && !(a.endpoint && d.missing !== 'CLOUDFLARE_API_TOKEN')) die(`set ${d.missing} in ${ENV_FILE}`);
  return { ...d, url: a.endpoint ?? d.url, imageMode: a['image-mode'] ?? d.imageMode };
})();
if (!['state', 'field'].includes(backend.imageMode)) die('--image-mode must be state or field');

async function decide(text, images, questions) {
  const dataUrls = images.map(buf => `data:image/jpeg;base64,${buf.toString('base64')}`);
  const body = { model: backend.model, questions };
  if (backend.imageMode === 'state') body.state = [text, ...dataUrls.map(url => ({ type: 'image_url', image_url: { url } }))];
  else { body.state = text; body.images = dataUrls; }
  const started = performance.now();
  const res = await fetch(backend.url, {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { 'content-type': 'application/json', ...(backend.key ? { authorization: `Bearer ${backend.key}` } : {}) },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json; try { json = JSON.parse(raw); } catch { json = undefined; }
  if (!res.ok || !json || json.success === false) throw new Error(`decision HTTP ${res.status}: ${raw.slice(0, 400)}`);
  const env = json.answers ? json : json.result; // Workers AI wraps the answer in `result`
  if (!env?.answers) throw new Error(`decision returned no answers: ${raw.slice(0, 400)}`);
  return { answers: env.answers, ms: Math.round(performance.now() - started) };
}
const choiceConfidence = ans => (typeof ans?.confidence === 'number' ? ans.confidence : ans?.probabilities?.[ans?.choice]);
const topChoices = (ans, n = 3) => Object.entries(ans?.probabilities ?? {}).sort((x, y) => y[1] - x[1]).slice(0, n);

// ---------- run directory and frames ----------
const runName = a.video ? basename(a.video, extname(a.video)) : basename(resolve(expand(a.frames)));
const outDir = resolve(expand(a.out ?? join(ROOT, 'runs', runName)));
mkdirSync(outDir, { recursive: true });
const reportFile = join(outDir, 'report.jsonl');
const stateFile = join(outDir, 'state.json');
const log = rec => appendFileSync(reportFile, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n');

let frameDir;
if (a.frames) frameDir = resolve(expand(a.frames));
else {
  const video = resolve(expand(a.video));
  if (!existsSync(video)) die(`no such video: ${video}`);
  frameDir = join(outDir, 'frames');
  const have = existsSync(frameDir) && readdirSync(frameDir).some(f => /\.(jpe?g|png)$/i.test(f));
  if (!have || a.refresh) {
    if (spawnSync('ffmpeg', ['-version']).status !== 0) die('ffmpeg not found (brew install ffmpeg)');
    rmSync(frameDir, { recursive: true, force: true }); mkdirSync(frameDir, { recursive: true });
    extractStillFrames(video, frameDir);
  }
}
const frames = readdirSync(frameDir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort().map(f => join(frameDir, f));
if (frames.length < 2) die(`need at least 2 frames, found ${frames.length} in ${frameDir} (try a lower --still or --dedupe-psnr)`);
const steps = frames.length - 1;
if (cfg.fromStep > steps) die(`--from-step ${cfg.fromStep} is past the last step (${steps})`);
console.log(`${frames.length} recorded screens (${steps} steps) in ${frameDir}`);
if (a['frames-only']) {
  console.log(`RESULT ${JSON.stringify({ status: 'frames', frames: frameDir, count: frames.length, steps })}`);
  process.exit(0);
}

// One frame per pause in the recording. App screens are mostly static, so ffmpeg's scene score
// barely moves between them (about 0.005); stillness is the reliable signal instead.
function extractStillFrames(video, dir) {
  console.log(`Finding pauses of ${cfg.still}s+ in ${basename(video)}...`);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', video, '-vf',
    `freezedetect=n=${cfg.noise}dB:d=${cfg.still},metadata=mode=print:file=-`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) die(`ffmpeg failed: ${r.stderr.slice(-400)}`);
  const starts = [...r.stdout.matchAll(/freeze_start=([\d.]+)/g)].map(m => Number(m[1]));
  const ends = [...r.stdout.matchAll(/freeze_end=([\d.]+)/g)].map(m => Number(m[1]));
  if (!starts.length) die('no pauses found; hold the mouse still ~1s on each screen, or lower --still');
  const times = starts.map((s, k) => (ends[k] !== undefined ? s + Math.min(0.3, (ends[k] - s) / 2) : s + 0.3));
  // The last click often has no pause after it (the recording stops on its result), so also keep the final frame.
  const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' }).stdout);
  if (dur > times.at(-1) + 0.3) times.push(dur - 0.1);
  let kept = 0, prev;
  for (const t of times) {
    const file = join(dir, `step_${String(kept + 1).padStart(3, '0')}.jpg`);
    const x = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(t), '-i', video, '-frames:v', '1',
      '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', file]);
    if (x.status !== 0 || !existsSync(file)) continue;
    if (prev && psnr(prev, file) > cfg.dedupePsnr) { rmSync(file, { force: true }); continue; }
    prev = file; kept++;
  }
  console.log(`  ${times.length} pauses -> ${kept} distinct screens`);
}
function psnr(x, y) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', x, '-i', y, '-lavfi', '[0][1]scale2ref[p][q];[p][q]psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /average:(inf|[\d.]+)/.exec(r.stderr);
  return !m ? 0 : m[1] === 'inf' ? Infinity : Number(m[1]);
}

// ---------- prompts (interactive mode only) ----------
const rl = createInterface({ input: process.stdin });
const pending = [], waiting = []; let inputClosed = false;
rl.on('line', l => (waiting.length ? waiting.shift()(l) : pending.push(l)));
rl.on('close', () => { inputClosed = true; waiting.splice(0).forEach(w => w('q')); });
const ask = q => {
  process.stdout.write(q);
  if (pending.length) return Promise.resolve(pending.shift());
  if (inputClosed) return Promise.resolve('q'); // closed input never means "click"
  return new Promise(r => waiting.push(r));
};

// ---------- browser ----------
const jevDir = resolve(expand(a['jev-dir']));
const { JevBrowser } = await import(pathToFileURL(join(jevDir, 'dist', 'index.js')).href)
  .catch(e => die(`cannot load jev-browser from ${jevDir}/dist (${e.message})`));
const launchOpts = JSON.parse(readFileSync(resolve(expand(a.options)), 'utf8'));
const attached = !!(launchOpts.cdpEndpoint || launchOpts.wsEndpoint);
const browser = await JevBrowser.launch(launchOpts).catch(e =>
  die(`${e.message}${attached ? '\nIs the shared browser running? Start it with ~/navattic-capture/browser.sh' : ''}`));

// Work in the newest tab whose URL contains --tab-url (or the newest tab), brought to the front:
// a background tab may not render, and its screenshots can time out.
const tabUrl = a['tab-url'];
async function selectNewestTab() {
  const { tabs } = await browser.native({ command: 'tabs', action: 'list' });
  const pool = tabUrl ? tabs.filter(t => t.url.includes(tabUrl)) : tabs;
  if (!pool.length) throw new Error(`no open tab's URL contains "${tabUrl}"`);
  const last = pool[pool.length - 1];
  if (!last.selected) await browser.native({ command: 'tabs', action: 'select', index: last.index });
  await browser.page.bringToFront().catch(() => {});
  return tabs.length;
}
// After a click: follow a tab the click opened; otherwise stay on the current tab.
async function followNewTab(tabsBefore) {
  const { tabs } = await browser.native({ command: 'tabs', action: 'list' });
  if (tabs.length <= tabsBefore) return false;
  const last = tabs[tabs.length - 1];
  if (!last.selected) await browser.native({ command: 'tabs', action: 'select', index: last.index });
  await browser.page.bringToFront().catch(() => {});
  return true;
}
async function settle() {
  await browser.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
  await browser.page.waitForTimeout(cfg.settleMs);
}
const liveShot = () => browser.page.screenshot({ type: 'jpeg', quality: 70 });
const describe = el => [el.role, el.name ? `"${el.name}"` : '', el.inputType ? `type=${el.inputType}` : '',
  el.frame ? `frame ${el.frame}` : '', el.context ? `in: ${el.context}` : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 200);
const elInfo = el => ({ ref: el.id, role: el.role, name: el.name, fillable: !!el.fillable });

async function matches(target) {
  const v = await decide('Image 1 is a recorded target screen. Image 2 is the live browser now.', [target, await liveShot()],
    { match: { type: 'noul', instructions: 'Does image 2 show the same app screen as image 1 (same page and state, ignoring small data differences)?',
      ...(backend.noulCriteria ? { criteria: { true: 'Same screen', false: 'Different screen' } } : {}) } });
  return v.answers.match?.noul;
}

// Every stop goes through here: state.json for Claude Code, a RESULT line, and the exit code.
let finished = false;
function stop(status, fields = {}) {
  const state = { status, steps, frames: frameDir, report: reportFile, ...fields };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  log({ event: 'stop', ...state });
  console.log(`\nRESULT ${JSON.stringify(state)}`);
  finished = true;
  return status === 'done' ? 0 : 2;
}

let exitCode = 0;
try {
  const startFrame = frames[cfg.fromStep - 1];
  if (!attached) await browser.goto('https://app.navattic.com');
  if (!cfg.auto && cfg.fromStep === 1) {
    console.log(`\nIn the browser: open your demo, click Start capturing, and bring the app to the screen matching ${basename(startFrame)}.`);
    if ((await ask('Press Enter when the capture bar is showing on that screen (q to quit)... ')).trim() === 'q') throw new Error('quit');
  }
  await selectNewestTab();
  await settle();
  log({ event: 'start', backend: backend.name, model: backend.model, fromStep: cfg.fromStep, steps, url: browser.page.url() });

  const p0 = await matches(readFileSync(startFrame)).catch(() => undefined);
  if (typeof p0 === 'number' && p0 < cfg.verifyThr) {
    if (cfg.auto) {
      exitCode = stop('not_at_start', { step: cfg.fromStep, expectedFrame: startFrame, match: p0, url: browser.page.url(),
        message: `The live page does not look like ${basename(startFrame)}. Bring the capture tab to that screen, then rerun with --from-step ${cfg.fromStep}.` });
    } else if ((await ask(`Live page doesn't look like ${basename(startFrame)} (match ${p0.toFixed(2)}). Enter=continue, q=quit: `)).trim() === 'q') throw new Error('quit');
  }

  for (let i = cfg.fromStep; i <= steps && !finished; i++) {
    const beforeF = frames[i - 1], afterF = frames[i];
    const before = readFileSync(beforeF), after = readFileSync(afterF);
    await settle();
    // Hover and scroll stills: the live page already looks like the next still, so there is nothing to click.
    // Checked before asking which element was clicked, since that question has no good answer for them.
    const pre = await matches(after).catch(() => undefined);
    if (typeof pre === 'number' && pre >= cfg.skipMatch) {
      console.log(`\nStep ${i}/${steps}: ${basename(beforeF)} -> ${basename(afterF)}\n  live page already matches ${basename(afterF)} (${pre.toFixed(2)}): hover or scroll, skipping`);
      log({ step: i, skipped: 'already_matches', match: pre });
      continue;
    }
    const snap = await browser.snapshot();
    const els = snap.elements.filter(e => !e.disabled).slice(0, cfg.maxOptions);
    const criteria = {
      same: 'Images 1 and 2 show the same screen; nothing happened between them',
      typed: 'No click: the user typed text into a form field (image 2 shows new text in a field)',
      moved: 'No click: only the mouse pointer moved, something is hovered or highlighted, or the page scrolled; same page and content otherwise',
      none: 'None of the listed elements caused the change',
    };
    els.forEach((el, k) => { criteria[`e${k}`] = describe(el); });

    let res;
    try {
      res = await decide(
        'Three screenshots of the same web app. Image 1: a recorded screen BEFORE a user action. Image 2: the recorded screen AFTER it. ' +
        'Image 3: the live browser now, which should match image 1. The options are the interactive elements on the live page (image 3), ' +
        'plus "typed" if the action was typing into a field rather than a click. The mouse pointer in image 1 usually rests on the element about to be clicked.',
        [before, after, await liveShot()],
        { target: { type: 'choice', instructions: 'Which live element did the user click to go from image 1 to image 2 (or "typed")?', criteria } });
    } catch (e) { exitCode = stop('error', { step: i, message: e.message }); break; }

    const ans = res.answers.target;
    let choice = ans?.choice;
    const conf = choiceConfidence(ans);
    if (!choice || !(choice in criteria)) { exitCode = stop('error', { step: i, message: `model returned an unknown option ${JSON.stringify(choice)}` }); break; }
    const alts = topChoices(ans).filter(([k]) => k !== choice);
    console.log(`\nStep ${i}/${steps}: ${basename(beforeF)} -> ${basename(afterF)}  [${res.ms} ms]`);
    console.log(`  pick: ${criteria[choice]}  (confidence ${typeof conf === 'number' ? conf.toFixed(2) : 'n/a'})`);
    alts.forEach(([k, p], n) => console.log(`  alt ${n + 1}: ${criteria[k]}  (${p.toFixed(2)})`));
    const altInfo = alts.map(([k, p]) => ({ option: criteria[k], probability: p, ...(k.startsWith('e') ? elInfo(els[Number(k.slice(1))]) : {}) }));
    const pickEl = choice.startsWith('e') ? els[Number(choice.slice(1))] : undefined;
    log({ step: i, choice, label: criteria[choice], confidence: conf, ms: res.ms, dry: cfg.dry || undefined });
    if (cfg.dry) continue;
    if (choice === 'same' && conf >= cfg.minConf) { console.log('  same screen twice; skipping'); continue; }
    if (choice === 'moved' && conf >= cfg.minConf) { console.log('  hover or scroll only; skipping'); continue; }

    // Typing: decision models can't produce text. Hand the step to a person or Claude Code.
    if (choice === 'typed' || pickEl?.fillable) {
      const fields = els.filter(e => e.fillable).map(elInfo);
      if (cfg.auto) {
        exitCode = stop('needs_text', { step: i, beforeFrame: beforeF, afterFrame: afterF, fields, nextFromStep: i + 1,
          message: `Step ${i} is typing. Read the field values off ${basename(afterF)}, type each into its live field with: node jev.mjs type "<field>" "<text>" (Shift+clicks the field, a capture, then types), then rerun with --from-step ${i + 1}.` });
        break;
      }
      await ask(`  Step ${i} is typing. Fill the fields to match ${basename(afterF)} in the browser, then press Enter... `);
      continue;
    }

    const low = !(conf >= cfg.minConf) || choice === 'none';
    if (low && cfg.auto) {
      exitCode = stop('low_confidence', { step: i, beforeFrame: beforeF, afterFrame: afterF, confidence: conf,
        pick: pickEl ? { option: criteria[choice], ...elInfo(pickEl) } : { option: criteria[choice] }, alternatives: altInfo, nextFromStep: i + 1,
        message: `Not sure which element step ${i} clicks. Compare ${basename(beforeF)} and ${basename(afterF)} with the live page, do the click yourself (Shift+click to capture), then rerun with --from-step ${i + 1}.` });
      break;
    }
    if (!cfg.auto && (low || !cfg.yes)) {
      const reply = (await ask(`  ${low ? 'LOW CONFIDENCE. ' : ''}[Enter]=click pick, 1-3=click alt, m=I'll do it, q=quit: `)).trim().toLowerCase();
      if (reply === 'q') throw new Error('quit');
      if (reply === 'm') { await ask('  Do the step in the browser (Shift+click to capture), then press Enter... '); await selectNewestTab(); continue; }
      if (/^[1-3]$/.test(reply) && alts[Number(reply) - 1]) choice = alts[Number(reply) - 1][0];
      if (!choice.startsWith('e')) { console.log('  That option is not a clickable element; choose another or m.'); i--; continue; }
    }

    const el = els[Number(choice.slice(1))];
    const tabsBefore = (await browser.native({ command: 'tabs', action: 'list' })).tabs.length;
    try {
      await browser.native({ command: 'click', ref: el.id, ...(cfg.shift ? { modifiers: ['Shift'] } : {}) });
    } catch (e) {
      if (cfg.auto) { exitCode = stop('error', { step: i, message: `click failed: ${e.message}`, nextFromStep: i }); break; }
      console.error(`  click failed: ${e.message}`); i--; await ask('  Fix it in the browser, then Enter to retry... '); continue;
    }
    await settle();
    if (await followNewTab(tabsBefore)) console.log('  (switched to the tab the click opened)');

    let p; try { p = await matches(after); } catch (e) { console.error(`  verify failed: ${e.message}`); }
    console.log(`  verify: ${typeof p === 'number' ? p.toFixed(2) : 'n/a'}`);
    log({ step: i, clicked: elInfo(el), shift: cfg.shift, verify: p, url: browser.page.url() });
    if (typeof p === 'number' && p < cfg.verifyThr) {
      if (cfg.auto) {
        exitCode = stop('mismatch', { step: i, clicked: elInfo(el), afterFrame: afterF, match: p, nextFromStep: i + 1, url: browser.page.url(),
          message: `After step ${i} the live page does not look like ${basename(afterF)}. Fix the page to match it, then rerun with --from-step ${i + 1}.` });
        break;
      }
      if ((await ask('  Live page may not match the next recorded screen. Enter=continue, q=quit: ')).trim() === 'q') throw new Error('quit');
    }
  }

  if (!finished) {
    exitCode = stop('done', { lastFrame: frames[frames.length - 1],
      message: `All steps replayed. Take the last capture on the final screen (${basename(frames[frames.length - 1])}): node jev.mjs settle && node jev.mjs capture && node jev.mjs finish.` });
  }
} catch (e) {
  if (e.message !== 'quit') { exitCode = stop('error', { message: e.message }); } else exitCode = 1;
} finally {
  rl.close();
  await browser.close().catch(() => {}); // attached over CDP: disconnects only; the browser stays open
}
process.exit(exitCode);
