#!/usr/bin/env node
/**
 * Fails if a port this stack publishes is already held by something else.
 *
 * This exists because the failure it catches is completely silent. `docker compose up`
 * exits 0 when a host port is taken, advertises the mapping in `ps`, and the container
 * reports `(healthy)` — because every healthcheck in the file is container-internal
 * (`redis-cli ping`, `pg_isready`, `mc ready local`) and passes happily while the
 * published port routes to the squatter instead.
 *
 * Demonstrated during review of PR #59: with a process holding 6389, the stack came up
 * "healthy" and a host-side probe returned the squatter's banner, not Redis.
 *
 * Runs before `infra:up`, so the collision is reported instead of discovered later as
 * an inexplicable connection error.
 */
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { publishedPorts, repoRoot as root } from './lib/compose.mjs';

const ports = publishedPorts();

// A parser that silently finds nothing would make this check pass unconditionally,
// which is exactly how it failed the first time it was written.
if (ports.length === 0) {
  console.error(
    'check-ports: parsed zero published ports from infra/docker-compose.yml.\n' +
      'That is a parsing failure, not an empty stack — refusing to report success.',
  );
  process.exit(1);
}

/** Ports already published by this stack's own running containers are fine. */
function oursAlready() {
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-f', 'infra/docker-compose.yml', 'ps', '--format', '{{.Publishers}}'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 },
    );
    return new Set([...out.matchAll(/(\d+)->/g)].map((m) => Number(m[1])));
  } catch {
    // Docker not running, or the stack is down. Nothing of ours is bound.
    return new Set();
  }
}

const mine = oursAlready();

function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    // 0.0.0.0 — the same interface Docker publishes on. Binding only 127.0.0.1 would
    // miss a squatter bound to a specific external address.
    server.listen(port, '0.0.0.0');
  });
}

const taken = [];
for (const { service, port } of ports) {
  if (mine.has(port)) continue;
  if (!(await isFree(port))) taken.push({ service, port });
}

if (taken.length) {
  console.error('Ports this stack needs are already in use:\n');
  for (const { service, port } of taken) console.error(`  - ${port} (${service})`);
  console.error(
    '\nStarting anyway would appear to work: compose exits 0, the container reports\n' +
      '(healthy), and connections from the host silently reach the other process.\n\n' +
      'Free the port, or change it in BOTH .env and infra/docker-compose.yml.\n' +
      'Do not take 5432, 5433 or 4200 — those belong to other projects on this machine.',
  );
  process.exit(1);
}

console.log(`check-ports: ${ports.length} published port(s) available`);
