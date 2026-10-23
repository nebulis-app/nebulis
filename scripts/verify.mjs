#!/usr/bin/env node
/**
 * Verification ladder — the single definition of "done" for a change.
 *
 *   npm run verify              typecheck + lint + unit tests (the default gate)
 *   npm run verify -- --e2e     also run the Playwright suite (mocked, tests/e2e)
 *   npm run verify -- --build   also run the production build
 *   npm run verify -- --all     everything above
 *   npm run verify -- --lab     also run the Import Lab's Docker lifecycle: lab:up,
 *                                tier 2 (real browser/server) and tier 3 (real
 *                                Docker SMB/FTP), then lab:down. Needs Docker.
 *   npm run test:all             alias for `--all --lab` — every suite this repo has.
 *   npm run verify -- --json    machine-readable report on stdout only
 *   npm run verify -- --only=lint
 *   npm run verify -- --open    open verify-report.html when done
 *
 * Every stage runs even after one fails, so a single run reports the complete
 * picture instead of one problem at a time. The exit code is 0 only when every
 * stage passed.
 *
 * Why this script exists instead of a chain of `npm run` calls: an agent (or a
 * human) needs one command that answers "did I break anything?" with a
 * structured, complete answer, and needs it to work under a restricted
 * sandbox. Two consequences of that:
 *
 *   1. The default (non `--lab`) stages invoke binaries in node_modules/.bin
 *      directly. Going through `npx`/`npm run` makes npm touch ~/.npm for its
 *      cache and logs, which fails with EPERM when the agent's sandbox only
 *      permits writes under the workspace. A verification command that cannot
 *      run under the sandbox is not a gate.
 *   2. The `--lab` stages are the exception: they need Docker and a real
 *      network, which no sandbox permits anyway, so they shell out via
 *      `npm run lab:up` / `test:e2e:real` / `test:lab` / `lab:down` instead of
 *      reimplementing that lifecycle here. Those four scripts (see
 *      package.json and docker/lab/) are the single source of truth for what
 *      "the lab" means; this file only orchestrates them and records pass/fail.
 *   3. The result is written as JSON (`verify-report.json`) and HTML
 *      (`verify-report.html`) as well as printed. Those files are the
 *      evidence bundle: what was checked, on which revision, and what the
 *      outcome was. When `--lab` ran, the HTML links out to the existing
 *      scenario-level `lab-report/index.html` (see scripts/lab-report.mjs)
 *      rather than duplicating it.
 *
 * The `test` stage always runs with the Import Lab's Vitest reporter attached
 * (`--reporter=./tests/lab/labReporter.ts`) alongside the default one. That
 * reporter only records tests already tagged `[U1]`-style and is a no-op for
 * everything else, so this costs nothing and means tests/backend/lab (tier 1)
 * no longer has to run a second time under `--lab` just to get its own report.
 *
 * `--redact` is not offered: the report deliberately contains no environment
 * values, only stage names, exit codes, timings, and output tails.
 */

import { spawnSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args
    .filter(a => a.startsWith('--'))
    .map(a => {
      const eq = a.indexOf('=');
      return eq === -1 ? [a.slice(2), true] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);

const wantAll = Boolean(flags.all);
const wantE2e = wantAll || Boolean(flags.e2e);
const wantBuild = wantAll || Boolean(flags.build);
const wantLab = Boolean(flags.lab);
const jsonOnly = Boolean(flags.json);
const only = typeof flags.only === 'string' ? flags.only : null;
const wantOpen = Boolean(flags.open);

/** npm itself, for the `--lab` stages that intentionally go through package.json scripts. */
function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** Resolve a binary from node_modules/.bin without going through npm. */
function bin(name) {
  const exe = process.platform === 'win32' ? `${name}.cmd` : name;
  const full = path.join(ROOT, 'node_modules', '.bin', exe);
  if (!fs.existsSync(full)) {
    throw new Error(`Expected ${name} at ${path.relative(ROOT, full)}. Run the install step first.`);
  }
  return full;
}

/**
 * Pull the headline numbers out of a tool's output so the report says what
 * happened, not just whether it exited zero.
 */
function summarize(name, output) {
  if (name === 'test') {
    const files = /Test Files\s+(.+)/.exec(output);
    const tests = /Tests\s+(.+)/.exec(output);
    return [files && `files: ${files[1].trim()}`, tests && `tests: ${tests[1].trim()}`].filter(Boolean).join(', ');
  }
  if (name === 'lint') {
    const problems = /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(output);
    if (problems) return `${problems[2]} errors, ${problems[3]} warnings`;
    return /no problems/i.test(output) ? 'clean' : '';
  }
  if (name === 'e2e' || name === 'lab:e2e-real') {
    const passed = /(\d+) passed/.exec(output);
    const failed = /(\d+) failed/.exec(output);
    return [passed && `${passed[1]} passed`, failed && `${failed[1]} failed`].filter(Boolean).join(', ');
  }
  if (name === 'lab:tier3') {
    const files = /Test Files\s+(.+)/.exec(output);
    const tests = /Tests\s+(.+)/.exec(output);
    return [files && `files: ${files[1].trim()}`, tests && `tests: ${tests[1].trim()}`].filter(Boolean).join(', ');
  }
  return '';
}

const STAGES = [
  {
    name: 'typecheck',
    description: 'Client + shared TypeScript',
    command: () => [bin('tsc'), ['-b', '--noEmit']],
  },
  {
    name: 'typecheck:server',
    description: 'Server-only TypeScript',
    command: () => [bin('tsc'), ['--noEmit', '-p', 'server/tsconfig.json']],
  },
  {
    name: 'lint',
    description: 'ESLint',
    command: () => [bin('eslint'), ['.']],
  },
  {
    name: 'test',
    description: 'Vitest unit + backend suites (incl. Import Lab tier 1)',
    // The labReporter tags-and-records Import Lab tier-1 tests ([U1]-style
    // titles under tests/backend/lab) into lab-report/results-vitest-tier1.json;
    // it is a no-op for every other test, so this always runs and tier 1 never
    // needs a separate `--reporter` pass under `--lab`.
    command: () => [bin('vitest'), ['run', '--reporter=default', '--reporter=./tests/lab/labReporter.ts']],
    timeoutMs: 15 * 60 * 1000,
  },
  ...(wantE2e
    ? [
        {
          name: 'e2e',
          description: 'Playwright end-to-end (mocked, tests/e2e)',
          command: () => [bin('playwright'), ['test']],
          timeoutMs: 30 * 60 * 1000,
        },
      ]
    : []),
  ...(wantBuild
    ? [
        {
          name: 'build',
          description: 'Production build',
          command: () => [bin('tsc'), ['-b']],
          then: () => [bin('vite'), ['build']],
          timeoutMs: 20 * 60 * 1000,
        },
      ]
    : []),
  ...(wantLab
    ? [
        {
          name: 'lab:up',
          description: 'Docker lab up (fake SMB/FTP telescopes)',
          command: () => [npmCmd(), ['run', 'lab:up']],
          timeoutMs: 10 * 60 * 1000,
        },
        {
          name: 'lab:e2e-real',
          description: 'Import Lab tier 2 — real browser, real server',
          command: () => [npmCmd(), ['run', 'test:e2e:real']],
          timeoutMs: 10 * 60 * 1000,
        },
        {
          name: 'lab:tier3',
          description: 'Import Lab tier 3 — real Docker SMB/FTP',
          command: () => [npmCmd(), ['run', 'test:lab']],
          timeoutMs: 15 * 60 * 1000,
        },
        {
          name: 'lab:down',
          description: 'Docker lab down',
          // Always scheduled, regardless of whether the stages above passed —
          // the stage loop below runs every stage even after an earlier one
          // fails, which is exactly the "always tear down" guarantee this needs.
          command: () => [npmCmd(), ['run', 'lab:down']],
          timeoutMs: 5 * 60 * 1000,
        },
      ]
    : []),
];

function runStage(stage) {
  const startedAt = Date.now();
  const [cmd, cmdArgs] = stage.command();
  const result = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: stage.timeoutMs ?? 10 * 60 * 1000,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
  });

  let status = result.status ?? 1;
  let output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  // A stage may declare a second command (e.g. build: tsc -b then vite build).
  if (status === 0 && stage.then) {
    const [cmd2, args2] = stage.then();
    const second = spawnSync(cmd2, args2, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: stage.timeoutMs ?? 10 * 60 * 1000,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    status = second.status ?? 1;
    output += `${second.stdout ?? ''}${second.stderr ?? ''}`;
  }

  const durationMs = Date.now() - startedAt;
  const lines = output.split('\n');
  const tail = lines.slice(-40).join('\n');

  return {
    name: stage.name,
    description: stage.description,
    command: [path.relative(ROOT, cmd), ...cmdArgs].join(' '),
    status: status === 0 ? 'pass' : 'fail',
    exitCode: status,
    durationMs,
    summary: summarize(stage.name, output),
    outputTail: status === 0 ? undefined : tail,
  };
}

const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * One HTML page for the whole ladder. It does not re-render the Import Lab's
 * own scenario table (scripts/lab-report.mjs already does that well) — it
 * links to it, plus to Playwright's own HTML report, so nothing is duplicated.
 */
function buildHtml(report) {
  const ranLab = report.stages.some(s => s.name.startsWith('lab:'));
  const ranE2e = report.stages.some(s => s.name === 'e2e');
  const rows = report.stages.map(s => `
      <details class="row ${s.status}">
        <summary>
          <span class="icon">${s.status === 'pass' ? '&#9989;' : '&#10060;'}</span>
          <span class="name">${escHtml(s.name)}</span>
          <span class="desc">${escHtml(s.description)}</span>
          <span class="meta">${(s.durationMs / 1000).toFixed(1)}s${s.summary ? ` &middot; ${escHtml(s.summary)}` : ''}</span>
        </summary>
        <div class="detail">
          <p class="dim"><code>${escHtml(s.command)}</code></p>
          ${s.outputTail ? `<pre>${escHtml(s.outputTail)}</pre>` : '<p class="dim">No output tail (passed).</p>'}
        </div>
      </details>`).join('');
  const links = [
    ranLab && fs.existsSync(path.join(ROOT, 'lab-report/index.html')) && `<li><a href="lab-report/index.html">Import Lab scenario report</a> — per-scenario detail for tiers 1-3</li>`,
    ranE2e && fs.existsSync(path.join(ROOT, 'playwright-report/index.html')) && `<li><a href="playwright-report/index.html">Playwright HTML report</a> — traces/screenshots for tests/e2e</li>`,
  ].filter(Boolean).join('');
  const banner = report.ok
    ? `<div class="banner green">&#9989; All ${report.stages.length} stages passed</div>`
    : `<div class="banner red">&#10060; ${report.stages.filter(s => s.status === 'fail').length} of ${report.stages.length} stage(s) failed</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verification Ladder Report</title>
<style>
:root{--bg:#fff;--fg:#1a1d23;--dim:#6b7280;--line:#e5e7eb;--green:#166534;--greenbg:#dcfce7;--red:#991b1b;--redbg:#fee2e2}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--dim:#9ca3af;--line:#272b33;--green:#86efac;--greenbg:#12301d;--red:#fca5a5;--redbg:#3a1414}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
h1{margin:0 0 4px;font-size:22px}.sub{color:var(--dim);margin:0 0 16px}
.banner{padding:14px 16px;border-radius:10px;font-weight:600;font-size:17px;margin-bottom:20px}
.banner.green{background:var(--greenbg);color:var(--green)}.banner.red{background:var(--redbg);color:var(--red)}
h2{font-size:16px;margin:28px 0 8px}
.row{border:1px solid var(--line);border-radius:8px;margin-bottom:6px}
.row.pass{border-left:4px solid var(--green)}.row.fail{border-left:4px solid var(--red)}
summary{display:flex;gap:10px;align-items:baseline;padding:8px 12px;cursor:pointer;flex-wrap:wrap}
.name{font-weight:700;min-width:8em}.desc{flex:1 1 260px;color:var(--dim)}.meta{color:var(--dim);font-size:13px}
.detail{padding:4px 14px 12px 38px;border-top:1px solid var(--line)}
.dim{color:var(--dim);font-size:13px}
pre{background:var(--redbg);color:var(--red);padding:8px;border-radius:6px;overflow:auto;font-size:12px;white-space:pre-wrap}
ul{padding-left:20px}
</style></head><body><main>
<h1>Verification Ladder Report</h1>
<p class="sub">Generated ${escHtml(report.finishedAt)}${report.revision ? ` &middot; revision ${escHtml(report.revision.slice(0, 9))}` : ''}</p>
${banner}
${links ? `<h2>Detail reports</h2><ul>${links}</ul>` : ''}
<h2>Stages</h2>
${rows}
</main></body></html>`;
}

function gitRevision() {
  for (const cmd of [
    ['git', ['rev-parse', 'HEAD']],
    ['git', ['status', '--porcelain']],
  ]) {
    // Best effort only: the report is still useful without revision info.
    const res = spawnSync(cmd[0], cmd[1], { cwd: ROOT, encoding: 'utf8' });
    if (res.status !== 0) return null;
    if (cmd[1][0] === 'rev-parse') return res.stdout.trim();
  }
  return null;
}

const selected = only ? STAGES.filter(s => s.name === only) : STAGES;
if (only && selected.length === 0) {
  console.error(`Unknown stage "${only}". Available: ${STAGES.map(s => s.name).join(', ')}`);
  process.exit(2);
}

/**
 * The e2e stage starts its own Vite server on this port (playwright.config.ts). This run sets CI, which turns
 * Playwright's reuse of an existing server off, so a dev server already on the port makes the stage fail in
 * milliseconds with no test run behind it, after the slow stages before it have already spent minutes. Look first.
 */
const E2E_PORT = 5173;
const portInUse = port => new Promise(resolve => {
  const socket = net.createConnection({ port, host: 'localhost' });
  socket.setTimeout(750, () => { socket.destroy(); resolve(false); });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
if (selected.some(s => s.name === 'e2e') && await portInUse(E2E_PORT)) {
  console.error(
    `Port ${E2E_PORT} is already in use, so the e2e stage cannot start its own server (this run sets CI, which turns ` +
    `reuse off). Stop the dev server (npm run dev) and run again, or run "npx playwright test" on its own to use it.`,
  );
  process.exit(2);
}

const startedAt = new Date().toISOString();
const results = [];
for (const stage of selected) {
  if (!jsonOnly) console.log(`\n▶ ${stage.name} — ${stage.description}`);
  const result = runStage(stage);
  results.push(result);
  if (!jsonOnly) {
    const mark = result.status === 'pass' ? 'PASS' : 'FAIL';
    const secs = (result.durationMs / 1000).toFixed(1);
    console.log(`  ${mark} (${secs}s)${result.summary ? ` — ${result.summary}` : ''}`);
  }
}

const ok = results.every(r => r.status === 'pass');
const report = {
  ok,
  startedAt,
  finishedAt: new Date().toISOString(),
  revision: gitRevision(),
  stages: results,
};

const outPath = path.join(ROOT, typeof flags.out === 'string' ? flags.out : 'verify-report.json');
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

const htmlOutPath = outPath.replace(/\.json$/, '.html');
fs.writeFileSync(htmlOutPath, buildHtml(report));

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`\n${'─'.repeat(52)}`);
  for (const r of results) {
    const mark = r.status === 'pass' ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${r.name.padEnd(18)} ${(r.durationMs / 1000).toFixed(1)}s  ${r.summary}`);
  }
  console.log(`${'─'.repeat(52)}`);
  console.log(ok ? 'Verification ladder passed.' : 'Verification ladder FAILED — see output above.');
  console.log(`Report: ${path.relative(ROOT, outPath)} / ${path.relative(ROOT, htmlOutPath)}${report.revision ? ` (revision ${report.revision.slice(0, 9)})` : ''}`);
}

if (wantOpen) {
  execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open', [htmlOutPath]);
}

process.exit(ok ? 0 : 1);
