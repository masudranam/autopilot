/**
 * Health endpoints against the real stack (F4/AC1, AC3, AC4) — no mocks. The 503
 * branch runs against a second app whose Redis URL points at a closed port, so the
 * failure path is genuinely exercised rather than simulated.
 *
 * Both apps are wired through configureApp() — the SAME function main.ts uses — so
 * these tests exercise production wiring. The previous version applied its own
 * setGlobalPrefix, which meant deleting the production call kept the suite green
 * (found by pr-reviewer).
 */
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { problemDetailsSchema } from '@repo/contracts';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { ENV } from '../../config/env.module';
import { validateEnv } from '../../config/env';

describe('health endpoints (F4)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, validateEnv({}));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health answers 200 with no dependencies involved (AC3)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /api/v1/health/ready answers 200 when Postgres and Redis are both up (AC3)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(response.body).toEqual({ status: 'ready', components: { postgres: true, redis: true } });
  });

  it('routes live under the global prefix — the bare path is not registered (AC1)', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });

  it('serves an OpenAPI document at /api/docs (AC4)', async () => {
    const ui = await request(app.getHttpServer()).get('/api/docs').expect(200);
    expect(ui.text).toContain('swagger');

    const document = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(document.body.openapi).toMatch(/^3\./);
    expect(Object.keys(document.body.paths as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['/api/v1/health', '/api/v1/health/ready']),
    );
  });
});

describe('readiness failure path (AC3 — 503 with Problem Details)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      // Port 1 answers nothing: the Redis probe must time out or refuse, and
      // readiness must report it rather than hang (bounded probe).
      .useValue(validateEnv({ REDIS_URL: 'redis://127.0.0.1:1' }))
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, validateEnv({}));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 503 with a body the contracts schema accepts, naming the failing component', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);

    expect(response.headers['content-type']).toContain('application/problem+json');

    // Parse with the real contract, not toMatchObject — a drifted field name or a
    // missing traceId must fail here, not in a consumer (I3).
    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.status).toBe(503);
    expect(problem.title).toBe('Not ready');
    expect(problem.detail).toContain('redis');
  });
});
