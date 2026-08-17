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
import { APP_GUARD } from '@nestjs/core';
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
import { RolesGuard } from './roles.guard';

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
/** The inverse of MixedProbe: a role-gated controller with one deliberately open route. */
@Roles(Role.ADMIN)
@Controller('staff-area')
class StaffAreaProbeController {
  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }

  @Get('inherited')
  inherited(): { ok: true } {
    return { ok: true };
  }
}

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
      controllers: [RbacProbeController, MixedProbeController, StaffAreaProbeController],
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

  it('a bare handler inherits the controller-level @Roles', async () => {
    await request(app.getHttpServer()).get('/api/v1/staff-area/inherited').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/staff-area/inherited')
      .set('Authorization', `Bearer ${tokenFor(Role.CUSTOMER)}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/staff-area/inherited')
      .set('Authorization', `Bearer ${tokenFor(Role.ADMIN)}`)
      .expect(200);
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

  it('a handler @Public inside a @Roles controller is public, not a dead route', async () => {
    // Found by probing during the review of PR #90: with getAllAndOverride this
    // answered 403 to EVERYONE including the named role — JwtAuthGuard honoured the
    // handler's public marker and attached no claims, then RolesGuard found the
    // class's roles and rejected for want of one. Closed, but silently bricked.
    await request(app.getHttpServer()).get('/api/v1/staff-area/open').expect(200);
  });

  it('a class-level @Public still opens a handler that declares nothing', async () => {
    // The other direction. A fix that closed everything would pass the two tests above
    // while breaking every genuinely public controller.
    await request(app.getHttpServer()).get('/api/v1/mixed/open').expect(200);
  });
});

/**
 * `RolesGuard` alone, with no `JwtAuthGuard` in front of it.
 *
 * The branch under test is `!role` in `canActivate` — the one whose comment says it
 * "must fail closed" because returning true "would make every @Roles route public".
 * The review of PR #90 mutated it to admit and watched all 42 tests stay green: the
 * branch was real, reachable, and covered by nothing.
 *
 * This is the missing test. It builds a module where the JWT guard is genuinely absent,
 * which is what a wiring mistake looks like, and asserts the role guard still refuses.
 */
@Controller('nojwt')
class NoJwtProbeController {
  @Roles(Role.ADMIN)
  @Get('admin')
  admin(): { ok: true } {
    return { ok: true };
  }
}

describe('RolesGuard fails closed when no claims were attached', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NoJwtProbeController],
      providers: [RolesGuard, { provide: APP_GUARD, useExisting: RolesGuard }],
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses rather than admitting a request with no role claim', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/nojwt/admin').expect(403);
    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.type).toBe(ProblemType.FORBIDDEN);
  });
});
