#!/usr/bin/env node
// start.mjs: start a Navattic capture session on your app, without going through Navattic's dashboard.
//
// Opens the URL in the shared browser (or uses the newest tab), brings it to the front and presses
// the Navattic toolbar button through Chrome's debugging protocol (Extensions.triggerAction).
// That is the same as clicking the extension icon on your app: Navattic starts capturing there.
//
//   node ~/navattic-capture/start.mjs https://app.example.com/dashboard
//   node ~/navattic-capture/start.mjs            # press the button on the newest tab
//   node ~/navattic-capture/start.mjs URL --no-setup   # only press the button
//   node ~/navattic-capture/start.mjs URL --new "Onboarding tour"      # new demo with this name
//   node ~/navattic-capture/start.mjs URL --existing "Built LMS"       # add to an existing demo
//
// Then it answers Navattic's "Choose a demo" dialog (by default a new demo named after the app's host and
// the time; Web capture; Click to capture off; Start capturing), waits for the capture bar to come back from
// Navattic's own reload, and reloads the tab only if it doesn't. It finishes with the capture bar up at 0.
//
// Exit 0 = capture bar ready (or, with --no-setup, button pressed). Exit 2 = Navattic needs you first
// (login or site access), or the dialog didn't go as expected; the message says what.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional settings and keys from .env next to this script; variables already in the shell win.
const ROOT = process.env.NAVATTIC_HOME || join(homedir(), 'navattic-capture');
try { process.loadEnvFile(join(ROOT, '.env')); } catch {}
const PORT = process.env.CDP_PORT || '9222';
const EXT_ID = 'lbecioncobbndebbfdopnpinnibemoon';
const args = process.argv.slice(2);
const setup = !args.includes('--no-setup');
const opt = n => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const EXISTING = opt('--existing');
const NEW_NAME = opt('--new');
const url = args.find(x => !x.startsWith('--'));
const stamp = () => new Date().toLocaleString('sv').slice(0, 16);
const DEMO = EXISTING ?? NEW_NAME ?? (url ? `${new URL(url).host} ${stamp()}` : `Demo ${stamp()}`);
// Navattic's dialog and capture bar live in an extension iframe. On text-heavy pages a full snapshot hits its
// text limit and drops the iframe's texts, so leave the common page landmarks out and raise the limits for
// apps without landmarks.
const NAVATTIC_ONLY = { exclude: ['main', 'nav', 'header', 'aside'], maxTexts: 2000, maxElements: 1000 };
const done = (status, message, extra = {}) => {
  console.log(`RESULT ${JSON.stringify({ status, message, ...extra })}`);
  process.exit(status === 'started' || status === 'ready' ? 0 : status === 'error' ? 1 : 2);
};

const { chromium } = await import(pathToFileURL(join(ROOT, 'jev-browser', 'node_modules', 'playwright-core', 'index.mjs')).href)
  .catch(e => done('error', `cannot load playwright-core from ${ROOT}/jev-browser (${e.message})`));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  .catch(() => done('error', 'The shared browser is not running. Start it with ~/navattic-capture/browser.sh'));

try {
  const ctx = browser.contexts()[0];
  let page;
  if (url) {
    page = await ctx.newPage();
    // ERR_ABORTED can mean a redirect or a script replaced the navigation while the page still loads,
    // so judge by where the tab ended up. On a real failure, close the tab instead of leaving about:blank.
    const err = await page.goto(url, { waitUntil: 'load', timeout: 45_000 }).then(() => null, e => e);
    if (err) {
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
      if (new URL(page.url()).origin !== 'null' && page.url().startsWith(new URL(url).origin)) console.error(`(goto reported ${err.message.split('\n')[0]}, but the tab is on ${page.url()}; continuing)`);
      else { await page.close().catch(() => {}); done('error', `Could not open ${url}: ${err.message.split('\n')[0]}`); }
    }
  } else {
    const pages = ctx.pages().filter(p => /^https?:/.test(p.url()));
    page = pages[pages.length - 1];
    if (!page) done('error', 'No http(s) tab is open. Pass the app URL.');
  }
  await page.bringToFront();
  await page.waitForTimeout(500);

  const cdp = await browser.newBrowserCDPSession();
  const before = new Set((await cdp.send('Target.getTargets')).targetInfos.map(t => t.targetId));
  const { targetInfos: tabs } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const here = page.url();
  const tab = tabs.filter(t => t.type === 'tab' && t.url === here).pop() || tabs.filter(t => t.url.split('#')[0] === here.split('#')[0]).pop();
  if (!tab) done('error', `Could not find the browser tab for ${here}`);
  try {
    await cdp.send('Extensions.triggerAction', { id: EXT_ID, targetId: tab.targetId });
  } catch (e) {
    done('error', `Chrome refused to press the Navattic button: ${e.message.split('\n')[0]}. Is the extension loaded? (see Verify in the guide)`);
  }

  // Navattic answers the press by starting capture, or by asking for site access or a login first.
  await page.waitForTimeout(3000);
  const after = (await cdp.send('Target.getTargets')).targetInfos.filter(t => !before.has(t.targetId));
  if (after.some(t => t.url.includes(`${EXT_ID}/static/site-access.html`)))
    done('needs_site_access', 'Navattic is asking for site access. In the browser click "Enable site access", then "Allow", then run this again.', { url: here });
  if (after.some(t => /navattic\.com\/auth\/login/.test(t.url)))
    done('needs_login', 'Navattic opened its login page. Log in in the browser, then run this again.', { url: here });
  if (!setup) done('started', 'Pressed the Navattic button on the app tab. The "Choose a demo" dialog should be showing there.', { url: here });
  await browser.close().catch(() => {});
  await chooseDemo(here);
} finally {
  await browser.close().catch(() => {}); // disconnects only; the shared browser stays open
}

// Answers the "Choose a demo" dialog with jev-browser, the same snapshot-and-click path the agent uses
// (Navattic's UI is an extension iframe that plain Playwright locators don't reach).
async function chooseDemo(appUrl) {
  const { JevBrowser } = await import(pathToFileURL(join(process.env.JEV_DIR || join(ROOT, 'jev-browser'), 'dist', 'index.js')).href)
    .catch(e => done('error', `cannot load jev-browser (${e.message})`));
  const jev = await JevBrowser.launch(JSON.parse(readFileSync(join(ROOT, 'opts.json'), 'utf8')));
  const fail = (message, snap) => done('setup_failed', `${message} Finish the dialog by hand (see the navattic-capture skill), or rerun.`,
    { url: appUrl, demo: DEMO, seen: snap && snap.texts.filter(t => t.frame > 0).map(t => t.text).slice(0, 30) });
  try {
    const { tabs } = await jev.native({ command: 'tabs', action: 'list' });
    // Older tabs can share the app url (earlier runs); the one Navattic's UI is in is the one we opened.
    const matches = tabs.filter(t => t.url.split('#')[0] === appUrl.split('#')[0]).reverse();
    if (!matches.length) fail(`Could not find the app tab ${appUrl}.`);
    let tab = matches[0];
    for (const end = Date.now() + 15_000; matches.length > 1 && Date.now() < end; await new Promise(r => setTimeout(r, 500))) {
      const hit = await (async () => { for (const t of matches) {
        await jev.native({ command: 'tabs', action: 'select', index: t.index });
        if ((await jev.snapshot(NAVATTIC_ONLY)).elements.some(e => e.frame > 0)) return t;
      } })();
      if (hit) { tab = hit; break; }
    }
    await jev.native({ command: 'tabs', action: 'select', index: tab.index });

    // Polls snapshots until find() returns something, so each click uses ids from a fresh snapshot.
    let snap;
    const waitFor = async (find, what, ms = 15_000) => {
      for (const end = Date.now() + ms; ;) {
        snap = await jev.snapshot(NAVATTIC_ONLY);
        const hit = find(snap);
        if (hit) return hit;
        if (Date.now() > end) fail(`Timed out waiting for ${what}.`, snap);
        await new Promise(r => setTimeout(r, 500));
      }
    };
    const el = (name, role) => s => s.elements.find(e => e.frame > 0 && e.name === name && (!role || e.role === role));
    const click = e => jev.native({ command: 'click', ref: e.id });
    const value = (s, name, role) => s.texts.find(t => t.frame > 0 && t.text === name && t.role === role)?.value;
    const barUp = s => el('Finish')(s) && !el('Start capturing')(s);

    const first = await waitFor(s => el('Add to existing demo')(s) || (barUp(s) && 'bar'), 'the "Choose a demo" dialog');
    if (first === 'bar') done('ready', 'The capture bar was already up on the app tab (no "Choose a demo" dialog).', { url: appUrl, count: counter(snap) });
    if (EXISTING) {
      await click(first);
      await click(await waitFor(el('Product demo', 'combobox'), 'the "Product demo" dropdown'));
      await click(await waitFor(s => s.elements.find(e => e.frame > 0 && e.name === DEMO && e.role !== 'combobox'), `the demo "${DEMO}" in the dropdown`));
    } else {
      await click(await waitFor(el('New demo'), 'the "New demo" button'));
      const name = await waitFor(el('Name your demo', 'textbox'), 'the "Name your demo" box');
      await jev.native({ command: 'type', target: name.id, text: DEMO });
    }
    snap = await jev.snapshot(NAVATTIC_ONLY);
    if (value(snap, 'Web capture Recommended', 'radio') === false) await click(el('Web capture Recommended', 'radio')(snap)), snap = await jev.snapshot(NAVATTIC_ONLY);
    if (value(snap, 'Click to capture', 'checkbox') === true) await click(el('Click to capture', 'checkbox')(snap)), snap = await jev.snapshot(NAVATTIC_ONLY);
    await click(await waitFor(el('Start capturing'), 'the "Start capturing" button'));

    // "Start capturing" makes Navattic reload the tab itself (worker.js: location.reload, then chrome.tabs.reload).
    // Wait for the bar to come back from those; reload ourselves only if it doesn't. It counts as up once it has been
    // seen twice, 1 s apart, with no page load between (the bar can flash up before Navattic's reloads land).
    let loads = 0; const onLoad = () => loads++; jev.page.on('load', onLoad);
    let seen = null, reloaded = false;
    for (const end = Date.now() + 12_000; Date.now() < end; await jev.page.waitForTimeout(1000)) {
      snap = await jev.snapshot(NAVATTIC_ONLY);
      // A free account allows one demo: "New demo" then shows this and stays on the dialog.
      const limit = snap.texts.find(t => t.frame > 0 && /demo limit reached/i.test(t.text));
      if (limit) done('demo_limit', `Navattic says: "${limit.text}" Rerun with --existing "<demo name>" to add to a demo you already have.`, { url: appUrl, demo: DEMO });
      const up = barUp(snap) && counter(snap) !== undefined;
      if (up && seen === loads) break;
      seen = up ? loads : null;
    }
    jev.page.off('load', onLoad);
    if (seen !== loads || !(barUp(snap) && counter(snap) !== undefined)) {
      reloaded = true;
      await jev.page.reload({ waitUntil: 'load' });
      await waitFor(s => barUp(s) && counter(s) !== undefined, 'the capture bar after the reload', 40_000);
    }
    done('ready', `Capturing into ${EXISTING ? 'existing' : 'new'} demo "${DEMO}". The capture bar is up on the app tab with ${counter(snap)} captures.`,
      { url: appUrl, demo: DEMO, count: counter(snap), navatticLoads: loads, reloaded });
  } finally {
    await jev.close().catch(() => {});
  }
}

// The capture bar's count: the number shown just before its "Capture" button.
function counter(s) {
  const t = s.texts.filter(x => x.frame > 0);
  const i = t.findIndex((x, k) => x.text === 'Capture' && t[k + 1]?.text === 'Finish');
  return i > 0 && /^\d+$/.test(t[i - 1].text) ? Number(t[i - 1].text) : undefined;
}
