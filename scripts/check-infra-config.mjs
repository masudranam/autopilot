#!/usr/bin/env node
/**
 * Regression test for the compose stack's shape, cross-checked against SPEC.md §3.
 *
 * F2/AC1–AC3 were verified by hand — bring the stack up, look at it, reset it, look
 * again. That proves it worked once on one machine and leaves nothing behind. Change
 * a published port, drop a healthcheck or delete a volume and nothing notices, because
 * CI uses GitHub service containers and never reads infra/docker-compose.yml at all.
 *
 * This is the artifact. It needs no Docker, so it runs in CI on every PR.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostPortOf, loadCompose, repoRoot as root } from './lib/compose.mjs';

const compose = loadCompose();
const spec = readFileSync(join(root, 'SPEC.md'), 'utf8');

const problems = [];

/** Services that must exist, and the volume each one persists to. */
const EXPECTED = {
  postgres: { volume: 'postgres-data', healthcheck: 'declared' },
  redis: { volume: 'redis-data', healthcheck: 'declared' },
  minio: { volume: 'minio-data', healthcheck: 'declared' },
  // Mailpit's image ships its own HEALTHCHECK, so compose declares none. Recorded
  // here so the exception is deliberate rather than an oversight nobody noticed.
  mailpit: { volume: null, healthcheck: 'from-image' },
};

const services = compose.services ?? {};

for (const [name, expected] of Object.entries(EXPECTED)) {
  const service = services[name];
  if (!service) {
    problems.push(`service "${name}" is missing from infra/docker-compose.yml`);
    continue;
  }

  if (expected.healthcheck === 'declared' && !service.healthcheck) {
    problems.push(
      `service "${name}" has no healthcheck — F2/AC1 requires healthchecks to pass, ` +
        'and without one compose reports it up the instant the process starts',
    );
  }

  if (expected.volume) {
    const mounts = (service.volumes ?? []).map((v) => String(v).split(':')[0]);
    if (!mounts.includes(expected.volume)) {
      problems.push(
        `service "${name}" no longer mounts "${expected.volume}" — data would not persist`,
      );
    }
    if (!compose.volumes || !(expected.volume in compose.volumes)) {
      problems.push(`top-level volume "${expected.volume}" is not declared`);
    }
  }

  if (!service.image) problems.push(`service "${name}" has no image`);

  // An unpinned :latest silently changes what the stack is on someone else's machine
  // or six months from now, which makes AC1 unreproducible.
  if (typeof service.image === 'string' && /:latest$/.test(service.image)) {
    problems.push(
      `service "${name}" uses "${service.image}" — pin a version so the stack is reproducible`,
    );
  }
}

for (const name of Object.keys(services)) {
  if (!(name in EXPECTED)) {
    problems.push(`service "${name}" is not in the expected set — add it here and to SPEC.md §3`);
  }
}

/**
 * Published host ports must match the SPEC §3 table exactly. This is the AC2 half
 * that can be checked statically: that the documented port and the real port agree.
 */
const SPEC_PORTS = {
  postgres: 5442,
  redis: 6389,
  mailpit: [1026, 8026],
  minio: [9010, 9011],
};

for (const [name, expected] of Object.entries(SPEC_PORTS)) {
  const service = services[name];
  if (!service) continue;

  const published = (service.ports ?? []).map(hostPortOf);

  for (const port of [expected].flat()) {
    if (!published.includes(port)) {
      problems.push(
        `service "${name}" does not publish host port ${port}, which SPEC.md §3 documents ` +
          `(publishes: ${published.join(', ') || 'nothing'})`,
      );
    }
  }

  if (!spec.includes(String(port0(expected)))) {
    problems.push(`SPEC.md §3 no longer mentions port ${port0(expected)} for ${name}`);
  }
}

function port0(expected) {
  return [expected].flat()[0];
}

if (problems.length) {
  console.error('infra/docker-compose.yml has drifted from SPEC.md §3:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nUpdate both together, or fix the drift.');
  process.exit(1);
}

console.log(
  `check-infra-config: ${Object.keys(services).length} services, ports and volumes match SPEC.md §3`,
);
