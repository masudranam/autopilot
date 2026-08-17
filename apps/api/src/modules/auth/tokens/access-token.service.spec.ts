/**
 * The access token, on its own (F8/AC1 and AC5).
 *
 * No HTTP and no database: the claims, the fifteen-minute expiry and every rejection
 * path are properties of this class, and testing them here means each one is asserted
 * against the real jsonwebtoken behaviour rather than through five layers of framework.
 */
import jwt from 'jsonwebtoken';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TTL_SECONDS,
  accessTokenClaimsSchema,
} from '@repo/contracts';
import { UnauthenticatedError } from '../../../common/errors/domain-error';
import { validateEnv } from '../../../config/env';
import { ACCESS_TOKEN_REJECTED, AccessTokenService } from './access-token.service';

const USER_ID = '018f1f77-bcf8-7c3d-9a3b-2c4c6b3f0a11';
const SESSION_ID = '018f1f77-bcf8-7c3d-9a3b-2c4c6b3f0a22';

const SECRET = 'a-test-signing-secret-of-sufficient-length';
const OTHER_SECRET = 'a-different-signing-secret-entirely-here!!';

function serviceWith(secret: string): AccessTokenService {
  return new AccessTokenService(validateEnv({ NODE_ENV: 'test', JWT_ACCESS_SECRET: secret }));
}

describe('AccessTokenService.issue', () => {
  const tokens = serviceWith(SECRET);

  it('issues a token carrying the user and the session that minted it (AC1)', () => {
    const issued = tokens.issue({ userId: USER_ID, sessionId: SESSION_ID, role: 'CUSTOMER' });

    expect(issued.tokenType).toBe('Bearer');
    expect(issued.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);

    const claims = accessTokenClaimsSchema.parse(jwt.decode(issued.accessToken));
    expect(claims.sub).toBe(USER_ID);
    expect(claims.sid).toBe(SESSION_ID);
    expect(claims.iss).toBe(ACCESS_TOKEN_ISSUER);
    expect(claims.aud).toBe(ACCESS_TOKEN_AUDIENCE);
  });

  /**
   * AC5's number, read off an actual token.
   *
   * `exp - iat` is the lifetime the token itself claims, which is what any client and
   * any other verifier will act on. Written as the literal 900 as well as the constant,
   * so a change to the constant fails here rather than propagating silently.
   */
  it('expires exactly 15 minutes after issue (AC5)', () => {
    const issued = tokens.issue({ userId: USER_ID, sessionId: SESSION_ID, role: 'CUSTOMER' });
    const claims = accessTokenClaimsSchema.parse(jwt.decode(issued.accessToken));

    expect(claims.exp - claims.iat).toBe(900);
    expect(claims.exp - claims.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('signs with HS256 and never with `none`', () => {
    const issued = tokens.issue({ userId: USER_ID, sessionId: SESSION_ID, role: 'CUSTOMER' });
    const header = JSON.parse(
      Buffer.from(issued.accessToken.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as { alg: string };

    expect(header.alg).toBe('HS256');
  });

  it('carries no password material and no refresh token', () => {
    const issued = tokens.issue({ userId: USER_ID, sessionId: SESSION_ID, role: 'CUSTOMER' });
    const payload = jwt.decode(issued.accessToken) as Record<string, unknown>;

    // A JWT payload is base64, not encryption — everything in it is public to whoever
    // holds the token. Only ids, timestamps and the role belong there.
    //
    // `role` joined the set in F10. It is not sensitive — a caller already knows what
    // it may do by trying — but it is pinned here for the same reason as the rest: this
    // assertion is what stops an email address or a name being added to the token by
    // someone reaching for a convenient place to put it.
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'role', 'sid', 'sub']);
  });
});

describe('AccessTokenService.verify', () => {
  const tokens = serviceWith(SECRET);

  it('accepts a token it issued and returns the parsed claims', () => {
    const issued = tokens.issue({ userId: USER_ID, sessionId: SESSION_ID, role: 'CUSTOMER' });
    const claims = tokens.verify(issued.accessToken);

    expect(claims.sub).toBe(USER_ID);
    expect(claims.sid).toBe(SESSION_ID);
  });

  /**
   * AC5: expired means 401, not 500.
   *
   * Fake timers rather than a hand-forged `exp`, so the token under test is one this
   * service really issued and the only thing that changed is the clock — which is the
   * thing the criterion is about. jsonwebtoken reads Date.now(), so advancing the fake
   * clock genuinely expires it.
   */
  describe('expiry (AC5)', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-08-16T12:00:00.000Z') });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('still accepts the token one second before it expires', () => {
      const issued = tokens.issue({ userId: USER_ID, sessionId: SESSION_ID, role: 'CUSTOMER' });

      jest.advanceTimersByTime((ACCESS_TOKEN_TTL_SECONDS - 1) * 1000);
      expect(tokens.verify(issued.accessToken).sub).toBe(USER_ID);
    });

    it('rejects it with a 401 domain error once fifteen minutes have passed', () => {
      const issued = tokens.issue({ userId: USER_ID, sessionId: SESSION_ID, role: 'CUSTOMER' });

      jest.advanceTimersByTime((ACCESS_TOKEN_TTL_SECONDS + 1) * 1000);

      const failure = failureOf(() => tokens.verify(issued.accessToken));
      // The specific regression: jsonwebtoken's own TokenExpiredError escaping this
      // method reaches the global filter as an unrecognised throw and renders as a 500.
      expect(failure).toBeInstanceOf(UnauthenticatedError);
      expect(failure).not.toBeInstanceOf(jwt.TokenExpiredError);
      expect((failure as UnauthenticatedError).status).toBe(401);
      expect((failure as UnauthenticatedError).message).toBe(ACCESS_TOKEN_REJECTED);
    });
  });

  it.each([
    ['garbage', 'not-a-jwt-at-all'],
    ['an empty string', ''],
    ['only two segments', 'header.payload'],
  ])('rejects %s with the same 401', (_label, token) => {
    const failure = failureOf(() => tokens.verify(token));
    expect(failure).toBeInstanceOf(UnauthenticatedError);
    expect((failure as UnauthenticatedError).message).toBe(ACCESS_TOKEN_REJECTED);
  });

  it('rejects a token signed with a different key', () => {
    const forged = serviceWith(OTHER_SECRET).issue({
      userId: USER_ID,
      sessionId: SESSION_ID,
      role: 'CUSTOMER',
    });
    expect(failureOf(() => tokens.verify(forged.accessToken))).toBeInstanceOf(UnauthenticatedError);
  });

  /**
   * The algorithm-confusion attack, spelled out.
   *
   * An attacker takes a real payload, re-encodes the header as `{"alg":"none"}` and
   * drops the signature. A verifier that trusts the token's own header accepts it.
   *
   * NOTE ON WHAT THIS DOES AND DOES NOT PIN: it does not, on its own, protect the
   * `algorithms: ['HS256']` option. Measured by mutation — deleting that option leaves
   * this test green, because jsonwebtoken given a string secret already refuses `none`.
   * The option is pinned by the HS512 test below, which is the case jsonwebtoken really
   * would accept without it. This test is kept because `none` must be rejected however
   * the verification is implemented, and a future move to a KeyObject or a JWKS
   * resolver would change which default applies.
   */
  it('rejects an unsigned token that claims alg=none', () => {
    const issued = tokens.issue({ userId: USER_ID, sessionId: SESSION_ID, role: 'CUSTOMER' });
    const payloadSegment = issued.accessToken.split('.')[1] ?? '';
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );

    expect(failureOf(() => tokens.verify(`${noneHeader}.${payloadSegment}.`))).toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  /**
   * The assertion that actually holds `algorithms: ['HS256']` in place.
   *
   * Without the option, jsonwebtoken accepts any HMAC variant the token's own header
   * names — this exact token, signed HS512 with the same secret, verifies. That is the
   * seam algorithm confusion widens: the set of accepted algorithms becomes something
   * the attacker writes rather than something the server decided, and the moment a key
   * of another type is introduced (an RS256 public key used as an HMAC secret is the
   * textbook case) it becomes a forgery. Verified by mutation: deleting the option
   * turns this token into an accepted one.
   */
  it('rejects a token signed with a different HMAC variant, pinning the algorithm list', () => {
    const hs512 = jwt.sign({ sid: SESSION_ID }, SECRET, {
      algorithm: 'HS512',
      subject: USER_ID,
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });

    // The token is otherwise perfect — right key, right issuer, right audience, not
    // expired — so the only thing that can reject it is the algorithm pin.
    expect(failureOf(() => tokens.verify(hs512))).toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects a token whose payload was edited to impersonate someone else', () => {
    const issued = tokens.issue({ userId: USER_ID, sessionId: SESSION_ID, role: 'CUSTOMER' });
    const [header, payload, signature] = issued.accessToken.split('.');
    const tampered = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    tampered.sub = '018f1f77-bcf8-7c3d-9a3b-2c4c6b3f0a99';

    const forged = `${header}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${signature}`;
    expect(failureOf(() => tokens.verify(forged))).toBeInstanceOf(UnauthenticatedError);
  });

  it.each([
    ['issuer', { issuer: 'somebody-else', audience: ACCESS_TOKEN_AUDIENCE }],
    ['audience', { issuer: ACCESS_TOKEN_ISSUER, audience: 'another-api' }],
  ])('rejects a correctly-signed token with the wrong %s', (_label, claims) => {
    const foreign = jwt.sign({ sid: SESSION_ID }, SECRET, {
      algorithm: 'HS256',
      subject: USER_ID,
      expiresIn: 900,
      ...claims,
    });

    expect(failureOf(() => tokens.verify(foreign))).toBeInstanceOf(UnauthenticatedError);
  });

  /**
   * A validly-signed token whose payload does not match the contract.
   *
   * The interesting part is the STATUS: a raw ZodError escaping `verify` would reach
   * the global filter, which deliberately maps a bare ZodError to 500 (it could equally
   * have come from parsing an upstream response). Here it must be a 401.
   */
  it('rejects a signed token whose claims do not match the contract, as 401 not 500', () => {
    const malformed = jwt.sign({ sid: 'not-a-uuid' }, SECRET, {
      algorithm: 'HS256',
      subject: 'also-not-a-uuid',
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: 900,
    });

    const failure = failureOf(() => tokens.verify(malformed));
    expect(failure).toBeInstanceOf(UnauthenticatedError);
    expect((failure as UnauthenticatedError).status).toBe(401);
  });

  it('says the same thing however the token failed', () => {
    const messages = ['not-a-jwt', 'header.payload.signature', ''].map(
      (token) => (failureOf(() => tokens.verify(token)) as UnauthenticatedError).message,
    );
    expect(new Set(messages).size).toBe(1);
  });
});

/** Runs `work`, expecting it to throw, and hands back what it threw. */
function failureOf(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned');
}
