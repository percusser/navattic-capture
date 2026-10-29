#!/usr/bin/env node
// jev.mjs: jev-browser's CLI on the shared browser, with the decision model picked from .env.
//
// One persistent CLI session ("navattic") stays attached to the shared Chromium over CDP, so every call
// is a fast command against the same tabs as the MCP server. The session opens on first use with
// .env's decider. The session keeps the decider it opened with, so when .env's decider changes, the
// next call closes it and reopens with the new one (the label is kept in .jev-session).
//
//   node jev.mjs tab <url part>          select the newest tab whose url contains <url part>
//   node jev.mjs shift "<description>"   decision model locates the element, then a Shift+click (a capture)
//   node jev.mjs click "<description>"   same, plain click (no capture)
//   node jev.mjs type "<description>" "<text>" [--submit] [--no-capture]   locate a field, Shift+click it (a capture), type
//   node jev.mjs capture                 Control+c on the page (a capture with no click)
//   node jev.mjs bar                     capture counter and the Finish button's ref
//   node jev.mjs finish [--build [--copilot "<option>" | --no-copilot]]   close the captures dialog (default) or build the demo
//   node jev.mjs find "<name>" ... [--near N]   elements whose name contains a term (*), with N neighbours each side
//   node jev.mjs settle [--max N]        wait until the page stops changing (default up to 4 s)
//   node jev.mjs wait <seconds>
//   node jev.mjs close                   end the CLI session (the browser keeps running)
//   node jev.mjs <any jev-browser command> [args]   passed through, e.g. snapshot --exclude main
//
// Chain steps in one Bash call with &&: each command exits nonzero on failure, so the chain stops there.
// Output is one short line per command; a failure prints the jev-browser error.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDecider, JEV_VARS, HOME } from './decider.mjs';

const ROOT = HOME;
const CLI = join(process.env.JEV_DIR || join(ROOT, 'jev-browser'), 'dist', 'cli.js');
const SESSION = 'navattic';
// Snapshot options that keep the Navattic capture bar (an extension iframe) in view on any app: leave out the
// common page landmarks, and raise the limits so a text-heavy page without landmarks can't push the bar's texts out.
const BAR_ONLY = [...['main', 'nav', 'header', 'aside'].flatMap(s => ['--exclude', s]), '--max-texts', '2000', '--max-elements', '1000'];

const env = { ...process.env };
for (const k of JEV_VARS) delete env[k];
let decider = 'none';
if (env.DECIDER !== 'none') {
  try { const d = resolveDecider(); Object.assign(env, d.jevEnv); decider = d.label; } catch (e) { fail(e.message); }
}
// Lowest locate confidence to act on. Cloudflare's Clef picks the right element with confidences around 0.2-0.4
// (Jev and OpenRouter's decider give 0.7-1.0 for the same picks), so it gets its own bar. LOCATE_MIN_CONFIDENCE overrides.
const MIN_CONFIDENCE = Number(process.env.LOCATE_MIN_CONFIDENCE) || (decider.startsWith('cloudflare/') ? 0.15 : 0.7);
const STAMP = join(ROOT, '.jev-session');
let stamp = '';
try { stamp = readFileSync(STAMP, 'utf8'); } catch {}
if (stamp !== decider) {
  spawnSync(process.execPath, [CLI, 'close', '--session', SESSION], { cwd: ROOT, env });
  writeFileSync(STAMP, decider);
}

function fail(msg) { console.error(`FAIL ${msg}`); process.exit(1); }

function jev(...args) {
  return jevTry(...args, { soft: false });
}

// soft: return the error object instead of failing, so a caller can retry.
function jevTry(...a) {
  const { soft } = a.pop(), args = a;
  // cwd matters: jev-browser scopes session names to the working directory.
  const r = spawnSync(process.execPath, [CLI, ...args, '--session', SESSION], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  let out;
  try { out = JSON.parse(r.stdout); } catch { fail(`${args[0]}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`); }
  if (out.ok === false && out.error?.code === 'SESSION_NOT_FOUND' && args[0] !== 'open' && args[0] !== 'close') {
    const o = spawnSync(process.execPath, [CLI, 'open', '--options-file', join(ROOT, 'opts.json'), '--session', SESSION], { cwd: ROOT, env, encoding: 'utf8' });
    if (!/"ok":true/.test(o.stdout)) fail(`open: ${(o.stdout || o.stderr).trim().slice(0, 300)}`);
    return jevTry(...args, { soft });
  }
  if (out.ok === false && soft) return { error: out.error };
  if (out.ok === false) fail(`${args[0]}: ${out.error?.code} ${out.error?.message}`);
  return out.result ?? out;
}

const call = (cmd, a) => jev(cmd, '--args', JSON.stringify(a));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function locate(description) {
  if (decider === 'none') fail(`no decision model (DECIDER=none), so nothing can locate "${description}": use find and act on the ref`);
  // A page still re-rendering after the last action gives STALE_TARGET; it settles within a moment, so retry once.
  const ask = () => jevTry('semantic_locate', '--args', JSON.stringify({ description, minConfidence: MIN_CONFIDENCE }), { soft: true });
  let r = ask();
  if (r.error?.code === 'STALE_TARGET') { spawnSync('sleep', ['1']); r = ask(); }
  // A rate limit or brief outage at the decision model's provider (HTTP 429, 5xx) usually clears in a moment.
  if (r.error?.code === 'PROVIDER_ERROR' && r.error.retryable) { console.error(`provider: ${r.error.message} Retrying in 2s.`); spawnSync('sleep', ['2']); r = ask(); }
  if (r.error) fail(`semantic_locate: ${r.error.code} ${r.error.message}`);
  return { ref: r.ref, conf: r.confidence.toFixed(2), role: r.evidence?.role, name: r.evidence?.text, what: `${r.evidence?.role ?? ''} "${r.evidence?.text ?? ''}"` };
}

function counter(snap) {
  const t = snap.texts.filter(x => x.frame > 0);
  const i = t.findIndex((x, k) => x.text === 'Capture' && t[k + 1]?.text === 'Finish');
  return i > 0 && /^\d+$/.test(t[i - 1].text) ? Number(t[i - 1].text) : null;
}

// The captures taken so far this run. Navattic counts a capture a moment after it is taken, so the bar's counter can
// still be catching up with the last Shift+click; this is what it will read once every capture has landed. `tab` sets
// it from the bar, each Shift+click and Control+c adds one.
const TAKEN = join(ROOT, '.jev-captures');
const taken = () => { try { const n = Number(readFileSync(TAKEN, 'utf8')); return Number.isInteger(n) ? n : null; } catch { return null; } };
const setTaken = n => writeFileSync(TAKEN, String(n));

// A page's shape for `settle`: url, controls and text count.
const sig = s => `${s.url}|${s.elements.length}|${s.texts.length}|${s.elements.map(e => e.role + e.name).join(',')}`;
const BEFORE = join(ROOT, '.jev-before');

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'tab': {
    const { tabs } = call('tabs', { action: 'list' });
    const matches = tabs.filter(t => t.url.includes(rest[0] ?? '')).reverse();
    if (!matches.length) fail(`no tab url contains "${rest[0]}". Tabs: ${tabs.map(t => t.url).join(' | ')}`);
    // Earlier runs leave tabs with the same url; the capture tab is the newest one showing the capture bar.
    let tab = matches[0];
    if (matches.length > 1) for (const t of matches) {
      call('tabs', { action: 'select', index: t.index });
      if (counter(jev("snapshot", ...BAR_ONLY)) != null) { tab = t; break; }
    }
    if (!tab.selected || matches.length > 1) call('tabs', { action: 'select', index: tab.index });
    const n = counter(jev('snapshot', ...BAR_ONLY));
    if (n != null) setTaken(n);
    console.log(`tab ${tab.index} ${tab.url}  (decider ${decider})`);
    break;
  }
  case 'shift': case 'click': {
    // What the page looked like before the click, so `settle` can wait for the click to change it. Taken before the
    // locate: a snapshot expires the refs of earlier ones.
    writeFileSync(BEFORE, sig(jev('snapshot')));
    const l = locate(rest.join(' '));
    call('click', { target: l.ref, element: rest.join(' '), ...(cmd === 'shift' && { modifiers: ['Shift'] }) });
    if (cmd === 'shift' && taken() != null) setTaken(taken() + 1);
    console.log(`${cmd === 'shift' ? 'shift+clicked' : 'clicked'} ${l.what} (confidence ${l.conf})`);
    break;
  }
  case 'type': {
    // A typing step is its own demo step: Shift+click the field first (a capture, hotspot on the field), then type.
    const submit = rest.includes('--submit'), quiet = rest.includes('--no-capture');
    const [description, text] = rest.filter(x => x !== '--submit' && x !== '--no-capture');
    // Read the counter before locating (a snapshot expires the refs of earlier ones), for when `tab` didn't set TAKEN.
    const before = quiet ? null : taken() ?? counter(jev('snapshot', ...BAR_ONLY));
    const l = locate(description);
    let note = '';
    if (!quiet) {
      // Navattic takes its screenshot a moment after the click (the counter moves ~1.4 s later), so typing right away
      // lands in the capture. Wait until the counter shows this capture too, not just the previous click's, so it
      // shows the empty field.
      call('click', { target: l.ref, element: description, modifiers: ['Shift'] });
      if (before != null) {
        const want = before + 1;
        let n = null;
        for (const end = Date.now() + 6000; Date.now() < end;) {
          n = counter(jev('snapshot', ...BAR_ONLY));
          if (n != null && n >= want) break;
        }
        if (n != null && n >= want) await sleep(250);
        else note = ` (counter ${n ?? 'not shown'}, expected ${want}: a capture may be missing)`;
        setTaken(n != null && n < want ? n : want);
      }
    }
    // The counter snapshots expired l.ref, so find the field again by its role and name. Focus is no fallback to wait
    // on: the Shift+click usually leaves the field focused, but Navattic's capture sometimes takes it (a 30 s timeout).
    // An unnamed field, or a name two fields share, falls back to the focused element.
    const targets = quiet ? [l.ref] : [...(l.role && l.name ? [`internal:role=${l.role}[name=${JSON.stringify(l.name)}s]`] : []), ':focus'];
    let r;
    for (const target of targets) {
      r = jevTry('type', '--args', JSON.stringify({ target, element: description, text, ...(submit && { submit: true }) }), '--timeout-ms', '5000', { soft: true });
      if (!r.error) break;
    }
    if (r.error) fail(`type: ${r.error.code} ${r.error.message}`);
    console.log(`${quiet ? '' : 'shift+clicked and '}typed into ${l.what} (confidence ${l.conf})${submit ? ', pressed Enter' : ''}${note}`);
    break;
  }
  case 'capture':
    call('press_key', { key: 'Control+c' });
    if (taken() != null) setTaken(taken() + 1);
    console.log('pressed Control+c');
    break;
  case 'bar': {
    // The bar drops out for a moment while the page re-renders (right after a Save, say): look again for up to 5 s.
    let s = jev('snapshot', ...BAR_ONLY);
    for (const end = Date.now() + 5000; counter(s) == null && Date.now() < end;) { await sleep(500); s = jev('snapshot', ...BAR_ONLY); }
    const finish = s.elements.find(e => e.name === 'Finish' && e.frame > 0);
    console.log(`counter ${counter(s) ?? 'not shown (capture bar missing)'}${finish ? `  finish ${finish.id}` : ''}`);
    break;
  }
  case 'finish': {
    // Finish on the capture bar, then answer the "Select your captures" dialog. By default close it with its X: the
    // captures stay, no demo is built. --build presses "Build demo"; with --copilot "<option>" it first picks that
    // option in Copilot's "Generate demo content for" dropdown, with --no-copilot it turns Copilot off.
    // The counter lags the last capture by a few seconds, so wait until it holds still before pressing Finish.
    let s, count, last;
    for (const end = Date.now() + 15_000; ; await sleep(1000)) {
      s = jev('snapshot', ...BAR_ONLY);
      count = counter(s);
      if (count !== null && count === last || Date.now() > end) break;
      last = count;
    }
    const finish = s.elements.find(e => e.name === 'Finish' && e.frame > 0);
    if (!finish) fail('no Finish button: the capture bar is not on this tab');
    call('click', { target: finish.id, element: 'Finish' });
    // The dialog first renders "Generating from 0 captures" and fills in the real number after.
    let from, close;
    for (const end = Date.now() + 20_000; ; await sleep(1000)) {
      const tab = call('tabs', { action: 'list' }).tabs.filter(t => t.url.includes('app.navattic.com')).pop();
      if (tab) {
        if (!tab.selected) call('tabs', { action: 'select', index: tab.index });
        const d = jev('snapshot');
        close = d.elements.find(e => e.name === 'Close button');
        from = d.texts.map(t => t.text).find(t => /Generating from \d+ captures?/.test(t));
        if (close && from && !/from 0 /.test(from)) break;
      }
      if (Date.now() > end) { if (close && from) break; fail('the "Select your captures" dialog did not show on the app.navattic.com tab'); }
    }
    const build = rest.includes('--build'), ci = rest.indexOf('--copilot'), copilot = ci >= 0 ? rest[ci + 1] : undefined;
    if (!build) {
      call('click', { target: close.id, element: 'Close button' });
      console.log(`finished: counter ${count}, dialog said "${from}", dialog closed`);
      break;
    }
    const dialog = () => jev('snapshot');
    // The dialog re-renders after each change, so a ref can expire between snapshot and click: retry with a fresh one.
    const press = async (name, pick = els => els.find(e => e.name === name)) => {
      for (let n = 0; ; n++) {
        const e = pick(dialog().elements);
        if (!e) fail(`no "${name}" in the "Select your captures" dialog`);
        const r = jevTry('click', '--args', JSON.stringify({ target: e.id, element: name }), { soft: true });
        if (!r.error) return;
        if (r.error.code !== 'STALE_TARGET' || n >= 4) fail(`click ${name}: ${r.error.code} ${r.error.message}`);
        await sleep(500);
      }
    };
    if (rest.includes('--no-copilot')) {
      const sw = dialog().elements.find(e => e.role === 'switch');
      if (!sw) fail('no Copilot toggle in the "Select your captures" dialog');
      if (sw.checked !== false) await press('Copilot toggle', els => els.find(e => e.role === 'switch'));
    } else if (copilot) {
      // The dropdown is the button right after "Manage", named after the current choice (default "Marketing").
      await press('Copilot content dropdown', els => { const mi = els.findIndex(e => e.name === 'Manage' && e.role === 'button'); return mi >= 0 && els[mi + 1]?.name ? els[mi + 1] : undefined; });
      await sleep(500);
      // Options: Customer Success, Marketing, Product, Sales, plus a "Manage" item for custom ones.
      const opts = dialog().elements.filter(e => /option|menuitem/.test(e.role) && e.name !== 'Manage');
      const pick = opts.find(e => e.name?.trim().toLowerCase() === copilot.toLowerCase()) ?? opts.find(e => e.name?.toLowerCase().includes(copilot.toLowerCase()));
      if (!pick) fail(`no Copilot option "${copilot}". Options: ${opts.map(e => e.name).join(' | ') || '(none found)'}`);
      await press(pick.name, els => els.find(e => /option|menuitem/.test(e.role) && e.name === pick.name));
      await sleep(500);
    }
    await press('Build demo');
    console.log(`finished: counter ${count}, dialog said "${from}", pressed Build demo${copilot ? ` (Copilot: ${copilot})` : rest.includes('--no-copilot') ? ' (Copilot off)' : ''}`);
    break;
  }
  case 'find': {
    // Each match comes with its neighbours in page order (2 either side, --near N for more), because unnamed
    // fields (an input beside an "Add" button) can only be found next to something that has a name.
    const ni = rest.indexOf('--near'), near = ni >= 0 ? Number(rest[ni + 1]) : 2;
    const terms = ni >= 0 ? rest.filter((_, k) => k !== ni && k !== ni + 1) : rest;
    const s = jev('snapshot', '--max-elements', '1000');
    const els = s.elements.filter(e => e.frame === 0);
    const want = terms.map(x => x.toLowerCase());
    const hits = els.flatMap((e, k) => want.some(w => (e.name || '').toLowerCase().includes(w)) ? [k] : []);
    if (!hits.length) fail(`no element named like: ${terms.join(', ')}`);
    const show = new Set(hits.flatMap(k => Array.from({ length: 2 * near + 1 }, (_, d) => k - near + d)).filter(k => k >= 0 && k < els.length));
    let prev = -2;
    for (const k of [...show].sort((a, b) => a - b)) {
      const e = els[k];
      if (k !== prev + 1) console.log('--');
      console.log(`${hits.includes(k) ? '*' : ' '} ${e.id}  ${e.role}  ${e.name ? `"${e.name}"` : '(no name)'}${e.checked !== undefined ? `  checked=${e.checked}` : ''}${e.disabled ? '  disabled' : ''}`);
      prev = k;
    }
    break;
  }
  case 'settle': {
    // Wait until the page stops changing after an action: the same url, controls and text count on
    // two snapshots in a row (each takes ~0.3 s, which is the spacing), with nothing marked aria-busy. A slow page
    // load leaves the old page standing still for a while, so first wait for the page to differ from how it looked
    // before the last click (up to 10 s). Gives up after --max seconds (default 4) once it has changed.
    const mi = rest.indexOf('--max'), max = mi >= 0 ? Number(rest[mi + 1]) : 4;
    let before = null;
    try { before = readFileSync(BEFORE, 'utf8'); unlinkSync(BEFORE); } catch {}
    const start = Date.now();
    let t0 = start, prev, same = 0, changed = before == null;
    for (;;) {
      const snap = jev('snapshot');
      const now = sig(snap);
      if (!changed) {
        if (now !== before) { changed = true; t0 = Date.now(); }
        else if (Date.now() - t0 > 10_000) { console.log('page unchanged 10s after the click, going on'); break; }
        else continue;
      }
      same = now === prev && !snap.busy ? same + 1 : 0;
      prev = now;
      if (same >= 1) { console.log(`settled in ${((Date.now() - start) / 1000).toFixed(1)}s`); break; }
      if (Date.now() - t0 > max * 1000) { console.log(`still changing after ${max}s, going on`); break; }
    }
    break;
  }
  case 'wait':
    await new Promise(r => setTimeout(r, Number(rest[0] ?? 1) * 1000));
    break;
  case undefined:
    fail('usage: see the header of jev.mjs');
  default: {
    call('tabs', { action: 'list' }); // opens the session first when needed
    const r = spawnSync(process.execPath, [CLI, cmd, ...rest, '--session', SESSION], { cwd: ROOT, env, stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
}
