#!/usr/bin/env node
/**
 * Fails if the compose stack reads an environment variable that `.env.example` does
 * not document (SPEC.md F2/AC4, and the ".env cascade" item in the review checklist).
 *
 * This drifts silently and expensively: someone adds `${SOMETHING}` to a service,
 * it works on their machine because their own `.env` already has it, and the next
 * person to run `pnpm infra:up` gets an empty string substituted with no warning —
 * Compose does not error on an undefined variable, it interpolates nothing.
 *
 * Checked in `pnpm verify` and in CI, so it cannot rot.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const composeFile = join(root, 'infra', 'docker-compose.yml');
const envExample = join(root, '.env.example');

for (const [label, file] of [
  ['infra/docker-compose.yml', composeFile],
  ['.env.example', envExample],
]) {
  if (!existsSync(file)) {
    console.error(`check-env-example: ${label} is missing`);
    process.exit(1);
  }
}

const compose = readFileSync(composeFile, 'utf8');
const example = readFileSync(envExample, 'utf8');

// Matches ${VAR}, ${VAR:-default} and ${VAR-default}.
const referenced = new Map();
for (const match of compose.matchAll(/\$\{([A-Z0-9_]+)(:?-[^}]*)?\}/g)) {
  const name = match[1];
  const hasDefault = Boolean(match[2]);
  // A variable is "safely defaulted" only if EVERY reference supplies a default.
  referenced.set(name, (referenced.get(name) ?? true) && hasDefault);
}

const documented = new Set(
  example
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim())
    .filter(Boolean),
);

const missing = [];
const undefaulted = [];

for (const [name, hasDefault] of referenced) {
  if (!documented.has(name)) missing.push({ name, hasDefault });
  if (!hasDefault) undefaulted.push(name);
}

let failed = false;

if (missing.length) {
  failed = true;
  console.error('Variables read by infra/docker-compose.yml but absent from .env.example:\n');
  for (const { name, hasDefault } of missing) {
    console.error(
      `  - ${name}${hasDefault ? '' : '   (no default — the stack breaks without it)'}`,
    );
  }
  console.error(
    '\nCompose does not error on an undefined variable; it substitutes an empty\n' +
      'string. Document each one in .env.example so a fresh clone starts correctly.',
  );
}

if (undefaulted.length) {
  failed = true;
  console.error(
    `\nCompose references without a default value: ${undefaulted.join(', ')}\n` +
      'Use ${VAR:-sensible-default} so `pnpm infra:up` works before anyone writes a .env.',
  );
}

if (failed) process.exit(1);

console.log(`check-env-example: ${referenced.size} compose variable(s) documented in .env.example`);
