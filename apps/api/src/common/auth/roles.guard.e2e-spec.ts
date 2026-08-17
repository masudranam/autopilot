/**
 * Role-based authorisation end to end (SPEC.md F10, AC1 and AC2).
 *
 * There are no `@Roles(Role.ADMIN)` routes in the application yet — the admin panel is
 * E8 — so AC2 is tested as the invariant it actually is: *an admin-decorated route
 * rejects a customer token*. The probe controller below is that route. When E8 lands,
 * its own suite covers the real ones and this keeps covering the rule.
 *
 * Also covers issue #86, the precedence bug this PR closes: a class-level `@Public()`
 * must not make a handler-level `@Authenticated()` or `@Roles()` route public.
 */
import 'reflect-metadata';
import type { Server } from 'node:http';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { problemDetailsSchema, ProblemType, Role } from '@repo/contracts';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { AuthModule } from '../../modules/auth/auth.module';
import { AccessTokenService } from '../../modules/auth/tokens/access-token.service';
import { validateEnv } from '../../config/env';
import { Authenticated } from './authenticated.decorator';
import { Public } from './public.decorator';
import { Roles } from './roles.decorator';

const USER_ID = '018f1f77-bcf8-7c3d-9a3b-2c4c6b3f0a11';
const SESSION_ID = '018f1f77-bcf8-7c3d-9a3b-2c4c6b3f0a22';

@Controller('rbac')
class RbacProbeController {
  @Roles(Role.ADMIN)
  @Get('admin-only')
  adminOnly(): { ok: true } {
    return { ok: true };
  }

  @Roles(Role.ADMIN, Role.SUPPORT)
  @Get('staff')
  staff(): { ok: true } {
    return { ok: true };
  }

  @Authenticated()
  @Get('any-signed-in')
  anySignedIn(): { ok: true } {
    return { ok: true };
  }
}

/**
 * The #86 shape: the CONTROLLER is public, one handler is not.
 *
 * Before this PR the guard asked only about `@Public()` with `getAllAndOverride`, found
 * the class-level marker, and let everything through — while the I5 sweep, which reads
 * handler metadata, saw `@Roles()`/`@Authenticated()` and reported the routes as
 * decided. Open at runtime, green in CI.
 */
@Public()
@Controller('mixed')
class MixedProbeController {
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }

  @Roles(Role.ADMIN)
  @Get('admin-only')
  adminOnly(): { ok: true } {
    return { ok: true };
  }

  @Authenticated()
  @Get('signed-in')
  signedIn(): { ok: true } {
    return { ok: true };
  }
}

describe('role-based authorisation (F10)', () => {
  let app: INestApplication;
  let tokens: AccessTokenService;

  const tokenFor = (role: (typeof Role)[keyof typeof Role]): string =>
    tokens.issue({ userId: USER_ID, sessionId: SESSION_ID, role }).accessToken;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, AuthModule],
      controllers: [RbacProbeController, MixedProbeController],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, validateEnv({ NODE_ENV: 'test' }));
    await app.init();
    const server = app.getHttpServer() as Server;
    if (!server.listening) {
      await new Promise<void>((resolve) => {
        server.listen(0, () => resolve());
      });
    }
    tokens = app.get(AccessTokenService);
  });

  afterAll(async () => {
    await app.close();
  });

  // ------------------------------------------------------------------ AC1

  it('admits the named role', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/rbac/admin-only')
      .set('Authorization', `Bearer ${tokenFor(Role.ADMIN)}`)
      .expect(200);
  });

  it('admits any of several named roles, and refuses the rest', async () => {
    for (const role of [Role.ADMIN, Role.SUPPORT]) {
      await request(app.getHttpServer())
        .get('/api/v1/rbac/staff')
        .set('Authorization', `Bearer ${tokenFor(role)}`)
        .expect(200);
    }
    await request(app.getHttpServer())
      .get('/api/v1/rbac/staff')
      .set('Authorization', `Bearer ${tokenFor(Role.CUSTOMER)}`)
      .expect(403);
  });

  it('leaves an @Authenticated route open to every role', async () => {
    for (const role of [Role.CUSTOMER, Role.SUPPORT, Role.ADMIN]) {
      await request(app.getHttpServer())
        .get('/api/v1/rbac/any-signed-in')
        .set('Authorization', `Bearer ${tokenFor(role)}`)
        .expect(200);
    }
  });

  // ------------------------------------------------------------------ AC2

  it('rejects a customer token on an admin route with 403 and Problem Details', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/rbac/admin-only')
      .set('Authorization', `Bearer ${tokenFor(Role.CUSTOMER)}`)
      .expect(403);

    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.status).toBe(403);
    expect(problem.type).toBe(ProblemType.FORBIDDEN);
    // 403 and not 404 on purpose: an admin route is not a per-account resource, so its
    // existence is not a secret (it is in the OpenAPI document). I4's hide-existence
    // rule is about another account's ROW, which is a different question.
    expect(response.text).not.toContain('Not found');
  });

  it('refuses an unauthenticated caller with 401, not 403 — the token is checked first', async () => {
    await request(app.getHttpServer()).get('/api/v1/rbac/admin-only').expect(401);
  });

  /**
   * Guard ORDER, which is a real failure mode rather than a hypothetical.
   *
   * `RolesGuard` reads the role from claims the JWT guard attached. Registered the other
   * way round it would find no claims and answer 403 for everyone — including the
   * correct role — so this asserts the admitted case, which is the one that breaks.
   */
  it('runs the JWT guard before the role guard', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/rbac/admin-only')
      .set('Authorization', `Bearer ${tokenFor(Role.ADMIN)}`)
      .expect(200);
  });

  // -------------------------------------------------- #86: marker precedence

  it('a class-level @Public does not open a handler marked @Roles (#86)', async () => {
    await request(app.getHttpServer()).get('/api/v1/mixed/admin-only').expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/mixed/admin-only')
      .set('Authorization', `Bearer ${tokenFor(Role.CUSTOMER)}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/mixed/admin-only')
      .set('Authorization', `Bearer ${tokenFor(Role.ADMIN)}`)
      .expect(200);
  });

  it('a class-level @Public does not open a handler marked @Authenticated (#86)', async () => {
    await request(app.getHttpServer()).get('/api/v1/mixed/signed-in').expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/mixed/signed-in')
      .set('Authorization', `Bearer ${tokenFor(Role.CUSTOMER)}`)
      .expect(200);
  });

  it('a class-level @Public still opens a handler that declares nothing', async () => {
    // The other direction. A fix that closed everything would pass the two tests above
    // while breaking every genuinely public controller.
    await request(app.getHttpServer()).get('/api/v1/mixed/open').expect(200);
  });
});
