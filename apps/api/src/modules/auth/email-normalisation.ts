/**
 * The canonical form of an email address for storage and lookup (F7/AC4).
 *
 * Trim, then lower-case. `A@B.com` and `a@b.com` become the same string, so the
 * `@unique` index on `users.email` is what enforces case-insensitive uniqueness —
 * including for two requests racing in parallel, where an application-level check
 * would have a window between the read and the write.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — dots and plus-tags are left alone.
 * `a.b@gmail.com`, `ab@gmail.com` and `ab+shop@gmail.com` all reach the same Gmail
 * mailbox, so stripping them would block a second signup from one person. It is not
 * done here for two reasons. First, it is provider-specific: at most other hosts
 * `a.b@` and `ab@` are genuinely different mailboxes, and folding them lets whoever
 * registers first permanently deny the other person their own address — a worse bug
 * than the one being fixed. Second, it is the wrong control: "one account per real
 * mailbox" is enforced by requiring a verified email (F11), which a plus-tag does not
 * evade because the verification link still has to be clicked. The local part is
 * therefore preserved exactly as sent, minus case.
 *
 * Case-folding the local part is technically over-reach too — RFC 5321 says the local
 * part is case-sensitive and only the domain is not — but no mail provider in
 * practical use treats it that way, and users type their own address inconsistently.
 * Storing `Ada@Example.com` and `ada@example.com` as two accounts would produce far
 * more real support tickets than the standards-purity is worth.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
