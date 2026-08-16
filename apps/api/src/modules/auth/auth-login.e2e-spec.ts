/**
 * POST /api/v1/auth/login end to end (SPEC.md F8, AC1 and AC4).
 *
 * Real application wiring through `configureApp` — the same function main.ts calls —
 * and a real Postgres. The account under test is created through the register endpoint
 * rather than inserted directly, so the password really is Argon2id-hashed by the code
 * that will hash it in production; a hand-written fixture hash would let a change in
 * hashing parameters pass this suite while breaking every real login.
 *
 * Cleanup is scoped to this suite's own email domain rather than truncating `users`.
 * Jest runs suites in parallel workers and the seed spec asserts on the two seeded
 * accounts; truncating would make the two suites fight over shared state, which is a
 * flaky green rather than a real one. Sessions go with the user by ON DELETE CASCADE.
 */
import 'reflect-metadata';
import type { Server } from 'node:http';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  authTokensSchema,
  problemDetailsSchema,
  ProblemType,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_SECONDS,
  refreshTokenSchema,
} from '@repo/contracts';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { validateEnv } from '../../config/env';
import { createPrismaClient, type PrismaClient } from '../../db/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PasswordHasher } from './password/password-hasher';
import { AccessTokenService } from './tokens/access-token.service';
import { RefreshTokenService } from './tokens/refresh-token.service';

const REGISTER = '/api/v1/auth/register';
const LOGIN = '/api/v1/auth/login';

const TEST_DOMAIN = '@f8-login.test';
const PASSWORD = 'marmalade-tuesday-gantry';

const KNOWN = `registered${TEST_DOMAIN}`;
const UNKNOWN = `never-registered${TEST_DOMAIN}`;

function registration(email: string) {
  return { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' };
}

async function listen(app: INestApplication): Promise<void> {
  // Bind once up front: letting parallel supertest calls each bind the server races
  // and produces ECONNRESET under load (the same fix as the F5 and F7 suites).
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

/** The attributes of one Set-Cookie header, lower-cased for case-insensitive lookup. */
function cookieAttributes(header: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    attributes.set((name ?? '').toLowerCase(), rest.join('='));
  }
  return attributes;
}

function setCookieHeaders(response: request.Response): string[] {
  const header: unknown = response.headers['set-cookie'];
  if (Array.isArray(header)) return header as string[];
  return typeof header === 'string' ? [header] : [];
}

function refreshCookieOf(response: request.Response): string {
  const header = setCookieHeaders(response).find((value) =>
    value.startsWith(`${REFRESH_COOKIE_NAME}=`),
  );
  if (!header) throw new Error('no refresh cookie was set');
  return header;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

describe('POST /auth/login', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, validateEnv({ NODE_ENV: 'test' }));
    await app.init();
    await listen(app);

    prisma = app.get(PrismaService).client;
  });

  beforeEach(async () => {
    await removeTestUsers(prisma);
    const created = await request(app.getHttpServer())
      .post(REGISTER)
      .send(registration(KNOWN))
      .expect(201);
    userId = (created.body as { id: string }).id;
  });

  afterAll(async () => {
    await removeTestUsers(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ AC1

  it('returns an access JWT bound to the session it created (AC1)', async () => {
    const response = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: PASSWORD })
      .expect(200);

    const tokens = authTokensSchema.parse(response.body);
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);

    // Verified by the application's own service with the application's own key — not
    // decoded, which would pass for an unsigned token.
    const claims = app.get(AccessTokenService).verify(tokens.accessToken);
    expect(claims.sub).toBe(userId);

    const session = await prisma.session.findUniqueOrThrow({ where: { id: claims.sid } });
    expect(session.userId).toBe(userId);
    expect(session.revokedAt).toBeNull();
    expect(session.rotatedAt).toBeNull();
  });

  it('sets the refresh token in an httpOnly, secure, sameSite=strict cookie (AC1)', async () => {
    const response = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: PASSWORD })
      .expect(200);

    const cookie = refreshCookieOf(response);
    const attributes = cookieAttributes(cookie);

    // Each flag asserted separately, because each one defends against a different
    // attack and a single "looks about right" regex would let any of them disappear.
    expect(attributes.has('httponly')).toBe(true);
    expect(attributes.has('secure')).toBe(true);
    expect(attributes.get('samesite')).toBe('Strict');
    // Scoped to the auth routes, so the 30-day credential is not attached to every
    // catalogue request for the rest of the session.
    expect(attributes.get('path')).toBe('/api/v1/auth');
    // Within a few seconds of the 30-day lifetime: Max-Age is derived from the same
    // `expiresAt` stored on the session row, so the elapsed request time rounds it
    // down by a second or so. A cookie that outlives its row would 401 on a request
    // the client believed was still good.
    expect(Number(attributes.get('max-age'))).toBeGreaterThan(REFRESH_TOKEN_TTL_SECONDS - 10);
    expect(Number(attributes.get('max-age'))).toBeLessThanOrEqual(REFRESH_TOKEN_TTL_SECONDS);

    const token = attributes.get(REFRESH_COOKIE_NAME) ?? '';
    expect(refreshTokenSchema.safeParse(token).success).toBe(true);
  });

  it('stores only a keyed hash of the refresh token (AC1)', async () => {
    const response = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: PASSWORD })
      .expect(200);

    const token = cookieAttributes(refreshCookieOf(response)).get(REFRESH_COOKIE_NAME) ?? '';
    const sessions = await prisma.session.findMany({ where: { userId } });

    expect(sessions).toHaveLength(1);
    const stored = sessions[0]!;
    expect(stored.refreshTokenHash).not.toBe(token);
    expect(stored.refreshTokenHash).not.toContain(token);
    // The hash on the row is the one the service would compute for that token — so
    // this is the value a refresh will actually look up, not merely "some digest".
    expect(stored.refreshTokenHash).toBe(app.get(RefreshTokenService).hash(token));

    const lifetimeMs = stored.expiresAt.getTime() - stored.createdAt.getTime();
    expect(Math.round(lifetimeMs / 1000)).toBe(REFRESH_TOKEN_TTL_SECONDS);
  });

  it('never puts the refresh token in the response body (AC1)', async () => {
    const response = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: PASSWORD })
      .expect(200);

    const token = cookieAttributes(refreshCookieOf(response)).get(REFRESH_COOKIE_NAME) ?? '';

    // Asserted on the raw bytes, not the parsed object: `authTokensSchema` is a
    // z.object and strips unknown keys, so a leak under a key the contract does not
    // declare would be invisible to a parsed comparison.
    expect(response.text).not.toContain(token);
    expect(Object.keys(response.body as object).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'tokenType',
    ]);
    expect(response.text).not.toContain(PASSWORD);
    expect(response.text.toLowerCase()).not.toContain('argon2');
  });

  it('logs in with the canonical form of the address, whatever case is typed (AC1)', async () => {
    await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: `  ${KNOWN.toUpperCase()} `, password: PASSWORD })
      .expect(200);
  });

  it('starts a new session family per login, leaving earlier sessions alone (AC1)', async () => {
    const first = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: PASSWORD })
      .expect(200);
    const second = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: PASSWORD })
      .expect(200);

    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.family)).size).toBe(2);
    // Signing in on a second device must not revoke the first one.
    expect(sessions.every((session) => session.revokedAt === null)).toBe(true);

    const claimsA = app
      .get(AccessTokenService)
      .verify(authTokensSchema.parse(first.body).accessToken);
    const claimsB = app
      .get(AccessTokenService)
      .verify(authTokensSchema.parse(second.body).accessToken);
    expect(claimsA.sid).not.toBe(claimsB.sid);
  });

  // ------------------------------------------------------------------ AC4

  it('rejects a wrong password with a generic 401 (AC4)', async () => {
    const response = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: `${PASSWORD}-wrong` })
      .expect(401);

    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.type).toBe(ProblemType.UNAUTHENTICATED);
    expect(problem.status).toBe(401);
    // The address must not come back — a 401 body is copied into logs and error
    // trackers, and an address there is an address disclosed.
    expect(response.text).not.toContain(KNOWN);
    expect(setCookieHeaders(response)).toEqual([]);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });

  /**
   * THE enumeration criterion (AC4).
   *
   * Byte-for-byte identical, once the traceId — which is unique per request by design —
   * is removed. Comparing the parsed Problem Details would not be enough: it is a
   * z.object and strips unknown keys, so an `email` or `reason` field added by a future
   * refactor would be invisible to it.
   */
  it('answers an unknown address exactly as it answers a wrong password (AC4)', async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: `${PASSWORD}-wrong` })
      .expect(401);

    const unknownAddress = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: UNKNOWN, password: PASSWORD })
      .expect(401);

    const withoutTrace = (body: string) => body.replace(/"traceId":"[^"]*"/, '"traceId":"…"');
    expect(withoutTrace(unknownAddress.text)).toBe(withoutTrace(wrongPassword.text));
    expect(unknownAddress.headers['content-type']).toBe(wrongPassword.headers['content-type']);
  });

  it('reports a short password as a failed login, not as a validation error (AC4)', async () => {
    // The registration policy would reject this as too short. Login must not: a 422
    // here would answer "no account could have this password" for free, and it would
    // answer it without paying for a hash.
    const response = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: 'short' })
      .expect(401);

    expect(problemDetailsSchema.parse(response.body).type).toBe(ProblemType.UNAUTHENTICATED);
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: PASSWORD, role: 'ADMIN' })
      .expect(422);
  });

  /**
   * The wall clock (AC4).
   *
   * Both bounds are ratios against a cost measured on THIS machine, so CI jitter and
   * machine speed move numerator and denominator together. An absolute floor (">10ms")
   * is worse than useless: HTTP, routing, validation and a Postgres round trip already
   * cost that much, so it passes with the enumeration oracle wide open.
   *
   * ALL THREE measurements are taken in the same interleaved loop, including the
   * Argon2id calibration. That is not cosmetic. In the original form the calibration
   * ran after the loop, so a machine that got busier partway through compared an early,
   * cheap login against a late, expensive verify — and the test failed with the code
   * correct. Reproduced under six competing CPU workers: one run in three, at a margin
   * of about 3%. Interleaving puts every sample under the same load, and the median of
   * seven rounds absorbs a single stalled one.
   *
   * The bound is what a skipped verify cannot survive: with the early return
   * reintroduced — `if (!credentials) throw` before any hashing — the unknown-address
   * path costs a few percent of a verify rather than more than one, so 0.75 has roughly
   * an order of magnitude of headroom in the direction that matters. Verified by
   * mutation: replacing `verifyAgainstDummy` with `false` fails this test on every run.
   */
  it('takes comparable wall-clock time for an unknown address and a wrong password (AC4)', async () => {
    const hasher = app.get(PasswordHasher);
    const stored = await hasher.hash(PASSWORD);

    const unknownSamples: number[] = [];
    const wrongSamples: number[] = [];
    const verifySamples: number[] = [];

    for (let i = 0; i < 7; i += 1) {
      unknownSamples.push(await time({ email: `${i}-${UNKNOWN}`, password: PASSWORD }));
      wrongSamples.push(await time({ email: KNOWN, password: `${PASSWORD}-wrong-${i}` }));
      verifySamples.push(await elapsed(() => hasher.verify(stored, `${PASSWORD}-nope-${i}`)));
    }

    const unknown = median(unknownSamples);
    const wrong = median(wrongSamples);
    const verifyCost = median(verifySamples);

    expect(unknown).toBeGreaterThan(verifyCost * 0.75);
    expect(unknown).toBeGreaterThan(wrong * 0.5);
    expect(wrong).toBeGreaterThan(unknown * 0.5);
  });

  async function time(body: Record<string, unknown>): Promise<number> {
    return elapsed(async () => {
      await request(app.getHttpServer()).post(LOGIN).send(body).expect(401);
    });
  }
});

async function elapsed(work: () => Promise<unknown>): Promise<number> {
  const start = process.hrtime.bigint();
  await work();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/**
 * The statement count for login.
 *
 * Not an N+1 guard — login is not a list endpoint — but the structural half of AC4: one
 * SELECT and nothing else on the failing paths, and the SAME one whether or not the
 * address exists. A second query on either path (a role lookup, an audit write, a
 * "does this email exist" pre-check) would show up here as a difference between the two
 * failure modes, which is a timing oracle regardless of how identical the bodies are.
 */
describe('login issues the same statements whether or not the account exists (AC4)', () => {
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
    configureApp(app, validateEnv({ NODE_ENV: 'test' }));
    await app.init();
    await listen(app);

    await removeTestUsers(raw);
    await request(app.getHttpServer()).post(REGISTER).send(registration(KNOWN)).expect(201);
  });

  beforeEach(() => {
    operations.length = 0;
  });

  afterAll(async () => {
    await removeTestUsers(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('performs exactly one read for a wrong password', async () => {
    await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: 'wrong-password' })
      .expect(401);

    expect(operations).toEqual(['User.findUnique']);
  });

  it('performs the same single read for an address that does not exist', async () => {
    await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: UNKNOWN, password: PASSWORD })
      .expect(401);

    expect(operations).toEqual(['User.findUnique']);
  });

  it('performs one read and one write on success', async () => {
    await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: KNOWN, password: PASSWORD })
      .expect(200);

    expect(operations).toEqual(['User.findUnique', 'Session.create']);
  });
});
