/**
 * Health endpoints against the real stack (F4/AC1, AC3, AC4) — no mocks. The 503
 * branch runs against a second app whose Redis URL points at a closed port, so the
 * failure path is genuinely exercised rather than simulated.
 */
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { ENV } from '../../config/env.module';
import { validateEnv } from '../../config/env';

describe('health endpoints (F4)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
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
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 503 with an RFC 9457 body naming the failing component', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      title: 'Not ready',
      status: 503,
      detail: expect.stringContaining('redis') as string,
    });
    expect(typeof response.body.traceId).toBe('string');
    expect(response.body.type).toMatch(/^https:\/\//);
  });
});
