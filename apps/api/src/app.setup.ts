import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Env } from './config/env';

/**
 * Everything that turns a bare Nest instance into THIS application: global prefix
 * and OpenAPI. Extracted from main.ts so the e2e suite exercises the exact wiring
 * production runs — pr-reviewer found the previous test applied its own prefix,
 * which meant deleting the production `setGlobalPrefix` call kept the suite green.
 */
export function configureApp(app: INestApplication, env: Env): void {
  app.setGlobalPrefix(env.API_PREFIX);

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
