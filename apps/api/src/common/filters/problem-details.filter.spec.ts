import { BadRequestException, HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { z } from 'zod';
import { problemDetailsSchema, ProblemType } from '@repo/contracts';
import { ProblemDetailsFilter, zodToFieldErrors } from './problem-details.filter';
import {
  ConflictError,
  InsufficientStockError,
  NotFoundError,
  ValidationError,
} from '../errors/domain-error';

/** Captures what the filter would send, without an HTTP server. */
function captureResponse() {
  const sent: { status?: number; contentType?: string; body?: unknown; headersSent: boolean } = {
    headersSent: false,
  };
  const response = {
    get headersSent() {
      return sent.headersSent;
    },
    status(code: number) {
      sent.status = code;
      return response;
    },
    type(value: string) {
      sent.contentType = value;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
      return response;
    },
  };
  return { sent, response };
}

function hostFor(response: unknown, url = '/api/v1/things'): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ originalUrl: url, method: 'GET' }),
    }),
  } as unknown as ArgumentsHost;
}

function run(exception: unknown, { production = false } = {}) {
  const { sent, response } = captureResponse();
  new ProblemDetailsFilter(production).catch(exception, hostFor(response));
  // Every body must satisfy the contract — not merely "look about right" (I3).
  const problem = problemDetailsSchema.parse(sent.body);
  return { ...sent, problem };
}

describe('every error becomes RFC 9457 (AC1, I3)', () => {
  it('renders a domain error with its own status, type and title', () => {
    const { status, contentType, problem } = run(new NotFoundError('No such product.'));
    expect(status).toBe(404);
    expect(contentType).toBe('application/problem+json');
    expect(problem.type).toBe(ProblemType.NOT_FOUND);
    expect(problem.title).toBe('Not found');
    expect(problem.detail).toBe('No such product.');
    expect(problem.instance).toBe('/api/v1/things');
  });

  it.each([
    [new ValidationError('bad'), 422, ProblemType.VALIDATION_FAILED],
    [new ConflictError('clash'), 409, ProblemType.CONFLICT],
    [
      new InsufficientStockError({ sku: 'TEE-M', available: 2 }),
      409,
      ProblemType.INSUFFICIENT_STOCK,
    ],
  ])('maps %s to its declared status and type', (error, status, type) => {
    const result = run(error);
    expect(result.problem.status).toBe(status);
    expect(result.problem.type).toBe(type);
  });

  it('puts the available quantity in the detail of a stock error', () => {
    const { problem } = run(new InsufficientStockError({ sku: 'TEE-M', available: 2 }));
    expect(problem.detail).toContain('2');
    expect(problem.detail).toContain('TEE-M');
  });

  it('maps a Zod failure to 422 with one entry per bad field', () => {
    const schema = z.object({ email: z.email(), quantity: z.int().positive() });
    let thrown: unknown;
    try {
      schema.parse({ email: 'nope', quantity: -1 });
    } catch (error) {
      thrown = error;
    }

    const { problem } = run(thrown);
    expect(problem.status).toBe(422);
    expect(problem.type).toBe(ProblemType.VALIDATION_FAILED);
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'email' }),
        expect.objectContaining({ path: 'quantity' }),
      ]),
    );
  });

  it('flattens nested Zod paths to dotted notation', () => {
    const schema = z.object({ lines: z.array(z.object({ quantity: z.int().positive() })) });
    try {
      schema.parse({ lines: [{ quantity: 0 }] });
    } catch (error) {
      expect(zodToFieldErrors(error as z.ZodError)[0]?.path).toBe('lines.0.quantity');
    }
    expect.hasAssertions();
  });

  it('converts a Nest HttpException, preserving its status', () => {
    const { problem } = run(new BadRequestException('Malformed JSON'));
    expect(problem.status).toBe(400);
    expect(problem.detail).toBe('Malformed JSON');
    expect(problem.type).toBe(ProblemType.VALIDATION_FAILED);
  });

  it('converts a 404 from the router into the not-found problem type', () => {
    const { problem } = run(new HttpException('Cannot GET /nope', HttpStatus.NOT_FOUND));
    expect(problem.status).toBe(404);
    expect(problem.type).toBe(ProblemType.NOT_FOUND);
  });

  it('renders a non-Error throw rather than crashing the filter', () => {
    const { problem } = run('a bare string');
    expect(problem.status).toBe(500);
    expect(problem.type).toBe(ProblemType.INTERNAL);
  });

  it('never writes a body when headers were already sent', () => {
    const { sent, response } = captureResponse();
    sent.headersSent = true;
    new ProblemDetailsFilter(false).catch(new NotFoundError('x'), hostFor(response));
    expect(sent.body).toBeUndefined();
  });
});

describe('production leaks nothing (AC2)', () => {
  // The strings below are the shapes that actually show up in unhandled errors.
  const LEAKY = [
    new Error('select * from "users" where "email" = $1 -- syntax error at position 42'),
    new Error('connect ECONNREFUSED postgresql://ecommerce:hunter2@10.0.0.4:5432/shop'),
    new Error('ENOENT: no such file or directory, open /srv/app/secrets/jwt.key'),
    new Error('Invalid `prisma.user.findMany()` invocation in /app/dist/src/users.js:88'),
  ];

  it.each(LEAKY.map((e) => [e.message.slice(0, 40), e] as const))(
    'suppresses %s',
    (_label, error) => {
      const { problem } = run(error, { production: true });

      expect(problem.status).toBe(500);
      expect(problem.detail).toBe(
        'An unexpected error occurred. Quote the traceId when reporting it.',
      );

      // Nothing anywhere in the serialised body may echo the original.
      const serialised = JSON.stringify(problem).toLowerCase();
      for (const fragment of [
        'select',
        'postgres',
        'hunter2',
        'econnrefused',
        '/srv/',
        'prisma',
        '.js:',
      ]) {
        expect(serialised).not.toContain(fragment);
      }
    },
  );

  it('never includes a stack trace in production', () => {
    const error = new Error('boom');
    const { problem } = run(error, { production: true });
    expect(JSON.stringify(problem)).not.toContain('at ');
    expect(Object.keys(problem)).not.toContain('stack');
  });

  it('keeps the real message in development, where debugging blind is the bigger hazard', () => {
    const { problem } = run(new Error('boom'), { production: false });
    expect(problem.detail).toBe('boom');
  });

  // A domain error's message is author-written and safe by construction — production
  // must NOT suppress it, or every 404 becomes unactionable.
  it('still shows domain error detail in production', () => {
    const { problem } = run(new NotFoundError('No such order.'), { production: true });
    expect(problem.detail).toBe('No such order.');
  });
});
