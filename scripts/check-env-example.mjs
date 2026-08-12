#!/usr/bin/env node
/**
 * Fails if the compose stack reads an environment variable that `.env.example` does
 * not document (SPEC.md F2/AC4).
 *
 * This drifts silently and expensively: Compose does not error on an undefined
 * variable, it substitutes an empty string. Someone adds a reference, it works on
 * their machine because their own `.env` already has it, and the next person to run
 * `pnpm infra:up` gets a subtly broken stack with no message.
 *
 * Parses the YAML and walks every string value rather than regexing the raw file.
 * The earlier regex version silently passed `${VAR:?required}` — the one form whose
 * whole purpose is to be mandatory — along with unbraced `$VAR`, `${VAR:+alt}`,
 * nested defaults and lowercase names. A check with blind spots is worse than none,
 * because it reports green over exactly the cases it cannot see.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

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

const raw = readFileSync(composeFile, 'utf8');
const compose = parseYaml(raw);

/**
 * Every interpolation form Compose supports.
 *
 *   ${VAR}  ${VAR:-d}  ${VAR-d}  ${VAR:?err}  ${VAR?err}  ${VAR:+alt}  ${VAR+alt}  $VAR
 *
 * Only `:-` / `-` supply a fallback. `:?` is the opposite — it is mandatory — so it
 * must never be treated as safely defaulted.
 */
const BRACED = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+])?([^}]*)\}/g;
const BARE = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

const references = new Map(); // name -> { defaulted, required }

function note(name, operator) {
  const defaulted = operator === ':-' || operator === '-';
  const required = operator === ':?' || operator === '?';
  const previous = references.get(name);
  references.set(name, {
    defaulted: previous ? previous.defaulted && defaulted : defaulted,
    required: previous ? previous.required || required : required,
  });
}

function scanString(value) {
  // Nested defaults such as ${A:-${B}} need the inner reference too, so scan the
  // whole string for braced forms first, then the bare form on what is left.
  let remaining = value;
  for (const match of value.matchAll(BRACED)) {
    note(match[1], match[2]);
    if (match[3]) for (const inner of match[3].matchAll(BRACED)) note(inner[1], inner[2]);
    remaining = remaining.split(match[0]).join(' ');
  }
  for (const match of remaining.matchAll(BARE)) note(match[1], undefined);
}

const envFiles = [];

function walk(node, path = []) {
  if (typeof node === 'string') {
    scanString(node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, [...path, String(i)]));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'env_file') envFiles.push(path.join('.') || 'root');
      walk(value, [...path, key]);
    }
  }
}

walk(compose);

const documented = new Set(
  readFileSync(envExample, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim())
    .filter(Boolean),
);

const missing = [];
const undefaulted = [];

for (const [name, { defaulted, required }] of references) {
  if (!documented.has(name)) missing.push({ name, required });
  // A `${VAR:?}` reference is deliberately mandatory — not having a fallback is the
  // point, so it is not reported as undefaulted.
  if (!defaulted && !required) undefaulted.push(name);
}

let failed = false;

if (missing.length) {
  failed = true;
  console.error('Variables read by infra/docker-compose.yml but absent from .env.example:\n');
  for (const { name, required } of missing) {
    console.error(
      `  - ${name}${required ? '   (declared mandatory with :? — the stack will not start)' : ''}`,
    );
  }
  console.error(
    '\nCompose substitutes an empty string for an undefined variable rather than\n' +
      'erroring. Document each one in .env.example so a fresh clone starts correctly.',
  );
}

if (undefaulted.length) {
  failed = true;
  console.error(
    `\nCompose references with neither a default nor a :? guard: ${undefaulted.join(', ')}\n` +
      'Use ${VAR:-sensible-default} so `pnpm infra:up` works before anyone writes a .env,\n' +
      'or ${VAR:?why it is required} to fail loudly instead of silently substituting "".',
  );
}

// An env_file would feed variables this check cannot see, making it quietly vacuous
// while still printing a green line. Fail rather than mislead.
if (envFiles.length) {
  failed = true;
  console.error(
    `\ninfra/docker-compose.yml uses env_file (at: ${envFiles.join(', ')}).\n` +
      'This check only sees inline interpolation, so it would report green while\n' +
      'blind to everything that file supplies. Extend this script before adding one.',
  );
}

if (failed) process.exit(1);

console.log(`check-env-example: ${references.size} compose variable(s) documented in .env.example`);
