#!/usr/bin/env node
/**
 * Guarded database reset — the body of `pnpm db:reset`.
 *
 * Prisma 7 refuses `migrate reset` from an AI agent without explicit user consent
 * (PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION). The user granted that consent for
 * THIS PROJECT'S DEVELOPMENT DATABASES ONLY, in the conversation on 2026-08-12:
 *
 *   "Yes, dev DB only + guard (Recommended)"
 *
 * The guard half of that answer is this script: it hard-refuses to run against
 * anything that is not a loopback host, so even with consent supplied, a production
 * or remote URL can never be wiped by it. Do not widen the host allowlist — if a
 * remote database ever legitimately needs resetting, that decision belongs to a
 * human at a keyboard, not to this script.
 */
import { execFileSync } from 'node:child_process';

const FALLBACK_URL =
  'postgresql://ecommerce:ecommerce_dev_password@localhost:5442/ecommerce?schema=public';

const CONSENT = 'Yes, dev DB only + guard (Recommended)';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const url = process.env.DATABASE_URL ?? FALLBACK_URL;

let host;
try {
  host = new URL(url).hostname;
} catch {
  console.error(`db-reset: DATABASE_URL is not a parseable URL; refusing to reset.`);
  process.exit(1);
}

if (!LOOPBACK_HOSTS.has(host)) {
  console.error(
    `db-reset: refusing to reset a database on host "${host}".\n\n` +
      `This command irreversibly destroys ALL data in the target database. The user's\n` +
      `consent covers this project's local development stack and CI service containers\n` +
      `— loopback hosts only. If "${host}" is genuinely a disposable dev database,\n` +
      `reset it by hand; this script will not.`,
  );
  process.exit(1);
}

function prisma(args, extraEnv = {}) {
  // Prisma's JS entry, invoked with the current node — portable, and avoids
  // Windows' block on spawning .cmd shims without a shell.
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}

// Generate BEFORE reset: if reset auto-runs the seed (migrations.seed), the seed
// imports the generated client, which may not exist on a fresh clone.
prisma(['generate']);
prisma(['migrate', 'reset', '--force'], {
  PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: CONSENT,
});

console.log(`db-reset: ${host} reset and reseeded from empty`);
