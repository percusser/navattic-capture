// decider.mjs: the one place that turns .env into a decision-model backend.
// mcp.mjs (Claude Code's browser tools), replay.mjs and ab.mjs all call resolveDecider, so they always agree.
//
// .env picks the backend with DECIDER and holds each backend's key, model and endpoint (see .env.example).
// Variables already in the shell win over .env. DECIDER_MODEL overrides the model of whichever backend is picked.

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';

// Code lives wherever these scripts are (this folder, or a Claude Code plugin's install folder); data lives in
// HOME: .env, opts.json, profile/, extension/, jev-browser/, runs/. Only the shell can move it (NAVATTIC_HOME).
export const HOME = process.env.NAVATTIC_HOME || join(homedir(), 'navattic-capture');
export const ENV_FILE = join(HOME, '.env');
let fileVars = {};
try { fileVars = parseEnv(readFileSync(ENV_FILE, 'utf8')); } catch {}
// Shell variables win over .env. These are the .env settings a shell export is overriding, so a stale
// export in ~/.zshrc is easy to spot (node decider.mjs and the MCP log both list them).
export const shellOverrides = Object.keys(fileVars).filter(k => fileVars[k] && process.env[k] !== undefined && process.env[k] !== fileVars[k]);
for (const [k, v] of Object.entries(fileVars)) process.env[k] ??= v;

export const DECIDERS = ['openrouter', 'typesafe', 'cloudflare', 'custom'];
// The jev-browser variables the decider sets. mcp.mjs clears these first so .env is the only source.
export const JEV_VARS = ['JEV_API_KEY', 'JEV_BASE_URL', 'JEV_ENDPOINT_API_KEY', 'JEV_MODEL'];

const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

// Returns { name, model, label, url, key, missing, imageMode, noulCriteria, jevEnv }:
//   url/key/imageMode/noulCriteria  how replay.mjs calls the System One endpoint itself
//   jevEnv                          the JEV_* variables jev-browser's MCP server needs
//   missing                         the .env variable that still needs a value, or false
// Overrides (command-line flags): { model, cfUrl, url }.
export function resolveDecider(name, o = {}) {
  const env = process.env;
  name ||= env.DECIDER || 'openrouter';
  const model = o.model || env.DECIDER_MODEL;
  const done = d => ({ name, label: `${name}/${d.model}`, ...d, jevEnv: clean(d.jevEnv) });

  if (name === 'openrouter') {
    const key = env.DECIDER_OPENROUTER_KEY, m = model || env.OPENROUTER_MODEL || 'perplexity/pplx-decider-v1.2';
    return done({ model: m, key, keyVar: 'DECIDER_OPENROUTER_KEY', missing: !key && 'DECIDER_OPENROUTER_KEY', url: 'https://openrouter.ai/api/v1/systemone', imageMode: 'state', noulCriteria: true,
      jevEnv: { JEV_BASE_URL: 'https://openrouter.ai/api', JEV_ENDPOINT_API_KEY: key, JEV_MODEL: m } });
  }
  if (name === 'typesafe') {
    const key = env.TYPESAFE_API_KEY, m = model || env.TYPESAFE_MODEL || 'jev-latest';
    return done({ model: m, key, keyVar: 'TYPESAFE_API_KEY', missing: !key && 'TYPESAFE_API_KEY', url: 'https://api.typesafe.ai/v1/systemone', imageMode: 'state', noulCriteria: true,
      jevEnv: { JEV_API_KEY: key, JEV_MODEL: m } });
  }
  if (name === 'cloudflare') {
    // The Workers AI run URL names both the account and the model. jev-browser reads the model from it.
    const key = env.CLOUDFLARE_API_TOKEN, account = env.CLOUDFLARE_ACCOUNT_ID, given = o.cfUrl || env.CLOUDFLARE_URL;
    const m = (given && /\/ai\/run\/@cf\/[^/]+\/([^/?#]+)/.exec(given)?.[1]) || model || env.CLOUDFLARE_MODEL || 'clef-flash';
    const url = given || (account && `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${m}`);
    return done({ model: m, key, keyVar: 'CLOUDFLARE_API_TOKEN', missing: (!key && 'CLOUDFLARE_API_TOKEN') || (!url && 'CLOUDFLARE_ACCOUNT_ID'), url, imageMode: 'field', noulCriteria: false,
      jevEnv: { JEV_BASE_URL: url, JEV_ENDPOINT_API_KEY: key } });
  }
  if (name === 'custom') {
    // Any endpoint that speaks the System One API: CUSTOM_URL is its root, without /v1/systemone.
    const base = (o.url || env.CUSTOM_URL || '').replace(/\/$/, ''), key = env.CUSTOM_API_KEY, m = model || env.CUSTOM_MODEL || '';
    return done({ model: m || 'default', key, keyVar: 'CUSTOM_API_KEY', missing: !base && 'CUSTOM_URL', url: base && `${base}/v1/systemone`, imageMode: 'state', noulCriteria: true,
      jevEnv: { JEV_BASE_URL: base, JEV_ENDPOINT_API_KEY: key, JEV_MODEL: m } });
  }
  throw new Error(`unknown DECIDER "${name}" (use ${DECIDERS.join(' | ')})`);
}

// `node decider.mjs` prints what .env resolves to, without the keys.
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    const d = resolveDecider();
    const src = k => (fileVars[k] && process.env[k] === fileVars[k] ? '.env' : 'shell');
    console.log(`DECIDER  ${d.name} (from ${process.env.DECIDER ? src('DECIDER') : 'default'})\nmodel    ${d.model}\nendpoint ${d.url || '(none)'}`);
    console.log(`key      ${d.key ? `${d.keyVar} set (from ${src(d.keyVar)})` : 'not set'}`);
    if (shellOverrides.length) console.log(`\nYour shell overrides these .env settings: ${shellOverrides.join(', ')}. Unset them (check ~/.zshrc) to use .env.`);
    console.log(d.missing ? `\nNot ready: set ${d.missing} in ${ENV_FILE}` : '\nReady.');
    process.exit(d.missing ? 1 : 0);
  } catch (e) { console.error(e.message); process.exit(1); }
}
