import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { validateEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Validate BEFORE Nest constructs anything — a bad environment should produce one
  // clear message naming the variable, not a stack of connection errors (F4/AC2).
  const env = validateEnv();

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix(env.API_PREFIX);
  app.enableShutdownHooks();

  // OpenAPI at /api/docs (F4/AC4) — outside the versioned prefix on purpose: the
  // docs describe versions, they are not part of one.
  const openapi = new DocumentBuilder()
    .setTitle('Agentic Shop API')
    .setDescription('Modular-monolith ecommerce API. Errors are RFC 9457 Problem Details.')
    .setVersion('1')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openapi));

  await app.listen(env.API_PORT);
  console.warn(`api listening on :${env.API_PORT} (prefix /${env.API_PREFIX}, docs /api/docs)`);
}

bootstrap().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
