import { z } from 'zod';

/**
 * Money is an integer in the currency's minor unit, always paired with its currency.
 * Never a float — see docs/adr/0003-money-as-integer-minor-units.md (invariant I1).
 */
export const moneySchema = z.object({
  amountMinor: z.int(),
  currency: z.string().length(3).toUpperCase(),
});

export type Money = z.infer<typeof moneySchema>;

/** Money that cannot be negative — prices, totals, refund amounts. */
export const nonNegativeMoneySchema = moneySchema.extend({
  amountMinor: z.int().nonnegative(),
});

/**
 * How many minor units make one major unit.
 *
 * Most currencies are 100, but not all: JPY and KRW have no minor unit at all, and
 * KWD/BHD/OMR use three decimal places. Hardcoding 100 silently mis-prices those by
 * a factor of 100 or 1000, so the exponent is looked up rather than assumed.
 */
const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

const DEFAULT_MINOR_UNIT_EXPONENT = 2;

export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? DEFAULT_MINOR_UNIT_EXPONENT;
}

/**
 * Formats money for display. This is the only place money becomes a string.
 *
 * `toFixed` is banned by lint for money precisely because it invites doing this
 * ad hoc at call sites, where the currency's exponent gets forgotten.
 */
export function formatMoney(money: Money, locale = 'en-US'): string {
  const exponent = minorUnitExponent(money.currency);
  const major = money.amountMinor / 10 ** exponent;

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(major);
}

/** Adds money of the same currency. Mixing currencies is a programming error. */
export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function multiplyMoney(money: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new TypeError(`Quantity must be an integer, received ${quantity}`);
  }
  return { amountMinor: money.amountMinor * quantity, currency: money.currency };
}

/**
 * Applies a percentage and rounds half-up to the nearest minor unit.
 *
 * Rounding happens here, once, rather than accumulating across a totals pipeline —
 * SPEC.md F27/AC2 requires a single defined rounding stage.
 *
 * Half-up is applied to the absolute value so that -50 and 50 round symmetrically;
 * `Math.round` alone rounds -0.5 towards zero and +0.5 away from it, which makes a
 * discount and its reversal disagree by a minor unit.
 */
export function percentageOf(money: Money, percent: number): Money {
  const exact = (money.amountMinor * percent) / 100;
  const rounded = Math.sign(exact) * Math.round(Math.abs(exact));
  return { amountMinor: rounded, currency: money.currency };
}

export function zeroMoney(currency: string): Money {
  return { amountMinor: 0, currency: currency.toUpperCase() };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Cannot combine ${a.currency} with ${b.currency}`);
  }
}
