import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Env } from './config/env';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';

/**
 * Everything that turns a bare Nest instance into THIS application: global prefix,
 * the Problem Details filter, and OpenAPI. Extracted from main.ts so the e2e suite
 * exercises the exact wiring production runs — pr-reviewer found the previous test
 * applied its own prefix, which meant deleting the production `setGlobalPrefix` call
 * kept the suite green.
 */
export function configureApp(app: INestApplication, env: Env): void {
  app.setGlobalPrefix(env.API_PREFIX);

  // Framework fingerprinting hygiene, flagged by security-auditor on #64. Full
  // security headers on the frontends are F51. The adapter instance is `any` from
  // Nest's perspective, so the Express surface we rely on is narrowed explicitly
  // rather than silenced with a disable comment.
  const httpAdapter = app.getHttpAdapter().getInstance() as {
    disable?: (setting: string) => void;
  };
  httpAdapter.disable?.('x-powered-by');

  // One filter owns the error wire format (I3). Registered here rather than via
  // APP_FILTER so the e2e suite cannot accidentally run without it.
  app.useGlobalFilters(new ProblemDetailsFilter(env.NODE_ENV === 'production'));

  // OpenAPI at /api/docs (F4/AC4) — outside the versioned prefix on purpose: the
  // docs describe versions, they are not part of one. Gating for production is
  // tracked as #66, due with the first authenticated route (F8).
  const openapi = new DocumentBuilder()
    .setTitle('Agentic Shop API')
    .setDescription('Modular-monolith ecommerce API. Errors are RFC 9457 Problem Details.')
    .setVersion('1')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openapi));
}
