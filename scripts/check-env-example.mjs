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
 * The variable list comes from `docker compose config --variables --format json` —
 * Compose's OWN parser — not from re-implementing interpolation here. This file
 * previously did that twice, and each version had blind spots its green output hid:
 * the regex round missed `${VAR:?required}` outright, and the YAML-walking round
 * missed nested `${A:-${B}}` while false-positive-ing on the `$$` escape. An oracle
 * that ships with Compose cannot drift from what Compose actually does.
 */
import { execFileSync } from 'node:child_process';
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

let variables;
try {
  const out = execFileSync(
    'docker',
    ['compose', '-f', composeFile, 'config', '--variables', '--format', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  variables = Object.values(JSON.parse(out));
} catch (error) {
  // Fail closed. A check that quietly passes when its oracle is unavailable reports
  // green over exactly the drift it exists to catch.
  console.error(
    'check-env-example: could not run `docker compose config --variables`.\n' +
      'The check needs the Docker CLI (the daemon itself is not required for config).\n\n' +
      String(error.stderr || error.message)
        .trim()
        .split('\n')
        .slice(0, 3)
        .join('\n'),
  );
  process.exit(1);
}

if (variables.length === 0) {
  console.error(
    'check-env-example: Compose reports zero variables for infra/docker-compose.yml.\n' +
      'Every service in this stack is parameterised, so an empty result means the\n' +
      'oracle output changed shape — refusing to report success on it.',
  );
  process.exit(1);
}

const documented = new Set(
  readFileSync(envExample, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim())
    .filter(Boolean),
);

const missing = [];
const unguarded = [];

for (const variable of variables) {
  const name = variable.Name;
  const required = variable.Required === true;
  // AlternateValue is the `:+` form: unset deliberately means empty. DefaultValue
  // non-empty means `:-`/`-` supplied a fallback.
  const hasFallback = Boolean(variable.DefaultValue) || Boolean(variable.AlternateValue);

  if (!documented.has(name)) missing.push({ name, required });
  if (!hasFallback && !required) unguarded.push(name);
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

if (unguarded.length) {
  failed = true;
  console.error(
    `\nCompose references with neither a default nor a :? guard: ${unguarded.join(', ')}\n` +
      'Use ${VAR:-sensible-default} so `pnpm infra:up` works before anyone writes a .env,\n' +
      'or ${VAR:?why it is required} to fail loudly instead of silently substituting "".',
  );
}

if (failed) process.exit(1);

console.log(
  `check-env-example: ${variables.length} compose variable(s) documented in .env.example (via compose's own parser)`,
);
