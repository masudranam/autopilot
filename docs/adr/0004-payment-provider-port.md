# ADR-0004 · Payment provider port with a mock as the default

**Status:** Accepted · 2026-08-12

## Context

Checkout is the most important flow to get right and the hardest to test. Building directly against
Stripe would mean test keys in every environment, the Stripe CLI running to forward webhooks, and CI
either holding a secret or skipping the checkout suite entirely.

Skipping it is the worst outcome: the paths that most need coverage — decline, timeout, partial
refund, duplicate capture — are the ones a live integration exercises least.

## Decision

Define a `PaymentProvider` port and program the checkout module entirely against it.

```ts
interface PaymentProvider {
  createIntent(input): Promise<PaymentIntent>;
  capture(intentId, idempotencyKey): Promise<PaymentResult>;
  refund(paymentId, amountMinor, idempotencyKey): Promise<RefundResult>;
  verifyWebhook(rawBody, signature): WebhookEvent;
}
```

`MockPaymentProvider` is the default in development, test and CI. It is deterministic, and specific
magic amounts force decline, timeout and partial-refund outcomes so every failure branch has a test
that actually reaches it.

`StripePaymentProvider` implements the same port and is selected by `PAYMENT_PROVIDER=stripe`. With
no keys present the application still boots and the mock stays active.

## Consequences

**Good**

- The entire checkout and refund suite runs with no secrets, so CI verifies it on every PR.
- Failure paths are reachable on demand instead of being hoped for.
- Swapping or adding a provider is an adapter, not a rewrite.

**Bad**

- The mock can drift from Stripe's real semantics — a passing suite is not proof the live
  integration works.
- Two implementations to maintain.

**Mitigation**

The Stripe adapter's own tests assert against recorded Stripe fixtures rather than the mock's
behaviour, so the two are checked against reality independently. Webhook signature verification is
tested with genuine Stripe-format payloads.
