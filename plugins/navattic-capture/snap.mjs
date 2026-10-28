#!/usr/bin/env node
// snap.mjs: search a browser_snapshot that was too large for the tool result and got saved to a file.
//
//   node ~/navattic-capture/snap.mjs <saved snapshot file> "Save changes" "Videos"
//   node ~/navattic-capture/snap.mjs <saved snapshot file>          # every element, one line each
//
// Prints the page url, the Navattic capture counter, and each element whose name matches a term
// (case-insensitive substring) as: id  role  "name"  [checked/expanded/disabled]  frame N.
// The ids work as browser_click / browser_type targets until the page changes.

import { readFileSync } from 'node:fs';

const [file, ...terms] = process.argv.slice(2);
if (!file) { console.error('usage: node snap.mjs <saved snapshot file> [name ...]'); process.exit(1); }
let snap = JSON.parse(readFileSync(file, 'utf8'));
// Some saved results wrap the snapshot as MCP content blocks.
if (Array.isArray(snap)) snap = JSON.parse(snap.find(b => b.type === 'text')?.text ?? '{}');

// The capture bar's count: the number shown just before its "Capture" and "Finish" buttons.
const t = snap.texts.filter(x => x.frame > 0);
const i = t.findIndex((x, k) => x.text === 'Capture' && t[k + 1]?.text === 'Finish');
const counter = i > 0 && /^\d+$/.test(t[i - 1].text) ? t[i - 1].text : 'not shown';
console.log(`url      ${snap.url}\ncounter  ${counter}`);

const want = terms.map(x => x.toLowerCase());
const hits = snap.elements.filter(e => !want.length || want.some(w => (e.name || '').toLowerCase().includes(w)));
for (const e of hits) {
  const state = [e.checked !== undefined && `checked=${e.checked}`, e.expanded && 'expanded', e.disabled && 'disabled'].filter(Boolean).join(' ');
  console.log(`${e.id}  ${e.role}  "${e.name}"${state ? `  ${state}` : ''}  frame ${e.frame}`);
}
if (!hits.length) console.log(`no element named like: ${terms.join(', ')} (names are often on a nearby element; try a shorter term)`);
