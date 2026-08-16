/**
 * The rotation transaction, against a real Postgres and with real concurrency
 * (SPEC.md F8/AC2, AC3).
 *
 * This sits below HTTP on purpose. The end-to-end suite fires six parallel refreshes
 * and asserts one winner, but that path spends milliseconds in routing, cookie parsing
 * and JSON serialisation before the transaction opens, which is long enough that the
 * requests can end up queueing behind each other rather than genuinely interleaving —
 * a race test that only sometimes races is a test that only sometimes tests. Calling
 * the repository directly removes that padding, so the two transactions really do
 * overlap inside the database.
 *
 * Verified by mutation: dropping `rotatedAt: null` from the conditional update's WHERE
 * clause — the change that turns this into a read-then-write — makes
 * `rotateSession` hand out two successors here and fails the first test below.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { PrismaClient } from '../../db/client';
import { AuthRepository, type RotationOutcome } from './auth.repository';
import { RefreshTokenService } from './tokens/refresh-token.service';

const TEST_DOMAIN = '@f8-repository.test';

describe('AuthRepository.rotateSession under concurrency', () => {
  let repository: AuthRepository;
  let refreshTokens: RefreshTokenService;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    repository = app.get(AuthRepository);
    refreshTokens = app.get(RefreshTokenService);
    prisma = app.get(PrismaService).client;
    close = () => app.close();
  });

  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
    const user = await prisma.user.create({
      data: {
        email: `rotator${TEST_DOMAIN}`,
        passwordHash: 'not-used-by-this-suite',
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
      select: { id: true },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
    await close();
  });

  /** A live session, and the token that unlocks it. */
  async function openSession(): Promise<{ id: string; tokenHash: string }> {
    const minted = refreshTokens.mint();
    const session = await repository.createSession({
      userId,
      family: refreshTokens.newFamily(),
      refreshTokenHash: minted.tokenHash,
      expiresAt: minted.expiresAt,
      origin: { device: 'jest', ip: null },
    });
    return { id: session.id, tokenHash: minted.tokenHash };
  }

  /**
   * Resolves once some statement is parked on a `sessions` row lock.
   *
   * This replaces a fixed sleep. The sleep was never a correctness guarantee — both
   * interleavings answer `reused` — but it did decide whether the *interesting* one
   * happened, and on a slow runner 500 ms is not reliably enough for the contender to
   * reach its UPDATE. Polling the lock table asks the database the actual question.
   *
   * Read from `pg_stat_activity`, not `pg_locks`: a statement waiting on a row lock
   * blocks on the holder's `transactionid`, and that lock row carries a NULL `relation`
   * — so the obvious `pg_locks JOIN pg_class ... WHERE NOT granted` never matches and
   * silently reports "not blocked". Measured, not reasoned: that version returned false
   * on every poll while the contender was demonstrably parked.
   *
   * Matched on the statement text so a Jest worker blocked on some other table is not
   * mistaken for this one. A false positive would only make this return early, which
   * degrades to the ordering the fixed sleep used to gamble on.
   */
  async function waitForBlockedUpdateOnSessions(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%sessions%'
      `;
      if ((row?.waiting ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  function rotate(presentedHash: string): Promise<RotationOutcome> {
    const next = refreshTokens.mint();
    return repository.rotateSession({
      presentedHash,
      next: {
        refreshTokenHash: next.tokenHash,
        expiresAt: next.expiresAt,
        origin: { device: 'jest', ip: null },
      },
    });
  }

  /**
   * WHAT THIS ONE DOES NOT DETECT, stated so nobody reads it as the guarantee.
   *
   * Measured by mutation: with `rotatedAt: null` deleted from the conditional update,
   * this test passed on every one of three runs. Two rotations rarely overlap closely
   * enough — the loser's pre-read usually happens after the winner has committed, so it
   * classifies as `reused` for the wrong reason and the missing WHERE clause never gets
   * exercised. What it does assert is the OUTCOME contract: exactly one caller is told
   * `rotated`, the other `reused`, and no third row appears. The atomicity itself is
   * held by the eight-way test below and, deterministically, by the row-lock test after
   * it.
   */
  it('lets exactly one of two simultaneous rotations win (AC2)', async () => {
    const { tokenHash } = await openSession();

    const outcomes = await Promise.all([rotate(tokenHash), rotate(tokenHash)]);

    expect(outcomes.map((result) => result.outcome).sort()).toEqual(['reused', 'rotated']);

    // One original plus ONE successor. Two successors would mean two live refresh
    // tokens for one single-use token.
    expect(await prisma.session.count({ where: { userId } })).toBe(2);
  });

  /**
   * Eight is enough for at least one pair to land inside each other's window: with the
   * conditional update's `rotatedAt: null` deleted this test failed on every run, where
   * the two-way version above did not. It is still a probabilistic detector, which is
   * why the deterministic one follows.
   */
  it('lets exactly one of eight simultaneous rotations win (AC2)', async () => {
    const { tokenHash } = await openSession();

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => rotate(tokenHash)));

    expect(outcomes.filter((result) => result.outcome === 'rotated')).toHaveLength(1);
    expect(outcomes.filter((result) => result.outcome === 'reused')).toHaveLength(7);
    expect(await prisma.session.count({ where: { userId } })).toBe(2);
  });

  /**
   * The race, made deterministic (AC2).
   *
   * `Promise.all` over N rotations only *probably* interleaves: measured here, the
   * two-way version above passes on every run even with `rotatedAt: null` deleted from
   * the conditional update's WHERE clause, because the loser's pre-read usually happens
   * after the winner has already committed. Only the eight-way version reliably lands a
   * pair inside each other's window. That makes both of them probabilistic detectors of
   * the bug they exist to catch, which is not a property a gate should rely on.
   *
   * This test forces the exact interleaving instead, with Postgres doing the
   * synchronisation:
   *
   *   1. a second connection takes `SELECT … FOR UPDATE` on the session row;
   *   2. `rotateSession` runs — its pre-read sees `rotated_at IS NULL` (a row lock does
   *      not block a plain read), and its UPDATE then blocks on the lock;
   *   3. while it is blocked, the second connection rotates the row itself and commits;
   *   4. the blocked UPDATE wakes, re-evaluates its WHERE against the new committed row.
   *
   * With `rotatedAt: null` in the WHERE, step 4 matches nothing, `count` is 0 and the
   * caller is told `reused` — one winner. Without it, step 4 matches, a second successor
   * is inserted, and the session now has two live refresh tokens. Verified by mutation:
   * deleting `rotatedAt: null` fails this test on every run.
   */
  it('a rotation that loses the row lock is refused, not granted a second successor (AC2)', async () => {
    const session = await openSession();

    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let lockAcquired!: () => void;
    const holdsLock = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });

    // The competing refresh: holds the row lock, then commits its own rotation.
    const competitor = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT id FROM sessions WHERE id = ${session.id} FOR UPDATE`;
        lockAcquired();
        await blocked;
        await tx.$executeRaw`UPDATE sessions SET rotated_at = now() WHERE id = ${session.id}`;
      },
      { timeout: 20_000, maxWait: 10_000 },
    );

    // Starting the contender before this resolved was a race in the test itself: on a
    // loaded runner the competitor had not yet taken its connection or its lock, so the
    // contender rotated uncontended and reported `rotated`. Waiting on the lock makes
    // the setup an ordering guarantee instead of a hope. (CI, run 31933663225.)
    await holdsLock;

    const contender = rotate(session.tokenHash);
    const parked = await waitForBlockedUpdateOnSessions();
    unblock();
    await competitor;

    // Both interleavings answer `reused`, so the assertion below does not depend on the
    // wait above landing — but only the parked one exercises the conditional update's
    // WHERE clause, which is the mutation this test exists to catch. If the contender
    // never blocked, the test would still pass while proving nothing, so fail loudly.
    expect(parked).toBe(true);

    expect((await contender).outcome).toBe('reused');

    // The original row and the competitor's rotation of it — and nothing the contender
    // inserted. A second successor here means two live refresh tokens for one
    // single-use token, which is the whole failure this criterion exists to prevent.
    expect(await prisma.session.count({ where: { userId } })).toBe(1);
  });

  /**
   * The rotation is one transaction, proven by making its last statement fail (AC2).
   *
   * The successor insert is forced to violate the unique index on `refresh_token_hash`.
   * If the claim and the insert were not in the same transaction, the presented row
   * would stay marked `rotated_at` while no successor existed — the account would be
   * locked out of its own session by a transient database error, and the next
   * presentation of the still-valid cookie would be read as theft and kill the family.
   *
   * The statement-count test in `auth-refresh.e2e-spec.ts` names a transaction in its
   * title but only counts operations; this is the assertion that the transaction is
   * really there.
   */
  it('rolls the claim back when the successor cannot be inserted (AC2)', async () => {
    const presented = await openSession();
    const collision = await openSession();

    await expect(
      repository.rotateSession({
        presentedHash: presented.tokenHash,
        next: {
          // Already taken by the second session — the insert cannot succeed.
          refreshTokenHash: collision.tokenHash,
          expiresAt: new Date(Date.now() + 60_000),
          origin: { device: 'jest', ip: null },
        },
      }),
    ).rejects.toThrow();

    const row = await prisma.session.findUniqueOrThrow({ where: { id: presented.id } });
    expect(row.rotatedAt).toBeNull();
    // …and the token still works, because nothing about it was consumed.
    expect((await rotate(presented.tokenHash)).outcome).toBe('rotated');
  });

  it('reports a second, later presentation as reuse rather than as unknown (AC3)', async () => {
    const { tokenHash } = await openSession();

    const first = await rotate(tokenHash);
    const second = await rotate(tokenHash);

    expect(first.outcome).toBe('rotated');
    expect(second.outcome).toBe('reused');
    if (second.outcome !== 'reused') throw new Error('unreachable');
    expect(second.userId).toBe(userId);
  });

  it('revokes every session in the family, and only that family (AC3)', async () => {
    const doomed = await openSession();
    await openSession(); // a second device, in its own family

    const rotated = await rotate(doomed.tokenHash);
    if (rotated.outcome !== 'rotated') throw new Error('expected the first rotation to win');

    const revoked = await repository.revokeFamily(rotated.session.family);
    expect(revoked).toBe(2); // the original and its successor

    const sessions = await prisma.session.findMany({ where: { userId } });
    for (const session of sessions) {
      expect(session.revokedAt === null).toBe(session.family !== rotated.session.family);
    }
  });

  it('is idempotent, and does not restamp an already-revoked session (AC3)', async () => {
    const { tokenHash } = await openSession();
    const rotated = await rotate(tokenHash);
    if (rotated.outcome !== 'rotated') throw new Error('expected the first rotation to win');

    expect(await repository.revokeFamily(rotated.session.family)).toBe(2);
    // A stolen token gets presented repeatedly; the second sweep must find nothing left
    // to revoke rather than rewriting the timestamps of the first.
    expect(await repository.revokeFamily(rotated.session.family)).toBe(0);
  });
});
