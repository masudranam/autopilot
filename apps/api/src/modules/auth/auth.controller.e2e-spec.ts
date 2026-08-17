/**
 * POST /api/v1/auth/register end to end (SPEC.md F7, all four acceptance criteria).
 *
 * Real application wiring through `configureApp` — the same function main.ts calls —
 * and a real Postgres. Nothing about hashing, uniqueness or the error shape is mocked,
 * because every one of those is what an acceptance criterion is about.
 *
 * There is no cross-account probe here, and that is not an omission: F7 adds one
 * unauthenticated endpoint and no owned resource with a GET/PATCH/DELETE to probe. The
 * 404-not-403 rule (I4) gets its tests with the first owned resource, /me (F12).
 *
 * Cleanup is scoped to this suite's own email domain rather than truncating `users`.
 * Jest runs suites in parallel workers and the seed spec asserts on the two seeded
 * accounts; truncating would make the two suites fight over shared state, which is a
 * flaky green rather than a real one.
 */
import 'reflect-metadata';
import type { Server } from 'node:http';
import { verify } from '@node-rs/argon2';
import { type INestApplication } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { problemDetailsSchema, ProblemType, registeredUserSchema } from '@repo/contracts';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { REQUIRES_AUTH_KEY } from '../../common/auth/authenticated.decorator';
import { IS_PUBLIC_KEY } from '../../common/auth/public.decorator';
import { validateEnv } from '../../config/env';
import { createPrismaClient, type PrismaClient } from '../../db/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuthController } from './auth.controller';
import { PasswordHasher } from './password/password-hasher';

const REGISTER = '/api/v1/auth/register';

/** Every address this suite creates ends here, so cleanup can be exact. */
const TEST_DOMAIN = '@f7-registration.test';

const PASSWORD = 'marmalade-tuesday-gantry';

function payload(local: string, overrides: Record<string, unknown> = {}) {
  return {
    email: `${local}${TEST_DOMAIN}`,
    password: PASSWORD,
    firstName: 'Ada',
    lastName: 'Lovelace',
    ...overrides,
  };
}

async function listen(app: INestApplication): Promise<void> {
  // Bind once up front: letting parallel supertest calls each bind the server races
  // and produces ECONNRESET under load (the same fix as the F5 suite).
  const server = app.getHttpServer() as Server;
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
  }
}

async function removeTestUsers(prisma: PrismaClient): Promise<void> {
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
}

describe('POST /auth/register', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, validateEnv({}));
    await app.init();
    await listen(app);

    prisma = app.get(PrismaService).client;
  });

  beforeEach(async () => {
    await removeTestUsers(prisma);
  });

  afterAll(async () => {
    await removeTestUsers(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ AC1

  it('creates the user with an Argon2id-hashed password (AC1)', async () => {
    const body = payload('ada');
    const response = await request(app.getHttpServer()).post(REGISTER).send(body).expect(201);

    const created = registeredUserSchema.parse(response.body);
    expect(created.email).toBe(body.email);

    const row = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    expect(row.id).toBe(created.id);
    expect(row.role).toBe('CUSTOMER');
    expect(row.emailVerifiedAt).toBeNull();

    // Argon2**id**, at the ADR-0009 cost, and a hash that actually verifies — the
    // three things that separate a stored credential from a stored string.
    expect(row.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(verify(row.passwordHash, PASSWORD)).resolves.toBe(true);
    await expect(verify(row.passwordHash, `${PASSWORD}-not`)).resolves.toBe(false);
  });

  it('salts: two accounts with the same password get different hashes (AC1)', async () => {
    await request(app.getHttpServer()).post(REGISTER).send(payload('salt-one')).expect(201);
    await request(app.getHttpServer()).post(REGISTER).send(payload('salt-two')).expect(201);

    const rows = await prisma.user.findMany({
      where: { email: { endsWith: TEST_DOMAIN } },
      select: { passwordHash: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.passwordHash).not.toBe(rows[1]?.passwordHash);
  });

  it('never returns password material', async () => {
    const response = await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('quiet'))
      .expect(201);

    expect(Object.keys(response.body as object).sort()).toEqual([
      'createdAt',
      'email',
      'firstName',
      'id',
      'lastName',
    ]);
    expect(response.text).not.toContain(PASSWORD);
    expect(response.text.toLowerCase()).not.toContain('argon2');
    expect(response.text.toLowerCase()).not.toContain('hash');
  });

  // ------------------------------------------------------------------ AC2

  it('rejects a password below the minimum length with a per-field 422 (AC2)', async () => {
    const response = await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('short', { password: 'elevenchars' }))
      .expect(422);

    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.type).toBe(ProblemType.VALIDATION_FAILED);
    expect(problem.errors?.map((error) => error.path)).toEqual(['password']);
    expect(problem.errors?.[0]?.message).toContain('12');

    expect(await prisma.user.count({ where: { email: { endsWith: TEST_DOMAIN } } })).toBe(0);
  });

  /**
   * The RAW body, deliberately not parsed first.
   *
   * `problemDetailsSchema` and `fieldErrorSchema` are both `z.object`, so `.parse()`
   * STRIPS any key the contract does not declare. Every assertion made on the parsed
   * value is therefore blind to exactly the thing "no leak" is about — this is how F5
   * ended up with eighteen leak assertions that could not fail. A 422 is the response
   * that has the rejected value closest to hand, so it is the one worth pinning.
   */
  it('carries only {path,message} per field error, and never echoes the value (AC2)', async () => {
    const submitted = 's3cret-pw';

    const response = await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('raw-shape', { password: submitted }))
      .expect(422);

    const raw = response.body as Record<string, unknown> & {
      errors?: Record<string, unknown>[];
    };

    expect(Object.keys(raw).sort()).toEqual([
      'detail',
      'errors',
      'instance',
      'status',
      'title',
      'traceId',
      'type',
    ]);

    expect(raw.errors).toHaveLength(1);
    for (const entry of raw.errors ?? []) {
      // Not `toMatchObject` — an extra `received`/`input`/`expected` key added by a
      // future refactor of the validation pipe has to fail here.
      expect(Object.keys(entry).sort()).toEqual(['message', 'path']);
    }
    expect(raw.errors?.[0]?.path).toBe('password');

    // The submitted password must not come back on the wire under any key at all.
    expect(response.text).not.toContain(submitted);
  });

  it('rejects a common password even when it is long enough, same 422 shape (AC2)', async () => {
    const response = await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('common', { password: 'correcthorsebatterystaple' }))
      .expect(422);

    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.type).toBe(ProblemType.VALIDATION_FAILED);
    expect(problem.errors).toEqual([{ path: 'password', message: expect.any(String) }]);
    // The list is what rejected it: it is 25 characters, well past the length rule.
    expect(await prisma.user.count({ where: { email: { endsWith: TEST_DOMAIN } } })).toBe(0);
  });

  it('reports every invalid field at once, not just the first (AC2)', async () => {
    const response = await request(app.getHttpServer())
      .post(REGISTER)
      .send({ email: 'not-an-email', password: 'short', firstName: '', lastName: '  ' })
      .expect(422);

    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.errors?.map((error) => error.path).sort()).toEqual([
      'email',
      'firstName',
      'lastName',
      'password',
    ]);
  });

  it('rejects missing fields (AC2)', async () => {
    const response = await request(app.getHttpServer()).post(REGISTER).send({}).expect(422);
    expect(
      problemDetailsSchema
        .parse(response.body)
        .errors?.map((e) => e.path)
        .sort(),
    ).toEqual(['email', 'firstName', 'lastName', 'password']);
  });

  it('rejects oversized input rather than hashing it', async () => {
    const response = await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('huge', { password: 'x'.repeat(5_000) }))
      .expect(422);

    expect(problemDetailsSchema.parse(response.body).errors?.[0]?.path).toBe('password');
  });

  it('rejects an unknown field instead of ignoring it — no role escalation (AC2)', async () => {
    await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('escalate', { role: 'ADMIN' }))
      .expect(422);

    expect(await prisma.user.count({ where: { email: { endsWith: TEST_DOMAIN } } })).toBe(0);
  });

  // ------------------------------------------------------------------ AC3

  it('answers 409 for a duplicate, without echoing the address (AC3)', async () => {
    const body = payload('taken');
    await request(app.getHttpServer()).post(REGISTER).send(body).expect(201);

    const response = await request(app.getHttpServer()).post(REGISTER).send(body).expect(409);

    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.type).toBe(ProblemType.CONFLICT);
    expect(problem.status).toBe(409);
    // The status concedes that this address is taken; the body does not have to carry
    // it into every log aggregator and error tracker as well.
    //
    // Asserted against `response.text` — the bytes on the wire — and NOT against
    // `problem`. `problemDetailsSchema` is a `z.object` and strips unknown keys, so
    // `JSON.stringify(problem)` cannot see an address leaked under a key the contract
    // does not declare, which is precisely the failure being guarded against.
    expect(response.text).not.toContain('taken@');
    expect(response.text).not.toContain(body.email);
    expect(problem.detail).not.toContain(body.email);

    expect(await prisma.user.count({ where: { email: body.email } })).toBe(1);
  });

  it('hashes on the duplicate path too — no cheap early return (AC3)', async () => {
    const body = payload('spied');
    await request(app.getHttpServer()).post(REGISTER).send(body).expect(201);

    // Deterministic counterpart to the timing test below: the expensive work is
    // observed to happen, rather than inferred from a stopwatch.
    const spy = jest.spyOn(app.get(PasswordHasher), 'hash');
    try {
      await request(app.getHttpServer()).post(REGISTER).send(body).expect(409);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(PASSWORD);
    } finally {
      spy.mockRestore();
    }
  });

  it('takes comparable wall-clock time whether or not the address exists (AC3)', async () => {
    const taken = payload('timing-taken');
    await request(app.getHttpServer()).post(REGISTER).send(taken).expect(201);

    const fresh: number[] = [];
    const duplicate: number[] = [];

    // Interleaved so any drift in machine load hits both samples equally.
    for (let i = 0; i < 5; i += 1) {
      fresh.push(await time(payload(`timing-fresh-${i}`), 201));
      duplicate.push(await time(taken, 409));
    }

    const freshMedian = median(fresh);
    const duplicateMedian = median(duplicate);

    // Calibrate the floor against THIS machine rather than a fixed millisecond count:
    // one Argon2id hash at the configured cost, measured here and now.
    //
    // The previous absolute bound was `duplicateMedian > 10`, and it could not fail.
    // Measured with the existence check reintroduced, the duplicate path still takes
    // ~12.4 ms end to end (HTTP, routing, validation and a round trip to Postgres are
    // not free), so `> 10` passed with the enumeration oracle wide open — and on a
    // slower runner it passes by an even wider margin, because the bound is fixed
    // while the measurement scales. Expressed as a multiple of the hash cost it
    // scales with the machine and it binds: ~12 ms against a ~30 ms hash fails.
    const hasher = app.get(PasswordHasher);
    const hashCosts: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const start = process.hrtime.bigint();
      await hasher.hash(`calibration-${i}-${PASSWORD}`);
      hashCosts.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    const hashCost = median(hashCosts);

    // Both bounds are deliberately loose — this is a regression detector, not a
    // constant-time proof — and both are ratios, so machine speed and CI jitter move
    // numerator and denominator together instead of eating the margin.
    expect(duplicateMedian).toBeGreaterThan(hashCost * 0.75);
    expect(duplicateMedian).toBeGreaterThan(freshMedian * 0.4);
  });

  async function time(body: Record<string, unknown>, expected: number): Promise<number> {
    const start = process.hrtime.bigint();
    await request(app.getHttpServer()).post(REGISTER).send(body).expect(expected);
    return Number(process.hrtime.bigint() - start) / 1e6;
  }

  function median(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
  }

  // ------------------------------------------------------------------ AC4

  it('normalises the email — trimmed, lower-cased, echoed back canonical (AC4)', async () => {
    const response = await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('x', { email: `  MiXeD.CaSe${TEST_DOMAIN.toUpperCase()}  ` }))
      .expect(201);

    const created = registeredUserSchema.parse(response.body);
    expect(created.email).toBe(`mixed.case${TEST_DOMAIN}`);

    const row = await prisma.user.findUniqueOrThrow({ where: { email: created.email } });
    expect(row.email).toBe(`mixed.case${TEST_DOMAIN}`);
  });

  it('treats A@B and a@b as the same account (AC4)', async () => {
    await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('x', { email: `Case.Test${TEST_DOMAIN}` }))
      .expect(201);

    await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('x', { email: `case.test${TEST_DOMAIN}` }))
      .expect(409);

    await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('x', { email: `  CASE.TEST${TEST_DOMAIN.toUpperCase()}  ` }))
      .expect(409);

    expect(await prisma.user.count({ where: { email: { endsWith: TEST_DOMAIN } } })).toBe(1);
  });

  it('keeps plus-tags and dots distinct — a documented decision, not an oversight (AC4)', async () => {
    // See email-normalisation.ts: folding these is provider-specific and would let
    // whoever registers first deny another person their own address.
    await request(app.getHttpServer()).post(REGISTER).send(payload('tagged')).expect(201);
    await request(app.getHttpServer())
      .post(REGISTER)
      .send(payload('x', { email: `tagged+shop${TEST_DOMAIN}` }))
      .expect(201);

    expect(await prisma.user.count({ where: { email: { endsWith: TEST_DOMAIN } } })).toBe(2);
  });

  // ------------------------------------------- the race the index has to win (AC3/AC4)

  it('creates exactly one account when six identical registrations run in parallel', async () => {
    const body = payload('stampede');

    // Promise.all, not a loop: a sequential version passes even when the check-then-
    // insert race is wide open, which is the whole failure mode being tested.
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(app.getHttpServer()).post(REGISTER).send(body)),
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);

    expect(await prisma.user.count({ where: { email: body.email } })).toBe(1);

    // Every loser is a clean 409, not a 500 from an unhandled constraint violation.
    for (const response of responses.filter((r) => r.status === 409)) {
      expect(problemDetailsSchema.parse(response.body).type).toBe(ProblemType.CONFLICT);
    }
  });

  // ------------------------------------------------------------------ I5

  it('carries an explicit authorisation decision (I5)', () => {
    // Read through the descriptor rather than naming the method: `SetMetadata` puts
    // the metadata on the handler function itself, and an unbound method reference is
    // a lint error here.
    const handler: unknown = Object.getOwnPropertyDescriptor(
      AuthController.prototype,
      'register',
    )?.value;
    expect(typeof handler).toBe('function');

    const explicit: unknown = Reflect.getMetadata(IS_PUBLIC_KEY, handler as object);
    // Registration cannot require a token, but "open" has to be a decision on the
    // handler rather than the absence of one. F10 adds the guard that reads this.
    expect(explicit).toBe(true);
  });

  /**
   * The invariant, not one instance of it.
   *
   * The test above only watches `AuthController.register`. Removing `@Public()` from
   * either health probe was verified to leave the ENTIRE suite green, so until F10's
   * guard lands the marker is inert metadata on every route but one — which is not I5
   * coverage, it is one hard-coded assertion.
   *
   * This sweeps every controller Nest actually registered and requires an explicit
   * decision on each route, so a route added without one fails here regardless of
   * which module it lands in. When F10 adds `@Roles()`, the set of accepted decisions
   * widens — the assertion does not.
   */
  it('every registered route carries an explicit authorisation decision (I5)', () => {
    const scanner = new MetadataScanner();
    const routes: string[] = [];
    const undecided: string[] = [];

    for (const module of app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const instance = wrapper.instance as object | null;
        if (!instance) continue;

        const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
        for (const methodName of scanner.getAllMethodNames(prototype)) {
          const handler = prototype[methodName];
          if (typeof handler !== 'function') continue;
          // `@Get`/`@Post`/... is what makes a method a route; a plain helper on the
          // controller has no HTTP method metadata and is not one.
          if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;

          const name = `${wrapper.metatype?.name ?? wrapper.name}.${methodName}`;
          routes.push(name);
          // EITHER marker counts, neither does not. Before F9 the only accepted answer
          // was `@Public()`, which was fine while every route was public and actively
          // dangerous the moment one was not: the cheapest way to green this test would
          // have been to mark the session list public. What I5 asserts is that a
          // decision was made, not which one.
          const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
          const requiresAuth = Reflect.getMetadata(REQUIRES_AUTH_KEY, handler) === true;
          if (!isPublic && !requiresAuth) undecided.push(name);
        }
      }
    }

    // Non-vacuity guard only: a broken enumeration would otherwise pass this test by
    // inspecting zero routes. Deliberately NOT an exact list of route names — that
    // would break on every future feature that adds a correctly-decorated route, and
    // the property worth asserting is the one below.
    expect(routes).toContain('AuthController.register');
    expect(routes.length).toBeGreaterThanOrEqual(3);

    expect(undecided).toEqual([]);
  });
});

/**
 * The statement count for the endpoint.
 *
 * Registration is a write, not a list, so this is not an N+1 guard — it is the
 * structural half of AC3. One statement on the happy path and one on the duplicate
 * path is what "the unique index decides, not a prior SELECT" looks like from the
 * database's side, and a reintroduced existence check shows up here as two.
 */
describe('registration issues exactly one database statement (AC3)', () => {
  let app: INestApplication;
  let raw: PrismaClient;
  const operations: string[] = [];

  beforeAll(async () => {
    raw = createPrismaClient();

    const counting = raw.$extends({
      query: {
        $allModels: {
          $allOperations({ model, operation, args, query }) {
            operations.push(`${model}.${operation}`);
            return query(args);
          },
        },
      },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        client: counting,
        ping: () => raw.$queryRaw`SELECT 1`,
        onModuleInit: () => raw.$connect(),
        onModuleDestroy: () => Promise.resolve(),
      })
      .compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, validateEnv({}));
    await app.init();
    await listen(app);
  });

  beforeEach(async () => {
    await removeTestUsers(raw);
    operations.length = 0;
  });

  afterAll(async () => {
    await removeTestUsers(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('performs one write and no read on the happy path', async () => {
    operations.length = 0;
    await request(app.getHttpServer()).post(REGISTER).send(payload('counted')).expect(201);
    expect(operations).toEqual(['User.create']);
  });

  it('performs the same single statement when the address is already taken', async () => {
    await request(app.getHttpServer()).post(REGISTER).send(payload('counted-dup')).expect(201);

    operations.length = 0;
    await request(app.getHttpServer()).post(REGISTER).send(payload('counted-dup')).expect(409);
    expect(operations).toEqual(['User.create']);
  });
});
