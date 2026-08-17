import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  loginRequestSchema,
  REFRESH_COOKIE_NAME,
  registerRequestSchema,
  sessionIdSchema,
} from '@repo/contracts';
// A separate `import type` line rather than inline type specifiers on the line above:
// the guard-write hook's payload-type heuristic reads an inline specifier as a local
// declaration and blocks the file, even though this imports the contract rather than
// redeclaring it.
import type {
  AccessTokenClaims,
  AuthTokens,
  LoginRequest,
  RegisterRequest,
  RegisteredUser,
  SessionSummary,
} from '@repo/contracts';
import { Authenticated } from '../../common/auth/authenticated.decorator';
import type { RequestWithAuth } from '../../common/auth/jwt-auth.guard';
import { Public } from '../../common/auth/public.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import type { Env } from '../../config/env';
import { ENV } from '../../config/env.module';
import { AuthService, type IssuedSession } from './auth.service';
import type { SessionOrigin } from './auth.repository';
import { clearRefreshCookie, setRefreshCookie } from './refresh-cookie';

/**
 * HTTP only: parse, delegate, serialise. Every rule lives in the service.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Nest answers 201 for POST by default, which is the correct code here — a resource
   * was created and the body is that resource.
   */
  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create a customer account' })
  @ApiCreatedResponse({ description: 'The account was created.' })
  @ApiUnprocessableEntityResponse({
    description:
      'The payload failed validation or the password is in the common-password list — ' +
      'RFC 9457 Problem Details with a per-field `errors[]`.',
  })
  @ApiConflictResponse({ description: 'That email address is already registered.' })
  register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
  ): Promise<RegisteredUser> {
    return this.auth.register(body);
  }

  /**
   * 200, not 201: a login creates a session server-side, but the thing being returned
   * is a credential, not a resource the client can go and fetch.
   *
   * `@Res({ passthrough: true })` gives access to `Set-Cookie` while leaving Nest in
   * charge of serialising the return value — taking the response object over entirely
   * would route around the interceptors and the global filter.
   *
   * @Public because it obviously must be, and explicitly so: I5 is that every route
   * carries a decision, not that every route demands a token.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for an access token and a refresh cookie' })
  @ApiOkResponse({
    description:
      'Access token in the body; refresh token in an httpOnly, secure, sameSite=strict cookie.',
  })
  @ApiUnauthorizedResponse({
    description:
      'The credentials are not valid. Identical in body and in timing whether or not ' +
      'the address is registered (F8/AC4).',
  })
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokens> {
    const issued = await this.auth.login(body, originOf(request));
    return this.withRefreshCookie(response, issued);
  }

  /**
   * The refresh token is read from the cookie and never from the body or a header.
   *
   * This handler therefore reads no request body at all — there is nothing here to
   * validate a body against, because nothing consumes one. The one input it does read,
   * the cookie, is parsed by `refreshTokenSchema` from `@repo/contracts` inside the
   * service before it is used (I2).
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiCookieAuth(REFRESH_COOKIE_NAME)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  @ApiOkResponse({ description: 'A new access token, and a new refresh cookie replacing the old.' })
  @ApiUnauthorizedResponse({
    description:
      'The cookie is missing, malformed, expired, revoked — or was already rotated, ' +
      'in which case the entire session family is revoked as well (F8/AC3).',
  })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokens> {
    const presented = cookieValue(request, REFRESH_COOKIE_NAME);
    const issued = await this.auth.refresh(presented, originOf(request));
    return this.withRefreshCookie(response, issued);
  }

  /**
   * The caller's active sessions (F9/AC1).
   *
   * `request.auth` is populated by `JwtAuthGuard`, which is global from F9 — so this
   * handler cannot run without verified claims, and `sub`/`sid` are trustworthy rather
   * than read from anything the client sent.
   */
  @Authenticated()
  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the caller's active sessions" })
  @ApiOkResponse({ description: 'Active sessions, newest use first. Never any token material.' })
  @ApiUnauthorizedResponse({ description: 'Missing, malformed or expired access token.' })
  listSessions(@Req() request: RequestWithAuth): Promise<SessionSummary[]> {
    const auth = claimsOf(request);
    return this.auth.listSessions(auth.sub, auth.sid);
  }

  /**
   * Revokes one session (F9/AC2, AC4).
   *
   * 404 rather than 403 for another account's session id, and the ownership check is
   * part of the database query rather than a comparison here — see the repository. A
   * 403 would confirm the id exists, which is the leak I4 exists to prevent.
   */
  @Authenticated()
  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one of the caller’s sessions' })
  @ApiNoContentResponse({ description: 'The session is revoked; its refresh token is now dead.' })
  @ApiNotFoundResponse({
    description: "No such active session for this caller — including another account's session.",
  })
  @ApiUnauthorizedResponse({ description: 'Missing, malformed or expired access token.' })
  async revokeSession(
    @Req() request: RequestWithAuth,
    @Param('id', new ZodValidationPipe(sessionIdSchema)) id: string,
  ): Promise<void> {
    await this.auth.revokeSession(id, claimsOf(request).sub);
  }

  /**
   * Ends the current session and clears the cookie (F9/AC3).
   *
   * `@Public()` on purpose, and it is not a hole. Logout is driven by the refresh
   * cookie, not the access token, so a client whose access token has already expired
   * can still sign out — requiring a valid access token here would mean "sign in again
   * to sign out". Possession of the cookie is the only claim being made, and the worst
   * an attacker without it can do is clear their own.
   *
   * Always 204, whatever the cookie was. See `AuthService.logout` for why an unknown
   * token must not answer differently from a real one.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiCookieAuth(REFRESH_COOKIE_NAME)
  @ApiOperation({ summary: 'Revoke the current session and clear the refresh cookie' })
  @ApiNoContentResponse({ description: 'Signed out. Answers 204 even if no session was found.' })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(cookieValue(request, REFRESH_COOKIE_NAME));
    clearRefreshCookie(response, this.env);
  }

  /**
   * The only place a plaintext refresh token is written anywhere, and it is written to
   * a header — never to the body, which is why `IssuedSession.tokens` is returned
   * rather than `issued`.
   */
  private withRefreshCookie(response: Response, issued: IssuedSession): AuthTokens {
    setRefreshCookie(response, this.env, issued.refreshToken, issued.refreshTokenExpiresAt);
    return issued.tokens;
  }
}

/**
 * Reads one cookie without trusting the shape of `req.cookies`.
 *
 * cookie-parser populates it, but a request with no Cookie header leaves it empty and a
 * duplicated cookie name yields an array — so anything that is not a string is treated
 * as absent rather than being passed on to be hashed.
 */
function cookieValue(request: Request, name: string): string | undefined {
  const cookies: unknown = request.cookies;
  if (!cookies || typeof cookies !== 'object') return undefined;
  const value = (cookies as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Where this session is being created from, for the session list in F9.
 *
 * The user-agent is truncated: it is attacker-controlled and unbounded, and there is no
 * reason to let a client write a megabyte into a column on every login. `req.ip` is
 * whatever Express resolves — behind a proxy that means configuring `trust proxy`, and
 * until then it is the peer address, which is the honest value rather than a spoofable
 * `X-Forwarded-For` read by hand.
 */
function originOf(request: Request): SessionOrigin {
  const userAgent = request.headers['user-agent'];
  return {
    device: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
    ip: request.ip ?? null,
  };
}

/**
 * The verified claims, or a loud failure.
 *
 * `RequestWithAuth.auth` is optional because the type describes a request both before
 * and after the guard. On an `@Authenticated()` route the guard has already run, so
 * absence here means the guard was unregistered or the decorator lost — a wiring bug,
 * not a client error. Throwing beats `!` : it fails as a 500 that names the cause
 * instead of a TypeError deep in a handler.
 */
function claimsOf(request: RequestWithAuth): AccessTokenClaims {
  if (!request.auth) {
    throw new Error('Route is marked @Authenticated but no claims were attached by the guard');
  }
  return request.auth;
}
