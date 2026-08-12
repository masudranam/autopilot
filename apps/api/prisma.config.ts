// Prisma 7: the CLI (migrate / db / validate) reads connection config from this file —
// `url = env(...)` inside schema.prisma is a validation error now. The runtime client
// does NOT read this; it gets a driver adapter in src/db/client.ts.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma db seed` runs this. tsx executes the TS directly — no build step.
    // Via `pnpm exec` because Prisma spawns the command WITHOUT node_modules/.bin on
    // PATH — bare `tsx` is "not recognized" on Windows and would be a silent
    // works-on-CI-only trap.
    seed: 'pnpm exec tsx prisma/seed.ts',
  },
  datasource: {
    // Local dev falls back to the compose stack's defaults so a fresh clone works
    // before anyone writes a .env. CI overrides with its own service container URL.
    url:
      process.env.DATABASE_URL ??
      'postgresql://ecommerce:ecommerce_dev_password@localhost:5442/ecommerce?schema=public',
  },
});
