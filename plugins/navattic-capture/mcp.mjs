#!/usr/bin/env node
// mcp.mjs: jev-browser's MCP server for Claude Code, with the decision model picked from .env.
//
// Register once:
//   claude mcp add --scope user jev-browser -- node ~/navattic-capture/mcp.mjs
// To switch model or endpoint: edit DECIDER (and that backend's lines) in .env, then in Claude Code
// run /mcp and reconnect jev-browser (or start a new session).
//
// DECIDER=none starts it with no decision model (snapshot and click tools only; ab.mjs arms A and D).
// Extra arguments are passed to jev-browser, e.g. --caps evaluate,storage or --file-root DIR.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolveDecider, shellOverrides, JEV_VARS, HOME } from './decider.mjs';

const ROOT = HOME;
const env = { ...process.env };
for (const k of JEV_VARS) delete env[k];
if (env.DECIDER !== 'none') {
  let d;
  try { d = resolveDecider(); } catch (e) { console.error(`[mcp.mjs] ${e.message}`); process.exit(1); }
  Object.assign(env, d.jevEnv);
  // stderr, not stdout: stdout is the MCP protocol. Claude Code shows this in its MCP logs.
  console.error(`[mcp.mjs] decider ${d.label}${d.missing ? ` (set ${d.missing} in ${join(ROOT, '.env')}; decision tools will fail)` : ''}`);
  if (shellOverrides.length) console.error(`[mcp.mjs] shell variables override .env: ${shellOverrides.join(', ')}`);
}

const child = spawn(process.execPath, [join(env.JEV_DIR || join(ROOT, 'jev-browser'), 'dist', 'mcp-stdio.js'),
  '--options-file', join(ROOT, 'opts.json'), ...process.argv.slice(2)], { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
