/**
 * F7/AC1 — the hash really is Argon2id, really is salted, and really verifies.
 *
 * Verification uses the library's own `verify`, which is the only proof that the
 * stored string is a usable credential rather than a plausible-looking one. F8 will
 * depend on exactly this property.
 */
import { verify } from '@node-rs/argon2';
import { PasswordHasher } from './password-hasher';

const PASSWORD = 'a-genuinely-long-passphrase';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('produces an Argon2id hash — not Argon2i, not Argon2d (AC1)', async () => {
    const encoded = await hasher.hash(PASSWORD);

    // The variant is the first field of the PHC string. Argon2d resists GPU cracking
    // but leaks through side channels; Argon2i is the reverse. Only the hybrid is the
    // one the acceptance criterion names, and only this assertion tells them apart.
    expect(encoded.startsWith('$argon2id$')).toBe(true);
    expect(encoded.startsWith('$argon2i$')).toBe(false);
    expect(encoded.startsWith('$argon2d$')).toBe(false);
  });

  it('records the ADR-0009 cost parameters in the encoded hash', async () => {
    const encoded = await hasher.hash(PASSWORD);
    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('salts every hash — the same password twice gives two different strings', async () => {
    const [first, second] = await Promise.all([hasher.hash(PASSWORD), hasher.hash(PASSWORD)]);

    expect(first).not.toBe(second);
    // Same parameters, different salt+digest: identical prefix, different tail.
    expect(first.slice(0, first.indexOf('$', 10))).toBe(second.slice(0, second.indexOf('$', 10)));
    await expect(verify(first, PASSWORD)).resolves.toBe(true);
    await expect(verify(second, PASSWORD)).resolves.toBe(true);
  });

  it('verifies the right password and rejects a near miss', async () => {
    const encoded = await hasher.hash(PASSWORD);

    await expect(verify(encoded, PASSWORD)).resolves.toBe(true);
    await expect(verify(encoded, `${PASSWORD}x`)).resolves.toBe(false);
    await expect(verify(encoded, PASSWORD.toUpperCase())).resolves.toBe(false);
  });

  it('never embeds the plaintext in the hash', async () => {
    const encoded = await hasher.hash(PASSWORD);
    expect(encoded).not.toContain(PASSWORD);
  });
});
