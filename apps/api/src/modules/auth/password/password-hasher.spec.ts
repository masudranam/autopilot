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

  // ---------------------------------------------------------------- F8/AC4

  it('verifies through its own method, not just the library (AC4)', async () => {
    const encoded = await hasher.hash(PASSWORD);

    await expect(hasher.verify(encoded, PASSWORD)).resolves.toBe(true);
    await expect(hasher.verify(encoded, `${PASSWORD}x`)).resolves.toBe(false);
  });

  /**
   * The seed writes placeholder hashes for its demo accounts, and a user row could hold
   * anything after a bad import. A throw here would surface as a 500 and would
   * distinguish "account exists with an unusable hash" from "wrong password" — the
   * distinction AC4 exists to remove.
   */
  it('answers false for an unusable stored hash instead of throwing (AC4)', async () => {
    for (const stored of ['', 'seed-placeholder-hash:ada@example.test', '$argon2id$broken']) {
      await expect(hasher.verify(stored, PASSWORD)).resolves.toBe(false);
    }
  });

  /**
   * The dummy-hash path is what makes an unknown email cost the same as a known one.
   *
   * Both halves are asserted: it always answers false, and it costs the same order of
   * magnitude as a real verify. The timing bound is expressed as a RATIO of a measured
   * real verify rather than a fixed millisecond count, so it scales with the machine —
   * an absolute floor passes on a slow CI runner even when the work was skipped.
   */
  it('pays a full Argon2id verify when there is no account to check (AC4)', async () => {
    const encoded = await hasher.hash(PASSWORD);

    await expect(hasher.verifyAgainstDummy(PASSWORD)).resolves.toBe(false);
    await expect(hasher.verifyAgainstDummy('anything-at-all')).resolves.toBe(false);

    const realCost = await medianElapsed(() => hasher.verify(encoded, `${PASSWORD}x`));
    const dummyCost = await medianElapsed(() => hasher.verifyAgainstDummy(`${PASSWORD}x`));

    // Deliberately loose: a regression detector for "the verify was skipped", not a
    // constant-time proof. Returning `false` without hashing scores ~0.001 here.
    expect(dummyCost).toBeGreaterThan(realCost * 0.5);
  });

  /**
   * The dummy hash is computed ONCE, not per call.
   *
   * A `hash()` on every unknown-email login would double that path's cost relative to a
   * wrong-password login — the same oracle again, pointing the other way, and it would
   * sail through the "did it pay a verify?" test above.
   *
   * MEASURED AS A RATIO OF TWO SINGLE ARGON2 CALLS, deliberately. The earlier form of
   * this test compared the dummy path against a hash-then-verify baseline, and that
   * comparison is two operations against one: under CPU contention the queueing delay
   * does not divide evenly between them, and the test failed with the code correct
   * (observed in a full-suite run at a 1% margin, and again after switching to medians
   * at 0.7%). Both quantities below are exactly one memory-hard call, interleaved in
   * the same loop, so contention multiplies them together and cancels out of the ratio.
   *
   * The separation is wide and was measured, not guessed. Under eight competing CPU
   * workers the correct implementation scored 0.99–1.20 across six runs; the per-call
   * variant scored 1.89–2.07 across four. The 1.5 bound sits between them with about a
   * quarter of the range to spare on each side.
   */
  it('reuses one dummy hash rather than computing a fresh one per call (AC4)', async () => {
    const fresh = new PasswordHasher();
    await fresh.verifyAgainstDummy('warm-up');
    const encoded = await fresh.hash(PASSWORD);

    const verifySamples: number[] = [];
    const dummySamples: number[] = [];

    for (let i = 0; i < 7; i += 1) {
      verifySamples.push(await elapsed(() => fresh.verify(encoded, `${PASSWORD}x`)));
      dummySamples.push(await elapsed(() => fresh.verifyAgainstDummy(`${PASSWORD}x`)));
    }

    const oneVerify = median(verifySamples);
    const dummy = median(dummySamples);

    // One Argon2 call, not two. Hashing per call lands at roughly two.
    expect(dummy).toBeLessThan(oneVerify * 1.5);
  });
});

async function elapsed(work: () => Promise<unknown>): Promise<number> {
  const start = process.hrtime.bigint();
  await work();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function medianElapsed(work: () => Promise<unknown>, rounds = 5): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < rounds; i += 1) samples.push(await elapsed(work));
  return median(samples);
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}
