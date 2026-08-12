#!/usr/bin/env node
/**
 * PreToolUse · Write | Edit | NotebookEdit
 *
 * Guards the invariants that are cheapest to enforce at the moment a file is written:
 *   1. never write secrets into the repo (.env, keys, certs)
 *   2. never declare an API payload type outside packages/contracts (I2)
 *   3. never hand-edit generated files
 *   4. never hand-write a review verdict — that would forge the merge gate
 */
import { allow, block, filePathOf, readPayload, relativePath } from './_lib.mjs';

const payload = await readPayload();
const absolute = filePathOf(payload);
if (!absolute) allow();

const path = relativePath(absolute);
const lower = path.toLowerCase();
const content = payload?.tool_input?.content ?? payload?.tool_input?.new_string ?? '';

// ---------------------------------------------------------------- 1 · secrets

if (/(^|\/)\.env($|\.)/.test(lower) && !lower.endsWith('.env.example')) {
  block(
    `BLOCKED: writing '${path}'.\n\n` +
      `.env files hold real credentials and must never be created or edited by an agent.\n` +
      `Document the variable in .env.example instead, and ask the user to fill in the value.`,
  );
}

if (
  /\.(pem|key|p12|pfx)$/.test(lower) ||
  /(^|\/)id_rsa/.test(lower) ||
  /(^|\/)secrets\//.test(lower)
) {
  block(`BLOCKED: writing credential material at '${path}'.`);
}

// ---------------------------------------------------------------- 2 · contracts belong in one place

const isAppSource = /^apps\/[^/]+\/.*\.(ts|tsx)$/.test(lower);
const isTest =
  /\.(spec|test|e2e-spec)\.tsx?$/.test(lower) || /(^|\/)(test|tests|__tests__)\//.test(lower);

if (isAppSource && !isTest && content) {
  // Heuristic, deliberately narrow: a type whose name reads like an API payload.
  const payloadType = content.match(
    /\b(?:export\s+)?(?:interface|type)\s+([A-Z]\w*(?:Dto|Request|Response|Payload|ApiResponse))\b/,
  );

  if (payloadType) {
    block(
      `BLOCKED: '${payloadType[1]}' declared in '${path}'.\n\n` +
        `API request/response shapes live in packages/contracts as Zod schemas, and\n` +
        `apps import the inferred type (SPEC.md I2, ADR-0002). A second declaration is\n` +
        `how the frontend and API silently drift apart.\n\n` +
        `Do this instead:\n` +
        `  1. define the schema in packages/contracts/src/<domain>.ts\n` +
        `  2. export it plus 'export type ${payloadType[1]} = z.infer<typeof ...>'\n` +
        `  3. import the type here from '@repo/contracts'\n\n` +
        `If this genuinely is a local view-model and not an API shape, name it so —\n` +
        `e.g. '${payloadType[1].replace(/(Dto|Request|Response|Payload|ApiResponse)$/, 'ViewModel')}'.`,
    );
  }
}

// ---------------------------------------------------------------- 3 · generated files

if (/\.generated\.(ts|tsx|js)$/.test(lower) || /(^|\/)generated\//.test(lower)) {
  block(
    `BLOCKED: '${path}' is generated.\n\n` +
      `Edit the source it is generated from and re-run the generator, otherwise the\n` +
      `change is silently reverted on the next build.`,
  );
}

if (/(^|\/)pnpm-lock\.yaml$/.test(lower)) {
  block(
    `BLOCKED: hand-editing pnpm-lock.yaml.\n\n` +
      `Change package.json and run 'pnpm install --reporter=append-only' so the\n` +
      `lockfile stays consistent with the registry.`,
  );
}

// ---------------------------------------------------------------- 4 · no forging the gate

if (/^\.claude\/state\/review-\d+\.json$/.test(lower)) {
  block(
    `BLOCKED: writing a review verdict with the Write/Edit tool.\n\n` +
      `Verdict files are the merge gate (ADR-0008). Hand-writing one would let\n` +
      `unreviewed code merge, which is the exact thing the gate exists to prevent.\n\n` +
      `Record a real pr-reviewer result through the recorder, which stamps the verdict\n` +
      `with the true current HEAD so a stale SHA cannot be recorded by mistake:\n\n` +
      `  node .claude/bin/record-verdict.mjs --pr <n> --verdict PASS --summary "..."`,
  );
}

allow();
