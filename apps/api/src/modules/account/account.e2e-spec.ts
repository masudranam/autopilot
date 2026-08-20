/**
 * Profile and address book end to end (SPEC.md F12, all three criteria).
 *
 * F12 adds the project's first owned resource with a FULL set of verbs, so AC3's
 * cross-account probe runs on every one of them — GET, PATCH and DELETE — each
 * asserting 404 rather than 403, and each asserting the victim's row survives. F9
 * established the pattern on a single verb; this is where it is exercised properly.
 */
import 'reflect-metadata';
import type { Server } from 'node:http';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  addressListSchema,
  addressSchema,
  MAX_ADDRESSES_PER_ACCOUNT,
  problemDetailsSchema,
  ProblemType,
  profileSchema,
} from '@repo/contracts';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { validateEnv } from '../../config/env';
import { createPrismaClient, type PrismaClient } from '../../db/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

const REGISTER = '/api/v1/auth/register';
const LOGIN = '/api/v1/auth/login';
const ME = '/api/v1/me';
const ADDRESSES = '/api/v1/me/addresses';

const TEST_DOMAIN = '@f12-account.test';
const PASSWORD = 'marmalade-tuesday-gantry';
const OWNER = `owner${TEST_DOMAIN}`;
const OTHER = `bystander${TEST_DOMAIN}`;

function addressBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'SHIPPING',
    fullName: 'Ada Lovelace',
    line1: '12 Analytical Way',
    city: 'London',
    postalCode: 'EC1A 1BB',
    country: 'GB',
    ...overrides,
  };
}

async function listen(app: INestApplication): Promise<void> {
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

describe('F12 · profile and addresses', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let ownerToken = '';
  let otherToken = '';

  async function signUpAndIn(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post(REGISTER)
      .send({ email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' })
      .expect(201);
    const response = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  /** Creates an address for the given token and returns the parsed body. */
  async function createAddress(token: string, overrides: Record<string, unknown> = {}) {
    const response = await request(app.getHttpServer())
      .post(ADDRESSES)
      .set('Authorization', `Bearer ${token}`)
      .send(addressBody(overrides))
      .expect(201);
    return addressSchema.parse(response.body);
  }

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
    ownerToken = await signUpAndIn(OWNER);
    otherToken = await signUpAndIn(OTHER);
  });

  afterAll(async () => {
    await removeTestUsers(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ AC1

  it('GET /me returns the caller’s own profile (AC1)', async () => {
    const response = await request(app.getHttpServer())
      .get(ME)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const profile = profileSchema.parse(response.body);
    expect(profile.email).toBe(OWNER);
    expect(profile.role).toBe('CUSTOMER');
    expect(profile.emailVerifiedAt).toBeNull();
  });

  it('GET /me never returns password material (AC1)', async () => {
    const response = await request(app.getHttpServer())
      .get(ME)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    // The RAW body: profileSchema is z.object and would strip an added key before any
    // assertion could see it — the F5 lesson.
    expect(Object.keys(response.body as object).sort()).toEqual([
      'createdAt',
      'email',
      'emailVerifiedAt',
      'firstName',
      'id',
      'lastName',
      'role',
    ]);
    expect(response.text.toLowerCase()).not.toContain('argon2');
    expect(response.text.toLowerCase()).not.toContain('passwordhash');
  });

  it('PATCH /me updates the name and persists it (AC1)', async () => {
    const response = await request(app.getHttpServer())
      .patch(ME)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ firstName: 'Grace' })
      .expect(200);

    expect(profileSchema.parse(response.body).firstName).toBe('Grace');

    const row = await prisma.user.findUniqueOrThrow({ where: { email: OWNER } });
    expect(row.firstName).toBe('Grace');
    // Unnamed fields are untouched — a PATCH is not a replace.
    expect(row.lastName).toBe('Lovelace');
  });

  it('PATCH /me rejects an unknown field rather than ignoring it — no role escalation (AC1)', async () => {
    await request(app.getHttpServer())
      .patch(ME)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'ADMIN' })
      .expect(422);

    await request(app.getHttpServer())
      .patch(ME)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'someone-else@example.com' })
      .expect(422);

    const row = await prisma.user.findUniqueOrThrow({ where: { email: OWNER } });
    expect(row.role).toBe('CUSTOMER');
    expect(row.email).toBe(OWNER);
  });

  it('PATCH /me rejects an empty body (AC1)', async () => {
    await request(app.getHttpServer())
      .patch(ME)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
      .expect(422);
  });

  // ------------------------------------------------------------------ AC2

  it('creates, lists, reads, updates and deletes an address (AC2)', async () => {
    const created = await createAddress(ownerToken, { city: 'Bristol' });
    expect(created.isDefault).toBe(false);

    const listed = addressListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(ADDRESSES)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200)
      ).body,
    );
    expect(listed.map((a) => a.id)).toEqual([created.id]);

    const fetched = addressSchema.parse(
      (
        await request(app.getHttpServer())
          .get(`${ADDRESSES}/${created.id}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200)
      ).body,
    );
    expect(fetched.city).toBe('Bristol');

    const updated = addressSchema.parse(
      (
        await request(app.getHttpServer())
          .patch(`${ADDRESSES}/${created.id}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ city: 'Bath' })
          .expect(200)
      ).body,
    );
    expect(updated.city).toBe('Bath');
    expect(updated.line1).toBe('12 Analytical Way');

    await request(app.getHttpServer())
      .delete(`${ADDRESSES}/${created.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(204);

    await request(app.getHttpServer())
      .get(`${ADDRESSES}/${created.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
  });

  it('holds one default per kind, and a new default displaces the old (AC2)', async () => {
    const first = await createAddress(ownerToken, { isDefault: true });
    const second = await createAddress(ownerToken, { isDefault: true, city: 'Leeds' });

    const listed = addressListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(ADDRESSES)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200)
      ).body,
    );

    expect(listed.filter((a) => a.isDefault).map((a) => a.id)).toEqual([second.id]);
    expect(listed.find((a) => a.id === first.id)?.isDefault).toBe(false);
  });

  it('keeps a shipping default and a billing default at the same time (AC2)', async () => {
    await createAddress(ownerToken, { kind: 'SHIPPING', isDefault: true });
    await createAddress(ownerToken, { kind: 'BILLING', isDefault: true });

    const listed = addressListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(ADDRESSES)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200)
      ).body,
    );

    const defaults = listed.filter((a) => a.isDefault);
    expect(defaults).toHaveLength(2);
    expect(defaults.map((a) => a.kind).sort()).toEqual(['BILLING', 'SHIPPING']);
  });

  it('promotes an existing address to default via PATCH (AC2)', async () => {
    const first = await createAddress(ownerToken, { isDefault: true });
    const second = await createAddress(ownerToken, { city: 'Leeds' });

    await request(app.getHttpServer())
      .patch(`${ADDRESSES}/${second.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isDefault: true })
      .expect(200);

    const listed = addressListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(ADDRESSES)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200)
      ).body,
    );
    expect(listed.filter((a) => a.isDefault).map((a) => a.id)).toEqual([second.id]);
    expect(listed.find((a) => a.id === first.id)?.isDefault).toBe(false);
  });

  /**
   * THE RACE THE PARTIAL UNIQUE INDEX EXISTS FOR (AC2).
   *
   * Six parallel creates all claiming the shipping default. Without the index each one
   * clears the current default and inserts its own, and several commit — leaving an
   * account with multiple defaults and checkout with no way to choose. `Promise.all`
   * rather than a loop: a sequential version passes with the bug present.
   *
   * Exactly one default must survive. Losers are either refused as a conflict or
   * inserted non-default; both are acceptable outcomes, and neither is "two defaults".
   */
  it('cannot end up with two defaults when six creates race (AC2)', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        request(app.getHttpServer())
          .post(ADDRESSES)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send(addressBody({ isDefault: true, city: `City ${index}` })),
      ),
    );

    // No 500s: a losing race is a conflict the API states, not a crash.
    for (const response of responses) {
      expect([201, 409]).toContain(response.status);
    }

    const owner = await prisma.user.findUniqueOrThrow({ where: { email: OWNER } });
    const defaults = await prisma.address.count({
      where: { userId: owner.id, kind: 'SHIPPING', isDefault: true },
    });
    expect(defaults).toBe(1);
  });

  /**
   * A NUL byte used to reach Postgres and surface as an unhandled 500 (security review
   * of PR #95): `22021 invalid byte sequence for encoding "UTF8"`. The edge is where
   * that has to stop (I2), so every text field refuses control characters.
   */
  it('rejects a control character in an address field rather than 500ing (AC2)', async () => {
    const nul = String.fromCharCode(0);
    for (const field of ['fullName', 'line1', 'city', 'postalCode']) {
      const response = await request(app.getHttpServer())
        .post(ADDRESSES)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(addressBody({ [field]: `bad${nul}value` }));
      expect(response.status).toBe(422);
    }
  });

  it('rejects a control character in a profile name rather than 500ing (AC1)', async () => {
    const nul = String.fromCharCode(0);
    await request(app.getHttpServer())
      .patch(ME)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ firstName: `Ev${nul}e` })
      .expect(422);
    // A newline is refused too: a name is a single-line value.
    await request(app.getHttpServer())
      .patch(ME)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ firstName: `Ada${String.fromCharCode(10)}Lovelace` })
      .expect(422);
  });

  it('caps how many addresses one account may hold (AC2)', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: OWNER } });
    // Seeded directly to the cap — going through the endpoint 50 times would test the
    // endpoint's speed rather than the cap.
    await prisma.address.createMany({
      data: Array.from({ length: MAX_ADDRESSES_PER_ACCOUNT }, (_, index) => ({
        userId: owner.id,
        kind: 'SHIPPING' as const,
        isDefault: false,
        fullName: 'Ada',
        line1: `${index} Road`,
        city: 'London',
        postalCode: 'X',
        country: 'GB',
      })),
    });

    const response = await request(app.getHttpServer())
      .post(ADDRESSES)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(addressBody({ city: 'One too many' }))
      .expect(409);

    expect(problemDetailsSchema.parse(response.body).type).toBe(ProblemType.CONFLICT);
    expect(await prisma.address.count({ where: { userId: owner.id } })).toBe(
      MAX_ADDRESSES_PER_ACCOUNT,
    );
  });

  it('rejects a malformed country code (AC2)', async () => {
    await request(app.getHttpServer())
      .post(ADDRESSES)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(addressBody({ country: 'GBR' }))
      .expect(422);
  });

  it('rejects an unknown field on create (AC2)', async () => {
    await request(app.getHttpServer())
      .post(ADDRESSES)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(addressBody({ userId: 'someone-else' }))
      .expect(422);
  });

  it('answers 422 for a malformed address id (AC2)', async () => {
    await request(app.getHttpServer())
      .get(`${ADDRESSES}/not-a-uuid`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(422);
  });

  // ------------------------------------------------------------------ AC3

  /**
   * THE CROSS-ACCOUNT PROBE, ON EVERY VERB (AC3, I4).
   *
   * 404 and not 403 — a 403 confirms the id names a real address, which is the
   * existence leak the invariant exists to prevent. Each case also asserts the victim's
   * row is untouched afterwards, so a refusal cannot be a silent success.
   */
  it('answers 404 — not 403 — on GET, PATCH and DELETE of another account’s address (AC3)', async () => {
    const victim = await createAddress(otherToken, { city: 'Theirs' });

    const cases = [
      request(app.getHttpServer())
        .get(`${ADDRESSES}/${victim.id}`)
        .set('Authorization', `Bearer ${ownerToken}`),
      request(app.getHttpServer())
        .patch(`${ADDRESSES}/${victim.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ city: 'Hijacked' }),
      request(app.getHttpServer())
        .delete(`${ADDRESSES}/${victim.id}`)
        .set('Authorization', `Bearer ${ownerToken}`),
    ];

    for (const call of cases) {
      const response = await call.expect(404);
      // DELETE answers 204 with no body on success, so only parse when there is one.
      if (response.text) {
        const problem = problemDetailsSchema.parse(response.body);
        expect(problem.status).toBe(404);
        expect(problem.type).toBe(ProblemType.NOT_FOUND);
      }
    }

    // Untouched, and still the victim's: the refusals changed nothing.
    const stillThere = addressSchema.parse(
      (
        await request(app.getHttpServer())
          .get(`${ADDRESSES}/${victim.id}`)
          .set('Authorization', `Bearer ${otherToken}`)
          .expect(200)
      ).body,
    );
    expect(stillThere.city).toBe('Theirs');
  });

  it('a nonexistent id and another account’s id are indistinguishable (AC3)', async () => {
    const victim = await createAddress(otherToken);

    const foreign = await request(app.getHttpServer())
      .get(`${ADDRESSES}/${victim.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);

    const missing = await request(app.getHttpServer())
      .get(`${ADDRESSES}/00000000-0000-7000-8000-000000000000`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);

    const strip = (body: unknown) => {
      const { traceId, instance, ...rest } = body as Record<string, unknown>;
      void traceId;
      void instance;
      return rest;
    };
    expect(strip(foreign.body)).toEqual(strip(missing.body));
  });

  it('the list never contains another account’s addresses (AC3)', async () => {
    await createAddress(otherToken, { city: 'Theirs' });
    await createAddress(ownerToken, { city: 'Mine' });

    const listed = addressListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(ADDRESSES)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200)
      ).body,
    );
    expect(listed.map((a) => a.city)).toEqual(['Mine']);
  });

  it('every account route requires a token', async () => {
    await request(app.getHttpServer()).get(ME).expect(401);
    await request(app.getHttpServer()).patch(ME).send({ firstName: 'X' }).expect(401);
    await request(app.getHttpServer()).get(ADDRESSES).expect(401);
    await request(app.getHttpServer()).post(ADDRESSES).send(addressBody()).expect(401);
    await request(app.getHttpServer())
      .get(`${ADDRESSES}/00000000-0000-7000-8000-000000000000`)
      .expect(401);
    await request(app.getHttpServer())
      .patch(`${ADDRESSES}/00000000-0000-7000-8000-000000000000`)
      .send({ city: 'X' })
      .expect(401);
    await request(app.getHttpServer())
      .delete(`${ADDRESSES}/00000000-0000-7000-8000-000000000000`)
      .expect(401);
  });
});

/**
 * The statement count for the list endpoint (§ Testing).
 *
 * `GET /me/addresses` is a list endpoint, so it needs an N+1 guard: one SELECT whatever
 * the number of addresses. A per-row lookup added later to decorate each entry shows up
 * here immediately.
 */
describe('listing addresses issues exactly one statement', () => {
  let app: INestApplication;
  let raw: PrismaClient;
  const operations: string[] = [];

  beforeAll(async () => {
    raw = createPrismaClient().$extends({
      query: {
        $allModels: {
          $allOperations({ model, operation, args, query }) {
            operations.push(`${model}.${operation}`);
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ client: raw })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, validateEnv({}));
    await app.init();
    await listen(app);
  });

  afterAll(async () => {
    await removeTestUsers(raw);
    await app.close();
  });

  it('performs one query regardless of how many addresses exist', async () => {
    await request(app.getHttpServer())
      .post(REGISTER)
      .send({ email: OWNER, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: OWNER, password: PASSWORD })
      .expect(200);
    const token = (login.body as { accessToken: string }).accessToken;

    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post(ADDRESSES)
        .set('Authorization', `Bearer ${token}`)
        .send(addressBody({ city: `City ${i}` }))
        .expect(201);
    }

    operations.length = 0;
    const response = await request(app.getHttpServer())
      .get(ADDRESSES)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(addressListSchema.parse(response.body)).toHaveLength(3);
    expect(operations).toEqual(['Address.findMany']);
  });
});

/**
 * THE CONSTRAINT ITSELF, ASSERTED DIRECTLY (F12/AC2).
 *
 * The race test below the CRUD suite exercises the service path, and the review of
 * PR #95 measured what it is worth as a guard on the mechanism: with
 * `addresses_one_default_per_kind` dropped, the full suite still went green in 5 of 16
 * runs — a ~31% miss rate — and a predicate weakened to SHIPPING only passed 18/18,
 * because that test never fires a BILLING create.
 *
 * A race is the wrong instrument for proving a constraint exists. These two tests are
 * deterministic:
 *
 *   1. the constraint REJECTS a second default, for each kind, via direct inserts that
 *      bypass the service entirely — so no application logic can mask its absence;
 *   2. the index definition is what it is supposed to be, so a narrowed predicate fails
 *      by name rather than by luck.
 *
 * The PR body originally reported the drop-index mutation as a clean single-shot result.
 * It was one run.
 */
describe('the one-default-per-kind constraint is enforced by the database', () => {
  let prisma: PrismaClient;
  let userId = '';

  beforeAll(() => {
    prisma = createPrismaClient();
  });

  beforeEach(async () => {
    await removeTestUsers(prisma);
    const user = await prisma.user.create({
      data: {
        email: `constraint${TEST_DOMAIN}`,
        passwordHash: 'not-used-by-this-suite',
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
      select: { id: true },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await removeTestUsers(prisma);
    await prisma.$disconnect();
  });

  /** A row straight into the table — no service, no transaction, no pre-clear. */
  function insertDefault(kind: 'SHIPPING' | 'BILLING', city: string) {
    return prisma.address.create({
      data: {
        userId,
        kind,
        isDefault: true,
        fullName: 'Ada Lovelace',
        line1: '12 Analytical Way',
        city,
        postalCode: 'EC1A 1BB',
        country: 'GB',
      },
      select: { id: true },
    });
  }

  it.each(['SHIPPING', 'BILLING'] as const)(
    'refuses a second default %s address at the database level',
    async (kind) => {
      await insertDefault(kind, 'First');
      // Not "the service prevents this" — the database does, with the service removed
      // from the picture. Dropping or narrowing the index fails this deterministically.
      await expect(insertDefault(kind, 'Second')).rejects.toMatchObject({ code: 'P2002' });
    },
  );

  it('still allows one default of each kind at the same time', async () => {
    await insertDefault('SHIPPING', 'Ship here');
    await insertDefault('BILLING', 'Bill here');
    expect(await prisma.address.count({ where: { userId, isDefault: true } })).toBe(2);
  });

  it('still allows any number of NON-default addresses', async () => {
    // The predicate half of the index. A constraint on (user_id, kind) without the
    // WHERE would reject these, and the seed would fail to build the index at all.
    for (const city of ['A', 'B', 'C']) {
      await prisma.address.create({
        data: {
          userId,
          kind: 'SHIPPING',
          isDefault: false,
          fullName: 'Ada',
          line1: '1 Road',
          city,
          postalCode: 'X',
          country: 'GB',
        },
      });
    }
    expect(await prisma.address.count({ where: { userId, isDefault: false } })).toBe(3);
  });

  it('the index exists with the predicate the migration declares', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'addresses'
        AND indexname = 'addresses_one_default_per_kind'
    `;

    expect(rows).toHaveLength(1);
    const definition = rows[0]?.indexdef ?? '';
    // Named parts rather than a byte-for-byte match: Postgres normalises whitespace and
    // quoting, but a narrowed predicate or a dropped column changes these.
    expect(definition).toContain('UNIQUE INDEX');
    expect(definition).toMatch(/\(user_id, kind\)/);
    expect(definition).toMatch(/WHERE is_default$/);
  });
});
