/**
 * Bearer access tokens over HTTP (SPEC.md F8/AC5).
 *
 * AC5 — "expired tokens return 401, not 500" — is a property of the whole request path:
 * the guard, the token service, and the global Problem Details filter agreeing on what
 * an unusable token means. A unit test on `AccessTokenService.verify` proves the error
 * TYPE; only a request proves the STATUS CODE, because the mapping from
 * `UnauthenticatedError` to 401 lives in the filter.
 *
 * F8 ships no protected production route — `/me` is F12 and `/auth/sessions` is F9 —
 * so the probe controller below exists to give the guard something to guard. It is
 * declared in this spec and registered in a test-only module, so it is not part of the
 * application's surface; everything it exercises (guard, service, filter, wiring) is
 * production code. The alternative was to ship a route that belongs to a later feature
 * purely to have something to test, which is worse.
 */
import 'reflect-metadata';
import { Controller, Get, Req, UseGuards, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ACCESS_TOKEN_TTL_SECONDS, problemDetailsSchema, ProblemType } from '@repo/contracts';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { validateEnv } from '../../config/env';
import { AuthModule } from '../../modules/auth/auth.module';
import { AccessTokenService } from '../../modules/auth/tokens/access-token.service';
import { JwtAuthGuard, type RequestWithAuth } from './jwt-auth.guard';
import { Public } from './public.decorator';

const USER_ID = '018f1f77-bcf8-7c3d-9a3b-2c4c6b3f0a11';
const SESSION_ID = '018f1f77-bcf8-7c3d-9a3b-2c4c6b3f0a22';

@Controller('probe')
@UseGuards(JwtAuthGuard)
class ProbeController {
  /** Echoes the claims the guard attached, so "who does the API think this is" is testable. */
  @Get('protected')
  protectedRoute(@Req() request: RequestWithAuth): { sub: string | undefined } {
    return { sub: request.auth?.sub };
  }

  /** The same guard, on a route that opted out — @Public must still mean public. */
  @Public()
  @Get('open')
  openRoute(): { ok: true } {
    return { ok: true };
  }
}

describe('bearer access tokens (F8/AC5)', () => {
  let app: INestApplication;
  let tokens: AccessTokenService;

  const PROTECTED = '/api/v1/probe/protected';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // AuthModule directly as well as through AppModule: Nest exports are visible to
      // the importing module only, and the probe controller lives in this root module.
      // Nest caches module instances, so this is the same AuthModule the app uses.
      imports: [AppModule, AuthModule],
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, validateEnv({ NODE_ENV: 'test' }));
    await app.init();

    tokens = app.get(AccessTokenService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a freshly issued token and identifies the caller', async () => {
    const issued = tokens.issue({ userId: USER_ID, sessionId: SESSION_ID });

    const response = await request(app.getHttpServer())
      .get(PROTECTED)
      .set('Authorization', `Bearer ${issued.accessToken}`)
      .expect(200);

    expect(response.body).toEqual({ sub: USER_ID });
  });

  /**
   * AC5, as a status code.
   *
   * The token is signed by this application, with its real key, at a clock offset that
   * puts its fifteen-minute expiry a minute in the past. Nothing about the token is
   * hand-forged, so the only reason it fails is the one the criterion is about.
   *
   * The clock is moved for the ISSUE and restored before the request: fake timers are
   * global, and leaving them on would stall the HTTP stack the request needs. That is
   * also why the offset is computed from the real clock rather than from a fixed date —
   * verification happens under the real one.
   *
   * Before the token service converted jsonwebtoken's `TokenExpiredError` into an
   * `UnauthenticatedError`, this request was a 500 with a stack trace in the logs — the
   * exact regression AC5 names.
   */
  it('answers 401, not 500, once the token has expired (AC5)', async () => {
    const issued = issuedAtOffset(-(ACCESS_TOKEN_TTL_SECONDS + 60));

    const response = await request(app.getHttpServer())
      .get(PROTECTED)
      .set('Authorization', `Bearer ${issued}`)
      .expect(401);

    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.status).toBe(401);
    expect(problem.type).toBe(ProblemType.UNAUTHENTICATED);
    expect(response.headers['content-type']).toContain('application/problem+json');
    // No stack trace, no library error name, no mention of the signing key.
    expect(response.text).not.toMatch(/TokenExpiredError|jsonwebtoken|at Object/);
  });

  /**
   * The other side of the boundary: fourteen minutes old is still valid.
   *
   * Without this, "expired tokens are rejected" would also be satisfied by rejecting
   * every token, which is not a working login.
   */
  it('still accepts a token that has not yet reached fifteen minutes (AC5)', async () => {
    const issued = issuedAtOffset(-(ACCESS_TOKEN_TTL_SECONDS - 60));

    await request(app.getHttpServer())
      .get(PROTECTED)
      .set('Authorization', `Bearer ${issued}`)
      .expect(200);
  });

  it.each([
    ['no Authorization header', undefined],
    ['an empty Bearer', 'Bearer '],
    ['a token that is not a JWT', 'Bearer not-a-jwt'],
    ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['a JWT with a broken signature', 'Bearer a.b.c'],
  ])('answers 401 for %s', async (_label, header) => {
    const call = request(app.getHttpServer()).get(PROTECTED);
    if (header !== undefined) call.set('Authorization', header);

    const response = await call.expect(401);
    expect(problemDetailsSchema.parse(response.body).type).toBe(ProblemType.UNAUTHENTICATED);
  });

  it('rejects a token signed with a different key', async () => {
    const foreign = new AccessTokenService(
      validateEnv({
        NODE_ENV: 'test',
        JWT_ACCESS_SECRET: 'a-completely-different-signing-key!!!!',
      }),
    ).issue({ userId: USER_ID, sessionId: SESSION_ID });

    await request(app.getHttpServer())
      .get(PROTECTED)
      .set('Authorization', `Bearer ${foreign.accessToken}`)
      .expect(401);
  });

  it('honours @Public on a route inside a guarded controller (I5)', async () => {
    await request(app.getHttpServer()).get('/api/v1/probe/open').expect(200);
  });

  /**
   * Issues a real token as though the clock had been `offsetSeconds` from now.
   *
   * Timers are faked only for the signing call — jsonwebtoken reads `Date.now()` for
   * `iat` — and restored immediately, because the request that follows needs a real
   * clock to complete.
   */
  function issuedAtOffset(offsetSeconds: number): string {
    jest.useFakeTimers({ now: new Date(Date.now() + offsetSeconds * 1000) });
    try {
      return tokens.issue({ userId: USER_ID, sessionId: SESSION_ID }).accessToken;
    } finally {
      jest.useRealTimers();
    }
  }
});
