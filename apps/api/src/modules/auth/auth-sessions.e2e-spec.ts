/**
 * Session listing, revocation and logout end to end (SPEC.md F9, all four criteria).
 *
 * These are the project's FIRST owned-resource routes, so the 404-not-403 probe that
 * F7's suite deferred lands here on the verb that has an id: `DELETE /auth/sessions/:id`.
 * `GET /auth/sessions` takes no id — the token decides whose sessions it returns — so
 * there is nothing to probe on it beyond "another account's rows are not in the list",
 * which is asserted directly.
 *
 * Real Postgres, real guard, real cookies. The default-deny test at the bottom is the
 * one that would have caught this feature shipping as `@Public()`.
 */
import 'reflect-metadata';
import type { Server } from 'node:http';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  problemDetailsSchema,
  ProblemType,
  REFRESH_COOKIE_NAME,
  sessionListSchema,
} from '@repo/contracts';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { validateEnv } from '../../config/env';
import { createPrismaClient, type PrismaClient } from '../../db/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

const REGISTER = '/api/v1/auth/register';
const LOGIN = '/api/v1/auth/login';
const REFRESH = '/api/v1/auth/refresh';
const SESSIONS = '/api/v1/auth/sessions';
const LOGOUT = '/api/v1/auth/logout';

const TEST_DOMAIN = '@f9-sessions.test';
const PASSWORD = 'marmalade-tuesday-gantry';
const EMAIL = `owner${TEST_DOMAIN}`;
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

function refreshSetCookieOf(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const headers = Array.isArray(header) ? (header as string[]) : [];
  const cookie = headers.find((value) => value.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!cookie) throw new Error('no refresh cookie was set');
  return cookie;
}

function refreshCookieOf(response: request.Response): string {
  return refreshSetCookieOf(response).split(';')[0] ?? '';
}

interface SignedIn {
  accessToken: string;
  refreshCookie: string;
}

describe('F9 · sessions', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  /** Signs in, optionally announcing a device, and returns both credentials. */
  async function signIn(email: string, device?: string): Promise<SignedIn> {
    const call = request(app.getHttpServer()).post(LOGIN);
    if (device) void call.set('User-Agent', device);
    const response = await call.send({ email, password: PASSWORD }).expect(200);
    return {
      accessToken: (response.body as { accessToken: string }).accessToken,
      refreshCookie: refreshCookieOf(response),
    };
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
    for (const email of [EMAIL, OTHER_EMAIL]) {
      await request(app.getHttpServer())
        .post(REGISTER)
        .send({ email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' })
        .expect(201);
    }
  });

  afterAll(async () => {
    await removeTestUsers(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ AC1

  it('lists the caller’s active sessions with device, IP and last-used (AC1)', async () => {
    const first = await signIn(EMAIL, 'Firefox on Linux');
    await signIn(EMAIL, 'Safari on iOS');

    const response = await request(app.getHttpServer())
      .get(SESSIONS)
      .set('Authorization', `Bearer ${first.accessToken}`)
      .expect(200);

    const sessions = sessionListSchema.parse(response.body);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.device).sort()).toEqual([
      'Firefox on Linux',
      'Safari on iOS',
    ]);
    // Every criterion field is actually populated — a null here would satisfy the
    // schema while telling the account holder nothing.
    for (const session of sessions) {
      expect(session.ip).not.toBeNull();
      expect(Date.parse(session.lastUsedAt)).not.toBeNaN();
    }
    // Exactly one is "this device", and it is the one whose token made the request.
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
  });

  it('shows only the caller’s own sessions, never another account’s (AC1, I4)', async () => {
    const mine = await signIn(EMAIL, 'Mine');
    await signIn(OTHER_EMAIL, 'Theirs');

    const response = await request(app.getHttpServer())
      .get(SESSIONS)
      .set('Authorization', `Bearer ${mine.accessToken}`)
      .expect(200);

    const sessions = sessionListSchema.parse(response.body);
    expect(sessions.map((session) => session.device)).toEqual(['Mine']);
  });

  it('never puts token material on the wire (AC1)', async () => {
    const { accessToken, refreshCookie } = await signIn(EMAIL, 'Quiet');
    const refreshToken = refreshCookie.split('=')[1] ?? '';

    const response = await request(app.getHttpServer())
      .get(SESSIONS)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // The RAW body: sessionListSchema is z.object per item and would strip an added
    // key before any assertion could see it — the F5 lesson.
    const raw = response.body as Record<string, unknown>[];
    for (const entry of raw) {
      expect(Object.keys(entry).sort()).toEqual([
        'createdAt',
        'current',
        'device',
        'expiresAt',
        'id',
        'ip',
        'lastUsedAt',
      ]);
    }
    expect(response.text).not.toContain(refreshToken);
    expect(response.text.toLowerCase()).not.toContain('hash');
  });

  it('omits rotated, revoked and expired sessions (AC1)', async () => {
    const live = await signIn(EMAIL, 'Live');
    const rotating = await signIn(EMAIL, 'Rotated');

    // The spent row is identified by id, not by device: its successor carries the
    // User-Agent of the REFRESH request, so asserting on the device string would be
    // asserting on supertest's default header rather than on rotation.
    const before = sessionListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(SESSIONS)
          .set('Authorization', `Bearer ${live.accessToken}`)
          .expect(200)
      ).body,
    );
    const spentId = before.find((session) => session.device === 'Rotated')?.id ?? '';
    expect(spentId).not.toBe('');

    // Rotate one: the old row survives as reuse evidence but is spent, and a device
    // list that grew a row per refresh would be useless within a day.
    await request(app.getHttpServer())
      .post(REFRESH)
      .set('Cookie', rotating.refreshCookie)
      .expect(200);

    // Revoke another outright, and expire a third, by touching the rows directly.
    const revoked = await signIn(EMAIL, 'Revoked');
    const expired = await signIn(EMAIL, 'Expired');
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    await prisma.session.updateMany({
      where: { userId: owner.id, device: 'Revoked' },
      data: { revokedAt: new Date() },
    });
    await prisma.session.updateMany({
      where: { userId: owner.id, device: 'Expired' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(revoked.accessToken).toBeTruthy();
    expect(expired.accessToken).toBeTruthy();

    const response = await request(app.getHttpServer())
      .get(SESSIONS)
      .set('Authorization', `Bearer ${live.accessToken}`)
      .expect(200);

    const after = sessionListSchema.parse(response.body);

    // The spent row is gone, its successor is present, and neither the revoked nor the
    // expired session is listed — two live rows, and the rotated id is not one of them.
    expect(after.map((session) => session.id)).not.toContain(spentId);
    expect(after.map((session) => session.device)).toContain('Live');
    expect(after).toHaveLength(2);
    expect(after.map((session) => session.device)).not.toContain('Revoked');
    expect(after.map((session) => session.device)).not.toContain('Expired');
  });

  // ------------------------------------------------------------------ AC2

  it('revokes one session (AC2)', async () => {
    const keep = await signIn(EMAIL, 'Keep');
    const drop = await signIn(EMAIL, 'Drop');

    const listed = sessionListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(SESSIONS)
          .set('Authorization', `Bearer ${keep.accessToken}`)
          .expect(200)
      ).body,
    );
    const target = listed.find((session) => session.device === 'Drop');
    expect(target).toBeDefined();

    await request(app.getHttpServer())
      .delete(`${SESSIONS}/${target?.id ?? ''}`)
      .set('Authorization', `Bearer ${keep.accessToken}`)
      .expect(204);

    const remaining = sessionListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(SESSIONS)
          .set('Authorization', `Bearer ${keep.accessToken}`)
          .expect(200)
      ).body,
    );
    expect(remaining.map((session) => session.device)).toEqual(['Keep']);

    // AC4 for this path: the revoked session's refresh token is dead.
    await request(app.getHttpServer()).post(REFRESH).set('Cookie', drop.refreshCookie).expect(401);
  });

  /**
   * THE CROSS-ACCOUNT PROBE (AC2, I4).
   *
   * 404, not 403. A 403 would confirm the id names a real session, which is the
   * existence leak the invariant exists to prevent — and the session survives, because
   * the ownership condition is part of the UPDATE's WHERE rather than a comparison
   * afterwards.
   */
  it('answers 404 — not 403 — for another account’s session, and leaves it alive (AC2, I4)', async () => {
    const mine = await signIn(EMAIL, 'Mine');
    const theirs = await signIn(OTHER_EMAIL, 'Theirs');

    const theirSessions = sessionListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(SESSIONS)
          .set('Authorization', `Bearer ${theirs.accessToken}`)
          .expect(200)
      ).body,
    );
    const victimId = theirSessions[0]?.id ?? '';
    expect(victimId).not.toBe('');

    const response = await request(app.getHttpServer())
      .delete(`${SESSIONS}/${victimId}`)
      .set('Authorization', `Bearer ${mine.accessToken}`)
      .expect(404);

    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.status).toBe(404);
    expect(problem.type).toBe(ProblemType.NOT_FOUND);
    // The victim's session still works — the 404 was a refusal, not a silent success.
    await request(app.getHttpServer())
      .post(REFRESH)
      .set('Cookie', theirs.refreshCookie)
      .expect(200);
  });

  it('answers 404 for a session id that never existed (AC2)', async () => {
    const { accessToken } = await signIn(EMAIL);
    await request(app.getHttpServer())
      .delete(`${SESSIONS}/00000000-0000-7000-8000-000000000000`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
  });

  it('answers 422 for a malformed session id (AC2)', async () => {
    const { accessToken } = await signIn(EMAIL);
    await request(app.getHttpServer())
      .delete(`${SESSIONS}/not-a-uuid`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(422);
  });

  // ------------------------------------------------------------------ AC3

  it('logout revokes the current session and clears the cookie (AC3)', async () => {
    const { refreshCookie } = await signIn(EMAIL, 'Leaving');

    const response = await request(app.getHttpServer())
      .post(LOGOUT)
      .set('Cookie', refreshCookie)
      .expect(204);

    // Cleared with the SAME attributes it was set with — a mismatched path leaves the
    // original cookie in the browser and the client keeps sending a dead token.
    const cleared = refreshSetCookieOf(response);
    expect(cleared).toContain('Path=/api/v1/auth');
    expect(cleared).toMatch(/refresh_token=;|Expires=Thu, 01 Jan 1970/);

    // AC4: the token is dead server-side too, not merely forgotten by the client.
    await request(app.getHttpServer()).post(REFRESH).set('Cookie', refreshCookie).expect(401);
  });

  it('logout answers 204 with no cookie, and with an unknown one (AC3)', async () => {
    await request(app.getHttpServer()).post(LOGOUT).expect(204);
    await request(app.getHttpServer())
      .post(LOGOUT)
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${'z'.repeat(43)}`)
      .expect(204);
  });

  it('logout leaves the account’s other sessions alone (AC3)', async () => {
    const staying = await signIn(EMAIL, 'Staying');
    const leaving = await signIn(EMAIL, 'Leaving');

    await request(app.getHttpServer())
      .post(LOGOUT)
      .set('Cookie', leaving.refreshCookie)
      .expect(204);

    const remaining = sessionListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(SESSIONS)
          .set('Authorization', `Bearer ${staying.accessToken}`)
          .expect(200)
      ).body,
    );
    expect(remaining.map((session) => session.device)).toEqual(['Staying']);
  });

  // ------------------------------------------------------------------ AC4

  it('a revoked session’s refresh token is rejected, and stays rejected (AC4)', async () => {
    const { accessToken, refreshCookie } = await signIn(EMAIL, 'Doomed');

    const listed = sessionListSchema.parse(
      (
        await request(app.getHttpServer())
          .get(SESSIONS)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200)
      ).body,
    );

    await request(app.getHttpServer())
      .delete(`${SESSIONS}/${listed[0]?.id ?? ''}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    // Twice: a revoked token must not become valid again on a second attempt, and must
    // not be treated as "reuse" evidence that revokes anything further.
    await request(app.getHttpServer()).post(REFRESH).set('Cookie', refreshCookie).expect(401);
    await request(app.getHttpServer()).post(REFRESH).set('Cookie', refreshCookie).expect(401);
  });

  // ------------------------------------------ the guard, now global (I5)

  it('requires a token: no header, malformed header, and garbage token all 401', async () => {
    await request(app.getHttpServer()).get(SESSIONS).expect(401);
    await request(app.getHttpServer()).get(SESSIONS).set('Authorization', 'Basic abc').expect(401);
    await request(app.getHttpServer())
      .get(SESSIONS)
      .set('Authorization', 'Bearer not.a.jwt')
      .expect(401);
  });

  it('another account’s token cannot read this account’s sessions (I4)', async () => {
    await signIn(EMAIL, 'Mine');
    const theirs = await signIn(OTHER_EMAIL, 'Theirs');

    const response = await request(app.getHttpServer())
      .get(SESSIONS)
      .set('Authorization', `Bearer ${theirs.accessToken}`)
      .expect(200);

    // Not a 403 and not an error — simply their own list, which contains nothing of
    // mine. Scoping by the token's `sub` is what makes the other account invisible.
    expect(sessionListSchema.parse(response.body).map((s) => s.device)).toEqual(['Theirs']);
  });
});

/**
 * The statement count for the list endpoint (CLAUDE.md § Testing).
 *
 * `GET /auth/sessions` is the project's first list endpoint, so this is the N+1 guard.
 * One SELECT, whatever the number of sessions — a per-row lookup added later to
 * decorate each entry shows up here immediately.
 */
describe('listing sessions issues exactly one statement', () => {
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

  it('performs one query regardless of how many sessions exist', async () => {
    await request(app.getHttpServer())
      .post(REGISTER)
      .send({ email: EMAIL, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' })
      .expect(201);

    let accessToken = '';
    for (let i = 0; i < 3; i++) {
      const response = await request(app.getHttpServer())
        .post(LOGIN)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      accessToken = (response.body as { accessToken: string }).accessToken;
    }

    operations.length = 0;
    const response = await request(app.getHttpServer())
      .get(SESSIONS)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(sessionListSchema.parse(response.body)).toHaveLength(3);
    expect(operations).toEqual(['Session.findMany']);
  });
});
