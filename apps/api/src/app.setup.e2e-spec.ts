/**
 * The OpenAPI document is served only where it is meant to be (issue #66).
 *
 * `/api/docs-json` is not documentation once authenticated routes exist — it is a
 * machine-readable index of every path, parameter and payload shape, and it is exactly
 * what a scanner wants. F4/AC4 still holds: the document is served in development, and
 * the health suite asserts its content there. What is added here is that production —
 * and, more importantly, an UNCONFIGURED environment — serves nothing.
 *
 * Three apps are built, one per environment, because the decision is taken once at
 * setup time. That is the design: an unmounted route cannot be reached by a
 * path-normalisation trick, and there is no second code path where the document is
 * built and then withheld.
 */
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { validateEnv } from './config/env';

/** Every route the Swagger module mounts. Missing one would leave a hole. */
const DOC_ROUTES = ['/api/docs', '/api/docs-json', '/api/docs-yaml'];

const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db.internal:5432/shop',
  REDIS_URL: 'redis://cache.internal:6379',
  JWT_ACCESS_SECRET: 'a2f4b6c8d0e2f4a6b8c0d2e4f6a8b0c2',
  JWT_REFRESH_SECRET: 'f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6',
};

async function appWith(source: NodeJS.ProcessEnv): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, validateEnv(source));
  await app.init();
  return app;
}

describe('OpenAPI exposure (#66)', () => {
  describe('with NODE_ENV=test — the documented development behaviour (F4/AC4)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await appWith({ NODE_ENV: 'test' });
    });

    afterAll(async () => {
      await app.close();
    });

    it.each(DOC_ROUTES)('serves %s', async (route) => {
      await request(app.getHttpServer()).get(route).expect(200);
    });

    it('documents the auth routes it is meant to document', async () => {
      const document = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
      expect(Object.keys((document.body as { paths: Record<string, unknown> }).paths)).toEqual(
        expect.arrayContaining(['/api/v1/auth/login', '/api/v1/auth/refresh']),
      );
    });
  });

  describe('with NODE_ENV=production', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await appWith(PRODUCTION);
    });

    afterAll(async () => {
      await app.close();
    });

    it.each(DOC_ROUTES)('does not serve %s', async (route) => {
      // 404 and not 401: the route does not exist at all, so there is nothing to
      // enumerate and no auth prompt confirming that a document is there to be had.
      await request(app.getHttpServer()).get(route).expect(404);
    });

    it('still serves the API itself', async () => {
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    });
  });

  /**
   * The case that matters most, and the one an `=== 'production'` check gets wrong: a
   * deployment with NODE_ENV unset. It is not a development box just because nobody
   * said so.
   */
  describe('with nothing configured at all', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await appWith({});
    });

    afterAll(async () => {
      await app.close();
    });

    it.each(DOC_ROUTES)('does not serve %s', async (route) => {
      await request(app.getHttpServer()).get(route).expect(404);
    });
  });

  describe('with DOCS_ENABLED overriding the environment', () => {
    let enabled: INestApplication;
    let disabled: INestApplication;

    beforeAll(async () => {
      enabled = await appWith({ ...PRODUCTION, DOCS_ENABLED: 'true' });
      disabled = await appWith({ NODE_ENV: 'development', DOCS_ENABLED: 'false' });
    });

    afterAll(async () => {
      await enabled.close();
      await disabled.close();
    });

    it('serves the document in production when explicitly asked to', async () => {
      await request(enabled.getHttpServer()).get('/api/docs-json').expect(200);
    });

    it('withholds it in development when explicitly asked to', async () => {
      await request(disabled.getHttpServer()).get('/api/docs-json').expect(404);
    });
  });
});
