import { describe, expect, it } from 'vitest';
import {
  addMoney,
  formatMoney,
  minorUnitExponent,
  moneySchema,
  multiplyMoney,
  nonNegativeMoneySchema,
  percentageOf,
  subtractMoney,
  zeroMoney,
  type Money,
} from './money';

const usd = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

describe('moneySchema', () => {
  it('accepts an integer amount with a 3-letter currency', () => {
    expect(moneySchema.parse({ amountMinor: 1999, currency: 'USD' })).toEqual({
      amountMinor: 1999,
      currency: 'USD',
    });
  });

  it('rejects a fractional amount — money is minor units, never a float (I1)', () => {
    expect(() => moneySchema.parse({ amountMinor: 19.99, currency: 'USD' })).toThrow();
  });

  it('rejects a currency that is not exactly three characters', () => {
    expect(() => moneySchema.parse({ amountMinor: 100, currency: 'DOLLAR' })).toThrow();
  });

  it('normalises currency to upper case', () => {
    expect(moneySchema.parse({ amountMinor: 100, currency: 'usd' }).currency).toBe('USD');
  });

  it('allows a negative amount — refunds and adjustments are legitimate', () => {
    expect(moneySchema.parse({ amountMinor: -500, currency: 'USD' }).amountMinor).toBe(-500);
  });

  it('rejects a negative amount where non-negative is required', () => {
    expect(() => nonNegativeMoneySchema.parse({ amountMinor: -1, currency: 'USD' })).toThrow();
  });
});

describe('minorUnitExponent', () => {
  it.each([
    ['USD', 2],
    ['EUR', 2],
    ['GBP', 2],
    ['JPY', 0],
    ['KRW', 0],
    ['KWD', 3],
    ['BHD', 3],
  ])('%s has exponent %i', (currency, expected) => {
    expect(minorUnitExponent(currency)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(minorUnitExponent('jpy')).toBe(0);
  });

  it('defaults to 2 for an unlisted currency', () => {
    expect(minorUnitExponent('ZZZ')).toBe(2);
  });
});

describe('formatMoney', () => {
  it('formats a 2-decimal currency', () => {
    expect(formatMoney(usd(1999))).toBe('$19.99');
  });

  // The bug this guards: dividing by a hardcoded 100 would render ¥1,999 as ¥19.99.
  it('formats a zero-decimal currency without inventing decimals', () => {
    expect(formatMoney({ amountMinor: 1999, currency: 'JPY' }, 'en-US')).toBe('¥1,999');
  });

  it('formats a three-decimal currency', () => {
    const formatted = formatMoney({ amountMinor: 1999, currency: 'KWD' }, 'en-US');
    expect(formatted).toContain('1.999');
  });

  it('formats zero', () => {
    expect(formatMoney(usd(0))).toBe('$0.00');
  });

  it('formats a negative amount', () => {
    expect(formatMoney(usd(-500))).toBe('-$5.00');
  });
});

describe('arithmetic', () => {
  it('adds', () => {
    expect(addMoney(usd(1000), usd(999))).toEqual(usd(1999));
  });

  it('subtracts', () => {
    expect(subtractMoney(usd(1000), usd(999))).toEqual(usd(1));
  });

  it('multiplies by a quantity', () => {
    expect(multiplyMoney(usd(1999), 3)).toEqual(usd(5997));
  });

  it('refuses a fractional quantity', () => {
    expect(() => multiplyMoney(usd(1999), 1.5)).toThrow(TypeError);
  });

  it('refuses to combine different currencies', () => {
    expect(() => addMoney(usd(100), { amountMinor: 100, currency: 'EUR' })).toThrow(TypeError);
    expect(() => subtractMoney(usd(100), { amountMinor: 100, currency: 'EUR' })).toThrow(TypeError);
  });

  // The whole reason for integer minor units: 0.1 + 0.2 !== 0.3 in float.
  it('is exact where floating point would not be', () => {
    expect(addMoney(usd(10), usd(20)).amountMinor).toBe(30);
    let total = zeroMoney('USD');
    for (let i = 0; i < 10; i += 1) total = addMoney(total, usd(10));
    expect(total.amountMinor).toBe(100);
  });
});

describe('percentageOf', () => {
  it.each([
    [1000, 10, 100],
    [1999, 10, 200], // 199.9 rounds half-up to 200
    [1995, 50, 998], // 997.5 rounds half-up to 998
    [100, 0, 0],
    [100, 100, 100],
  ])('%i minor units at %i%% is %i', (amount, percent, expected) => {
    expect(percentageOf(usd(amount), percent).amountMinor).toBe(expected);
  });

  it('always returns an integer number of minor units', () => {
    for (const amount of [1, 7, 33, 199, 1999, 12345]) {
      for (const percent of [3, 7, 12.5, 33.3]) {
        expect(Number.isInteger(percentageOf(usd(amount), percent).amountMinor)).toBe(true);
      }
    }
  });

  // Math.round(-0.5) is -0 but Math.round(0.5) is 1, so a naive implementation makes
  // a discount and its reversal disagree by one minor unit.
  it('rounds negative amounts symmetrically with positive ones', () => {
    const positive = percentageOf(usd(1995), 50).amountMinor;
    const negative = percentageOf(usd(-1995), 50).amountMinor;
    expect(negative).toBe(-positive);
  });

  it('preserves the currency', () => {
    expect(percentageOf({ amountMinor: 1000, currency: 'JPY' }, 10).currency).toBe('JPY');
  });
});
