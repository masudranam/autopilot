/**
 * Error handling and tracing against the real application (F5, all four ACs).
 *
 * A throwing test controller is mounted into the real AppModule so the assertions go
 * through the actual middleware, filter and HTTP stack — not a unit harness.
 */
import 'reflect-metadata';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { problemDetailsSchema, ProblemType } from '@repo/contracts';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { validateEnv } from '../config/env';
import { ConflictError, NotFoundError } from './errors/domain-error';
import { currentTraceId } from './trace/trace';
import { logger } from './logging/logger';

@Controller('boom')
class BoomController {
  @Get('domain')
  domain(): never {
    throw new NotFoundError('No such widget.');
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictError('Already exists.');
  }

  @Get('leaky')
  leaky(): never {
    throw new Error('select * from "users" where email = $1 // at /srv/app/dist/users.js:12');
  }

  /** Echoes the id the request is running under, to prove header/body/log agreement. */
  @Get('trace')
  trace(): { traceId: string } {
    logger.info('inside boom/trace');
    return { traceId: currentTraceId() };
  }
}

async function buildApp(nodeEnv: 'development' | 'production'): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [BoomController],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, validateEnv({ NODE_ENV: nodeEnv, ...productionUrls(nodeEnv) }));
  await app.init();
  return app;
}

/** Production validation requires these explicitly (F4/#65). */
function productionUrls(nodeEnv: string): Record<string, string> {
  if (nodeEnv !== 'production') return {};
  return {
    DATABASE_URL:
      process.env.DATABASE_URL ??
      'postgresql://ecommerce:ecommerce_dev_password@localhost:5442/ecommerce?schema=public',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6389',
  };
}

describe('error handling in development', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp('development');
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders a domain error as Problem Details the contract accepts (AC1)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/boom/domain').expect(404);

    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.type).toBe(ProblemType.NOT_FOUND);
    expect(problem.detail).toBe('No such widget.');
    expect(problem.instance).toBe('/api/v1/boom/domain');
  });

  it('renders a conflict with its own status (AC1)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/boom/conflict').expect(409);
    expect(problemDetailsSchema.parse(response.body).type).toBe(ProblemType.CONFLICT);
  });

  // The router's own 404 must go through the filter too — otherwise the most common
  // error in the whole API is the one that is not Problem Details.
  it('renders an unmatched route as Problem Details (AC1)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/nothing-here').expect(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(problemDetailsSchema.parse(response.body).type).toBe(ProblemType.NOT_FOUND);
  });

  it('sets X-Trace-Id on every response and matches the body (AC3)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/boom/trace').expect(200);
    expect(response.headers['x-trace-id']).toBeTruthy();
    expect(response.body.traceId).toBe(response.headers['x-trace-id']);
  });

  it('the error body traceId matches the header (AC3)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/boom/domain').expect(404);
    expect(problemDetailsSchema.parse(response.body).traceId).toBe(response.headers['x-trace-id']);
  });

  it('gives concurrent requests distinct trace ids (AC3)', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(app.getHttpServer()).get('/api/v1/boom/trace')),
    );
    const ids = responses.map((r) => r.body.traceId as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('echoes a well-formed inbound trace id so callers can correlate (AC3)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/boom/trace')
      .set('X-Trace-Id', 'caller-supplied-0001')
      .expect(200);
    expect(response.body.traceId).toBe('caller-supplied-0001');
  });

  // An inbound header is attacker-controlled; it must not be able to inject
  // newlines into every log line for the request.
  // Newlines are not in this list because Node's HTTP client refuses to send them —
  // that case is covered as a unit test of the pattern in trace.middleware.spec.ts.
  it.each([['short'], ['has spaces'], ['x'.repeat(500)], ['semi;colon']])(
    'rejects a malformed inbound trace id (%s)',
    async (bad) => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/boom/trace')
        .set('X-Trace-Id', bad)
        .expect(200);
      expect(response.body.traceId).not.toBe(bad);
      expect(response.body.traceId).toMatch(/^[A-Za-z0-9-]+$/);
    },
  );

  it('shows the underlying message in development (AC2, negative control)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/boom/leaky').expect(500);
    expect(problemDetailsSchema.parse(response.body).detail).toContain('select');
  });
});

describe('error handling in production mode (AC2)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp('production');
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a generic 500 with no SQL, path or stack on the wire', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/boom/leaky').expect(500);

    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.detail).toBe(
      'An unexpected error occurred. Quote the traceId when reporting it.',
    );

    const body = JSON.stringify(response.body).toLowerCase();
    for (const leak of ['select', 'users', '/srv/', '.js:', 'at ']) {
      expect(body).not.toContain(leak);
    }
  });

  it('still carries a traceId so the suppressed detail is findable in the logs', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/boom/leaky').expect(500);
    expect(problemDetailsSchema.parse(response.body).traceId).toBe(response.headers['x-trace-id']);
  });

  it('does not suppress author-written domain messages', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/boom/domain').expect(404);
    expect(problemDetailsSchema.parse(response.body).detail).toBe('No such widget.');
  });

  it('does not advertise the framework (X-Powered-By)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
