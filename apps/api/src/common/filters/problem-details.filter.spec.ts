import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  type ArgumentsHost,
} from '@nestjs/common';
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

  // `problem` validates the contract (I3). `raw` is what actually goes on the wire.
  //
  // These MUST stay distinct. problemDetailsSchema is a plain z.object, so parsing
  // STRIPS unknown keys — pr-reviewer added `stack` and `sqlHint` to the production
  // 500 body and all 18 tests here passed, including one asserting `stack` was absent,
  // because the schema had already removed it before the assertion ran. Leak
  // assertions must therefore read `raw`, never `problem`.
  const problem = problemDetailsSchema.parse(sent.body);
  const raw = sent.body as Record<string, unknown>;
  return { ...sent, problem, raw };
}

/** Every value anywhere in the body, so a leak cannot hide in an undeclared field. */
function allValues(body: Record<string, unknown>): string {
  return JSON.stringify(body).toLowerCase();
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

  // Request validation reaches the filter as a ValidationError (the pipe converts it),
  // which is what produces a 422 with per-field errors[].
  it('maps a request ValidationError to 422 with one entry per bad field', () => {
    const { problem } = run(
      new ValidationError('The request did not match the expected shape.', [
        { path: 'email', message: 'Invalid email address' },
        { path: 'quantity', message: 'Too small: expected number to be >0' },
      ]),
    );

    expect(problem.status).toBe(422);
    expect(problem.type).toBe(ProblemType.VALIDATION_FAILED);
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'email' }),
        expect.objectContaining({ path: 'quantity' }),
      ]),
    );
  });

  // A BARE ZodError is not necessarily the caller's fault — it could come from parsing
  // an upstream provider's response. Treating it as 422 would blame the caller and
  // publish internal field paths in errors[] (pr-reviewer).
  it('treats a bare ZodError as an internal fault, not a client 422', () => {
    const schema = z.object({ internalToken: z.string() });
    let thrown: unknown;
    try {
      schema.parse({ internalToken: 42 });
    } catch (error) {
      thrown = error;
    }

    const { problem, raw } = run(thrown);
    expect(problem.status).toBe(500);
    expect(problem.type).toBe(ProblemType.INTERNAL);
    expect(problem.errors).toBeUndefined();
    // The internal field path must not reach the client body.
    expect(allValues(raw)).toContain('internaltoken'); // development shows it…
  });

  it('suppresses the internal field paths of a bare ZodError in production', () => {
    const schema = z.object({ chargeInternalToken: z.string() });
    let thrown: unknown;
    try {
      schema.parse({ chargeInternalToken: 42 });
    } catch (error) {
      thrown = error;
    }

    const { problem, raw } = run(thrown, { production: true });
    expect(problem.status).toBe(500);
    expect(allValues(raw)).not.toContain('chargeinternaltoken');
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
      const { problem, raw } = run(error, { production: true });

      expect(problem.status).toBe(500);
      expect(problem.detail).toBe(
        'An unexpected error occurred. Quote the traceId when reporting it.',
      );

      // Against RAW, not the parsed problem: the schema strips unknown keys, so a
      // leak added in an undeclared field would be invisible to a parsed assertion.
      const serialised = allValues(raw);
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
    const { raw } = run(new Error('boom'), { production: true });
    expect(JSON.stringify(raw)).not.toContain('at ');
    expect(Object.keys(raw)).not.toContain('stack');
  });

  // The body must carry EXACTLY the contract's fields. Without this, any future
  // addition to the response object — a debug aid, a stack, a hint — ships silently,
  // because every other assertion here looks at declared fields only.
  it('emits no field the contract does not declare', () => {
    const permitted = new Set([
      'type',
      'title',
      'status',
      'detail',
      'instance',
      'traceId',
      'errors',
    ]);
    for (const error of [...LEAKY, new NotFoundError('x'), new ValidationError('y')]) {
      const { raw } = run(error, { production: true });
      expect(Object.keys(raw).filter((key) => !permitted.has(key))).toEqual([]);
    }
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

  // Suppression used to be keyed on exception CLASS, so this — the most common way a
  // 500 is raised in a Nest codebase — returned SQL and credentials verbatim while an
  // identical plain Error was suppressed. Found by pr-reviewer.
  it('suppresses a 5xx HttpException exactly like a bare throw', () => {
    const leak = 'select * from "users" -- pg://u:hunter2@10.0.0.4 at /srv/app/dist/users.js:12';
    const { problem, raw } = run(new InternalServerErrorException(leak), { production: true });

    expect(problem.status).toBe(500);
    expect(problem.detail).toBe(
      'An unexpected error occurred. Quote the traceId when reporting it.',
    );
    for (const fragment of ['select', 'hunter2', 'pg://', '/srv/']) {
      expect(allValues(raw)).not.toContain(fragment);
    }
  });

  it('suppresses any 5xx status, not just 500', () => {
    const { problem } = run(new HttpException('database is down', 503), { production: true });
    expect(problem.status).toBe(503);
    expect(problem.detail).not.toContain('database');
  });

  // 4xx describes the caller's own mistake — suppressing it makes the API unusable.
  it('does not suppress 4xx detail in production', () => {
    const { problem } = run(new BadRequestException('quantity must be positive'), {
      production: true,
    });
    expect(problem.detail).toBe('quantity must be positive');
  });
});

describe('express-layer errors keep their own status (AC1)', () => {
  /**
   * Shape body-parser uses: a plain Error carrying `status`/`statusCode` AND
   * `expose: true`, the http-errors flag meaning "this message is safe for the client".
   */
  function withStatus(message: string, status: number, expose = true): Error {
    return Object.assign(new Error(message), { status, statusCode: status, expose });
  }

  it('renders an oversized payload as 413, not 500', () => {
    const { problem } = run(withStatus('request entity too large', 413));
    expect(problem.status).toBe(413);
    expect(problem.title).toBe('Payload too large');
    // Not INTERNAL: a client switching on `type` must not see "internal" for their
    // own oversized upload.
    expect(problem.type).toBe(ProblemType.PAYLOAD_TOO_LARGE);
  });

  it('renders an unsupported content type as 415', () => {
    const { problem } = run(withStatus('unsupported media type', 415));
    expect(problem.status).toBe(415);
    expect(problem.type).toBe(ProblemType.UNSUPPORTED_MEDIA_TYPE);
  });

  it('ignores an implausible carried status rather than trusting it', () => {
    const { problem } = run(withStatus('nonsense', 999));
    expect(problem.status).toBe(500);
  });

  it('suppresses a carried 5xx in production like any other', () => {
    const { problem } = run(withStatus('internal detail here', 503), { production: true });
    expect(problem.detail).not.toContain('internal detail');
  });

  // Without the expose requirement, ANY thrown object with a numeric 4xx sent its own
  // message to the client, unsuppressed. pr-reviewer demonstrated an S3-shaped error
  // rendering an access key id and a Stripe-shaped one rendering an sk_live_ key.
  // `statusCode` is the standard convention on aws-sdk, minio, got and Stripe errors,
  // and MinIO is already in this project's compose stack.
  describe('a provider error is NOT treated as a client fault', () => {
    it('suppresses an S3-shaped 403 carrying an access key id', () => {
      const s3 = Object.assign(
        new Error(
          'The AWS Access Key Id AKIAIOSFODNN7EXAMPLE you provided does not exist; endpoint http://minio:9000/private-bucket',
        ),
        { statusCode: 403, code: 'InvalidAccessKeyId' },
      );

      const { problem, raw } = run(s3, { production: true });
      expect(problem.status).toBe(500);
      for (const fragment of ['akiaiosfodnn7example', 'minio:9000', 'private-bucket']) {
        expect(allValues(raw)).not.toContain(fragment);
      }
    });

    it('suppresses a Stripe-shaped 402 carrying a live key', () => {
      const stripe = Object.assign(
        new Error(
          'card_declined for cus_123 via sk_live_51H8xTESTkey at /srv/app/dist/payments.js:44',
        ),
        { statusCode: 402, type: 'StripeCardError' },
      );

      const { problem, raw } = run(stripe, { production: true });
      expect(problem.status).toBe(500);
      for (const fragment of ['sk_live_', 'cus_123', '/srv/']) {
        expect(allValues(raw)).not.toContain(fragment);
      }
    });

    it('ignores a 4xx status when expose is false', () => {
      const { problem } = run(withStatus('server-side detail', 400, false), { production: true });
      expect(problem.status).toBe(500);
      expect(problem.detail).not.toContain('server-side detail');
    });

    it('still honours body-parser errors, which do set expose', () => {
      const { problem } = run(withStatus('request entity too large', 413, true));
      expect(problem.status).toBe(413);
    });
  });
});
