---
description: Run one complete feature cycle on the next unblocked issue
argument-hint: '[issue number — optional, defaults to the next unblocked one]'
---

Run the `feature-cycle` skill for a single feature.

Target issue: $ARGUMENTS

If no issue number was given, pick the lowest-numbered open issue whose `Depends on` issues are all
closed. If one was given, use it, but check its dependencies first and warn if any are still open.

Follow every step of the skill: claim, branch, implement, test, verify, PR, review, gate, merge,
advance. Do not skip the review gate, and do not merge on anything other than a `PASS` with green
CI.

When you are done, report what merged, what the reviewer said, and what the next unblocked issue is.
