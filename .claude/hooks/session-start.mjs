#!/usr/bin/env node
/**
 * SessionStart
 *
 * Prints the board so a fresh session knows where the build got to without having to
 * go and look: branch, working-tree state, open PRs, and the next unblocked issue.
 *
 * Everything here is best-effort — a missing gh auth or a stopped Docker daemon prints
 * a line and moves on. This hook must never be the reason a session fails to start.
 */
import { execFileSync } from 'node:child_process';
import { projectDir } from './_lib.mjs';

function run(cmd, args, timeout = 8000) {
  try {
    return execFileSync(cmd, args, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
    }).trim();
  } catch {
    return '';
  }
}

const lines = [];

// ---- git -------------------------------------------------------------------
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (!branch) {
  console.log('agentic-ecommerce · not a git repository yet (bootstrap not run)');
  process.exit(0);
}

const dirty = run('git', ['status', '--porcelain']);
const dirtyCount = dirty ? dirty.split('\n').filter(Boolean).length : 0;
lines.push(`branch      ${branch}${branch === 'main' ? '  (feature work needs its own branch)' : ''}`);
lines.push(`working set ${dirtyCount === 0 ? 'clean' : `${dirtyCount} uncommitted file(s)`}`);

// ---- github ----------------------------------------------------------------
const ghUser = run('gh', ['api', 'user', '--jq', '.login']);
if (!ghUser) {
  lines.push('github      NOT AUTHENTICATED — run: gh auth login');
} else {
  const prs = run('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName', '--limit', '10']);
  let openPrs = [];
  try {
    openPrs = JSON.parse(prs || '[]');
  } catch {
    openPrs = [];
  }

  lines.push(`github      ${ghUser} · ${openPrs.length} open PR(s)`);
  for (const pr of openPrs.slice(0, 5)) {
    lines.push(`            #${pr.number} ${pr.title}`);
  }

  const issues = run('gh', [
    'issue',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,labels',
    '--limit',
    '100',
  ]);
  try {
    const open = JSON.parse(issues || '[]');
    lines.push(`issues      ${open.length} open`);
    const next = open.sort((a, b) => a.number - b.number)[0];
    if (next) lines.push(`next        #${next.number} ${next.title}`);
  } catch {
    /* ignore */
  }
}

// ---- infrastructure --------------------------------------------------------
const ps = run('docker', ['compose', '-f', 'infra/docker-compose.yml', 'ps', '--services', '--filter', 'status=running']);
lines.push(`infra       ${ps ? ps.split('\n').filter(Boolean).join(', ') : 'down — run: pnpm infra:up'}`);

console.log(`\nagentic-ecommerce\n${'-'.repeat(60)}\n${lines.join('\n')}\n`);
