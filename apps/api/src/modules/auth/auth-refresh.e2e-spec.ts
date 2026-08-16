/**
 * POST /api/v1/auth/refresh end to end (SPEC.md F8, AC2 and AC3).
 *
 * Nothing here is mocked: real Postgres, real transactions, real cookies. A refresh
 * suite with a mocked session store would prove nothing at all about rotation — the
 * criterion IS the database behaviour under concurrent access.
 *
 * Cleanup is scoped to this suite's own email domain; sessions follow the user by
 * ON DELETE CASCADE.
 */
import 'reflect-metadata';
import type { Server } from 'node:http';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  authTokensSchema,
  problemDetailsSchema,
  ProblemType,
  REFRESH_COOKIE_NAME,
} from '@repo/contracts';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { validateEnv } from '../../config/env';
import { createPrismaClient, type PrismaClient } from '../../db/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AccessTokenService } from './tokens/access-token.service';

const REGISTER = '/api/v1/auth/register';
const LOGIN = '/api/v1/auth/login';
const REFRESH = '/api/v1/auth/refresh';

const TEST_DOMAIN = '@f8-refresh.test';
const PASSWORD = 'marmalade-tuesday-gantry';
const EMAIL = `rotator${TEST_DOMAIN}`;
/** A second account, for the cross-account probes (I4). */
const OTHER_EMAIL = `bystander${TEST_DOMAIN}`;

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

/** The whole Set-Cookie header, attributes included. */
function refreshSetCookieOf(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const headers = Array.isArray(header) ? (header as string[]) : [];
  const cookie = headers.find((value) => value.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!cookie) throw new Error('no refresh cookie was set');
  return cookie;
}

/** The `name=value` pair to send back as a Cookie header. */
function refreshCookieOf(response: request.Response): string {
  return refreshSetCookieOf(response).split(';')[0] ?? '';
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

describe('POST /auth/refresh', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let userId: string;

  /** Logs in and hands back the cookie header to present. */
  async function login(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);
    return refreshCookieOf(response);
  }

  function refreshWith(cookie: string): request.Test {
    return request(app.getHttpServer()).post(REFRESH).set('Cookie', cookie);
  }

  /**
   * A second, unrelated account with a live session of its own — the other side of
   * every cross-account probe. Its address is in this suite's domain, so the existing
   * cleanup removes it and its sessions with it.
   */
  async function registerOther(): Promise<{ userId: string; cookie: string }> {
    const email = OTHER_EMAIL;
    const created = await request(app.getHttpServer())
      .post(REGISTER)
      .send({ email, password: PASSWORD, firstName: 'Grace', lastName: 'Hopper' })
      .expect(201);

    const loggedIn = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email, password: PASSWORD })
      .expect(200);

    return { userId: (created.body as { id: string }).id, cookie: refreshCookieOf(loggedIn) };
  }

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
      .send({ email: EMAIL, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' })
      .expect(201);
    userId = (created.body as { id: string }).id;
  });

  afterAll(async () => {
    await removeTestUsers(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ AC2

  it('rotates: a new refresh token is issued in the same family (AC2)', async () => {
    const first = await login();
    const response = await refreshWith(first).expect(200);

    const second = refreshCookieOf(response);
    expect(second).not.toBe(first);

    const sessions = await prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(sessions).toHaveLength(2);
    const [original, successor] = sessions;
    // Same lineage, so revoking the family later reaches both (AC3).
    expect(successor!.family).toBe(original!.family);
    expect(original!.rotatedAt).not.toBeNull();
    expect(successor!.rotatedAt).toBeNull();
    expect(successor!.revokedAt).toBeNull();
  });

  it('issues a working access token bound to the new session (AC2)', async () => {
    const cookie = await login();
    const response = await refreshWith(cookie).expect(200);

    const claims = app
      .get(AccessTokenService)
      .verify(authTokensSchema.parse(response.body).accessToken);
    expect(claims.sub).toBe(userId);

    const successor = await prisma.session.findUniqueOrThrow({ where: { id: claims.sid } });
    expect(successor.rotatedAt).toBeNull();
  });

  it('invalidates the previous token — the successor works, the predecessor does not (AC2)', async () => {
    const first = await login();
    const second = refreshCookieOf(await refreshWith(first).expect(200));

    // The new one is live…
    const third = refreshCookieOf(await refreshWith(second).expect(200));
    expect(third).not.toBe(second);

    // …and the one it replaced is not. This is the half of AC2 that a "rotation
    // happened" assertion alone would miss: issuing a new token while leaving the old
    // one usable is two live credentials, not a rotation.
    await refreshWith(second).expect(401);
  });

  /**
   * The AC1 flags have to survive rotation (AC1 + AC2).
   *
   * The login suite asserts them on the cookie login sets; nothing asserted them on the
   * cookie REFRESH sets, and that is the one a client actually holds for the remaining
   * 29 days of the session. A rotated cookie that lost `httpOnly` would be a long-lived
   * credential readable by any script on the page, and every existing assertion in this
   * file would still have passed — `refreshCookieOf` throws the attributes away.
   */
  it('the rotated cookie carries the same httpOnly, secure, sameSite=strict flags (AC1)', async () => {
    const cookie = await login();
    const response = await refreshWith(cookie).expect(200);
    const attributes = cookieAttributes(refreshSetCookieOf(response));

    expect(attributes.has('httponly')).toBe(true);
    expect(attributes.has('secure')).toBe(true);
    expect(attributes.get('samesite')).toBe('Strict');
    // Same name and path as the cookie it replaces, or the browser keeps BOTH and the
    // superseded one goes on being sent — a rotated credential that never leaves.
    expect(attributes.get('path')).toBe('/api/v1/auth');
    expect(attributes.has(REFRESH_COOKIE_NAME)).toBe(true);
    // No `domain`: the cookie stays on the exact host that set it rather than being
    // shared with every sibling subdomain.
    expect(attributes.has('domain')).toBe(false);
  });

  it('the plaintext token is never stored or echoed (AC2)', async () => {
    const cookie = await login();
    const response = await refreshWith(cookie).expect(200);
    const issued = refreshCookieOf(response).slice(REFRESH_COOKIE_NAME.length + 1);

    expect(response.text).not.toContain(issued);
    const stored = await prisma.session.findMany({ where: { userId } });
    for (const session of stored) {
      expect(session.refreshTokenHash).not.toContain(issued);
    }
  });

  // ------------------------------------------------------------------ AC3

  /**
   * The criterion, end to end.
   *
   * A token that has already been exchanged is, by definition, held by two parties. The
   * response is 401 AND every session descended from that login dies — including the
   * successor the legitimate client is holding, which is the point: the legitimate
   * client can log in again, the thief cannot.
   */
  it('a reused token revokes the entire session family and returns 401 (AC3)', async () => {
    const first = await login();
    const second = refreshCookieOf(await refreshWith(first).expect(200));

    const response = await refreshWith(first).expect(401);
    expect(problemDetailsSchema.parse(response.body).type).toBe(ProblemType.UNAUTHENTICATED);

    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);

    // The successor is dead too — otherwise "revokes the family" would mean "revokes
    // the one row nobody was using".
    await refreshWith(second).expect(401);
  });

  it('leaves other families — other devices — alone (AC3)', async () => {
    const deviceA = await login();
    const deviceB = await login();

    const rotatedA = refreshCookieOf(await refreshWith(deviceA).expect(200));
    await refreshWith(deviceA).expect(401); // reuse on A

    const families = await prisma.session.findMany({ where: { userId } });
    const revoked = families.filter((session) => session.revokedAt !== null);
    // Exactly the two sessions of family A, and nothing belonging to B.
    expect(revoked).toHaveLength(2);
    expect(new Set(revoked.map((session) => session.family)).size).toBe(1);

    await request(app.getHttpServer()).post(REFRESH).set('Cookie', deviceB).expect(200);
    // …and A really is dead on both of its tokens.
    await refreshWith(rotatedA).expect(401);
  });

  /**
   * The cross-account probe for the one credential F8 adds (I4).
   *
   * `POST /auth/refresh` has no path parameter, so there is no `:id` to swap for
   * somebody else's — the cookie IS the identity. The equivalent question is therefore
   * whether one account's refresh token can reach another account's session, and it is
   * asked in both directions: the token must act only on its own owner's lineage, and
   * detecting theft on one account must not log the other one out.
   *
   * Without this, a `revokeFamily` that matched on something less specific than the
   * family id — a `userId`-shaped bug, or a missing WHERE — would take out unrelated
   * accounts and every existing AC3 test, all of which use one user, would stay green.
   */
  it("a refresh token acts only on its own owner's session (I4)", async () => {
    const other = await registerOther();

    const rotated = await request(app.getHttpServer())
      .post(REFRESH)
      .set('Cookie', other.cookie)
      .expect(200);

    // The access token minted from B's cookie identifies B, not the caller's guess and
    // not the other account in the database.
    const claims = app
      .get(AccessTokenService)
      .verify(authTokensSchema.parse(rotated.body).accessToken);
    expect(claims.sub).toBe(other.userId);
    expect(claims.sub).not.toBe(userId);

    const session = await prisma.session.findUniqueOrThrow({ where: { id: claims.sid } });
    expect(session.userId).toBe(other.userId);
    // Nothing of the first account's was touched by a request carrying B's cookie.
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });

  it("reuse on one account does not revoke another account's sessions (AC3, I4)", async () => {
    const other = await registerOther();
    const mine = await login();

    // Theft detected on this account's family…
    await refreshWith(mine).expect(200);
    await refreshWith(mine).expect(401);

    const revoked = await prisma.session.findMany({
      where: { userId },
      select: { revokedAt: true },
    });
    expect(revoked).toHaveLength(2);
    expect(revoked.every((session) => session.revokedAt !== null)).toBe(true);

    // …leaves the other account alone, in the database and on the wire.
    const theirs = await prisma.session.findMany({ where: { userId: other.userId } });
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.revokedAt).toBeNull();
    await request(app.getHttpServer()).post(REFRESH).set('Cookie', other.cookie).expect(200);
  });

  it('says nothing different when the reuse was detected (AC3)', async () => {
    const first = await login();
    await refreshWith(first).expect(200);

    const reuse = await refreshWith(first).expect(401);
    const unknown = await request(app.getHttpServer())
      .post(REFRESH)
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${'z'.repeat(43)}`)
      .expect(401);

    const withoutTrace = (body: string) => body.replace(/"traceId":"[^"]*"/, '"traceId":"…"');
    // A distinguishable "reuse detected" response would tell an attacker holding a
    // stolen token that the theft was noticed — and tell a scanner which tokens exist.
    expect(withoutTrace(reuse.text)).toBe(withoutTrace(unknown.text));
  });

  /**
   * The race, over HTTP (AC2/AC3, rules/50-testing.md §4).
   *
   * Promise.all, not a loop: a sequential version passes even when rotation is a
   * read-then-write, because nothing overlaps.
   *
   * The tighter version of this test is in `auth.repository.e2e-spec.ts` — specifically
   * "a rotation that loses the row lock is refused", which forces the interleaving with
   * a held row lock instead of hoping for it. That is the one that BINDS on atomicity:
   * independently re-measured, dropping `rotatedAt: null` from the conditional update
   * fails there on every run and leaves THIS test green on every run, because at this
   * level the requests spend long enough in routing and cookie parsing that they queue
   * rather than interleave.
   *
   * It stays anyway, and it is not inert: it is the criterion in the shape a client
   * experiences it — six live requests, one usable answer, no 500s, family revoked —
   * and it fails on a reuse path that stops revoking the family and on a `revokeFamily`
   * that misses rotated rows (both verified by mutation). Read it as the end-to-end
   * contract, not as the proof of the conditional update.
   */
  it('six parallel refreshes with the same token produce exactly one winner', async () => {
    const cookie = await login();

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app.getHttpServer()).post(REFRESH).set('Cookie', cookie),
      ),
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 401, 401, 401, 401, 401]);

    // One original + one successor. Two winners would mean two live refresh tokens for
    // one session — the exact thing the conditional update prevents.
    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(2);

    // Every loser is a clean 401 with the shared message, not a 500 from a transaction
    // conflict escaping as an unhandled error.
    for (const response of responses.filter((r) => r.status === 401)) {
      expect(problemDetailsSchema.parse(response.body).status).toBe(401);
    }

    // And because a second presentation of a single-use token is reuse, the family is
    // revoked — including the winner's brand-new token. A client must serialise its
    // refreshes; see the note on `AuthService.refresh` about why there is no grace
    // window.
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
  });

  // ------------------------------------------------------------------ failure paths

  it('rejects a request with no cookie at all', async () => {
    const response = await request(app.getHttpServer()).post(REFRESH).expect(401);
    expect(problemDetailsSchema.parse(response.body).type).toBe(ProblemType.UNAUTHENTICATED);
  });

  it.each([
    ['a malformed value', 'not-a-token'],
    ['a value of the right shape that was never issued', 'z'.repeat(43)],
    ['an empty value', ''],
  ])('rejects %s with 401 and no new session', async (_label, value) => {
    await request(app.getHttpServer())
      .post(REFRESH)
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${value}`)
      .expect(401);

    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });

  it('rejects an expired refresh token', async () => {
    const cookie = await login();
    await prisma.session.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await refreshWith(cookie).expect(401);
    // Expiry is not theft: nothing is revoked and no successor is created.
    expect(await prisma.session.count({ where: { userId } })).toBe(1);
  });

  it('rejects a revoked session (F9 leans on this)', async () => {
    const cookie = await login();
    await prisma.session.updateMany({ where: { userId }, data: { revokedAt: new Date() } });

    await refreshWith(cookie).expect(401);
    expect(await prisma.session.count({ where: { userId } })).toBe(1);
  });

  it('does not set a new cookie on a failed refresh', async () => {
    const response = await request(app.getHttpServer())
      .post(REFRESH)
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${'z'.repeat(43)}`)
      .expect(401);

    expect(response.headers['set-cookie']).toBeUndefined();
  });
});

/**
 * The statement count for a rotation.
 *
 * Three statements, in one transaction: read the presented row to classify it, claim it
 * with a CONDITIONAL update, insert the successor. The conditional update is the
 * atomicity, and it must stay — this test pins the shape so a refactor to
 * `findUnique` + unconditional `update` (same count, no safety) is visible as a change
 * from `updateMany` to `update`.
 */
describe('rotation issues three statements in one transaction (AC2)', () => {
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
    await request(app.getHttpServer())
      .post(REGISTER)
      .send({ email: EMAIL, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' })
      .expect(201);
  });

  afterAll(async () => {
    await removeTestUsers(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('reads once, claims once, inserts once — and no more', async () => {
    const loggedIn = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    operations.length = 0;
    await request(app.getHttpServer())
      .post(REFRESH)
      .set('Cookie', refreshCookieOf(loggedIn))
      .expect(200);

    expect(operations).toEqual(['Session.findUnique', 'Session.updateMany', 'Session.create']);
  });

  it('reads once and revokes once when a rotated token comes back', async () => {
    const loggedIn = await request(app.getHttpServer())
      .post(LOGIN)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);
    const cookie = refreshCookieOf(loggedIn);
    await request(app.getHttpServer()).post(REFRESH).set('Cookie', cookie).expect(200);

    operations.length = 0;
    await request(app.getHttpServer()).post(REFRESH).set('Cookie', cookie).expect(401);

    // No successor is created on the reuse path, and the family revocation is a single
    // statement rather than one per session.
    expect(operations).toEqual(['Session.findUnique', 'Session.updateMany']);
  });
});
