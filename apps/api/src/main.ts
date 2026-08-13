import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { validateEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Validate BEFORE Nest constructs anything — a bad environment should produce one
  // clear message naming the variable, not a stack of connection errors (F4/AC2).
  const env = validateEnv();

  const app = await NestFactory.create(AppModule);
  configureApp(app, env);
  app.enableShutdownHooks();

  await app.listen(env.API_PORT);
  console.warn(`api listening on :${env.API_PORT} (prefix /${env.API_PREFIX}, docs /api/docs)`);
}

bootstrap().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
