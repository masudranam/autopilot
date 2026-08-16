/**
 * Refresh token minting and hashing (F8/AC1, AC2, AC3).
 *
 * The two properties that matter are that the token is unguessable and that what gets
 * stored is not the token. Both are asserted against the real crypto, because a mocked
 * digest would prove nothing about either.
 */
import {
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_TTL_SECONDS,
  refreshTokenSchema,
} from '@repo/contracts';
import { validateEnv } from '../../../config/env';
import { RefreshTokenService } from './refresh-token.service';

const KEY = 'a-refresh-hmac-key-of-sufficient-length!!';
const OTHER_KEY = 'a-completely-different-hmac-key-here!!!!!';

function serviceWith(secret: string): RefreshTokenService {
  return new RefreshTokenService(validateEnv({ NODE_ENV: 'test', JWT_REFRESH_SECRET: secret }));
}

describe('RefreshTokenService.mint', () => {
  const tokens = serviceWith(KEY);

  it('produces a token the contract accepts', () => {
    expect(refreshTokenSchema.safeParse(tokens.mint().token).success).toBe(true);
  });

  it('produces 256 bits of entropy, freshly, every time', () => {
    const minted = Array.from({ length: 200 }, () => tokens.mint().token);

    // No collisions in 200 draws is a weak statement on its own; the strong one is the
    // decoded length, which is where "unguessable" actually comes from.
    expect(new Set(minted).size).toBe(200);
    for (const token of minted) {
      expect(Buffer.from(token, 'base64url')).toHaveLength(REFRESH_TOKEN_BYTES);
    }
  });

  it('never returns the token and its hash as the same value', () => {
    const minted = tokens.mint();

    expect(minted.tokenHash).not.toBe(minted.token);
    // The stored value must not contain the token — a "hash" that embeds its input
    // stores the credential in plain sight.
    expect(minted.tokenHash).not.toContain(minted.token);
    expect(minted.tokenHash).toBe(tokens.hash(minted.token));
  });

  it('expires 30 days after it was minted (SPEC §6.4)', () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    const minted = tokens.mint(now);

    expect(minted.expiresAt.getTime() - now.getTime()).toBe(REFRESH_TOKEN_TTL_SECONDS * 1000);
    expect(minted.expiresAt.toISOString()).toBe('2026-09-15T12:00:00.000Z');
  });
});

describe('RefreshTokenService.hash', () => {
  const tokens = serviceWith(KEY);

  it('is deterministic, so the presented token can be found by its index (AC2)', () => {
    const token = tokens.mint().token;
    expect(tokens.hash(token)).toBe(tokens.hash(token));
    // …and stable across instances, or a restart would log everybody out.
    expect(serviceWith(KEY).hash(token)).toBe(tokens.hash(token));
  });

  it('produces a full SHA-256 digest', () => {
    expect(tokens.hash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is keyed — the same token hashes differently under a different secret', () => {
    const token = tokens.mint().token;

    // This is the property a plain SHA-256 would lack: with a stolen database dump but
    // no key, an attacker cannot confirm a guessed token by recomputing its digest.
    expect(serviceWith(OTHER_KEY).hash(token)).not.toBe(tokens.hash(token));
  });

  it('separates tokens that differ by a single character', () => {
    const a = 'a'.repeat(43);
    const b = `${'a'.repeat(42)}b`;
    expect(tokens.hash(a)).not.toBe(tokens.hash(b));
  });
});

describe('RefreshTokenService.newFamily', () => {
  it('opens a distinct lineage per login (AC3)', () => {
    const tokens = serviceWith(KEY);
    const families = Array.from({ length: 100 }, () => tokens.newFamily());

    expect(new Set(families).size).toBe(100);
    // Two logins sharing a family would mean detecting theft on one device revoked the
    // other — and, worse, that revoking one family could miss sessions in it.
    for (const family of families) {
      expect(family).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
