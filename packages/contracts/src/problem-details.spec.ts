import { describe, expect, it } from 'vitest';
import { ProblemType, problemDetailsSchema } from './problem-details';

const valid = {
  type: ProblemType.NOT_FOUND,
  title: 'Not found',
  status: 404,
  traceId: '01JB2X',
};

describe('problemDetailsSchema', () => {
  it('accepts a minimal problem', () => {
    expect(problemDetailsSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a validation problem with per-field errors', () => {
    const problem = {
      ...valid,
      type: ProblemType.VALIDATION_FAILED,
      status: 422,
      detail: 'The request body is invalid.',
      instance: '/api/v1/cart/lines',
      errors: [{ path: 'lines.0.quantity', message: 'exceeds available stock' }],
    };
    expect(problemDetailsSchema.parse(problem)).toEqual(problem);
  });

  // traceId is what ties a response to its log lines; a response without one is
  // undebuggable, so it is required rather than optional.
  it('requires a traceId', () => {
    const { traceId: _traceId, ...withoutTrace } = valid;
    expect(() => problemDetailsSchema.parse(withoutTrace)).toThrow();
  });

  it('requires type to be a URI', () => {
    expect(() => problemDetailsSchema.parse({ ...valid, type: 'not-found' })).toThrow();
  });

  it.each([99, 600, 200.5])('rejects an out-of-range status %s', (status) => {
    expect(() => problemDetailsSchema.parse({ ...valid, status })).toThrow();
  });

  it('rejects a malformed errors entry', () => {
    expect(() => problemDetailsSchema.parse({ ...valid, errors: [{ path: 'x' }] })).toThrow();
  });
});

describe('ProblemType', () => {
  it('every type is a distinct absolute URI', () => {
    const uris = Object.values(ProblemType);
    expect(new Set(uris).size).toBe(uris.length);
    for (const uri of uris) expect(uri).toMatch(/^https:\/\//);
  });
});
