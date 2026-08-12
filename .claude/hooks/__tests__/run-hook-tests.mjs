#!/usr/bin/env node
/**
 * Adversarial test for the harness hooks.
 *
 * Every case here is a thing the hooks MUST block or MUST allow. A gate that does not
 * actually block is worse than no gate, because it produces false confidence — so this
 * runs the real hook processes with real payloads rather than testing the logic in the
 * abstract.
 *
 *   node .claude/hooks/__tests__/run-hook-tests.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hooks = join(here, '..');
const projectDir = join(hooks, '..', '..');
const statePath = (f) => join(projectDir, '.claude', 'state', f);

const BLOCK = 2;
const ALLOW = 0;

let passed = 0;
const failures = [];

function runHook(hook, payload) {
  const result = spawnSync(process.execPath, [join(hooks, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    timeout: 20_000,
  });
  return { code: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

function expect(name, { hook, payload, want, mustSay }) {
  const { code, stderr } = runHook(hook, payload);
  const verdict = code === BLOCK ? 'BLOCK' : code === ALLOW ? 'ALLOW' : `EXIT ${code}`;
  const wanted = want === BLOCK ? 'BLOCK' : 'ALLOW';

  if (verdict !== wanted) {
    failures.push(
      `${name}\n    wanted ${wanted}, got ${verdict}\n    stderr: ${stderr.trim().slice(0, 200)}`,
    );
    return;
  }

  if (mustSay && !stderr.includes(mustSay)) {
    failures.push(
      `${name}\n    blocked correctly but the message never mentions "${mustSay}"\n    stderr: ${stderr.trim().slice(0, 200)}`,
    );
    return;
  }

  passed += 1;
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path, content = '') => ({
  tool_name: 'Write',
  tool_input: { file_path, content },
});

// ============================================================ guard-write

expect('guard-write blocks .env', {
  hook: 'guard-write.mjs',
  payload: write(join(projectDir, '.env'), 'JWT_SECRET=hunter2'),
  want: BLOCK,
  mustSay: '.env.example',
});

expect('guard-write allows .env.example', {
  hook: 'guard-write.mjs',
  payload: write(join(projectDir, '.env.example'), 'JWT_SECRET=replace_me'),
  want: ALLOW,
});

expect('guard-write blocks private keys', {
  hook: 'guard-write.mjs',
  payload: write(join(projectDir, 'apps/api/tls.pem'), 'x'),
  want: BLOCK,
});

expect('guard-write blocks an API DTO declared in an app', {
  hook: 'guard-write.mjs',
  payload: write(
    join(projectDir, 'apps/storefront/src/types.ts'),
    'export interface ProductResponse { id: string }',
  ),
  want: BLOCK,
  mustSay: 'packages/contracts',
});

expect('guard-write allows the same shape inside packages/contracts', {
  hook: 'guard-write.mjs',
  payload: write(
    join(projectDir, 'packages/contracts/src/product.ts'),
    'export interface ProductResponse { id: string }',
  ),
  want: ALLOW,
});

expect('guard-write allows a plainly-named local view model in an app', {
  hook: 'guard-write.mjs',
  payload: write(
    join(projectDir, 'apps/storefront/src/cart-view.ts'),
    'export interface CartViewModel { lines: number }',
  ),
  want: ALLOW,
});

expect('guard-write blocks generated files', {
  hook: 'guard-write.mjs',
  payload: write(
    join(projectDir, 'packages/contracts/src/enums.generated.ts'),
    'export const X = 1;',
  ),
  want: BLOCK,
});

expect('guard-write blocks hand-written review verdicts', {
  hook: 'guard-write.mjs',
  payload: write(statePath('review-99.json'), '{"verdict":"PASS"}'),
  want: BLOCK,
  mustSay: 'record-verdict',
});

// ============================================================ guard-git

expect('guard-git blocks force push', {
  hook: 'guard-git.mjs',
  payload: bash('git push --force origin feat/1-foo'),
  want: BLOCK,
  mustSay: 'force',
});

expect('guard-git blocks short-flag force push', {
  hook: 'guard-git.mjs',
  payload: bash('git push -f origin feat/1-foo'),
  want: BLOCK,
});

expect('guard-git allows --force-with-lease', {
  hook: 'guard-git.mjs',
  payload: bash('git push --force-with-lease origin feat/1-foo'),
  want: ALLOW,
});

expect('guard-git is not fooled by "--force" inside a commit message', {
  hook: 'guard-git.mjs',
  payload: bash('git commit -m "document why we never use --force here"'),
  want: ALLOW,
});

expect('guard-git blocks deleting main on the remote', {
  hook: 'guard-git.mjs',
  payload: bash('git push origin --delete main'),
  want: BLOCK,
});

expect('guard-git allows an ordinary push', {
  hook: 'guard-git.mjs',
  payload: bash('git push -u origin feat/12-cart'),
  want: ALLOW,
});

// ---- the merge gate itself -------------------------------------------------

rmSync(statePath('review-42.json'), { force: true });

expect('MERGE GATE: blocks gh pr merge with no verdict on file', {
  hook: 'guard-git.mjs',
  payload: bash('gh pr merge 42 --squash --delete-branch'),
  want: BLOCK,
  mustSay: 'no review verdict',
});

expect('MERGE GATE: blocks gh pr merge with no PR number', {
  hook: 'guard-git.mjs',
  payload: bash('gh pr merge --squash'),
  want: BLOCK,
  mustSay: 'explicit PR number',
});

mkdirSync(statePath(''), { recursive: true });
writeFileSync(
  statePath('review-42.json'),
  JSON.stringify({ pr: 42, verdict: 'FAIL', summary: 'no test covers AC3', headSha: 'deadbeef' }),
);

expect('MERGE GATE: blocks merge when the verdict is FAIL', {
  hook: 'guard-git.mjs',
  payload: bash('gh pr merge 42 --squash'),
  want: BLOCK,
  mustSay: 'not PASS',
});

writeFileSync(
  statePath('review-42.json'),
  JSON.stringify({ pr: 42, verdict: 'PASS', summary: 'ok', headSha: 'sha-from-an-older-commit' }),
);

expect('MERGE GATE: blocks a PASS recorded against a different commit', {
  hook: 'guard-git.mjs',
  payload: bash('gh pr merge 42 --squash'),
  want: BLOCK,
  mustSay: 'moved since it was reviewed',
});

// A PASS stamped with the real current HEAD is the only thing that opens the gate.
const head = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: projectDir,
  encoding: 'utf8',
}).stdout?.trim();

if (head) {
  writeFileSync(
    statePath('review-42.json'),
    JSON.stringify({ pr: 42, verdict: 'PASS', summary: 'ok', headSha: head }),
  );

  expect('MERGE GATE: allows merge on a PASS at the current head', {
    hook: 'guard-git.mjs',
    payload: bash('gh pr merge 42 --squash --delete-branch'),
    want: ALLOW,
  });
} else {
  console.log('  (skipped the positive merge-gate case — no commits in the repo yet)');
}

rmSync(statePath('review-42.json'), { force: true });

// ============================================================ report

console.log(`\nhook tests: ${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const f of failures) console.log(`FAIL  ${f}\n`);
  console.log('The harness gate is not trustworthy until these pass.');
  process.exit(1);
}

console.log('All hook guarantees hold.');
