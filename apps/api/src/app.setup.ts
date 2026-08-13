import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express from 'express';
import { AppModule } from './app.module';
import { validateEnv, type Env } from './config/env';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { traceRequest } from './common/trace/trace.middleware';

/** Request bodies above this are rejected with 413 rather than buffered. */
export const BODY_LIMIT = '1mb';

/**
 * Creates the application with the options `configureApp` depends on.
 *
 * `bodyParser: false` is load-bearing: Nest's own parsers would otherwise be
 * registered here, ahead of the trace handler, and a body-parse failure would escape
 * tracing entirely (AC3). The parsers are re-added by `configureApp`, after tracing.
 */
export async function createApp(env: Env = validateEnv()): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureApp(app, env);
  return app;
}

/**
 * Everything that turns a bare Nest instance into THIS application. Both main.ts and
 * the e2e suites go through here, so the tests exercise production wiring.
 */
export function configureApp(app: INestApplication, env: Env): void {
  // ---- order matters from here to the parsers ----

  // 1. Tracing first, so EVERY failure below is traced and logged (AC3, AC4).
  app.use(traceRequest);

  // 2. Body parsing, which is where malformed-JSON and oversized-payload errors are
  //    raised. Being inside the trace context is the whole point of the ordering.
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

  app.setGlobalPrefix(env.API_PREFIX);

  // Framework fingerprinting hygiene, flagged by security-auditor on #64. Full
  // security headers on the frontends are F51.
  const httpAdapter = app.getHttpAdapter().getInstance() as {
    disable?: (setting: string) => void;
  };
  httpAdapter.disable?.('x-powered-by');

  // One filter owns the error wire format (I3). Registered here rather than via
  // APP_FILTER so the e2e suite cannot accidentally run without it.
  app.useGlobalFilters(new ProblemDetailsFilter(env.suppressInternalErrors));

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
