/**
 * Application bootstrap.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { createGlobalValidationPipe } from './app.pipes';
import { initTracing } from './tracing';

// Tracing starts before the Nest application is created so HTTP
// auto-instrumentation wraps the server created in `bootstrap`.
initTracing();

/**
 * Boots the Nest application.
 *
 * - creates the app from AppModule
 * - applies the shared validation pipe
 * - registers the ws adapter for the `/ws` gateway
 * - listens on the configured port.
 *
 * @return Resolves when the server is listening.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
