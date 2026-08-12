#!/usr/bin/env node
/**
 * Fails if a workspace package that contains TypeScript source does not declare the
 * scripts the verify gate runs.
 *
 * Turbo silently skips a package with no matching script — "Running lint in 4
 * packages" followed by "1 successful, 1 total" is not an error. That is how the gate
 * was vacuous before F1: `packages/config` was the only member and declared nothing,
 * so every step exited 0 having run nothing.
 *
 * Without this check the same hole reopens the moment apps/api, apps/storefront,
 * apps/admin or e2e lands without a `test` script — green gate, zero coverage, no
 * signal anywhere.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const REQUIRED = ['lint', 'typecheck', 'test', 'build'];

/** Packages exempt from a given script, with the reason. */
const EXEMPT = {
  // Config is flat ESM config files with no TypeScript to check, build or test.
  '@repo/config': ['typecheck', 'test', 'build'],
  // The e2e suite is Playwright — nothing to build or unit test.
  '@repo/e2e': ['build', 'test'],
};

function findPackages(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (existsSync(join(full, 'package.json'))) found.push(full);
  }
  return found;
}

function hasTypeScript(dir) {
  const src = join(dir, 'src');
  if (!existsSync(src)) return false;
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).some((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name),
    );
  return walk(src);
}

const packages = [
  ...findPackages(join(root, 'apps')),
  ...findPackages(join(root, 'packages')),
  ...(existsSync(join(root, 'e2e', 'package.json')) ? [join(root, 'e2e')] : []),
];

const problems = [];

for (const dir of packages) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const name = manifest.name ?? relative(root, dir);
  const scripts = manifest.scripts ?? {};
  const exempt = EXEMPT[name] ?? [];

  for (const required of REQUIRED) {
    if (exempt.includes(required)) continue;
    if (!scripts[required]) {
      problems.push(`${name} (${relative(root, dir)}) is missing a "${required}" script`);
    }
  }

  if (!hasTypeScript(dir) && !EXEMPT[name]) {
    problems.push(`${name} has no src/*.ts — add it to EXEMPT in this script if that is intended`);
  }
}

if (packages.length === 0) {
  console.error(
    'check-workspace-scripts: found no workspace packages at all — is the layout right?',
  );
  process.exit(1);
}

if (problems.length) {
  console.error('Workspace packages are missing gate scripts:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nA package with no script is skipped silently by Turbo, so the gate would pass\n' +
      'without checking it. Add the script, or add a deliberate exemption with a reason.',
  );
  process.exit(1);
}

console.log(`check-workspace-scripts: ${packages.length} package(s) declare their gate scripts`);
